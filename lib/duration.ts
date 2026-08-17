import type { ResolvedConfig } from "./resolved";
import {
  PX_PER_SEC,
  MIN_CONTENT_SEC,
  MAX_CONTENT_SEC,
  DEVICE_BASE_W,
  TELEPROMPTER_ESTIMATED_CHAR_WIDTH,
  TELEPROMPTER_TEXT_LINE_HEIGHT,
  TELEPROMPTER_TEXT_PADDING_RATIO,
} from "./constants";
import { DEFAULT_ENDING_DURATION_SEC } from "./config-schema";

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

export function openingSec(cfg: ResolvedConfig): number {
  // Countdown and curtain run concurrently: the curtain finishes opening exactly
  // when the countdown reaches 0. So the opening lasts the countdown length.
  return cfg.opening.countdown.enabled
    ? cfg.opening.countdown.from / cfg.opening.countdown.speed
    : cfg.opening.curtain.openDurationSec;
}

// Estimate the complete CSS text box, including its vertical padding. The
// renderer finishes by translating the actual laid-out box by -100%, so this
// estimate controls the requested px/sec pace but never decides whether the
// final line is allowed to remain on screen.
export function estimateTeleprompterTextBoxHeight(
  text: string,
  fontSize: number,
  screenW: number,
  screenH: number,
): number {
  const padding = screenW * TELEPROMPTER_TEXT_PADDING_RATIO;
  const innerW = Math.max(1, screenW - padding * 2);
  const lineH = fontSize * TELEPROMPTER_TEXT_LINE_HEIGHT;
  const charW = fontSize * TELEPROMPTER_ESTIMATED_CHAR_WIDTH;
  const perLine = Math.max(1, Math.floor(innerW / charW));
  // white-space: pre-wrap preserves every explicit newline, including the
  // standard four-line lead-in. Collapsing a newline run makes the planned
  // duration shorter than the box rendered by Chromium.
  const linesOfText = text.split("\n");
  let lines = 0;
  for (const line of linesOfText) {
    lines += Math.max(1, Math.ceil(line.length / perLine));
  }
  return Math.max(screenH, lines * lineH + padding * 2);
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
  const deviceH = deviceW * cfg.content.device.aspectRatio;
  const screenW = deviceW * t.screen.w;
  const screenH = deviceH * t.screen.h;
  // Travel the complete text box out through the top edge. The ending starts
  // only after this distance is complete; it may no longer replace a frame
  // while the last line is still visible.
  const distance = estimateTeleprompterTextBoxHeight(
    text.content,
    text.fontSize,
    screenW,
    screenH,
  );
  const sec = distance / (PX_PER_SEC * text.speed);
  return clamp(sec, MIN_CONTENT_SEC, MAX_CONTENT_SEC);
}

export function endingSec(cfg: ResolvedConfig): number {
  const duration = cfg.ending?.video?.asset?.durationSec;
  return typeof duration === "number" && duration > 0
    ? duration
    : DEFAULT_ENDING_DURATION_SEC;
}

export function totalFrames(cfg: ResolvedConfig): number {
  return openingFrames(cfg) + contentFrames(cfg) + endingFrames(cfg);
}

export function totalSec(cfg: ResolvedConfig): number {
  // Report the exact composition duration after each scene has been aligned to
  // a frame boundary. This keeps CLI metadata and the rendered MP4 in sync.
  return totalFrames(cfg) / cfg.canvas.fps;
}

export function openingFrames(cfg: ResolvedConfig): number {
  return Math.round(openingSec(cfg) * cfg.canvas.fps);
}

export function contentFrames(cfg: ResolvedConfig): number {
  return Math.max(1, Math.round(contentSec(cfg) * cfg.canvas.fps));
}

export function endingFrames(cfg: ResolvedConfig): number {
  return Math.max(1, Math.round(endingSec(cfg) * cfg.canvas.fps));
}
