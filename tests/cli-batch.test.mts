import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { build } from "esbuild";

const ROOT = process.cwd();
const bundle = await build({
  entryPoints: [path.join(ROOT, "cli/batch.ts")],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  write: false,
  logLevel: "silent",
});
const core = (await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
)) as typeof import("../cli/batch.ts");

async function withTempDir(run: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-batch-"));
  try {
    await run(dir);
  } finally {
    await fs.rm(dir, { force: true, recursive: true });
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function pathExists(file: string): Promise<boolean> {
  return fs.access(file).then(
    () => true,
    () => false,
  );
}

async function waitForPath(file: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await pathExists(file))) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${file}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function listTree(root: string): Promise<string[]> {
  const result: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      result.push(path.relative(root, absolute));
      if (entry.isDirectory()) await visit(absolute);
    }
  };
  await visit(root);
  return result.sort();
}

async function createConfig(dir: string, name: string, value: unknown = {}): Promise<string> {
  const file = path.join(dir, `${name}.json`);
  await writeJson(file, value);
  return file;
}

function manifestJob(id: string, extra: Record<string, unknown> = {}) {
  return { id, config: `${id}.json`, ...extra };
}

function validation(localAssetPaths: readonly string[] = []) {
  return { value: { ok: true }, localAssetPaths };
}

async function writeArtifacts(job: {
  outputPath: string;
  coverPath?: string;
}): Promise<{ output: string }> {
  await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
  await fs.writeFile(job.outputPath, "video");
  if (job.coverPath) {
    await fs.mkdir(path.dirname(job.coverPath), { recursive: true });
    await fs.writeFile(job.coverPath, "cover");
  }
  return { output: job.outputPath };
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

test("strict manifest rejects traversal, duplicate ids, duplicate outputs, and absolute configs", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["safe", "other", "third", "fourth"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, {
      version: 1,
      unexpected: true,
      jobs: [manifestJob("safe")],
    });
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir: path.join(dir, "out"),
        validateOne: async () => validation(),
        renderOne: writeArtifacts,
      }),
      (error: unknown) =>
        error instanceof core.BatchManifestError &&
        error.issues.some((issue) => issue.path === "unexpected"),
    );

    await writeJson(manifest, {
      version: 1,
      jobs: [
        manifestJob("safe", { out: "../escape.mp4" }),
        manifestJob("safe", { config: "other.json" }),
        manifestJob("third", { out: "same.mp4" }),
        manifestJob("fourth", {
          out: "same.mp4",
          config: path.join(dir, "fourth.json"),
        }),
      ],
    });

    let captured: InstanceType<typeof core.BatchPreflightError> | undefined;
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir: path.join(dir, "out"),
        validateOne: async () => validation(),
        renderOne: writeArtifacts,
      }),
      (error: unknown) => {
        if (!(error instanceof core.BatchPreflightError)) return false;
        captured = error;
        return true;
      },
    );
    const codes = new Set(captured?.issues.map((issue) => issue.code));
    assert.equal(codes.has("OUTPUT_TRAVERSAL"), true);
    assert.equal(codes.has("DUPLICATE_ID"), true);
    assert.equal(codes.has("DUPLICATE_OUTPUT"), true);
    assert.equal(codes.has("ABSOLUTE_CONFIG_PATH"), true);
    assert.equal(await fs.stat(path.join(dir, "escape.mp4")).catch(() => null), null);
  });
});

