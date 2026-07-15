"use client";

import type { ReactNode } from "react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  CheckCircle2,
  CircleHelp,
  Download,
  ExternalLink,
  HardDriveDownload,
  LoaderCircle,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
} from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  classifyDesktopUpdateGate,
  inferDesktopClientVersion,
  shouldBlockDesktopUpdate,
  type DesktopUpdateGateMode,
  type DesktopUpdateState,
} from "@/lib/desktop-bridge";
import { cn } from "@/lib/utils";
import { useExportSessionActive } from "@/lib/export-session";
import { Logo } from "./Logo";

const noopSubscribe = () => () => {};
const POLL_MS = 15_000;
const LEGACY_WAIT_MS = 60_000;
const STALLED_DOWNLOAD_MS = 45_000;

type ReleaseInfo = {
  required: boolean;
  version: string;
  downloadUrl: string;
  releasePageUrl?: string;
  downloadSizeBytes?: number;
};

function useDesktopUpdateClient(): {
  mode: DesktopUpdateGateMode;
  inferredVersion: string | null;
} {
  const mode = useSyncExternalStore<DesktopUpdateGateMode>(
    noopSubscribe,
    () => classifyDesktopUpdateGate(window.electronRender),
    () => "hidden",
  );
  const inferredVersion = useSyncExternalStore<string | null>(
    noopSubscribe,
    () => inferDesktopClientVersion(window.electronRender),
    () => null,
  );
  return { mode, inferredVersion };
}

function withoutVersionPrefix(version: string): string {
  return version.replace(/^v/, "");
}

