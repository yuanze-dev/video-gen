import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { constants, existsSync } from "node:fs";
import fs from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";
import type {
  DesktopCliInstallResult,
  DesktopCliInstallState,
} from "../lib/desktop-bridge";

export const CLI_LAUNCHER_MARKER = "# littlestart-cli-launcher:v1";
export const CLI_PROFILE_START = "# >>> littlestart CLI >>>";
export const CLI_PROFILE_END = "# <<< littlestart CLI <<<";

type RunExecutable = (
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
) => Promise<{ stdout: string; stderr: string }>;

type CliInstallerOptions = {
  supported: boolean;
  homeDir: string;
  shellPath: string;
  pathEnv: string;
  appExecutable: string;
  resourcesPath: string;
  cliRoot: string;
  runExecutable?: RunExecutable;
  testHooks?: {
    beforeLauncherInspect?: (file: string) => Promise<void>;
    beforeLauncherWrite?: (file: string) => Promise<void>;
    afterLauncherPublish?: (file: string) => Promise<void>;
    beforeProfilePublish?: (file: string) => Promise<void>;
    afterProfilePublish?: (file: string) => Promise<void>;
    beforeQuarantineCleanup?: (file: string) => Promise<void>;
    beforeFinalStateCheck?: () => Promise<void>;
    beforeStaleLockReclaim?: (createSuccessor: () => Promise<string>) => Promise<void>;
  };
};

type LauncherInspection =
  | { kind: "missing" }
  | { kind: "current"; content: string; mode: number; version: string | null }
  | { kind: "managed-stale"; content: string; mode: number; version: string | null }
  | { kind: "conflict" };

type LauncherBackup = {
  bytes: Buffer;
  content: string;
  mode: number;
  device: number;
  inode: number;
  size: number;
  modifiedMs: number;
} | null;

type LauncherSnapshot = Exclude<LauncherBackup, null>;

type LauncherMutationReceipt = {
  // Registered by the caller before the first directory mutation. Old and new
  // launcher inodes are immutable; only their directory entries move.
  file: string;
  previous: LauncherBackup;
  quarantinePath: string | null;
  published: LauncherSnapshot | null;
};

type ProfileMutationReceipt = LauncherMutationReceipt;

type MutationOutcome = {
  ok: boolean;
  retainedPaths: string[];
};

type ManagedPathPlan =
  | { configured: true; warning?: string; needsPublish?: false }
  | { configured: false; warning: string; needsPublish?: false }
  | {
      configured: true;
      needsPublish: true;
      warning?: undefined;
      previous: LauncherBackup;
      content: Buffer;
      mode: number;
    };

type InstallPlan = {
  state: DesktopCliInstallState;
  fingerprint: string;
};

const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_LAUNCHER_BYTES = 256 * 1024;
const VERIFY_TIMEOUT_MS = 60_000;
const INSTALL_LOCK_STALE_MS = 10 * 60 * 1000;
const INSTALL_LOCK_GENERATION = /^generation-([0-9a-f]{12})$/;

function runExecutableDefault(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number; env: NodeJS.ProcessEnv },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: options.env,
        maxBuffer: 1024 * 1024,
        timeout: options.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve({ stdout, stderr });
      },
    );
  });
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function readVersionMarker(content: string): string | null {
  return /^# littlestart-cli-version:([^\r\n]+)$/m.exec(content)?.[1]?.trim() ?? null;
}

function isManagedLauncher(content: string): boolean {
  return (
    content.startsWith(`#!/bin/sh\n${CLI_LAUNCHER_MARKER}\n# littlestart-cli-version:`) &&
    content.includes("\nexport ELECTRON_RUN_AS_NODE=1\n") &&
    content.includes("\nexec ")
  );
}

function withoutLauncherVersion(content: string): string {
  // The launcher always points into the current .app. When Electron updates in
  // place, the CLI updates with it; a stale comment alone must not ask users to
  // repair an otherwise current launcher.
  return content.replace(/^# littlestart-cli-version:[^\r\n]+$/m, "# littlestart-cli-version:<current>");
}

function isMissing(error: unknown): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === "ENOENT";
}

function hasErrorCode(error: unknown, code: string): boolean {
  return !!error && typeof error === "object" && "code" in error && error.code === code;
}

function chooseProfile(homeDir: string, shellPath: string): string | null {
  switch (path.basename(shellPath)) {
    case "zsh":
      return path.join(homeDir, ".zprofile");
    case "bash": {
      // Bash reads only the first existing login profile. Creating a new
      // .bash_profile would otherwise hide a user's .bash_login or .profile.
      const candidates = [".bash_profile", ".bash_login", ".profile"];
      return path.join(
        homeDir,
        candidates.find((candidate) => existsSync(path.join(homeDir, candidate))) ?? ".bash_profile",
      );
    }
    case "sh":
    case "dash":
    case "ksh":
      return path.join(homeDir, ".profile");
    default:
      return null;
  }
}

function pathContains(pathEnv: string, binDir: string): boolean {
  return pathEnv
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === path.resolve(binDir));
}

