import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
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
  t: TestContext,
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

type Installer = ReturnType<typeof createDesktopCliInstaller>;

async function installConfirmed(installer: Installer) {
  const plan = await installer.prepareInstall();
  return installer.install(plan);
}

test("installs executable launchers, verifies them, and configures PATH idempotently", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await ctx.installer.getState()).status, "not-installed");

  const first = await installConfirmed(ctx.installer);
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

  const second = await installConfirmed(ctx.installer);
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

  const result = await installConfirmed(installer);
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
  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), "#!/bin/sh\necho user-command\n");
  assert.equal(await exists(ctx.aliasPath), false);
});

test("requires a prepared confirmation plan and rejects non-confirmable states", async (t) => {
  const ctx = await fixture(t);
  const unconfirmed = await ctx.installer.install();
  assert.equal(unconfirmed.ok, false);
  assert.equal(unconfirmed.state.errorCode, "CONFIRMATION_REQUIRED");
  assert.equal(await exists(ctx.installPath), false);

  await fs.mkdir(path.dirname(ctx.installPath), { recursive: true });
  const foreign = "#!/bin/sh\necho foreign\n";
  await fs.writeFile(ctx.installPath, foreign, { mode: 0o755 });
  const plan = await ctx.installer.prepareInstall();
  assert.equal(plan.state.status, "conflict");
  const blocked = await ctx.installer.install(plan);
  assert.equal(blocked.ok, false);
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
});