test("artifact extension preflight accepts mp4/jpeg only and starts no validation or render on errors", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["bad-video", "bad-cover", "valid"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    const outDir = path.join(dir, "out");
    await writeJson(manifest, {
      version: 1,
      jobs: [
        manifestJob("bad-video", { out: "bad-video.mov" }),
        manifestJob("bad-cover", { cover: "bad-cover.png" }),
        manifestJob("valid", { out: "valid.MP4", cover: "valid.JPEG" }),
      ],
    });

    let validations = 0;
    let renders = 0;
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir,
        validateOne: async () => {
          validations += 1;
          return validation();
        },
        renderOne: async (job) => {
          renders += 1;
          return writeArtifacts(job);
        },
      }),
      (error: unknown) => {
        if (!(error instanceof core.BatchPreflightError)) return false;
        assert.deepEqual(
          error.issues.map((issue) => issue.code).sort(),
          ["INVALID_COVER_EXTENSION", "INVALID_OUTPUT_EXTENSION"],
        );
        return true;
      },
    );
    assert.equal(validations, 0);
    assert.equal(renders, 0);
    assert.equal(await pathExists(path.join(outDir, core.BATCH_LOCK_FILENAME)), false);

    await writeJson(manifest, {
      version: 1,
      jobs: [manifestJob("valid", { out: "valid.MP4", cover: "valid.JPEG" })],
    });
    const summary = await core.runBatch({
      manifestPath: manifest,
      outDir,
      validateOne: async () => validation(),
      renderOne: writeArtifacts,
    });
    assert.equal(summary.succeeded, 1);
  });
});

test("output paths cannot escape through an existing symlink", async (t) => {
  if (process.platform === "win32") t.skip("symlink permissions vary on Windows");
  await withTempDir(async (dir) => {
    await createConfig(dir, "safe");
    const outside = path.join(dir, "outside");
    const outDir = path.join(dir, "out");
    await fs.mkdir(outside);
    await fs.mkdir(outDir);
    await fs.symlink(outside, path.join(outDir, "linked"));
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, {
      version: 1,
      jobs: [manifestJob("safe", { out: "linked/escape.mp4" })],
    });
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir,
        validateOne: async () => validation(),
        renderOne: writeArtifacts,
      }),
      (error: unknown) =>
        error instanceof core.BatchPreflightError &&
        error.issues.some((issue) => issue.code === "OUTPUT_TRAVERSAL"),
    );
  });
});

test("all existing artifacts are rejected before rendering unless overwrite is explicit", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["a", "b"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    const outDir = path.join(dir, "out");
    const journalPath = path.join(outDir, ".littlestart-batch-state.json");
    await writeJson(manifest, {
      version: 1,
      jobs: [
        manifestJob("a", { cover: "covers/a.jpg" }),
        manifestJob("b", { cover: "covers/b.jpeg" }),
      ],
    });
    await fs.mkdir(path.join(outDir, "covers"), { recursive: true });
    await fs.writeFile(path.join(outDir, "a.mp4"), "old-a");
    await fs.writeFile(path.join(outDir, "covers", "a.jpg"), "old-cover-a");
    await fs.writeFile(path.join(outDir, "b.mp4"), "old-b");

    let renders = 0;
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir,
        validateOne: async () => validation(),
        renderOne: async (job) => {
          renders += 1;
          return writeArtifacts(job);
        },
      }),
      (error: unknown) => {
        if (!(error instanceof core.BatchPreflightError)) return false;
        const existing = error.issues.filter(
          (issue) => issue.code === "OUTPUT_EXISTS",
        );
        assert.deepEqual(
          existing.map((issue) => [issue.id, issue.path]),
          [
            ["a", "jobs.0.cover"],
            ["a", "jobs.0.out"],
            ["b", "jobs.1.out"],
          ],
        );
        return true;
      },
    );
    assert.equal(renders, 0);
    assert.equal(await pathExists(journalPath), false);
    assert.equal(await pathExists(path.join(outDir, core.BATCH_LOCK_FILENAME)), false);

    const overwriteFlags: boolean[] = [];
    const summary = await core.runBatch({
      manifestPath: manifest,
      outDir,
      overwrite: true,
      validateOne: async () => validation(),
      renderOne: async (job, _validated, context) => {
        overwriteFlags.push(context.overwrite);
        return writeArtifacts(job);
      },
    });
    assert.equal(summary.succeeded, 2);
    assert.deepEqual(overwriteFlags, [true, true]);
    assert.equal(await pathExists(path.join(outDir, "covers", "b.jpeg")), true);
    assert.equal(await pathExists(path.join(outDir, core.BATCH_LOCK_FILENAME)), false);
  });
});

