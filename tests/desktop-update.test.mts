import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  classifyDesktopUpdateClient,
  compareDesktopVersions,
  inferDesktopClientVersion,
  isDesktopUpdateAvailable,
} from "../lib/desktop-bridge.ts";
import {
  canAutoCheckDesktopUpdate,
  deriveDesktopUpdatePresentation,
  desktopReleaseIsAvailable,
  parseDesktopReleaseInfo,
  type DesktopReleaseInfo,
} from "../lib/desktop-update.ts";
import {
  isDesktopReleaseReady,
  readDesktopManifestVersion,
  selectDesktopRelease,
} from "../lib/desktop-release.ts";
import { createExportSessionActivityStore } from "../lib/export-session.ts";
import {
  createDesktopUpdaterController,
  type AutoUpdaterLike,
} from "../electron/updater-controller.ts";
import {
  beginExportWithUpdateInterlock,
  startRenderWithUpdateInterlock,
} from "../electron/update-export-interlock.ts";
import { createUpdateRestartGuard } from "../electron/update-restart-guard.ts";

const CURRENT_VERSION = "0.2.2";
const NEXT_VERSION = "0.2.3";

test("maps every shipped desktop generation without treating a feature flag as a version", () => {
  const cases = [
    [undefined, "hidden", null],
    [{ isAvailable: false }, "hidden", null],
    [{ isAvailable: true }, "manual", "0.1.0"],
    [{ isAvailable: true, supportsExportOptions: true }, "legacy-auto", "0.2.0"],
    [
      { isAvailable: true, supportsExportOptions: true, supportsEndingVideo: true },
      "legacy-auto",
      "0.2.1",
    ],
    [
      {
        isAvailable: true,
        supportsExportOptions: true,
        supportsEndingVideo: true,
        supportsUpdateStatus: true,
      },
      "legacy-auto",
      "0.2.2",
    ],
    [
      {
        isAvailable: true,
        supportsExportOptions: true,
        supportsEndingVideo: true,
        supportsUpdateStatus: true,
        supportsSafeUpdateRestart: true,
      },
      "observable",
      "0.2.3",
    ],
  ] as const;

  for (const [bridge, mode, version] of cases) {
    assert.equal(classifyDesktopUpdateClient(bridge), mode);
    assert.equal(inferDesktopClientVersion(bridge), version);
  }
});

test("compares desktop semantic versions numerically and handles prereleases", () => {
  assert.equal(compareDesktopVersions("0.2.1", "v0.2.2"), -1);
  assert.equal(compareDesktopVersions("0.2.2", "v0.2.2"), 0);
  assert.equal(compareDesktopVersions("0.2.10", "0.2.2"), 1);
  assert.equal(compareDesktopVersions("1.0.0", "0.99.99"), 1);
  assert.equal(compareDesktopVersions("0.2.2-beta.1", "0.2.2"), -1);
  assert.equal(compareDesktopVersions("not-a-version", "0.2.2"), null);
});

test("advertises a verified update only to an older desktop without implying a block", () => {
  const base = { releaseAvailable: true, latestVersion: "v0.2.2" };
  assert.equal(
    isDesktopUpdateAvailable({ ...base, mode: "hidden", currentVersion: null }),
    false,
  );
  assert.equal(
    isDesktopUpdateAvailable({ ...base, mode: "legacy-auto", currentVersion: "0.2.1" }),
    true,
  );
  assert.equal(
    isDesktopUpdateAvailable({ ...base, mode: "observable", currentVersion: "0.2.2" }),
    false,
  );
  assert.equal(
    isDesktopUpdateAvailable({ ...base, mode: "observable", currentVersion: "0.2.3" }),
    false,
  );
  assert.equal(
    isDesktopUpdateAvailable({
      ...base,
      releaseAvailable: false,
      mode: "manual",
      currentVersion: "0.1.0",
    }),
    false,
  );
});