test("fails safely when the confirmed state changes before the lock is acquired", async (t) => {
  const ctx = await fixture(t);
  const plan = await ctx.installer.prepareInstall();
  const foreign = "#!/bin/sh\necho arrived-after-confirmation\n";
  await fs.mkdir(path.dirname(ctx.installPath), { recursive: true });
  await fs.writeFile(ctx.installPath, foreign, { mode: 0o755 });

  const result = await ctx.installer.install(plan);
  assert.equal(result.ok, false);
  assert.equal(result.state.status, "conflict");
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("uses no-clobber semantics when a foreign command appears immediately before write", async (t) => {
  let armed = false;
  const foreign = "#!/bin/sh\necho won-write-race\n";
  const ctx = await fixture(t, {
    testHooks: {
      beforeLauncherWrite: async (file) => {
        if (armed && file.endsWith("/littlestart")) {
          await fs.writeFile(file, foreign, { mode: 0o755 });
        }
      },
    },
  });
  const plan = await ctx.installer.prepareInstall();
  armed = true;

  const result = await ctx.installer.install(plan);
  assert.equal(result.ok, false);
  assert.equal(result.state.errorCode, "EXISTING_COMMAND_CONFLICT");
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("rolls back from a receipt when failure happens immediately after publish", async (t) => {
  const ctx = await fixture(t, {
    testHooks: {
      afterLauncherPublish: async (file) => {
        if (file.endsWith("/littlestart")) throw new Error("post-publish failure");
      },
    },
  });

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.equal(await exists(ctx.installPath), false);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("leaves a foreign launcher directory at the command path", async (t) => {
  let installPath = "";
  const ctx = await fixture(t, {
    testHooks: {
      afterLauncherPublish: async (file) => {
        if (file !== installPath) return;
        await fs.rename(file, `${file}.published-by-installer`);
        await fs.mkdir(file);
        await fs.writeFile(path.join(file, "foreign.txt"), "foreign directory content\n");
      },
    },
  });
  installPath = ctx.installPath;

  const result = await installConfirmed(ctx.installer);

  assert.equal(result.ok, false);
  assert.equal(result.state.errorCode, "ROLLBACK_FAILED");
  assert.equal((await fs.lstat(ctx.installPath)).isDirectory(), true);
  assert.equal(
    await fs.readFile(path.join(ctx.installPath, "foreign.txt"), "utf8"),
    "foreign directory content\n",
  );
  assert.match(result.state.message ?? "", new RegExp(ctx.installPath.replaceAll("/", "\\/")));
  assert.equal(await exists(`${ctx.installPath}.published-by-installer`), true);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("never modifies the quarantined managed inode and restores it after verification failure", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await installConfirmed(ctx.installer)).ok, true);
  const stale = (await fs.readFile(ctx.installPath, "utf8")).replace(
    "export NODE_PATH=",
    "export NODE_PATH='/old-app' # ",
  );
  await fs.writeFile(ctx.installPath, stale, { mode: 0o755 });
  const oldInodeLink = `${ctx.installPath}.old-inode`;
  await fs.link(ctx.installPath, oldInodeLink);

  const repairing = createDesktopCliInstaller({
    supported: true,
    homeDir: ctx.homeDir,
    shellPath: "/bin/zsh",
    pathEnv: "/usr/bin:/bin",
    appExecutable: process.execPath,
    resourcesPath: ctx.resourcesPath,
    cliRoot: ctx.cliRoot,
    runExecutable: async () => {
      throw new Error("verification failed");
    },
  });
  const result = await installConfirmed(repairing);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(oldInodeLink, "utf8"), stale);
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), stale);
  assert.equal((await fs.stat(oldInodeLink)).ino, (await fs.stat(ctx.installPath)).ino);
});

test("an alias race fails the whole transaction instead of leaving the primary installed", async (t) => {
  const foreignAlias = "#!/bin/sh\necho alias-race\n";
  const ctx = await fixture(t, {
    testHooks: {
      beforeLauncherWrite: async (file) => {
        if (file.endsWith("/video-gen")) {
          await fs.writeFile(file, foreignAlias, { mode: 0o755 });
        }
      },
    },
  });

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.equal(await exists(ctx.installPath), false);
  assert.equal(await fs.readFile(ctx.aliasPath, "utf8"), foreignAlias);
});

test("does not overwrite a foreign replacement while repairing a managed launcher", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await installConfirmed(ctx.installer)).ok, true);
  const stale = (await fs.readFile(ctx.installPath, "utf8")).replace(
    "export NODE_PATH=",
    "export NODE_PATH='/old-app' # ",
  );
  await fs.writeFile(ctx.installPath, stale, { mode: 0o755 });

  const foreign = "#!/bin/sh\necho replaced-managed-launcher\n";
  let armed = false;
  const repairing = createDesktopCliInstaller({
    supported: true,
    homeDir: ctx.homeDir,
    shellPath: "/bin/zsh",
    pathEnv: "/usr/bin:/bin",
    appExecutable: process.execPath,
    resourcesPath: ctx.resourcesPath,
    cliRoot: ctx.cliRoot,
    testHooks: {
      beforeLauncherWrite: async (file) => {
        if (!armed || file !== ctx.installPath) return;
        await fs.rename(file, `${file}.previous-managed`);
        await fs.writeFile(file, foreign, { mode: 0o755 });
      },
    },
  });
  const plan = await repairing.prepareInstall();
  armed = true;
  const result = await repairing.install(plan);
  assert.equal(result.ok, false);
  assert.equal(result.state.errorCode, "EXISTING_COMMAND_CONFLICT");
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
});

test("preserves a foreign video-gen alias while installing the canonical command", async (t) => {
  const ctx = await fixture(t);
  await fs.mkdir(path.dirname(ctx.aliasPath), { recursive: true });
  await fs.writeFile(ctx.aliasPath, "#!/bin/sh\necho existing-video-gen\n", { mode: 0o755 });

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "installed");
  assert.match(result.state.message ?? "", /video-gen 命令已保留/);
  assert.equal(await fs.readFile(ctx.aliasPath, "utf8"), "#!/bin/sh\necho existing-video-gen\n");
  assert.equal(JSON.parse((await execute(ctx.installPath, ["version", "--json"])).stdout).ok, true);
});

