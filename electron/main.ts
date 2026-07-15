// Electron main process — a thin "render compute shell".
//
// The window loads the editor UI from a remote URL (the Vercel deployment in
// production, localhost during development), so UI + composition updates ship
// via Vercel without re-distributing the desktop app. The only thing this
// process adds is local MP4 rendering, exposed to the page over a narrow IPC
// bridge (see preload.ts).
import { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme } from "electron";
import path from "node:path";
import fs from "node:fs/promises";
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

ipcMain.handle("render:session-begin", (event) => ({
  ok: true as const,
  sessionId: beginExportSession(event.sender.id),
}));

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
    const result = await startRender(
      payload,
      (progress) => {
        if (!sender.isDestroyed()) sender.send("render:progress", progress);
      },
      sender.id,
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
  createWindow();
  // Keep the desktop shell current: background download + idle restart prompt.
  initAutoUpdate(() => mainWindow);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
