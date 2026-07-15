import { execFile } from "node:child_process";
import crypto from "node:crypto";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
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
  options: { cwd: string; timeoutMs: number },
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
};

type LauncherInspection =
  | { kind: "missing" }
  | { kind: "current"; content: string; mode: number; version: string | null }
  | { kind: "managed-stale"; content: string; mode: number; version: string | null }
  | { kind: "conflict" };

type LauncherBackup = {
  content: string;
  mode: number;
  device: number;
  inode: number;
  size: number;
  modifiedMs: number;
} | null;

const MAX_PROFILE_BYTES = 1024 * 1024;
const VERIFY_TIMEOUT_MS = 60_000;

function runExecutableDefault(
  executable: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      [...args],
      {
        cwd: options.cwd,
        encoding: "utf8",
        env: process.env,
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

async function isRegularFile(file: string): Promise<boolean> {
  try {
    return (await fs.lstat(file)).isFile();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function atomicWrite(
  file: string,
  content: string,
  mode: number,
  options: { exclusive?: boolean } = {},
): Promise<void> {
  const temporary = path.join(
    path.dirname(file),
    `.${path.basename(file)}.littlestart-${process.pid}-${crypto.randomUUID()}.tmp`,
  );
  try {
    await fs.writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode });
    await fs.chmod(temporary, mode);
    if (options.exclusive) await fs.link(temporary, file);
    else await fs.rename(temporary, file);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

async function acquireInstallLock(lockPath: string): Promise<() => Promise<void>> {
  const token = `${process.pid}:${crypto.randomUUID()}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fs.open(lockPath, "wx", 0o600);
      try {
        await handle.writeFile(`${token}\n`, "utf8");
      } catch (error) {
        await handle.close().catch(() => {});
        await fs.rm(lockPath, { force: true }).catch(() => {});
        throw error;
      }
      await handle.close();
      return async () => {
        try {
          if ((await fs.readFile(lockPath, "utf8")).trim() === token) {
            await fs.rm(lockPath, { force: true });
          }
        } catch {
          // A missing/replaced lock belongs to no active operation here.
        }
      };
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
      try {
        const [stat, content] = await Promise.all([
          fs.lstat(lockPath),
          fs.readFile(lockPath, "utf8"),
        ]);
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          Date.now() - stat.mtimeMs > 10 * 60 * 1000
        ) {
          const unchanged = (await fs.readFile(lockPath, "utf8")) === content;
          if (unchanged) {
            await fs.rm(lockPath);
            continue;
          }
        }
      } catch {
        continue;
      }
      throw new Error("INSTALL_BUSY");
    }
  }
  throw new Error("INSTALL_BUSY");
}

async function readSmallProfile(profilePath: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(profilePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_PROFILE_BYTES) return null;
    return await fs.readFile(profilePath, "utf8");
  } catch (error) {
    if (isMissing(error)) return "";
    return null;
  }
}

function profileBlock(binDir: string): string {
  return `${CLI_PROFILE_START}\nexport PATH=${shellQuote(binDir)}:"$PATH"\n${CLI_PROFILE_END}`;
}

async function profileHasManagedPath(profilePath: string | null, binDir: string): Promise<boolean> {
  if (!profilePath) return false;
  const content = await readSmallProfile(profilePath);
  if (content === null) return false;
  return (
    content.includes(profileBlock(binDir)) ||
    (content.includes("PATH") &&
      (content.includes(binDir) || content.includes("$HOME/.local/bin")))
  );
}

async function ensureManagedPath(
  profilePath: string | null,
  binDir: string,
  pathEnv: string,
): Promise<{ configured: boolean; warning?: string }> {
  if (pathContains(pathEnv, binDir)) return { configured: true };
  if (!profilePath) {
    return {
      configured: false,
      warning: `CLI 已安装；请手动将 ${binDir} 加入 PATH。`,
    };
  }

  const content = await readSmallProfile(profilePath);
  if (content === null) {
    return {
      configured: false,
      warning: `CLI 已安装，但 ${profilePath} 不是可安全修改的普通文件，请手动配置 PATH。`,
    };
  }

  const block = profileBlock(binDir);
  if (content.includes(block)) return { configured: true };
  if (content.includes(CLI_PROFILE_START) || content.includes(CLI_PROFILE_END)) {
    return {
      configured: false,
      warning: `CLI 已安装，但 ${profilePath} 中的 Littlestart 标记不完整，请手动配置 PATH。`,
    };
  }

  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  try {
    await fs.appendFile(profilePath, `${prefix}${block}\n`, { encoding: "utf8", mode: 0o644 });
    return { configured: true };
  } catch {
    return {
      configured: false,
      warning: `CLI 已安装，但无法修改 ${profilePath}；请手动将 ${binDir} 加入 PATH。`,
    };
  }
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
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return { kind: "conflict" };
      const content = await fs.readFile(file, "utf8");
      if (!isManagedLauncher(content)) return { kind: "conflict" };
      const common = { content, mode: stat.mode & 0o777, version: readVersionMarker(content) };
      return withoutLauncherVersion(content) === withoutLauncherVersion(expectedContent) &&
        (stat.mode & 0o100) !== 0
        ? { kind: "current", ...common }
        : { kind: "managed-stale", ...common };
    } catch (error) {
      if (isMissing(error)) return { kind: "missing" };
      throw error;
    }
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

  const backup = async (file: string): Promise<LauncherBackup> => {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("EXISTING_COMMAND_CONFLICT");
      const content = await fs.readFile(file, "utf8");
      if (!isManagedLauncher(content)) throw new Error("EXISTING_COMMAND_CONFLICT");
      return {
        content,
        mode: stat.mode & 0o777,
        device: stat.dev,
        inode: stat.ino,
        size: stat.size,
        modifiedMs: stat.mtimeMs,
      };
    } catch (error) {
      if (isMissing(error)) return null;
      throw error;
    }
  };

  const assertTargetUnchanged = async (file: string, previous: LauncherBackup): Promise<void> => {
    try {
      const stat = await fs.lstat(file);
      if (!previous || !stat.isFile() || stat.isSymbolicLink()) {
        throw new Error("EXISTING_COMMAND_CONFLICT");
      }
      if (
        stat.dev !== previous.device ||
        stat.ino !== previous.inode ||
        stat.size !== previous.size ||
        stat.mtimeMs !== previous.modifiedMs ||
        (await fs.readFile(file, "utf8")) !== previous.content
      ) {
        throw new Error("EXISTING_COMMAND_CONFLICT");
      }
    } catch (error) {
      if (isMissing(error) && previous === null) return;
      throw error;
    }
  };

  const writeLauncher = async (
    file: string,
    content: string,
    previous: LauncherBackup,
  ): Promise<void> => {
    await assertTargetUnchanged(file, previous);
    try {
      await atomicWrite(file, content, 0o755, { exclusive: previous === null });
    } catch (error) {
      if (hasErrorCode(error, "EEXIST")) throw new Error("EXISTING_COMMAND_CONFLICT");
      throw error;
    }
  };

  const restore = async (
    file: string,
    previous: LauncherBackup,
    installedContent: string,
  ): Promise<boolean> => {
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.isSymbolicLink()) return false;
      if ((await fs.readFile(file, "utf8")) !== installedContent) return false;
      if (!previous) await fs.rm(file);
      else await atomicWrite(file, previous.content, previous.mode || 0o755);
      return true;
    } catch {
      return false;
    }
  };

  const performInstall = async (): Promise<DesktopCliInstallResult> => {
    const initial = await getState();
    if (
      initial.status === "unsupported" ||
      initial.status === "conflict" ||
      (initial.status === "error" && initial.retryable === false)
    ) {
      return { ok: false, error: initial.message ?? "当前无法安装 CLI", state: initial };
    }

    const lockPath = path.join(binDir, ".littlestart-cli-install.lock");
    let releaseLock: (() => Promise<void>) | null = null;
    try {
      await fs.mkdir(binDir, { recursive: true, mode: 0o755 });
      releaseLock = await acquireInstallLock(lockPath);
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
      if (
        before.status === "unsupported" ||
        before.status === "conflict" ||
        (before.status === "error" && before.retryable === false)
      ) {
        return { ok: false, error: before.message ?? "当前无法安装 CLI", state: before };
      }

      const bundledVersion = before.bundledVersion ?? (await readBundledVersion());
      const expectedContent = launcherContent(bundledVersion);
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
      let primaryWritten = false;
      let aliasWritten = false;
      let aliasWritable = true;

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

        await writeLauncher(installPath, expectedContent, primaryBackup);
        primaryWritten = true;
        if (aliasWritable) {
          try {
            await writeLauncher(aliasPath, expectedContent, aliasBackup);
            aliasWritten = true;
          } catch (error) {
            if (!(error instanceof Error && error.message === "EXISTING_COMMAND_CONFLICT")) {
              throw error;
            }
            // The legacy alias is optional. Preserve a command that appeared
            // during installation and continue with the canonical name.
          }
        }

        const { stdout } = await runExecutable(installPath, ["version", "--json"], {
          cwd: options.homeDir,
          timeoutMs: VERIFY_TIMEOUT_MS,
        });
        if (!parseVersionOutput(stdout, bundledVersion)) throw new Error("VERIFY_FAILED");

        const pathResult = await ensureManagedPath(profilePath, binDir, options.pathEnv);
        installingState = null;
        const installed = await getState();
        const state = pathResult.warning ? { ...installed, message: pathResult.warning } : installed;
        return { ok: true, state };
      } catch (error) {
        const rollbackResults = await Promise.all([
          primaryWritten ? restore(installPath, primaryBackup, expectedContent) : true,
          aliasWritten ? restore(aliasPath, aliasBackup, expectedContent) : true,
        ]);
        installingState = null;
        const rollbackFailedPaths = [installPath, aliasPath].filter(
          (_file, index) => !rollbackResults[index],
        );
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
            ? `CLI 自检失败，且无法安全恢复 ${rollbackFailedPaths.join("、")}。安装器没有覆盖后来出现的文件，请手动检查。`
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

  const install = (): Promise<DesktopCliInstallResult> => {
    if (installInFlight) return installInFlight;
    installInFlight = performInstall().finally(() => {
      installInFlight = null;
      installingState = null;
    });
    return installInFlight;
  };

  return { getState, install };
}
