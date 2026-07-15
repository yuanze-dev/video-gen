import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledDirectory = await fs.mkdtemp(path.join(root, ".doctor-test-"));
const compiledFile = path.join(compiledDirectory, "doctor.mjs");
const temporaryDirectories: string[] = [];

type DoctorModule = typeof import("../cli/doctor.ts");
let subject: DoctorModule;

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `littlestart-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

before(async () => {
  await build({
    entryPoints: [path.join(root, "cli", "doctor.ts")],
    outfile: compiledFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  subject = (await import(`${pathToFileURL(compiledFile).href}?t=${Date.now()}`)) as DoctorModule;
});

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  await fs.rm(compiledDirectory, { recursive: true, force: true });
});

const fakeRenderer = {
  ensureBrowser: async () => ({ type: "no-browser" as const }),
};

test("read-only doctor leaves no cache probe or browser directory and never downloads", async () => {
  const parent = await temporaryDirectory("doctor-readonly");
  const cacheDir = path.join(parent, "nested", "cache");
  let ensureCalls = 0;

  const result = await subject.doctor({
    cacheDir,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "darwin",
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      packaged: false,
      importRenderer: async () => fakeRenderer,
      inspectBrowser: async () => ({ status: "missing" }),
      ensureBrowser: async () => {
        ensureCalls += 1;
        return { type: "no-browser" };
      },
    },
  });

  assert.equal(ensureCalls, 0);
  assert.equal(await fs.lstat(cacheDir).catch(() => null), null);
  assert.equal(result.ok, false);
  assert.equal(result.checks.find((check) => check.id === "cache")?.status, "ok");
  assert.equal(result.checks.find((check) => check.id === "chromium")?.status, "error");
});

test("doctor --fix installs below the selected cache and restores cwd", async () => {
  const parent = await temporaryDirectory("doctor-fix");
  const cacheDir = path.join(parent, "cache");
  const originalCwd = process.cwd();
  let ensureCalls = 0;

  const result = await subject.doctor({
    cacheDir,
    fix: true,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "darwin",
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      packaged: false,
      importRenderer: async () => fakeRenderer,
      inspectBrowser: async () => ({ status: "missing" }),
      ensureBrowser: async () => {
        ensureCalls += 1;
        const browserRoot = path.join(cacheDir, "browser");
        assert.equal(process.cwd(), await fs.realpath(browserRoot));
        const executable = path.join(browserRoot, "node_modules", ".remotion", "fake-chromium");
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, "binary");
        return { type: "local-puppeteer-browser", path: executable };
      },
    },
  });

  assert.equal(ensureCalls, 1);
  assert.equal(process.cwd(), originalCwd);
  assert.equal(result.ok, true);
  const chromium = result.checks.find((check) => check.id === "chromium");
  assert.equal(chromium?.status, "ok");
  assert.match(String(chromium?.details?.path), /cache\/browser\/node_modules\/\.remotion/);
  assert.equal(
    JSON.parse(await fs.readFile(path.join(cacheDir, "browser", "package.json"), "utf8")).private,
    true,
  );
});

test("offline fix reports a missing browser without creating or downloading", async () => {
  const parent = await temporaryDirectory("doctor-offline");
  const cacheDir = path.join(parent, "cache");
  let ensureCalls = 0;
  const result = await subject.doctor({
    cacheDir,
    fix: true,
    offline: true,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "linux",
      arch: "x64",
      homeDir: path.join(parent, "home"),
      packaged: false,
      importRenderer: async () => fakeRenderer,
      inspectBrowser: async () => ({ status: "missing" }),
      ensureBrowser: async () => {
        ensureCalls += 1;
        return { type: "no-browser" };
      },
    },
  });

  assert.equal(ensureCalls, 0);
  assert.equal(await fs.lstat(cacheDir).catch(() => null), null);
  assert.equal(result.ok, false);
  assert.match(result.checks.find((check) => check.id === "chromium")?.message ?? "", /离线/);
});

test("packaged doctor validates both runtime index and metadata", async () => {
  const parent = await temporaryDirectory("doctor-runtime");
  const runtimeSite = path.join(parent, "runtime", "remotion-site");
  await fs.mkdir(runtimeSite, { recursive: true });
  const index = "<!doctype html>";
  await fs.writeFile(path.join(runtimeSite, "index.html"), index);
  const bundleDigest = `sha256:${crypto
    .createHash("sha256")
    .update("index.html")
    .update("\0")
    .update(index)
    .update("\0")
    .digest("hex")}`;
  await fs.writeFile(
    path.join(parent, "runtime", "runtime.json"),
    JSON.stringify({
      protocolVersion: "1",
      template: "teleprompter@1.0.0",
      composition: "Teleprompter",
      remotionVersion: "4.0.481",
      templateDigest: `sha256:${"1".repeat(64)}`,
      bundleDigest,
    }),
  );
  const options = {
    cacheDir: path.join(parent, "cache"),
    runtimeSite,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "darwin" as const,
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      packaged: true,
      importRenderer: async () => fakeRenderer,
      inspectBrowser: async () => ({ status: "missing" as const }),
    },
  };

  const valid = await subject.doctor(options);
  assert.equal(valid.checks.find((check) => check.id === "runtime")?.status, "ok");
  await fs.writeFile(path.join(runtimeSite, "index.html"), `${index}<!-- tampered -->`);
  const tampered = await subject.doctor(options);
  assert.equal(tampered.checks.find((check) => check.id === "runtime")?.status, "error");
  await fs.writeFile(path.join(runtimeSite, "index.html"), index);
  await fs.writeFile(path.join(parent, "runtime", "runtime.json"), "{}");
  const invalid = await subject.doctor(options);
  assert.equal(invalid.checks.find((check) => check.id === "runtime")?.status, "error");
});

test("doctor actually launches Chromium and creates a WebGL context", async () => {
  const parent = await temporaryDirectory("doctor-webgl-probe");
  const cacheDir = path.join(parent, "cache");
  const browserPath = path.join(parent, "custom-browser", "fake-chrome");
  await fs.mkdir(path.dirname(browserPath), { recursive: true });
  await fs.writeFile(browserPath, "browser");
  await fs.chmod(browserPath, 0o755);
  let closed = false;
  let openedGl: string | null = null;
  let openedBrowser: string | null = null;
  const runtimeRenderer = {
    ...fakeRenderer,
    openBrowser: async (
      _browser: string,
      options?: { browserExecutable?: string | null; chromiumOptions?: { gl?: string } },
    ) => {
      openedGl = options?.chromiumOptions?.gl ?? null;
      openedBrowser = options?.browserExecutable ?? null;
      return {
      pages: async () => [
        {
          evaluate: async () => ({
            webgl: true,
            version: "WebGL 2.0",
            renderer: "ANGLE SwiftShader",
          }),
        },
      ],
      close: async () => {
        closed = true;
      },
      };
    },
  } as unknown as Awaited<
    ReturnType<NonNullable<import("../cli/doctor.ts").DoctorDependencies["importRenderer"]>>
  >;

  const result = await subject.doctor({
    cacheDir,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "darwin",
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      packaged: false,
      env: {
        LITTLESTART_CHROMIUM_GL: "swangle",
        REMOTION_BROWSER_EXECUTABLE: browserPath,
      },
      importRenderer: async () => runtimeRenderer,
      inspectBrowser: async () => {
        throw new Error("自定义 Chromium 不应检查 CLI 缓存");
      },
    },
  });

  const webgl = result.checks.find((check) => check.id === "webgl");
  assert.equal(webgl?.status, "ok");
  assert.equal(webgl?.details?.runtimeProbe, true);
  assert.equal(webgl?.details?.version, "WebGL 2.0");
  assert.equal(webgl?.details?.rendererMode, "swangle");
  assert.equal(openedGl, "swangle");
  assert.equal(openedBrowser, await fs.realpath(browserPath));
  assert.match(
    result.checks.find((candidate) => candidate.id === "chromium")?.message ?? "",
    /自定义 Chromium/,
  );
  assert.equal(closed, true);
});

test("invalid custom Chromium is reported without downloading", async () => {
  const parent = await temporaryDirectory("doctor-invalid-custom-browser");
  let ensureCalls = 0;
  const configured = path.join(parent, "missing-chrome");
  const result = await subject.doctor({
    cacheDir: path.join(parent, "cache"),
    fix: true,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "darwin",
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      packaged: false,
      env: { REMOTION_BROWSER_EXECUTABLE: configured },
      importRenderer: async () => fakeRenderer,
      inspectBrowser: async () => {
        throw new Error("自定义 Chromium 不应检查 CLI 缓存");
      },
      ensureBrowser: async () => {
        ensureCalls += 1;
        return { type: "no-browser" };
      },
    },
  });

  const chromium = result.checks.find((candidate) => candidate.id === "chromium");
  assert.equal(result.ok, false);
  assert.equal(ensureCalls, 0);
  assert.equal(chromium?.status, "error");
  assert.equal(chromium?.details?.path, path.resolve(configured));
  assert.match(chromium?.message ?? "", /REMOTION_BROWSER_EXECUTABLE/);
  assert.equal(chromium?.fixable, false);
});

test("doctor reports an invalid Chromium GL environment value", async () => {
  const parent = await temporaryDirectory("doctor-invalid-gl");
  let inspectCalls = 0;
  let ensureCalls = 0;
  const result = await subject.doctor({
    cacheDir: path.join(parent, "cache"),
    fix: true,
    dependencies: {
      nodeVersion: "22.14.0",
      platform: "linux",
      arch: "x64",
      homeDir: path.join(parent, "home"),
      packaged: false,
      env: { LITTLESTART_CHROMIUM_GL: "hardware-magic" },
      importRenderer: async () => fakeRenderer,
      inspectBrowser: async () => {
        inspectCalls += 1;
        return { status: "missing" };
      },
      ensureBrowser: async () => {
        ensureCalls += 1;
        return { type: "no-browser" };
      },
    },
  });

  const check = result.checks.find((candidate) => candidate.id === "chromium-gl");
  assert.equal(result.ok, false);
  assert.equal(check?.status, "error");
  assert.match(check?.message ?? "", /angle \| swangle/);
  assert.deepEqual(check?.details?.allowed, ["angle", "swangle"]);
  assert.equal(inspectCalls, 0);
  assert.equal(ensureCalls, 0);
  assert.match(
    result.checks.find((candidate) => candidate.id === "chromium")?.message ?? "",
    /跳过浏览器检查和下载/,
  );
});

test("browser install restores cwd even when ensureBrowser fails", async () => {
  const parent = await temporaryDirectory("doctor-fix-failure");
  const cacheDir = path.join(parent, "cache");
  const originalCwd = process.cwd();

  await assert.rejects(
    subject.ensureCliBrowser({
      cacheDir,
      fix: true,
      dependencies: {
        platform: "darwin",
        arch: "arm64",
        homeDir: path.join(parent, "home"),
        inspectBrowser: async () => ({ status: "missing" }),
        importRenderer: async () => fakeRenderer,
        ensureBrowser: async () => {
          assert.equal(process.cwd(), await fs.realpath(path.join(cacheDir, "browser")));
          throw new Error("simulated download failure");
        },
      },
    }),
    /simulated download failure/,
  );
  assert.equal(process.cwd(), originalCwd);
});

test("browser installs serialize process-wide cwd changes", async () => {
  const parent = await temporaryDirectory("doctor-concurrent-fix");
  const originalCwd = process.cwd();
  let active = 0;
  let maximumActive = 0;

  const install = (name: string) => {
    const cacheDir = path.join(parent, name);
    return subject.ensureCliBrowser({
      cacheDir,
      fix: true,
      dependencies: {
        platform: "darwin",
        arch: "arm64",
        homeDir: path.join(parent, "home"),
        inspectBrowser: async () => ({ status: "missing" }),
        importRenderer: async () => fakeRenderer,
        ensureBrowser: async () => {
          active += 1;
          maximumActive = Math.max(maximumActive, active);
          const browserRoot = process.cwd();
          await new Promise((resolve) => setTimeout(resolve, 15));
          const executable = path.join(browserRoot, "node_modules", ".remotion", "fake");
          await fs.mkdir(path.dirname(executable), { recursive: true });
          await fs.writeFile(executable, "binary");
          active -= 1;
          return { type: "local-puppeteer-browser", path: executable };
        },
      },
    });
  };

  const [first, second] = await Promise.all([install("one"), install("two")]);
  assert.equal(maximumActive, 1);
  assert.equal(process.cwd(), originalCwd);
  assert.match(first.path ?? "", /one\/browser/);
  assert.match(second.path ?? "", /two\/browser/);
});

test("browser install lock wait is immediately cancellable", async () => {
  const parent = await temporaryDirectory("doctor-browser-lock-abort");
  const cacheDir = path.join(parent, "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  const browserLock = path.join(cacheDir, ".browser-install.lock");
  await fs.writeFile(
    browserLock,
    `${JSON.stringify({ pid: process.pid, token: "test-owner", createdAt: new Date().toISOString() })}\n`,
  );
  const controller = new AbortController();
  let ensureCalls = 0;
  const startedAt = Date.now();

  try {
    const waiting = subject.ensureCliBrowser({
      cacheDir,
      fix: true,
      signal: controller.signal,
      dependencies: {
        platform: "darwin",
        arch: "arm64",
        homeDir: path.join(parent, "home"),
        inspectBrowser: async () => ({ status: "missing" }),
        importRenderer: async () => fakeRenderer,
        ensureBrowser: async () => {
          ensureCalls += 1;
          return { type: "no-browser" };
        },
      },
    });
    setTimeout(() => controller.abort(new Error("cancel browser lock wait")), 20);
    await assert.rejects(waiting, (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.name, "AbortError");
      return true;
    });
    assert.ok(Date.now() - startedAt < 500);
    assert.equal(ensureCalls, 0);
    assert.ok(await fs.stat(browserLock));
    assert.equal(
      await fs.lstat(path.join(cacheDir, ".cache-maintenance.lock")).catch(() => null),
      null,
    );
  } finally {
    await fs.rm(browserLock, { force: true });
  }
});

test("prune waits for an active browser installation before mutating cache", async () => {
  const parent = await temporaryDirectory("doctor-prune-browser-race");
  const cacheDir = path.join(parent, "cache");
  const stalePartial = path.join(cacheDir, "remotion-bundles", ".old.partial");
  await fs.mkdir(stalePartial, { recursive: true });
  await fs.writeFile(path.join(stalePartial, "data"), "stale");
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
  await fs.utimes(stalePartial, old, old);

  let markInstallStarted: (() => void) | undefined;
  const installStarted = new Promise<void>((resolve) => {
    markInstallStarted = resolve;
  });
  let releaseInstall: (() => void) | undefined;
  const installRelease = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  const installation = subject.ensureCliBrowser({
    cacheDir,
    fix: true,
    dependencies: {
      platform: "darwin",
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      inspectBrowser: async () => ({ status: "missing" }),
      importRenderer: async () => fakeRenderer,
      ensureBrowser: async () => {
        markInstallStarted?.();
        await installRelease;
        const executable = path.join(process.cwd(), "node_modules", ".remotion", "fake");
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, "binary");
        return { type: "local-puppeteer-browser", path: executable };
      },
    },
  });
  try {
    await installStarted;

    let pruneSettled = false;
    const pruning = subject.pruneCache(cacheDir, {
      homeDir: path.join(parent, "home"),
      now: Date.now(),
    }).finally(() => {
      pruneSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(pruneSettled, false);
    assert.ok(await fs.stat(stalePartial));

    releaseInstall?.();
    const [browser, pruned] = await Promise.all([installation, pruning]);
    assert.equal(browser.ok, true);
    assert.deepEqual(pruned.removed, ["remotion-bundles/.old.partial"]);
    assert.equal(await fs.lstat(stalePartial).catch(() => null), null);
    assert.ok(await fs.stat(browser.path ?? ""));
  } finally {
    releaseInstall?.();
    await installation.catch(() => {});
  }
});

test("clear waits for browser installation and never deletes its active workspace", async () => {
  const parent = await temporaryDirectory("doctor-clear-browser-race");
  const cacheDir = path.join(parent, "cache");
  await fs.mkdir(cacheDir, { recursive: true });
  await fs.writeFile(path.join(cacheDir, "stale.txt"), "stale");

  let markInstallStarted: (() => void) | undefined;
  const installStarted = new Promise<void>((resolve) => {
    markInstallStarted = resolve;
  });
  let releaseInstall: (() => void) | undefined;
  const installRelease = new Promise<void>((resolve) => {
    releaseInstall = resolve;
  });
  const installation = subject.ensureCliBrowser({
    cacheDir,
    fix: true,
    dependencies: {
      platform: "darwin",
      arch: "arm64",
      homeDir: path.join(parent, "home"),
      inspectBrowser: async () => ({ status: "missing" }),
      importRenderer: async () => fakeRenderer,
      ensureBrowser: async () => {
        markInstallStarted?.();
        await installRelease;
        const executable = path.join(process.cwd(), "node_modules", ".remotion", "fake");
        await fs.mkdir(path.dirname(executable), { recursive: true });
        await fs.writeFile(executable, "binary");
        return { type: "local-puppeteer-browser", path: executable };
      },
    },
  });
  try {
    await installStarted;

    let clearSettled = false;
    const clearing = subject.clearCache(cacheDir, {
      homeDir: path.join(parent, "home"),
      force: true,
    }).finally(() => {
      clearSettled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(clearSettled, false);
    assert.ok(await fs.stat(path.join(cacheDir, "browser", "package.json")));

    releaseInstall?.();
    const browser = await installation;
    assert.equal(browser.ok, true);
    const cleared = await clearing;
    assert.deepEqual(cleared.removed.sort(), ["browser", "stale.txt"]);
    assert.deepEqual(await fs.readdir(cacheDir), []);
  } finally {
    releaseInstall?.();
    await installation.catch(() => {});
  }
});

test("cache APIs reject dangerous roots and clear requires force", async () => {
  const home = await temporaryDirectory("doctor-danger-home");
  await assert.rejects(subject.listCache(path.parse(home).root, { homeDir: home }), /根目录/);
  await assert.rejects(subject.listCache(home, { homeDir: home }), /主目录/);
  await assert.rejects(subject.listCache(path.join(path.parse(home).root, "tmp"), { homeDir: home }), /过短/);

  const cache = path.join(home, "safe", "cache");
  await fs.mkdir(cache, { recursive: true });
  await assert.rejects(subject.clearCache(cache, { homeDir: home }), /force=true/);
});

test("list and prune count content while preserving immutable bundles and browser data", async () => {
  const parent = await temporaryDirectory("doctor-prune");
  const cache = path.join(parent, "cache");
  const bundles = path.join(cache, "remotion-bundles");
  const canonical = path.join(bundles, "bundle-a1b2c3d4");
  const rebuild = path.join(bundles, "bundle-a1b2c3d4-rebuild-old");
  const oldPartial = path.join(bundles, ".bundle-a1b2c3d4-old.partial");
  const freshPartial = path.join(bundles, ".bundle-a1b2c3d4-fresh.partial");
  const browser = path.join(cache, "browser", "node_modules", ".remotion");
  for (const directory of [canonical, rebuild, oldPartial, freshPartial, browser]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "data"), directory.includes("browser") ? "browser" : "bundle");
  }
  const now = Date.now();
  const old = new Date(now - 10 * 24 * 60 * 60 * 1_000);
  await fs.utimes(rebuild, old, old);
  await fs.utimes(oldPartial, old, old);

  const listed = await subject.listCache(cache, { homeDir: path.join(parent, "home") });
  assert.equal(listed.exists, true);
  assert.ok(listed.bytes >= "browser".length + "bundle".length * 4);
  assert.ok(listed.items >= 5);
  assert.deepEqual(listed.entries.map((entry) => entry.name), ["browser", "remotion-bundles"]);

  const pruned = await subject.pruneCache(cache, {
    homeDir: path.join(parent, "home"),
    now,
  });
  assert.ok(pruned.bytes > 0);
  assert.ok(pruned.items >= 4);
  assert.deepEqual(pruned.removed.sort(), [
    "remotion-bundles/.bundle-a1b2c3d4-old.partial",
    "remotion-bundles/bundle-a1b2c3d4-rebuild-old",
  ]);
  assert.ok(await fs.stat(canonical));
  assert.ok(await fs.stat(freshPartial));
  assert.ok(await fs.stat(browser));
});

test("prune and clear unlink symlinks without touching targets outside the cache", async () => {
  const parent = await temporaryDirectory("doctor-symlink");
  const cache = path.join(parent, "cache");
  const outside = path.join(parent, "outside");
  await fs.mkdir(cache, { recursive: true });
  await fs.mkdir(outside, { recursive: true });
  const outsideFile = path.join(outside, "keep.txt");
  await fs.writeFile(outsideFile, "keep");

  const staleLink = path.join(cache, ".outside.partial");
  await fs.symlink(outside, staleLink);
  const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1_000);
  await fs.lutimes(staleLink, old, old);
  const listed = await subject.listCache(cache, { homeDir: path.join(parent, "home") });
  assert.equal(listed.entries[0]?.kind, "symlink");

  const pruned = await subject.pruneCache(cache, { homeDir: path.join(parent, "home") });
  assert.deepEqual(pruned.removed, [".outside.partial"]);
  assert.equal(await fs.lstat(staleLink).catch(() => null), null);
  assert.equal(await fs.readFile(outsideFile, "utf8"), "keep");

  const clearLink = path.join(cache, "outside-link");
  await fs.symlink(outside, clearLink);
  const cleared = await subject.clearCache(cache, {
    homeDir: path.join(parent, "home"),
    force: true,
  });
  assert.deepEqual(cleared.removed, ["outside-link"]);
  assert.equal(await fs.readFile(outsideFile, "utf8"), "keep");
});