async function readHandleBytes(handle: FileHandle, size: number): Promise<Buffer> {
  const buffer = Buffer.alloc(size);
  let offset = 0;
  while (offset < size) {
    const { bytesRead } = await handle.read(buffer, offset, size - offset, offset);
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

async function snapshotHandle(
  handle: FileHandle,
  maxBytes: number,
): Promise<LauncherSnapshot | null> {
  const before = await handle.stat();
  if (!before.isFile() || before.size > maxBytes) return null;
  const bytes = await readHandleBytes(handle, before.size);
  const after = await handle.stat();
  if (
    bytes.length !== before.size ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs
  ) {
    return null;
  }
  return {
    bytes,
    content: bytes.toString("utf8"),
    mode: after.mode & 0o7777,
    device: after.dev,
    inode: after.ino,
    size: after.size,
    modifiedMs: after.mtimeMs,
  };
}

function sameSnapshot(left: LauncherSnapshot, right: LauncherSnapshot): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.modifiedMs === right.modifiedMs &&
    left.bytes.equals(right.bytes)
  );
}

async function readSnapshotAtPath(
  file: string,
  maxBytes: number,
): Promise<LauncherSnapshot | "missing" | null> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    return await snapshotHandle(handle, maxBytes);
  } catch (error) {
    if (isMissing(error)) return "missing";
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function exclusivePublish(
  file: string,
  content: string | Buffer,
  mode: number,
  maxBytes: number,
): Promise<LauncherSnapshot> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.littlestart-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await fs.chmod(temporary, mode);
    const snapshot = await readSnapshotAtPath(temporary, maxBytes);
    if (!snapshot || snapshot === "missing") throw new Error("VERIFY_FAILED");
    await fs.link(temporary, file);
    return snapshot;
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

type InstallLockRecord = {
  token: string;
  status: "active" | "released";
  updatedAt: string;
};

type InstallLockLease = {
  generation: number;
  directory: string;
  token: string;
  handle: FileHandle;
};

function installLockGenerationName(generation: number): string {
  return `generation-${generation.toString(16).padStart(12, "0")}`;
}

async function writeInstallLockRecord(
  handle: FileHandle,
  record: InstallLockRecord,
): Promise<void> {
  const content = Buffer.from(`${JSON.stringify(record)}\n`, "utf8");
  let offset = 0;
  while (offset < content.length) {
    const { bytesWritten } = await handle.write(
      content,
      offset,
      content.length - offset,
      offset,
    );
    if (bytesWritten === 0) throw new Error("INSTALL_LOCK_SHORT_WRITE");
    offset += bytesWritten;
  }
  await handle.truncate(content.length);
  await handle.sync();
}

async function latestInstallLockGeneration(
  lockPath: string,
): Promise<{ generation: number; directory: string } | null> {
  let latest: number | null = null;
  for (const entry of await fs.readdir(lockPath)) {
    const match = INSTALL_LOCK_GENERATION.exec(entry);
    if (!match) continue;
    const generation = Number.parseInt(match[1], 16);
    if (latest === null || generation > latest) latest = generation;
  }
  return latest === null
    ? null
    : {
        generation: latest,
        directory: path.join(lockPath, installLockGenerationName(latest)),
      };
}

async function inspectInstallLockGeneration(
  directory: string,
): Promise<{ released: boolean; stale: boolean }> {
  const directoryStat = await fs.lstat(directory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) {
    return { released: false, stale: false };
  }

  const ownerPath = path.join(directory, "owner.json");
  let ownerHandle: FileHandle | null = null;
  try {
    ownerHandle = await fs.open(ownerPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const ownerSnapshot = await snapshotHandle(ownerHandle, 4096);
    if (!ownerSnapshot) return { released: false, stale: false };
    let record: Partial<InstallLockRecord> = {};
    try {
      record = JSON.parse(ownerSnapshot.content) as Partial<InstallLockRecord>;
    } catch {}
    const validRecord =
      typeof record.token === "string" &&
      record.token.length > 0 &&
      (record.status === "active" || record.status === "released");
    if (!validRecord) {
      return {
        released: false,
        stale:
          Date.now() - Math.max(directoryStat.mtimeMs, ownerSnapshot.modifiedMs) >
          INSTALL_LOCK_STALE_MS,
      };
    }
    return {
      released: record.status === "released",
      stale:
        record.status === "active" &&
        Date.now() - Math.max(directoryStat.mtimeMs, ownerSnapshot.modifiedMs) >
          INSTALL_LOCK_STALE_MS,
    };
  } catch (error) {
    if (!isMissing(error)) return { released: false, stale: false };
    return {
      released: false,
      stale: Date.now() - directoryStat.mtimeMs > INSTALL_LOCK_STALE_MS,
    };
  } finally {
    await ownerHandle?.close().catch(() => {});
  }
}

async function createInstallLockLease(
  lockPath: string,
  generation: number,
): Promise<InstallLockLease> {
  const directory = path.join(lockPath, installLockGenerationName(generation));
  await fs.mkdir(directory, { mode: 0o700 });
  const token = `${process.pid}:${crypto.randomUUID()}`;
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(path.join(directory, "owner.json"), "wx+", 0o600);
    await writeInstallLockRecord(handle, {
      token,
      status: "active",
      updatedAt: new Date().toISOString(),
    });
    return { generation, directory, token, handle };
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

async function acquireInstallLock(
  lockPath: string,
  testHooks: CliInstallerOptions["testHooks"] = {},
): Promise<() => Promise<void>> {
  try {
    await fs.mkdir(lockPath, { mode: 0o700 });
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error;
    const stat = await fs.lstat(lockPath);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("INSTALL_BUSY");
  }

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const latest = await latestInstallLockGeneration(lockPath);
    let generation = 0;
    if (latest) {
      const inspection = await inspectInstallLockGeneration(latest.directory);
      if (!inspection.released && !inspection.stale) throw new Error("INSTALL_BUSY");
      generation = latest.generation + 1;
      if (generation > 0xffffffffffff) throw new Error("INSTALL_BUSY");
      if (inspection.stale) {
        await testHooks?.beforeStaleLockReclaim?.(async () => {
          const successor = await createInstallLockLease(lockPath, generation);
          await successor.handle.close();
          return successor.directory;
        });
      }
    }

    let lease: InstallLockLease;
    try {
      lease = await createInstallLockLease(lockPath, generation);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) continue;
      throw error;
    }

    return async () => {
      try {
        await writeInstallLockRecord(lease.handle, {
          token: lease.token,
          status: "released",
          updatedAt: new Date().toISOString(),
        });
      } catch {
        // A failed release remains active until its lease becomes stale.
      } finally {
        await lease.handle.close().catch(() => {});
      }
    };
  }
  throw new Error("INSTALL_BUSY");
}

function profileBlock(binDir: string): string {
  return `${CLI_PROFILE_START}\nexport PATH=${shellQuote(binDir)}:"$PATH"\n${CLI_PROFILE_END}`;
}

function hasExactManagedBlock(content: string, binDir: string): boolean {
  const lines = content.split(/\r?\n/);
  const blockLines = profileBlock(binDir).split("\n");
  let controlDepth = 0;
  let heredocDelimiter: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trim();
    if (heredocDelimiter) {
      if (trimmed === heredocDelimiter) heredocDelimiter = null;
      continue;
    }
    if (
      controlDepth === 0 &&
      blockLines.every((blockLine, offset) => lines[index + offset] === blockLine)
    ) {
      return true;
    }

    const heredoc = /<<-?\s*['\"]?([A-Za-z_][A-Za-z0-9_]*)['\"]?/.exec(line);
    if (heredoc) {
      heredocDelimiter = heredoc[1] ?? null;
      continue;
    }
    if (/^(?:fi|done|esac|})\b/.test(trimmed) || trimmed === "}") {
      controlDepth = Math.max(0, controlDepth - 1);
    }
    if (
      /^(?:if|for|while|until|case|select)\b/.test(trimmed) ||
      /^function\s+[A-Za-z_][A-Za-z0-9_]*\b/.test(trimmed) ||
      /^[A-Za-z_][A-Za-z0-9_]*\s*\(\)\s*\{/.test(trimmed)
    ) {
      controlDepth += 1;
    }
  }
  return false;
}

async function readSmallProfile(profilePath: string): Promise<LauncherSnapshot | "missing" | null> {
  return readSnapshotAtPath(profilePath, MAX_PROFILE_BYTES);
}

async function fingerprintFile(file: string, maxBytes: number): Promise<unknown> {
  let handle: FileHandle | null = null;
  try {
    handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const snapshot = await snapshotHandle(handle, maxBytes);
    return snapshot
      ? {
          contentHash: crypto.createHash("sha256").update(snapshot.bytes).digest("hex"),
          mode: snapshot.mode,
          device: snapshot.device,
          inode: snapshot.inode,
          size: snapshot.size,
          modifiedMs: snapshot.modifiedMs,
        }
      : { kind: "unsafe" };
  } catch (error) {
    if (isMissing(error)) return { kind: "missing" };
    return {
      kind: "error",
      code:
        error && typeof error === "object" && "code" in error ? String(error.code) : "UNKNOWN",
    };
  } finally {
    await handle?.close().catch(() => {});
  }
}

function isConfirmableStatus(status: DesktopCliInstallState["status"]): boolean {
  return status === "not-installed" || status === "repair-needed" || status === "installed";
}

async function profileHasManagedPath(
  profilePath: string | null,
  binDir: string,
): Promise<boolean> {
  if (!profilePath) return false;
  const profile = await readSmallProfile(profilePath);
  return profile !== null && profile !== "missing"
    ? hasExactManagedBlock(profile.content, binDir)
    : false;
}

async function planManagedPath(
  profilePath: string | null,
  binDir: string,
  pathEnv: string,
): Promise<ManagedPathPlan> {
  if (pathContains(pathEnv, binDir)) return { configured: true };
  if (!profilePath) {
    return {
      configured: false,
      warning: `CLI 已安装；请手动将 ${binDir} 加入 PATH。`,
    };
  }

  const snapshot = await readSmallProfile(profilePath);
  if (snapshot === null) {
    return {
      configured: false,
      warning: `CLI 已安装，但 ${profilePath} 不是可安全修改的普通文件，请手动配置 PATH。`,
    };
  }
  const content = snapshot === "missing" ? "" : snapshot.content;
  if (hasExactManagedBlock(content, binDir)) return { configured: true };
  if (content.includes(CLI_PROFILE_START) || content.includes(CLI_PROFILE_END)) {
    return {
      configured: false,
      warning: `CLI 已安装，但 ${profilePath} 中的 Littlestart 标记不完整，请手动配置 PATH。`,
    };
  }

  const previousBytes = snapshot === "missing" ? Buffer.alloc(0) : snapshot.bytes;
  const prefix =
    previousBytes.length === 0
      ? ""
      : previousBytes[previousBytes.length - 1] === 0x0a
        ? "\n"
        : "\n\n";
  return {
    configured: true,
    needsPublish: true,
    previous: snapshot === "missing" ? null : snapshot,
    content: Buffer.concat([
      previousBytes,
      Buffer.from(`${prefix}${profileBlock(binDir)}\n`, "utf8"),
    ]),
    // The replacement keeps the exact byte prefix and POSIX mode. Node does
    // not expose a portable O_NOFOLLOW xattr/ACL clone API, so extended
    // metadata is intentionally outside this transaction's current scope.
    mode: snapshot === "missing" ? 0o644 : snapshot.mode,
  };
}

function parseVersionOutput(stdout: string, expectedVersion: string): boolean {
  try {
    const value = JSON.parse(stdout) as {
      ok?: unknown;
      command?: unknown;
      result?: { version?: unknown; packaged?: unknown };
    };
    return (
      value.ok === true &&
      value.command === "version" &&
      value.result?.version === expectedVersion &&
      value.result?.packaged === true
    );
  } catch {
    return false;
  }
}

export function createDesktopCliInstaller(options: CliInstallerOptions) {
  const binDir = path.join(options.homeDir, ".local", "bin");
  const installPath = path.join(binDir, "littlestart");
  const aliasPath = path.join(binDir, "video-gen");
  const profilePath = chooseProfile(options.homeDir, options.shellPath);
  const cliEntry = path.join(options.cliRoot, "dist", "littlestart.cjs");
  const packageFile = path.join(options.cliRoot, "package.json");
  const runtimeFile = path.join(options.cliRoot, "runtime", "runtime.json");
  const nodeModulesPath = path.join(options.resourcesPath, "app.asar", "node_modules");
  const compositorPath = path.join(
    options.resourcesPath,
    "app.asar.unpacked",
    "node_modules",
    "@remotion",
    "compositor-darwin-arm64",
  );
  const browserPath = path.join(
    options.resourcesPath,
    "render-bin",
    "chrome-headless-shell",
    "mac-arm64",
    "chrome-headless-shell-mac-arm64",
    "chrome-headless-shell",
  );
  const runExecutable = options.runExecutable ?? runExecutableDefault;
  let installInFlight: Promise<DesktopCliInstallResult> | null = null;
  let installingState: DesktopCliInstallState | null = null;
  const validPlans = new WeakSet<InstallPlan>();

  const baseState = (status: DesktopCliInstallState["status"]): DesktopCliInstallState => ({
    status,
    installPath,
    aliasPath,
    profilePath: profilePath ?? undefined,
  });

  const readBundledVersion = async (): Promise<string> => {
    const [manifest, entryOk, runtimeOk] = await Promise.all([
      fs.readFile(packageFile, "utf8"),
      isRegularFile(cliEntry),
      isRegularFile(runtimeFile),
    ]);
    const value = JSON.parse(manifest) as { version?: unknown };
    if (
      typeof value.version !== "string" ||
      !/^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/.test(value.version) ||
      !entryOk ||
      !runtimeOk
    ) {
      throw new Error("CLI_RUNTIME_MISSING");
    }
    return value.version;
  };

  const launcherContent = (version: string): string => `#!/bin/sh
${CLI_LAUNCHER_MARKER}
# littlestart-cli-version:${version}
export ELECTRON_RUN_AS_NODE=1
export NODE_PATH=${shellQuote(nodeModulesPath)}
export REMOTION_BINARIES_DIR=${shellQuote(compositorPath)}
export REMOTION_BROWSER_EXECUTABLE=${shellQuote(browserPath)}
exec ${shellQuote(options.appExecutable)} ${shellQuote(cliEntry)} "$@"
`;

  const inspectLauncher = async (
    file: string,
    expectedContent: string,
  ): Promise<LauncherInspection> => {
    await options.testHooks?.beforeLauncherInspect?.(file);
    const snapshot = await readSnapshotAtPath(file, MAX_LAUNCHER_BYTES);
    if (snapshot === "missing") return { kind: "missing" };
    if (!snapshot || !isManagedLauncher(snapshot.content)) return { kind: "conflict" };
    const common = {
      content: snapshot.content,
      mode: snapshot.mode,
      version: readVersionMarker(snapshot.content),
    };
    return withoutLauncherVersion(snapshot.content) === withoutLauncherVersion(expectedContent) &&
      (snapshot.mode & 0o100) !== 0
      ? { kind: "current", ...common }
      : { kind: "managed-stale", ...common };
  };

  const getState = async (): Promise<DesktopCliInstallState> => {
    if (installingState) return installingState;
    if (!options.supported) {
      return {
        ...baseState("unsupported"),
        errorCode: "UNSUPPORTED_PLATFORM",
        message: "请在已安装到 Mac 的正式桌面版中使用一键安装。",
        retryable: false,
      };
    }
    const executablePath = path.resolve(options.appExecutable);
    if (
      executablePath.startsWith(`${path.sep}Volumes${path.sep}`) ||
      executablePath.includes(`${path.sep}AppTranslocation${path.sep}`)
    ) {
      return {
        ...baseState("error"),
        errorCode: "APP_NOT_STABLE",
        message: "请先把小音符起号助手拖入“应用程序”，再安装 CLI。",
        retryable: false,
      };
    }

    try {
      const bundledVersion = await readBundledVersion();
      const expectedContent = launcherContent(bundledVersion);
      const [primary, alias, managedProfile] = await Promise.all([
        inspectLauncher(installPath, expectedContent),
        inspectLauncher(aliasPath, expectedContent),
        profileHasManagedPath(profilePath, binDir),
      ]);
      const pathConfigured = pathContains(options.pathEnv, binDir) || managedProfile;

      if (primary.kind === "conflict") {
        return {
          ...baseState("conflict"),
          bundledVersion,
          pathConfigured,
          errorCode: "EXISTING_COMMAND_CONFLICT",
          message: `${installPath} 已存在且不属于小音符，未进行覆盖。`,
          retryable: false,
        };
      }

      if (primary.kind === "current") {
        const aliasConflict = alias.kind === "conflict";
        return {
          ...baseState("installed"),
          bundledVersion,
          installedVersion: bundledVersion,
          pathConfigured,
          message: pathConfigured
            ? aliasConflict
              ? "CLI 已就绪；已有 video-gen 命令已保留，请使用 littlestart。"
              : "CLI 已就绪。新打开的终端可直接使用 littlestart。"
            : `CLI 已安装；请手动将 ${binDir} 加入 PATH。`,
          retryable: false,
        };
      }

      const installedVersion =
        primary.kind === "managed-stale"
          ? primary.version ?? undefined
          : alias.kind === "managed-stale" || alias.kind === "current"
            ? alias.version ?? undefined
            : undefined;
      const notInstalled =
        primary.kind === "missing" &&
        (alias.kind === "missing" || alias.kind === "conflict");
      return {
        ...baseState(notInstalled ? "not-installed" : "repair-needed"),
        bundledVersion,
        installedVersion,
        pathConfigured,
        message: notInstalled
          ? "安装后可在 Codex、Claude Code 或终端中直接生产视频。"
          : "启动器不完整或来自旧版本，可以安全修复。",
        retryable: true,
      };
    } catch {
      return {
        ...baseState("error"),
        errorCode: "CLI_RUNTIME_MISSING",
        message: "桌面版没有携带完整的 CLI，请更新或重新安装桌面版。",
        retryable: false,
      };
    }
  };

  const fingerprintState = async (state: DesktopCliInstallState): Promise<string> => {
    const files = await Promise.all([
      fingerprintFile(installPath, MAX_LAUNCHER_BYTES),
      fingerprintFile(aliasPath, MAX_LAUNCHER_BYTES),
      profilePath
        ? fingerprintFile(profilePath, MAX_PROFILE_BYTES)
        : Promise.resolve({ kind: "none" }),
      fingerprintFile(packageFile, MAX_LAUNCHER_BYTES),
    ]);
    return crypto
      .createHash("sha256")
      .update(JSON.stringify({ state, files }))
      .digest("hex");
  };

  const prepareInstall = async (): Promise<InstallPlan> => {
    const state = await getState();
    const plan = { state, fingerprint: await fingerprintState(state) };
    validPlans.add(plan);
    return plan;
  };

  const backup = async (file: string): Promise<LauncherBackup> => {
    const snapshot = await readSnapshotAtPath(file, MAX_LAUNCHER_BYTES);
    if (snapshot === "missing") return null;
    if (!snapshot || !isManagedLauncher(snapshot.content)) {
      throw new Error("EXISTING_COMMAND_CONFLICT");
    }
    return snapshot;
  };

  const restoreEntryNoClobber = async (
    quarantinePath: string,
    targetPath: string,
  ): Promise<boolean> => {
    try {
      await fs.link(quarantinePath, targetPath);
      await fs.unlink(quarantinePath);
      return true;
    } catch {
      return false;
    }
  };

  const hiddenRecoveryPath = (file: string, label: string): string => {
    const basename = path.basename(file);
    const hiddenBasename = basename.startsWith(".") ? basename : `.${basename}`;
    return path.join(
      path.dirname(file),
      `${hiddenBasename}.littlestart-${label}-${crypto.randomUUID()}`,
    );
  };

  const publishImmutableFile = async (
    receipt: LauncherMutationReceipt,
    content: string | Buffer,
    mode: number,
    maxBytes: number,
    beforePublish?: (file: string) => Promise<void>,
    afterPublish?: (file: string) => Promise<void>,
  ): Promise<LauncherSnapshot> => {
    await beforePublish?.(receipt.file);
    if (receipt.previous) {
      const current = await readSnapshotAtPath(receipt.file, maxBytes);
      if (!current || current === "missing" || !sameSnapshot(current, receipt.previous)) {
        throw new Error("EXISTING_COMMAND_CONFLICT");
      }
      // Moving first gives us a CAS-like boundary: verify exactly what rename
      // captured, then publish the replacement with link(2) no-clobber.
      const quarantinePath = hiddenRecoveryPath(receipt.file, "previous");
      try {
        await fs.rename(receipt.file, quarantinePath);
        receipt.quarantinePath = quarantinePath;
      } catch (error) {
        if (isMissing(error)) throw new Error("EXISTING_COMMAND_CONFLICT");
        throw error;
      }
      const moved = await readSnapshotAtPath(quarantinePath, maxBytes);
      if (!moved || moved === "missing" || !sameSnapshot(moved, receipt.previous)) {
        if (await restoreEntryNoClobber(quarantinePath, receipt.file)) {
          receipt.quarantinePath = null;
        }
        throw new Error("EXISTING_COMMAND_CONFLICT");
      }
    }

    try {
      receipt.published = await exclusivePublish(receipt.file, content, mode, maxBytes);
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) throw new Error("EXISTING_COMMAND_CONFLICT");
      throw error;
    }
    await afterPublish?.(receipt.file);
    const installed = await readSnapshotAtPath(receipt.file, maxBytes);
    if (!installed || installed === "missing" || !sameSnapshot(installed, receipt.published)) {
      throw new Error("EXISTING_COMMAND_CONFLICT");
    }
    return installed;
  };

  const publishLauncher = (
    receipt: LauncherMutationReceipt,
    content: string,
  ): Promise<LauncherSnapshot> =>
    publishImmutableFile(
      receipt,
      content,
      0o755,
      MAX_LAUNCHER_BYTES,
      options.testHooks?.beforeLauncherWrite,
      options.testHooks?.afterLauncherPublish,
    );

  const publishProfile = (
    receipt: ProfileMutationReceipt,
    content: Buffer,
    mode: number,
  ): Promise<LauncherSnapshot> =>
    publishImmutableFile(
      receipt,
      content,
      mode,
      MAX_PROFILE_BYTES,
      options.testHooks?.beforeProfilePublish,
      options.testHooks?.afterProfilePublish,
    );

  const removePublishedEntry = async (
    receipt: LauncherMutationReceipt,
    maxBytes: number,
  ): Promise<MutationOutcome> => {
    if (!receipt.published) return { ok: true, retainedPaths: [] };
    // Avoid moving a replacement merely to inspect it. This keeps foreign
    // files, symlinks, and especially directories at the user-visible path.
    const current = await readSnapshotAtPath(receipt.file, maxBytes);
    if (!current || current === "missing" || !sameSnapshot(current, receipt.published)) {
      return {
        ok: false,
        retainedPaths: current === "missing" ? [] : [receipt.file],
      };
    }
    const quarantinePath = hiddenRecoveryPath(receipt.file, "published");
    let isolated = false;
    try {
      // Rollback uses the same rule in reverse. Never unlink the user-visible
      // entry until the quarantined inode matches our publish receipt.
      await fs.rename(receipt.file, quarantinePath);
      isolated = true;
      const moved = await readSnapshotAtPath(quarantinePath, maxBytes);
      if (moved && moved !== "missing" && sameSnapshot(moved, receipt.published)) {
        await fs.unlink(quarantinePath);
        receipt.published = null;
        return { ok: true, retainedPaths: [] };
      }
      const restored = await restoreEntryNoClobber(quarantinePath, receipt.file);
      return {
        ok: false,
        retainedPaths: [restored ? receipt.file : quarantinePath],
      };
    } catch {
      return {
        ok: false,
        retainedPaths: [isolated ? quarantinePath : receipt.file],
      };
    }
  };

  const rollbackImmutableFile = async (
    receipt: LauncherMutationReceipt,
    maxBytes: number,
  ): Promise<MutationOutcome> => {
    const publishedRemoval = await removePublishedEntry(receipt, maxBytes);
    if (!receipt.quarantinePath) return publishedRemoval;
    if (!receipt.previous) {
      return {
        ok: false,
        retainedPaths: [...new Set([...publishedRemoval.retainedPaths, receipt.quarantinePath])],
      };
    }
    const quarantined = await readSnapshotAtPath(
      receipt.quarantinePath,
      maxBytes,
    );
    if (
      !quarantined ||
      quarantined === "missing" ||
      !sameSnapshot(quarantined, receipt.previous)
    ) {
      return {
        ok: false,
        retainedPaths: [...new Set([...publishedRemoval.retainedPaths, receipt.quarantinePath])],
      };
    }
    const restored = await restoreEntryNoClobber(receipt.quarantinePath, receipt.file);
    if (restored) receipt.quarantinePath = null;
    return {
      ok: publishedRemoval.ok && restored,
      retainedPaths: [
        ...new Set([
          ...publishedRemoval.retainedPaths,
          ...(restored || !receipt.quarantinePath ? [] : [receipt.quarantinePath]),
        ]),
      ],
    };
  };

  const rollbackLauncher = (receipt: LauncherMutationReceipt): Promise<MutationOutcome> =>
    rollbackImmutableFile(receipt, MAX_LAUNCHER_BYTES);

  const rollbackProfile = (receipt: ProfileMutationReceipt): Promise<MutationOutcome> =>
    rollbackImmutableFile(receipt, MAX_PROFILE_BYTES);

  const commitImmutableFile = async (
    receipt: LauncherMutationReceipt,
    maxBytes: number,
  ): Promise<{ ok: boolean; recoveryPath?: string }> => {
    if (!receipt.quarantinePath || !receipt.previous) return { ok: true };
    const originalQuarantinePath = receipt.quarantinePath;
    const cleanupPath = `${originalQuarantinePath}.commit-${crypto.randomUUID()}`;
    try {
      await fs.rename(originalQuarantinePath, cleanupPath);
      receipt.quarantinePath = cleanupPath;
      const moved = await readSnapshotAtPath(cleanupPath, maxBytes);
      if (!moved || moved === "missing" || !sameSnapshot(moved, receipt.previous)) {
        const restored = await restoreEntryNoClobber(cleanupPath, originalQuarantinePath);
        if (restored) receipt.quarantinePath = originalQuarantinePath;
        return {
          ok: false,
          recoveryPath: restored ? originalQuarantinePath : cleanupPath,
        };
      }
      await options.testHooks?.beforeQuarantineCleanup?.(cleanupPath);
      await fs.unlink(cleanupPath);
      receipt.quarantinePath = null;
      return { ok: true };
    } catch {
      return {
        ok: false,
        recoveryPath: receipt.quarantinePath ?? originalQuarantinePath,
      };
    }
  };

  const commitLauncher = (
    receipt: LauncherMutationReceipt,
  ): Promise<{ ok: boolean; recoveryPath?: string }> =>
    commitImmutableFile(receipt, MAX_LAUNCHER_BYTES);

  const commitProfile = (
    receipt: ProfileMutationReceipt,
  ): Promise<{ ok: boolean; recoveryPath?: string }> =>
    commitImmutableFile(receipt, MAX_PROFILE_BYTES);

  const immutableFileIsPublished = async (
    receipt: LauncherMutationReceipt,
    maxBytes: number,
  ): Promise<boolean> => {
    if (!receipt.published) return false;
    const current = await readSnapshotAtPath(receipt.file, maxBytes);
    return !!current && current !== "missing" && sameSnapshot(current, receipt.published);
  };

  const launcherIsPublished = (receipt: LauncherMutationReceipt): Promise<boolean> =>
    immutableFileIsPublished(receipt, MAX_LAUNCHER_BYTES);

  const profileIsPublished = (receipt: ProfileMutationReceipt): Promise<boolean> =>
    immutableFileIsPublished(receipt, MAX_PROFILE_BYTES);

  const performInstall = async (plan?: InstallPlan): Promise<DesktopCliInstallResult> => {
    if (!plan || !validPlans.has(plan)) {
      const state = plan?.state ?? (await getState());
      return {
        ok: false,
        error: "安装前需要重新确认当前状态。",
        state: {
          ...state,
          errorCode: "CONFIRMATION_REQUIRED",
          message: "安装前需要重新确认当前状态。",
          retryable: isConfirmableStatus(state.status),
        },
      };
    }
    validPlans.delete(plan);
    const initial = plan.state;
    if (!isConfirmableStatus(initial.status)) {
      return { ok: false, error: initial.message ?? "当前无法安装 CLI", state: initial };
    }

    const lockPath = path.join(binDir, ".littlestart-cli-install.lock");
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      await fs.mkdir(binDir, { recursive: true, mode: 0o755 });
      releaseLock = await acquireInstallLock(lockPath, options.testHooks);
    } catch (error) {
      const busy = error instanceof Error && error.message === "INSTALL_BUSY";
      const state: DesktopCliInstallState = {
        ...baseState("error"),
        bundledVersion: initial.bundledVersion,
        installedVersion: initial.installedVersion,
        pathConfigured: initial.pathConfigured,
        errorCode: busy ? "INSTALL_BUSY" : "VERIFY_FAILED",
        message: busy
          ? "另一个 CLI 安装正在进行，请稍后重试。"
          : "无法准备 CLI 安装目录，请检查当前用户的文件权限。",
        retryable: true,
      };
      return { ok: false, error: state.message ?? "CLI 安装失败", state };
    }

    try {
      const before = await getState();
      const beforeFingerprint = await fingerprintState(before);
      if (!isConfirmableStatus(before.status) || beforeFingerprint !== plan.fingerprint) {
        const changed = isConfirmableStatus(before.status);
        const state: DesktopCliInstallState = changed
          ? {
              ...before,
              errorCode: "INSTALL_STATE_CHANGED",
              message: "CLI 安装状态已变化，请检查后重新确认。",
              retryable: true,
            }
          : before;
        return { ok: false, error: state.message ?? "当前无法安装 CLI", state };
      }

      const bundledVersion = before.bundledVersion ?? (await readBundledVersion());
      const expectedContent = launcherContent(bundledVersion);
      const managedPathPlan = await planManagedPath(profilePath, binDir, options.pathEnv);
      if ((await fingerprintState(before)) !== plan.fingerprint) {
        const state: DesktopCliInstallState = {
          ...before,
          errorCode: "INSTALL_STATE_CHANGED",
          message: "CLI 安装状态已变化，请检查后重新确认。",
          retryable: true,
        };
        return { ok: false, error: state.message ?? "CLI 安装状态已变化", state };
      }
      installingState = {
        ...baseState("installing"),
        bundledVersion,
        installedVersion: before.installedVersion,
        pathConfigured: before.pathConfigured,
        message: "正在写入启动器并验证运行环境…",
        retryable: false,
      };

      let primaryBackup: LauncherBackup = null;
      let aliasBackup: LauncherBackup = null;
      let aliasWritable = true;
      const launcherReceipts: LauncherMutationReceipt[] = [];
      let profileMutation: ProfileMutationReceipt | undefined;

      try {
        // Back up both targets before the first write. If a foreign command
        // appears between the state check and here, fail without touching it.
        primaryBackup = await backup(installPath);
        try {
          aliasBackup = await backup(aliasPath);
        } catch (error) {
          if (error instanceof Error && error.message === "EXISTING_COMMAND_CONFLICT") {
            aliasWritable = false;
          } else {
            throw error;
          }
        }

        const primaryReceipt: LauncherMutationReceipt = {
          file: installPath,
          previous: primaryBackup,
          quarantinePath: null,
          published: null,
        };
        launcherReceipts.push(primaryReceipt);
        await publishLauncher(primaryReceipt, expectedContent);
        if (aliasWritable) {
          const aliasReceipt: LauncherMutationReceipt = {
            file: aliasPath,
            previous: aliasBackup,
            quarantinePath: null,
            published: null,
          };
          launcherReceipts.push(aliasReceipt);
          await publishLauncher(aliasReceipt, expectedContent);
        }

        const { stdout } = await runExecutable(options.appExecutable, [
          cliEntry,
          "version",
          "--json",
        ], {
          cwd: options.homeDir,
          timeoutMs: VERIFY_TIMEOUT_MS,
          env: {
            ...process.env,
            ELECTRON_RUN_AS_NODE: "1",
            NODE_PATH: nodeModulesPath,
            REMOTION_BINARIES_DIR: compositorPath,
            REMOTION_BROWSER_EXECUTABLE: browserPath,
          },
        });
        if (!parseVersionOutput(stdout, bundledVersion)) throw new Error("VERIFY_FAILED");
        if (!(await Promise.all(launcherReceipts.map(launcherIsPublished))).every(Boolean)) {
          throw new Error("EXISTING_COMMAND_CONFLICT");
        }

        if (managedPathPlan.needsPublish) {
          if (!profilePath) throw new Error("VERIFY_FAILED");
          profileMutation = {
            file: profilePath,
            previous: managedPathPlan.previous,
            quarantinePath: null,
            published: null,
          };
          await publishProfile(
            profileMutation,
            managedPathPlan.content,
            managedPathPlan.mode,
          );
          if (!(await profileIsPublished(profileMutation))) {
            throw new Error("EXISTING_COMMAND_CONFLICT");
          }
        }
        await options.testHooks?.beforeFinalStateCheck?.();
        installingState = null;
        const installed = await getState();
        if (installed.status !== "installed") throw new Error("EXISTING_COMMAND_CONFLICT");
        if (!(await Promise.all(launcherReceipts.map(launcherIsPublished))).every(Boolean)) {
          throw new Error("EXISTING_COMMAND_CONFLICT");
        }
        if (profileMutation && !(await profileIsPublished(profileMutation))) {
          throw new Error("EXISTING_COMMAND_CONFLICT");
        }
        const commitResults = await Promise.all([
          ...launcherReceipts.map(commitLauncher),
          ...(profileMutation ? [commitProfile(profileMutation)] : []),
        ]);
        const recoveryPaths = commitResults
          .filter((result) => !result.ok && result.recoveryPath)
          .map((result) => result.recoveryPath as string);
        const messages = [managedPathPlan.warning ?? installed.message];
        if (recoveryPaths.length > 0) {
          messages.push(
            `未能确认旧文件恢复副本的清理状态，请检查：${recoveryPaths.join("、")}。`,
          );
        }
        const state = { ...installed, message: messages.filter(Boolean).join(" ") };
        return { ok: true, state };
      } catch (error) {
        const rollbackResults: Array<{ file: string; outcome: MutationOutcome }> = [];
        if (profileMutation) {
          rollbackResults.push({
            file: profileMutation.file,
            outcome: await rollbackProfile(profileMutation),
          });
        }
        for (const receipt of [...launcherReceipts].reverse()) {
          rollbackResults.push({
            file: receipt.file,
            outcome: await rollbackLauncher(receipt),
          });
        }
        installingState = null;
        const rollbackFailedPaths = rollbackResults
          .filter((result) => !result.outcome.ok)
          .map((result) => result.file);
        const retainedPaths = [
          ...new Set(rollbackResults.flatMap((result) => result.outcome.retainedPaths)),
        ];
        const rollbackFailed = rollbackFailedPaths.length > 0;
        const conflict = error instanceof Error && error.message === "EXISTING_COMMAND_CONFLICT";
        const state: DesktopCliInstallState = {
          ...baseState(conflict ? "conflict" : "error"),
          bundledVersion,
          installedVersion: before.installedVersion,
          pathConfigured: before.pathConfigured,
          errorCode: rollbackFailed
            ? "ROLLBACK_FAILED"
            : conflict
              ? "EXISTING_COMMAND_CONFLICT"
              : "VERIFY_FAILED",
          message: rollbackFailed
            ? `CLI 自检失败，且无法安全恢复 ${rollbackFailedPaths.join("、")}。安装器没有覆盖后来出现的文件，请手动检查${retainedPaths.length > 0 ? `：${retainedPaths.join("、")}` : ""}。`
            : conflict
              ? "检测到同名命令在安装期间发生变化，未进行覆盖。"
              : "CLI 自检失败，已撤销本次安装。请重试或更新桌面版。",
          retryable: !conflict && !rollbackFailed,
        };
        return { ok: false, error: state.message ?? "CLI 安装失败", state };
      }
    } finally {
      installingState = null;
      await releaseLock?.();
    }
  };

  const install = (plan?: InstallPlan): Promise<DesktopCliInstallResult> => {
    if (installInFlight) return installInFlight;
    installInFlight = performInstall(plan).finally(() => {
      installInFlight = null;
      installingState = null;
    });
    return installInFlight;
  };

  return { getState, prepareInstall, install };
}
