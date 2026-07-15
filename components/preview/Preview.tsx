"use client";

/* eslint-disable react-hooks/refs -- refs in this file are only read from event handlers and effects */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import dynamic from "next/dynamic";
import type { PlayerRef } from "@remotion/player";
import { Pause, Play, RefreshCw, RotateCcw } from "lucide-react";
import { toast } from "sonner";
import { TeleprompterVideo } from "@/remotion/TeleprompterVideo";
import { resolveConfig } from "@/lib/resolved";
import { totalFrames, openingFrames, contentFrames, endingFrames } from "@/lib/duration";
import { micBox, deviceBox } from "@/lib/coords";
import { CANVAS } from "@/lib/constants";
import {
  useEditor,
  type DragTarget,
  type ContentTarget,
  type OpeningTarget,
  type SceneView,
} from "@/lib/store";

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
    }
  | {
      kind: "screen-move" | "screen-resize";
      startX: number;
      startY: number;
      sx: number;
      sy: number;
      sw: number;
      sh: number;
      devW: number;
      devH: number;
    };

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

const isOpening = (t: DragTarget): t is OpeningTarget => t === "title" || t === "countdown";

export function Preview() {
  const config = useEditor((s) => s.config);
  const assetUrls = useEditor((s) => s.assetUrls);
  const view = useEditor((s) => s.view);
  const viewFocusRevision = useEditor((s) => s.viewFocusRevision);
  const setView = useEditor((s) => s.setView);
  const selected = useEditor((s) => s.selected);
  const setSelected = useEditor((s) => s.setSelected);
  const setTransform = useEditor((s) => s.setTransform);
  const setOpeningPos = useEditor((s) => s.setOpeningPos);
  const setScreen = useEditor((s) => s.setScreen);
  const addAsset = useEditor((s) => s.addAsset);
  const resetAsset = useEditor((s) => s.resetAsset);

  const resolved = useMemo(() => resolveConfig(config, assetUrls), [config, assetUrls]);
  // Stable reference so 60fps scrubber re-renders don't hand the Player new
  // inputProps every frame (which would restart the audio tags repeatedly).
  const inputProps = useMemo(() => ({ config: resolved }), [resolved]);
  const duration = useMemo(() => totalFrames(resolved), [resolved]);
  const openF = useMemo(() => openingFrames(resolved), [resolved]);
  const contentF = useMemo(() => contentFrames(resolved), [resolved]);
  const endF = useMemo(() => endingFrames(resolved), [resolved]);

  const playerRef = useRef<PlayerRef | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const replaceInputRef = useRef<HTMLInputElement>(null);
  const dragRef = useRef<DragState>(null);
  const previousViewRef = useRef(view);
  const previousViewFocusRef = useRef(viewFocusRevision);
  const latestViewRef = useRef(view);
  const latestViewFocusRef = useRef(viewFocusRevision);

  const [boxW, setBoxW] = useState(0);
  const [frame, setFrame] = useState(0);
  const [playing, setPlaying] = useState(false);

  const sf = boxW / CANVAS.width; // display px per canvas px

  // representative frame for a scene (static editing peek)
  const frameForView = useCallback(
    (v: SceneView) => {
      if (v === "opening") return Math.min(openF - 1, Math.round(openF * 0.45));
      if (v === "content") {
        return Math.min(duration - 1, openF + Math.round(contentF * 0.35));
      }
      return Math.min(duration - 1, openF + contentF + Math.round(endF * 0.45));
    },
    [openF, contentF, endF, duration],
  );
  const frameForViewRef = useRef(frameForView);

  useEffect(() => {
    latestViewRef.current = view;
    latestViewFocusRef.current = viewFocusRevision;
    frameForViewRef.current = frameForView;
  }, [frameForView, view, viewFocusRevision]);

  // measure preview box
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBoxW(el.clientWidth));
    ro.observe(el);
    setBoxW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  // The left editor is an accordion keyed by the same scene view. Switching a
  // card — including reselecting the active card — moves the player to a
  // representative frame as well.
  useEffect(() => {
    const sceneChanged = previousViewRef.current !== view;
    const focusRequested = previousViewFocusRef.current !== viewFocusRevision;
    if (!sceneChanged && !focusRequested) return;
    const player = playerRef.current;
    if (!player) return;
    previousViewRef.current = view;
    previousViewFocusRef.current = viewFocusRevision;
    setSelected(null);
    if (player.isPlaying()) player.pause();
    player.seekTo(frameForView(view));
  }, [frameForView, setSelected, view, viewFocusRevision]);

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
      const initialView = latestViewRef.current;
      const focusWasRequested = latestViewFocusRef.current !== previousViewFocusRef.current;
      // The first opening frame doubles as the cover. If the user already
      // selected another card while the dynamic player was mounting, honor it.
      p.seekTo(
        initialView === "opening" && !focusWasRequested
          ? 0
          : frameForViewRef.current(initialView),
      );
      previousViewRef.current = initialView;
      previousViewFocusRef.current = latestViewFocusRef.current;
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
  }, []);

  const peek = (v: SceneView) => {
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
  const onPointerDownEl = (e: React.PointerEvent, target: ContentTarget) => {
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

  const onPointerDownHandle = (e: React.PointerEvent, target: ContentTarget) => {
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

  const onScreenPointerDown = (e: React.PointerEvent, mode: "screen-move" | "screen-resize") => {
    if (playing) return;
    e.preventDefault();
    e.stopPropagation();
    setSelected("device");
    const dev = deviceBox(config.content.device.transform);
    const sc = config.content.teleprompter.screen;
    dragRef.current = {
      kind: mode,
      startX: e.clientX,
      startY: e.clientY,
      sx: sc.x,
      sy: sc.y,
      sw: sc.w,
      sh: sc.h,
      devW: dev.width * sf,
      devH: dev.height * sf,
    };
  };

  // ---- opening elements (title / countdown): move only ----
  const onPointerDownOpening = (e: React.PointerEvent, target: OpeningTarget) => {
    if (playing) return;
    e.preventDefault();
    setSelected(target);
    const pos = config.opening[target].pos;
    dragRef.current = {
      kind: "move",
      target,
      startX: e.clientX,
      startY: e.clientY,
      startNX: pos.x,
      startNY: pos.y,
      startScale: 1,
      startBoxW: 0,
    };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || boxW === 0) return;
      if (d.kind === "move") {
        const nx = d.startNX + (e.clientX - d.startX) / boxW;
        const ny = d.startNY + (e.clientY - d.startY) / (boxW * ASPECT);
        if (isOpening(d.target)) {
          setOpeningPos(d.target, { x: clamp(nx, 0, 1), y: clamp(ny, 0, 1) });
        } else {
          setTransform(d.target, { x: clamp(nx, -0.1, 1.1), y: clamp(ny, -0.1, 1.1) });
        }
      } else if (d.kind === "resize" && !isOpening(d.target)) {
        const next = (d.startBoxW + (e.clientX - d.startX)) / d.startBoxW;
        setTransform(d.target, { scale: clamp(d.startScale * next, 0.4, 2.5) });
      } else if (d.kind === "screen-move") {
        const dx = (e.clientX - d.startX) / d.devW;
        const dy = (e.clientY - d.startY) / d.devH;
        setScreen({ x: clamp(d.sx + dx, 0, 1 - d.sw), y: clamp(d.sy + dy, 0, 1 - d.sh) });
      } else if (d.kind === "screen-resize") {
        const dw = (e.clientX - d.startX) / d.devW;
        const dh = (e.clientY - d.startY) / d.devH;
        setScreen({ w: clamp(d.sw + dw, 0.1, 1 - d.sx), h: clamp(d.sh + dh, 0.1, 1 - d.sy) });
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
  }, [boxW, setTransform, setOpeningPos, setScreen]);

  const showOverlay = !playing && boxW > 0;

  // Approximate canvas-px bounding box of an opening element (centered on pos),
  // used only as a draggable affordance — exact text metrics aren't needed.
  const openingBox = (target: OpeningTarget) => {
    if (target === "title") {
      const { pos, fontSize, text } = config.opening.title;
      const width = CANVAS.width * 0.84;
      const charsPerLine = Math.max(1, Math.floor(width / (fontSize * 0.55)));
      // Respect explicit line breaks, then add wrapping within each line.
      const lines = text
        .split("\n")
        .reduce((acc, line) => acc + Math.max(1, Math.ceil(line.trim().length / charsPerLine)), 0);
      const height = Math.max(1, lines) * fontSize * 1.15;
      return { left: pos.x * CANVAS.width - width / 2, top: pos.y * CANVAS.height - height / 2, width, height };
    }
    const { pos, fontSize } = config.opening.countdown;
    const width = fontSize * 0.8;
    const height = fontSize * 1.1;
    return { left: pos.x * CANVAS.width - width / 2, top: pos.y * CANVAS.height - height / 2, width, height };
  };

  const dispBox = (target: DragTarget) => {
    const b = isOpening(target)
      ? openingBox(target)
      : target === "mic"
        ? micBox(config.content.mic.transform)
        : deviceBox(config.content.device.transform);
    return { left: b.left * sf, top: b.top * sf, width: b.width * sf, height: b.height * sf };
  };

  // which draggable elements belong to the current scene
  const overlayTargets: DragTarget[] =
    view === "opening"
      ? config.opening.countdown.enabled
        ? ["title", "countdown"]
        : ["title"]
      : view === "content"
        ? ["device", "mic"]
        : [];

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4">
      {/* peek toggle */}
      <div className="flex gap-1 rounded-full border border-border bg-black/40 p-1 backdrop-blur">
        {(
          [
            ["opening", "① 开场"],
            ["content", "② 正片"],
            ["ending", "③ 片尾"],
          ] as const
        ).map(([v, label]) => (
          <button
            key={v}
            onClick={() => peek(v)}
            className={`rounded-full px-4 py-1.5 text-xs transition-colors ${
              view === v ? "bg-[#ff2d7e] font-semibold text-white" : "text-muted-foreground"
            }`}
          >
            {label}
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
          ? overlayTargets.map((target) => {
              const b = dispBox(target);
              const on = selected === target;

              if (isOpening(target)) {
                return (
                  <div
                    key={target}
                    onPointerDown={(e) => onPointerDownOpening(e, target)}
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
                    <span className="pointer-events-none absolute -top-6 left-0 whitespace-nowrap rounded-md bg-black/70 px-2 py-0.5 text-[10px] text-white">
                      {target === "title" ? "标题" : "倒计时"}
                    </span>
                  </div>
                );
              }

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
                      <div
                        className={`absolute -top-8 flex gap-1 ${target === "mic" ? "right-0" : "left-0"}`}
                        onPointerDown={(e) => e.stopPropagation()}
                      >
                        <button
                          onClick={() => {
                            replaceInputRef.current?.setAttribute("data-target", target);
                            replaceInputRef.current?.click();
                          }}
                          className="whitespace-nowrap rounded-md bg-[#ff2d7e] px-2 py-1 text-[10px] text-white"
                        >
                          ↻ 替换
                        </button>
                        {config.content[target].asset.kind === "upload" ? (
                          <button
                            title="恢复内置素材"
                            onClick={() => {
                              resetAsset(target);
                              toast.success(
                                `${target === "mic" ? "麦克风" : "手机"}已恢复为内置素材`,
                              );
                            }}
                            className="flex items-center gap-1 whitespace-nowrap rounded-md bg-black/70 px-2 py-1 text-[10px] text-white"
                          >
                            <RotateCcw className="size-2.5" />
                            内置
                          </button>
                        ) : null}
                        {target === "mic" ? (
                          <>
                            <button
                              title="左右翻转"
                              onClick={() =>
                                setTransform("mic", { flipH: !config.content.mic.transform.flipH })
                              }
                              className="rounded-md bg-black/70 px-2 py-1 text-[10px] text-white"
                            >
                              ↔
                            </button>
                            <button
                              title="上下翻转"
                              onClick={() =>
                                setTransform("mic", { flipV: !config.content.mic.transform.flipV })
                              }
                              className="rounded-md bg-black/70 px-2 py-1 text-[10px] text-white"
                            >
                              ↕
                            </button>
                          </>
                        ) : null}
                      </div>
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

        {/* teleprompter screen-region editor (shown when the device is selected) */}
        {showOverlay && selected === "device"
          ? (() => {
              const dev = dispBox("device");
              const sc = config.content.teleprompter.screen;
              return (
                <div
                  onPointerDown={(e) => onScreenPointerDown(e, "screen-move")}
                  className="absolute cursor-move"
                  style={{
                    left: dev.left + sc.x * dev.width,
                    top: dev.top + sc.y * dev.height,
                    width: sc.w * dev.width,
                    height: sc.h * dev.height,
                    outline: "2px dashed #22d3ee",
                    outlineOffset: -1,
                    background: "rgba(34,211,238,0.10)",
                    borderRadius: 6,
                  }}
                >
                  <span
                    onPointerDown={(e) => e.stopPropagation()}
                    className="absolute -top-6 left-0 whitespace-nowrap rounded bg-[#0891b2] px-1.5 py-0.5 text-[9px] text-white"
                  >
                    屏幕区 · 拖动/拉角贴合屏幕
                  </span>
                  <span
                    onPointerDown={(e) => onScreenPointerDown(e, "screen-resize")}
                    className="absolute -bottom-1.5 -right-1.5 size-3.5 cursor-nwse-resize rounded-full border-2 border-[#22d3ee] bg-white"
                  />
                </div>
              );
            })()
          : null}

        <input
          ref={replaceInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            const target = e.target.getAttribute("data-target") as ContentTarget | null;
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
