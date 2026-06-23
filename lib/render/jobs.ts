import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import { ProjectConfig } from "../config-schema";
import { resolveConfig } from "../resolved";
import { crfFor, normalizeExportOptions, scaleFor } from "../export-options";

export type JobStatus = "queued" | "rendering" | "done" | "error";

export type Job = {
  id: string;
  status: JobStatus;
  progress: number; // 0..1
  dir: string;
  outputPath?: string;
  coverPath?: string; // first-frame still, used as the video cover
  error?: string;
  assets: Record<string, { file: string; mime: string }>;
};

// In-memory store — fine for a single long-lived Node server (internal tool).
const jobs = new Map<string, Job>();
export const getJob = (id: string) => jobs.get(id);

// Bundle the Remotion entry. Cached across renders in production (static code);
// rebuilt every render in development so composition edits are reflected.
let bundlePromise: Promise<string> | null = null;
function getBundle(): Promise<string> {
  if (process.env.NODE_ENV === "production" && bundlePromise) return bundlePromise;
  bundlePromise = (async () => {
    const { bundle } = await import("@remotion/bundler");
    return bundle({
      entryPoint: path.join(process.cwd(), "remotion", "index.ts"),
      publicDir: path.join(process.cwd(), "public"),
    });
  })();
  return bundlePromise;
}

export async function createJob(): Promise<Job> {
  const id = crypto.randomUUID();
  const dir = path.join(os.tmpdir(), "teleprompter-render", id);
  await fs.mkdir(dir, { recursive: true });
  const job: Job = { id, status: "queued", progress: 0, dir, assets: {} };
  jobs.set(id, job);
  return job;
}

export async function saveAsset(job: Job, assetId: string, file: File) {
  const buf = Buffer.from(await file.arrayBuffer());
  const fp = path.join(job.dir, assetId);
  await fs.writeFile(fp, buf);
  job.assets[assetId] = { file: fp, mime: file.type || "application/octet-stream" };
}

export async function startRender(job: Job, cfgJson: unknown, origin: string, optsJson?: unknown) {
  const parsed = ProjectConfig.safeParse(cfgJson);
  if (!parsed.success) {
    job.status = "error";
    job.error = "配置格式不符";
    return;
  }

  // Uploaded assets are served back to the headless browser by the asset route.
  const urls: Record<string, string> = {};
  for (const id of Object.keys(job.assets)) {
    urls[id] = `${origin}/api/asset/${job.id}/${id}`;
  }
  // Export options (画质/清晰度/流畅度). fps rides in the config so the
  // composition's duration matches; crf/scale are encoder-only. Defaults
  // reproduce the previous fixed output.
  const opts = normalizeExportOptions(optsJson);
  const resolved = {
    ...resolveConfig(parsed.data, urls),
    canvas: { ...parsed.data.canvas, fps: opts.fps },
  };
  const inputProps = { config: resolved };
  const scale = scaleFor(opts.resolution);

  job.status = "rendering";
  try {
    const { selectComposition, renderMedia, renderStill, ensureBrowser } =
      await import("@remotion/renderer");
    await ensureBrowser();
    const serveUrl = await getBundle();
    const composition = await selectComposition({ serveUrl, id: "Teleprompter", inputProps });

    const outputPath = path.join(job.dir, "out.mp4");
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      crf: crfFor(opts.quality),
      scale,
      outputLocation: outputPath,
      inputProps,
      chromiumOptions: { gl: "angle" },
      onProgress: ({ progress }) => {
        job.progress = progress;
      },
    });
    job.outputPath = outputPath;

    // Cover = the very first frame (the closed curtain).
    const coverPath = path.join(job.dir, "cover.jpg");
    await renderStill({
      serveUrl,
      composition,
      frame: 0,
      output: coverPath,
      inputProps,
      imageFormat: "jpeg",
      jpegQuality: 90,
      scale,
      chromiumOptions: { gl: "angle" },
    });
    job.coverPath = coverPath;

    job.progress = 1;
    job.status = "done";
  } catch (e) {
    job.status = "error";
    job.error = e instanceof Error ? e.message : String(e);
  }
}
