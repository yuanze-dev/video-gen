import type { ResolvedConfig } from "./resolved";
import {
  PX_PER_SEC,
  MIN_CONTENT_SEC,
  MAX_CONTENT_SEC,
  DEVICE_BASE_W,
  DEVICE_ASPECT,
} from "./constants";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function openingSec(cfg: ResolvedConfig): number {
  // Countdown and curtain run concurrently: the curtain finishes opening exactly
  // when the countdown reaches 0. So the opening lasts the countdown length.
  return cfg.opening.countdown.enabled
    ? cfg.opening.countdown.from
    : cfg.opening.curtain.openDurationSec;
}

// Estimate the rendered height (px) of the teleprompter text given the screen
// width. An approximation — slight over/under-scroll is acceptable.
function estimateTextHeight(text: string, fontSize: number, screenW: number): number {
  const lineH = fontSize * 1.2;
  const charW = fontSize * 0.52;
  const perLine = Math.max(1, Math.floor(screenW / charW));
  const paras = text.split(/\n+/);
  let lines = 0;
  for (const p of paras) lines += Math.max(1, Math.ceil(p.length / perLine));
  lines += (paras.length - 1) * 0.7; // inter-paragraph spacing
  return lines * lineH;
}

export function contentSec(cfg: ResolvedConfig): number {
  const t = cfg.content.teleprompter;
  if (t.mode === "video") {
    return clamp(t.video?.asset.durationSec ?? 10, 1, MAX_CONTENT_SEC);
  }
  const text = t.text;
  if (!text) return MIN_CONTENT_SEC;
  const scale = cfg.content.device.scale;
  const deviceW = DEVICE_BASE_W * scale;
  const deviceH = deviceW * DEVICE_ASPECT;
  const screenW = deviceW * t.screen.w;
  const screenH = deviceH * t.screen.h;
  const textH = estimateTextHeight(text.content, text.fontSize, screenW);
  const distance = Math.max(0, textH - screenH) + screenH * 0.45; // lead-out
  const sec = distance / (PX_PER_SEC * text.speed);
  return clamp(sec, MIN_CONTENT_SEC, MAX_CONTENT_SEC);
}

export function totalSec(cfg: ResolvedConfig): number {
  return openingSec(cfg) + contentSec(cfg);
}

export function totalFrames(cfg: ResolvedConfig): number {
  return Math.max(1, Math.round(totalSec(cfg) * cfg.canvas.fps));
}

export function openingFrames(cfg: ResolvedConfig): number {
  return Math.round(openingSec(cfg) * cfg.canvas.fps);
}

export function contentFrames(cfg: ResolvedConfig): number {
  return Math.max(1, Math.round(contentSec(cfg) * cfg.canvas.fps));
}
