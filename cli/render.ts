// Local bundling + rendering for the CLI. Mirrors lib/render/jobs.ts (web) but
// runs standalone in Node: the Remotion entry is bundled with a content-hash
// cache under node_modules/.cache, file-based assets are served over a
// loopback HTTP server (same pattern as electron/render.ts), and the local
// headless Chromium is driven via @remotion/renderer.
import http from "node:http";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { ProjectConfig } from "../lib/config-schema";
import { resolveConfig } from "../lib/resolved";
import { totalSec } from "../lib/duration";
import { crfFor, scaleFor, type ExportOptions } from "../lib/export-options";
import type { LocalFile } from "./config";

export type RenderParams = {
  root: string; // project root (where remotion/, lib/, public/ live)
  config: ProjectConfig;
  files: Record<string, LocalFile>;
  options: ExportOptions;
  outPath: string;
  coverPath?: string;
  rebuild?: boolean; // force a fresh Remotion bundle
  onProgress?: (progress: number) => void;
  log?: (msg: string) => void;
};

export type RenderOutput = {
  outputPath: string;
  coverPath?: string;
  durationSec: number;
};

// ---- bundle cache -----------------------------------------------------------

async function collectSourceFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await collectSourceFiles(fp, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(fp);
  }
}

async function collectAllFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const fp = path.join(dir, e.name);
    if (e.isDirectory()) await collectAllFiles(fp, out);
    else out.push(fp);
  }
}

// Content hash of everything that affects the bundle output: composition and
// shared lib sources plus the lockfile (dependency upgrades invalidate too).
async function hashSources(root: string): Promise<string> {
  const files: string[] = [];
  for (const dir of ["remotion", "lib"]) {
    await collectSourceFiles(path.join(root, dir), files);
  }
  // Built-in assets are copied into the Remotion bundle. Include them in the
  // cache key so replacing the default ending (or any other built-in) can never
  // reuse a bundle containing stale bytes.
  await collectAllFiles(path.join(root, "public", "assets", "builtin"), files);
  files.push(path.join(root, "package-lock.json"));
  files.sort();

  const h = crypto.createHash("sha1");
  for (const f of files) {
    h.update(path.relative(root, f));
    h.update(await fs.readFile(f));
  }
  return h.digest("hex").slice(0, 12);
}

// Returns a serveUrl (local bundle directory) for the composition, bundling
// only when sources changed since the cached bundle was built.
export async function ensureBundle(
  root: string,
  opts: { rebuild?: boolean; log?: (msg: string) => void } = {},
): Promise<string> {
  const cacheRoot = path.join(root, "node_modules", ".cache", "video-gen-cli");
  const hash = await hashSources(root);
  const dest = path.join(cacheRoot, `bundle-${hash}`);

  const cached = await fs
    .stat(path.join(dest, "index.html"))
    .then((s) => s.isFile())
    .catch(() => false);
  if (cached && !opts.rebuild) return dest;

  opts.log?.("打包 Remotion 合成站点（源码有更新，约 10-30 秒）…");
  const { bundle } = await import("@remotion/bundler");
  const outDir = await bundle({
    entryPoint: path.join(root, "remotion", "index.ts"),
    publicDir: path.join(root, "public"),
  });

  await fs.rm(dest, { recursive: true, force: true });
  await fs.mkdir(cacheRoot, { recursive: true });
  await fs.cp(outDir, dest, { recursive: true });

  // Keep only the current bundle so the cache never grows unbounded.
  const entries = await fs.readdir(cacheRoot).catch(() => [] as string[]);
  for (const e of entries) {
    if (e.startsWith("bundle-") && e !== `bundle-${hash}`) {
      await fs.rm(path.join(cacheRoot, e), { recursive: true, force: true }).catch(() => {});
    }
  }
  return dest;
}

// ---- loopback asset server ---------------------------------------------------

type AssetServer = { urls: Record<string, string>; close: () => void };

// Serves the config's file-based assets to the headless browser. Loopback
// only, ephemeral port, lives for the duration of one render.
function serveLocalAssets(files: Record<string, LocalFile>): Promise<AssetServer> {
  const ids = Object.keys(files);
  if (ids.length === 0) {
    return Promise.resolve({ urls: {}, close: () => {} });
  }
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const match = /^\/asset\/([^/]+)$/.exec(req.url ?? "");
      const asset = match ? files[decodeURIComponent(match[1])] : undefined;
      if (!asset) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }
      try {
        const buf = await fs.readFile(asset.file);
        res.setHeader("Content-Type", asset.mime);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.end(buf);
      } catch (e) {
        res.statusCode = 500;
        res.end(e instanceof Error ? e.message : "read error");
      }
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr !== "object") {
        reject(new Error("本地资源服务启动失败"));
        return;
      }
      const urls: Record<string, string> = {};
      for (const id of ids) {
        urls[id] = `http://127.0.0.1:${addr.port}/asset/${encodeURIComponent(id)}`;
      }
      resolve({ urls, close: () => server.close() });
    });
  });
}

// ---- render -------------------------------------------------------------------

export async function renderVideo(params: RenderParams): Promise<RenderOutput> {
  const { root, config, files, options, outPath, coverPath, onProgress, log } = params;

  const serveUrl = await ensureBundle(root, { rebuild: params.rebuild, log });
  const assetServer = await serveLocalAssets(files);

  try {
    // fps rides in the config so calculateMetadata derives a matching
    // durationInFrames; crf/scale are encoder-only (same as the app paths).
    const resolved = {
      ...resolveConfig(config, assetServer.urls),
      canvas: { ...config.canvas, fps: options.fps },
    };
    const inputProps = { config: resolved };
    const scale = scaleFor(options.resolution);
    const chromiumOptions = { gl: "angle" as const };

    const { ensureBrowser, selectComposition, renderMedia, renderStill } =
      await import("@remotion/renderer");

    log?.("准备无头浏览器（首次运行会下载 Chromium）…");
    await ensureBrowser();

    const composition = await selectComposition({
      serveUrl,
      id: "Teleprompter",
      inputProps,
      chromiumOptions,
    });

    const durationSec = totalSec(resolved);
    log?.(
      `开始渲染: ${Math.round(durationSec)} 秒 · ${options.resolution} · ${options.fps}fps · 画质 ${options.quality}`,
    );

    await fs.mkdir(path.dirname(path.resolve(outPath)), { recursive: true });
    await renderMedia({
      serveUrl,
      composition,
      codec: "h264",
      crf: crfFor(options.quality),
      scale,
      outputLocation: outPath,
      inputProps,
      chromiumOptions,
      onProgress: ({ progress }: { progress: number }) => onProgress?.(progress),
    });

    if (coverPath) {
      // Cover = first frame (closed curtain), matching the app pipeline.
      await fs.mkdir(path.dirname(path.resolve(coverPath)), { recursive: true });
      await renderStill({
        serveUrl,
        composition,
        frame: 0,
        output: coverPath,
        inputProps,
        imageFormat: "jpeg",
        jpegQuality: 90,
        scale,
        chromiumOptions,
      });
    }

    return { outputPath: outPath, coverPath, durationSec };
  } finally {
    assetServer.close();
  }
}
