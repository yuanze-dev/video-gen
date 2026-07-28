import http from "node:http";
import path from "node:path";
import { constants, createReadStream } from "node:fs";
import fs from "node:fs/promises";
import crypto from "node:crypto";
import type { Socket } from "node:net";
import { AsyncLocalStorage } from "node:async_hooks";
import { format as formatLog } from "node:util";
import type { CancelSignal, LogLevel } from "@remotion/renderer";
import type { ProjectConfig } from "../lib/config-schema";
import { resolveConfig, type ResolvedConfig } from "../lib/resolved";
import {
  contentFrames,
  openingFrames,
  totalSec,
} from "../lib/duration";
import { crfFor, scaleFor, type ExportOptions } from "../lib/export-options";
import type { LocalFile } from "./config";
import {
  getCacheDirectory,
  removeStaleCacheStaging,
  withCacheMaintenanceLock,
  withFileLock,
} from "./cache";
import { probeMedia, type MediaProbe } from "./media";
import {
  resolveChromiumGlRenderer,
  type ChromiumGlRenderer,
} from "./chromium";

export { getCacheDirectory, withCacheMaintenanceLock, withFileLock } from "./cache";
export { probeMedia } from "./media";

export type RenderBaseParams = {
  /** Source project root. Optional when `serveUrl` or `runtimeSite` is set. */
  root?: string;
  config: ProjectConfig;
  files: Record<string, LocalFile>;
  options: ExportOptions;
  /** A ready Remotion URL or local bundle directory. Takes precedence over bundling. */
  serveUrl?: string;
  /** Path to a prebuilt, read-only Remotion site containing index.html. */
  runtimeSite?: string;
  /** Overrides the user cache root for this invocation. */
  cacheDir?: string;
  rebuild?: boolean;
  /** Native cancellation for CLI signal handling. */
  signal?: AbortSignal;
  /** Remotion cancellation for callers already using makeCancelSignal(). */
  cancelSignal?: CancelSignal;
  /** Defaults to error so renderer diagnostics never pollute machine stdout. */
  logLevel?: LogLevel;
  browserExecutable?: string;
  binariesDirectory?: string;
  log?: (message: string) => void;
};

export type RenderParams = RenderBaseParams & {
  outPath: string;
  coverPath?: string;
  /** Existing outputs are rejected unless overwrite is explicitly true. */
  overwrite?: boolean;
  /** Fail before publication when the workflow promises an audible BGM track. */
  requireAudioTrack?: boolean;
  onProgress?: (progress: number) => void;
};

export type RenderOutput = {
  outputPath: string;
  coverPath?: string;
  durationSec: number;
  media: MediaProbe;
};

export function assertRenderedMediaMatchesPlan(
  media: MediaProbe,
  expected: {
    width: number;
    height: number;
    fps: number;
    durationSec: number;
    requireAudioTrack?: boolean;
  },
): void {
  if (
    media.videoCodec === null ||
    media.width === null ||
    media.height === null ||
    media.durationSec === null ||
    media.durationSec <= 0
  ) {
    throw new Error("渲染产物校验失败：MP4 缺少有效视频轨或时长");
  }
  if (media.videoCodec !== "h264" || media.container !== "mp4") {
    throw new Error(
      `渲染产物校验失败：预期 H.264/MP4，实际 ${media.videoCodec}/${media.container}`,
    );
  }
  if (media.width !== expected.width || media.height !== expected.height) {
    throw new Error(
      `渲染产物校验失败：预期 ${expected.width}×${expected.height}，实际 ${media.width}×${media.height}`,
    );
  }
  if (media.fps === null || Math.abs(media.fps - expected.fps) > 0.01) {
    throw new Error(
      `渲染产物校验失败：预期 ${expected.fps}fps，实际 ${media.fps ?? "未知"}fps`,
    );
  }
  // AAC/container padding can extend the reported container duration slightly
  // beyond the exact video timeline. Anything beyond this tolerance indicates
  // a truncated or structurally different export.
  const durationToleranceSec = Math.max(0.15, 3 / expected.fps);
  if (Math.abs(media.durationSec - expected.durationSec) > durationToleranceSec) {
    throw new Error(
      `渲染产物校验失败：预期约 ${expected.durationSec.toFixed(3)} 秒，实际 ${media.durationSec.toFixed(3)} 秒`,
    );
  }
  if (expected.requireAudioTrack && media.audioCodec === null) {
    throw new Error("渲染产物校验失败：配置包含开场音效或 BGM，但最终 MP4 缺少音频轨");
  }
}

export type StillScene = "opening" | "content" | "ending";

export type RenderStillParams = RenderBaseParams & {
  outPath: string;
  scene?: StillScene;
  frame?: number;
  imageFormat?: "jpeg" | "png";
  jpegQuality?: number;
  overwrite?: boolean;
};

export type RenderStillOutput = {
  outputPath: string;
  frame: number;
  scene: StillScene | null;
};

export type RenderSceneStillsParams = RenderBaseParams & {
  outDir: string;
  scenes?: StillScene[];
  imageFormat?: "jpeg" | "png";
  jpegQuality?: number;
  overwrite?: boolean;
};

export type RenderSceneStillsOutput = {
  outputs: Partial<Record<StillScene, RenderStillOutput>>;
};

