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

async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const startedAt = Date.now();
  while (!(await predicate())) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

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

test("stale guard cleanup cannot remove a fresh successor guard", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-recovery-"));
  const lockPath = path.join(directory, "bundle.lock");
  const staleGuard = `${lockPath}.recovery-abandoned`;
  const successorGuard = `${lockPath}.recovery-successor`;
  await fs.writeFile(lockPath, "{}\n");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);
  await fs.writeFile(staleGuard, "{}\n");
  await fs.utimes(staleGuard, old, old);
  await fs.writeFile(
    successorGuard,
    `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
  );

  let visits = 0;
  try {
    const waiter = core.withFileLock(
      lockPath,
      async () => {
        visits += 1;
      },
      { staleMs: 10_000, retryMinMs: 1, retryMaxMs: 1, timeoutMs: 2_000 },
    );

    await waitFor(
      async () => (await fs.lstat(staleGuard).catch(() => null)) === null,
      "abandoned guard was not cleaned",
    );
    assert.equal(visits, 0, "no waiter may acquire while stale-lock recovery is in progress");
    assert.ok(await fs.lstat(successorGuard), "fresh successor guard must not be removed");
    await fs.unlink(successorGuard);
    await waiter;

    assert.equal(visits, 1);
    assert.equal(await fs.lstat(lockPath).catch(() => null), null);
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) => name.startsWith("bundle.lock.recovery-")),
      [],
    );
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a delayed stale recoverer restores rather than deletes a fresh successor lock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-stale-aba-"));
  const lockPath = path.join(directory, "bundle.lock");
  const displacedStalePath = `${lockPath}.displaced-stale`;
  await fs.writeFile(lockPath, "{}\n");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);

  const originalRename = fs.rename.bind(fs);
  let continueRename: (() => void) | undefined;
  const renameGate = new Promise<void>((resolve) => {
    continueRename = resolve;
  });
  let reportIntercepted: (() => void) | undefined;
  const intercepted = new Promise<void>((resolve) => {
    reportIntercepted = resolve;
  });
  let didIntercept = false;
  const patchedRename: typeof fs.rename = async (source, destination) => {
    if (
      !didIntercept &&
      String(source) === lockPath &&
      String(destination).startsWith(`${lockPath}.stale-`)
    ) {
      didIntercept = true;
      reportIntercepted?.();
      await renameGate;
    }
    return originalRename(source, destination);
  };
  Object.defineProperty(fs, "rename", { configurable: true, value: patchedRename });

  let visits = 0;
  const acquisition = core.withFileLock(
    lockPath,
    async () => {
      visits += 1;
    },
    { staleMs: 10, retryMinMs: 1, retryMaxMs: 1, timeoutMs: 2_000 },
  );
  try {
    await intercepted;
    const recoveryGuard = (await fs.readdir(directory))
      .map((name) => path.join(directory, name))
      .find((name) => path.basename(name).startsWith("bundle.lock.recovery-"));
    assert.ok(recoveryGuard, "the delayed recoverer must still own its guard");
    await originalRename(lockPath, displacedStalePath);
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "fresh-successor",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    continueRename?.();

    await waitFor(
      async () => {
        const originalGuardReleased = (await fs.lstat(recoveryGuard).catch(() => null)) === null;
        const successorRestored = await fs
          .readFile(lockPath, "utf8")
          .then((value) => JSON.parse(value).token === "fresh-successor")
          .catch(() => false);
        return originalGuardReleased && successorRestored;
      },
      "fresh successor lock was not restored after stale recovery raced",
    );
    assert.equal(visits, 0);
    await fs.unlink(lockPath);
    await acquisition;
    assert.equal(visits, 1);
  } finally {
    continueRename?.();
    Object.defineProperty(fs, "rename", { configurable: true, value: originalRename });
    await acquisition.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a released quarantined contender is recovered without leaving a ghost lock", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-release-token-"));
  const lockPath = path.join(directory, "bundle.lock");
  const displacedStalePath = path.join(directory, "displaced-stale");
  await fs.writeFile(lockPath, "{}\n");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);

  const originalReaddir = fs.readdir.bind(fs);
  const originalRename = fs.rename.bind(fs);
  const originalLink = fs.link.bind(fs);
  const firstScanSeen = deferred();
  const allowFirstScan = deferred();
  const secondGuardScanSeen = deferred();
  const allowSecondGuardScan = deferred();
  const staleRenameSeen = deferred();
  const allowStaleRename = deferred();
  const restoreLinkSeen = deferred();
  const allowRestoreLink = deferred();
  const releaseRenameFinished = deferred();
  let readdirCalls = 0;
  let staleRenameIntercepted = false;
  let restoreLinkIntercepted = false;

  const patchedReaddir: typeof fs.readdir = async (target, ...args) => {
    const names = await originalReaddir(target, ...args);
    if (String(target) !== directory) return names;
    readdirCalls += 1;
    if (readdirCalls === 1) {
      firstScanSeen.resolve();
      await allowFirstScan.promise;
    } else if (readdirCalls === 3) {
      secondGuardScanSeen.resolve();
      await allowSecondGuardScan.promise;
    }
    return names;
  };
  const patchedRename: typeof fs.rename = async (source, destination) => {
    const sourcePath = String(source);
    const destinationPath = String(destination);
    if (
      !staleRenameIntercepted &&
      sourcePath === lockPath &&
      destinationPath.startsWith(`${lockPath}.stale-`)
    ) {
      staleRenameIntercepted = true;
      staleRenameSeen.resolve();
      await allowStaleRename.promise;
    }
    if (sourcePath === lockPath && destinationPath.startsWith(`${lockPath}.released-`)) {
      try {
        return await originalRename(source, destination);
      } finally {
        releaseRenameFinished.resolve();
      }
    }
    return originalRename(source, destination);
  };
  const patchedLink: typeof fs.link = async (source, destination) => {
    if (
      !restoreLinkIntercepted &&
      String(source).startsWith(`${lockPath}.stale-`) &&
      String(destination) === lockPath
    ) {
      restoreLinkIntercepted = true;
      restoreLinkSeen.resolve();
      await allowRestoreLink.promise;
    }
    return originalLink(source, destination);
  };
  Object.defineProperty(fs, "readdir", { configurable: true, value: patchedReaddir });
  Object.defineProperty(fs, "rename", { configurable: true, value: patchedRename });
  Object.defineProperty(fs, "link", { configurable: true, value: patchedLink });

  let active = 0;
  let maximumActive = 0;
  let visits = 0;
  const visit = async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    visits += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };
  const options = { staleMs: 10, retryMinMs: 1, retryMaxMs: 1, timeoutMs: 2_000 };
  let contender: Promise<void> | undefined;
  let recoverer: Promise<void> | undefined;
  try {
    contender = core.withFileLock(lockPath, visit, options);
    await firstScanSeen.promise;
    recoverer = core.withFileLock(lockPath, visit, options);
    await staleRenameSeen.promise;

    // Remove the stale inode after the recoverer inspected it. The contender
    // still owns a directory snapshot from before the recovery guard existed.
    await originalRename(lockPath, displacedStalePath);
    allowFirstScan.resolve();
    await secondGuardScanSeen.promise;

    // The delayed recoverer now quarantines the contender's fresh inode. Hold
    // its no-clobber restore until the contender observes the guard and marks
    // that inode released through its still-open file descriptor.
    allowStaleRename.resolve();
    await restoreLinkSeen.promise;
    allowSecondGuardScan.resolve();
    await releaseRenameFinished.promise;

    const quarantineName = (await originalReaddir(directory)).find((name) =>
      name.startsWith("bundle.lock.stale-"),
    );
    assert.ok(quarantineName, "the fresh contender inode must still be quarantined");
    const records = (await fs.readFile(path.join(directory, quarantineName), "utf8"))
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { token?: unknown; released?: unknown });
    assert.equal(records.length, 2);
    assert.equal(records[1]?.released, records[0]?.token);

    allowRestoreLink.resolve();
    const settled = await Promise.allSettled([contender, recoverer]);
    assert.deepEqual(
      settled.map((result) => result.status),
      ["fulfilled", "fulfilled"],
    );
    assert.equal(maximumActive, 1);
    assert.equal(visits, 2);
    assert.deepEqual((await originalReaddir(directory)).sort(), ["displaced-stale"]);
  } finally {
    allowFirstScan.resolve();
    allowSecondGuardScan.resolve();
    allowStaleRename.resolve();
    allowRestoreLink.resolve();
    Object.defineProperty(fs, "readdir", { configurable: true, value: originalReaddir });
    Object.defineProperty(fs, "rename", { configurable: true, value: originalRename });
    Object.defineProperty(fs, "link", { configurable: true, value: originalLink });
    await Promise.allSettled([contender, recoverer].filter(Boolean) as Promise<void>[]);
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("lock release restores rather than deletes a replacement inode", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-release-aba-"));
  const lockPath = path.join(directory, "bundle.lock");
  const displacedOwnerPath = `${lockPath}.displaced-owner`;
  const originalRename = fs.rename.bind(fs);
  let continueRename: (() => void) | undefined;
  const renameGate = new Promise<void>((resolve) => {
    continueRename = resolve;
  });
  let reportIntercepted: (() => void) | undefined;
  const intercepted = new Promise<void>((resolve) => {
    reportIntercepted = resolve;
  });
  let didIntercept = false;
  const patchedRename: typeof fs.rename = async (source, destination) => {
    if (
      !didIntercept &&
      String(source) === lockPath &&
      String(destination).startsWith(`${lockPath}.released-`)
    ) {
      didIntercept = true;
      reportIntercepted?.();
      await renameGate;
    }
    return originalRename(source, destination);
  };
  Object.defineProperty(fs, "rename", { configurable: true, value: patchedRename });

  const holder = core.withFileLock(lockPath, async () => {});
  try {
    await intercepted;
    await originalRename(lockPath, displacedOwnerPath);
    await fs.writeFile(
      lockPath,
      `${JSON.stringify({
        pid: process.pid,
        token: "fresh-successor",
        createdAt: new Date().toISOString(),
      })}\n`,
    );
    continueRename?.();
    await holder;

    const successor = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: unknown };
    assert.equal(successor.token, "fresh-successor");
    assert.ok(await fs.lstat(displacedOwnerPath), "the original owned inode remains isolated");
    assert.deepEqual(
      (await fs.readdir(directory)).filter(
        (name) => name.startsWith("bundle.lock.recovery-") || name.includes(".released-"),
      ),
      [],
    );
  } finally {
    continueRename?.();
    Object.defineProperty(fs, "rename", { configurable: true, value: originalRename });
    await holder.catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("stale recovery never removes a non-regular lock path", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-symlink-"));
  const lockPath = path.join(directory, "bundle.lock");
  const targetPath = path.join(directory, "user-file");
  const original = "user-owned contents\n";
  await fs.writeFile(targetPath, original);
  await fs.symlink(targetPath, lockPath);

  try {
    await assert.rejects(
      core.withFileLock(lockPath, async () => assert.fail("symlink lock was acquired"), {
        staleMs: 1,
        retryMinMs: 1,
        retryMaxMs: 1,
        timeoutMs: 30,
      }),
      /等待缓存操作锁超时/,
    );
    assert.equal((await fs.lstat(lockPath)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(targetPath, "utf8"), original);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("a non-regular ABA replacement is preserved in a reported quarantine", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-lock-directory-aba-"));
  const lockPath = path.join(directory, "bundle.lock");
  const displacedStalePath = path.join(directory, "displaced-stale");
  await fs.writeFile(lockPath, "{}\n");
  const old = new Date(Date.now() - 60_000);
  await fs.utimes(lockPath, old, old);

  const originalRename = fs.rename.bind(fs);
  const staleRenameSeen = deferred();
  const allowStaleRename = deferred();
  let staleRenameIntercepted = false;
  const patchedRename: typeof fs.rename = async (source, destination) => {
    if (
      !staleRenameIntercepted &&
      String(source) === lockPath &&
      String(destination).startsWith(`${lockPath}.stale-`)
    ) {
      staleRenameIntercepted = true;
      staleRenameSeen.resolve();
      await allowStaleRename.promise;
    }
    return originalRename(source, destination);
  };
  Object.defineProperty(fs, "rename", { configurable: true, value: patchedRename });

  const attempt = core.withFileLock(lockPath, async () => assert.fail("directory lock was acquired"), {
    staleMs: 10,
    retryMinMs: 1,
    retryMaxMs: 1,
    timeoutMs: 2_000,
  });
  try {
    await staleRenameSeen.promise;
    await originalRename(lockPath, displacedStalePath);
    await fs.mkdir(lockPath);
    await fs.writeFile(path.join(lockPath, "owned.txt"), "preserve me\n");
    allowStaleRename.resolve();

    let failure: unknown;
    try {
      await attempt;
    } catch (error) {
      failure = error;
    }
    assert.ok(failure instanceof Error);
    const quarantineName = (await fs.readdir(directory)).find((name) =>
      name.startsWith("bundle.lock.stale-"),
    );
    assert.ok(quarantineName, "the replacement directory must remain in quarantine");
    const quarantinePath = path.join(directory, quarantineName);
    assert.match(
      failure.message,
      new RegExp(quarantinePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
    );
    assert.equal(await fs.readFile(path.join(quarantinePath, "owned.txt"), "utf8"), "preserve me\n");
    assert.equal(await fs.lstat(lockPath).catch(() => null), null);
    assert.deepEqual(
      (await fs.readdir(directory)).filter((name) => name.startsWith("bundle.lock.recovery-")),
      [],
    );
  } finally {
    allowStaleRename.resolve();
    Object.defineProperty(fs, "rename", { configurable: true, value: originalRename });
    await attempt.catch(() => {});
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
