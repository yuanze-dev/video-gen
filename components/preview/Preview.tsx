"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PlayerRef } from "@remotion/player";
import { Play, Pause, RefreshCw } from "lucide-react";
import { TeleprompterVideo } from "@/remotion/TeleprompterVideo";
import { resolveConfig } from "@/lib/resolved";
import { totalFrames, openingFrames, contentFrames } from "@/lib/duration";
import { micBox, deviceBox } from "@/lib/coords";
import { CANVAS } from "@/lib/constants";
import { useEditor, type DragTarget } from "@/lib/store";

const Player = dynamic(() => import("@remotion/player").then((m) => m.Player), {
  ssr: false,
}) as unknown as typeof import("@remotion/player").Player;

const ASPECT = CANVAS.height / CANVAS.width; // 16/9

type DragState =
  | null
  | {
      kind: "move" | "resize";
      target: DragTarget;
      startX: number;
      startY: number;
      startNX: number;
      startNY: number;
      startScale: number;
      startBoxW: number;
    };

export function Preview() {
  const config = useEditor((s) => s.config);
  const assetUrls = useEditor((s) => s.assetUrls);
  const view = useEditor((s) => s.view);
  const setView = useEditor((s) => s.setView);
  const selected = useEditor((s) => s.selected);
  const setSelected = useEditor((s) => s.setSelected);
  const setTransform = useEditor((s) => s.setTransform);
  const addAsset = useEditor((s) => s.addAsset);

  const resolved = useMemo(() => resolveConfig(config, assetUrls), [config, assetUrls]);
  // Stable reference so 60fps scrubber re-renders don't hand the Player new
  // inputProps every frame (which would restart the audio tags repeatedly).
  const inputProps = useMemo(() => ({ config: resolved }), [resolved]);
  const duration = useMemo(() => totalFrames(resolved), [resolved]);
  const openF = useMemo(() => openingFrames(resolved), [resolved]);
  const contentF = useMemo(() => contentFrames(resolved), [resolved]);

  const playerRef = useRef<PlayerRef | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState>(null);

  const [boxW, setBoxW] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  const sf = boxW / CANVAS.width; // display px per canvas px

  // representative frame for a scene (static editing peek)
  const frameForView = useCallback(
    (v: "opening" | "content") =>
      v === "opening"
        ? Math.min(openF - 1, Math.round(openF * 0.45))
        : Math.min(duration - 1, openF + Math.round(contentF * 0.35)),
    [openF, contentF, duration],
  );

  // measure preview box
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // attach player listeners once the (dynamically imported) player mounts
  useEffect(() => {
    let raf = 0;
    const onFrame = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    let attached: PlayerRef | null = null;
    const attach = () => {
      const p = playerRef.current;
      if (!p) {
        raf = requestAnimationFrame(attach);
        return;
      }
      attached = p;
      p.addEventListener("frameupdate", onFrame);
      p.addEventListener("play", onPlay);
      p.addEventListener("pause", onPause);
      p.seekTo(frameForView("opening"));
    };
    attach();
    return () => {
      cancelAnimationFrame(raf);
      if (attached) {
        attached.removeEventListener("frameupdate", onFrame);
        attached.removeEventListener("play", onPlay);
        attached.removeEventListener("pause", onPause);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const peek = (v: "opening" | "content") => {
    setView(v);
    playerRef.current?.seekTo(frameForView(v));
  };

  const togglePlay = () => {
    const p = playerRef.current;
    if (!p) return;
    if (p.isPlaying()) p.pause();
    else p.play();
  };

  // ---- drag / resize ----
  const onPointerDownEl = (e: React.PointerEvent, target: DragTarget) => {
    if (playing) return;
    e.preventDefault();
    setSelected(target);
    const t = config.content[target].transform;
    const dispW = (target === "mic" ? micBox(t) : deviceBox(t)).width * sf;
    dragRef.current = {
      kind: "move",
      target,
      startX: e.clientX,
      startY: e.clientY,
      startNX: t.x,
      startNY: t.y,
      startScale: t.scale,
      startBoxW: dispW,
    };
  };

  const onPointerDownHandle = (e: React.PointerEvent, target: DragTarget) => {
    if (playing) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected(target);
    const t = config.content[target].transform;
    const dispW = (target === "mic" ? micBox(t) : deviceBox(t)).width * sf;
    dragRef.current = {
      kind: "resize",
      target,
      startX: e.clientX,
      startY: e.clientY,
      startNX: t.x,
      startNY: t.y,
      startScale: t.scale,
      startBoxW: dispW,
    };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || boxW === 0) return;
      if (d.kind === "move") {
        const nx = d.startNX + (e.clientX - d.startX) / boxW;
        const ny = d.startNY + (e.clientY - d.startY) / (boxW * ASPECT);
        setTransform(d.target, {
          x: Math.max(-0.1, Math.min(1.1, nx)),
          y: Math.max(-0.1, Math.min(1.1, ny)),
        });
      } else {
        const next = (d.startBoxW + (e.clientX - d.startX)) / d.startBoxW;
        setTransform(d.target, {
          scale: Math.max(0.4, Math.min(2.5, d.startScale * next)),
        });
      }
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [boxW, setTransform]);

  const showOverlay = view === "content" && !playing && boxW > 0;

  const dispBox = (target: DragTarget) => {
    const t = config.content[target].transform;
    const b = target === "mic" ? micBox(t) : deviceBox(t);
    return { left: b.left * sf, top: b.top * sf, width: b.width * sf, height: b.height * sf };
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      {/* peek toggle */}
      <div className="flex gap-1 rounded-full border border-border bg-black/40 p-1 backdrop-blur">
        {(["opening", "content"] as const).map((v, i) => (
          <button
            key={v}
            onClick={() => peek(v)}
            className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
              view === v ? "bg-[#ff2d7e] font-semibold text-white" : "text-muted-foreground"
            }`}
          >
            {i === 0 ? "① 开场" : "② 正片"}
          </button>
        ))}
      </div>

      {/* preview canvas */}
      <div
        ref={boxRef}
        className="relative overflow-hidden rounded-[22px] bg-black shadow-2xl ring-1 ring-white/10"
        style={{ height: "min(72vh, 760px)", aspectRatio: "1080 / 1920" }}
      >
        <Player
          ref={playerRef}
          component={TeleprompterVideo}
          inputProps={inputProps}
          durationInFrames={duration}
          compositionWidth={CANVAS.width}
          compositionHeight={CANVAS.height}
          fps={CANVAS.fps}
          acknowledgeRemotionLicense
          style={{ width: "100%", height: "100%" }}
        />

        {/* badges */}
        <div className="pointer-events-none absolute left-2 top-2 flex gap-1.5">
          <span className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/80 backdrop-blur">
            1080×1920
          </span>
          <span className="rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-white/80 backdrop-blur">
            {CANVAS.fps}fps
          </span>
        </div>

        {/* interaction overlay */}
        {showOverlay
          ? (["device", "mic"] as const).map((target) => {
              const b = dispBox(target);
              const on = selected === target;
              return (
                <div
                  key={target}
                  onPointerDown={(e) => onPointerDownEl(e, target)}
                  className="absolute cursor-move"
                  style={{
                    left: b.left,
                    top: b.top,
                    width: b.width,
                    height: b.height,
                    outline: on ? "2px solid #ff2d7e" : "1px dashed rgba(255,255,255,.35)",
                    outlineOffset: 2,
                    borderRadius: 4,
                  }}
                >
                  {on ? (
                    <>
                      <button
                        onPointerDown={(e) => e.stopPropagation()}
                        onClick={() => {
                          replaceInputRef.current?.setAttribute("data-target", target);
                          replaceInputRef.current?.click();
                        }}
                        className="absolute -top-7 left-0 whitespace-nowrap rounded-md bg-[#ff2d7e] px-2 py-1 text-[10px] text-white"
                      >
                        ↻ 替换素材
                      </button>
                      <span
                        onPointerDown={(e) => onPointerDownHandle(e, target)}
                        className="absolute -bottom-2 -right-2 size-4 cursor-nwse-resize rounded-full border-2 border-[#ff2d7e] bg-white"
                      />
                    </>
                  ) : null}
                </div>
              );
            })
          : null}

        <input
          ref={replaceInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            const target = e.target.getAttribute("data-target") as DragTarget | null;
            if (f && target) void addAsset(target, f);
            e.target.value = "";
          }}
        />
      </div>

      {/* transport */}
      <div className="flex w-[min(72vh,760px)] max-w-full items-center gap-3" style={{ width: boxW || undefined }}>
        <button
          onClick={togglePlay}
          className="grid size-9 flex-none place-items-center rounded-full bg-[#ff2d7e] text-white shadow-lg shadow-[#ff2d7e]/40"
        >
          {playing ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <div
          className="relative h-1.5 flex-1 cursor-pointer rounded-full bg-white/15"
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            const p = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
            playerRef.current?.seekTo(Math.round(p * (duration - 1)));
          }}
        >
          <div
            className="absolute left-0 top-0 h-full rounded-full bg-gradient-to-r from-[#7c5cff] to-[#ff2d7e]"
            style={{ width: `${duration > 1 ? (frame / (duration - 1)) * 100 : 0}%` }}
          />
        </div>
        <span className="flex-none font-mono text-[11px] text-muted-foreground">
          {fmt(frame / CANVAS.fps)} / {fmt(duration / CANVAS.fps)}
        </span>
        <button
          onClick={() => playerRef.current?.seekTo(0)}
          className="flex-none text-muted-foreground hover:text-foreground"
          title="回到开头"
        >
          <RefreshCw className="size-3.5" />
        </button>
      </div>
    </div>
  );
}

function fmt(sec: number) {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${String(m).padStart(2, "0")}:${String(r).padStart(2, "0")}`;
}
