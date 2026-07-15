import {
  compareDesktopVersions,
  isDesktopUpdateAvailable,
  type DesktopUpdateClientMode,
  type DesktopUpdateState,
} from "./desktop-bridge.ts";

export type DesktopReleaseInfo = {
  available: boolean;
  /** Compatibility with the v0.2.2 Web gate. New clients use `available`. */
  required?: boolean;
  version: string;
  downloadUrl: string;
  releasePageUrl?: string;
  downloadSizeBytes?: number;
  minimumSupportedVersion?: string | null;
};

export type DesktopUpdatePresentationKind =
  | "hidden"
  | "manual"
  | "legacy"
  | "checking"
  | "downloading"
  | "preparing"
  | "stalled"
  | "ready"
  | "installing"
  | "error";

export type DesktopUpdatePresentation = {
  kind: DesktopUpdatePresentationKind;
  title: string;
  detail: string;
  targetVersion?: string;
  percent?: number;
  indeterminate?: boolean;
  primaryAction?: "restart" | "retry" | "manual";
  primaryLabel?: string;
  showManualAction?: boolean;
  restartDisabled?: boolean;
  alert?: boolean;
};

export function parseDesktopReleaseInfo(data: unknown): DesktopReleaseInfo | null {
  if (!data || typeof data !== "object") return null;
  const candidate = data as Partial<DesktopReleaseInfo>;
  if (typeof candidate.version !== "string" || typeof candidate.downloadUrl !== "string") {
    return null;
  }
  return {
    available: candidate.available === true || candidate.required === true,
    required: candidate.required === true,
    version: candidate.version,
    downloadUrl: candidate.downloadUrl,
    releasePageUrl:
      typeof candidate.releasePageUrl === "string" ? candidate.releasePageUrl : undefined,
    downloadSizeBytes:
      typeof candidate.downloadSizeBytes === "number" &&
      Number.isFinite(candidate.downloadSizeBytes)
        ? candidate.downloadSizeBytes
        : undefined,
    minimumSupportedVersion:
      typeof candidate.minimumSupportedVersion === "string"
        ? candidate.minimumSupportedVersion
        : null,
  };
}

const HIDDEN_PRESENTATION: DesktopUpdatePresentation = {
  kind: "hidden",
  title: "",
  detail: "",
};

export function desktopReleaseIsAvailable(release: DesktopReleaseInfo | null): boolean {
  return !!release && (release.available || release.required === true);
}

export function canAutoCheckDesktopUpdate(state: DesktopUpdateState | null): boolean {
  return (
    state?.status === "idle" ||
    state?.status === "not-available" ||
    (state?.status === "error" && state.errorPhase === "check")
  );
}

function sanitizePercent(percent: number | undefined): number | undefined {
  if (typeof percent !== "number" || !Number.isFinite(percent)) return undefined;
  return Math.min(100, Math.max(0, percent));
}

function versionsMatch(left: string | undefined, right: string | undefined): boolean {
  if (!left || !right) return false;
  return compareDesktopVersions(left, right) === 0;
}

function displayVersion(version: string | undefined): string {
  return version ? `v${version.replace(/^v/, "")}` : "新版本";
}

