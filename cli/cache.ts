import os from "node:os";
import path from "node:path";
import { constants } from "node:fs";
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

function isMissing(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === code
  );
}

type FileIdentity = {
  dev: number;
  ino: number;
};

function sameFile(left: FileIdentity | null, right: FileIdentity | null): boolean {
  return left !== null && right !== null && left.dev === right.dev && left.ino === right.ino;
}

function uniqueSibling(filePath: string, kind: string): string {
  return `${filePath}.${kind}-${process.pid}-${crypto.randomBytes(16).toString("hex")}`;
}

function recoveryPrefix(lockPath: string): string {
  return `${path.basename(lockPath)}.recovery-`;
}

async function createRecoveryGuard(lockPath: string): Promise<string> {
  const guardPath = uniqueSibling(lockPath, "recovery");
  const handle = await fs.open(guardPath, "wx", 0o600);
  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
    );
  } catch (error) {
    await handle.close().catch(() => {});
    await fs.unlink(guardPath).catch(() => {});
    throw error;
  }
  await handle.close();
  return guardPath;
}

type LockOwner = {
  pid?: unknown;
  token?: unknown;
  released?: boolean;
};

function parseLockOwner(value: string): LockOwner | null {
  const lines = value.split(/\r?\n/).filter(Boolean);
  if (lines.length === 0) return null;
  try {
    const owner = JSON.parse(lines[0]) as { pid?: unknown; token?: unknown };
    const released =
      typeof owner.token === "string" &&
      lines.slice(1).some((line) => {
        try {
          const record = JSON.parse(line) as { released?: unknown };
          return record.released === owner.token;
        } catch {
          return false;
        }
      });
    return { ...owner, released };
  } catch {
    return null;
  }
}