test("reads and verifies release assets before advertising availability", () => {
  assert.equal(readDesktopManifestVersion("version: 0.2.2\nfiles: []\n"), "0.2.2");
  assert.equal(readDesktopManifestVersion("version: '0.2.2'\n"), "0.2.2");
  assert.equal(readDesktopManifestVersion("files: []\n"), null);

  const ready = {
    manifestOk: true,
    installerOk: true,
    manifest: "version: 0.2.2\nfiles: []\n",
    requiredVersion: "v0.2.2",
  };
  assert.equal(isDesktopReleaseReady(ready), true);
  assert.equal(isDesktopReleaseReady({ ...ready, installerOk: false }), false);
  assert.equal(isDesktopReleaseReady({ ...ready, manifestOk: false }), false);
  assert.equal(isDesktopReleaseReady({ ...ready, manifest: "version: 0.2.1\n" }), false);
});

test("keeps the verified fallback discoverable until every target asset is ready", () => {
  const target = { available: false, version: "v0.2.2" };
  const fallback = { available: true, version: "v0.2.1" };
  assert.equal(selectDesktopRelease([target, fallback]).version, "v0.2.1");
  assert.equal(
    selectDesktopRelease([{ ...target, available: true }, fallback]).version,
    "v0.2.2",
  );
  assert.equal(
    selectDesktopRelease([target, { ...fallback, available: false }]).version,
    "v0.2.1",
  );
});

test("release metadata and the release API target stay synchronized", () => {
  const packageJson = JSON.parse(
    readFileSync(new URL("../package.json", import.meta.url), "utf8"),
  ) as { version: string };
  const packageLock = JSON.parse(
    readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"),
  ) as { packages: Record<string, { version?: string }> };
  const route = readFileSync(new URL("../app/api/desktop-release/route.ts", import.meta.url), "utf8");
  const target = /TARGET_RELEASE_TAG = "([^"]+)"/.exec(route)?.[1];
  const fallback = /FALLBACK_RELEASE_TAG = "([^"]+)"/.exec(route)?.[1];

  assert.equal(target, `v${packageJson.version}`);
  assert.equal(packageLock.packages[""].version, packageJson.version);
  assert.equal(typeof fallback, "string");
  assert.equal(compareDesktopVersions(fallback!, target!), -1);
  assert.doesNotMatch(route, /required:\s*true/);
  assert.equal(route.match(/required:\s*false/g)?.length, 2);
});

const VERIFIED_RELEASE: DesktopReleaseInfo = {
  available: true,
  required: false,
  version: `v${NEXT_VERSION}`,
  downloadUrl: `https://example.com/littlestart-${NEXT_VERSION}.dmg`,
  minimumSupportedVersion: null,
};

function updatePresentation({
  mode = "observable",
  release = VERIFIED_RELEASE,
  updateState = null,
  updateStateReady = true,
  exportActive = false,
  downloadStalled = false,
}: Partial<Parameters<typeof deriveDesktopUpdatePresentation>[0]> = {}) {
  return deriveDesktopUpdatePresentation({
    mode,
    inferredVersion: mode === "manual" ? "0.1.0" : CURRENT_VERSION,
    release,
    updateState,
    updateStateReady,
    exportActive,
    downloadStalled,
  });
}

test("a remotely updated Web UI never exposes restart to the unsafe v0.2.2 protocol", () => {
  const mode = classifyDesktopUpdateClient({
    isAvailable: true,
    supportsExportOptions: true,
    supportsEndingVideo: true,
    supportsUpdateStatus: true,
  });
  assert.equal(mode, "legacy-auto");

  const presentation = updatePresentation({
    mode,
    updateState: {
      revision: 7,
      status: "ready",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
    },
  });
  assert.equal(presentation.kind, "legacy");
  assert.equal(presentation.primaryAction, "manual");
  assert.notEqual(presentation.primaryAction, "restart");
});

test("supports the old release response while separating availability from blocking", () => {
  assert.equal(desktopReleaseIsAvailable(VERIFIED_RELEASE), true);
  assert.equal(
    desktopReleaseIsAvailable({ ...VERIFIED_RELEASE, available: false, required: true }),
    true,
  );
  assert.equal(
    desktopReleaseIsAvailable({ ...VERIFIED_RELEASE, available: false, required: false }),
    false,
  );
});

test("parses both release API generations and rejects incomplete wire responses", () => {
  assert.deepEqual(
    parseDesktopReleaseInfo({
      required: true,
      version: "v0.2.2",
      downloadUrl: "https://example.com/v0.2.2.dmg",
    }),
    {
      available: true,
      required: true,
      version: "v0.2.2",
      downloadUrl: "https://example.com/v0.2.2.dmg",
      releasePageUrl: undefined,
      downloadSizeBytes: undefined,
      minimumSupportedVersion: null,
    },
  );
  assert.equal(
    parseDesktopReleaseInfo({ available: true, version: "v0.2.3" }),
    null,
  );
  assert.equal(parseDesktopReleaseInfo(null), null);
});

