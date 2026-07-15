import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledDir = await fs.mkdtemp(path.join(root, ".render-core-test-"));
const compiledFile = path.join(compiledDir, "render-core.mjs");
const compiledConfigFile = path.join(compiledDir, "config-schema.mjs");

type RenderCore = typeof import("../cli/render.ts") & typeof import("../cli/cache.ts");
type ConfigSchema = typeof import("../lib/config-schema.ts");
let core: RenderCore;
let configSchema: ConfigSchema;

before(async () => {
  await build({
    entryPoints: [path.join(root, "cli", "render.ts")],
    outfile: compiledFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
    sourcemap: "inline",
  });
  await build({
    entryPoints: [path.join(root, "lib", "config-schema.ts")],
    outfile: compiledConfigFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
  });
  core = (await import(`${pathToFileURL(compiledFile).href}?t=${Date.now()}`)) as RenderCore;
  configSchema = (await import(
    `${pathToFileURL(compiledConfigFile).href}?t=${Date.now()}`
  )) as ConfigSchema;
});

after(async () => {
  await fs.rm(compiledDir, { recursive: true, force: true });
});

test("uses platform user cache locations and honors LITTLESTART_CACHE_DIR", () => {
  assert.equal(
    core.getCacheDirectory({
      platform: "darwin",
      homeDir: "/Users/tester",
      env: {},
    }),
    "/Users/tester/Library/Caches/littlestart",
  );
  assert.equal(
    core.getCacheDirectory({
      platform: "linux",
      homeDir: "/home/tester",
      env: { XDG_CACHE_HOME: "/mnt/cache" },
    }),
    "/mnt/cache/littlestart",
  );
  assert.equal(
    core.getCacheDirectory({
      platform: "win32",
      homeDir: "C:\\Users\\tester",
      env: { LOCALAPPDATA: "C:\\Users\\tester\\AppData\\Local" },
    }),
    path.resolve("C:\\Users\\tester\\AppData\\Local", "littlestart"),
  );
  assert.equal(
    core.getCacheDirectory({
      platform: "linux",
      homeDir: "/home/tester",
      env: { LITTLESTART_CACHE_DIR: "/custom/littlestart-cache" },
    }),
    "/custom/littlestart-cache",
  );
});

