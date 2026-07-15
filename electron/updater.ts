// Auto-update for the desktop shell, via electron-updater (Squirrel.Mac under
// the hood). The update feed is a public GitHub release, configured in
// electron-builder.yml and baked into the packaged app as app-update.yml.
//
// The remote editor owns the non-blocking status UI. The testable controller
// owns download/install state; this file only wires that state to Electron IPC.
import { app, autoUpdater as nativeAutoUpdater, ipcMain, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { DESKTOP_UPDATE_CHANNELS } from "../lib/desktop-bridge";
import { hasActiveExportSession } from "./render";
import { createDesktopUpdaterController } from "./updater-controller";
import { updateRestartGuard } from "./update-restart-guard";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  const supported = app.isPackaged && process.platform === "darwin";
  const controller = createDesktopUpdaterController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    supported,
    requiresInstallReadySignal: supported,
    hasActiveExportSession,
    restartGuard: updateRestartGuard,
    onState: (state) => {
      const webContents = getWindow()?.webContents;
      if (webContents && !webContents.isDestroyed()) {
        webContents.send(DESKTOP_UPDATE_CHANNELS.stateChanged, state);
      }
    },
  });

  // Register IPC before BrowserWindow.loadURL(), otherwise the remote page can
  // hydrate and invoke the bridge before the main process has a handler.
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.getState, () => controller.getState());
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.retry, () => controller.check());
  ipcMain.handle(DESKTOP_UPDATE_CHANNELS.install, () => controller.install());

  if (!supported) return;

  // electron-updater's macOS `update-downloaded` fires before Squirrel.Mac has
  // fetched the staged zip. This native event supplies one half of readiness;
  // the controller also waits for downloadPromise to fulfill so late cache I/O
  // can never invalidate an already-exposed restart action.
  nativeAutoUpdater.on("update-downloaded", (_event, _notes, releaseName) =>
    controller.markInstallReady(releaseName),
  );

  // Let the window settle. The non-blocking Web status indicator can also ask
  // for an immediate check when it learns about a verified release.
  setTimeout(() => void controller.check(), 10_000);
  setInterval(() => void controller.check(), SIX_HOURS);
}
