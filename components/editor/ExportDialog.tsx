"use client";

import { useEffect, useRef, useState } from "react";
import { Download, Image as ImageIcon, Loader2 } from "lucide-react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { useEditor } from "@/lib/store";
import type { ProjectConfig } from "@/lib/config-schema";

type Phase = "idle" | "working" | "done" | "error";

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
  return ids;
}

export function ExportDialog() {
  const [open, setOpen] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [stat, setStat] = useState("准备渲染任务…");
  const [url, setUrl] = useState<string | null>(null);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const stopPoll = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = null;
  };

  useEffect(() => () => stopPoll(), []);

  const start = async () => {
    setPhase("working");
    setProgress(0);
    setStat("打包素材，提交渲染任务…");
    setUrl(null);
    setCoverUrl(null);
    try {
      const { config, assetUrls, fileNames } = useEditor.getState();
      const fd = new FormData();
      fd.append("config", JSON.stringify(config));
      for (const id of referencedUploadIds(config)) {
        const objUrl = assetUrls[id];
        if (!objUrl) continue;
        const blob = await fetch(objUrl).then((r) => r.blob());
        fd.append(`asset:${id}`, blob, fileNames[id] ?? id);
      }
      const res = await fetch("/api/render", { method: "POST", body: fd });
      if (!res.ok) throw new Error(await res.text());
      const { jobId } = (await res.json()) as { jobId: string };

      pollRef.current = setInterval(async () => {
        try {
          const s = await fetch(`/api/render/${jobId}`).then((r) => r.json());
          setProgress(Math.round((s.progress ?? 0) * 100));
          if (s.status === "rendering") setStat("云端合成图层 · 编码 H.264…");
          else if (s.status === "queued") setStat("排队中…");
          if (s.status === "done") {
            stopPoll();
            setProgress(100);
            setStat("渲染完成 ✓");
            setUrl(s.url);
            setCoverUrl(s.coverUrl ?? null);
            setPhase("done");
          } else if (s.status === "error") {
            stopPoll();
            setStat(s.error ?? "渲染失败");
            setPhase("error");
          }
        } catch (e) {
          stopPoll();
          setStat(e instanceof Error ? e.message : "查询失败");
          setPhase("error");
        }
      }, 1000);
    } catch (e) {
      setStat(e instanceof Error ? e.message : "提交失败");
      setPhase("error");
    }
  };

  return (
    <>
      <Button
        onClick={() => {
          setOpen(true);
          void start();
        }}
        className="bg-[#ff2d7e] text-white hover:bg-[#ff2d7e]/90"
      >
        <Download className="size-4" /> 导出视频
      </Button>
      <Dialog
        open={open}
        onOpenChange={(o) => {
          setOpen(o);
          if (!o) {
            stopPoll();
            setPhase("idle");
          }
        }}
      >
        <DialogContent>
        <DialogHeader>
          <DialogTitle>导出视频</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {["MP4 · H.264", "1080×1920", "30 fps", "无水印"].map((s) => (
              <span key={s} className="rounded-md border border-border bg-muted px-2.5 py-1 text-[11px] text-muted-foreground">
                {s}
              </span>
            ))}
          </div>
          <p className="rounded-lg border border-border border-l-2 border-l-[#7c5cff] bg-muted/40 p-3 text-[11px] leading-relaxed text-muted-foreground">
            首次导出需要准备渲染环境，会稍慢一些，请耐心等待。
          </p>
          <Progress value={progress} />
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {phase === "working" ? <Loader2 className="size-4 animate-spin" /> : null}
            {stat}
          </div>
          {phase === "done" && url ? (
            <div className="space-y-2">
              <Button
                nativeButton={false}
                render={<a href={url} download />}
                className="w-full bg-[#ff2d7e] text-white hover:bg-[#ff2d7e]/90"
              >
                <Download className="size-4" /> 下载视频
              </Button>
              {coverUrl ? (
                <Button
                  nativeButton={false}
                  variant="outline"
                  render={<a href={coverUrl} download />}
                  className="w-full"
                >
                  <ImageIcon className="size-4" /> 下载封面图（第一帧）
                </Button>
              ) : null}
            </div>
          ) : null}
          {phase === "error" ? (
            <Button variant="outline" className="w-full" onClick={() => void start()}>
              重试
            </Button>
          ) : null}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