test("a newly published release wakes a long-running observable client once it can check", () => {
  assert.equal(
    canAutoCheckDesktopUpdate({ revision: 1, status: "idle", currentVersion: CURRENT_VERSION }),
    true,
  );
  assert.equal(
    canAutoCheckDesktopUpdate({
      revision: 2,
      status: "not-available",
      currentVersion: CURRENT_VERSION,
    }),
    true,
  );
  assert.equal(
    canAutoCheckDesktopUpdate({
      revision: 3,
      status: "error",
      currentVersion: CURRENT_VERSION,
      errorPhase: "check",
    }),
    true,
  );
  assert.equal(
    canAutoCheckDesktopUpdate({
      revision: 4,
      status: "downloading",
      currentVersion: CURRENT_VERSION,
    }),
    false,
  );
  assert.equal(
    canAutoCheckDesktopUpdate({
      revision: 5,
      status: "error",
      currentVersion: CURRENT_VERSION,
      errorPhase: "download",
    }),
    false,
  );
});

test("presents manual and legacy clients as non-blocking truthful fallbacks", () => {
  const manual = updatePresentation({ mode: "manual" });
  assert.equal(manual.kind, "manual");
  assert.equal(manual.primaryAction, "manual");
  assert.match(manual.detail, /继续编辑/);

  const legacy = updatePresentation({ mode: "legacy-auto" });
  assert.equal(legacy.kind, "legacy");
  assert.equal(legacy.indeterminate, true);
  assert.equal(legacy.percent, undefined);
  assert.match(legacy.detail, /继续编辑和导出/);
  assert.match(legacy.detail, /正常退出应用时会自动安装/);
});

test("maps observable download and ready states to background progress then explicit restart", () => {
  const downloading = updatePresentation({
    updateState: {
      revision: 3,
      status: "downloading",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
      percent: 62.4,
    },
  });
  assert.equal(downloading.kind, "downloading");
  assert.equal(downloading.percent, 62.4);
  assert.equal(downloading.primaryAction, undefined);
  assert.match(downloading.detail, /继续编辑和导出/);

  const preparing = updatePresentation({
    updateState: {
      revision: 4,
      status: "preparing",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
    },
  });
  assert.equal(preparing.kind, "preparing");
  assert.equal(preparing.primaryAction, undefined);
  assert.match(preparing.detail, /继续编辑和导出/);

  const ready = updatePresentation({
    updateState: {
      revision: 4,
      status: "ready",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
    },
  });
  assert.equal(ready.kind, "ready");
  assert.equal(ready.primaryAction, "restart");
  assert.equal(ready.restartDisabled, false);

  const exporting = updatePresentation({
    updateState: {
      revision: 4,
      status: "ready",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
    },
    exportActive: true,
  });
  assert.equal(exporting.kind, "ready");
  assert.equal(exporting.restartDisabled, true);
  assert.match(exporting.detail, /导出完成/);
});

test("keeps authoritative updater state visible through API failure and release mismatch", () => {
  const readyWithoutApi = updatePresentation({
    release: null,
    updateState: {
      revision: 5,
      status: "ready",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
    },
  });
  assert.equal(readyWithoutApi.kind, "ready");
  assert.equal(readyWithoutApi.primaryAction, "restart");

  const mismatchError = updatePresentation({
    release: { ...VERIFIED_RELEASE, version: "v0.2.4" },
    updateState: {
      revision: 6,
      status: "error",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
      errorPhase: "download",
    },
  });
  assert.equal(mismatchError.kind, "error");
  assert.equal(mismatchError.showManualAction, false);

  const longRunningClient = updatePresentation({
    updateState: {
      revision: 7,
      status: "not-available",
      currentVersion: CURRENT_VERSION,
      targetVersion: CURRENT_VERSION,
    },
  });
  assert.equal(longRunningClient.kind, "error");
  assert.equal(longRunningClient.targetVersion, `v${NEXT_VERSION}`);
  assert.equal(longRunningClient.showManualAction, true);
  assert.match(longRunningClient.title, /新版暂未开始下载/);
});

