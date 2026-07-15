// Auto-update for the desktop shell, via electron-updater (Squirrel.Mac under
// the hood). The update feed is a PUBLIC GitHub releases repo, so no token ever
// ships in the client; the private source repo stays private. See
// electron-builder.yml `publish:` for the matching provider config.
//
// Behaviour: download new versions in the background, then require a restart
// as soon as the app is idle — never while an export is rendering. There is no
// deferral path: after the one-button notice closes, the update is installed.
// As a safety net, a downloaded update also installs on the next normal quit.
import { app, dialog, type BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { hasActiveExportSession } from "./render";

const SIX_HOURS = 6 * 60 * 60 * 1000;
const IDLE_RETRY_MS = 5_000;

export function initAutoUpdate(getWindow: () => BrowserWindow | null): void {
  // Unpackaged dev runs have no app-update.yml; updates are macOS-only here.
  if (!app.isPackaged || process.platform !== "darwin") return;

  autoUpdater.autoDownload = true; // fetch in the background
  autoUpdater.autoInstallOnAppQuit = true; // fallback: apply on next clean quit

  let pending = false; // an update is downloaded and waiting to install
  let dialogOpen = false; // guard against overlapping prompts

  const maybeInstall = async (): Promise<void> => {
    // Wait through render, save dialog, and the user's explicit save/abandon
    // decision. Completed-but-unsaved files still live only in the temp job.
    if (!pending || dialogOpen || hasActiveExportSession()) return;
    dialogOpen = true;
    try {
      const win = getWindow();
      const opts = {
        type: "info" as const,
        buttons: ["立即重启更新"],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: "必须更新后才能继续使用",
        detail: "新版本已在后台下载完成。应用将立即重启并完成更新。",
      };
      if (win) await dialog.showMessageBox(win, opts);
      else await dialog.showMessageBox(opts);
      pending = false;
      autoUpdater.quitAndInstall();
    } finally {
      dialogOpen = false;
    }
  };

  autoUpdater.on("update-downloaded", () => {
    pending = true;
    void maybeInstall();
  });
  autoUpdater.on("error", (err) => {
    console.error("[auto-update]", err);
  });

  const check = (): void => {
    autoUpdater.checkForUpdates().catch((err) => console.error("[auto-update] check failed", err));
  };

  // First check shortly after launch (let the window settle), then periodically.
  setTimeout(check, 10_000);
  setInterval(check, SIX_HOURS);

  // A downloaded update may arrive during an export. Retry frequently so the
  // mandatory restart happens promptly once rendering becomes idle.
  setInterval(() => void maybeInstall(), IDLE_RETRY_MS);
}
