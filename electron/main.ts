// Electron main process — a thin "render compute shell".
//
// The window loads the editor UI from a remote URL (the Vercel deployment in
// production, localhost during development), so UI + composition updates ship
// via Vercel without re-distributing the desktop app. The only thing this
// process adds is local MP4 rendering, exposed to the page over a narrow IPC
// bridge (see preload.ts).
import {
  app,
  BrowserWindow,
  Menu,
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
} from "electron";
import path from "node:path";
import fs from "node:fs/promises";
import { DESKTOP_CLI_CHANNELS } from "../lib/desktop-bridge";
import {
  startRender,
  cancelRender,
  getJob,
  cleanupJob,
  beginExportSession,
  endExportSession,
  cleanupExportSessionsForOwner,
  type RenderRequest,
} from "./render";
import { initAutoUpdate } from "./updater";
import { createDesktopCliInstaller } from "./cli-installer";
import {
  ensureElevenLabsCredentialFile,
  promptAndStoreElevenLabsCredential,
} from "./elevenlabs-credential-dialog.ts";
import { updateRestartGuard } from "./update-restart-guard";
import {
  beginExportWithUpdateInterlock,
  startRenderWithUpdateInterlock,
} from "./update-export-interlock";

// In the packaged app, node_modules lives inside app.asar (read-only, can't
// execute binaries) and the chromium download dir isn't writable. Point Remotion
// at the binaries we ship: the compositor (ffmpeg) is asarUnpack'd, and
// chrome-headless-shell is copied in via extraResources. render.ts reads these
// env vars. In dev (running from source) they stay unset and Remotion resolves
// everything from node_modules automatically.
if (app.isPackaged) {
  const res = process.resourcesPath;
  process.env.REMOTION_BINARIES_DIR = path.join(
    res,
    "app.asar.unpacked",
    "node_modules",
    "@remotion",
    "compositor-darwin-arm64",
  );
  process.env.REMOTION_BROWSER_EXECUTABLE = path.join(
    res,
    "render-bin",
    "chrome-headless-shell",
    "mac-arm64",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
}

// Where to load the editor from. Dev → local Next server; prod → Vercel.
// Override at runtime with APP_URL.
const DEFAULT_PROD_URL = "https://littlestart.flowprompter.app";
const APP_URL =
  process.env.APP_URL || (app.isPackaged ? DEFAULT_PROD_URL : "http://localhost:3000");

const trustedOrigin = (() => {
  try {
    return new URL(APP_URL).origin;
  } catch {
    return "http://localhost:3000";
  }
})();

let mainWindow: BrowserWindow | null = null;

function isTrustedCliRequest(event: IpcMainInvokeEvent, argumentCount: number): boolean {
  if (argumentCount !== 0 || !mainWindow || event.sender !== mainWindow.webContents) return false;
  const frame = event.senderFrame;
  if (!frame || frame !== event.sender.mainFrame) return false;
  try {
    return new URL(frame.url).origin === trustedOrigin;
  } catch {
    return false;
  }
}

function initCliInstall() {
  const supported = app.isPackaged && process.platform === "darwin" && process.arch === "arm64";
  const installer = createDesktopCliInstaller({
    supported,
    homeDir: app.getPath("home"),
    shellPath: process.env.SHELL?.trim() || "/bin/zsh",
    pathEnv: process.env.PATH ?? "",
    appExecutable: process.execPath,
    resourcesPath: process.resourcesPath,
    cliRoot: path.join(process.resourcesPath, "cli"),
  });
  let installRequestInFlight: Promise<Awaited<ReturnType<typeof installer.install>>> | null = null;
  let credentialRequestInFlight: Promise<
    | { ok: true; state: Awaited<ReturnType<typeof installer.getElevenLabsState>> }
    | {
        ok: false;
        error: string;
        state: Awaited<ReturnType<typeof installer.getElevenLabsState>>;
        canceled?: boolean;
      }
  > | null = null;

  const configureElevenLabsCredential = () => {
    if (credentialRequestInFlight) return credentialRequestInFlight;
    credentialRequestInFlight = (async () => {
      const cliState = await installer.getState();
      const elevenLabs = cliState.elevenLabs ?? (await installer.getElevenLabsState());
      if (!supported || cliState.status !== "installed" || elevenLabs.runtime !== "available") {
        return {
          ok: false as const,
          error: "ElevenLabs MCP 尚未随 CLI 完整安装，请先更新或修复客户端。",
          state: elevenLabs,
        };
      }
      try {
        const result = await promptAndStoreElevenLabsCredential(app.getPath("home"));
        const state = await installer.getElevenLabsState();
        if (result === "skipped") {
          return { ok: false as const, canceled: true, error: "已跳过配置", state };
        }
        return { ok: true as const, state };
      } catch {
        return {
          ok: false as const,
          error: "未能保存 ElevenLabs API Key，请检查本机配置目录权限后重试。",
          state: await installer.getElevenLabsState(),
        };
      }
    })().finally(() => {
      credentialRequestInFlight = null;
    });
    return credentialRequestInFlight;
  };

  const confirmInstall = (state: Awaited<ReturnType<typeof installer.getState>>): Promise<boolean> => {
    const window = mainWindow;
    if (!window) return Promise.resolve(false);
    const verb = state.status === "not-installed" ? "安装" : "修复";
    return dialog
      .showMessageBox(window, {
        type: "question",
        title: `${verb} Littlestart CLI`,
        message: `${verb}命令行工具？`,
        detail: `将写入 ${state.installPath ?? "~/.local/bin/littlestart"}、随附的 ElevenLabs MCP 启动器，并把视频生成 Skill 安装到本机 Codex 和 Claude 用户目录；需要时为新终端配置 PATH。安装后可选填写 API Key；跳过不影响视频 CLI。不会使用管理员权限或联网下载，也不会覆盖用户自定义 Skill。`,
        buttons: [verb, "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((result) => result.response === 0);
  };

  const installCli = async () => {
    if (installRequestInFlight) return installRequestInFlight;
    installRequestInFlight = (async () => {
      const plan = await installer.prepareInstall();
      const state = plan.state;
      if (
        state.status !== "not-installed" &&
        state.status !== "repair-needed" &&
        state.status !== "installed"
      ) {
        return { ok: false as const, error: state.message ?? "当前无法安装 CLI", state };
      }
      if (!(await confirmInstall(state))) {
        return { ok: false as const, canceled: true, error: "已取消安装", state };
      }
      // Hold the updater interlock across the complete launcher/profile/Skill
      // transaction. A committed restart makes this fail before any writes.
      const releaseRestartBlocker = updateRestartGuard.tryAcquireRestartBlocker();
      if (!releaseRestartBlocker) {
        return {
          ok: false as const,
          error: "应用正在重启更新，请稍后再安装 CLI",
          state,
        };
      }
      let result: Awaited<ReturnType<typeof installer.install>>;
      try {
        result = await installer.install(plan);
      } finally {
        releaseRestartBlocker();
      }
      if (!result.ok) return result;

      // Key setup is optional and runs only after the complete local install
      // commits. Skipping it never disables or rolls back the video CLI.
      try {
        await ensureElevenLabsCredentialFile(app.getPath("home"));
        const elevenLabs = await installer.getElevenLabsState();
        if (elevenLabs.credential === "missing" && elevenLabs.runtime === "available") {
          const configured = await configureElevenLabsCredential();
          if (!configured.ok && !configured.canceled && mainWindow) {
            await dialog.showMessageBox(mainWindow, {
              type: "warning",
              title: "ElevenLabs 尚未配置",
              message: "CLI 已安装，但 ElevenLabs API Key 未能保存。",
              detail: "你仍然可以生成视频，之后可在“命令行与自动化”或应用菜单中重新配置背景音或环境音效。",
              buttons: ["知道了"],
              defaultId: 0,
              noLink: true,
            });
          }
        }
      } catch {
        // Credential setup remains optional; state reports it truthfully.
      }
      return { ...result, state: await installer.getState() };
    })().finally(() => {
      installRequestInFlight = null;
    });
    return installRequestInFlight;
  };

  ipcMain.handle(DESKTOP_CLI_CHANNELS.getState, (event, ...args: unknown[]) => {
    if (!isTrustedCliRequest(event, args.length)) {
      throw new Error("拒绝来自非可信页面的 CLI 请求");
    }
    return installer.getState();
  });

  ipcMain.handle(DESKTOP_CLI_CHANNELS.install, async (event, ...args: unknown[]) => {
    if (!isTrustedCliRequest(event, args.length)) {
      throw new Error("拒绝来自非可信页面的 CLI 请求");
    }
    return installCli();
  });

  ipcMain.handle(DESKTOP_CLI_CHANNELS.configureElevenLabs, (event, ...args: unknown[]) => {
    if (!isTrustedCliRequest(event, args.length)) {
      throw new Error("拒绝来自非可信页面的 CLI 请求");
    }
    return configureElevenLabsCredential();
  });

  return { installCli, configureElevenLabsCredential };
}

function installNativeMenu(cli: ReturnType<typeof initCliInstall>): void {
  const showInstallResult = async () => {
    if (!mainWindow) return;
    const result = await cli.installCli();
    if (result.ok) {
      await dialog.showMessageBox(mainWindow, {
        type: "info",
        title: "Littlestart CLI 已就绪",
        message: "CLI、ElevenLabs MCP 和视频生成 Skill 已安装。",
        detail: "新打开一个终端后可以使用 littlestart。ElevenLabs API Key 如果跳过，可稍后再配置。",
        buttons: ["知道了"],
        defaultId: 0,
        noLink: true,
      });
      return;
    }
    if (result.canceled) return;
    await dialog.showMessageBox(mainWindow, {
      type: "error",
      title: "CLI 安装未完成",
      message: result.error,
      detail: result.state.message ?? "请根据提示处理冲突后再试；不会覆盖用户自定义的 Skill。",
      buttons: ["知道了"],
      defaultId: 0,
      noLink: true,
    });
  };

  const configureCredential = async () => {
    if (!mainWindow) return;
    const result = await cli.configureElevenLabsCredential();
    if (result.ok || result.canceled) return;
    await dialog.showMessageBox(mainWindow, {
      type: "warning",
      title: "ElevenLabs API Key 未配置",
      message: result.error,
      buttons: ["知道了"],
      defaultId: 0,
      noLink: true,
    });
  };

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: "about" },
        { type: "separator" },
        { label: "安装或修复 Littlestart CLI…", click: () => void showInstallResult() },
        { label: "配置 ElevenLabs API Key…", click: () => void configureCredential() },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    },
    { role: "editMenu" },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0b0f",
    title: "小音符起号助手",
    // Drop the native macOS title bar so the window reads as one continuous
    // dark surface instead of a light chrome strip stacked on the dark editor.
    // The page's own header already shows the product name, so the native title
    // (which duplicated it) goes away with the bar. The traffic lights stay and
    // float over the header; position them centered within its 56px height.
    // (Window is macOS-only — electron-builder ships a mac arm64 dmg.)
    titleBarStyle: "hidden",
    trafficLightPosition: { x: 19, y: 21 },
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Security: keep the window pinned to the trusted origin. Any other
  // navigation or window.open target is opened in the system browser instead.
  // Fail closed if the URL can't be parsed.
  mainWindow.webContents.on("will-navigate", (event, url) => {
    let sameOrigin = false;
    try {
      sameOrigin = new URL(url).origin === trustedOrigin;
    } catch {
      sameOrigin = false;
    }
    if (!sameOrigin) {
      event.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  // Remote content gets no implicit access to camera/mic/geolocation/etc.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));

  const renderer = mainWindow.webContents;
  renderer.on("did-start-navigation", (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) cleanupExportSessionsForOwner(renderer.id);
  });
  renderer.on("render-process-gone", () => cleanupExportSessionsForOwner(renderer.id));
  renderer.on("destroyed", () => cleanupExportSessionsForOwner(renderer.id));

  void mainWindow.loadURL(APP_URL);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

// ---- IPC: render bridge -----------------------------------------------------

ipcMain.handle("render:session-begin", (event) => {
  return beginExportWithUpdateInterlock(updateRestartGuard, () =>
    beginExportSession(event.sender.id),
  );
});

ipcMain.handle("render:session-end", (event, sessionId: string) => {
  if (typeof sessionId === "string") endExportSession(sessionId, event.sender.id);
  return { ok: true as const };
});

ipcMain.handle("render:start", async (event, payload: RenderRequest) => {
  try {
    // Only allow rendering the Remotion site hosted by the trusted origin.
    // Parse and compare the full origin (a prefix match would accept
    // littlestart.flowprompter.app.evil.com) and require the expected path.
    let serveOk = false;
    try {
      const u = new URL(String(payload?.serveUrl));
      serveOk = u.origin === trustedOrigin && u.pathname.startsWith("/remotion-site/");
    } catch {
      serveOk = false;
    }
    if (!serveOk) {
      throw new Error("serveUrl 不在可信来源内");
    }
    const sender = event.sender;
    const result = await startRenderWithUpdateInterlock(updateRestartGuard, () =>
      startRender(
        payload,
        (progress) => {
          if (!sender.isDestroyed()) sender.send("render:progress", progress);
        },
        sender.id,
      ),
    );
    return { ok: true as const, jobId: result.jobId };
  } catch (e) {
    return { ok: false as const, error: e instanceof Error ? e.message : String(e) };
  }
});

ipcMain.handle("render:cancel", (_event, jobId: string) => {
  cancelRender(jobId);
  return { ok: true as const };
});

ipcMain.handle(
  "render:save",
  async (_event, { jobId, kind }: { jobId: string; kind: "video" | "cover" }) => {
    const job = getJob(jobId);
    const src = kind === "cover" ? job?.coverPath : job?.outputPath;
    if (!src) return { ok: false as const, error: "找不到渲染产物" };

    const isVideo = kind === "video";
    const { canceled, filePath } = await dialog.showSaveDialog({
      defaultPath: isVideo ? "teleprompter.mp4" : "封面.jpg",
      filters: [
        isVideo
          ? { name: "MP4 视频", extensions: ["mp4"] }
          : { name: "JPEG 图片", extensions: ["jpg"] },
      ],
    });
    if (canceled || !filePath) return { ok: false as const, canceled: true };

    await fs.copyFile(src, filePath);
    return { ok: true as const, path: filePath };
  },
);

ipcMain.handle("render:reveal", (_event, filePath: string) => {
  if (typeof filePath === "string") shell.showItemInFolder(filePath);
  return { ok: true as const };
});

ipcMain.handle("render:cleanup", async (_event, jobId: string) => {
  await cleanupJob(jobId);
  return { ok: true as const };
});

// ---- lifecycle --------------------------------------------------------------

app.whenReady().then(() => {
  // The editor UI is dark-only; force native chrome (traffic lights on hover,
  // context menus, the save dialog) to match so nothing flashes light.
  nativeTheme.themeSource = "dark";
  // Register updater IPC before loading the remote page so hydration can never
  // race ahead of the main-process handlers.
  initAutoUpdate(() => mainWindow);
  const cli = initCliInstall();
  createWindow();
  installNativeMenu(cli);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
