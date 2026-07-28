import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  entryPoints: [path.join(ROOT, "cli", "skills.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const subject = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
)) as typeof import("../cli/skills.ts");

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-skills-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

async function createSkill(source: string, version = "v1"): Promise<void> {
  await fs.mkdir(path.join(source, "references"), { recursive: true });
  await fs.writeFile(
    path.join(source, "SKILL.md"),
    `---\nname: generate-video\ndescription: test skill ${version}\n---\n\n# ${version}\n`,
  );
  await fs.writeFile(path.join(source, "references", "workflow.md"), `${version}\n`);
}

async function stagingEntries(project: string): Promise<string[]> {
  const parents = [
    path.join(project, ".agents", "skills"),
    path.join(project, ".claude", "skills"),
  ];
  const names: string[] = [];
  for (const parent of parents) {
    for (const name of await fs.readdir(parent).catch(() => [])) {
      if (name.includes(".partial") || name.includes(".backup")) names.push(name);
    }
  }
  return names;
}

test("project install copies a complete skill to Codex and Claude targets", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const project = path.join(dir, "project");
    await createSkill(source);
    await fs.mkdir(project);

    const result = await subject.installGenerateVideoSkill({
      sourceDir: source,
      cwd: project,
      scope: "project",
      target: "both",
    });
    assert.equal(result.scope, "project");
    assert.deepEqual(
      result.installed.map((item) => item.agent),
      ["codex", "claude"],
    );
    for (const root of [".agents", ".claude"]) {
      const installed = path.join(project, root, "skills", "generate-video");
      assert.match(await fs.readFile(path.join(installed, "SKILL.md"), "utf8"), /# v1/);
      assert.equal(
        await fs.readFile(path.join(installed, "references", "workflow.md"), "utf8"),
        "v1\n",
      );
    }
    assert.deepEqual(await stagingEntries(project), []);
  });
});

test("multi-target preflight is all-or-nothing and force replaces stale trees", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const project = path.join(dir, "project");
    await createSkill(source, "v1");
    await fs.mkdir(project);

    await subject.installGenerateVideoSkill({
      sourceDir: source,
      cwd: project,
      target: "codex",
    });
    const codexTarget = path.join(project, ".agents", "skills", "generate-video");
    const claudeTarget = path.join(project, ".claude", "skills", "generate-video");
    await fs.writeFile(path.join(codexTarget, "obsolete.txt"), "stale");

    await assert.rejects(
      subject.installGenerateVideoSkill({
        sourceDir: source,
        cwd: project,
        target: "both",
      }),
      /Skill \u5df2\u5b58\u5728|--force/,
    );
    assert.equal(await fs.lstat(claudeTarget).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(codexTarget, "obsolete.txt"), "utf8"), "stale");

    await createSkill(source, "v2");
    await subject.installGenerateVideoSkill({
      sourceDir: source,
      cwd: project,
      target: "codex",
      force: true,
    });
    assert.match(await fs.readFile(path.join(codexTarget, "SKILL.md"), "utf8"), /# v2/);
    assert.equal(await fs.lstat(path.join(codexTarget, "obsolete.txt")).catch(() => null), null);
    assert.deepEqual(await stagingEntries(project), []);
  });
});

