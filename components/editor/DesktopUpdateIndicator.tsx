"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  LoaderCircle,
  RefreshCw,
  TriangleAlert,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  classifyDesktopUpdateClient,
  inferDesktopClientVersion,
  isDesktopUpdateAvailable,
  type DesktopUpdateClientMode,
  type DesktopUpdateState,
} from "@/lib/desktop-bridge";
import {
  canAutoCheckDesktopUpdate,
  deriveDesktopUpdatePresentation,
  desktopReleaseIsAvailable,
  parseDesktopReleaseInfo,
  type DesktopReleaseInfo,
  type DesktopUpdatePresentationKind,
} from "@/lib/desktop-update";
import { useExportSessionActive } from "@/lib/export-session";
import { useEditor } from "@/lib/store";
import { cn } from "@/lib/utils";

const noopSubscribe = () => () => {};
const RELEASE_POLL_MS = 5 * 60 * 1000;
const STALLED_DOWNLOAD_MS = 45_000;
const SLOW_RESTART_MS = 10_000;

function useDesktopUpdateClient(): {
  mode: DesktopUpdateClientMode;
  inferredVersion: string | null;
} {
  const mode = useSyncExternalStore<DesktopUpdateClientMode>(
    noopSubscribe,
    () => classifyDesktopUpdateClient(window.electronRender),
    () => "hidden",
  );
  const inferredVersion = useSyncExternalStore<string | null>(
    noopSubscribe,
    () => inferDesktopClientVersion(window.electronRender),
    () => null,
  );
  return { mode, inferredVersion };
}

function formatBytes(bytes: number | undefined): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

const toneClass: Record<Exclude<DesktopUpdatePresentationKind, "hidden">, string> = {
  manual: "border-amber-300/15 bg-amber-300/[0.045]",
  legacy: "border-white/[0.09] bg-white/[0.035]",
  checking: "border-white/[0.09] bg-white/[0.035]",
  downloading: "border-[#ff5d9a]/18 bg-[#ff2d7e]/[0.045]",
  preparing: "border-[#ff5d9a]/18 bg-[#ff2d7e]/[0.045]",
  stalled: "border-amber-300/15 bg-amber-300/[0.045]",
  ready: "border-emerald-300/16 bg-emerald-300/[0.045]",
  installing: "border-[#ff5d9a]/18 bg-[#ff2d7e]/[0.045]",
  error: "border-amber-300/15 bg-amber-300/[0.045]",
};

function StatusIcon({ kind, pending }: { kind: DesktopUpdatePresentationKind; pending: boolean }) {
  if (kind === "ready") return <CheckCircle2 className="size-4 text-emerald-400" />;
  if (kind === "manual" || kind === "downloading") {
    return <Download className="size-4 text-[#ff72aa]" />;
  }
  if (kind === "stalled" || kind === "error") {
    return <TriangleAlert className="size-4 text-amber-300" />;
  }
  return (
    <LoaderCircle
      className={cn(
        "size-4 text-[#ff72aa] motion-reduce:animate-none",
        (pending ||
          kind === "legacy" ||
          kind === "checking" ||
          kind === "preparing" ||
          kind === "installing") &&
          "animate-spin",
      )}
    />
  );
}

