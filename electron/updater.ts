// Auto-update for the desktop shell, via electron-updater (Squirrel.Mac under
// the hood). The update feed is a PUBLIC GitHub releases repo, so no token ever
// ships in the client; the private source repo stays private. See
// electron-builder.yml `publish:` for the matching provider config.
//
// Behaviour: download new versions in the background, then prompt for a restart
// only when the app is idle — never while an export is rendering. As a safety
// net, a downloaded update also installs on the next normal quit.
import { app, dialog, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { isRendering } from "./render";

const SIX_HOURS = 6 * 60 * 60 * 1000;

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // Unpackaged dev runs have no app-update.yml; updates are macOS-only here.
  if (!app.isPackaged || process.platform !== "darwin") return;

  autoUpdater.autoDownload = true; // fetch in the background
  autoUpdater.autoInstallOnAppQuit = true; // fallback: apply on next clean quit

  let pending = false; // an update is downloaded and waiting to install
  let dialogOpen = false; // guard against overlapping prompts

  const maybePrompt = async (): Promise<void> => {
    if (!pending || dialogOpen || isRendering()) return; // wait for an idle moment
    dialogOpen = true;
    try {
      const win = getWindow();
      const opts = {
        type: "info" as const,
        buttons: ["立即重启更新", "稍后"],
        defaultId: 0,
        cancelId: 1,
        message: "新版本已就绪",
        detail: "已在后台下载完成，重启应用即可更新。",
      };
      const { response } = win
        ? await dialog.showMessageBox(win, opts)
        : await dialog.showMessageBox(opts);
      if (response === 0) {
        pending = false;
        autoUpdater.quitAndInstall();
      }
      // Otherwise keep `pending`; we re-offer on the next interval tick, and
      // autoInstallOnAppQuit still applies it when the user quits normally.
    } finally {
      dialogOpen = false;
    }
  };

  autoUpdater.on("update-downloaded", () => {
    pending = true;
    void maybePrompt();
  });
  autoUpdater.on("error", (err) => {
    console.error("[auto-update]", err);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => console.error("[auto-update] check failed", err));
  };

  // First check shortly after launch (let the window settle), then periodically.
  // Each tick also retries a deferred prompt in case an export was running before.
  setTimeout(check, 10_000);
  setInterval(() => {
    check();
    void maybePrompt();
  }, SIX_HOURS);
}