test("source and destination symlinks are rejected without partial installation", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is permission-dependent on Windows");
    return;
  }
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const project = path.join(dir, "project");
    const outside = path.join(dir, "outside");
    await createSkill(source);
    await fs.mkdir(project);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "outside-owned");

    await fs.symlink(
      path.join(outside, "secret.txt"),
      path.join(source, "references", "linked.md"),
    );
    await assert.rejects(
      subject.installGenerateVideoSkill({
        sourceDir: source,
        cwd: project,
        target: "codex",
      }),
      /\u7b26\u53f7\u94fe\u63a5/,
    );
    const codexTarget = path.join(project, ".agents", "skills", "generate-video");
    assert.equal(await fs.lstat(codexTarget).catch(() => null), null);
    assert.equal(await fs.readFile(path.join(outside, "secret.txt"), "utf8"), "outside-owned");
    assert.deepEqual(await stagingEntries(project), []);

    await fs.unlink(path.join(source, "references", "linked.md"));
    await fs.mkdir(path.dirname(codexTarget), { recursive: true });
    const externalTarget = path.join(outside, "existing-skill");
    await fs.mkdir(externalTarget);
    await fs.writeFile(path.join(externalTarget, "owned.txt"), "do-not-replace");
    await fs.symlink(externalTarget, codexTarget);
    await assert.rejects(
      subject.installGenerateVideoSkill({
        sourceDir: source,
        cwd: project,
        target: "codex",
        force: true,
      }),
      /\u76ee\u6807\u662f\u7b26\u53f7\u94fe\u63a5/,
    );
    assert.equal(await fs.readFile(path.join(externalTarget, "owned.txt"), "utf8"), "do-not-replace");
    assert.equal((await fs.lstat(codexTarget)).isSymbolicLink(), true);
    assert.deepEqual(await stagingEntries(project), []);

    const sourceLink = path.join(dir, "source-link");
    await fs.symlink(source, sourceLink);
    await assert.rejects(
      subject.installGenerateVideoSkill({
        sourceDir: sourceLink,
        cwd: project,
        target: "claude",
      }),
      /\u6765\u6e90\u76ee\u5f55\u4e0d\u5b58\u5728\u6216\u4e0d\u5b89\u5168/,
    );
    assert.equal(
      await fs.lstat(path.join(project, ".claude", "skills", "generate-video")).catch(() => null),
      null,
    );
  });
});

test("failed forced restore preserves the old skill backup and reports its recovery path", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const project = path.join(dir, "project");
    await createSkill(source, "v1");
    await fs.mkdir(project);
    await subject.installGenerateVideoSkill({
      sourceDir: source,
      cwd: project,
      target: "codex",
    });
    await createSkill(source, "v2");

    const target = path.join(project, ".agents", "skills", "generate-video");
    const originalRename = fs.rename;
    let activationFailed = false;
    fs.rename = (async (from, to) => {
      const sourcePath = String(from);
      const destination = String(to);
      if (sourcePath.endsWith(".partial") && destination === target) {
        activationFailed = true;
        throw new Error("simulated skill activation failure");
      }
      if (activationFailed && sourcePath.endsWith(".backup") && destination === target) {
        throw new Error("simulated skill restore failure");
      }
      return originalRename(from, to);
    }) as typeof fs.rename;

    let failure: unknown;
    try {
      await subject.installGenerateVideoSkill({
        sourceDir: source,
        cwd: project,
        target: "codex",
        force: true,
      });
    } catch (error) {
      failure = error;
    } finally {
      fs.rename = originalRename;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /自动恢复原 Skill 失败/);
    assert.match(failure.message, /simulated skill activation failure/);
    assert.match(failure.message, /simulated skill restore failure/);

    const parent = path.dirname(target);
    const artifacts = (await fs.readdir(parent)).filter(
      (name) => name.includes(".partial") || name.includes(".backup"),
    );
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0], /\.backup$/);
    const backup = path.join(parent, artifacts[0]);
    assert.match(await fs.readFile(path.join(backup, "SKILL.md"), "utf8"), /# v1/);
    assert.match(failure.message, new RegExp(backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(failure.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await fs.lstat(target).catch(() => null), null);
  });
});

