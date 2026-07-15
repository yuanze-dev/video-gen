// Auto-update for the desktop shell, via electron-updater (Squirrel.Mac under
// the hood). The update feed is a public GitHub release, configured in
// electron-builder.yml and baked into the packaged app as app-update.yml.
//
// The remote editor owns the mandatory-update UI. The testable controller owns
// download/install state; this file only wires that state to Electron IPC.
import { app, ipcMain, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { DESKTOP_UPDATE_CHANNELS } from "../lib/desktop-bridge";
import { hasActiveExportSession } from "./render";
import { createDesktopUpdaterController } from "./updater-controller";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  const controller = createDesktopUpdaterController({
    updater: autoUpdater,
    currentVersion: app.getVersion(),
    supported: app.isPackaged && process.platform === "darwin",
    hasActiveExportSession,
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

  if (!app.isPackaged || process.platform !== "darwin") return;

  // Let the window settle. A blocking Web gate can also call retryUpdate()
  // immediately, and the controller prevents duplicate requests.
  setTimeout(() => void controller.check(), 10_000);
  setInterval(() => void controller.check(), SIX_HOURS);
}
