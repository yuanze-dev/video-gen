import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import {
  classifyDesktopUpdateGate,
  compareDesktopVersions,
  inferDesktopClientVersion,
  shouldBlockDesktopUpdate,
} from "../lib/desktop-bridge.ts";
import {
  isDesktopReleaseReady,
  readDesktopManifestVersion,
  selectDesktopRelease,
} from "../lib/desktop-release.ts";
import { createExportSessionActivityStore } from "../lib/export-session.ts";
import { createDesktopUpdaterController } from "../electron/updater-controller.ts";

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
      "observable",
      "0.2.2",
    ],
  ] as const;

  for (const [bridge, mode, version] of cases) {
    assert.equal(classifyDesktopUpdateGate(bridge), mode);
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

test("blocks only an older desktop when the verified release is required", () => {
  const base = { releaseRequired: true, requiredVersion: "v0.2.2" };
  assert.equal(
    shouldBlockDesktopUpdate({ ...base, mode: "hidden", currentVersion: null }),
    false,
  );
  assert.equal(
    shouldBlockDesktopUpdate({ ...base, mode: "legacy-auto", currentVersion: "0.2.1" }),
    true,
  );
  assert.equal(
    shouldBlockDesktopUpdate({ ...base, mode: "observable", currentVersion: "0.2.2" }),
    false,
  );
  assert.equal(
    shouldBlockDesktopUpdate({ ...base, mode: "observable", currentVersion: "0.2.3" }),
    false,
  );
  assert.equal(
    shouldBlockDesktopUpdate({
      ...base,
      releaseRequired: false,
      mode: "manual",
      currentVersion: "0.1.0",
    }),
    false,
  );
});

test("reads and verifies the v0.2.2 release assets before arming the gate", () => {
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

test("keeps the verified v0.2.1 gate armed until every v0.2.2 asset is ready", () => {
  const target = { required: false, version: "v0.2.2" };
  const fallback = { required: true, version: "v0.2.1" };
  assert.equal(selectDesktopRelease([target, fallback]).version, "v0.2.1");
  assert.equal(
    selectDesktopRelease([{ ...target, required: true }, fallback]).version,
    "v0.2.2",
  );
  assert.equal(
    selectDesktopRelease([target, { ...fallback, required: false }]).version,
    "v0.2.1",
  );
});

class FakeUpdater extends EventEmitter {
  autoDownload = false;
  autoInstallOnAppQuit = false;
  checkResult: { downloadPromise?: Promise<unknown> | null } | null = null;
  checkError: unknown = null;
  emitAvailableOnCheck = false;
  quitCalls = 0;
  quitErrors: unknown[] = [];

  async checkForUpdates() {
    if (this.checkError) throw this.checkError;
    if (this.emitAvailableOnCheck) this.emit("update-available", { version: "0.2.2" });
    return this.checkResult;
  }

  quitAndInstall() {
    this.quitCalls += 1;
    const error = this.quitErrors.shift();
    if (error) throw error;
  }
}

function setupUpdater(activeExport = false) {
  const updater = new FakeUpdater();
  const states: Array<ReturnType<ReturnType<typeof createDesktopUpdaterController>["getState"]>> = [];
  const controller = createDesktopUpdaterController({
    updater,
    currentVersion: "0.2.1",
    supported: true,
    hasActiveExportSession: () => activeExport,
    onState: (state) => states.push(state),
    logger: { error: () => {} },
  });
  return { updater, controller, states };
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
  rejectDownload(Object.assign(new Error("network lost"), { code: "ERR_NETWORK" }));
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "download");
  assert.equal(controller.getState().retryable, true);
  assert.equal(controller.getState().errorCode, "ERR_NETWORK");
});

test("keeps a downloaded installer retryable after an asynchronous install error", () => {
  const { updater, controller } = setupUpdater();
  updater.emit("update-downloaded", { version: "0.2.2" });

  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 1);
  updater.emit("error", new Error("native restart failed"));
  assert.equal(controller.getState().status, "error");
  assert.equal(controller.getState().errorPhase, "install");
  assert.match(controller.getState().message ?? "", /重启/);

  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 2);
});

test("keeps a downloaded installer retryable after a synchronous install error", () => {
  const { updater, controller } = setupUpdater();
  updater.emit("update-downloaded", { version: "0.2.2" });
  updater.quitErrors.push(new Error("sync failure"));

  assert.equal(controller.install().ok, false);
  assert.equal(controller.getState().errorPhase, "install");
  assert.deepEqual(controller.install(), { ok: true });
  assert.equal(updater.quitCalls, 2);
});

test("does not install while an export session still owns unsaved output", () => {
  const { updater, controller } = setupUpdater(true);
  updater.emit("update-downloaded", { version: "0.2.2" });
  assert.deepEqual(controller.install(), {
    ok: false,
    busy: true,
    error: "请先保存或放弃当前导出",
  });
  assert.equal(updater.quitCalls, 0);
  assert.equal(controller.getState().status, "ready");
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
