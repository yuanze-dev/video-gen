import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLI_LAUNCHER_MARKER,
  CLI_PROFILE_START,
  createDesktopCliInstaller,
} from "../electron/cli-installer.ts";

const VERSION = "0.1.0";

function versionOutput(version = VERSION): string {
  return JSON.stringify({
    protocolVersion: "1",
    ok: true,
    command: "version",
    result: { version, packaged: true },
  });
}

function execute(file: string, args: string[] = []): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { encoding: "utf8" }, (error, stdout, stderr) => {
      if (error) reject(error);
      else resolve({ stdout, stderr });
    });
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    return !!error && typeof error === "object" && "code" in error && error.code !== "ENOENT";
  }
}

async function fixture(
  t: Parameters<typeof test>[1] extends (t: infer T) => unknown ? T : never,
  overrides: Partial<Parameters<typeof createDesktopCliInstaller>[0]> & { validCli?: boolean } = {},
) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-cli-install-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home user's files");
  const resourcesPath = path.join(root, "App Resources");
  const cliRoot = path.join(resourcesPath, "cli package's files");
  await fs.mkdir(path.join(cliRoot, "dist"), { recursive: true });
  await fs.mkdir(path.join(cliRoot, "runtime"), { recursive: true });
  await fs.mkdir(homeDir, { recursive: true });
  await fs.writeFile(
    path.join(cliRoot, "package.json"),
    `${JSON.stringify({ name: "@yuanze/littlestart-cli", version: VERSION })}\n`,
  );
  await fs.writeFile(path.join(cliRoot, "runtime", "runtime.json"), "{}\n");
  await fs.writeFile(
    path.join(cliRoot, "dist", "littlestart.cjs"),
    overrides.validCli === false
      ? "process.stdout.write(JSON.stringify({ok:false})); process.exitCode = 1;\n"
      : `process.stdout.write(${JSON.stringify(versionOutput())});\n`,
    { mode: 0o755 },
  );

  const options = {
    supported: true,
    homeDir,
    shellPath: "/bin/zsh",
    pathEnv: "/usr/bin:/bin",
    appExecutable: process.execPath,
    resourcesPath,
    cliRoot,
    ...overrides,
  };
  delete (options as { validCli?: boolean }).validCli;
  const installer = createDesktopCliInstaller(options);
  return {
    root,
    homeDir,
    resourcesPath,
    cliRoot,
    installer,
    installPath: path.join(homeDir, ".local", "bin", "littlestart"),
    aliasPath: path.join(homeDir, ".local", "bin", "video-gen"),
    profilePath: path.join(homeDir, ".zprofile"),
  };
}

test("installs executable launchers, verifies them, and configures PATH idempotently", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await ctx.installer.getState()).status, "not-installed");

  const first = await ctx.installer.install();
  assert.equal(first.ok, true);
  assert.equal(first.state.status, "installed");
  assert.equal(first.state.installedVersion, VERSION);
  assert.equal(first.state.pathConfigured, true);

  for (const launcher of [ctx.installPath, ctx.aliasPath]) {
    const stat = await fs.stat(launcher);
    assert.equal(stat.mode & 0o777, 0o755);
    const content = await fs.readFile(launcher, "utf8");
    assert.match(content, new RegExp(CLI_LAUNCHER_MARKER.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    const executed = JSON.parse((await execute(launcher, ["version", "--json"])).stdout);
    assert.equal(executed.result.version, VERSION);
  }

  const second = await ctx.installer.install();
  assert.equal(second.ok, true);
  const profile = await fs.readFile(ctx.profilePath, "utf8");
  assert.equal(profile.split(CLI_PROFILE_START).length - 1, 1);
});

test("does not touch a shell profile when the install directory is already on PATH", async (t) => {
  const ctx = await fixture(t);
  const binDir = path.dirname(ctx.installPath);
  const installer = createDesktopCliInstaller({
    supported: true,
    homeDir: ctx.homeDir,
    shellPath: "/bin/zsh",
    pathEnv: `/usr/bin:${binDir}:/bin`,
    appExecutable: process.execPath,
    resourcesPath: ctx.resourcesPath,
    cliRoot: ctx.cliRoot,
  });

  const result = await installer.install();
  assert.equal(result.ok, true);
  assert.equal(result.state.pathConfigured, true);
  assert.equal(await exists(ctx.profilePath), false);
});