test("repairs a stale managed launcher", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await installConfirmed(ctx.installer)).ok, true);
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
  const repaired = await installConfirmed(ctx.installer);
  assert.equal(repaired.ok, true);
  assert.equal(repaired.state.status, "installed");
  assert.match(await fs.readFile(ctx.installPath, "utf8"), /littlestart-cli-version:0\.1\.0/);
});

test("repairs a managed launcher that lost its executable bit", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await installConfirmed(ctx.installer)).ok, true);
  await fs.chmod(ctx.installPath, 0o644);
  assert.equal((await ctx.installer.getState()).status, "repair-needed");
  assert.equal((await installConfirmed(ctx.installer)).ok, true);
  assert.equal((await fs.stat(ctx.installPath)).mode & 0o777, 0o755);
});

test("rolls back both launchers when the installed CLI fails verification", async (t) => {
  const ctx = await fixture(t, { validCli: false });
  const result = await installConfirmed(ctx.installer);
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

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, true);
  assert.equal(result.state.status, "installed");
  assert.equal(result.state.pathConfigured, false);
  assert.match(result.state.message ?? "", /手动配置 PATH/);
  assert.equal(await fs.readFile(target, "utf8"), "# user profile\n");
});

test("leaves both a moved profile and a swapped-in symlink untouched", async (t) => {
  const target = path.join(os.tmpdir(), `littlestart-profile-target-${crypto.randomUUID()}`);
  await fs.writeFile(target, "# attacker target\n");
  t.after(() => fs.rm(target, { force: true }));
  const original = "# original profile\n";
  let movedProfile = "";
  const ctx = await fixture(t, {
    testHooks: {
      beforeProfilePublish: async (file) => {
        movedProfile = `${file}.moved`;
        await fs.rename(file, movedProfile);
        await fs.symlink(target, file);
      },
    },
  });
  await fs.writeFile(ctx.profilePath, original);

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.notEqual(result.state.status, "installed");
  assert.equal(await fs.readFile(target, "utf8"), "# attacker target\n");
  assert.equal(await fs.readFile(movedProfile, "utf8"), original);
  assert.equal(await fs.readFile(ctx.profilePath, "utf8"), "# attacker target\n");
  assert.equal(await exists(ctx.installPath), false);
});

test("PATH detection trusts only the current PATH or an exact managed block", async (t) => {
  const falsePositive = await fixture(t);
  const binDir = path.dirname(falsePositive.installPath);
  await fs.writeFile(
    falsePositive.profilePath,
    `# PATH example: ${binDir}\necho 'export PATH=$HOME/.local/bin:$PATH'\nPATH_NOTE=${binDir}\n`,
  );
  assert.equal((await falsePositive.installer.getState()).pathConfigured, false);
  const installed = await installConfirmed(falsePositive.installer);
  assert.equal(installed.ok, true);
  assert.equal(installed.state.pathConfigured, true);
  assert.match(await fs.readFile(falsePositive.profilePath, "utf8"), new RegExp(CLI_PROFILE_START));

  const realExport = await fixture(t);
  await fs.writeFile(realExport.profilePath, 'export PATH="$HOME/.local/bin:$PATH"\n');
  assert.equal((await realExport.installer.getState()).pathConfigured, false);
  assert.equal((await installConfirmed(realExport.installer)).ok, true);
  assert.match(await fs.readFile(realExport.profilePath, "utf8"), new RegExp(CLI_PROFILE_START));
});

test("conditional, heredoc, and function exports do not produce a PATH false positive", async (t) => {
  const ctx = await fixture(t);
  await fs.writeFile(
    ctx.profilePath,
    [
      "if false; then",
      '  export PATH="$HOME/.local/bin:$PATH"',
      "fi",
      "cat <<'EXAMPLE'",
      'export PATH="$HOME/.local/bin:$PATH"',
      "EXAMPLE",
      "configure_path() {",
      '  export PATH="$HOME/.local/bin:$PATH"',
      "}",
      "",
    ].join("\n"),
  );
  assert.equal((await ctx.installer.getState()).pathConfigured, false);
  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, true);
  assert.match(await fs.readFile(ctx.profilePath, "utf8"), new RegExp(CLI_PROFILE_START));
});

