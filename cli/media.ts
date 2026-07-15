import path from "node:path";
import fs from "node:fs/promises";
import { parseMedia } from "@remotion/media-parser";
import { nodeReader } from "@remotion/media-parser/node";

export type MediaProbe = {
  path: string;
  sizeBytes: number;
  durationSec: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string;
  mimeType: string | null;
};

function normalizeFps(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  // Container time bases commonly surface 30fps as 29.999999999999996.
  // Keep meaningful fractional rates (for example 29.97) while avoiding
  // floating-point noise in the stable JSON protocol.
  return Math.round(value * 1_000_000) / 1_000_000;
}

/**
 * Reads media metadata without spawning ffprobe. This is shared by `plan`,
 * post-render verification and future asset inspection commands.
 */
export async function probeMedia(file: string): Promise<MediaProbe> {
  const absolutePath = path.resolve(file);
  const stat = await fs.stat(absolutePath).catch(() => null);
  if (!stat?.isFile()) throw new Error(`媒体文件不存在: ${absolutePath}`);
  if (stat.size === 0) throw new Error(`媒体文件为空: ${absolutePath}`);

  try {
    const result = await parseMedia({
      src: absolutePath,
      reader: nodeReader,
      logLevel: "error",
      acknowledgeRemotionLicense: true,
      fields: {
        dimensions: true,
        durationInSeconds: true,
        fps: true,
        videoCodec: true,
        audioCodec: true,
        container: true,
        mimeType: true,
        size: true,
      },
    });

    return {
      path: absolutePath,
      sizeBytes: result.size ?? stat.size,
      durationSec:
        typeof result.durationInSeconds === "number" && Number.isFinite(result.durationInSeconds)
          ? result.durationInSeconds
          : null,
      width: result.dimensions?.width ?? null,
      height: result.dimensions?.height ?? null,
      fps: normalizeFps(result.fps),
      videoCodec: result.videoCodec,
      audioCodec: result.audioCodec,
      container: result.container,
      mimeType: result.mimeType,
    };
  } catch (error) {
    throw new Error(
      `无法读取媒体信息: ${absolutePath} — ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