test("output parent probes cover nested directories, fail safely, and leave no probe files", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["nested", "blocked"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    const nestedOutDir = path.join(dir, "nested-out");
    await writeJson(manifest, {
      version: 1,
      jobs: [
        manifestJob("nested", {
          out: "videos/deep/nested.mp4",
          cover: "covers/deep/nested.jpg",
        }),
      ],
    });
    const summary = await core.runBatch({
      manifestPath: manifest,
      outDir: nestedOutDir,
      validateOne: async () => validation(),
      renderOne: writeArtifacts,
    });
    assert.equal(summary.succeeded, 1);
    assert.equal(
      (await listTree(nestedOutDir)).some((file) =>
        file.includes(".littlestart-write-probe-"),
      ),
      false,
    );

    const blockedOutDir = path.join(dir, "blocked-out");
    await fs.mkdir(blockedOutDir);
    await fs.writeFile(path.join(blockedOutDir, "not-a-directory"), "blocked");
    await writeJson(manifest, {
      version: 1,
      jobs: [manifestJob("blocked", { out: "not-a-directory/video.mp4" })],
    });
    let renders = 0;
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir: blockedOutDir,
        validateOne: async () => validation(),
        renderOne: async (job) => {
          renders += 1;
          return writeArtifacts(job);
        },
      }),
      (error: unknown) =>
        error instanceof core.BatchPreflightError &&
        error.issues.some(
          (issue) => issue.code === "OUTPUT_PARENT_UNWRITABLE",
        ),
    );
    assert.equal(renders, 0);
    assert.equal(
      (await listTree(blockedOutDir)).some((file) =>
        file.includes(".littlestart-write-probe-"),
      ),
      false,
    );
    assert.equal(
      await pathExists(path.join(blockedOutDir, core.BATCH_LOCK_FILENAME)),
      false,
    );
  });
});

test("all configs are preflighted and no render starts when any validation fails", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["a", "b", "c"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, {
      version: 1,
      jobs: [manifestJob("a"), manifestJob("b"), manifestJob("c")],
    });
    const validated: string[] = [];
    let renders = 0;
    await assert.rejects(
      core.runBatch({
        manifestPath: manifest,
        outDir: path.join(dir, "out"),
        concurrency: 2,
        validateOne: async (job) => {
          validated.push(job.id);
          if (job.id === "b") throw new Error("broken config b");
          return validation();
        },
        renderOne: async (job) => {
          renders += 1;
          return writeArtifacts(job);
        },
      }),
      (error: unknown) =>
        error instanceof core.BatchPreflightError &&
        error.issues.some((issue) => issue.id === "b" && /broken config/.test(issue.message)),
    );
    assert.deepEqual(validated.sort(), ["a", "b", "c"]);
    assert.equal(renders, 0);
  });
});

test("render worker pool observes the concurrency limit and emits progress", async () => {
  await withTempDir(async (dir) => {
    const ids = ["a", "b", "c", "d", "e"];
    for (const id of ids) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, { version: 1, jobs: ids.map((id) => manifestJob(id)) });
    let active = 0;
    let peak = 0;
    const events: Array<import("../cli/batch.ts").BatchEvent<{ id: string }>> = [];
    const summary = await core.runBatch({
      manifestPath: manifest,
      outDir: path.join(dir, "out"),
      concurrency: 2,
      validateOne: async () => validation(),
      renderOne: async (job, _loaded, context) => {
        active += 1;
        peak = Math.max(peak, active);
        context.reportProgress(0.25, { stage: "render" });
        await new Promise((resolve) => setTimeout(resolve, 15));
        await writeArtifacts(job);
        active -= 1;
        return { id: job.id };
      },
      onEvent: (event) => events.push(event),
    });
    assert.equal(peak, 2);
    assert.equal(summary.succeeded, ids.length);
    assert.equal(summary.partial, false);
    assert.deepEqual(summary.jobs.map((job) => job.id), ids);
    assert.equal(events.filter((event) => event.event === "job-progress").length, ids.length);
    assert.equal(events.at(-1)?.event, "batch-finished");
  });
});