test("an exact managed block inside disabled shell syntax is not treated as active", async (t) => {
  const ctx = await fixture(t);
  assert.equal((await installConfirmed(ctx.installer)).ok, true);
  const block = await fs.readFile(ctx.profilePath, "utf8");

  await fs.writeFile(ctx.profilePath, `if false; then\n${block}fi\n`);
  assert.equal((await ctx.installer.getState()).pathConfigured, false);

  await fs.writeFile(ctx.profilePath, `cat <<'BLOCK'\n${block}BLOCK\n`);
  assert.equal((await ctx.installer.getState()).pathConfigured, false);
});

test("preserves raw profile bytes, mode, and an existing hardlink sibling", async (t) => {
  const original = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x20, 0x70, 0x72, 0x6f, 0x66, 0x69, 0x6c, 0x65]);
  const ctx = await fixture(t);
  await fs.writeFile(ctx.profilePath, original, { mode: 0o640 });
  const sibling = `${ctx.profilePath}.hardlink-sibling`;
  await fs.link(ctx.profilePath, sibling);
  const originalInode = (await fs.stat(sibling)).ino;

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, true);
  const installed = await fs.readFile(ctx.profilePath);
  assert.equal(installed.subarray(0, original.length).equals(original), true);
  assert.match(installed.toString("utf8"), new RegExp(CLI_PROFILE_START));
  assert.equal((await fs.stat(ctx.profilePath)).mode & 0o777, 0o640);
  assert.equal((await fs.readFile(sibling)).equals(original), true);
  assert.equal((await fs.stat(sibling)).ino, originalInode);
  assert.notEqual((await fs.stat(ctx.profilePath)).ino, originalInode);
});