export function DesktopUpdateIndicator() {
  const { mode, inferredVersion } = useDesktopUpdateClient();
  const exportActive = useExportSessionActive();
  const localAssetCount = useEditor((state) => Object.keys(state.assetUrls).length);
  const [release, setRelease] = useState<DesktopReleaseInfo | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [updateStateReady, setUpdateStateReady] = useState(false);
  const [stalledRevision, setStalledRevision] = useState<number | null>(null);
  const [slowRestartRevision, setSlowRestartRevision] = useState<number | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const indicatorRef = useRef<HTMLDivElement>(null);
  const latestRevisionRef = useRef(-1);
  const requestedVersionRef = useRef<string | null>(null);

  useEffect(() => {
    if (mode === "hidden") return;

    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;

    const checkRelease = async () => {
      controller = new AbortController();
      try {
        const response = await fetch("/api/desktop-release", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`release status ${response.status}`);
        const next = parseDesktopReleaseInfo(await response.json());
        if (!disposed && next) setRelease(next);
      } catch {
        // Keep the last verified release. A temporary API failure must not make
        // an active download or a ready installer disappear from the toolbar.
      } finally {
        if (!disposed) timer = window.setTimeout(() => void checkRelease(), RELEASE_POLL_MS);
      }
    };

    void checkRelease();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [mode]);

  useEffect(() => {
    latestRevisionRef.current = -1;
    if (mode !== "observable") return;

    const bridge = window.electronRender;
    let disposed = false;
    if (!bridge?.getUpdateState || !bridge.onUpdateState) {
      queueMicrotask(() => {
        if (disposed) return;
        setUpdateStateReady(true);
        setUpdateState({
          revision: 0,
          status: "error",
          currentVersion: inferredVersion ?? "0.2.2",
          errorPhase: "check",
          message: "无法读取自动更新状态",
          retryable: true,
        });
      });
      return () => {
        disposed = true;
      };
    }

    const apply = (next: DesktopUpdateState) => {
      if (disposed || next.revision <= latestRevisionRef.current) return;
      latestRevisionRef.current = next.revision;
      setUpdateState(next);
      setUpdateStateReady(true);
      setActionError(null);
      if (next.status !== "installing") setActionPending(false);
    };

    const unsubscribe = bridge.onUpdateState(apply);
    void bridge.getUpdateState().then(apply).catch(() => {
      // Subscription is registered first so no state transition is missed.
      // If a newer event already arrived, a failed snapshot must not replace
      // it with a synthetic revision-0 error.
      if (disposed || latestRevisionRef.current >= 0) return;
      setUpdateStateReady(true);
      setUpdateState({
        revision: 0,
        status: "error",
        currentVersion: inferredVersion ?? "0.2.2",
        errorPhase: "check",
        message: "无法读取自动更新状态",
        retryable: true,
      });
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [inferredVersion, mode]);

  const currentVersion = updateState?.currentVersion ?? inferredVersion;
  const releaseOutdated =
    !!release &&
    isDesktopUpdateAvailable({
      mode,
      releaseAvailable: desktopReleaseIsAvailable(release),
      currentVersion,
      latestVersion: release.version,
    });

  useEffect(() => {
    if (
      mode !== "observable" ||
      !releaseOutdated ||
      !canAutoCheckDesktopUpdate(updateState) ||
      !release ||
      requestedVersionRef.current === release.version
    ) {
      return;
    }
    requestedVersionRef.current = release.version;
    void window.electronRender?.retryUpdate?.().catch(() => {});
  }, [mode, release, releaseOutdated, updateState]);

  useEffect(() => {
    if (updateState?.status !== "downloading" && updateState?.status !== "preparing") return;
    const revision = updateState.revision;
    const timer = window.setTimeout(() => setStalledRevision(revision), STALLED_DOWNLOAD_MS);
    return () => window.clearTimeout(timer);
  }, [updateState?.revision, updateState?.status]);

  useEffect(() => {
    if (updateState?.status !== "installing") return;
    const revision = updateState.revision;
    const timer = window.setTimeout(
      () => setSlowRestartRevision(revision),
      SLOW_RESTART_MS,
    );
    return () => window.clearTimeout(timer);
  }, [updateState?.revision, updateState?.status]);

  const presentation = deriveDesktopUpdatePresentation({
    mode,
    inferredVersion,
    release,
    updateState,
    updateStateReady: mode !== "observable" || updateStateReady,
    exportActive,
    downloadStalled:
      (updateState?.status === "downloading" || updateState?.status === "preparing") &&
      stalledRevision === updateState.revision,
    restartSlow:
      updateState?.status === "installing" && slowRestartRevision === updateState.revision,
  });

  const retryUpdate = async () => {
    const retry = window.electronRender?.retryUpdate;
    if (!retry) return;
    setActionPending(true);
    setActionError(null);
    const result = await retry().catch(() => ({
      ok: false as const,
      error: "暂时无法重新检查更新",
    }));
    if (!result.ok) {
      setActionError(result.error);
    } else {
      window.requestAnimationFrame(() => indicatorRef.current?.focus({ preventScroll: true }));
    }
    setActionPending(false);
  };

  const restartAndInstall = async () => {
    const install = window.electronRender?.restartAndInstall;
    if (!install || exportActive) return;
    if (
      localAssetCount > 0 &&
      !window.confirm(
        `重启后需要重新选择 ${localAssetCount} 个本地素材；文字和参数已经自动保存。是否现在重启更新？`,
      )
    ) {
      return;
    }

    setActionPending(true);
    setActionError(null);
    const result = await install().catch(() => ({
      ok: false as const,
      error: "应用未能自动重启",
    }));
    if (!result.ok) {
      setActionError(result.error);
      setActionPending(false);
    }
  };

  const percent = presentation.percent;
  const announcedPercent =
    typeof percent === "number" ? Math.floor(percent / 10) * 10 : undefined;
  const transferred = formatBytes(updateState?.transferred);
  const total = formatBytes(updateState?.total);
  const progressText =
    typeof percent === "number"
      ? `${Math.round(percent)}%${transferred && total ? ` · ${transferred} / ${total}` : ""}`
      : null;
  const detail = actionError ?? presentation.detail;
  const manualHref = release?.downloadUrl;
  const preparationStalled =
    presentation.kind === "stalled" && updateState?.status === "preparing";
  const isAlert = presentation.alert || !!actionError;
  const liveMessage =
    presentation.kind === "hidden"
      ? ""
      : presentation.kind === "downloading" && announcedPercent !== undefined
        ? `${presentation.title}，${announcedPercent}%，${presentation.detail}`
        : `${presentation.title}，${detail}`;

  return (
    <>
      <span
        role={isAlert ? "alert" : "status"}
        aria-live={isAlert ? "assertive" : "polite"}
        aria-atomic="true"
        className="sr-only"
      >
        {liveMessage}
      </span>

      {presentation.kind === "hidden" ? null : (
        <div
          ref={indicatorRef}
          tabIndex={-1}
          role="group"
          aria-label={`${presentation.title}。${detail}`}
          data-update-indicator={presentation.kind}
          className={cn(
            "no-drag-region relative flex h-10 w-full max-w-[480px] min-w-0 items-center gap-2.5 overflow-hidden rounded-xl border px-3 shadow-sm focus-visible:ring-2 focus-visible:ring-[#ff72aa]/45 focus-visible:outline-none",
            toneClass[presentation.kind],
          )}
          title={`${presentation.title}。${detail}`}
        >
          <span className="grid size-6 shrink-0 place-items-center rounded-lg bg-black/15">
            <StatusIcon kind={presentation.kind} pending={actionPending} />
          </span>

          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-[12px] font-medium text-white/88">
                {presentation.title}
              </span>
              {progressText ? (
                <span className="shrink-0 text-[10px] font-medium tabular-nums text-white/68">
                  {progressText}
                </span>
              ) : null}
            </div>
            <p
              className={cn(
                "truncate text-[10px] leading-4 text-white/52",
                actionError && "text-amber-200/75",
              )}
            >
              {detail}
            </p>
          </div>

          {presentation.primaryAction === "restart" ? (
            <Button
              size="sm"
              disabled={actionPending || presentation.restartDisabled}
              onClick={() => void restartAndInstall()}
              className="h-7 shrink-0 rounded-lg bg-[#ff2d7e] px-2.5 text-[11px] text-white shadow-sm shadow-[#ff2d7e]/15 hover:bg-[#f32674]"
            >
              <RefreshCw
                className={cn(
                  "size-3.5",
                  actionPending && "animate-spin motion-reduce:animate-none",
                )}
              />
              {actionPending ? "正在重启…" : presentation.primaryLabel}
            </Button>
          ) : presentation.primaryAction === "retry" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={actionPending}
              onClick={() => void retryUpdate()}
              className="h-7 shrink-0 border-white/10 bg-white/[0.035] px-2 text-[11px] text-white/78 hover:bg-white/[0.07] hover:text-white"
            >
              <RefreshCw
                className={cn(
                  "size-3.5",
                  actionPending && "animate-spin motion-reduce:animate-none",
                )}
              />
              {actionPending ? "重试中…" : presentation.primaryLabel}
            </Button>
          ) : presentation.primaryAction === "manual" && manualHref ? (
            <a
              href={manualHref}
              target="_blank"
              rel="noopener noreferrer"
              className={cn(
                buttonVariants({ variant: "outline", size: "sm" }),
                "h-7 shrink-0 border-white/10 bg-white/[0.035] px-2 text-[11px] text-white/78 hover:bg-white/[0.07] hover:text-white",
              )}
            >
              {presentation.primaryLabel}
              <ExternalLink className="size-3" />
              <span className="sr-only">（在浏览器中打开）</span>
            </a>
          ) : null}

          {presentation.showManualAction && manualHref ? (
            <a
              href={manualHref}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 text-[11px] text-white/48 underline-offset-4 hover:text-white/75 hover:underline"
            >
              手动下载
              <span className="sr-only">（在浏览器中打开）</span>
            </a>
          ) : null}

          {presentation.kind === "downloading" || presentation.kind === "stalled" ? (
            <div
              role="progressbar"
              aria-label={preparationStalled ? "macOS 更新准备状态" : "客户端更新下载进度"}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={typeof percent === "number" ? Math.round(percent) : undefined}
              aria-valuetext={
                progressText ?? (preparationStalled ? "macOS 正在准备更新" : "正在获取下载进度")
              }
              className="absolute inset-x-0 bottom-0 h-0.5 overflow-hidden bg-white/[0.04]"
            >
              <div
                className={cn(
                  "h-full bg-[linear-gradient(90deg,#ff2d7e,#ff78b2)] transition-[width] duration-300 motion-reduce:transition-none",
                  typeof percent !== "number" &&
                    "w-1/3 animate-[update-indeterminate_1.4s_ease-in-out_infinite] motion-reduce:animate-none",
                )}
                style={typeof percent === "number" ? { width: `${percent}%` } : undefined}
              />
            </div>
          ) : null}
        </div>
      )}
    </>
  );
}