test("resume requires matching config and asset hashes plus non-empty artifacts", async () => {
  await withTempDir(async (dir) => {
    const assetA = path.join(dir, "asset-a.bin");
    const assetB = path.join(dir, "asset-b.bin");
    await fs.writeFile(assetA, "asset-a-v1");
    await fs.writeFile(assetB, "asset-b-v1");
    await createConfig(dir, "a", { text: "a-v1" });
    await createConfig(dir, "b", { text: "b-v1" });
    const manifest = path.join(dir, "batch.json");
    const outDir = path.join(dir, "out");
    const journalPath = path.join(outDir, ".littlestart-batch-state.json");
    await writeJson(manifest, {
      version: 1,
      defaults: { quality: "standard" },
      jobs: [
        manifestJob("a", { cover: "covers/a.jpg" }),
        manifestJob("b", { options: { fps: 30 } }),
      ],
    });
    const rendered: string[] = [];
    let fingerprintSalt = JSON.stringify({
      cliVersion: "cli-1",
      runtime: "runtime-a",
      platform: "linux",
      arch: "x64",
      chromiumGl: "angle",
      browserExecutable: null,
      binariesDirectory: null,
    });
    const run = (resume: boolean, overwrite = false) =>
      core.runBatch({
        manifestPath: manifest,
        outDir,
        resume,
        overwrite,
        fingerprintSalt,
        concurrency: 2,
        validateOne: async (job) =>
          validation([job.id === "a" ? assetA : assetB]),
        renderOne: async (job) => {
          rendered.push(job.id);
          return writeArtifacts(job);
        },
      });

    let summary = await run(false);
    assert.equal(summary.succeeded, 2);
    assert.deepEqual(rendered.sort(), ["a", "b"]);

    let journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    assert.deepEqual(journal.jobs.a.artifacts, {
      output: { sizeBytes: 5, sha256: sha256("video") },
      cover: { sizeBytes: 5, sha256: sha256("cover") },
    });
    assert.deepEqual(journal.jobs.b.artifacts, {
      output: { sizeBytes: 5, sha256: sha256("video") },
    });

    rendered.length = 0;
    summary = await run(true);
    assert.equal(summary.skipped, 2);
    assert.deepEqual(rendered, []);

    // Legacy v1 succeeded entries had no artifact integrity block. They remain
    // readable but are intentionally rendered again instead of being trusted.
    journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    delete journal.jobs.b.artifacts;
    await writeJson(journalPath, journal);
    rendered.length = 0;
    await assert.rejects(
      run(true),
      (error: unknown) =>
        error instanceof core.BatchPreflightError &&
        error.issues.some(
          (issue) => issue.id === "b" && issue.code === "OUTPUT_EXISTS",
        ),
    );
    assert.deepEqual(rendered, []);
    summary = await run(true, true);
    assert.deepEqual(rendered, ["b"]);
    assert.equal(summary.skipped, 1);

    // A GL backend change changes rendered pixels and must invalidate resume,
    // even when the CLI and template runtime are otherwise identical.
    fingerprintSalt = JSON.stringify({
      cliVersion: "cli-1",
      runtime: "runtime-a",
      platform: "linux",
      arch: "x64",
      chromiumGl: "swangle",
      browserExecutable: null,
      binariesDirectory: null,
    });
    rendered.length = 0;
    await assert.rejects(
      run(true),
      (error: unknown) =>
        error instanceof core.BatchPreflightError &&
        error.issues.filter((issue) => issue.code === "OUTPUT_EXISTS").length === 3,
    );
    assert.deepEqual(rendered, []);
    summary = await run(true, true);
    assert.equal(summary.skipped, 0);
    assert.deepEqual(rendered.sort(), ["a", "b"]);

    // A non-empty, same-size replacement must not pass resume based only on
    // path and size. Output and cover are verified independently by SHA-256.
    await fs.writeFile(path.join(outDir, "a.mp4"), "VIDE0");
    rendered.length = 0;
    summary = await run(true, true);
    assert.deepEqual(rendered, ["a"]);
    assert.equal(summary.skipped, 1);

    await fs.writeFile(path.join(outDir, "covers", "a.jpg"), "COVER");
    rendered.length = 0;
    summary = await run(true, true);
    assert.deepEqual(rendered, ["a"]);
    assert.equal(summary.skipped, 1);

    await fs.writeFile(path.join(outDir, "a.mp4"), "");
    rendered.length = 0;
    summary = await run(true, true);
    assert.deepEqual(rendered, ["a"]);
    assert.equal(summary.skipped, 1);

    await createConfig(dir, "b", { text: "b-v2" });
    rendered.length = 0;
    summary = await run(true, true);
    assert.deepEqual(rendered, ["b"]);
    assert.equal(summary.skipped, 1);

    await fs.writeFile(assetA, "asset-a-v2");
    rendered.length = 0;
    summary = await run(true, true);
    assert.deepEqual(rendered, ["a"]);
    assert.equal(summary.skipped, 1);

    await fs.rm(path.join(outDir, "covers", "a.jpg"));
    rendered.length = 0;
    summary = await run(true, true);
    assert.deepEqual(rendered, ["a"]);
    assert.equal(summary.skipped, 1);
  });
});