function formatBytes(bytes?: number): string | null {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes < 0) return null;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes >= 100 * 1024 * 1024 ? 0 : 1)} MB`;
}

function InstallSteps() {
  const steps = [
    ["下载并打开安装包", "下载会在系统浏览器中开始"],
    ["完全退出旧版", "回到当前应用，按 ⌘Q 完全退出"],
    ["拖入“应用程序”", "出现询问时选择“替换”"],
    ["重新打开应用", "从“应用程序”中打开小音符起号助手"],
  ];

  return (
    <ol className="space-y-2.5" aria-label="安装步骤">
      {steps.map(([title, detail], index) => (
        <li
          key={title}
          className="grid grid-cols-[28px_1fr] items-start gap-3 rounded-xl border border-white/[0.06] bg-white/[0.025] px-3 py-2.5"
        >
          <span className="grid size-7 place-items-center rounded-lg bg-white/[0.055] text-[11px] font-semibold tabular-nums text-white/70">
            {index + 1}
          </span>
          <span className="pt-0.5">
            <strong className="block text-[13px] font-medium text-white/88">{title}</strong>
            <span className="mt-0.5 block text-[11px] leading-4 text-white/58">{detail}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function DownloadAction({
  release,
  primary = false,
  label = "下载最新版",
}: {
  release: ReleaseInfo;
  primary?: boolean;
  label?: string;
}) {
  const size = formatBytes(release.downloadSizeBytes);
  return (
    <a
      href={release.downloadUrl}
      target="_blank"
      rel="noopener noreferrer"
      data-update-primary={primary ? "true" : undefined}
      className={cn(
        buttonVariants({
          variant: primary ? "default" : "outline",
          size: "lg",
        }),
          "h-11 w-full gap-2 rounded-xl text-[13px]",
          primary
            ? "bg-[#ff2d7e] text-white shadow-lg shadow-[#ff2d7e]/15 hover:bg-[#f32674]"
            : "border-white/10 bg-white/[0.035] text-white/78 hover:bg-white/[0.07] hover:text-white",
      )}
    >
      <Download className="size-4" />
      {label} {withoutVersionPrefix(release.version)}
      {size ? <span className="text-white/60">· {size}</span> : null}
      <ExternalLink className="ml-auto size-3.5 text-white/60" />
    </a>
  );
}

function ActionErrorNotice({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div
      role="alert"
      className="rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-3.5 py-3 text-[11px] leading-5 text-white/65"
    >
      {message}
    </div>
  );
}

function GateCard({
  release,
  currentVersion,
  badge,
  badgeIcon,
  title,
  description,
  children,
  actions,
  statusRole = "status",
}: {
  release: ReleaseInfo;
  currentVersion?: string;
  badge: string;
  badgeIcon: ReactNode;
  title: string;
  description: string;
  children?: ReactNode;
  actions?: ReactNode;
  statusRole?: "status" | "alert";
}) {
  return (
    <div className="relative w-full max-w-[520px] overflow-hidden rounded-[26px] border border-white/[0.1] bg-[#15151d]/97 shadow-[0_30px_100px_rgba(0,0,0,0.58)]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-32 bg-[radial-gradient(420px_150px_at_18%_-10%,rgba(255,45,126,0.18),transparent_72%)]"
      />
      <div className="relative max-h-[calc(100vh-72px)] overflow-y-auto p-6 sm:p-7">
        <header className="flex items-start justify-between gap-5">
          <div className="flex items-center gap-3.5">
            <Logo className="size-12 rounded-[15px] shadow-lg shadow-[#ff2d7e]/20" />
            <div>
              <div className="flex w-fit items-center gap-1.5 rounded-full border border-[#ff2d7e]/20 bg-[#ff2d7e]/8 px-2.5 py-1 text-[10px] font-semibold tracking-[0.08em] text-[#ff78ac]">
                {badgeIcon}
                {badge}
              </div>
              <p className="mt-1.5 text-[10px] tracking-[0.08em] text-white/48">小音符起号助手</p>
            </div>
          </div>
          <div className="rounded-lg border border-white/[0.07] bg-black/15 px-2.5 py-1.5 text-right text-[10px] leading-4 text-white/52">
            <span>{currentVersion ? `v${withoutVersionPrefix(currentVersion)}` : "旧版"}</span>
            <span className="mx-1.5 text-white/15">→</span>
            <strong className="font-medium text-white/68">{release.version}</strong>
          </div>
        </header>

        <section className="mt-6" role={statusRole} aria-live={statusRole === "status" ? "polite" : undefined}>
          <h1 id="required-update-title" className="text-[22px] font-semibold tracking-[-0.02em] text-white">
            {title}
          </h1>
          <p id="required-update-description" className="mt-2 text-[13px] leading-6 text-white/68">
            {description}
          </p>
        </section>

        {children ? <div className="mt-5">{children}</div> : null}
        {actions ? <div className="mt-5 space-y-2.5">{actions}</div> : null}

        <div className="mt-5 flex items-start gap-2.5 border-t border-white/[0.07] pt-4 text-[11px] leading-[18px] text-white/56">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0 text-emerald-400/70" />
          <p>
            已保存的文字与参数会保留；本地上传的图片、音乐和视频可能需要重新选择，请保留原文件。
          </p>
        </div>

        <div className="mt-3 flex items-center gap-2 text-[10px] text-white/46">
          <span className="h-px flex-1 bg-white/[0.06]" />
          新版包含：片尾替换 · 恢复内置
          <span className="h-px flex-1 bg-white/[0.06]" />
        </div>
      </div>
    </div>
  );
}

export function RequiredUpdateGate() {
  const { mode, inferredVersion } = useDesktopUpdateClient();
  const exportSessionActive = useExportSessionActive();
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  const [updateStateReadSettled, setUpdateStateReadSettled] = useState(false);
  const [legacyWaitExpired, setLegacyWaitExpired] = useState(false);
  const [stalledRevision, setStalledRevision] = useState<number | null>(null);
  const [actionPending, setActionPending] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [slowInstallRevision, setSlowInstallRevision] = useState<number | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const latestRevisionRef = useRef(-1);
  const requestedCheckRef = useRef(false);

  useEffect(() => {
    if (mode === "hidden") return;

    let disposed = false;
    let timer: number | undefined;
    let controller: AbortController | undefined;
    const check = async () => {
      controller = new AbortController();
      try {
        const response = await fetch("/api/desktop-release", {
          cache: "no-store",
          signal: controller.signal,
        });
        if (!response.ok) throw new Error(`release status ${response.status}`);
        const data = (await response.json()) as Partial<ReleaseInfo>;
        const usable =
          data.required === true &&
          typeof data.version === "string" &&
          typeof data.downloadUrl === "string";
        if (!disposed && typeof data.version === "string" && typeof data.downloadUrl === "string") {
          setRelease({
            required: usable,
            version: data.version,
            downloadUrl: data.downloadUrl,
            releasePageUrl:
              typeof data.releasePageUrl === "string" ? data.releasePageUrl : undefined,
            downloadSizeBytes:
              typeof data.downloadSizeBytes === "number" ? data.downloadSizeBytes : undefined,
          });
        } else if (!disposed) {
          setRelease((current) => (current ? { ...current, required: false } : null));
        }
      } catch {
        // Fail open during a transient release-status outage.
        if (!disposed) {
          setRelease((current) => (current ? { ...current, required: false } : null));
        }
      } finally {
        if (!disposed) timer = window.setTimeout(() => void check(), POLL_MS);
      }
    };

    void check();
    return () => {
      disposed = true;
      controller?.abort();
      if (timer) window.clearTimeout(timer);
    };
  }, [mode]);

  const currentVersion =
    mode === "observable" ? (updateState?.currentVersion ?? inferredVersion) : inferredVersion;
  const versionReady = mode !== "observable" || updateStateReadSettled;
  const shouldBlock =
    versionReady &&
    !exportSessionActive &&
    !!release &&
    shouldBlockDesktopUpdate({
      mode,
      releaseRequired: release.required,
      currentVersion,
      requiredVersion: release.version,
    });

  useEffect(() => {
    latestRevisionRef.current = -1;
    requestedCheckRef.current = false;
    if (mode !== "observable") return;

    const bridge = window.electronRender;
    let disposed = false;
    if (!bridge?.getUpdateState || !bridge.onUpdateState) {
      queueMicrotask(() => {
        if (disposed) return;
        setUpdateStateReadSettled(true);
        setActionError("无法读取自动更新状态，请手动下载安装");
      });
      return () => {
        disposed = true;
      };
    }
    const apply = (next: DesktopUpdateState) => {
      if (disposed || next.revision <= latestRevisionRef.current) return;
      latestRevisionRef.current = next.revision;
      setUpdateState(next);
      setUpdateStateReadSettled(true);
      setActionError(null);
      if (next.status !== "installing") setActionPending(false);
    };
    const unsubscribe = bridge.onUpdateState(apply);
    void bridge.getUpdateState().then(apply).catch(() => {
      if (!disposed) {
        setUpdateStateReadSettled(true);
        setUpdateState({
          revision: 0,
          status: "error",
          currentVersion: inferredVersion ?? "0.2.2",
          errorPhase: "check",
          message: "无法读取自动更新状态",
          retryable: true,
        });
        setActionError("请使用下方安装包完成更新");
      }
    });
    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [inferredVersion, mode]);

  useEffect(() => {
    if (
      !shouldBlock ||
      mode !== "observable" ||
      updateState?.status !== "idle" ||
      requestedCheckRef.current
    ) {
      return;
    }
    requestedCheckRef.current = true;
    void window.electronRender?.retryUpdate?.();
  }, [mode, shouldBlock, updateState?.status]);

  useEffect(() => {
    if (!shouldBlock || mode !== "legacy-auto") return;
    const timer = window.setTimeout(() => setLegacyWaitExpired(true), LEGACY_WAIT_MS);
    return () => window.clearTimeout(timer);
  }, [mode, shouldBlock]);

  useEffect(() => {
    if (updateState?.status !== "downloading") return;
    const revision = updateState.revision;
    const timer = window.setTimeout(() => setStalledRevision(revision), STALLED_DOWNLOAD_MS);
    return () => window.clearTimeout(timer);
  }, [updateState?.revision, updateState?.status]);

  useEffect(() => {
    if (updateState?.status !== "installing") return;
    const revision = updateState.revision;
    const timer = window.setTimeout(() => setSlowInstallRevision(revision), 10_000);
    return () => window.clearTimeout(timer);
  }, [updateState?.revision, updateState?.status]);

  const downloadStalled =
    updateState?.status === "downloading" && stalledRevision === updateState.revision;
  const restartSlow =
    updateState?.status === "installing" && slowInstallRevision === updateState.revision;

  const focusKey = `${mode}:${updateState?.status ?? "legacy"}:${legacyWaitExpired}`;
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!shouldBlock || !dialog || dialog.open) return;
    dialog.showModal();
    window.requestAnimationFrame(() => {
      dialog.querySelector<HTMLElement>("[data-update-primary='true']")?.focus();
    });
    return () => {
      if (dialog.open) dialog.close();
    };
  }, [shouldBlock]);

  useEffect(() => {
    if (!shouldBlock) return;
    window.requestAnimationFrame(() => {
      dialogRef.current
        ?.querySelector<HTMLElement>("[data-update-primary='true']")
        ?.focus({ preventScroll: true });
    });
  }, [focusKey, shouldBlock]);

  const retryUpdate = async () => {
    const retry = window.electronRender?.retryUpdate;
    if (!retry) return;
    setActionPending(true);
    setActionError(null);
    const result = await retry().catch(() => ({ ok: false as const, error: "无法重新检查更新" }));
    if (!result.ok) setActionError(result.error);
    setActionPending(false);
  };

  const restartAndInstall = async () => {
    const install = window.electronRender?.restartAndInstall;
    if (!install) return;
    setActionPending(true);
    setActionError(null);
    const result = await install().catch(() => ({ ok: false as const, error: "应用未能自动重启" }));
    if (!result.ok) {
      setActionError(result.error);
      setActionPending(false);
    }
  };

  if (!shouldBlock || !release) return null;

  let content: ReactNode;

  if (mode === "manual") {
    content = (
      <GateCard
        release={release}
        currentVersion={inferredVersion ?? undefined}
        badge="需要更新"
        badgeIcon={<HardDriveDownload className="size-3" />}
        title="安装新版后即可继续"
        description="你当前使用的客户端版本较早，不支持应用内更新。请下载安装最新版并覆盖原应用。"
        actions={<DownloadAction release={release} primary />}
      >
        <InstallSteps />
      </GateCard>
    );
  } else if (mode === "legacy-auto") {
    content = legacyWaitExpired ? (
      <GateCard
        release={release}
        currentVersion={inferredVersion ?? undefined}
        badge="需要更新"
        badgeIcon={<CircleHelp className="size-3" />}
        title="还没有出现更新提示？"
        description="无需继续等待，你可以直接下载安装最新版并覆盖原应用。"
        actions={<DownloadAction release={release} primary />}
      >
        <InstallSteps />
      </GateCard>
    ) : (
      <GateCard
        release={release}
        currentVersion={inferredVersion ?? undefined}
        badge="需要更新"
        badgeIcon={<RefreshCw className="size-3" />}
        title="新版客户端已发布"
        description={`应用正在尝试在后台获取 ${release.version}。这个旧版本无法显示实时下载进度；完成后会出现系统重启提示。`}
        actions={<DownloadAction release={release} primary label="直接下载安装" />}
      >
        <div className="flex items-start gap-3 rounded-xl border border-white/[0.07] bg-black/15 px-3.5 py-3">
          <LoaderCircle className="mt-0.5 size-4 shrink-0 animate-spin text-[#ff6da6] motion-reduce:animate-none" />
          <div>
            <p className="text-[12px] font-medium text-white/75">等待系统更新提示</p>
            <p className="mt-1 text-[11px] leading-4 text-white/58">
              如果看到系统窗口，请选择“立即重启更新”；也可以直接使用下方安装包。
            </p>
          </div>
        </div>
      </GateCard>
    );
  } else {
    const status = updateState?.status ?? "checking";
    const currentVersion = updateState?.currentVersion ?? inferredVersion ?? undefined;
    const installFailed = status === "error" && updateState?.errorPhase === "install";

    if (status === "downloading") {
      const percent = Math.round(updateState?.percent ?? 0);
      const transferred = formatBytes(updateState?.transferred);
      const total = formatBytes(updateState?.total);
      const progressText = transferred && total ? `${transferred} / ${total}` : null;
      content = (
        <GateCard
          release={release}
          currentVersion={currentVersion}
          badge={downloadStalled ? "下载暂缓" : "正在更新"}
          badgeIcon={
            downloadStalled ? <TriangleAlert className="size-3" /> : <Download className="size-3" />
          }
          title={`正在下载 ${release.version}`}
          description={
            downloadStalled
              ? "下载暂时没有进展，可能是网络连接不稳定。无需继续等待，可以直接手动安装。"
              : "保持应用打开，下载完成后即可重启更新。"
          }
          statusRole={downloadStalled ? "alert" : "status"}
          actions={
            downloadStalled ? (
              <DownloadAction release={release} primary label="手动下载安装" />
            ) : (
              <DownloadAction release={release} label="改为手动安装" />
            )
          }
        >
          <div>
            <div className="mb-2 flex items-center justify-between text-[11px]">
              <span className="text-white/60">下载进度</span>
              <span className="font-medium tabular-nums text-white/75">
                {percent}%{progressText ? ` · ${progressText}` : ""}
              </span>
            </div>
            <div
              role="progressbar"
              aria-label={`新版下载进度 ${percent}%`}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={percent}
              className="h-2 overflow-hidden rounded-full bg-white/[0.07]"
            >
              <div
                className="h-full rounded-full bg-[linear-gradient(90deg,#ff2d7e,#ff70ad)] transition-[width] duration-300 motion-reduce:transition-none"
                style={{ width: `${percent}%` }}
              />
            </div>
            <span className="sr-only" aria-live="polite">
              下载进度 {Math.floor(percent / 10) * 10}%
            </span>
          </div>
        </GateCard>
      );
    } else if (status === "ready") {
      content = (
        <GateCard
          release={release}
          currentVersion={currentVersion}
          badge="准备就绪"
          badgeIcon={<CheckCircle2 className="size-3" />}
          title="新版已准备好"
          description={`${release.version} 已下载完成。重启后会自动安装，完成前无需再做其他操作。`}
          actions={
            <Button
              data-update-primary="true"
              size="lg"
              disabled={actionPending}
              onClick={() => void restartAndInstall()}
              className="h-11 w-full rounded-xl bg-[#ff2d7e] text-white hover:bg-[#f32674]"
            >
              <RefreshCw className={cn("size-4", actionPending && "animate-spin")} />
              {actionPending ? "正在重启…" : "立即重启并更新"}
            </Button>
          }
        >
          <div className="space-y-2.5">
            <div className="flex items-center gap-3 rounded-xl border border-emerald-400/12 bg-emerald-400/[0.045] px-3.5 py-3 text-[11px] leading-5 text-white/62">
              <CheckCircle2 className="size-4 shrink-0 text-emerald-400/80" />
              安装包已完成校验，可以安全重启。
            </div>
            <ActionErrorNotice message={actionError} />
          </div>
        </GateCard>
      );
    } else if (status === "installing") {
      content = (
        <GateCard
          release={release}
          currentVersion={currentVersion}
          badge="正在重启"
          badgeIcon={<RefreshCw className="size-3 animate-spin motion-reduce:animate-none" />}
          title="正在完成更新"
          description={
            restartSlow
              ? "应用没有自动关闭？请按 ⌘Q 完全退出，然后重新打开小音符起号助手。"
              : "应用即将关闭并安装新版，请稍候。"
          }
          actions={
            <Button size="lg" disabled className="h-11 w-full rounded-xl bg-white/[0.07] text-white/55">
              <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" /> 正在重启…
            </Button>
          }
        />
      );
    } else if (status === "error" || status === "not-available" || status === "unsupported") {
      content = (
        <GateCard
          release={release}
          currentVersion={currentVersion}
          badge="更新未完成"
          badgeIcon={<TriangleAlert className="size-3" />}
          title="自动更新没有完成"
          description={
            installFailed
              ? "自动重启没有完成。安装包仍已准备好，你可以再次重启安装，或手动更新。"
              : updateState?.message
                ? `${updateState.message}。你可以重新尝试，或直接下载安装最新版。`
                : "可能是网络连接或当前客户端能力受限。你可以重新尝试，或直接下载安装最新版。"
          }
          statusRole="alert"
          actions={
            <>
              {installFailed ? (
                <Button
                  data-update-primary="true"
                  size="lg"
                  disabled={actionPending}
                  onClick={() => void restartAndInstall()}
                  className="h-11 w-full rounded-xl bg-[#ff2d7e] text-white hover:bg-[#f32674]"
                >
                  <RefreshCw className={cn("size-4", actionPending && "animate-spin")} />
                  {actionPending ? "正在重启…" : "再次重启并更新"}
                </Button>
              ) : status !== "unsupported" ? (
                <Button
                  data-update-primary="true"
                  size="lg"
                  disabled={actionPending}
                  onClick={() => void retryUpdate()}
                  className="h-11 w-full rounded-xl bg-[#ff2d7e] text-white hover:bg-[#f32674]"
                >
                  <RefreshCw className={cn("size-4", actionPending && "animate-spin")} /> 重新尝试
                </Button>
              ) : null}
              <DownloadAction release={release} primary={status === "unsupported"} label="手动下载" />
            </>
          }
        >
          {actionError || updateState?.errorCode ? (
            <ActionErrorNotice
              message={
                actionError ??
                (updateState?.errorCode ? `错误代码：${updateState.errorCode}` : null)
              }
            />
          ) : undefined}
        </GateCard>
      );
    } else {
      content = (
        <GateCard
          release={release}
          currentVersion={currentVersion}
          badge="正在检查"
          badgeIcon={<RefreshCw className="size-3" />}
          title="正在检查更新"
          description="正在连接更新服务，请稍候。"
          actions={<DownloadAction release={release} label="改为手动安装" />}
        >
          <div className="space-y-2.5">
            <div className="flex items-center gap-3 rounded-xl border border-white/[0.07] bg-black/15 px-3.5 py-3 text-[11px] text-white/60">
              <LoaderCircle className="size-4 animate-spin text-[#ff6da6] motion-reduce:animate-none" />
              正在确认可用版本与安装包…
            </div>
            <ActionErrorNotice message={actionError} />
          </div>
        </GateCard>
      );
    }
  }

  return (
    <dialog
      ref={dialogRef}
      className="fixed inset-0 m-0 h-screen max-h-none w-screen max-w-none border-0 bg-[#08080c]/96 p-0 text-inherit backdrop:bg-[#08080c]/96"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="required-update-title"
      aria-describedby="required-update-description"
      onCancel={(event) => event.preventDefault()}
    >
      <div className="relative grid h-full w-full place-items-center overflow-hidden px-5 py-8">
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 bg-[radial-gradient(760px_480px_at_50%_42%,rgba(255,45,126,0.075),transparent_70%)]"
        />
        {content}
      </div>
    </dialog>
  );
}