// ---- bundle cache -----------------------------------------------------------

async function collectSourceFiles(
  dir: string,
  out: string[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectSourceFiles(file, out, signal);
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(file);
  }
}

async function collectAllFiles(
  dir: string,
  out: string[],
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal);
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    throwIfAborted(signal);
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) await collectAllFiles(file, out, signal);
    else out.push(file);
  }
}

async function hashSources(root: string, signal?: AbortSignal): Promise<string> {
  const files: string[] = [];
  for (const dir of ["remotion", "lib"]) {
    await collectSourceFiles(path.join(root, dir), files, signal);
  }
  await collectAllFiles(path.join(root, "public", "assets"), files, signal);

  const lockfile = path.join(root, "package-lock.json");
  const packageFile = path.join(root, "package.json");
  files.push((await fs.stat(lockfile).catch(() => null))?.isFile() ? lockfile : packageFile);
  files.sort();

  const hash = crypto.createHash("sha256");
  // This salt represents the on-disk contract expected by the renderer. It
  // must change whenever bundle options or required artifacts change, even if
  // the Remotion composition sources themselves did not. Version 2 requires
  // the source map consumed by @remotion/renderer during server preparation.
  hash.update("littlestart-remotion-bundle-v2-sourcemap\0");
  for (const file of files) {
    throwIfAborted(signal);
    hash.update(path.relative(root, file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

async function isBundleReady(directory: string): Promise<boolean> {
  const requiredFiles = ["index.html", "bundle.js", "bundle.js.map"];
  const checks = await Promise.all(
    requiredFiles.map((file) =>
      fs
        .stat(path.join(directory, file))
        .then((stat) => stat.isFile() && stat.size > 0)
        .catch(() => false),
    ),
  );
  return checks.every(Boolean);
}

function randomId(): string {
  return `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
}

function maintenanceRootForBundleCache(cacheRoot: string): string {
  return path.basename(cacheRoot) === "remotion-bundles"
    ? path.dirname(cacheRoot)
    : cacheRoot;
}

/**
 * Returns an immutable content-addressed Remotion bundle in the user's cache.
 * Only public/assets is staged, so a generated public/remotion-site can never
 * recursively become part of the next bundle.
 */
export async function ensureBundle(
  root: string,
  options: {
    rebuild?: boolean;
    log?: (message: string) => void;
    cacheDir?: string;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  throwIfAborted(options.signal);
  const absoluteRoot = path.resolve(root);
  const cacheRoot = path.resolve(
    options.cacheDir ?? path.join(getCacheDirectory(), "remotion-bundles"),
  );
  const hash = await hashSources(absoluteRoot, options.signal);
  throwIfAborted(options.signal);
  const destination = path.join(cacheRoot, `bundle-${hash}`);
  const maintenanceRoot = maintenanceRootForBundleCache(cacheRoot);

  try {
    return await withCacheMaintenanceLock(maintenanceRoot, async () => {
      throwIfAborted(options.signal);
      await fs.mkdir(cacheRoot, { recursive: true });
      throwIfAborted(options.signal);
      return withFileLock(path.join(cacheRoot, ".bundle-cache.lock"), async () => {
        throwIfAborted(options.signal);
        if (!options.rebuild && (await isBundleReady(destination))) return destination;
        await removeStaleCacheStaging(cacheRoot);
        throwIfAborted(options.signal);

        const id = randomId();
        const publicStage = path.join(cacheRoot, `.public-${hash}-${id}.partial`);
        const bundleStage = path.join(cacheRoot, `.bundle-${hash}-${id}.partial`);
        let bundlerOutput: string | undefined;
        try {
          // Keep staticFile("assets/…") behavior while excluding every other
          // public child, most importantly the generated remotion-site itself.
          await fs.mkdir(publicStage, { recursive: true });
          throwIfAborted(options.signal);
          await fs.cp(path.join(absoluteRoot, "public", "assets"), path.join(publicStage, "assets"), {
            recursive: true,
          });
          throwIfAborted(options.signal);

          options.log?.("打包 Remotion 合成站点（源码有更新，约 10-30 秒）…");
          const { bundle } = await import("@remotion/bundler");
          throwIfAborted(options.signal);
          bundlerOutput = await bundle({
            entryPoint: path.join(absoluteRoot, "remotion", "index.ts"),
            publicDir: publicStage,
          });
          throwIfAborted(options.signal);

          await fs.cp(bundlerOutput, bundleStage, { recursive: true });
          throwIfAborted(options.signal);
          if (!(await isBundleReady(bundleStage))) {
            throw new Error(
              "Remotion 打包产物不完整：需要非空的 index.html、bundle.js 和 bundle.js.map",
            );
          }

          // Complete bundle directories are immutable: deleting one here could
          // break a renderer that already received its path. A forced rebuild is
          // therefore installed under a unique sibling when the canonical entry
          // is healthy. Corrupt/incomplete canonical entries are safe to replace.
          const destinationReady = await isBundleReady(destination);
          throwIfAborted(options.signal);
          if (destinationReady && !options.rebuild) return destination;
          const installDestination = destinationReady
            ? path.join(cacheRoot, `bundle-${hash}-rebuild-${id}`)
            : destination;
          if (!destinationReady) {
            await fs.rm(destination, { recursive: true, force: true }).catch(() => {});
          }
          throwIfAborted(options.signal);
          await fs.rename(bundleStage, installDestination);
          return installDestination;
        } finally {
          await fs.rm(publicStage, { recursive: true, force: true }).catch(() => {});
          await fs.rm(bundleStage, { recursive: true, force: true }).catch(() => {});
          if (bundlerOutput) {
            await fs.rm(bundlerOutput, { recursive: true, force: true }).catch(() => {});
          }
        }
      }, { signal: options.signal });
    }, { signal: options.signal });
  } catch (error) {
    // Keep the render API's established cancellation type even when the abort
    // originated inside the generic file-lock waiter.
    if (options.signal?.aborted) throwIfAborted(options.signal);
    throw error;
  }
}

async function validateRuntimeSite(site: string): Promise<string> {
  const absolute = path.resolve(site);
  if (!(await isBundleReady(absolute))) {
    throw new Error(
      `预构建 Remotion 站点无效（需要非空的 index.html、bundle.js 和 bundle.js.map）: ${absolute}`,
    );
  }
  return absolute;
}

export async function resolveRenderServeUrl(params: {
  root?: string;
  serveUrl?: string;
  runtimeSite?: string;
  cacheDir?: string;
  rebuild?: boolean;
  log?: (message: string) => void;
  signal?: AbortSignal;
}): Promise<string> {
  throwIfAborted(params.signal);
  if (params.serveUrl && params.runtimeSite) {
    throw new Error("serveUrl 和 runtimeSite 不能同时设置");
  }
  if (params.serveUrl) {
    const value = params.serveUrl.trim();
    if (!value) throw new Error("serveUrl 不能为空");
    if (/^https?:\/\//i.test(value) || /^file:\/\//i.test(value)) return value;
    return validateRuntimeSite(value);
  }
  if (params.runtimeSite) return validateRuntimeSite(params.runtimeSite);
  if (!params.root) throw new Error("缺少渲染站点：请提供 root、serveUrl 或 runtimeSite");
  return ensureBundle(params.root, {
    rebuild: params.rebuild,
    log: params.log,
    cacheDir: params.cacheDir,
    signal: params.signal,
  });
}

// ---- loopback asset server --------------------------------------------------

export type AssetServer = {
  urls: Record<string, string>;
  close: () => Promise<void>;
};

type ByteRange = { start: number; end: number };

function parseByteRange(header: string | undefined, size: number): ByteRange | "invalid" | null {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || size <= 0) return "invalid";

  const [, rawStart, rawEnd] = match;
  if (!rawStart && !rawEnd) return "invalid";
  if (!rawStart) {
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }

  const start = Number(rawStart);
  const requestedEnd = rawEnd ? Number(rawEnd) : size - 1;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(requestedEnd) ||
    start < 0 ||
    start >= size ||
    requestedEnd < start
  ) {
    return "invalid";
  }
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/**
 * Serves local assets to Chromium without buffering whole videos in memory.
 * The unguessable token prevents unrelated local pages from discovering files.
 */
export function serveLocalAssets(files: Record<string, LocalFile>): Promise<AssetServer> {
  const ids = Object.keys(files);
  if (ids.length === 0) return Promise.resolve({ urls: {}, close: async () => {} });

  return new Promise((resolve, reject) => {
    const token = crypto.randomBytes(24).toString("hex");
    const sockets = new Set<Socket>();
    const server = http.createServer(async (request, response) => {
      if (request.method === "OPTIONS") {
        response.statusCode = 204;
        response.setHeader("Access-Control-Allow-Origin", "*");
        response.setHeader("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
        response.setHeader("Access-Control-Allow-Headers", "Range");
        response.end();
        return;
      }
      if (request.method !== "GET" && request.method !== "HEAD") {
        response.statusCode = 405;
        response.setHeader("Allow", "GET, HEAD, OPTIONS");
        response.end("method not allowed");
        return;
      }

      let asset: LocalFile | undefined;
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        const match = /^\/asset\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (match && match[1] === token) asset = files[decodeURIComponent(match[2])];
      } catch {
        response.statusCode = 400;
        response.end("bad request");
        return;
      }
      if (!asset) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      const stat = await fs.stat(asset.file).catch(() => null);
      if (!stat?.isFile()) {
        response.statusCode = 404;
        response.end("not found");
        return;
      }

      const range = parseByteRange(request.headers.range, stat.size);
      if (range === "invalid") {
        response.statusCode = 416;
        response.setHeader("Content-Range", `bytes */${stat.size}`);
        response.end();
        return;
      }

      const start = range?.start ?? 0;
      const end = range?.end ?? Math.max(0, stat.size - 1);
      const length = stat.size === 0 ? 0 : end - start + 1;
      response.statusCode = range ? 206 : 200;
      response.setHeader("Content-Type", asset.mime);
      response.setHeader("Content-Length", length);
      response.setHeader("Accept-Ranges", "bytes");
      response.setHeader("Cache-Control", "private, max-age=3600, immutable");
      response.setHeader("Access-Control-Allow-Origin", "*");
      if (range) response.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
      if (request.method === "HEAD" || stat.size === 0) {
        response.end();
        return;
      }

      const stream = createReadStream(asset.file, { start, end });
      stream.on("error", () => {
        if (!response.headersSent) {
          response.statusCode = 500;
          response.end("read error");
        } else {
          response.destroy();
        }
      });
      response.on("close", () => stream.destroy());
      stream.pipe(response);
    });

    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        server.close();
        reject(new Error("本地资源服务启动失败"));
        return;
      }
      server.removeListener("error", reject);
      // Runtime errors are contained by request handlers; keep an error
      // listener attached so Node never turns one into an uncaught exception.
      server.on("error", () => {});

      const urls: Record<string, string> = {};
      for (const id of ids) {
        urls[id] =
          `http://127.0.0.1:${address.port}/asset/${token}/` + encodeURIComponent(id);
      }
      let closed = false;
      resolve({
        urls,
        close: async () => {
          if (closed) return;
          closed = true;
          await new Promise<void>((done) => {
            server.close(() => done());
            for (const socket of sockets) socket.destroy();
          });
        },
      });
    });
  });
}

