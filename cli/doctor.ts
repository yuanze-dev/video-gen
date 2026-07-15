import fs from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import {
  CACHE_MAINTENANCE_LOCK_NAME,
  withCacheMaintenanceLock,
  withFileLock,
} from "./cache";
import { verifyPackagedRuntime } from "./runtime";
import {
  resolveChromiumGlRenderer,
  type ChromiumGlRenderer,
} from "./chromium";

export type DoctorCheckStatus = "ok" | "warn" | "error";

export type DoctorCheck = {
  id: string;
  status: DoctorCheckStatus;
  message: string;
  details?: Record<string, unknown>;
  fixable?: boolean;
};

export type DoctorResult = {
  ok: boolean;
  checks: DoctorCheck[];
};

type BrowserStatus =
  | { type: "user-defined-path" | "local-puppeteer-browser"; path: string }
  | { type: "no-browser" }
  | { type: "version-mismatch"; actualVersion: string | null };

type RendererModule = {
  ensureBrowser: (options?: {
    logLevel?: "error" | "info" | "trace" | "verbose" | "warn";
    browserExecutable?: string | null;
    onBrowserDownload?: () => {
      version: string | null;
      onProgress: (progress: { percent: number }) => void;
    };
  }) => Promise<BrowserStatus>;
  openBrowser?: typeof import("@remotion/renderer")["openBrowser"];
};

export type BrowserInspection = {
  status: "available" | "missing" | "version-mismatch" | "invalid";
  path?: string;
  actualVersion?: string | null;
  expectedVersion?: string | null;
  cacheDirectory?: string;
  message?: string;
};

export type DoctorDependencies = {
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  homeDir?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  packaged?: boolean;
  rendererPackageJson?: string;
  importRenderer?: () => Promise<RendererModule>;
  inspectBrowser?: () => Promise<BrowserInspection>;
  ensureBrowser?: RendererModule["ensureBrowser"];
};

export type DoctorOptions = {
  fix?: boolean;
  offline?: boolean;
  cacheDir: string;
  runtimeSite?: string;
  sourceRoot?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Test seam. Production callers should not need to set this. */
  dependencies?: DoctorDependencies;
};

export type EnsureCliBrowserOptions = {
  cacheDir: string;
  fix?: boolean;
  offline?: boolean;
  sourceRoot?: string;
  signal?: AbortSignal;
  log?: (message: string) => void;
  /** Test seam. Production callers should not need to set this. */
  dependencies?: DoctorDependencies;
};

export type CliBrowserResult = BrowserInspection & {
  ok: boolean;
  browserRoot: string;
  downloaded: boolean;
};

type BrowserRuntimeProbe = {
  webgl: boolean;
  version: string | null;
  renderer: string | null;
};

async function abortableTimeout<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (work: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      work();
    };
    const onAbort = () => finish(() => reject(abortError(signal?.reason)));
    const timer = setTimeout(
      () => finish(() => reject(new Error(`Chromium runtime 探针超过 ${timeoutMs}ms`))),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    void promise.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
  });
}

async function probeBrowserRuntime(
  renderer: RendererModule,
  browserExecutable: string,
  platform: NodeJS.Platform,
  gl: ChromiumGlRenderer,
  signal?: AbortSignal,
): Promise<BrowserRuntimeProbe | null> {
  if (!renderer.openBrowser) return null;
  let browserInstance: Awaited<ReturnType<NonNullable<RendererModule["openBrowser"]>>> | undefined;
  const launch = renderer
    .openBrowser("chrome", {
      browserExecutable,
      chromeMode: "headless-shell",
      logLevel: "error",
      chromiumOptions: {
        gl,
        ...(platform === "linux" ? { enableMultiProcessOnLinux: true } : {}),
      },
    })
    .then(async (browser) => {
      if (signal?.aborted) {
        await browser.close({ silent: true }).catch(() => {});
        throw abortError(signal.reason);
      }
      return browser;
    });
  try {
    browserInstance = await abortableTimeout(launch, signal, 15_000);
    const pages = await abortableTimeout(browserInstance.pages(), signal, 5_000);
    // Remotion intentionally closes the bootstrap page before openBrowser()
    // resolves. Create a fresh page for this runtime probe instead of
    // assuming Chromium always keeps an about:blank target alive.
    const page =
      pages[0] ??
      (await abortableTimeout(
        browserInstance.newPage({
          context: () => null,
          logLevel: "error",
          indent: false,
          pageIndex: 0,
          onBrowserLog: null,
          onLog: () => {},
        }),
        signal,
        5_000,
      ));
    return await abortableTimeout(
      page.evaluate(() => {
        const canvas = document.createElement("canvas");
        const context =
          canvas.getContext("webgl2") ?? canvas.getContext("webgl");
        if (!context) return { webgl: false, version: null, renderer: null };
        return {
          webgl: true,
          version: String(context.getParameter(context.VERSION)),
          renderer: String(context.getParameter(context.RENDERER)),
        };
      }),
      signal,
      5_000,
    );
  } finally {
    await browserInstance?.close({ silent: true }).catch(() => {});
    void launch.then((browser) => {
      if (!browserInstance) return browser.close({ silent: true }).catch(() => {});
    }).catch(() => {});
  }
}