function ownerIsAlive(owner: LockOwner | null): boolean {
  if (owner?.released) return false;
  if (typeof owner?.pid !== "number" || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) {
    return false;
  }
  try {
    process.kill(owner.pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function hasActiveRecoveryGuard(lockPath: string, staleMs: number): Promise<boolean> {
  const directory = path.dirname(lockPath);
  const prefix = recoveryPrefix(lockPath);
  const names = await fs.readdir(directory);

  let active = false;
  await Promise.all(
    names
      .filter((name) => name.startsWith(prefix))
      .map(async (name) => {
        const guardPath = path.join(directory, name);
        const before = await fs.lstat(guardPath).catch((error) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (!before) return;
        if (!before.isFile() || before.isSymbolicLink() || before.size > 4096) {
          active = true;
          return;
        }

        const owner = await fs
          .readFile(guardPath, "utf8")
          .then((value) => JSON.parse(value) as { pid?: unknown })
          .catch(() => null);
        const after = await fs.lstat(guardPath).catch((error) => {
          if (isMissing(error)) return null;
          throw error;
        });
        if (!sameFile(before, after)) {
          // A concurrent change is active by definition. Never clean a path
          // whose identity changed while it was being inspected.
          active = true;
          return;
        }
        if (Date.now() - before.mtimeMs <= staleMs || ownerIsAlive(owner)) {
          active = true;
          return;
        }

        // Guard names contain a random token and are never reused. Deleting
        // this exact abandoned name cannot delete a successor's guard.
        await fs.unlink(guardPath).catch((error) => {
          if (!isMissing(error)) active = true;
        });
      }),
  );
  return active;
}

async function staleLockCandidate(lockPath: string, staleMs: number): Promise<FileIdentity | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | null = null;
  try {
    try {
      handle = await fs.open(lockPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (isMissing(error) || hasErrorCode(error, "ELOOP")) return null;
      throw error;
    }
    const before = await handle.stat();
    if (
      !before.isFile() ||
      before.size > 4096
    ) {
      return null;
    }

    const owner = await handle
      .readFile("utf8")
      .then(parseLockOwner)
      .catch(() => null);
    const [after, pathStat] = await Promise.all([
      handle.stat().catch(() => null),
      fs.lstat(lockPath).catch((error) => {
        if (isMissing(error)) return null;
        throw error;
      }),
    ]);
    if (!sameFile(before, after) || !sameFile(before, pathStat)) return null;
    if (!owner?.released && Date.now() - before.mtimeMs <= staleMs) return null;
    // A live owner may legitimately be doing a long first-time bundle. It is
    // safer to time out than to allow two writers into the cache.
    return ownerIsAlive(owner) ? null : { dev: before.dev, ino: before.ino };
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function restoreQuarantinedLock(lockPath: string, quarantinePath: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    try {
      // link() is a portable no-clobber restore. Once the fixed path points at
      // the quarantined inode again, deleting only our unique name is safe.
      await fs.link(quarantinePath, lockPath);
      await fs.unlink(quarantinePath);
      return;
    } catch (error) {
      if (isMissing(error)) return;
      if (!isAlreadyExists(error)) throw error;
      await abortableSleep(2);
    }
  }
  throw new Error(`锁文件在并发更换后无法安全恢复，已保留于: ${quarantinePath}`);
}

/**
 * Recovery guards have unique, never-reused names. While any guard exists,
 * contenders check both before and after creating the fixed lock path. The
 * stale inode is first renamed to a unique quarantine and only that name is
 * deleted after its identity is verified.
 */
async function tryRecoverStaleLock(
  lockPath: string,
  staleMs: number,
): Promise<boolean> {
  const guardPath = await createRecoveryGuard(lockPath);
  const quarantinePath = uniqueSibling(lockPath, "stale");

  try {
    const candidate = await staleLockCandidate(lockPath, staleMs);
    if (!candidate) return false;
    try {
      await fs.rename(lockPath, quarantinePath);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }

    const quarantined = await fs.lstat(quarantinePath).catch(() => null);
    if (!sameFile(candidate, quarantined)) {
      await restoreQuarantinedLock(lockPath, quarantinePath);
      return false;
    }
    await fs.unlink(quarantinePath);
    return true;
  } finally {
    // This path contains a per-attempt random token. A successor always owns a
    // different path, so this finally block can release only its own guard.
    await fs.unlink(guardPath).catch(() => {});
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
  const throwIfTimedOut = (): void => {
    if (Date.now() - startedAt < timeoutMs) return;
    throw new Error(`等待缓存操作锁超时（${Math.round(timeoutMs / 1000)} 秒）: ${lockPath}`);
  };

  throwIfAborted(options.signal);
  await fs.mkdir(path.dirname(lockPath), { recursive: true });
  throwIfAborted(options.signal);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  const ownerToken = crypto.randomBytes(16).toString("hex");
  const releaseOwnedLock = async (): Promise<void> => {
    if (!handle) return;
    const ownedHandle = handle;
    handle = undefined;
    let guardPath: string | null = null;
    try {
      const descriptorStat = await ownedHandle.stat().catch(() => null);
      if (descriptorStat) {
        const marker = Buffer.from(`${JSON.stringify({ released: ownerToken })}\n`, "utf8");
        let offset = 0;
        while (offset < marker.length) {
          const { bytesWritten } = await ownedHandle.write(
            marker,
            offset,
            marker.length - offset,
            descriptorStat.size + offset,
          );
          if (bytesWritten <= 0) throw new Error("无法标记缓存锁已释放");
          offset += bytesWritten;
        }
        await ownedHandle.sync();
      }
      guardPath = await createRecoveryGuard(lockPath);
      const quarantinePath = uniqueSibling(lockPath, "released");
      try {
        await fs.rename(lockPath, quarantinePath);
      } catch (error) {
        if (isMissing(error)) return;
        throw error;
      }
      const quarantined = await fs.lstat(quarantinePath).catch(() => null);
      if (sameFile(descriptorStat, quarantined)) {
        await fs.unlink(quarantinePath);
      } else {
        // The fixed path was replaced before release. Preserve and restore the
        // foreign inode instead of deleting a successor after a token check.
        await restoreQuarantinedLock(lockPath, quarantinePath);
      }
    } finally {
      await ownedHandle.close().catch(() => {});
      if (guardPath) await fs.unlink(guardPath).catch(() => {});
    }
  };
  try {
    for (;;) {
      throwIfAborted(options.signal);
      if (await hasActiveRecoveryGuard(lockPath, staleMs)) {
        throwIfTimedOut();
        const jitter = Math.floor(Math.random() * (retryMaxMs - retryMinMs + 1));
        await abortableSleep(retryMinMs + jitter, options.signal);
        continue;
      }
      try {
        handle = await fs.open(lockPath, "wx", 0o600);
        await handle.writeFile(
          `${JSON.stringify({
            pid: process.pid,
            token: ownerToken,
            createdAt: new Date().toISOString(),
          })}\n`,
        );
        throwIfAborted(options.signal);
        if (await hasActiveRecoveryGuard(lockPath, staleMs)) {
          await releaseOwnedLock();
          throwIfTimedOut();
          const jitter = Math.floor(Math.random() * (retryMaxMs - retryMinMs + 1));
          await abortableSleep(retryMinMs + jitter, options.signal);
          continue;
        }
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
        if (await tryRecoverStaleLock(lockPath, staleMs)) continue;
        throwIfAborted(options.signal);
        throwIfTimedOut();
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