// ---- safe output transactions ----------------------------------------------

type Artifact = { temporaryPath: string; targetPath: string };

function isExistsError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

type FileIdentity = {
  dev: number;
  ino: number;
};

type InstalledArtifactReceipt = {
  source: string;
  target: string;
  identity: FileIdentity;
};

type BackupArtifactReceipt = {
  target: string;
  backup: string;
  identity: FileIdentity;
};

function identityOf(stat: { dev: number; ino: number }): FileIdentity {
  return { dev: stat.dev, ino: stat.ino };
}

function sameFileIdentity(
  left: FileIdentity | null,
  right: FileIdentity | null,
): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

async function lstatOrNull(file: string) {
  return fs.lstat(file).catch((error) => {
    if (isMissingError(error)) return null;
    throw error;
  });
}

function uniqueTransactionSibling(file: string, kind: string): string {
  return path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}-${crypto.randomBytes(16).toString("hex")}.${kind}`,
  );
}

async function restoreQuarantineNoClobber(
  quarantinePath: string,
  target: string,
  expected: FileIdentity,
): Promise<{ restored: boolean; recoveryPath: string }> {
  const quarantined = await lstatOrNull(quarantinePath);
  if (!sameFileIdentity(quarantined ? identityOf(quarantined) : null, expected)) {
    return { restored: false, recoveryPath: quarantinePath };
  }

  try {
    // link() is the portable no-clobber primitive. A concurrent writer that
    // already owns target wins, while the quarantined inode remains preserved.
    await fs.link(quarantinePath, target);
  } catch {
    return { restored: false, recoveryPath: quarantinePath };
  }

  const [restored, stillQuarantined] = await Promise.all([
    lstatOrNull(target),
    lstatOrNull(quarantinePath),
  ]);
  if (
    !sameFileIdentity(restored ? identityOf(restored) : null, expected) ||
    !sameFileIdentity(stillQuarantined ? identityOf(stillQuarantined) : null, expected)
  ) {
    return { restored: false, recoveryPath: quarantinePath };
  }

  try {
    // quarantinePath contains a per-operation random token and is never
    // reused. Removing this verified private link cannot remove target.
    await fs.unlink(quarantinePath);
    return { restored: true, recoveryPath: target };
  } catch {
    return { restored: false, recoveryPath: quarantinePath };
  }
}

async function removeOwnedTransactionPath(
  ownedPath: string,
  expected: FileIdentity,
): Promise<void> {
  const current = await lstatOrNull(ownedPath);
  if (!current) return;
  if (!sameFileIdentity(identityOf(current), expected)) {
    throw new Error(`并发写入更换了待清理文件，已保留于: ${ownedPath}`);
  }

  // lstat + unlink has an ABA window. Move the pathname to a unique receipt
  // quarantine, then delete only if rename captured the inode we published.
  const cleanupPath = uniqueTransactionSibling(ownedPath, "cleanup");
  try {
    await fs.rename(ownedPath, cleanupPath);
  } catch (error) {
    if (isMissingError(error)) return;
    throw error;
  }

  const moved = await lstatOrNull(cleanupPath);
  const captured = moved ? identityOf(moved) : null;
  if (!sameFileIdentity(captured, expected)) {
    if (captured) {
      const restored = await restoreQuarantineNoClobber(cleanupPath, ownedPath, captured);
      throw new Error(
        `并发写入更换了待清理文件，未删除该文件，已保留于: ${restored.recoveryPath}`,
      );
    }
    throw new Error(`待清理文件在核验前消失: ${cleanupPath}`);
  }

  try {
    await fs.unlink(cleanupPath);
  } catch (error) {
    throw new Error(
      `无法清理已核验的隔离文件，文件仍保留在 ${cleanupPath}: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