export type CacheEntry = {
  name: string;
  relativePath: string;
  kind: "directory" | "file" | "symlink" | "other";
  bytes: number;
  items: number;
  modifiedAt: string;
  symlinkTarget?: string;
};

export type CacheListResult = {
  root: string;
  exists: boolean;
  bytes: number;
  items: number;
  entries: CacheEntry[];
};

export type CacheMutationResult = {
  root: string;
  bytes: number;
  items: number;
  removed: string[];
};

export type CacheOperationOptions = {
  homeDir?: string;
  now?: number;
  partialMaxAgeMs?: number;
  rebuildMaxAgeMs?: number;
  signal?: AbortSignal;
};

export type ClearCacheOptions = CacheOperationOptions & {
  force?: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_PARTIAL_MAX_AGE_MS = DAY_MS;
const DEFAULT_REBUILD_MAX_AGE_MS = 7 * DAY_MS;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function abortError(reason?: unknown): Error {
  const error = new Error("Operation aborted", { cause: reason });
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw abortError(signal.reason);
}

function pathDepth(absolute: string): number {
  const root = path.parse(absolute).root;
  return path.relative(root, absolute).split(path.sep).filter(Boolean).length;
}

/**
 * Validates a cache root before any destructive or directory-creating action.
 * A cache root itself may not be a symlink: accepting one makes a harmless
 * command such as `cache clear` depend on a mutable target outside that path.
 */
async function resolveSafeCacheRoot(
  cacheDir: string,
  options: CacheOperationOptions = {},
): Promise<{ root: string; exists: boolean }> {
  if (!cacheDir.trim()) throw new Error("缓存目录不能为空");
  const requestedRoot = path.resolve(cacheDir);
  const home = path.resolve(options.homeDir ?? os.homedir());
  if (requestedRoot === path.parse(requestedRoot).root) {
    throw new Error(`拒绝操作文件系统根目录: ${requestedRoot}`);
  }
  if (requestedRoot === home) throw new Error(`拒绝操作用户主目录: ${requestedRoot}`);
  if (pathDepth(requestedRoot) < 2) {
    throw new Error(`缓存路径过短，拒绝操作: ${requestedRoot}`);
  }

  const stat = await fs.lstat(requestedRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (stat?.isSymbolicLink()) throw new Error(`缓存根目录不能是符号链接: ${requestedRoot}`);
  if (stat && !stat.isDirectory()) throw new Error(`缓存路径不是目录: ${requestedRoot}`);

  // Resolve existing symlinked ancestors before applying the destructive-path
  // guard. This makes `/safe-link/cache` operate on its physical cache root,
  // while a final cache-root symlink remains rejected above.
  let existingAncestor = stat ? requestedRoot : path.dirname(requestedRoot);
  while (!(await fs.lstat(existingAncestor).catch(() => null))) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) break;
    existingAncestor = parent;
  }
  const realAncestor = await fs.realpath(existingAncestor);
  const root = stat
    ? await fs.realpath(requestedRoot)
    : path.resolve(realAncestor, path.relative(existingAncestor, requestedRoot));
  const filesystemRoot = path.parse(root).root;
  const realHome = await fs.realpath(home).catch(() => home);
  if (root === filesystemRoot) throw new Error(`拒绝操作文件系统根目录: ${root}`);
  if (root === realHome) throw new Error(`拒绝操作用户主目录: ${root}`);
  if (pathDepth(root) < 2) throw new Error(`缓存路径过短，拒绝操作: ${root}`);
  return { root, exists: Boolean(stat) };
}

type PathContainmentApi = Pick<typeof path, "isAbsolute" | "relative" | "sep">;