test("clamps invalid progress and switches stalled downloads to a manual fallback", () => {
  const over = updatePresentation({
    updateState: {
      revision: 7,
      status: "downloading",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
      percent: 120,
    },
  });
  assert.equal(over.percent, 100);

  const invalid = updatePresentation({
    updateState: {
      revision: 8,
      status: "downloading",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
      percent: Number.NaN,
    },
  });
  assert.equal(invalid.percent, undefined);

  const stalled = updatePresentation({
    updateState: {
      revision: 9,
      status: "downloading",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
      percent: 20,
    },
    downloadStalled: true,
  });
  assert.equal(stalled.kind, "stalled");
  assert.equal(stalled.primaryAction, "manual");

  const stalledPreparation = updatePresentation({
    updateState: {
      revision: 10,
      status: "preparing",
      currentVersion: CURRENT_VERSION,
      targetVersion: NEXT_VERSION,
    },
    downloadStalled: true,
  });
  assert.equal(stalledPreparation.kind, "stalled");
  assert.equal(stalledPreparation.primaryAction, "manual");
  assert.match(stalledPreparation.title, /系统准备更新/);
});

test("update UI stays non-modal and only hands off focus after a user retry", () => {
  const indicator = readFileSync(
    new URL("../components/editor/DesktopUpdateIndicator.tsx", import.meta.url),
    "utf8",
  );
  const editor = readFileSync(new URL("../components/editor/EditorShell.tsx", import.meta.url), "utf8");
  const topBar = readFileSync(new URL("../components/editor/TopBar.tsx", import.meta.url), "utf8");
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const render = readFileSync(new URL("../electron/render.ts", import.meta.url), "utf8");

  assert.doesNotMatch(indicator, /<dialog|aria-modal|showModal\(|autoFocus/);
  assert.match(indicator, /requestAnimationFrame\(\(\) => indicatorRef\.current\?\.focus/);
  assert.match(indicator, /latestRevisionRef\.current >= 0/);
  assert.doesNotMatch(editor, /RequiredUpdateGate/);
  assert.match(topBar, /DesktopUpdateIndicator/);
  assert.match(indicator, /data-update-indicator/);
  assert.match(main, /render:session-begin[\s\S]+beginExportWithUpdateInterlock/);
  assert.match(main, /render:start[\s\S]+startRenderWithUpdateInterlock/);

  const startRenderBody = render
    .split("export async function startRender", 2)[1]
    ?.replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "");
  assert.ok(startRenderBody, "startRender source should exist");
  const reservationEnd = startRenderBody.indexOf("endExportSession(");
  const jobRegistration = startRenderBody.indexOf("jobs.set(");
  const firstAwait = startRenderBody.indexOf("await ");
  assert.ok(reservationEnd >= 0 && reservationEnd < jobRegistration);
  assert.ok(jobRegistration >= 0 && jobRegistration < firstAwait);
});

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkResult: { downloadPromise?: Promise<unknown> | null } | null = null;
  checkPromise: Promise<{ downloadPromise?: Promise<unknown> | null } | null> | null = null;
  checkError: unknown = null;
  emitAvailableOnCheck = false;
  checkCalls = 0;
  quitCalls = 0;
  quitErrors: unknown[] = [];
  quitEmittedErrors: unknown[] = [];

  async checkForUpdates() {
    this.checkCalls += 1;
    if (this.checkError) throw this.checkError;
    if (this.checkPromise) return this.checkPromise;
    if (this.emitAvailableOnCheck) this.emit("update-available", { version: NEXT_VERSION });
    return this.checkResult;
  }

  quitAndInstall() {
    this.quitCalls += 1;
    const emittedError = this.quitEmittedErrors.shift();
    if (emittedError) this.emit("error", emittedError);
    const error = this.quitErrors.shift();
    if (error) throw error;
  }
}

function setupUpdater(initialActiveExport = false) {
  const updater = new FakeUpdater();
  const restartGuard = createUpdateRestartGuard();
  let activeExport = initialActiveExport;
  const states: Array<ReturnType<ReturnType<typeof createDesktopUpdaterController>["getState"]>> = [];
  const controller = createDesktopUpdaterController({
    updater: updater as unknown as AutoUpdaterLike,
    currentVersion: CURRENT_VERSION,
    supported: true,
    requiresInstallReadySignal: true,
    hasActiveExportSession: () => activeExport,
    restartGuard,
    onState: (state) => states.push(state),
    logger: { error: () => {} },
  });
  return {
    updater,
    controller,
    restartGuard,
    states,
    setActiveExport: (active: boolean) => {
      activeExport = active;
    },
  };
}

