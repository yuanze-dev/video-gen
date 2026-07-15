"use client";

import { useEffect, useRef, useState } from "react";
import { Check, Download, FolderOpen, Image as ImageIcon, Loader2, MonitorDown } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEditor } from "@/lib/store";
import type { ProjectConfig } from "@/lib/config-schema";
import { DEFAULT_EXPORT_OPTIONS, type ExportOptions } from "@/lib/export-options";
import { setExportSessionActive } from "@/lib/export-session";
import { ExportOptionsForm } from "./ExportOptions";

type Phase = "idle" | "working" | "done" | "error" | "unsupported" | "outdated";

// The render bridge injected by the Electron preload (absent in a plain browser).
type RenderAsset = { id: string; name: string; mime: string; data: ArrayBuffer };
type ElectronRender = {
  isAvailable: boolean;
  supportsExportOptions?: boolean; // absent on shells older than the export-options release
  supportsEndingVideo?: boolean; // absent on shells older than the ending-video release
  beginExportSession?: () => Promise<{ ok: true; sessionId: string }>;
  endExportSession?: (sessionId: string) => Promise<{ ok: true }>;
  render: (p: {
    serveUrl: string;
    config: unknown;
    assets: RenderAsset[];
    options: ExportOptions;
    sessionId?: string;
  }) => Promise<{ ok: true; jobId: string } | { ok: false; error: string }>;
  onProgress: (cb: (progress: number) => void) => () => void;
  save: (
    jobId: string,
    kind: "video" | "cover",
  ) => Promise<{ ok: true; path: string } | { ok: false; canceled?: boolean; error?: string }>;
  reveal: (filePath: string) => Promise<{ ok: true }>;
  cleanup: (jobId: string) => Promise<{ ok: true }>;
};

declare global {
  interface Window {
    electronRender?: ElectronRender;
  }
}

function referencedUploadIds(cfg: ProjectConfig): string[] {
  const ids: string[] = [];
  const push = (a?: { kind: string; id: string } | null) => {
    if (a && a.kind === "upload") ids.push(a.id);
  };
  push(cfg.content.background);
  push(cfg.content.mic.asset);
  push(cfg.content.device.asset);
  push(cfg.content.teleprompter.video?.asset);
  push(cfg.content.bgm?.asset);
  push(cfg.opening.curtain.sfx);
  push(cfg.ending.video.asset);
  return ids;
}

async function collectAssets(
  cfg: ProjectConfig,
  assetUrls: Record<string, string>,
  fileNames: Record<string, string>,
): Promise<RenderAsset[]> {
  const assets: RenderAsset[] = [];
  for (const id of referencedUploadIds(cfg)) {
    const objUrl = assetUrls[id];
    if (!objUrl) continue;
    const blob = await fetch(objUrl).then((r) => r.blob());
    assets.push({
      id,
      name: fileNames[id] ?? id,
      mime: blob.type || "application/octet-stream",
      data: await blob.arrayBuffer(),
    });
  }
  return assets;
}

