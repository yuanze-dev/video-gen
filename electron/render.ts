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
  assets: Record<string, StoredAsset>;
  outputPath?: string;
  coverPath?: string;
  cancel?: () => void;
};

const jobs = new Map<string, Job>();
export const getJob = (id: string): Job | undefined => jobs.get(id);

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
  await fs.mkdir(dir, { recursive: true });
  const job: Job = { id, dir, assets: {} };
  jobs.set(id, job);

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
  }

  const port = await ensureAssetServer();
  const urls: Record<string, string> = {};
  for (const assetId of Object.keys(job.assets)) {
    urls[assetId] = `http://127.0.0.1:${port}/asset/${id}/${encodeURIComponent(assetId)}`;
  }

  const resolved = resolveConfig(parsed.data, urls);
  const inputProps = { config: resolved };

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

  const composition = await selectComposition({
    serveUrl: req.serveUrl,
    id: "Teleprompter",
    inputProps,
    ...common,
  });

  const { cancelSignal, cancel } = makeCancelSignal();
  job.cancel = cancel;

  const outputPath = path.join(dir, "out.mp4");
  await renderMedia({
    serveUrl: req.serveUrl,
    composition,
    codec: "h264",
    outputLocation: outputPath,
    inputProps,
    cancelSignal,
    onProgress: ({ progress }: { progress: number }) => onProgress(progress),
    ...common,
  });
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
    ...common,
  });
  job.coverPath = coverPath;
  job.cancel = undefined;

  return { jobId: id, outputPath, coverPath };
}

export function cancelRender(jobId: string): void {
  jobs.get(jobId)?.cancel?.();
}

export async function cleanupJob(jobId: string): Promise<void> {
  const job = jobs.get(jobId);
  if (!job) return;
  jobs.delete(jobId);
  await fs.rm(job.dir, { recursive: true, force: true }).catch(() => {});
}