async function prepareReadyInstaller(
  context: Pick<ReturnType<typeof setupUpdater>, "updater" | "controller">,
  version = NEXT_VERSION,
): Promise<void> {
  context.updater.emitAvailableOnCheck = true;
  assert.deepEqual(await context.controller.check(), { ok: true });
  context.updater.emit("update-downloaded", { version });
  context.controller.markInstallReady(version);
  assert.equal(context.controller.getState().status, "ready");
}

test("consumes a rejected auto-download promise and publishes a retryable download error", async () => {
  const { updater, controller } = setupUpdater();
  let rejectDownload!: (error: unknown) => void;
  updater.checkResult = {
    downloadPromise: new Promise((_resolve, reject) => {
      rejectDownload = reject;
    }),
  };
  updater.emitAvailableOnCheck = true;

  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  assert.equal(controller.getState().status, "preparing");
  rejectDownload(Object.assign(new Error("network lost"), { code: "ERR_NETWORK" }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "download");
  assert.equal(controller.getState().retryable, true);
  assert.equal(controller.getState().errorCode, "ERR_NETWORK");
  controller.markInstallReady();
  assert.equal(controller.getState().status, "error");
});

test("native readiness cannot expose restart until electron-updater finishes successfully", async () => {
  const { updater, controller, restartGuard } = setupUpdater();
  let resolveDownload!: () => void;
  updater.checkResult = {
    downloadPromise: new Promise((resolve) => {
      resolveDownload = () => resolve(undefined);
    }),
  };
  updater.emitAvailableOnCheck = true;

  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  controller.markInstallReady();
  assert.equal(controller.getState().status, "preparing");
  assert.deepEqual(controller.install(), { ok: false, error: "新版尚未下载完成" });
  assert.equal(restartGuard.isCommitted(), false);

  resolveDownload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().status, "ready");
  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(restartGuard.isCommitted(), true);
});

test("early or mismatched native events cannot arm a later staged download", async () => {
  const { updater, controller } = setupUpdater();
  let resolveDownload!: () => void;
  updater.checkResult = {
    downloadPromise: new Promise((resolve) => {
      resolveDownload = () => resolve(undefined);
    }),
  };
  updater.emitAvailableOnCheck = true;

  assert.deepEqual(await controller.check(), { ok: true });
  controller.markInstallReady(NEXT_VERSION);
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  resolveDownload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().status, "preparing");

  controller.markInstallReady("0.2.4");
  assert.equal(controller.getState().status, "preparing");
  controller.markInstallReady(`v${NEXT_VERSION}`);
  assert.equal(controller.getState().status, "ready");
});

test("electron-updater's error-then-reject sequence cannot release a restart latch", async () => {
  const { updater, controller, restartGuard } = setupUpdater();
  let rejectDownload!: (error: unknown) => void;
  const rawDownload = new Promise<unknown>((_resolve, reject) => {
    rejectDownload = reject;
  });
  updater.checkResult = {
    // AppUpdater dispatches `error` before propagating the same rejection to
    // consumers of UpdateCheckResult.downloadPromise.
    downloadPromise: rawDownload.catch((error) => {
      updater.emit("error", error);
      throw error;
    }),
  };
  updater.emitAvailableOnCheck = true;

  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  controller.markInstallReady();
  assert.equal(controller.getState().status, "preparing");
  assert.deepEqual(controller.install(), { ok: false, error: "新版尚未下载完成" });
  rejectDownload(new Error("late cache bookkeeping failure"));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "download");
  assert.equal(restartGuard.isCommitted(), false);
});

