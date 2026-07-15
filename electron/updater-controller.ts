import type {
  DesktopUpdateCommandResult,
  DesktopUpdateErrorPhase,
  DesktopUpdateState,
} from "../lib/desktop-bridge";
import type { AppUpdater } from "electron-updater";
import {
  createUpdateRestartGuard,
  type UpdateRestartGuard,
} from "./update-restart-guard.ts";

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

function versionsMatch(left: string, right: string): boolean {
  return left.trim().replace(/^v/i, "") === right.trim().replace(/^v/i, "");
}

export function createDesktopUpdaterController({
  updater,
  currentVersion,
  supported,
  requiresInstallReadySignal = false,
  hasActiveExportSession,
  restartGuard = createUpdateRestartGuard(),
  onState,
  logger = console,
}: {
  updater: AutoUpdaterLike;
  currentVersion: string;
  supported: boolean;
  requiresInstallReadySignal?: boolean;
  hasActiveExportSession: () => boolean;
  restartGuard?: UpdateRestartGuard;
  onState?: (state: DesktopUpdateState) => void;
  logger?: UpdaterLogger;
}) {
  let revision = 0;
  let pendingInstall = false;
  let installRequested = false;
  let stagedTargetVersion: string | null = null;
  let nativeInstallReady = false;
  // A macOS installer is never actionable until the current check has either
  // exposed no separate download operation or that operation has fulfilled.
  let downloadOperationSucceeded = false;
  let downloadOperationId = 0;
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

  const promoteStagedInstallerIfReady = (): void => {
    if (!stagedTargetVersion || pendingInstall || installRequested) return;
    if (!downloadOperationSucceeded) return;
    if (requiresInstallReadySignal && !nativeInstallReady) return;

    const targetVersion = stagedTargetVersion;
    stagedTargetVersion = null;
    pendingInstall = true;
    operationPhase = "install";
    publish({ status: "ready", targetVersion });
  };

  const check = (): Promise<DesktopUpdateCommandResult> => {
    if (!supported) {
      return Promise.resolve({ ok: false, error: "当前环境不支持自动更新" });
    }
    if (state.status === "installing" || installRequested) {
      return Promise.resolve({ ok: false, busy: true, error: "应用正在准备重启" });
    }
    if (pendingInstall) {
      return Promise.resolve({ ok: false, error: "新版已下载完成，请重启安装" });
    }
    if (state.status === "downloading") {
      return Promise.resolve({ ok: false, busy: true, error: "新版正在后台下载" });
    }
    if (state.status === "preparing") {
      return Promise.resolve({ ok: false, busy: true, error: "新版正在由系统准备" });
    }
    if (checkInFlight) return checkInFlight;

    operationPhase = "check";
    nativeInstallReady = false;
    downloadOperationSucceeded = false;
    const operationId = ++downloadOperationId;
    publish({ status: "checking", targetVersion: state.targetVersion });
    checkInFlight = updater
      .checkForUpdates()
      .then((result) => {
        // electron-updater exposes its auto-download as a separate promise.
        // Consuming it here is required even though it also emits `error`;
        // otherwise a failed download becomes an unhandled rejection in Node.
        if (result?.downloadPromise) {
          void result.downloadPromise.then(
            () => {
              if (operationId !== downloadOperationId) return;
              downloadOperationSucceeded = true;
              promoteStagedInstallerIfReady();
            },
            (error: unknown) => {
              if (operationId !== downloadOperationId) return;
              downloadOperationSucceeded = false;
              nativeInstallReady = false;
              pendingInstall = false;
              stagedTargetVersion = null;
              operationPhase = "download";
              publishError("download", error);
            },
          );
        } else if (operationId === downloadOperationId) {
          // No separate operation means checkForUpdates itself covered all work
          // exposed by this updater implementation.
          downloadOperationSucceeded = true;
          promoteStagedInstallerIfReady();
        }
        return { ok: true as const };
      })
      .catch((error: unknown) => {
        if (operationId !== downloadOperationId) {
          return { ok: false as const, error: messageForPhase("check") };
        }
        downloadOperationSucceeded = false;
        nativeInstallReady = false;
        stagedTargetVersion = null;
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
    if (state.status === "installing" || installRequested) {
      return { ok: false, busy: true, error: "应用正在准备重启" };
    }
    if (!restartGuard.commit()) {
      return { ok: false, busy: true, error: "应用正在准备重启" };
    }

    operationPhase = "install";
    installRequested = true;
    try {
      publish({ status: "installing", targetVersion: state.targetVersion });
      // pendingInstall deliberately remains true. If the native updater emits
      // an asynchronous error, the same command remains a real install retry.
      updater.quitAndInstall();
      // EventEmitters are synchronous. A native updater can emit `error`
      // during quitAndInstall() and still return normally, so re-check the
      // latch before acknowledging the command.
      if (!installRequested || !restartGuard.isCommitted()) {
        return { ok: false, error: messageForPhase("install") };
      }
      return { ok: true };
    } catch (error) {
      installRequested = false;
      restartGuard.release();
      publishError("install", error);
      return { ok: false, error: messageForPhase("install") };
    }
  };

  const markInstallReady = (nativeTargetVersion?: string): void => {
    // MacUpdater always dispatches its outer event before asking the native
    // updater to stage the zip. Requiring that staged target rejects an early
    // or previous-operation native event instead of arming the next download.
    if (
      !requiresInstallReadySignal ||
      !stagedTargetVersion ||
      state.status !== "preparing" ||
      pendingInstall ||
      installRequested
    ) {
      return;
    }
    if (
      nativeTargetVersion &&
      !versionsMatch(nativeTargetVersion, stagedTargetVersion)
    ) {
      return;
    }
    nativeInstallReady = true;
    promoteStagedInstallerIfReady();
  };

  if (supported) {
    updater.autoDownload = true;
    updater.autoInstallOnAppQuit = true;

    updater.on("checking-for-update", () => {
      if (
        pendingInstall ||
        installRequested ||
        state.status === "downloading" ||
        state.status === "preparing"
      ) {
        return;
      }
      operationPhase = "check";
      publish({ status: "checking", targetVersion: state.targetVersion });
    });
    updater.on("update-available", (info: UpdateInfoLike) => {
      if (
        pendingInstall ||
        installRequested ||
        state.status === "downloading" ||
        state.status === "preparing"
      ) {
        return;
      }
      pendingInstall = false;
      stagedTargetVersion = null;
      nativeInstallReady = false;
      downloadOperationSucceeded = false;
      operationPhase = "download";
      publish({ status: "downloading", targetVersion: info.version, percent: 0 });
    });
    updater.on("download-progress", (progress: DownloadProgressLike) => {
      if (pendingInstall || installRequested || state.status !== "downloading") return;
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
      if (
        pendingInstall ||
        installRequested ||
        state.status !== "downloading" ||
        !state.targetVersion ||
        !versionsMatch(info.version, state.targetVersion)
      ) {
        return;
      }
      stagedTargetVersion = info.version;
      pendingInstall = false;
      installRequested = false;
      operationPhase = requiresInstallReadySignal ? "download" : "install";
      if (requiresInstallReadySignal) {
        publish({ status: "preparing", targetVersion: info.version });
      }
      promoteStagedInstallerIfReady();
    });
    updater.on("update-not-available", (info: UpdateInfoLike) => {
      if (
        pendingInstall ||
        installRequested ||
        state.status === "downloading" ||
        state.status === "preparing"
      ) {
        return;
      }
      pendingInstall = false;
      stagedTargetVersion = null;
      nativeInstallReady = false;
      downloadOperationSucceeded = false;
      operationPhase = "check";
      publish({ status: "not-available", targetVersion: info.version });
    });
    updater.on("error", (error: unknown) => {
      // `pendingInstall` is set only after macOS's native updater confirms that
      // Squirrel has fetched the staged zip. Errors after that point, but before
      // an explicit restart, cannot invalidate the verified installer.
      if (pendingInstall && !installRequested) {
        logger.error("[auto-update] ignored error after installer became ready", error);
        return;
      }
      if (operationPhase === "download") {
        downloadOperationSucceeded = false;
        nativeInstallReady = false;
        pendingInstall = false;
        stagedTargetVersion = null;
      }
      if (operationPhase === "install") {
        installRequested = false;
        restartGuard.release();
      }
      publishError(operationPhase, error);
    });
  }

  return {
    getState: (): DesktopUpdateState => state,
    check,
    install,
    markInstallReady,
  };
}