test("manifest input is bounded and exposes explicit export override keys", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      core.runBatch({
        manifestPath: path.join(dir, "stdin.batch.json"),
        manifestText: "x".repeat(core.MAX_BATCH_MANIFEST_BYTES + 1),
        outDir: path.join(dir, "out"),
        validateOne: async () => validation(),
        renderOne: writeArtifacts,
      }),
      (error: unknown) =>
        error instanceof core.BatchManifestError &&
        error.issues.some((issue) => issue.code === "MANIFEST_TOO_LARGE"),
    );

    await createConfig(dir, "a");
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, {
      version: 1,
      defaults: { quality: "small" },
      jobs: [manifestJob("a", { options: { fps: 30 } })],
    });
    let keys: readonly string[] = [];
    await core.runBatch({
      manifestPath: manifest,
      outDir: path.join(dir, "out"),
      validateOne: async (job) => {
        keys = job.exportOverrideKeys;
        return validation();
      },
      renderOne: writeArtifacts,
    });
    assert.deepEqual(keys, ["quality", "fps"]);
  });
});

test("a cross-process out-dir lock blocks rendering and an AbortSignal cancels the waiter", async () => {
  await withTempDir(async (dir) => {
    await createConfig(dir, "a");
    const manifest = path.join(dir, "batch.json");
    const outDir = path.join(dir, "out");
    const modulePath = path.join(dir, "batch-bundle.mjs");
    const workerPath = path.join(dir, "lock-owner.mjs");
    const startedPath = path.join(dir, "owner-started");
    const releasePath = path.join(dir, "owner-release");
    await writeJson(manifest, { version: 1, jobs: [manifestJob("a")] });
    await fs.writeFile(modulePath, bundle.outputFiles[0].contents);
    await fs.writeFile(
      workerPath,
      `
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const [modulePath, manifestPath, outDir, startedPath, releasePath] = process.argv.slice(2);
const { runBatch } = await import(pathToFileURL(modulePath).href);
await runBatch({
  manifestPath,
  outDir,
  validateOne: async () => ({ value: { ok: true } }),
  renderOne: async (job) => {
    await fs.writeFile(startedPath, "started");
    while (true) {
      try {
        await fs.access(releasePath);
        break;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    await fs.mkdir(path.dirname(job.outputPath), { recursive: true });
    await fs.writeFile(job.outputPath, "child-video");
    return { owner: "child" };
  },
});
`,
      "utf8",
    );

    const child = spawn(
      process.execPath,
      [workerPath, modulePath, manifest, outDir, startedPath, releasePath],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const childExit = new Promise<number | null>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", resolve);
    });

    try {
      await Promise.race([
        waitForPath(startedPath),
        childExit.then((code) => {
          throw new Error(`Lock owner exited early (${code}): ${stderr}`);
        }),
      ]);
      const lockPath = path.join(outDir, core.BATCH_LOCK_FILENAME);
      const metadata = JSON.parse(await fs.readFile(lockPath, "utf8"));
      assert.equal(metadata.pid, child.pid);

      const controller = new AbortController();
      let waiterRenders = 0;
      const waitingRun = core.runBatch({
        manifestPath: manifest,
        outDir,
        signal: controller.signal,
        validateOne: async () => validation(),
        renderOne: async (job) => {
          waiterRenders += 1;
          return writeArtifacts(job);
        },
      });
      const waitingRejection = assert.rejects(
        waitingRun,
        (error: unknown) => error instanceof Error && error.name === "AbortError",
      );
      await new Promise((resolve) => setTimeout(resolve, 250));
      assert.equal(waiterRenders, 0);
      assert.equal(await pathExists(path.join(outDir, "a.mp4")), false);
      controller.abort("cancel lock waiter");
      await waitingRejection;
      assert.equal(waiterRenders, 0);

      await fs.writeFile(releasePath, "release");
      const exitCode = await childExit;
      assert.equal(exitCode, 0, stderr);
      assert.equal(await fs.readFile(path.join(outDir, "a.mp4"), "utf8"), "child-video");
      assert.equal(await pathExists(lockPath), false);
    } finally {
      await fs.writeFile(releasePath, "release").catch(() => {});
      if (child.exitCode === null && !child.killed) child.kill("SIGKILL");
    }
  });
});