export function isInside(
  root: string,
  target: string,
  pathApi: PathContainmentApi = path,
): boolean {
  const relative = pathApi.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${pathApi.sep}`) &&
      relative !== ".." &&
      !pathApi.isAbsolute(relative))
  );
}

async function assertDirectoryInsideRoot(root: string, directory: string): Promise<void> {
  if (!isInside(root, directory)) throw new Error(`缓存项越界: ${directory}`);
  const [realRoot, realDirectory] = await Promise.all([fs.realpath(root), fs.realpath(directory)]);
  if (!isInside(realRoot, realDirectory)) {
    throw new Error(`缓存目录指向根目录之外: ${directory}`);
  }
}

function kindOf(stat: Awaited<ReturnType<typeof fs.lstat>>): CacheEntry["kind"] {
  if (stat.isSymbolicLink()) return "symlink";
  if (stat.isDirectory()) return "directory";
  if (stat.isFile()) return "file";
  return "other";
}

type MeasuredNode = { bytes: number; items: number };

async function measureNode(root: string, target: string): Promise<MeasuredNode> {
  if (!isInside(root, target)) throw new Error(`缓存项越界: ${target}`);
  const stat = await fs.lstat(target);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return { bytes: stat.size, items: 1 };
  }

  await assertDirectoryInsideRoot(root, target);
  let bytes = 0;
  let items = 1;
  const children = await fs.readdir(target);
  for (const child of children) {
    const measured = await measureNode(root, path.join(target, child));
    bytes += measured.bytes;
    items += measured.items;
  }
  return { bytes, items };
}

async function removeTreeNoFollow(root: string, target: string): Promise<void> {
  if (!isInside(root, target) || target === root) {
    throw new Error(`拒绝删除缓存根目录或越界路径: ${target}`);
  }
  const stat = await fs.lstat(target).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (!stat) return;
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    await fs.unlink(target);
    return;
  }

  await assertDirectoryInsideRoot(root, target);
  for (const child of await fs.readdir(target)) {
    await removeTreeNoFollow(root, path.join(target, child));
  }
  await fs.rmdir(target);
}

export async function listCache(
  cacheDir: string,
  options: CacheOperationOptions = {},
): Promise<CacheListResult> {
  const safe = await resolveSafeCacheRoot(cacheDir, options);
  if (!safe.exists) {
    return { root: safe.root, exists: false, bytes: 0, items: 0, entries: [] };
  }

  const entries: CacheEntry[] = [];
  let bytes = 0;
  let items = 0;
  for (const name of (await fs.readdir(safe.root)).sort()) {
    const target = path.join(safe.root, name);
    const stat = await fs.lstat(target);
    const measured = await measureNode(safe.root, target);
    const kind = kindOf(stat);
    const entry: CacheEntry = {
      name,
      relativePath: name,
      kind,
      bytes: measured.bytes,
      items: measured.items,
      modifiedAt: stat.mtime.toISOString(),
    };
    if (kind === "symlink") entry.symlinkTarget = await fs.readlink(target);
    entries.push(entry);
    bytes += measured.bytes;
    items += measured.items;
  }
  return { root: safe.root, exists: true, bytes, items, entries };
}

type PruneCandidate = { target: string; relativePath: string };

function candidateMaxAge(name: string, options: CacheOperationOptions): number | null {
  if (name.includes(".partial") || name.endsWith("-partial")) {
    return options.partialMaxAgeMs ?? DEFAULT_PARTIAL_MAX_AGE_MS;
  }
  if (/^bundle-.+-rebuild-/.test(name)) {
    return options.rebuildMaxAgeMs ?? DEFAULT_REBUILD_MAX_AGE_MS;
  }
  return null;
}

async function collectPruneCandidates(
  root: string,
  directory: string,
  options: CacheOperationOptions,
  candidates: PruneCandidate[],
): Promise<void> {
  throwIfAborted(options.signal);
  await assertDirectoryInsideRoot(root, directory);
  const now = options.now ?? Date.now();
  const names = await fs.readdir(directory);
  const bundleLock = path.join(directory, ".bundle-cache.lock");
  const locked = await fs.lstat(bundleLock).then(() => true).catch(() => false);

  for (const name of names) {
    throwIfAborted(options.signal);
    const target = path.join(directory, name);
    const stat = await fs.lstat(target);
    const maxAge = candidateMaxAge(name, options);
    if (maxAge !== null && now - stat.mtimeMs >= Math.max(0, maxAge) && !locked) {
      candidates.push({ target, relativePath: path.relative(root, target) });
      continue;
    }
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      await collectPruneCandidates(root, target, options, candidates);
    }
  }
}

export async function pruneCache(
  cacheDir: string,
  options: CacheOperationOptions = {},
): Promise<CacheMutationResult> {
  const safe = await resolveSafeCacheRoot(cacheDir, options);
  if (!safe.exists) return { root: safe.root, bytes: 0, items: 0, removed: [] };

  throwIfAborted(options.signal);
  return withCacheMaintenanceLock(safe.root, async () => {
    throwIfAborted(options.signal);
    const candidates: PruneCandidate[] = [];
    await collectPruneCandidates(safe.root, safe.root, options, candidates);
    let bytes = 0;
    let items = 0;
    const removed: string[] = [];
    for (const candidate of candidates) {
      throwIfAborted(options.signal);
      const measured = await measureNode(safe.root, candidate.target).catch(() => null);
      if (!measured) continue;
      throwIfAborted(options.signal);
      await removeTreeNoFollow(safe.root, candidate.target);
      bytes += measured.bytes;
      items += measured.items;
      removed.push(candidate.relativePath);
    }
    return { root: safe.root, bytes, items, removed };
  }, { signal: options.signal });
}

export async function clearCache(
  cacheDir: string,
  options: ClearCacheOptions,
): Promise<CacheMutationResult> {
  if (options.force !== true) throw new Error("清空缓存需要显式确认 force=true");
  const safe = await resolveSafeCacheRoot(cacheDir, options);
  if (!safe.exists) return { root: safe.root, bytes: 0, items: 0, removed: [] };

  throwIfAborted(options.signal);
  return withCacheMaintenanceLock(safe.root, async () => {
    throwIfAborted(options.signal);
    let bytes = 0;
    let items = 0;
    const removed: string[] = [];
    for (const name of (await fs.readdir(safe.root)).sort()) {
      // This lock is removed by withCacheMaintenanceLock after the callback.
      // Deleting it here would let another process enter maintenance early.
      if (name === CACHE_MAINTENANCE_LOCK_NAME) continue;
      throwIfAborted(options.signal);
      const target = path.join(safe.root, name);
      const measured = await measureNode(safe.root, target);
      throwIfAborted(options.signal);
      await removeTreeNoFollow(safe.root, target);
      bytes += measured.bytes;
      items += measured.items;
      removed.push(name);
    }
    return { root: safe.root, bytes, items, removed };
  }, { signal: options.signal });
}

function parseNodeMajor(version: string): number | null {
  const match = /^(?:v)?(\d+)/.exec(version.trim());
  return match ? Number(match[1]) : null;
}

function platformSupported(platform: NodeJS.Platform, arch: string): boolean {
  if (platform === "darwin" || platform === "linux") return arch === "x64" || arch === "arm64";
  return platform === "win32" && arch === "x64";
}

async function cacheProbe(cacheDir: string, homeDir: string): Promise<Record<string, unknown>> {
  const safe = await resolveSafeCacheRoot(cacheDir, { homeDir });
  const missing: string[] = [];
  if (!safe.exists) {
    let current = safe.root;
    for (;;) {
      const stat = await fs.lstat(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (stat) break;
      missing.push(current);
      const parent = path.dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }

  let probeDirectory: string | undefined;
  try {
    await fs.mkdir(safe.root, { recursive: true });
    const rootStat = await fs.lstat(safe.root);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
      throw new Error("创建后的缓存根目录不是安全目录");
    }
    probeDirectory = await fs.mkdtemp(path.join(safe.root, ".doctor-"));
    const probeFile = path.join(probeDirectory, "write-probe");
    const expected = `littlestart:${process.pid}:${Date.now()}`;
    await fs.writeFile(probeFile, expected, { flag: "wx", mode: 0o600 });
    const actual = await fs.readFile(probeFile, "utf8");
    if (actual !== expected) throw new Error("缓存读写校验不一致");
  } finally {
    if (probeDirectory) await fs.rm(probeDirectory, { recursive: true, force: true }).catch(() => {});
    // Remove only directories this probe created, and only while they remain
    // empty. Never recursively remove an ancestor that another process used.
    for (const directory of missing) {
      await fs.rmdir(directory).catch(() => {});
    }
  }
  return { path: safe.root, createdTemporarily: !safe.exists, probeCleaned: true };
}

async function checkRuntime(runtimeSite: string | undefined): Promise<DoctorCheck> {
  if (!runtimeSite) {
    return {
      id: "runtime",
      status: "error",
      message: "安装包缺少预构建渲染运行时路径",
      fixable: false,
    };
  }
  const site = path.resolve(runtimeSite);
  const indexPath = path.join(site, "index.html");
  const metadataPath = path.join(path.dirname(site), "runtime.json");
  try {
    const [indexStat, metadata] = await Promise.all([
      fs.stat(indexPath),
      verifyPackagedRuntime(site, metadataPath),
    ]);
    if (!indexStat.isFile()) throw new Error("index.html 不是文件");
    return {
      id: "runtime",
      status: "ok",
      message: "预构建渲染运行时完整",
      details: { site, metadataPath, metadata },
    };
  } catch (error) {
    return {
      id: "runtime",
      status: "error",
      message: `预构建渲染运行时无效: ${errorMessage(error)}`,
      details: { site, indexPath, metadataPath },
      fixable: false,
    };
  }
}

async function checkSourceRoot(sourceRoot: string): Promise<DoctorCheck> {
  const root = path.resolve(sourceRoot);
  const required = ["package.json", "remotion/index.ts", "public/assets", "lib"];
  const missing: string[] = [];
  for (const relative of required) {
    if (!(await fs.stat(path.join(root, relative)).catch(() => null))) missing.push(relative);
  }
  return missing.length === 0
    ? {
        id: "source",
        status: "ok",
        message: "源码渲染目录完整",
        details: { root },
      }
    : {
        id: "source",
        status: "error",
        message: `源码渲染目录缺少: ${missing.join(", ")}`,
        details: { root, missing },
        fixable: false,
      };
}

function remotionPlatform(platform: NodeJS.Platform, arch: string): string | null {
  if (platform === "darwin") return arch === "arm64" ? "mac-arm64" : arch === "x64" ? "mac-x64" : null;
  if (platform === "linux") return arch === "arm64" ? "linux-arm64" : arch === "x64" ? "linux64" : null;
  if (platform === "win32") return arch === "x64" ? "win64" : null;
  return null;
}

async function resolveRendererPackageJson(
  dependencies: DoctorDependencies,
  sourceRoot: string | undefined,
): Promise<string | null> {
  if (dependencies.rendererPackageJson) return path.resolve(dependencies.rendererPackageJson);
  const anchors = [
    sourceRoot,
    process.argv[1] ? path.dirname(path.resolve(process.argv[1])) : undefined,
    dependencies.cwd,
    process.cwd(),
  ].filter((value): value is string => Boolean(value));
  for (const anchor of anchors) {
    try {
      const requireFromAnchor = createRequire(path.join(path.resolve(anchor), "__littlestart_doctor__.cjs"));
      return requireFromAnchor.resolve("@remotion/renderer/package.json");
    } catch {
      // Try the next resolution anchor.
    }
  }
  return null;
}

async function readExpectedChromeVersion(rendererPackageJson: string | null): Promise<string | null> {
  if (!rendererPackageJson) return null;
  const source = path.join(path.dirname(rendererPackageJson), "dist", "browser", "get-chrome-download-url.js");
  const text = await fs.readFile(source, "utf8").catch(() => "");
  return /TESTED_VERSION\s*=\s*['\"]([^'\"]+)['\"]/.exec(text)?.[1] ?? null;
}

async function defaultInspectBrowser(options: {
  browserRoot: string;
  platform: NodeJS.Platform;
  arch: string;
  rendererPackageJson: string | null;
}): Promise<BrowserInspection> {
  const expectedVersion = await readExpectedChromeVersion(options.rendererPackageJson);
  const platform = remotionPlatform(options.platform, options.arch);
  if (!platform) return { status: "invalid", message: "当前平台没有可用的 Remotion Chromium 构建" };
  const remotionRoot = path.join(options.browserRoot, "node_modules", ".remotion");
  const cacheDirectory = path.join(remotionRoot, "chrome-headless-shell");
  const platformDirectory = path.join(cacheDirectory, platform);
  const executableDirectory = path.join(platformDirectory, `chrome-headless-shell-${platform}`);
  const executableNames = platform === "win64"
    ? ["chrome-headless-shell.exe"]
    : platform === "linux-arm64"
      ? ["headless_shell", "chrome-headless-shell"]
      : ["chrome-headless-shell", "headless_shell"];
  let executable: string | undefined;
  for (const name of executableNames) {
    const candidate = path.join(executableDirectory, name);
    if ((await fs.stat(candidate).catch(() => null))?.isFile()) {
      executable = candidate;
      break;
    }
  }
  if (!executable) return { status: "missing", cacheDirectory, expectedVersion };

  const actualVersion = await fs.readFile(path.join(cacheDirectory, "VERSION"), "utf8")
    .then((value) => value.trim() || null)
    .catch(() => null);
  if (expectedVersion && actualVersion !== expectedVersion) {
    return {
      status: "version-mismatch",
      path: executable,
      cacheDirectory,
      actualVersion,
      expectedVersion,
    };
  }
  return {
    status: "available",
    path: executable,
    cacheDirectory,
    actualVersion,
    expectedVersion,
  };
}

let cwdOperationQueue: Promise<void> = Promise.resolve();

function withSerializedWorkingDirectory<T>(work: () => Promise<T>): Promise<T> {
  const operation = cwdOperationQueue.catch(() => {}).then(work);
  cwdOperationQueue = operation.then(
    () => undefined,
    () => undefined,
  );
  return operation;
}

async function ensureBrowserWorkspace(browserRoot: string): Promise<void> {
  await fs.mkdir(browserRoot, { recursive: true });
  const rootStat = await fs.lstat(browserRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`浏览器缓存根目录不安全: ${browserRoot}`);
  }
  const marker = path.join(browserRoot, "package.json");
  try {
    await fs.writeFile(
      marker,
      `${JSON.stringify({ private: true, name: "littlestart-browser-cache" }, null, 2)}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const stat = await fs.lstat(marker);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`浏览器缓存的 package.json 不安全: ${marker}`);
    }
  }
}

