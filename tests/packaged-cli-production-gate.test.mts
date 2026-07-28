import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import verifier from "../build/verify-cli-resource.cjs";

const { parseCliEnvelope, validatePackagedProductionResult } = verifier as {
  parseCliEnvelope: (stdout: string, command: string) => Record<string, unknown>;
  validatePackagedProductionResult: (
    result: Record<string, unknown>,
    expected: { output: string; preparedConfig: string; lock: string },
  ) => {
    durationSec: number;
    openingSec: number;
    contentSec: number;
    endingSec: number;
  };
};

test("packaged production gate requires an exact successful CLI envelope", () => {
  const result = parseCliEnvelope(
    JSON.stringify({
      ok: true,
      protocolVersion: "1",
      command: "produce",
      result: { output: "/tmp/output.mp4" },
    }),
    "produce",
  );
  assert.equal(result.output, "/tmp/output.mp4");
  assert.throws(
    () =>
      parseCliEnvelope(
        JSON.stringify({
          ok: true,
          protocolVersion: "1",
          command: "render",
          result: {},
        }),
        "produce",
      ),
    /successful protocol v1 envelope/,
  );
  assert.throws(() => parseCliEnvelope("progress\n{}", "produce"), /invalid JSON/);
});

test("packaged production gate accepts only the complete standard H.264/AAC result", async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "littlestart-gate-test-"));
  const output = path.join(temporary, "output.mp4");
  const preparedConfig = path.join(temporary, "video.prepared.json");
  const lock = path.join(temporary, "video.lock.json");
  try {
    await writeFile(output, Buffer.from("fake-mp4"));
    await writeFile(preparedConfig, "{}\n");
    await writeFile(lock, "{}\n");
    const sizeBytes = Buffer.byteLength("fake-mp4");
    const result = {
      output,
      preparedConfig,
      lock,
      durationSec: 292 / 30,
      sizeBytes,
      export: { quality: "small", resolution: "720p", fps: 30 },
      productionGuard: { policy: "standard", passed: true },
      audio: {
        kind: "sound-effect",
        mode: "auto",
        status: "skipped",
        reason: "missing-key",
        prompt:
          "Create one seamless looping environmental sound effect: modern commercial aircraft cockpit and cabin ambience with low turbofan hum, steady ventilation airflow, subtle avionics fans, and gentle airframe resonance. No music, voices, speech, dialogue, alarms, or sudden transients.",
        output: null,
        manifest: null,
        requestKey: null,
        reused: false,
      },
      scenes: {
        opening: { seconds: 1.5, frames: 45 },
        content: { seconds: 6, frames: 180 },
        ending: { seconds: 2.227664, frames: 67 },
        total: { seconds: 292 / 30, frames: 292 },
      },
      media: {
        path: output,
        sizeBytes,
        durationSec: 9.792,
        width: 720,
        height: 1280,
        fps: 30,
        videoCodec: "h264",
        audioCodec: "aac",
        container: "mp4",
      },
    };
    const accepted = validatePackagedProductionResult(result, {
      output,
      preparedConfig,
      lock,
    });
    assert.equal(accepted.openingSec, 1.5);
    assert.equal(accepted.endingSec, 2.227664);

    assert.throws(
      () =>
        validatePackagedProductionResult(
          { ...result, productionGuard: { policy: "custom", passed: true } },
          { output, preparedConfig, lock },
        ),
      /standard production guard/,
    );
    assert.throws(
      () =>
        validatePackagedProductionResult(
          { ...result, scenes: { ...result.scenes, ending: { seconds: 0.2, frames: 6 } } },
          { output, preparedConfig, lock },
        ),
      /ending is shorter than 1 second/,
    );
    assert.throws(
      () =>
        validatePackagedProductionResult(
          { ...result, media: { ...result.media, audioCodec: null } },
          { output, preparedConfig, lock },
        ),
      /media mismatch/,
    );
    assert.throws(
      () =>
        validatePackagedProductionResult(
          {
            ...result,
            audio: {
              ...result.audio,
              prompt: "Mayday, Flight 724 has an engine fire",
            },
          },
          { output, preparedConfig, lock },
        ),
      /narration-safe aircraft sound effect/,
    );
    assert.throws(
      () =>
        validatePackagedProductionResult(
          { ...result, media: { ...result.media, durationSec: 8 } },
          { output, preparedConfig, lock },
        ),
      /container duration mismatch/,
    );
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
});
