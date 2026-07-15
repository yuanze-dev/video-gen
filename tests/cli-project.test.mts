import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  stdin: {
    contents: `
      export {
        stableStringify,
        digestJson,
        writeFileAtomic,
        writeJsonAtomic,
      } from "./cli/project.ts";
    `,
    loader: "ts",
    resolveDir: ROOT,
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  write: false,
  logLevel: "silent",
});

const subject = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
)) as {
  stableStringify: (value: unknown, indent?: number) => string;
  digestJson: (value: unknown) => string;
  writeFileAtomic: (
    target: string,
    contents: string,
    overwrite?: boolean,
  ) => Promise<string>;
  writeJsonAtomic: (
    target: string,
    value: unknown,
    overwrite?: boolean,
  ) => Promise<string>;
};

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-project-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function generatedArtifacts(names: readonly string[]): string[] {
  return names.filter(
    (name) => name.includes(".partial") || name.includes(".backup"),
  );
}

test("stable JSON and digest ignore object insertion order but preserve arrays", () => {
  const first = {
    z: 1,
    nested: { beta: true, alpha: [3, { y: 2, x: 1 }] },
    a: "value",
  };
  const second = {
    a: "value",
    nested: { alpha: [3, { x: 1, y: 2 }], beta: true },
    z: 1,
  };
  assert.equal(subject.stableStringify(first), subject.stableStringify(second));
  assert.equal(subject.digestJson(first), subject.digestJson(second));
  assert.match(subject.digestJson(first), /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(
    subject.digestJson(first),
    subject.digestJson({ ...second, nested: { ...second.nested, alpha: [...second.nested.alpha].reverse() } }),
  );
  assert.equal(
    subject.stableStringify({ z: 1, a: 2 }, 2),
    '{\n  "a": 2,\n  "z": 1\n}',
  );
});

test("atomic JSON writes are deterministic and refuse implicit overwrite", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "nested", "project.json");
    const output = await subject.writeJsonAtomic(target, { z: 1, a: { d: 4, c: 3 } });
    assert.equal(output, target);
    assert.equal(
      await fs.readFile(target, "utf8"),
      '{\n  "a": {\n    "c": 3,\n    "d": 4\n  },\n  "z": 1\n}\n',
    );

    await assert.rejects(
      subject.writeJsonAtomic(target, { replaced: false }),
      /\u5df2\u5b58\u5728|--force/,
    );
    assert.match(await fs.readFile(target, "utf8"), /"z": 1/);
    assert.deepEqual(generatedArtifacts(await fs.readdir(path.dirname(target))), []);

    await subject.writeJsonAtomic(target, { replaced: true }, true);
    assert.deepEqual(JSON.parse(await fs.readFile(target, "utf8")), {
      replaced: true,
    });
    assert.deepEqual(generatedArtifacts(await fs.readdir(path.dirname(target))), []);
  });
});

test("atomic failures clean staging files and preserve an existing directory", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "occupied");
    await fs.mkdir(target);
    await fs.writeFile(path.join(target, "owned.txt"), "owned");

    await assert.rejects(
      subject.writeFileAtomic(target, "must-not-land", true),
      /\u8f93\u51fa\u8def\u5f84\u662f\u76ee\u5f55/,
    );
    assert.equal(await fs.readFile(path.join(target, "owned.txt"), "utf8"), "owned");
    assert.deepEqual(generatedArtifacts(await fs.readdir(dir)), []);
  });
});

test("forced atomic replacement replaces a symlink, never its referent", async (t) => {
  if (process.platform === "win32") {
    t.skip("symlink creation is permission-dependent on Windows");
    return;
  }
  await withTempDir(async (dir) => {
    const outside = path.join(dir, "outside.txt");
    const target = path.join(dir, "output.txt");
    await fs.writeFile(outside, "outside-owned");
    await fs.symlink(outside, target);

    await assert.rejects(subject.writeFileAtomic(target, "no-force"), /\u5df2\u5b58\u5728/);
    assert.equal(await fs.readFile(outside, "utf8"), "outside-owned");
    assert.equal((await fs.lstat(target)).isSymbolicLink(), true);

    await subject.writeFileAtomic(target, "replacement", true);
    assert.equal((await fs.lstat(target)).isSymbolicLink(), false);
    assert.equal(await fs.readFile(target, "utf8"), "replacement");
    assert.equal(await fs.readFile(outside, "utf8"), "outside-owned");
    assert.deepEqual(generatedArtifacts(await fs.readdir(dir)), []);
  });
});

test("failed atomic restore preserves the only backup and reports its recovery path", async () => {
  await withTempDir(async (dir) => {
    const target = path.join(dir, "output.txt");
    await fs.writeFile(target, "original");

    const originalRename = fs.rename;
    let activationFailed = false;
    fs.rename = (async (from, to) => {
      const source = String(from);
      const destination = String(to);
      if (source.endsWith(".partial") && destination === target) {
        activationFailed = true;
        throw new Error("simulated activation failure");
      }
      if (activationFailed && source.endsWith(".backup") && destination === target) {
        throw new Error("simulated restore failure");
      }
      return originalRename(from, to);
    }) as typeof fs.rename;

    let failure: unknown;
    try {
      await subject.writeFileAtomic(target, "replacement", true);
    } catch (error) {
      failure = error;
    } finally {
      fs.rename = originalRename;
    }

    assert.ok(failure instanceof Error);
    assert.match(failure.message, /自动恢复原文件失败/);
    assert.match(failure.message, /simulated activation failure/);
    assert.match(failure.message, /simulated restore failure/);

    const artifacts = generatedArtifacts(await fs.readdir(dir));
    assert.equal(artifacts.length, 1);
    assert.match(artifacts[0], /\.backup$/);
    const backup = path.join(dir, artifacts[0]);
    assert.equal(await fs.readFile(backup, "utf8"), "original");
    assert.match(failure.message, new RegExp(backup.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(failure.message, new RegExp(target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.equal(await fs.lstat(target).catch(() => null), null);
  });
});