async function normalizeBrowserInspection(
  inspection: BrowserInspection,
  browserRoot: string,
): Promise<BrowserInspection> {
  if (inspection.status !== "available") return inspection;
  if (!inspection.path) {
    return { ...inspection, status: "invalid", message: "Chromium 状态缺少可执行文件路径" };
  }
  const absolute = path.resolve(inspection.path);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) {
    return { ...inspection, status: "invalid", path: absolute, message: "Chromium 可执行文件不存在" };
  }
  const real = await fs.realpath(absolute);
  if (!isInside(browserRoot, real)) {
    return {
      ...inspection,
      status: "invalid",
      path: real,
      message: "Chromium 可执行文件位于 CLI 缓存之外",
    };
  }
  return { ...inspection, path: real };
}

async function inspectConfiguredBrowser(
  configured: string,
  platform: NodeJS.Platform,
): Promise<BrowserInspection> {
  const absolute = path.resolve(configured);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) {
    return {
      status: "invalid",
      path: absolute,
      message: "REMOTION_BROWSER_EXECUTABLE 不是可执行文件",
    };
  }
  const executable = await fs
    .access(absolute, platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
    .then(() => true)
    .catch(() => false);
  if (!executable) {
    return {
      status: "invalid",
      path: absolute,
      message: "REMOTION_BROWSER_EXECUTABLE 没有执行权限",
    };
  }
  return {
    status: "available",
    path: await fs.realpath(absolute),
    message: "使用 REMOTION_BROWSER_EXECUTABLE 指定的 Chromium",
  };
}

