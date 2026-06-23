// User-facing export choices, kept deliberately plain for non-technical users.
// The UI offers three semantic dimensions; this module maps them to the encoder
// settings Remotion actually consumes (crf / scale / fps). Shared by the editor
// dialog, the Electron render engine, and the web render path so all three agree.

export type ExportQuality = "high" | "standard" | "small";
export type ExportResolution = "1080p" | "720p";
export type ExportFps = 30 | 60;

export type ExportOptions = {
  quality: ExportQuality; // 画质 — clarity vs file size
  resolution: ExportResolution; // 清晰度 — output pixel size
  fps: ExportFps; // 流畅度 — frame rate
};

// Defaults reproduce the previous hard-coded output exactly (crf 18 is the
// Remotion h264 default, 1080×1920, 60fps), so "just export" is unchanged.
export const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  quality: "high",
  resolution: "1080p",
  fps: 60,
};

// H.264 CRF: lower = better quality + larger file. ~+5 roughly halves bitrate.
const CRF: Record<ExportQuality, number> = { high: 18, standard: 23, small: 28 };

// Output scale relative to the 1080×1920 composition. 2/3 → 720×1280 (both even,
// required by h264). 1 leaves the full resolution untouched.
const SCALE: Record<ExportResolution, number> = { "1080p": 1, "720p": 2 / 3 };

export const crfFor = (quality: ExportQuality): number => CRF[quality];
export const scaleFor = (resolution: ExportResolution): number => SCALE[resolution];

// Coerce untrusted input (arrives over IPC / HTTP) to a safe ExportOptions,
// falling back to the defaults for anything unrecognized.
export function normalizeExportOptions(raw: unknown): ExportOptions {
  const o = (raw ?? {}) as Partial<ExportOptions>;
  return {
    quality: o.quality === "standard" || o.quality === "small" ? o.quality : "high",
    resolution: o.resolution === "720p" ? "720p" : "1080p",
    fps: o.fps === 30 ? 30 : 60,
  };
}