test("downloads completely in the background and waits for an explicit install command", async () => {
  const { updater, controller, restartGuard } = setupUpdater();
  assert.equal(updater.autoDownload, true);
  assert.equal(updater.autoInstallOnAppQuit, true);

  updater.emitAvailableOnCheck = true;
  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("download-progress", {
    percent: 48,
    transferred: 48,
    total: 100,
    bytesPerSecond: 10,
  });
  assert.equal(controller.getState().status, "downloading");
  assert.equal(updater.quitCalls, 0);

  updater.emit("update-downloaded", { version: NEXT_VERSION });
  assert.equal(controller.getState().status, "preparing");
  assert.deepEqual(controller.install(), { ok: false, error: "新版尚未下载完成" });
  controller.markInstallReady(NEXT_VERSION);
  assert.equal(controller.getState().status, "ready");
  assert.equal(updater.quitCalls, 0);

  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(controller.getState().status, "installing");
  assert.equal(updater.quitCalls, 1);
  assert.equal(restartGuard.isCommitted(), true);
  assert.deepEqual(controller.install(), {
    ok: false,
    busy: true,
    error: "应用正在准备重启",
  });
  assert.equal(updater.quitCalls, 1);
});

test("macOS preparation errors after the outer download event never expose a false ready state", async () => {
  const { updater, controller } = setupUpdater();
  updater.emitAvailableOnCheck = true;
  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  assert.equal(controller.getState().status, "preparing");
  assert.deepEqual(controller.install(), { ok: false, error: "新版尚未下载完成" });

  updater.emit("error", new Error("Squirrel failed to stage the zip"));
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "download");
  controller.markInstallReady();
  assert.equal(controller.getState().status, "error");
  assert.deepEqual(controller.install(), { ok: false, error: "新版尚未下载完成" });

  assert.deepEqual(await controller.check(), { ok: true });
  assert.equal(updater.checkCalls, 2);
});

test("failed download events cannot be revived by late progress or staging signals", async () => {
  const { updater, controller } = setupUpdater();
  let resolveDownload!: () => void;
  updater.checkResult = {
    downloadPromise: new Promise((resolve) => {
      resolveDownload = () => resolve(undefined);
    }),
  };
  updater.emitAvailableOnCheck = true;

  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("error", new Error("native staging failed"));
  const errorRevision = controller.getState().revision;
  assert.equal(controller.getState().status, "error");

  updater.emit("download-progress", {
    percent: 100,
    transferred: 100,
    total: 100,
    bytesPerSecond: 1,
  });
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  controller.markInstallReady(NEXT_VERSION);
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().revision, errorRevision);
  assert.deepEqual(controller.install(), { ok: false, error: "新版尚未下载完成" });

  resolveDownload();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.getState().status, "error");
});

test("late updater events cannot erase a natively verified installer before restart", async () => {
  const context = setupUpdater();
  const { updater, controller } = context;
  await prepareReadyInstaller(context);
  const readyRevision = controller.getState().revision;

  updater.emit("checking-for-update");
  updater.emit("update-available", { version: "0.2.4" });
  updater.emit("download-progress", {
    percent: 1,
    transferred: 1,
    total: 100,
    bytesPerSecond: 1,
  });
  updater.emit("update-not-available", { version: CURRENT_VERSION });
  updater.emit("error", new Error("late feed event"));

  assert.equal(controller.getState().status, "ready");
  assert.equal(controller.getState().targetVersion, NEXT_VERSION);
  assert.equal(controller.getState().revision, readyRevision);
  assert.equal(updater.quitCalls, 0);
});

test("deduplicates concurrent checks and refuses a second check during download", async () => {
  const { updater, controller } = setupUpdater();
  let resolveCheck!: (value: null) => void;
  updater.checkPromise = new Promise((resolve) => {
    resolveCheck = resolve;
  });

  const first = controller.check();
  const second = controller.check();
  assert.equal(first, second);
  assert.equal(updater.checkCalls, 1);
  resolveCheck(null);
  await first;

  updater.checkPromise = null;
  updater.emit("update-available", { version: NEXT_VERSION });
  assert.deepEqual(await controller.check(), {
    ok: false,
    busy: true,
    error: "新版正在后台下载",
  });
  assert.equal(updater.checkCalls, 1);
});

test("keeps a downloaded installer retryable after an asynchronous install error", async () => {
  const context = setupUpdater();
  const { updater, controller, restartGuard } = context;
  await prepareReadyInstaller(context);

  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 1);
  assert.equal(restartGuard.isCommitted(), true);
  updater.emit("error", new Error("native restart failed"));
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "install");
  assert.match(controller.getState().message ?? "", /重启/);
  assert.equal(restartGuard.isCommitted(), false);

  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 2);
  assert.equal(restartGuard.isCommitted(), true);
});