export function ExportDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [options, setOptions] = useState<ExportOptions>(DEFAULT_EXPORT_OPTIONS);
  // Whether the installed desktop shell honors export options (older shells don't);
  // captured when the dialog opens so we never read `window` during render.
  const [canPickOptions, setCanPickOptions] = useState(true);
  const [progress, setProgress] = useState(0);
  const [stat, setStat] = useState("准备渲染任务…");
  const [jobId, setJobId] = useState<string | null>(null);
  const [savedPath, setSavedPath] = useState<string | null>(null);
  const [videoSaved, setVideoSaved] = useState(false);
  const unsubRef = useRef<(() => void) | null>(null);
  const jobRef = useRef<string | null>(null);
  const sessionRef = useRef<string | null>(null);

  const cleanup = () => {
    unsubRef.current?.();
    unsubRef.current = null;
  };
  // Tell the desktop app to delete the finished job's temp dir (uploaded
  // assets + rendered files) so nothing lingers on disk between exports.
  const discardJob = async () => {
    const id = jobRef.current;
    const sessionId = sessionRef.current;
    jobRef.current = null;
    sessionRef.current = null;
    try {
      if (sessionId) await window.electronRender?.endExportSession?.(sessionId);
      if (id) await window.electronRender?.cleanup(id);
    } finally {
      setExportSessionActive(false);
    }
  };
  useEffect(
    () => () => {
      cleanup();
      const id = jobRef.current;
      const sessionId = sessionRef.current;
      jobRef.current = null;
      sessionRef.current = null;
      void (async () => {
        try {
          if (sessionId) await window.electronRender?.endExportSession?.(sessionId);
          if (id) await window.electronRender?.cleanup(id);
        } finally {
          setExportSessionActive(false);
        }
      })();
    },
    [],
  );

  const start = async (opts: ExportOptions) => {
    const bridge = window.electronRender;
    if (!bridge?.isAvailable) {
      setPhase("unsupported");
      return;
    }

    const editor = useEditor.getState();
    if (!bridge.supportsEndingVideo && editor.config.ending.video.asset.kind === "upload") {
      setPhase("outdated");
      return;
    }

    cleanup();
    await discardJob();
    setExportSessionActive(true);
    setPhase("working");
    setProgress(0);
    setSavedPath(null);
    setVideoSaved(false);
    setJobId(null);
    setStat("打包素材，提交本机渲染…");

    try {
      if (bridge.beginExportSession) {
        const reservation = await bridge.beginExportSession();
        sessionRef.current = reservation.sessionId;
      }
      const { config, assetUrls, fileNames } = editor;
      const assets = await collectAssets(config, assetUrls, fileNames);
      const serveUrl = `${window.location.origin}/remotion-site/`;

      unsubRef.current = bridge.onProgress((p) => {
        setProgress(Math.round((p ?? 0) * 100));
        setStat("本机合成图层 · 编码 H.264…");
      });

      const res = await bridge.render({
        serveUrl,
        config,
        assets,
        options: opts,
        sessionId: sessionRef.current ?? undefined,
      });
      cleanup();
      if (!res.ok) {
        const sessionId = sessionRef.current;
        sessionRef.current = null;
        if (sessionId) await bridge.endExportSession?.(sessionId);
        setExportSessionActive(false);
        setStat(res.error || "渲染失败");
        setPhase("error");
        return;
      }
      sessionRef.current = null;
      jobRef.current = res.jobId;
      setJobId(res.jobId);
      setProgress(100);
      setStat("渲染完成 ✓");
      setPhase("done");
    } catch (e) {
      cleanup();
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) await bridge.endExportSession?.(sessionId).catch(() => {});
      setExportSessionActive(false);
      setStat(e instanceof Error ? e.message : "渲染失败");
      setPhase("error");
    }
  };

  const save = async (kind: "video" | "cover") => {
    const bridge = window.electronRender;
    if (!bridge || !jobId) return;
    const res = await bridge.save(jobId, kind);
    if (res.ok) {
      setSavedPath(res.path);
      if (kind === "video") setVideoSaved(true);
    }
  };

  return (
    <>
      <Button
        onClick={() => {
          // Open to the options step; the user picks settings then hits 开始导出.
          const bridge = window.electronRender;
          const hasCustomEnding =
            useEditor.getState().config.ending.video.asset.kind === "upload";
          setPhase(
            !bridge?.isAvailable
              ? "unsupported"
              : !bridge.supportsEndingVideo && hasCustomEnding
                ? "outdated"
                : "idle",
          );
          setCanPickOptions(!!bridge?.supportsExportOptions);
          setOpen(true);
        }}
        className="bg-[#ff2d7e] text-white hover:bg-[#ff2d7e]/90"
      >
        <Download className="size-4" /> 导出视频
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          if (!o && phase === "working") return;
          if (
            !o &&
            phase === "done" &&
            jobId &&
            !videoSaved &&
            !window.confirm("导出视频尚未保存，确定放弃这次导出吗？")
          ) {
            return;
          }
          setOpen(o);
          if (!o) {
            cleanup();
            void discardJob();
            setPhase("idle");
            setJobId(null);
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>导出视频</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {phase === "unsupported" ? (
              <div className="space-y-3">
                <p className="rounded-lg border border-border border-l-2 border-l-[#ff2d7e] bg-muted/40 p-3 text-[13px] leading-relaxed text-muted-foreground">
                  <MonitorDown className="mb-1 mr-1 inline size-4 text-[#ff2d7e]" />
                  视频导出由本机算力完成，需在<strong className="text-foreground">桌面版</strong>中进行。
                  网页版用于编辑与实时预览；请打开桌面版后点击导出。
                </p>
              </div>
            ) : phase === "outdated" ? (
              <p className="rounded-lg border border-border border-l-2 border-l-amber-400 bg-muted/40 p-3 text-[13px] leading-relaxed text-muted-foreground">
                当前桌面版版本较旧，无法导出你替换的片尾视频。请先更新桌面版后再导出；使用内置默认片尾不受影响。
              </p>
            ) : (
              <>
                <p className="rounded-lg border border-border border-l-2 border-l-[#7c5cff] bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
                  首次导出需要准备渲染环境，会稍慢一些，请耐心等待。渲染在本机进行，不会上传你的素材。
                </p>

                {phase === "idle" ? (
                  <>
                    {canPickOptions ? (
                      <ExportOptionsForm value={options} onChange={setOptions} />
                    ) : null}
                    <Button
                      onClick={() => void start(options)}
                      className="w-full bg-[#ff2d7e] text-white hover:bg-[#ff2d7e]/90"
                    >
                      <Download className="size-4" /> 开始导出
                    </Button>
                  </>
                ) : (
                  <>
                    <Progress value={progress} />
                    <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
                      {phase === "working" ? <Loader2 className="size-4 animate-spin" /> : null}
                      {phase === "done" ? <Check className="size-4 text-emerald-500" /> : null}
                      {stat}
                    </div>

                    {phase === "done" && jobId ? (
                      <div className="space-y-2">
                        <Button
                          onClick={() => void save("video")}
                          className="w-full bg-[#ff2d7e] text-white hover:bg-[#ff2d7e]/90"
                        >
                          <Download className="size-4" /> 保存视频
                        </Button>
                        <Button variant="outline" className="w-full" onClick={() => void save("cover")}>
                          <ImageIcon className="size-4" /> 保存封面图（第一帧）
                        </Button>
                        {savedPath ? (
                          <button
                            type="button"
                            onClick={() => void window.electronRender?.reveal(savedPath)}
                            className="flex w-full items-center justify-center gap-1.5 text-[12px] text-muted-foreground hover:text-foreground"
                          >
                            <FolderOpen className="size-3.5" /> 已保存，在访达中显示
                          </button>
                        ) : null}
                      </div>
                    ) : null}

                    {phase === "error" ? (
                      <Button variant="outline" className="w-full" onClick={() => void start(options)}>
                        重试
                      </Button>
                    ) : null}
                  </>
                )}
              </>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
