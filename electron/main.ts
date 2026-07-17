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
  ipcMain,
  dialog,
  shell,
  nativeTheme,
  type IpcMainInvokeEvent,
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

function initCliInstall(): void {
  const installer = createDesktopCliInstaller({
    supported: app.isPackaged && process.platform === "darwin" && process.arch === "arm64",
    homeDir: app.getPath("home"),
    shellPath: process.env.SHELL?.trim() || "/bin/zsh",
    pathEnv: process.env.PATH ?? "",
    appExecutable: process.execPath,
    resourcesPath: process.resourcesPath,
    cliRoot: path.join(process.resourcesPath, "cli"),
  });
  let installRequestInFlight: Promise<Awaited<ReturnType<typeof installer.install>>> | null = null;

  const confirmInstall = (state: Awaited<ReturnType<typeof installer.getState>>): Promise<boolean> => {
    const window = mainWindow;
    if (!window) return Promise.resolve(false);
    const verb = state.status === "not-installed" ? "安装" : "修复";
    return dialog
      .showMessageBox(window, {
        type: "question",
        title: `${verb} Littlestart CLI`,
        message: `${verb}命令行工具？`,
        detail: `将写入 ${state.installPath ?? "~/.local/bin/littlestart"}，并在需要时为新终端配置 PATH。不会使用管理员权限或联网下载。`,
        buttons: [verb, "取消"],
        defaultId: 0,
        cancelId: 1,
        noLink: true,
      })
      .then((result) => result.response === 0);
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
      // Acquire this synchronously after confirmation and hold it across the
      // complete launcher/profile transaction. The updater cannot commit a
      // restart while an entry is quarantined, and a committed restart makes
      // this acquisition fail before the installer mutates the filesystem.
      const releaseRestartBlocker = updateRestartGuard.tryAcquireRestartBlocker();
      if (!releaseRestartBlocker) {
        return {
          ok: false as const,
          error: "应用正在重启更新，请稍后再安装 CLI",
          state,
        };
      }
      try {
        return await installer.install(plan);
      } finally {
        releaseRestartBlocker();
      }
    })().finally(() => {
      installRequestInFlight = null;
    });
    return installRequestInFlight;
  });
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
  initCliInstall();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
