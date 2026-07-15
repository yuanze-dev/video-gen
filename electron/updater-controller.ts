import type {
  DesktopUpdateCommandResult,
  DesktopUpdateErrorPhase,
  DesktopUpdateState,
} from "../lib/desktop-bridge";
import type { AppUpdater } from "electron-updater";

type UpdateInfoLike = { version: string };
type DownloadProgressLike = {
  percent: number;
  transferred: number;
  total: number;
  bytesPerSecond: number;
};

export type AutoUpdaterLike = Pick<
  AppUpdater,
  "autoDownload" | "autoInstallOnAppQuit" | "checkForUpdates" | "quitAndInstall" | "on"
>;

type UpdaterLogger = {
  error: (...args: unknown[]) => void;
};

function updaterErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) return undefined;
  const code = String(error.code);
  return code.length <= 80 ? code : undefined;
}

function messageForPhase(phase: DesktopUpdateErrorPhase): string {
  if (phase === "download") return "自动下载没有完成";
  if (phase === "install") return "应用未能自动重启，请再次尝试";
  return "暂时无法连接更新服务";
}

export function createDesktopUpdaterController({
  updater,
  currentVersion,
  supported,
  hasActiveExportSession,
  onState,
  logger = console,
}: {
  updater: AutoUpdaterLike;
  currentVersion: string;
  supported: boolean;
  hasActiveExportSession: () => boolean;
  onState?: (state: DesktopUpdateState) => void;
  logger?: UpdaterLogger;
}) {
  let revision = 0;
  let pendingInstall = false;
  let operationPhase: DesktopUpdateErrorPhase = "check";
  let checkInFlight: Promise<DesktopUpdateCommandResult> | null = null;
  let state: DesktopUpdateState = {
    revision,
    status: supported ? "idle" : "unsupported",
    currentVersion,
  };

  const publish = (next: Omit<DesktopUpdateState, "revision" | "currentVersion">): void => {
    state = { ...next, currentVersion, revision: ++revision };
    onState?.(state);
  };

  const publishError = (phase: DesktopUpdateErrorPhase, error: unknown): void => {
    const message = messageForPhase(phase);
    const errorCode = updaterErrorCode(error);
    if (
      state.status === "error" &&
      state.errorPhase === phase &&
      state.errorCode === errorCode &&
      state.message === message
    ) {
      return;
    }

    logger.error(`[auto-update] ${phase}`, error);
    publish({
      status: "error",
      targetVersion: state.targetVersion,
      errorPhase: phase,
      errorCode,
      message,
      retryable: true,
    });
  };

  const check = (): Promise<DesktopUpdateCommandResult> => {
    if (!supported) {
      return Promise.resolve({ ok: false, error: "当前环境不支持自动更新" });
    }
    if (pendingInstall) {
      return Promise.resolve({ ok: false, error: "新版已下载完成，请重启安装" });
    }
    if (checkInFlight) return checkInFlight;

    operationPhase = "check";
    publish({ status: "checking", targetVersion: state.targetVersion });
    checkInFlight = updater
      .checkForUpdates()
      .then((result) => {
        // electron-updater exposes its auto-download as a separate promise.
        // Consuming it here is required even though it also emits `error`;
        // otherwise a failed download becomes an unhandled rejection in Node.
        if (result?.downloadPromise) {
          void result.downloadPromise.catch((error: unknown) => {
            operationPhase = "download";
            pendingInstall = false;
            publishError("download", error);
          });
        }
        return { ok: true as const };
      })
      .catch((error: unknown) => {
        operationPhase = "check";
        publishError("check", error);
        return { ok: false as const, error: messageForPhase("check") };
      })
      .finally(() => {
        checkInFlight = null;
      });
    return checkInFlight;
  };

  const install = (): DesktopUpdateCommandResult => {
    if (!supported || !pendingInstall) {
      return { ok: false, error: "新版尚未下载完成" };
    }
    if (hasActiveExportSession()) {
      return { ok: false, busy: true, error: "请先保存或放弃当前导出" };
    }

    operationPhase = "install";
    publish({ status: "installing", targetVersion: state.targetVersion });
    try {
      // pendingInstall deliberately remains true. If the native updater emits
      // an asynchronous error, the same command remains a real install retry.
      updater.quitAndInstall();
      return { ok: true };
    } catch (error) {
      publishError("install", error);
      return { ok: false, error: messageForPhase("install") };
    }
  };

  if (supported) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;

    updater.on("checking-for-update", () => {
      operationPhase = "check";
      publish({ status: "checking", targetVersion: state.targetVersion });
    });
    updater.on("update-available", (info: UpdateInfoLike) => {
      pendingInstall = false;
      operationPhase = "download";
      publish({ status: "downloading", targetVersion: info.version, percent: 0 });
    });
    updater.on("download-progress", (progress: DownloadProgressLike) => {
      operationPhase = "download";
      publish({
        status: "downloading",
        targetVersion: state.targetVersion,
        percent: Math.min(100, Math.max(0, progress.percent)),
        transferred: progress.transferred,
        total: progress.total,
        bytesPerSecond: progress.bytesPerSecond,
      });
    });
    updater.on("update-downloaded", (info: UpdateInfoLike) => {
      pendingInstall = true;
      operationPhase = "install";
      publish({ status: "ready", targetVersion: info.version });
    });
    updater.on("update-not-available", (info: UpdateInfoLike) => {
      pendingInstall = false;
      operationPhase = "check";
      publish({ status: "not-available", targetVersion: info.version });
    });
    updater.on("error", (error: unknown) => {
      if (operationPhase === "download") pendingInstall = false;
      publishError(operationPhase, error);
    });
  }

  return {
    getState: (): DesktopUpdateState => state,
    check,
    install,
  };
}