async function publishArtifactNoClobber(
  artifact: Artifact,
): Promise<InstalledArtifactReceipt> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(
      artifact.temporaryPath,
      constants.O_RDONLY | constants.O_NOFOLLOW,
    );
    const staged = await handle.stat();
    if (!staged.isFile()) {
      throw new Error(`渲染暂存路径不是普通文件: ${artifact.temporaryPath}`);
    }
    const expected = identityOf(staged);

    await fs.link(artifact.temporaryPath, artifact.targetPath);
    const published = await lstatOrNull(artifact.targetPath);
    if (!sameFileIdentity(published ? identityOf(published) : null, expected)) {
      throw new Error(`输出路径在发布时被并发更换，未覆盖该文件: ${artifact.targetPath}`);
    }
    return {
      source: artifact.temporaryPath,
      target: artifact.targetPath,
      identity: expected,
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function quarantineOverwriteTarget(
  target: string,
): Promise<BackupArtifactReceipt | null> {
  const existing = await lstatOrNull(target);
  if (!existing) return null;
  if (existing.isDirectory()) throw new Error(`输出路径是目录: ${target}`);

  const expected = identityOf(existing);
  const backup = uniqueTransactionSibling(target, "backup");
  try {
    await fs.rename(target, backup);
  } catch (error) {
    if (isMissingError(error)) return null;
    throw error;
  }

  const moved = await lstatOrNull(backup);
  const captured = moved ? identityOf(moved) : null;
  if (!sameFileIdentity(captured, expected)) {
    if (!captured) throw new Error(`输出文件在隔离核验前消失: ${backup}`);
    const restored = await restoreQuarantineNoClobber(backup, target, captured);
    throw new Error(
      `输出文件在隔离时被并发更换；未删除该文件，已保留于: ${restored.recoveryPath}`,
    );
  }
  return { target, backup, identity: expected };
}

async function rollbackArtifactTransaction(
  installed: InstalledArtifactReceipt[],
  backups: BackupArtifactReceipt[],
): Promise<Error[]> {
  const failures: Error[] = [];
  for (const receipt of [...installed].reverse()) {
    try {
      await removeOwnedTransactionPath(receipt.target, receipt.identity);
    } catch (error) {
      failures.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  for (const receipt of [...backups].reverse()) {
    const restored = await restoreQuarantineNoClobber(
      receipt.backup,
      receipt.target,
      receipt.identity,
    );
    if (!restored.restored) {
      failures.push(
        new Error(
          `无法在不覆盖并发文件的前提下恢复原产物；原产物仍保留在 ${restored.recoveryPath}`,
        ),
      );
    }
  }
  return failures;
}

function transactionFailure(error: unknown, rollbackFailures: Error[]): Error {
  const original = error instanceof Error ? error : new Error(String(error));
  if (rollbackFailures.length === 0) return original;
  return new Error(
    `提交产物失败，且安全回滚保留了需要人工检查的文件: ${rollbackFailures.map((failure) => failure.message).join("；")}。原始错误: ${original.message}`,
    { cause: original },
  );
}

async function cleanupCommittedTransaction(
  installed: InstalledArtifactReceipt[],
  backups: BackupArtifactReceipt[],
): Promise<void> {
  // A committed output remains valid even if an unrelated process replaced a
  // private staging/backup pathname. Cleanup is best-effort, but every attempt
  // is receipt-checked so it can never delete that foreign inode.
  await Promise.allSettled([
    ...installed.map((receipt) =>
      removeOwnedTransactionPath(receipt.source, receipt.identity),
    ),
    ...backups.map((receipt) =>
      removeOwnedTransactionPath(receipt.backup, receipt.identity),
    ),
  ]);
}

async function prepareArtifactTargets(artifacts: Artifact[], overwrite: boolean): Promise<void> {
  const uniqueTargets = new Set<string>();
  for (const artifact of artifacts) {
    artifact.targetPath = path.resolve(artifact.targetPath);
    if (uniqueTargets.has(artifact.targetPath)) {
      throw new Error(`多个产物不能写入同一路径: ${artifact.targetPath}`);
    }
    uniqueTargets.add(artifact.targetPath);
    await fs.mkdir(path.dirname(artifact.targetPath), { recursive: true });
    const existing = await fs.lstat(artifact.targetPath).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`输出路径是目录: ${artifact.targetPath}`);
    if (existing && !overwrite) {
      throw new Error(`输出文件已存在: ${artifact.targetPath}（显式设置 overwrite 才会覆盖）`);
    }
  }
}

/** Installs all rendered files or rolls the whole set back on any failure. */
export async function commitArtifactsAtomically(
  artifacts: Artifact[],
  overwrite = false,
): Promise<void> {
  await prepareArtifactTargets(artifacts, overwrite);

  const backups: BackupArtifactReceipt[] = [];
  const installed: InstalledArtifactReceipt[] = [];
  try {
    if (overwrite) {
      for (const artifact of artifacts) {
        const backup = await quarantineOverwriteTarget(artifact.targetPath);
        if (backup) backups.push(backup);
      }
    }

    // The temporary file lives beside its target, so a hard link gives every
    // mode the same atomic no-clobber publish primitive. overwrite applies only
    // to the inode explicitly captured in backups, never to a later contender.
    for (const artifact of artifacts) {
      installed.push(await publishArtifactNoClobber(artifact));
    }
  } catch (error) {
    const rollbackFailures = await rollbackArtifactTransaction(installed, backups);
    await Promise.allSettled(
      installed.map((receipt) =>
        removeOwnedTransactionPath(receipt.source, receipt.identity),
      ),
    );
    if (!overwrite && isExistsError(error)) {
      throw transactionFailure(
        new Error("提交产物时发现同名文件；未覆盖任何已有文件", { cause: error }),
        rollbackFailures,
      );
    }
    throw transactionFailure(error, rollbackFailures);
  }
  await cleanupCommittedTransaction(installed, backups);
}

export function temporaryArtifactPath(target: string, extension: string): string {
  const absolute = path.resolve(target);
  const safeBase = path.basename(absolute).replace(/[^A-Za-z0-9._-]/g, "-") || "output";
  return path.join(path.dirname(absolute), `.${safeBase}.${randomId()}.partial${extension}`);
}

// ---- render preparation -----------------------------------------------------

export class RenderCancelledError extends Error {
  readonly code = "RENDER_CANCELLED";

  constructor(message = "渲染已取消", options?: ErrorOptions) {
    super(message, options);
    this.name = "RenderCancelledError";
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new RenderCancelledError("渲染已取消", {
      cause: signal.reason,
    });
  }
}

function combineCancelSignals(
  ownSignal: CancelSignal,
  externalSignal: CancelSignal | undefined,
): CancelSignal {
  if (!externalSignal) return ownSignal;
  return (callback) => {
    let called = false;
    const once = () => {
      if (called) return;
      called = true;
      callback();
    };
    ownSignal(once);
    externalSignal(once);
  };
}

type PreparedRender = {
  renderer: typeof import("@remotion/renderer");
  serveUrl: string;
  resolved: ResolvedConfig;
  inputProps: { config: ResolvedConfig };
  composition: Awaited<ReturnType<typeof import("@remotion/renderer")["selectComposition"]>>;
  scale: number;
  common: {
    chromiumOptions: { gl: ChromiumGlRenderer; enableMultiProcessOnLinux?: boolean };
    logLevel: LogLevel;
    browserExecutable?: string;
    binariesDirectory?: string;
    licenseKey?: string;
  };
  cancelSignal: CancelSignal;
  runRenderer: <T>(work: () => Promise<T>) => Promise<T>;
  close: () => Promise<void>;
};

type RendererLogContext = {
  logLevel: LogLevel;
  log?: (message: string) => void;
};

const rendererLogStorage = new AsyncLocalStorage<RendererLogContext>();
const configuredRenderers = new WeakSet<object>();
const logLevelRank: Record<LogLevel, number> = {
  trace: 0,
  verbose: 1,
  info: 2,
  warn: 3,
  error: 4,
};
let consoleRoutingConfigured = false;

function emitRendererLog(context: RendererLogContext, message: string): void {
  if (!context.log) return;
  // A caller may itself use console.log as the log sink. Exit the renderer
  // context to avoid recursion and to honor that explicit caller choice.
  rendererLogStorage.exit(() => context.log?.(message));
}

function configureRendererConsoleRouting(): void {
  if (consoleRoutingConfigured) return;
  consoleRoutingConfigured = true;

  const route = (
    level: LogLevel,
    original: (...args: unknown[]) => void,
    args: unknown[],
  ): void => {
    const context = rendererLogStorage.getStore();
    if (!context) {
      original(...args);
      return;
    }
    if (logLevelRank[level] < logLevelRank[context.logLevel]) return;
    emitRendererLog(context, formatLog(...args));
  };

  const originalLog = console.log.bind(console);
  const originalInfo = console.info.bind(console);
  const originalDebug = console.debug.bind(console);
  const originalWarn = console.warn.bind(console);
  const originalError = console.error.bind(console);
  console.log = (...args: unknown[]) => route("info", originalLog, args);
  console.info = (...args: unknown[]) => route("info", originalInfo, args);
  console.debug = (...args: unknown[]) => route("verbose", originalDebug, args);
  console.warn = (...args: unknown[]) => route("warn", originalWarn, args);
  console.error = (...args: unknown[]) => route("error", originalError, args);
}

function configureRendererLogging(renderer: typeof import("@remotion/renderer")): void {
  configureRendererConsoleRouting();
  if (configuredRenderers.has(renderer.RenderInternals)) return;
  configuredRenderers.add(renderer.RenderInternals);

  // Remotion's default browser-log adapter uses each browser event's severity
  // as its own threshold. This can send WebGL info messages to stdout even
  // when the API was called with logLevel="error". Route those events through
  // an async-local sink so concurrent renders stay isolated and stdout remains
  // a machine-only channel.
  renderer.RenderInternals.defaultOnLog = ({ logLevel, tag, previewString }) => {
    const context = rendererLogStorage.getStore();
    if (!context || logLevelRank[logLevel] < logLevelRank[context.logLevel]) return;
    emitRendererLog(context, `${tag ? `[${tag}] ` : ""}${previewString}`);
  };
}

async function prepareRender(params: RenderBaseParams): Promise<PreparedRender> {
  throwIfAborted(params.signal);
  const serveUrl = await resolveRenderServeUrl(params);
  throwIfAborted(params.signal);
  const assetServer = await serveLocalAssets(params.files);
  const renderer = await import("@remotion/renderer");
  configureRendererLogging(renderer);
  const ownCancellation = renderer.makeCancelSignal();
  const onAbort = () => ownCancellation.cancel();
  params.signal?.addEventListener("abort", onAbort, { once: true });

  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    params.signal?.removeEventListener("abort", onAbort);
    await assetServer.close();
  };

  try {
    const baseResolved = resolveConfig(params.config, assetServer.urls);
    const resolved: ResolvedConfig = {
      ...baseResolved,
      canvas: { ...baseResolved.canvas, fps: params.options.fps },
    };
    const inputProps = { config: resolved };
    const logLevel = params.logLevel ?? "error";
    const browserExecutable =
      params.browserExecutable ?? process.env.REMOTION_BROWSER_EXECUTABLE ?? undefined;
    const binariesDirectory =
      params.binariesDirectory ?? process.env.REMOTION_BINARIES_DIR ?? undefined;
    const licenseKey = process.env.REMOTION_LICENSE_KEY?.trim() || undefined;
    const common: PreparedRender["common"] = {
      chromiumOptions: {
        gl: resolveChromiumGlRenderer(),
        ...(process.platform === "linux" ? { enableMultiProcessOnLinux: true } : {}),
      },
      logLevel,
      ...(browserExecutable ? { browserExecutable } : {}),
      ...(binariesDirectory ? { binariesDirectory } : {}),
      ...(licenseKey ? { licenseKey } : {}),
    };
    const runRenderer = <T>(work: () => Promise<T>): Promise<T> =>
      rendererLogStorage.run({ logLevel, log: params.log }, work);

    params.log?.("正在启动无头浏览器…");
    await runRenderer(() =>
      renderer.ensureBrowser({
        logLevel,
        ...(browserExecutable ? { browserExecutable } : {}),
      }),
    );
    throwIfAborted(params.signal);

    const composition = await runRenderer(() =>
      renderer.selectComposition({
        serveUrl,
        id: "Teleprompter",
        inputProps,
        ...common,
      }),
    );
    throwIfAborted(params.signal);

    return {
      renderer,
      serveUrl,
      resolved,
      inputProps,
      composition,
      scale: scaleFor(params.options.resolution),
      common,
      cancelSignal: combineCancelSignals(ownCancellation.cancelSignal, params.cancelSignal),
      runRenderer,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function normalizeRenderError(
  error: unknown,
  signal?: AbortSignal,
): unknown {
  const message =
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
      ? error.message
      : "";
  if (signal?.aborted || /render(?:Media|Still|Frames)\(\) got cancelled/.test(message)) {
    return new RenderCancelledError("渲染已取消", { cause: error });
  }
  return error;
}

function frameForScene(config: ResolvedConfig, scene: StillScene): number {
  if (scene === "opening") return 0;
  if (scene === "content") return openingFrames(config);
  return openingFrames(config) + contentFrames(config);
}

function validateFrame(frame: number, durationInFrames: number): void {
  if (!Number.isInteger(frame) || frame < 0 || frame >= durationInFrames) {
    throw new Error(`静帧位置超出范围: ${frame}（有效范围 0-${durationInFrames - 1}）`);
  }
}

// ---- public render API ------------------------------------------------------

export async function renderVideo(params: RenderParams): Promise<RenderOutput> {
  const videoTarget = path.resolve(params.outPath);
  const coverTarget = params.coverPath ? path.resolve(params.coverPath) : undefined;
  const videoTemporary = temporaryArtifactPath(videoTarget, ".mp4");
  const coverTemporary = coverTarget ? temporaryArtifactPath(coverTarget, ".jpg") : undefined;
  const artifacts: Artifact[] = [
    { temporaryPath: videoTemporary, targetPath: videoTarget },
    ...(coverTarget && coverTemporary
      ? [{ temporaryPath: coverTemporary, targetPath: coverTarget }]
      : []),
  ];
  await prepareArtifactTargets(artifacts, params.overwrite === true);

  let prepared: PreparedRender | undefined;
  let commitAttempted = false;
  try {
    prepared = await prepareRender(params);
    const durationSec = totalSec(prepared.resolved);
    params.log?.(
      `开始渲染: ${Math.round(durationSec)} 秒 · ${params.options.resolution} · ${params.options.fps}fps · 画质 ${params.options.quality}`,
    );

    await prepared.runRenderer(() =>
      prepared!.renderer.renderMedia({
        serveUrl: prepared!.serveUrl,
        composition: prepared!.composition,
        codec: "h264",
        crf: crfFor(params.options.quality),
        scale: prepared!.scale,
        outputLocation: videoTemporary,
        overwrite: false,
        inputProps: prepared!.inputProps,
        cancelSignal: prepared!.cancelSignal,
        onProgress: ({ progress }: { progress: number }) => params.onProgress?.(progress),
        ...prepared!.common,
      }),
    );
    throwIfAborted(params.signal);

    const media = await probeMedia(videoTemporary);
    assertRenderedMediaMatchesPlan(media, {
      width: Math.round(prepared.resolved.canvas.width * prepared.scale),
      height: Math.round(prepared.resolved.canvas.height * prepared.scale),
      fps: params.options.fps,
      durationSec,
      requireAudioTrack: params.requireAudioTrack,
    });

    if (coverTemporary) {
      await prepared.runRenderer(() =>
        prepared!.renderer.renderStill({
          serveUrl: prepared!.serveUrl,
          composition: prepared!.composition,
          frame: 0,
          output: coverTemporary,
          overwrite: false,
          inputProps: prepared!.inputProps,
          imageFormat: "jpeg",
          jpegQuality: 90,
          scale: prepared!.scale,
          cancelSignal: prepared!.cancelSignal,
          ...prepared!.common,
        }),
      );
      throwIfAborted(params.signal);
    }

    commitAttempted = true;
    await commitArtifactsAtomically(artifacts, params.overwrite === true);
    return {
      outputPath: videoTarget,
      coverPath: coverTarget,
      durationSec,
      media: { ...media, path: videoTarget },
    };
  } catch (error) {
    throw prepared ? normalizeRenderError(error, params.signal) : error;
  } finally {
    await prepared?.close();
    if (!commitAttempted) {
      await Promise.all(
        [videoTemporary, coverTemporary]
          .filter((file): file is string => Boolean(file))
          .map((file) => fs.rm(file, { force: true }).catch(() => {})),
      );
    }
  }
}

export async function renderStill(params: RenderStillParams): Promise<RenderStillOutput> {
  if (params.frame !== undefined && params.scene !== undefined) {
    throw new Error("frame 和 scene 不能同时设置");
  }
  const format = params.imageFormat ??
    (path.extname(params.outPath).toLowerCase() === ".png" ? "png" : "jpeg");
  const target = path.resolve(params.outPath);
  const temporary = temporaryArtifactPath(target, format === "png" ? ".png" : ".jpg");
  const artifacts = [{ temporaryPath: temporary, targetPath: target }];
  await prepareArtifactTargets(artifacts, params.overwrite === true);

  let prepared: PreparedRender | undefined;
  let commitAttempted = false;
  try {
    prepared = await prepareRender(params);
    const scene = params.frame === undefined ? (params.scene ?? "opening") : null;
    const frame = params.frame ?? frameForScene(prepared.resolved, scene ?? "opening");
    validateFrame(frame, prepared.composition.durationInFrames);

    await prepared.runRenderer(() =>
      prepared!.renderer.renderStill({
        serveUrl: prepared!.serveUrl,
        composition: prepared!.composition,
        frame,
        output: temporary,
        overwrite: false,
        inputProps: prepared!.inputProps,
        imageFormat: format,
        ...(format === "jpeg" ? { jpegQuality: params.jpegQuality ?? 90 } : {}),
        scale: prepared!.scale,
        cancelSignal: prepared!.cancelSignal,
        ...prepared!.common,
      }),
    );
    throwIfAborted(params.signal);
    commitAttempted = true;
    await commitArtifactsAtomically(artifacts, params.overwrite === true);
    return { outputPath: target, frame, scene };
  } catch (error) {
    throw prepared ? normalizeRenderError(error, params.signal) : error;
  } finally {
    await prepared?.close();
    if (!commitAttempted) {
      await fs.rm(temporary, { force: true }).catch(() => {});
    }
  }
}

export async function renderSceneStills(
  params: RenderSceneStillsParams,
): Promise<RenderSceneStillsOutput> {
  const scenes = params.scenes ?? ["opening", "content", "ending"];
  if (scenes.length === 0) throw new Error("至少需要一个静帧场景");
  if (new Set(scenes).size !== scenes.length) throw new Error("静帧场景不能重复");
  const format = params.imageFormat ?? "jpeg";
  const extension = format === "png" ? ".png" : ".jpg";
  const outDir = path.resolve(params.outDir);
  const jobs = scenes.map((scene) => {
    const targetPath = path.join(outDir, `${scene}${extension}`);
    return {
      scene,
      artifact: {
        targetPath,
        temporaryPath: temporaryArtifactPath(targetPath, extension),
      },
    };
  });
  await prepareArtifactTargets(
    jobs.map((job) => job.artifact),
    params.overwrite === true,
  );

  let prepared: PreparedRender | undefined;
  let commitAttempted = false;
  try {
    prepared = await prepareRender(params);
    for (const job of jobs) {
      const frame = frameForScene(prepared.resolved, job.scene);
      validateFrame(frame, prepared.composition.durationInFrames);
      await prepared.runRenderer(() =>
        prepared!.renderer.renderStill({
          serveUrl: prepared!.serveUrl,
          composition: prepared!.composition,
          frame,
          output: job.artifact.temporaryPath,
          overwrite: false,
          inputProps: prepared!.inputProps,
          imageFormat: format,
          ...(format === "jpeg" ? { jpegQuality: params.jpegQuality ?? 90 } : {}),
          scale: prepared!.scale,
          cancelSignal: prepared!.cancelSignal,
          ...prepared!.common,
        }),
      );
      throwIfAborted(params.signal);
    }

    commitAttempted = true;
    await commitArtifactsAtomically(
      jobs.map((job) => job.artifact),
      params.overwrite === true,
    );
    const outputs: Partial<Record<StillScene, RenderStillOutput>> = {};
    for (const job of jobs) {
      outputs[job.scene] = {
        outputPath: job.artifact.targetPath,
        frame: frameForScene(prepared.resolved, job.scene),
        scene: job.scene,
      };
    }
    return { outputs };
  } catch (error) {
    throw prepared ? normalizeRenderError(error, params.signal) : error;
  } finally {
    await prepared?.close();
    if (!commitAttempted) {
      await Promise.all(
        jobs.map((job) => fs.rm(job.artifact.temporaryPath, { force: true }).catch(() => {})),
      );
    }
  }
}