test("refuses to overwrite a foreign command", async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(path.dirname(ctx.installPath), { recursive: true });
  await fs.writeFile(ctx.installPath, "#!/bin/sh\necho user-command\n", { mode: 0o755 });

  const state = await ctx.installer.getState();
  assert.equal(state.status, "conflict");
  assert.equal(state.errorCode, "EXISTING_COMMAND_CONFLICT");
  const result = await ctx.installer.install();
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), "#!/bin/sh\necho user-command\n");
  assert.equal(await exists(ctx.aliasPath), false);
});

test("preserves a foreign video-gen alias while installing the canonical command", async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(path.dirname(ctx.aliasPath), { recursive: true });
  await fs.writeFile(ctx.aliasPath, "#!/bin/sh\necho existing-video-gen\n", { mode: 0o755 });

  const result = await ctx.installer.install();
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "installed");
  assert.match(result.state.message ?? "", /video-gen 命令已保留/);
  assert.equal(await fs.readFile(ctx.aliasPath, "utf8"), "#!/bin/sh\necho existing-video-gen\n");
  assert.equal(JSON.parse((await execute(ctx.installPath, ["version", "--json"])).stdout).ok, true);
});

test("repairs a stale managed launcher", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await ctx.installer.install()).ok, true);
  const previousVersionMarker = (await fs.readFile(ctx.installPath, "utf8")).replace(
    "# littlestart-cli-version:0.1.0",
    "# littlestart-cli-version:0.0.9",
  );
  await fs.writeFile(ctx.installPath, previousVersionMarker, { mode: 0o755 });
  assert.equal((await ctx.installer.getState()).status, "installed");

  const stale = previousVersionMarker.replace(
    "export NODE_PATH=",
    "export NODE_PATH='/moved-app/node_modules' # was ",
  );
  await fs.writeFile(ctx.installPath, stale, { mode: 0o755 });

  const before = await ctx.installer.getState();
  assert.equal(before.status, "repair-needed");
  assert.equal(before.installedVersion, "0.0.9");
  const repaired = await ctx.installer.install();
  assert.equal(repaired.ok, true);
  assert.equal(repaired.state.status, "installed");
  assert.match(await fs.readFile(ctx.installPath, "utf8"), /littlestart-cli-version:0\.1\.0/);
});

test("repairs a managed launcher that lost its executable bit", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await ctx.installer.install()).ok, true);
  await fs.chmod(ctx.installPath, 0o644);
  assert.equal((await ctx.installer.getState()).status, "repair-needed");
  assert.equal((await ctx.installer.install()).ok, true);
  assert.equal((await fs.stat(ctx.installPath)).mode & 0o777, 0o755);
});

test("rolls back both launchers when the installed CLI fails verification", async (t) => {
  const ctx = await fixture(t, { validCli: false });
  const result = await ctx.installer.install();
  assert.equal(result.ok, false);
  assert.equal(result.state.status, "error");
  assert.equal(result.state.errorCode, "VERIFY_FAILED");
  assert.equal(await exists(ctx.installPath), false);
  assert.equal(await exists(ctx.aliasPath), false);
  assert.equal(await exists(ctx.profilePath), false);
});

test("leaves an unsafe profile symlink untouched and reports the manual PATH step", async (t) => {
  const ctx = await fixture(t);
  const target = path.join(ctx.root, "real-profile");
  await fs.writeFile(target, "# user profile\n");
  await fs.symlink(target, ctx.profilePath);

  const result = await ctx.installer.install();
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "installed");
  assert.equal(result.state.pathConfigured, false);
  assert.match(result.state.message ?? "", /手动配置 PATH/);
  assert.equal(await fs.readFile(target, "utf8"), "# user profile\n");
});