test("managed user install marks both agents and rolls an upgrade back to the exact prior content", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const home = path.join(dir, "home");
    await createSkill(source, "v1");
    await fs.mkdir(home);

    const first = await subject.beginManagedGenerateVideoSkillInstall({
      sourceDir: source,
      homeDir: home,
      target: "both",
    });
    assert.equal(await first.verify(), true);
    assert.equal((await first.commit()).ok, true);

    const targets = [
      path.join(home, ".codex", "skills", "generate-video"),
      path.join(home, ".claude", "skills", "generate-video"),
    ];
    for (const target of targets) {
      assert.match(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), /# v1/);
      assert.match(
        await fs.readFile(path.join(target, subject.MANAGED_SKILL_MARKER), "utf8"),
        /littlestart-electron/,
      );
    }

    await createSkill(source, "v2");
    const upgrading = await subject.beginManagedGenerateVideoSkillInstall({
      sourceDir: source,
      homeDir: home,
      target: "both",
    });
    assert.equal(await upgrading.verify(), true);
    for (const target of targets) {
      assert.match(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), /# v2/);
    }
    const rollback = await upgrading.rollback();
    assert.equal(rollback.ok, true);
    assert.deepEqual(rollback.retainedPaths, []);
    for (const target of targets) {
      assert.match(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), /# v1/);
      assert.doesNotMatch(await fs.readFile(path.join(target, "SKILL.md"), "utf8"), /# v2/);
    }
  });
});

test("managed user install preserves an unmanaged conflict and does not partially install the other agent", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const home = path.join(dir, "home");
    const codex = path.join(home, ".codex", "skills", "generate-video");
    const claude = path.join(home, ".claude", "skills", "generate-video");
    await createSkill(source, "v1");
    await fs.mkdir(codex, { recursive: true });
    await fs.writeFile(path.join(codex, "SKILL.md"), "# user-owned\n");

    await assert.rejects(
      subject.beginManagedGenerateVideoSkillInstall({
        sourceDir: source,
        homeDir: home,
        target: "both",
      }),
      (error: unknown) =>
        error instanceof subject.ManagedSkillInstallError &&
        error.code === "SKILL_INSTALL_CONFLICT",
    );
    assert.equal(await fs.readFile(path.join(codex, "SKILL.md"), "utf8"), "# user-owned\n");
    assert.equal(await fs.lstat(claude).catch(() => null), null);
  });
});

test("managed user install rolls back both targets when the second target publish fails", async () => {
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const home = path.join(dir, "home");
    await createSkill(source, "v1");
    await fs.mkdir(home);

    await assert.rejects(
      subject.beginManagedGenerateVideoSkillInstall({
        sourceDir: source,
        homeDir: home,
        target: "both",
        testHooks: {
          afterTargetPublish: async (target) => {
            if (target.agent === "claude") throw new Error("simulated second-target failure");
          },
        },
      }),
      (error: unknown) =>
        error instanceof subject.ManagedSkillInstallError &&
        error.code === "SKILL_INSTALL_FAILED",
    );
    for (const target of [
      path.join(home, ".codex", "skills", "generate-video"),
      path.join(home, ".claude", "skills", "generate-video"),
    ]) {
      assert.equal(await fs.lstat(target).catch(() => null), null);
    }
  });
});

test("managed user install rejects a symlinked agent directory without writing outside home", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is permission-dependent on Windows");
    return;
  }
  await withTempDir(async (dir) => {
    const source = path.join(dir, "source");
    const home = path.join(dir, "home");
    const outside = path.join(dir, "outside");
    await createSkill(source, "v1");
    await fs.mkdir(home);
    await fs.mkdir(outside);
    await fs.symlink(outside, path.join(home, ".codex"));

    const inspection = await subject.inspectManagedGenerateVideoSkill({
      sourceDir: source,
      homeDir: home,
      target: "both",
    });
    assert.equal(inspection.status, "conflict");
    assert.equal(
      inspection.targets.find((target) => target.agent === "codex")?.reason,
      "unsafe",
    );
    await assert.rejects(
      subject.beginManagedGenerateVideoSkillInstall({
        sourceDir: source,
        homeDir: home,
        target: "both",
      }),
      (error: unknown) =>
        error instanceof subject.ManagedSkillInstallError &&
        error.code === "SKILL_INSTALL_CONFLICT",
    );
    assert.deepEqual(await fs.readdir(outside), []);
  });
});