test("restores the exact old profile inode when failure follows profile publish", async (t) => {
  const original = "# old profile must survive\n";
  const ctx = await fixture(t, {
    testHooks: {
      afterProfilePublish: async () => {
        throw new Error("post-profile-publish failure");
      },
    },
  });
  await fs.writeFile(ctx.profilePath, original);
  const sibling = `${ctx.profilePath}.hardlink-sibling`;
  await fs.link(ctx.profilePath, sibling);
  const originalInode = (await fs.stat(ctx.profilePath)).ino;

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(ctx.profilePath, "utf8"), original);
  assert.equal(await fs.readFile(sibling, "utf8"), original);
  assert.equal((await fs.stat(ctx.profilePath)).ino, originalInode);
  assert.equal(await exists(ctx.installPath), false);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("rolls a newly published missing profile back to missing", async (t) => {
  const ctx = await fixture(t, {
    testHooks: {
      afterProfilePublish: async () => {
        throw new Error("post-profile-publish failure");
      },
    },
  });

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.equal(await exists(ctx.profilePath), false);
  assert.equal(await exists(ctx.installPath), false);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("preserves a foreign profile replacement after publish and never reports installed", async (t) => {
  const original = "# recoverable old profile\n";
  const foreign = "# concurrent foreign profile\n";
  const ctx = await fixture(t, {
    testHooks: {
      afterProfilePublish: async (file) => {
        await fs.rename(file, `${file}.published-by-installer`);
        await fs.writeFile(file, foreign);
      },
    },
  });
  await fs.writeFile(ctx.profilePath, original);

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.notEqual(result.state.status, "installed");
  assert.equal(result.state.errorCode, "ROLLBACK_FAILED");
  assert.equal(await fs.readFile(ctx.profilePath, "utf8"), foreign);
  const recoveries = (await fs.readdir(ctx.homeDir)).filter((entry) =>
    entry.startsWith(".zprofile.littlestart-previous-"),
  );
  assert.equal(recoveries.length, 1);
  assert.equal(await fs.readFile(path.join(ctx.homeDir, recoveries[0] ?? ""), "utf8"), original);
  assert.equal(await exists(ctx.installPath), false);
});

test("leaves a foreign profile directory in place and reports the retained old profile", async (t) => {
  const original = "# old profile recovery copy\n";
  const ctx = await fixture(t, {
    testHooks: {
      afterProfilePublish: async (file) => {
        await fs.rename(file, `${file}.published-by-installer`);
        await fs.mkdir(file);
        await fs.writeFile(path.join(file, "foreign.txt"), "foreign directory content\n");
      },
    },
  });
  await fs.writeFile(ctx.profilePath, original);

  const result = await installConfirmed(ctx.installer);

  assert.equal(result.ok, false);
  assert.equal(result.state.errorCode, "ROLLBACK_FAILED");
  assert.equal((await fs.lstat(ctx.profilePath)).isDirectory(), true);
  assert.equal(
    await fs.readFile(path.join(ctx.profilePath, "foreign.txt"), "utf8"),
    "foreign directory content\n",
  );
  const recoveries = (await fs.readdir(ctx.homeDir)).filter((entry) =>
    entry.startsWith(".zprofile.littlestart-previous-"),
  );
  assert.equal(recoveries.length, 1);
  const recoveryPath = path.join(ctx.homeDir, recoveries[0] ?? "");
  assert.equal(await fs.readFile(recoveryPath, "utf8"), original);
  assert.match(result.state.message ?? "", new RegExp(recoveryPath.replaceAll("/", "\\/")));
  assert.equal(await exists(`${ctx.profilePath}.published-by-installer`), true);
  assert.equal(await exists(ctx.installPath), false);
});

test("reports the actual cleanup path when verified quarantine cleanup fails", async (t) => {
  let retainedPath = "";
  const ctx = await fixture(t, {
    testHooks: {
      beforeQuarantineCleanup: async (file) => {
        if (!path.basename(file).startsWith(".zprofile.littlestart-previous-")) return;
        retainedPath = file;
        throw new Error("simulated cleanup failure");
      },
    },
  });
  const original = "# retained after cleanup failure\n";
  await fs.writeFile(ctx.profilePath, original);

  const result = await installConfirmed(ctx.installer);

  assert.equal(result.ok, true);
  assert.equal(result.state.status, "installed");
  assert.ok(retainedPath);
  assert.equal(await fs.readFile(retainedPath, "utf8"), original);
  assert.match(result.state.message ?? "", new RegExp(retainedPath.replaceAll("/", "\\/")));
  assert.equal(await exists(retainedPath.replace(/\.commit-[^.]+$/, "")), false);
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

  const result = await installConfirmed(installer);
  assert.equal(result.ok, true);
  assert.match(await fs.readFile(existingProfile, "utf8"), new RegExp(CLI_PROFILE_START));
  assert.equal(await exists(path.join(ctx.homeDir, ".bash_profile")), false);
});

test("launcher inspection fails closed for a symlink swap and an oversized command", async (t) => {
  let armed = false;
  let installPath = "";
  let root = "";
  const symlinkRace = await fixture(t, {
    testHooks: {
      beforeLauncherInspect: async (file) => {
        if (!armed || file !== installPath) return;
        const target = path.join(root, "foreign-command");
        await fs.writeFile(target, "#!/bin/sh\necho foreign\n", { mode: 0o755 });
        await fs.symlink(target, file);
        armed = false;
      },
    },
  });
  installPath = symlinkRace.installPath;
  root = symlinkRace.root;
  await fs.mkdir(path.dirname(installPath), { recursive: true });
  armed = true;
  const symlinkState = await symlinkRace.installer.getState();
  assert.equal(symlinkState.status, "conflict");
  assert.equal(symlinkState.errorCode, "EXISTING_COMMAND_CONFLICT");

  const oversized = await fixture(t);
  await fs.mkdir(path.dirname(oversized.installPath), { recursive: true });
  await fs.writeFile(oversized.installPath, Buffer.alloc(300 * 1024, 0x61), { mode: 0o755 });
  const oversizedState = await oversized.installer.getState();
  assert.equal(oversizedState.status, "conflict");
  assert.equal(oversizedState.errorCode, "EXISTING_COMMAND_CONFLICT");
});

test("rejects unsupported and transient DMG locations without writing files", async (t) => {
  const unsupported = await fixture(t, { supported: false });
  assert.equal((await unsupported.installer.getState()).status, "unsupported");
  assert.equal((await installConfirmed(unsupported.installer)).ok, false);
  assert.equal(await exists(unsupported.installPath), false);

  const fromDmg = await fixture(t, {
    appExecutable: "/Volumes/Littlestart/小音符起号助手.app/Contents/MacOS/小音符起号助手",
  });
  const state = await fromDmg.installer.getState();
  assert.equal(state.status, "error");
  assert.equal(state.errorCode, "APP_NOT_STABLE");
  assert.equal((await installConfirmed(fromDmg.installer)).ok, false);
  assert.equal(await exists(fromDmg.installPath), false);

  const translocated = await fixture(t, {
    appExecutable:
      "/private/var/folders/ab/cd/T/AppTranslocation/ABC/d/小音符起号助手.app/Contents/MacOS/小音符起号助手",
  });
  const translocatedState = await translocated.installer.getState();
  assert.equal(translocatedState.errorCode, "APP_NOT_STABLE");
  assert.equal((await installConfirmed(translocated.installer)).ok, false);
  assert.equal(await exists(translocated.installPath), false);
});

test("self-check executes only the controlled app runtime and then detects a swapped launcher", async (t) => {
  const foreign = "#!/bin/sh\necho must-not-execute\n";
  let installPath = "";
  let cliEntry = "";
  let resourcesPath = "";
  let called = false;
  const ctx = await fixture(t, {
    runExecutable: async (executable, args, runOptions) => {
      called = true;
      assert.equal(executable, process.execPath);
      assert.deepEqual(args, [cliEntry, "version", "--json"]);
      assert.equal(runOptions.env.ELECTRON_RUN_AS_NODE, "1");
      assert.equal(
        runOptions.env.NODE_PATH,
        path.join(resourcesPath, "app.asar", "node_modules"),
      );
      await fs.rename(installPath, `${installPath}.published-before-verification`);
      await fs.writeFile(installPath, foreign, { mode: 0o755 });
      return { stdout: versionOutput(), stderr: "" };
    },
  });
  installPath = ctx.installPath;
  cliEntry = path.join(ctx.cliRoot, "dist", "littlestart.cjs");
  resourcesPath = ctx.resourcesPath;

  const result = await installConfirmed(ctx.installer);
  assert.equal(called, true);
  assert.equal(result.ok, false);
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
  assert.equal(await exists(ctx.aliasPath), false);
});

test("never removes a file that replaces the launcher during failed verification", async (t) => {
  const foreign = "#!/bin/sh\necho replaced-during-verification\n";
  const originalProfile = "# original profile\n";
  let installPath = "";
  const ctx = await fixture(t, {
    testHooks: {
      beforeFinalStateCheck: async () => {
        await fs.rename(installPath, `${installPath}.verified-launcher`);
        await fs.writeFile(installPath, foreign, { mode: 0o755 });
      },
    },
  });
  installPath = ctx.installPath;
  await fs.writeFile(ctx.profilePath, originalProfile);

  const result = await installConfirmed(ctx.installer);
  assert.equal(result.ok, false);
  assert.notEqual(result.state.status, "installed");
  assert.equal(result.state.errorCode, "ROLLBACK_FAILED");
  assert.equal(await fs.readFile(ctx.installPath, "utf8"), foreign);
  assert.equal(await exists(ctx.aliasPath), false);
  assert.equal(await fs.readFile(ctx.profilePath, "utf8"), originalProfile);
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

  const plan = await ctx.installer.prepareInstall();
  const first = ctx.installer.install(plan);
  const second = ctx.installer.install(plan);
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

  const firstPlan = await ctx.installer.prepareInstall();
  const secondPlan = await second.prepareInstall();
  const firstInstall = ctx.installer.install(firstPlan);
  while (!verifying) await new Promise((resolve) => setImmediate(resolve));
  const competing = await second.install(secondPlan);
  assert.equal(competing.ok, false);
  assert.equal(competing.state.errorCode, "INSTALL_BUSY");
  release();
  assert.equal((await firstInstall).ok, true);
});

test("does not follow a symlinked install-lock owner record", async (t) => {
  const ctx = await fixture(t);
  const lockRoot = path.join(path.dirname(ctx.installPath), ".littlestart-cli-install.lock");
  const generationPath = path.join(lockRoot, "generation-000000000000");
  const releasedTarget = path.join(ctx.root, "foreign-released-owner.json");
  const releasedRecord = `${JSON.stringify({
    token: "foreign-token",
    status: "released",
    updatedAt: new Date().toISOString(),
  })}\n`;
  await fs.mkdir(generationPath, { recursive: true });
  await fs.writeFile(releasedTarget, releasedRecord);
  await fs.symlink(releasedTarget, path.join(generationPath, "owner.json"));

  const result = await installConfirmed(ctx.installer);

  assert.equal(result.ok, false);
  assert.equal(result.state.errorCode, "INSTALL_BUSY");
  assert.equal(await fs.readFile(releasedTarget, "utf8"), releasedRecord);
  assert.equal(await exists(ctx.installPath), false);
});

test("a stale-lock reclaimer and the old owner never remove a fresh successor lease", async (t) => {
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

  let successorPath = "";
  const competingInstaller = createDesktopCliInstaller({
    supported: true,
    homeDir: ctx.homeDir,
    shellPath: "/bin/zsh",
    pathEnv: "/usr/bin:/bin",
    appExecutable: process.execPath,
    resourcesPath: ctx.resourcesPath,
    cliRoot: ctx.cliRoot,
    testHooks: {
      beforeStaleLockReclaim: async (createSuccessor) => {
        successorPath = await createSuccessor();
      },
    },
  });

  const firstPlan = await ctx.installer.prepareInstall();
  const competingPlan = await competingInstaller.prepareInstall();
  const firstInstall = ctx.installer.install(firstPlan);
  while (!verifying) await new Promise((resolve) => setImmediate(resolve));

  const lockRoot = path.join(path.dirname(ctx.installPath), ".littlestart-cli-install.lock");
  const [firstGeneration] = (await fs.readdir(lockRoot)).filter((entry) =>
    entry.startsWith("generation-"),
  );
  assert.ok(firstGeneration);
  const staleAt = new Date(Date.now() - 11 * 60 * 1000);
  const generationPath = path.join(lockRoot, firstGeneration);
  await fs.utimes(path.join(generationPath, "owner.json"), staleAt, staleAt);
  await fs.utimes(generationPath, staleAt, staleAt);

  const competing = await competingInstaller.install(competingPlan);
  assert.equal(competing.ok, false);
  assert.equal(competing.state.errorCode, "INSTALL_BUSY");
  assert.ok(successorPath);
  const successorBeforeRelease = await fs.readFile(
    path.join(successorPath, "owner.json"),
    "utf8",
  );
  assert.equal(JSON.parse(successorBeforeRelease).status, "active");

  release();
  assert.equal((await firstInstall).ok, true);
  assert.equal(
    await fs.readFile(path.join(successorPath, "owner.json"), "utf8"),
    successorBeforeRelease,
  );
});