test("dead-owner and old malformed batch locks recover without leaving lock debris", async () => {
  await withTempDir(async (dir) => {
    await createConfig(dir, "a");
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, { version: 1, jobs: [manifestJob("a")] });

    const run = async (outDir: string) => {
      const summary = await core.runBatch({
        manifestPath: manifest,
        outDir,
        validateOne: async () => validation(),
        renderOne: writeArtifacts,
      });
      assert.equal(summary.succeeded, 1);
      assert.equal(
        await pathExists(path.join(outDir, core.BATCH_LOCK_FILENAME)),
        false,
      );
      assert.equal(
        await pathExists(path.join(outDir, ".littlestart-batch.lock.recovery")),
        false,
      );
    };

    const deadOwnerOutDir = path.join(dir, "dead-owner");
    await fs.mkdir(deadOwnerOutDir);
    await fs.writeFile(
      path.join(deadOwnerOutDir, core.BATCH_LOCK_FILENAME),
      `${JSON.stringify({
        version: 1,
        pid: 2_147_483_647,
        token: "0".repeat(32),
        createdAt: new Date(0).toISOString(),
      })}\n`,
    );
    await run(deadOwnerOutDir);

    const malformedOutDir = path.join(dir, "malformed");
    await fs.mkdir(malformedOutDir);
    const malformedLock = path.join(malformedOutDir, core.BATCH_LOCK_FILENAME);
    await fs.writeFile(malformedLock, "partial owner metadata");
    const old = new Date(Date.now() - core.BATCH_LOCK_STALE_MS - 1_000);
    await fs.utimes(malformedLock, old, old);
    await run(malformedOutDir);
  });
});