test("keeps a downloaded installer retryable after a synchronous install error", async () => {
  const context = setupUpdater();
  const { updater, controller, restartGuard } = context;
  await prepareReadyInstaller(context);
  updater.quitErrors.push(new Error("sync failure"));

  assert.equal(controller.install().ok, false);
  assert.equal(controller.getState().errorPhase, "install");
  assert.equal(restartGuard.isCommitted(), false);
  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 2);
  assert.equal(restartGuard.isCommitted(), true);
});

test("returns a failed install command when the updater emits an error synchronously", async () => {
  const context = setupUpdater();
  const { updater, controller, restartGuard } = context;
  await prepareReadyInstaller(context);
  updater.quitEmittedErrors.push(new Error("native updater rejected restart"));

  assert.deepEqual(controller.install(), {
    ok: false,
    error: "应用未能自动重启，请再次尝试",
  });
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "install");
  assert.equal(restartGuard.isCommitted(), false);

  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(restartGuard.isCommitted(), true);
});

test("downloads during export but installs only after the export lease is released", async () => {
  const { updater, controller, restartGuard, setActiveExport } = setupUpdater(true);
  updater.emitAvailableOnCheck = true;
  assert.deepEqual(await controller.check(), { ok: true });
  updater.emit("download-progress", {
    percent: 70,
    transferred: 70,
    total: 100,
    bytesPerSecond: 10,
  });
  assert.equal(controller.getState().status, "downloading");
  updater.emit("update-downloaded", { version: NEXT_VERSION });
  controller.markInstallReady(NEXT_VERSION);
  assert.deepEqual(controller.install(), {
    ok: false,
    busy: true,
    error: "请先保存或放弃当前导出",
  });
  assert.equal(updater.quitCalls, 0);
  assert.equal(restartGuard.isCommitted(), false);
  assert.equal(controller.getState().status, "ready");
  setActiveExport(false);
  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 1);
  assert.equal(restartGuard.isCommitted(), true);
});

test("the executable restart/export interlock is safe in both event orders", async () => {
  {
    const context = setupUpdater();
    const { controller, restartGuard, setActiveExport } = context;
    await prepareReadyInstaller(context);

    const reservation = beginExportWithUpdateInterlock(restartGuard, () => {
      setActiveExport(true);
      return "session-first";
    });
    assert.deepEqual(reservation, { ok: true, sessionId: "session-first" });
    assert.equal(controller.install().ok, false);
    assert.equal(restartGuard.isCommitted(), false);
  }

  {
    const context = setupUpdater();
    const { controller, restartGuard } = context;
    await prepareReadyInstaller(context);
    assert.deepEqual(controller.install(), { ok: true });

    let began = false;
    const reservation = beginExportWithUpdateInterlock(restartGuard, () => {
      began = true;
      return "too-late";
    });
    assert.equal(reservation.ok, false);
    assert.equal(began, false);
  }

  {
    const context = setupUpdater();
    const { controller, restartGuard, setActiveExport } = context;
    await prepareReadyInstaller(context);

    let releaseRender!: () => void;
    const render = startRenderWithUpdateInterlock(restartGuard, () => {
      setActiveExport(true);
      return new Promise<void>((resolve) => {
        releaseRender = resolve;
      });
    });
    assert.equal(controller.install().ok, false);
    releaseRender();
    await render;
  }

  {
    const context = setupUpdater();
    const { controller, restartGuard } = context;
    await prepareReadyInstaller(context);
    assert.deepEqual(controller.install(), { ok: true });

    let started = false;
    assert.throws(
      () =>
        startRenderWithUpdateInterlock(restartGuard, () => {
          started = true;
          return Promise.resolve();
        }),
      /暂时无法开始新的导出/,
    );
    assert.equal(started, false);
  }
});

test("an old async cleanup cannot release a newer export activity lease", () => {
  const store = createExportSessionActivityStore();
  const releaseOld = store.acquire();
  const releaseNew = store.acquire();
  assert.equal(store.getSnapshot(), true);

  releaseOld();
  assert.equal(store.getSnapshot(), true);
  releaseOld();
  assert.equal(store.getSnapshot(), true);
  releaseNew();
  assert.equal(store.getSnapshot(), false);
});