/**
 * Resolves (and, only with `fix`, installs) the CLI-owned Chromium binary.
 *
 * Remotion derives its browser cache from process.cwd(). A tiny private package
 * marker pins that cache below `<cacheDir>/browser`; both a cross-process file
 * lock and an in-process queue protect the temporary cwd switch. Read-only
 * calls never create directories and never call ensureBrowser().
 */
export async function ensureCliBrowser(options: EnsureCliBrowserOptions): Promise<CliBrowserResult> {
  throwIfAborted(options.signal);
  const dependencies = options.dependencies ?? {};
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const safe = await resolveSafeCacheRoot(options.cacheDir, { homeDir });
  const browserRoot = path.join(safe.root, "browser");
  const existingBrowserRoot = await fs.lstat(browserRoot).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (existingBrowserRoot?.isSymbolicLink() || (existingBrowserRoot && !existingBrowserRoot.isDirectory())) {
    throw new Error(`浏览器缓存根目录不安全: ${browserRoot}`);
  }
  const rendererPackageJson = await resolveRendererPackageJson(dependencies, options.sourceRoot);
  throwIfAborted(options.signal);
  let inspection = await normalizeBrowserInspection(
    await (dependencies.inspectBrowser?.() ?? defaultInspectBrowser({
      browserRoot,
      platform,
      arch,
      rendererPackageJson,
    })),
    browserRoot,
  );
  throwIfAborted(options.signal);

  if (inspection.status === "available" || !options.fix || options.offline) {
    return {
      ...inspection,
      ok: inspection.status === "available",
      browserRoot,
      downloaded: false,
    };
  }

  throwIfAborted(options.signal);
  let attemptedDownload = false;
  const normalizedInstalled = await withCacheMaintenanceLock(safe.root, async () => {
    throwIfAborted(options.signal);
    const installed = await withFileLock(path.join(safe.root, ".browser-install.lock"), async () => {
      throwIfAborted(options.signal);
      const lockedBrowserRoot = await fs.lstat(browserRoot).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
      if (lockedBrowserRoot?.isSymbolicLink() || (lockedBrowserRoot && !lockedBrowserRoot.isDirectory())) {
        throw new Error(`浏览器缓存根目录不安全: ${browserRoot}`);
      }
      throwIfAborted(options.signal);
      // Another process may have completed the same installation while this one
      // waited for the lock. Re-inspect before initiating a download.
      inspection = await normalizeBrowserInspection(
        await (dependencies.inspectBrowser?.() ?? defaultInspectBrowser({
          browserRoot,
          platform,
          arch,
          rendererPackageJson,
        })),
        browserRoot,
      );
      throwIfAborted(options.signal);
      if (inspection.status === "available") return inspection;

      await ensureBrowserWorkspace(browserRoot);
      throwIfAborted(options.signal);
      return withSerializedWorkingDirectory(async () => {
        const previous = process.cwd();
        try {
          process.chdir(browserRoot);
          throwIfAborted(options.signal);
          const renderer = dependencies.importRenderer ? await dependencies.importRenderer() : await import("@remotion/renderer");
          throwIfAborted(options.signal);
          const ensure = dependencies.ensureBrowser ?? renderer.ensureBrowser.bind(renderer);
          attemptedDownload = true;
          options.log?.("正在下载或修复 CLI 专用 Chromium…");
          let lastDownloadPercent = -5;
          const status = await ensure({
            logLevel: "error",
            browserExecutable: null,
            onBrowserDownload: () => ({
              version: null,
              onProgress: ({ percent }) => {
                const rounded = Math.round(percent);
                if (rounded < 100 && rounded < lastDownloadPercent + 5) return;
                lastDownloadPercent = rounded;
                options.log?.(`Chromium ${rounded}%`);
              },
            }),
          });
          throwIfAborted(options.signal);
          if (status.type === "no-browser") return { status: "missing" } satisfies BrowserInspection;
          if (status.type === "version-mismatch") {
            return {
              status: "version-mismatch",
              actualVersion: status.actualVersion,
            } satisfies BrowserInspection;
          }
          return { status: "available", path: status.path } satisfies BrowserInspection;
        } finally {
          process.chdir(previous);
        }
      });
    }, { signal: options.signal });
    throwIfAborted(options.signal);
    const normalized = await normalizeBrowserInspection(installed, browserRoot);
    throwIfAborted(options.signal);
    return normalized;
  }, { signal: options.signal });

  throwIfAborted(options.signal);

  return {
    ...normalizedInstalled,
    ok: normalizedInstalled.status === "available",
    browserRoot,
    downloaded: attemptedDownload && normalizedInstalled.status === "available",
  };
}