test("abort signal cancels active and queued jobs with a complete summary", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["a", "b", "c"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    await writeJson(manifest, {
      version: 1,
      jobs: [manifestJob("a"), manifestJob("b"), manifestJob("c")],
    });
    const controller = new AbortController();
    let notifyStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      notifyStarted = resolve;
    });
    const run = core.runBatch({
      manifestPath: manifest,
      outDir: path.join(dir, "out"),
      concurrency: 1,
      signal: controller.signal,
      validateOne: async () => validation(),
      renderOne: async (_job, _loaded, context) => {
        notifyStarted();
        await new Promise<void>((_resolve, reject) => {
          context.signal?.addEventListener(
            "abort",
            () => {
              const error = new Error("stopped");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
        throw new Error("unreachable");
      },
    });
    await started;
    controller.abort("test cancellation");
    const summary = await run;
    assert.equal(summary.cancelled, 3);
    assert.equal(summary.interrupted, true);
    assert.equal(summary.partial, true);
    assert.equal(summary.jobs[0].startedAt !== undefined, true);
    assert.equal(summary.jobs[1].startedAt, undefined);
    assert.equal(summary.jobs[2].startedAt, undefined);
  });
});

test("partial failures continue, journal atomically recovers, and resume retries only failures", async () => {
  await withTempDir(async (dir) => {
    for (const id of ["a", "b", "c"]) await createConfig(dir, id);
    const manifest = path.join(dir, "batch.json");
    const outDir = path.join(dir, "out");
    const journalPath = path.join(outDir, ".littlestart-batch-state.json");
    await writeJson(manifest, {
      version: 1,
      jobs: [manifestJob("a"), manifestJob("b"), manifestJob("c")],
    });
    let failB = true;
    const attempts: string[] = [];
    const run = (resume: boolean) =>
      core.runBatch({
        manifestPath: manifest,
        outDir,
        journalPath,
        resume,
        concurrency: 3,
        validateOne: async () => validation(),
        renderOne: async (job) => {
          attempts.push(job.id);
          if (job.id === "b" && failB) throw new Error("encoder exploded");
          return writeArtifacts(job);
        },
      });

    let summary = await run(false);
    assert.equal(summary.succeeded, 2);
    assert.equal(summary.failed, 1);
    assert.equal(summary.partial, true);
    assert.deepEqual(summary.jobs.map((job) => job.status), ["succeeded", "failed", "succeeded"]);
    assert.match(new core.BatchPartialFailureError(summary).message, /1 项失败/);

    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    assert.equal(journal.version, 1);
    assert.equal(journal.jobs.a.status, "succeeded");
    assert.equal(journal.jobs.b.status, "failed");
    assert.equal(journal.jobs.c.status, "succeeded");
    assert.match(journal.jobs.a.artifacts.output.sha256, /^[a-f0-9]{64}$/);
    assert.equal(journal.jobs.a.artifacts.output.sizeBytes, 5);
    assert.equal(journal.jobs.b.artifacts, undefined);
    assert.match(journal.jobs.c.artifacts.output.sha256, /^[a-f0-9]{64}$/);
    const partialFiles = (await fs.readdir(outDir)).filter((name) => name.endsWith(".partial"));
    assert.deepEqual(partialFiles, []);

    // A stale temporary file from a crashed atomic write is never treated as
    // authoritative; the last complete journal remains readable.
    await fs.writeFile(path.join(outDir, ".state.crashed.partial"), "{broken");
    failB = false;
    attempts.length = 0;
    summary = await run(true);
    assert.deepEqual(attempts, ["b"]);
    assert.equal(summary.succeeded, 1);
    assert.equal(summary.skipped, 2);
    assert.equal(summary.partial, false);
    const finalJournalText = await fs.readFile(journalPath, "utf8");
    assert.doesNotThrow(() => JSON.parse(finalJournalText));
  });
});