export function deriveDesktopUpdatePresentation({
  mode,
  inferredVersion,
  release,
  updateState,
  updateStateReady,
  exportActive,
  downloadStalled = false,
  restartSlow = false,
}: {
  mode: DesktopUpdateClientMode;
  inferredVersion: string | null;
  release: DesktopReleaseInfo | null;
  updateState: DesktopUpdateState | null;
  updateStateReady: boolean;
  exportActive: boolean;
  downloadStalled?: boolean;
  restartSlow?: boolean;
}): DesktopUpdatePresentation {
  if (mode === "hidden") return HIDDEN_PRESENTATION;

  const releaseAvailable = desktopReleaseIsAvailable(release);
  const currentVersion =
    mode === "observable" ? (updateState?.currentVersion ?? inferredVersion) : inferredVersion;
  const outdated =
    !!release &&
    isDesktopUpdateAvailable({
      mode,
      releaseAvailable,
      currentVersion,
      latestVersion: release.version,
    });

  if (mode === "manual") {
    if (!outdated || !release) return HIDDEN_PRESENTATION;
    return {
      kind: "manual",
      title: `新版 ${displayVersion(release.version)} 可用`,
      detail: "当前版本需要手动安装；你可以继续编辑，准备好后再更新。",
      targetVersion: release.version,
      primaryAction: "manual",
      primaryLabel: "下载安装包",
    };
  }

  if (mode === "legacy-auto") {
    if (!outdated || !release) return HIDDEN_PRESENTATION;
    const hasStatusButUnsafeRestart =
      !!inferredVersion && compareDesktopVersions(inferredVersion, "0.2.2") !== -1;
    return {
      kind: "legacy",
      title: `正在后台准备 ${displayVersion(release.version)}`,
      detail: hasStatusButUnsafeRestart
        ? "你可以继续编辑和导出；稍后正常退出应用时会自动安装。"
        : "旧版无法显示实时进度；你可以继续使用，稍后正常退出应用即可安装。",
      targetVersion: release.version,
      indeterminate: true,
      primaryAction: "manual",
      primaryLabel: "手动下载",
    };
  }

  if (!updateStateReady) return HIDDEN_PRESENTATION;

  const status = updateState?.status ?? "idle";
  const stateOwnsTarget =
    status === "downloading" ||
    status === "preparing" ||
    status === "ready" ||
    status === "installing" ||
    (status === "error" && updateState?.errorPhase !== "check");
  const targetVersion = stateOwnsTarget
    ? (updateState?.targetVersion ?? release?.version)
    : (outdated ? release?.version : updateState?.targetVersion);
  const releaseMatchesTarget =
    !!release && releaseAvailable && (!updateState?.targetVersion || versionsMatch(release.version, targetVersion));
  const activeUpdate =
    status === "downloading" ||
    status === "preparing" ||
    status === "ready" ||
    status === "installing";
  const installFailed = status === "error" && updateState?.errorPhase === "install";
  const targetIsNewer =
    !!currentVersion && !!targetVersion && compareDesktopVersions(currentVersion, targetVersion) === -1;

  if (!outdated && !activeUpdate && !installFailed && !targetIsNewer) {
    return HIDDEN_PRESENTATION;
  }

  if (status === "downloading") {
    const percent = sanitizePercent(updateState?.percent);
    if (downloadStalled) {
      return {
        kind: "stalled",
        title: "下载暂时没有进展",
        detail: "不影响当前使用；可以继续等待，或改用安装包。",
        targetVersion,
        percent,
        primaryAction: releaseMatchesTarget ? "manual" : undefined,
        primaryLabel: "手动下载",
      };
    }
    return {
      kind: "downloading",
      title: `正在后台下载 ${displayVersion(targetVersion)}`,
      detail: "下载完成后会等待你点击重启；期间可继续编辑和导出。",
      targetVersion,
      percent,
    };
  }

  if (status === "preparing") {
    if (downloadStalled) {
      return {
        kind: "stalled",
        title: "系统准备更新暂时没有进展",
        detail: "不影响当前使用；可以继续等待，或改用安装包。",
        targetVersion,
        indeterminate: true,
        primaryAction: releaseMatchesTarget ? "manual" : undefined,
        primaryLabel: "手动下载",
      };
    }
    return {
      kind: "preparing",
      title: `正在准备 ${displayVersion(targetVersion)}`,
      detail: "下载已完成，macOS 正在校验；期间可继续编辑和导出。",
      targetVersion,
      indeterminate: true,
    };
  }

  if (status === "ready") {
    return {
      kind: "ready",
      title: `${displayVersion(targetVersion)} 已下载完成`,
      detail: exportActive
        ? "当前导出完成并关闭后即可重启。"
        : "准备好后再重启；正常退出应用时也会自动安装。",
      targetVersion,
      primaryAction: "restart",
      primaryLabel: exportActive ? "导出后可重启" : "立即重启更新",
      restartDisabled: exportActive,
    };
  }

  if (status === "installing") {
    return {
      kind: "installing",
      title: restartSlow ? "应用尚未自动退出" : "正在重启并完成更新",
      detail: restartSlow
        ? "请按 ⌘Q 完全退出，再重新打开应用完成更新。"
        : "应用即将关闭；重新打开后就是新版本。",
      targetVersion,
      indeterminate: true,
    };
  }

  if (installFailed) {
    return {
      kind: "error",
      title: "没有成功重启，新版仍已准备好",
      detail: updateState?.message ?? "可以在方便时再次尝试重启。",
      targetVersion,
      primaryAction: "restart",
      primaryLabel: "再次重启更新",
      showManualAction: releaseMatchesTarget,
      alert: true,
    };
  }

  if (status === "error" || status === "not-available" || status === "unsupported") {
    if (status === "unsupported") {
      return {
        kind: "manual",
        title: `${displayVersion(targetVersion ?? release?.version)} 可用`,
        detail: "当前环境无法自动更新；你可以继续使用，准备好后手动安装。",
        targetVersion,
        primaryAction: releaseMatchesTarget ? "manual" : undefined,
        primaryLabel: "下载安装包",
      };
    }
    return {
      kind: "error",
      title: status === "not-available" ? "新版暂未开始下载" : "后台更新暂未完成",
      detail: updateState?.message
        ? `${updateState.message}；不影响当前使用。`
        : "不影响当前使用，可以稍后重新尝试。",
      targetVersion,
      primaryAction: "retry",
      primaryLabel: "重新尝试",
      showManualAction: releaseMatchesTarget,
    };
  }

  return {
    kind: "checking",
    title: "正在准备后台更新",
    detail: "你可以继续编辑和导出，不会中断当前操作。",
    targetVersion,
    indeterminate: true,
  };
}
