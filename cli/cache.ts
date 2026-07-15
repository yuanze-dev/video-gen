import os from "node:os";
import path from "node:path";
import fs from "node:fs/promises";
import crypto from "node:crypto";

const APP_CACHE_NAME = "littlestart";

export type CacheDirectoryOptions = {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
};

/**
 * Returns the user-owned cache directory used by the CLI.
 *
 * The optional arguments make the platform rules deterministic in tests. The
 * environment override is deliberately resolved to an absolute path so child
 * processes and callers with a different cwd still share the same cache.
 */
export function getCacheDirectory(options: CacheDirectoryOptions = {}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const homeDir = options.homeDir ?? os.homedir();
  const overridden = env.LITTLESTART_CACHE_DIR?.trim();
  if (overridden) return path.resolve(overridden);

  if (platform === "win32") {
    const base = env.LOCALAPPDATA?.trim() || env.APPDATA?.trim();
    return path.resolve(base || path.join(homeDir, "AppData", "Local"), APP_CACHE_NAME);
  }
  if (platform === "darwin") {
    return path.join(homeDir, "Library", "Caches", APP_CACHE_NAME);
  }
  const xdg = env.XDG_CACHE_HOME?.trim();
  return path.resolve(xdg || path.join(homeDir, ".cache"), APP_CACHE_NAME);
}

export type FileLockOptions = {
  timeoutMs?: number;
  staleMs?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** Cancels lock acquisition immediately, including while backing off. */
  signal?: AbortSignal;
};

export const CACHE_MAINTENANCE_LOCK_NAME = ".cache-maintenance.lock";

function abortError(signal: AbortSignal): Error {
  const error = new Error("操作已取消", { cause: signal.reason });
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(), ms);
    const onAbort = () => finish(abortError(signal as AbortSignal));
    signal?.addEventListener("abort", onAbort, { once: true });
    // Abort can happen between the initial check and listener registration.
    if (signal?.aborted) onAbort();
  });
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}

async function removeStaleLock(lockPath: string, staleMs: number): Promise<boolean> {
  const stat = await fs.stat(lockPath).catch(() => null);
  if (!stat || Date.now() - stat.mtimeMs <= staleMs) return false;

  const owner = await fs
    .readFile(lockPath, "utf8")
    .then((value) => JSON.parse(value) as { pid?: unknown })
    .catch(() => null);
  if (typeof owner?.pid === "number" && Number.isSafeInteger(owner.pid) && owner.pid > 0) {
    try {
      process.kill(owner.pid, 0);
      // A live owner may legitimately be doing a long first-time bundle. It
      // is safer to time out than to allow two writers into the cache.
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // EPERM means the process exists but belongs to another user.
      if (code === "EPERM") return false;
    }
  }

  // Rename first: this only removes the exact stale inode we inspected and
  // never unlinks a fresh lock another process may have just acquired.
  const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`;
  try {
    await fs.rename(lockPath, stalePath);
    await fs.rm(stalePath, { force: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs work while holding a cross-process, crash-recoverable file lock.
 */
export async function withFileLock<T>(
  lockPath: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const staleMs = options.staleMs ?? 10 * 60_000;
  const retryMinMs = options.retryMinMs ?? 80;
  const retryMaxMs = Math.max(retryMinMs, options.retryMaxMs ?? 240);
  const startedAt = Date.now();

  throwIfAborted(options.signal);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  throwIfAborted(options.signal);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  let metadataWritten = false;
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const releaseOwnedLock = async (): Promise<void> => {
    if (!handle) return;
    const ownedHandle = handle;
    handle = undefined;
    const descriptorStat = await ownedHandle.stat().catch(() => null);
    await ownedHandle.close().catch(() => {});

    const stillOwned = metadataWritten
      ? await fs
          .readFile(lockPath, "utf8")
          .then((value) => {
            const parsed = JSON.parse(value) as { token?: unknown };
            return parsed.token === ownerToken;
          })
          .catch(() => false)
      : await fs
          .lstat(lockPath)
          .then(
            (pathStat) =>
              descriptorStat !== null &&
              pathStat.dev === descriptorStat.dev &&
              pathStat.ino === descriptorStat.ino,
          )
          .catch(() => false);
    if (stillOwned) await fs.rm(lockPath, { force: true }).catch(() => {});
    metadataWritten = false;
  };
  try {
    for (;;) {
      throwIfAborted(options.signal);
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            token: ownerToken,
            createdAt: new Date().toISOString(),
          })}\n`,
        );
        metadataWritten = true;
        throwIfAborted(options.signal);
        break;
      } catch (error) {
        // Clean only the inode/token created by this attempt on metadata,
        // write, or cancellation failures.
        if (handle) {
          await releaseOwnedLock();
          throw error;
        }
        if (!isAlreadyExists(error)) throw error;
        throwIfAborted(options.signal);
        if (await removeStaleLock(lockPath, staleMs)) continue;
        throwIfAborted(options.signal);
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`等待缓存操作锁超时（${Math.round(timeoutMs / 1000)} 秒）: ${lockPath}`);
        }
        const jitter = Math.floor(Math.random() * (retryMaxMs - retryMinMs + 1));
        await abortableSleep(retryMinMs + jitter, options.signal);
      }
    }

    throwIfAborted(options.signal);
    return await work();
  } finally {
    await releaseOwnedLock();
  }
}

/**
 * Serializes destructive cache maintenance with bundle/browser writers.
 * Writers must always acquire this lock before their resource-specific lock;
 * keeping one global order prevents cross-process lock inversion.
 */
export function withCacheMaintenanceLock<T>(
  cacheRoot: string,
  work: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  return withFileLock(
    path.join(path.resolve(cacheRoot), CACHE_MAINTENANCE_LOCK_NAME),
    work,
    options,
  );
}

/** Removes abandoned staging directories without touching complete bundles. */
export async function removeStaleCacheStaging(
  cacheDir: string,
  maxAgeMs = 24 * 60 * 60_000,
): Promise<void> {
  const entries = await fs.readdir(cacheDir, { withFileTypes: true }).catch(() => []);
  const now = Date.now();
  await Promise.all(
    entries
      .filter((entry) => entry.name.startsWith(".") && entry.name.includes(".partial"))
      .map(async (entry) => {
        const target = path.join(cacheDir, entry.name);
        const stat = await fs.stat(target).catch(() => null);
        if (stat && now - stat.mtimeMs > maxAgeMs) {
          await fs.rm(target, { recursive: entry.isDirectory(), force: true }).catch(() => {});
        }
      }),
  );
}
