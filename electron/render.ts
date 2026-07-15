// Local render engine for the Electron desktop app.
//
// Unlike the web `lib/render/jobs.ts`, this module does NOT bundle the Remotion
// project locally. The composition site is hosted remotely (on Vercel) and
// passed in as `serveUrl`, so the desktop app stays a thin, stable compute
// shell: it only drives the user's local headless Chromium + ffmpeg via
// @remotion/renderer. Uploaded assets travel in over IPC and are served back to
// the headless browser from a tiny localhost HTTP server.
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import { ProjectConfig } from "../lib/config-schema";
import { resolveConfig } from "../lib/resolved";
import { crfFor, normalizeExportOptions, scaleFor } from "../lib/export-options";

export type IncomingAsset = {
  id: string;
  name: string;
  mime: string;
  data: Uint8Array;
};

export type RenderRequest = {
  serveUrl: string;
  config: unknown;
  assets: IncomingAsset[];
  options?: unknown;
  sessionId?: string;
};

export type RenderResult = {
  jobId: string;
  outputPath: string;
  coverPath: string;
};

type StoredAsset = { file: string; mime: string };
type Job = {
  id: string;
  dir: string;
  ownerId: number;
  assets: Record<string, StoredAsset>;
  outputPath?: string;
  coverPath?: string;
  cancel?: () => void;
  rendering: boolean;
  abandoned: boolean;
};

const jobs = new Map<string, Job>();
const reservations = new Map<string, number>();
export const getJob = (id: string): Job | undefined => jobs.get(id);

// A session remains active through rendering AND the user's save/abandon step.
// The mandatory updater must not restart while completed files are still only
// reachable from the export dialog's temporary job directory.
export const hasActiveExportSession = (): boolean =>
  jobs.size > 0 || reservations.size > 0;

export function beginExportSession(ownerId: number): string {
  const id = crypto.randomUUID();
  reservations.set(id, ownerId);
  return id;
}

export function endExportSession(sessionId: string, ownerId: number): void {
  if (reservations.get(sessionId) === ownerId) reservations.delete(sessionId);
}

export function cleanupExportSessionsForOwner(ownerId: number): void {
  for (const [id, owner] of reservations) {
    if (owner === ownerId) reservations.delete(id);
  }
  for (const job of jobs.values()) {
    if (job.ownerId !== ownerId) continue;
    if (job.rendering) {
      job.abandoned = true;
      job.cancel?.();
    } else {
      jobs.delete(job.id);
      void fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

// ---- localhost asset server (lazy, shared across renders) -------------------

let assetServer: http.Server | null = null;
let assetPort = 0;

function ensureAssetServer(): Promise<number> {
  if (assetServer && assetPort) return Promise.resolve(assetPort);
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      // /asset/<jobId>/<assetId>
      const match = /^\/asset\/([^/]+)\/([^/]+)$/.exec(req.url ?? "");
      if (!match) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      const [, jobId, id] = match;
      const asset = jobs.get(jobId)?.assets[decodeURIComponent(id)];
      if (!asset) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      try {
        const buf = await fs.readFile(asset.file);
        res.setHeader("Content-Type", asset.mime || "application/octet-stream");
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(buf);
      } catch (e) {
        res.statusCode = 500;
        res.end(e instanceof Error ? e.message : "read error");
      }
    });
    server.on("error", reject);
    // Ephemeral port, loopback only.
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (addr && typeof addr === "object") {
        assetServer = server;
        assetPort = addr.port;
        resolve(assetPort);
      } else {
        reject(new Error("failed to bind asset server"));
      }
    });
  });
}

// ---- render -----------------------------------------------------------------