test("uses an existing Bash login profile instead of shadowing it", async (t) => {
  const ctx = await fixture(t);
  const existingProfile = path.join(ctx.homeDir, ".profile");
  await fs.writeFile(existingProfile, "# existing bash profile\n");
  const installer = createDesktopCliInstaller({
    supported: true,
    homeDir: ctx.homeDir,
    shellPath: "/bin/bash",
    pathEnv: "/usr/bin:/bin",
    appExecutable: process.execPath,
    resourcesPath: ctx.resourcesPath,
    cliRoot: ctx.cliRoot,
  });

  const result = await installer.install();
  assert.equal(result.ok, true);
  assert.match(await fs.readFile(existingProfile, "utf8"), new RegExp(CLI_PROFILE_START));
  assert.equal(await exists(path.join(ctx.homeDir, ".bash_profile")), false);
});

test("rejects unsupported and transient DMG locations without writing files", async (t) => {
  const unsupported = await fixture(t, { supported: false });
  assert.equal((await unsupported.installer.getState()).status, "unsupported");
  assert.equal((await unsupported.installer.install()).ok, false);
  assert.equal(await exists(unsupported.installPath), false);

  const fromDmg = await fixture(t, {
    appExecutable: "/Volumes/Littlestart/小音符起号助手.app/Contents/MacOS/小音符起号助手",
  });
  const state = await fromDmg.installer.getState();
  assert.equal(state.status, "error");
  assert.equal(state.errorCode, "APP_NOT_STABLE");
  assert.equal((await fromDmg.installer.install()).ok, false);
  assert.equal(await exists(fromDmg.installPath), false);

  const translocated = await fixture(t, {
    appExecutable:
      "/private/var/folders/ab/cd/T/AppTranslocation/ABC/d/小音符起号助手.app/Contents/MacOS/小音符起号助手",
  });
  const translocatedState = await translocated.installer.getState();
  assert.equal(translocatedState.errorCode, "APP_NOT_STABLE");
  assert.equal((await translocated.installer.install()).ok, false);
  assert.equal(await exists(translocated.installPath), false);
});

test("never removes a file that replaces the launcher during failed verification", async (t) => {
  const foreign = "#!/bin/sh\necho replaced-during-verification\n";
  const ctx = await fixture(t, {
    runExecutable: async (launcher) => {
      await fs.writeFile(launcher, foreign, { mode: 0o755 });
      throw new Error("verification failed");
    },
  });

  const result = await ctx.installer.install();
  assert.equal(result.ok, false);
  assert.equal(result.state.errorCode, "ROLLBACK_FAILED");
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("deduplicates rapid repeated install requests", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let runs = 0;
  const ctx = await fixture(t, {
    runExecutable: async () => {
      runs += 1;
      await gate;
      return { stdout: versionOutput(), stderr: "" };
    },
  });

  const first = ctx.installer.install();
  const second = ctx.installer.install();
  assert.equal(first, second);
  while (runs === 0) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(runs, 1);
  assert.equal((await ctx.installer.getState()).status, "installing");
  release();
  assert.equal((await first).ok, true);
  assert.equal((await second).ok, true);
  assert.equal(runs, 1);
});

test("serializes installers from separate desktop processes with a user-level lock", async (t) => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let verifying = false;
  const ctx = await fixture(t, {
    runExecutable: async () => {
      verifying = true;
      await gate;
      return { stdout: versionOutput(), stderr: "" };
    },
  });
  const second = createDesktopCliInstaller({
    supported: true,
    homeDir: ctx.homeDir,
    shellPath: "/bin/zsh",
    pathEnv: "/usr/bin:/bin",
    appExecutable: process.execPath,
    resourcesPath: ctx.resourcesPath,
    cliRoot: ctx.cliRoot,
  });

  const firstInstall = ctx.installer.install();
  while (!verifying) await new Promise((resolve) => setImmediate(resolve));
  const competing = await second.install();
  assert.equal(competing.ok, false);
  assert.equal(competing.state.errorCode, "INSTALL_BUSY");
  release();
  assert.equal((await firstInstall).ok, true);
});