test("serializes concurrent cache writers with a file lock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-"));
  const lockPath = path.join(directory, "bundle.lock");
  let active = 0;
  let maximumActive = 0;
  const visits: number[] = [];
  try {
    await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        core.withFileLock(
          lockPath,
          async () => {
            active += 1;
            maximumActive = Math.max(maximumActive, active);
            visits.push(index);
            await new Promise((resolve) => setTimeout(resolve, 20));
            active -= 1;
          },
          { retryMinMs: 1, retryMaxMs: 3, timeoutMs: 2_000 },
        ),
      ),
    );
    assert.equal(maximumActive, 1);
    assert.equal(visits.length, 4);
    await assert.rejects(fs.stat(lockPath));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("cancels a file-lock waiter immediately during retry backoff", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-abort-"));
  const lockPath = path.join(directory, "bundle.lock");
  let markHolderReady: (() => void) | undefined;
  const holderReady = new Promise<void>((resolve) => {
    markHolderReady = resolve;
  });
  let releaseHolder: (() => void) | undefined;
  const holderRelease = new Promise<void>((resolve) => {
    releaseHolder = resolve;
  });

  try {
    const holder = core.withFileLock(lockPath, async () => {
      markHolderReady?.();
      await holderRelease;
    });
    await holderReady;

    const controller = new AbortController();
    const startedAt = Date.now();
    const waiting = core.withFileLock(lockPath, async () => assert.fail("waiter acquired lock"), {
      retryMinMs: 5_000,
      retryMaxMs: 5_000,
      timeoutMs: 30_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("cancel lock wait")), 20);

    await assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      assert.match(error.message, /取消/);
      return true;
    });
    assert.ok(Date.now() - startedAt < 500, "abort should not wait for the 5s retry timer");

    releaseHolder?.();
    await holder;
    assert.equal(await fs.lstat(lockPath).catch(() => null), null);
  } finally {
    releaseHolder?.();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("ensureBundle forwards cancellation while waiting for its bundle cache lock", { timeout: 10_000 }, async () => {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-bundle-abort-"));
  const bundleLock = path.join(cache, ".bundle-cache.lock");
  await fs.writeFile(
    bundleLock,
    `${JSON.stringify({ pid: process.pid, token: "test-owner", createdAt: new Date().toISOString() })}\n`,
  );

  try {
    const controller = new AbortController();
    const bundling = core.ensureBundle(root, { cacheDir: cache, signal: controller.signal });
    setTimeout(() => controller.abort(new Error("cancel bundle wait")), 50);
    await assert.rejects(
      bundling,
      (error: unknown) =>
        error instanceof core.RenderCancelledError && error.code === "RENDER_CANCELLED",
    );
    assert.equal(
      (await fs.readdir(cache)).filter((entry) => entry.includes(".partial")).length,
      0,
    );
    assert.ok(await fs.stat(bundleLock));
    assert.equal(
      await fs.lstat(path.join(cache, ".cache-maintenance.lock")).catch(() => null),
      null,
    );
  } finally {
    await fs.rm(cache, { recursive: true, force: true });
  }
});

test("streams local assets with HEAD, byte ranges and an unguessable token", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-assets-"));
  const file = path.join(directory, "clip.mp4");
  await fs.writeFile(file, "0123456789");
  const server = await core.serveLocalAssets({ clip: { file, mime: "video/mp4" } });
  try {
    const url = server.urls.clip;
    assert.equal(new URL(url).hostname, "127.0.0.1");

    const head = await fetch(url, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");

    const range = await fetch(url, { headers: { Range: "bytes=2-5" } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await range.text(), "2345");

    const suffix = await fetch(url, { headers: { Range: "bytes=-3" } });
    assert.equal(suffix.status, 206);
    assert.equal(await suffix.text(), "789");

    const invalid = await fetch(url, { headers: { Range: "bytes=50-60" } });
    assert.equal(invalid.status, 416);
    assert.equal(invalid.headers.get("content-range"), "bytes */10");

    const wrongToken = new URL(url);
    wrongToken.pathname = wrongToken.pathname.replace(/\/asset\/[^/]+\//, "/asset/wrong-token/");
    assert.equal((await fetch(wrongToken)).status, 404);
    assert.equal((await fetch(url, { method: "POST" })).status, 405);
  } finally {
    await server.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("commits video and cover as one transaction and rolls back failures", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-commit-"));
  const video = path.join(directory, "video.mp4");
  const cover = path.join(directory, "cover.jpg");
  const videoTemp = path.join(directory, ".video.partial.mp4");
  const missingCoverTemp = path.join(directory, ".missing-cover.partial.jpg");
  await fs.writeFile(video, "old-video");
  await fs.writeFile(cover, "old-cover");
  await fs.writeFile(videoTemp, "new-video");

  try {
    await assert.rejects(
      core.commitArtifactsAtomically(
        [
          { temporaryPath: videoTemp, targetPath: video },
          { temporaryPath: missingCoverTemp, targetPath: cover },
        ],
        true,
      ),
    );
    assert.equal(await fs.readFile(video, "utf8"), "old-video");
    assert.equal(await fs.readFile(cover, "utf8"), "old-cover");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("does not overwrite unless explicitly requested", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-no-clobber-"));
  const target = path.join(directory, "video.mp4");
  const temporary = path.join(directory, ".video.partial.mp4");
  await fs.writeFile(target, "existing");
  await fs.writeFile(temporary, "new");
  try {
    await assert.rejects(
      core.commitArtifactsAtomically([{ temporaryPath: temporary, targetPath: target }]),
      /输出文件已存在/,
    );
    assert.equal(await fs.readFile(target, "utf8"), "existing");
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("accepts a valid prebuilt runtime site without source bundling", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-runtime-"));
  try {
    await fs.writeFile(path.join(directory, "index.html"), "<!doctype html>");
    await fs.writeFile(path.join(directory, "bundle.js"), "// runtime");
    await fs.writeFile(path.join(directory, "bundle.js.map"), "{}");
    assert.equal(await core.resolveRenderServeUrl({ runtimeSite: directory }), directory);
    await assert.rejects(
      core.resolveRenderServeUrl({ runtimeSite: directory, serveUrl: "https://example.com" }),
      /不能同时设置/,
    );

    await fs.rm(path.join(directory, "bundle.js.map"));
    await assert.rejects(
      core.resolveRenderServeUrl({ runtimeSite: directory }),
      /bundle\.js\.map/,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("probes a real bundled video using media-parser", async () => {
  const file = path.join(root, "public", "assets", "builtin", "flowprompter-outro.mp4");
  const result = await core.probeMedia(file);
  assert.equal(result.path, file);
  assert.ok(result.sizeBytes > 0);
  assert.ok((result.durationSec ?? 0) > 0);
  assert.ok((result.width ?? 0) > 0);
  assert.ok((result.height ?? 0) > 0);
  assert.equal(result.fps, 30);
  assert.equal(result.container, "mp4");
  assert.ok(result.videoCodec);
});

test("builds an immutable cache bundle without nesting public/remotion-site", { timeout: 120_000 }, async () => {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-bundle-"));
  try {
    const [first, second] = await Promise.all([
      core.ensureBundle(root, { cacheDir: cache }),
      core.ensureBundle(root, { cacheDir: cache }),
    ]);
    assert.equal(first, second);
    assert.ok((await fs.stat(path.join(first, "index.html"))).isFile());
    assert.ok(
      (await fs.stat(path.join(first, "public", "assets", "builtin", "airport.jpg"))).isFile(),
    );
    await assert.rejects(fs.stat(path.join(first, "public", "remotion-site")));
    assert.equal(
      (await fs.readdir(cache)).filter((entry) => entry.includes(".partial")).length,
      0,
    );
  } finally {
    await fs.rm(cache, { recursive: true, force: true });
  }
});

test("renders all named scene stills and cleans cancelled partial output", { timeout: 120_000 }, async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-stills-"));
  try {
    const result = await core.renderSceneStills({
      root,
      config: configSchema.makeDefaultConfig(),
      files: {},
      options: { quality: "small", resolution: "720p", fps: 30 },
      outDir: directory,
    });
    assert.deepEqual(Object.keys(result.outputs).sort(), ["content", "ending", "opening"]);
    for (const scene of ["opening", "content", "ending"] as const) {
      const output = result.outputs[scene];
      assert.ok(output);
      assert.ok((await fs.stat(output.outputPath)).size > 0);
      assert.equal(output.scene, scene);
    }

    const controller = new AbortController();
    controller.abort(new Error("test cancellation"));
    await assert.rejects(
      core.renderStill({
        root,
        config: configSchema.makeDefaultConfig(),
        files: {},
        options: { quality: "small", resolution: "720p", fps: 30 },
        outPath: path.join(directory, "cancelled.jpg"),
        signal: controller.signal,
      }),
      (error: unknown) =>
        error instanceof core.RenderCancelledError && error.code === "RENDER_CANCELLED",
    );
    assert.equal(
      (await fs.readdir(directory)).filter((entry) => entry.includes(".partial")).length,
      0,
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