export async function startRender(
  req: RenderRequest,
  onProgress: (progress: number) => void,
  ownerId: number,
): Promise<RenderResult> {
  const parsed = ProjectConfig.safeParse(req.config);
  if (!parsed.success) {
    throw new Error("配置格式不符");
  }
  if (!/^https?:\/\//.test(req.serveUrl)) {
    throw new Error(`非法 serveUrl: ${req.serveUrl}`);
  }

  const id = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), "teleprompter-render", id);
  const job: Job = {
    id,
    dir,
    ownerId,
    assets: {},
    rendering: true,
    abandoned: false,
  };
  // Register before the first await so the updater cannot observe an idle gap
  // while the job directory is being created.
  if (req.sessionId) endExportSession(req.sessionId, ownerId);
  jobs.set(id, job);

  try {
    await fs.mkdir(dir, { recursive: true });
    if (job.abandoned) throw new Error("导出页面已关闭");
    // Persist incoming assets to disk so the localhost server can stream them.
    // The id arrives over IPC from the page; reject anything that could escape
    // the job dir before using it as a path segment (defense-in-depth).
    for (const a of req.assets ?? []) {
      if (!/^[A-Za-z0-9_.-]{1,128}$/.test(a.id) || a.id.includes("..")) {
        throw new Error(`非法 asset id: ${a.id}`);
      }
      const fp = path.join(dir, a.id);
      await fs.writeFile(fp, Buffer.from(a.data));
      job.assets[a.id] = { file: fp, mime: a.mime || "application/octet-stream" };
      if (job.abandoned) throw new Error("导出页面已关闭");
    }

    const port = await ensureAssetServer();
    const urls: Record<string, string> = {};
    for (const assetId of Object.keys(job.assets)) {
      urls[assetId] = `http://127.0.0.1:${port}/asset/${id}/${encodeURIComponent(assetId)}`;
    }

    // Export options (画质/清晰度/流畅度) chosen in the dialog. fps rides in the
    // config so calculateMetadata derives a matching durationInFrames; crf/scale
    // are encoder-only and passed straight to renderMedia/renderStill.
    const opts = normalizeExportOptions(req.options);
    const resolved = {
      ...resolveConfig(parsed.data, urls),
      canvas: { ...parsed.data.canvas, fps: opts.fps },
    };
    const inputProps = { config: resolved };
    const scale = scaleFor(opts.resolution);

    const { ensureBrowser, selectComposition, renderMedia, renderStill, makeCancelSignal } =
      await import("@remotion/renderer");

    // Optional overrides for the packaged app (read-only bundled binaries). Only
    // include keys when actually set so we never pass null into Remotion.
    const browserExecutable = process.env.REMOTION_BROWSER_EXECUTABLE || undefined;
    const binariesDirectory = process.env.REMOTION_BINARIES_DIR || undefined;
    const common: {
      browserExecutable?: string;
      binariesDirectory?: string;
      chromiumOptions: { gl: "angle" };
    } = { chromiumOptions: { gl: "angle" } };
    if (browserExecutable) common.browserExecutable = browserExecutable;
    if (binariesDirectory) common.binariesDirectory = binariesDirectory;

    await ensureBrowser(browserExecutable ? { browserExecutable } : undefined);
    if (job.abandoned) throw new Error("导出页面已关闭");

    const composition = await selectComposition({
      serveUrl: req.serveUrl,
      id: "Teleprompter",
      inputProps,
      ...common,
    });
    if (job.abandoned) throw new Error("导出页面已关闭");

    const { cancelSignal, cancel } = makeCancelSignal();
    job.cancel = cancel;

    const outputPath = path.join(dir, "out.mp4");
    await renderMedia({
      serveUrl: req.serveUrl,
      composition,
      codec: "h264",
      crf: crfFor(opts.quality),
      scale,
      outputLocation: outputPath,
      inputProps,
      cancelSignal,
      onProgress: ({ progress }: { progress: number }) => onProgress(progress),
      ...common,
    });
    if (job.abandoned) throw new Error("导出页面已关闭");
    job.outputPath = outputPath;

    // Cover = first frame (closed curtain), matches the web pipeline.
    const coverPath = path.join(dir, "cover.jpg");
    await renderStill({
      serveUrl: req.serveUrl,
      composition,
      frame: 0,
      output: coverPath,
      inputProps,
      imageFormat: "jpeg",
      jpegQuality: 90,
      scale,
      ...common,
    });
    if (job.abandoned) throw new Error("导出页面已关闭");
    job.coverPath = coverPath;
    job.cancel = undefined;
    job.rendering = false;

    return { jobId: id, outputPath, coverPath };
  } catch (error) {
    // Failed/cancelled jobs never reach the save step, so release the updater
    // guard and remove partial artifacts before surfacing the error.
    jobs.delete(id);
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

export function cancelRender(jobId: string): void {
  jobs.get(jobId)?.cancel?.();
}

export async function cleanupJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.rendering) {
    job.abandoned = true;
    job.cancel?.();
    return;
  }
  jobs.delete(jobId);
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}