export async function doctor(options: DoctorOptions): Promise<DoctorResult> {
  const dependencies = options.dependencies ?? {};
  const nodeVersion = dependencies.nodeVersion ?? process.versions.node;
  const platform = dependencies.platform ?? process.platform;
  const arch = dependencies.arch ?? process.arch;
  const homeDir = dependencies.homeDir ?? os.homedir();
  const packaged = dependencies.packaged ?? process.env.LITTLESTART_PACKAGED === "1";
  const checks: DoctorCheck[] = [];
  let chromiumGl: ChromiumGlRenderer = "angle";
  let chromiumGlValid = true;
  try {
    chromiumGl = resolveChromiumGlRenderer(dependencies.env ?? process.env);
    checks.push({
      id: "chromium-gl",
      status: "ok",
      message: `Chromium WebGL 后端为 ${chromiumGl}`,
      details: {
        renderer: chromiumGl,
        source: (dependencies.env ?? process.env).LITTLESTART_CHROMIUM_GL?.trim()
          ? "env"
          : "default",
      },
    });
  } catch (error) {
    chromiumGlValid = false;
    checks.push({
      id: "chromium-gl",
      status: "error",
      message: errorMessage(error),
      details: {
        value: (dependencies.env ?? process.env).LITTLESTART_CHROMIUM_GL,
        allowed: ["angle", "swangle"],
      },
      fixable: false,
    });
  }

  throwIfAborted(options.signal);
  const nodeMajor = parseNodeMajor(nodeVersion);
  checks.push(
    nodeMajor !== null && nodeMajor >= 20
      ? { id: "node", status: "ok", message: `Node.js ${nodeVersion} 满足要求`, details: { version: nodeVersion, required: ">=20" } }
      : { id: "node", status: "error", message: `Node.js ${nodeVersion} 不满足 >=20`, details: { version: nodeVersion, required: ">=20" }, fixable: false },
  );

  const supported = platformSupported(platform, arch);
  checks.push({
    id: "platform",
    status: supported ? "ok" : "error",
    message: supported ? `支持当前平台 ${platform}/${arch}` : `不支持当前平台 ${platform}/${arch}`,
    details: { platform, arch, supported: ["darwin/x64", "darwin/arm64", "linux/x64", "linux/arm64", "win32/x64"] },
    fixable: false,
  });

  throwIfAborted(options.signal);
  try {
    const details = await cacheProbe(options.cacheDir, homeDir);
    checks.push({ id: "cache", status: "ok", message: "缓存目录可安全读写，诊断探针已清理", details });
  } catch (error) {
    checks.push({
      id: "cache",
      status: "error",
      message: `缓存目录不可用: ${errorMessage(error)}`,
      details: { path: path.resolve(options.cacheDir) },
      fixable: false,
    });
  }

  throwIfAborted(options.signal);
  if (packaged || options.runtimeSite) checks.push(await checkRuntime(options.runtimeSite));
  if (!packaged && options.sourceRoot) checks.push(await checkSourceRoot(options.sourceRoot));

  throwIfAborted(options.signal);
  let renderer: RendererModule | undefined;
  let browser: CliBrowserResult | undefined;
  try {
    renderer = await (dependencies.importRenderer?.() ?? import("@remotion/renderer"));
    checks.push({ id: "renderer", status: "ok", message: "@remotion/renderer 可加载" });
  } catch (error) {
    checks.push({
      id: "renderer",
      status: "error",
      message: `@remotion/renderer 加载失败: ${errorMessage(error)}`,
      fixable: false,
    });
  }

  throwIfAborted(options.signal);
  if (!renderer) {
    checks.push({
      id: "chromium",
      status: "error",
      message: "无法检查 Chromium，因为渲染器未加载",
      fixable: false,
    });
  } else if (!chromiumGlValid) {
    checks.push({
      id: "chromium",
      status: "warn",
      message: "Chromium WebGL 后端配置无效；已跳过浏览器检查和下载",
      fixable: false,
    });
  } else {
    try {
      const configuredBrowser = (dependencies.env ?? process.env)
        .REMOTION_BROWSER_EXECUTABLE?.trim();
      if (configuredBrowser) {
        const inspection = await inspectConfiguredBrowser(configuredBrowser, platform);
        browser = {
          ...inspection,
          ok: inspection.status === "available",
          browserRoot: path.join(path.resolve(options.cacheDir), "browser"),
          downloaded: false,
        };
      } else {
        browser = await ensureCliBrowser({
          cacheDir: options.cacheDir,
          fix: options.fix,
          offline: options.offline,
          sourceRoot: options.sourceRoot,
          signal: options.signal,
          log: options.log,
          dependencies: {
            ...dependencies,
            importRenderer: async () => renderer,
          },
        });
      }
      checks.push(
        browser.ok
          ? {
              id: "chromium",
              status: "ok",
              message: configuredBrowser
                ? "自定义 Chromium 可执行且可供 Remotion 使用"
                : "CLI 专用 Chromium 已安装且可供 Remotion 使用",
              details: browser,
            }
          : {
              id: "chromium",
              status: "error",
              message: browser.status === "invalid"
                ? `Chromium 配置无效${browser.message ? `: ${browser.message}` : ""}`
                : options.fix && options.offline
                  ? "离线模式不会下载 Chromium；CLI 缓存中尚未安装匹配版本"
                  : "CLI 缓存中未安装匹配的 Chromium；运行 doctor --fix 可修复",
              details: browser,
              fixable: !configuredBrowser,
            },
      );
    } catch (error) {
      throwIfAborted(options.signal);
      checks.push({
        id: "chromium",
        status: "error",
        message: `Chromium 检查或修复失败: ${errorMessage(error)}`,
        fixable: true,
      });
    }
  }

  if (!chromiumGlValid) {
    checks.push({
      id: "webgl",
      status: "warn",
      message: "Chromium WebGL 后端配置无效；未运行 runtime 探针",
      details: { renderer: chromiumGl, runtimeProbe: false },
      fixable: false,
    });
  } else if (!supported) {
    checks.push({
      id: "webgl",
      status: "error",
      message: "当前平台无受支持的 ANGLE/WebGL 无头渲染路径",
      details: { renderer: chromiumGl, runtimeProbe: false },
      fixable: false,
    });
  } else if (!renderer || !browser?.ok || !browser.path) {
    checks.push({
      id: "webgl",
      status: "warn",
      message: "安装并验证 Chromium 后才能执行 WebGL runtime 探针",
      details: { renderer: chromiumGl, runtimeProbe: false },
      fixable: false,
    });
  } else {
    try {
      const probe = await probeBrowserRuntime(
        renderer,
        browser.path,
        platform,
        chromiumGl,
        options.signal,
      );
      checks.push(
        probe === null
          ? {
              id: "webgl",
              status: "warn",
              message: "当前渲染器未暴露 Chromium runtime 探针",
              details: { renderer: chromiumGl, runtimeProbe: false },
              fixable: false,
            }
          : probe.webgl
            ? {
                id: "webgl",
                status: "ok",
                message: "Chromium 已实际启动并创建 WebGL 上下文",
                details: { ...probe, rendererMode: chromiumGl, runtimeProbe: true },
                fixable: false,
              }
            : {
                id: "webgl",
                status: "error",
                message: "Chromium 已启动，但无法创建 WebGL 上下文",
                details: { ...probe, rendererMode: chromiumGl, runtimeProbe: true },
                fixable: false,
              },
      );
    } catch (error) {
      throwIfAborted(options.signal);
      checks.push({
        id: "webgl",
        status: "error",
        message: `Chromium runtime / WebGL 探针失败: ${errorMessage(error)}`,
        details: { renderer: chromiumGl, runtimeProbe: true },
        fixable: false,
      });
    }
  }

  return { ok: checks.every((check) => check.status !== "error"), checks };
}
