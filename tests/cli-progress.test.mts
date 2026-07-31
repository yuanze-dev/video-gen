import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  entryPoints: [path.join(root, "cli", "progress.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "silent",
});
const subject = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
) as typeof import("../cli/progress.ts");

test("renderer progress is throttled and mapped into the production slice", () => {
  const samples: import("../cli/progress.ts").ProgressSample[] = [];
  const report = subject.createThrottledProgressReporter(
    (sample) => samples.push(sample),
    { base: 0.25, span: 0.75, minimumPercentStep: 2 },
  );

  for (let frame = 0; frame <= 3_103; frame += 1) report(frame / 3_103);

  assert.ok(samples.length <= 52, `expected <=52 samples, received ${samples.length}`);
  assert.equal(samples[0]?.percent, 0);
  assert.equal(samples[0]?.ratio, 0.25);
  assert.equal(samples.at(-1)?.percent, 100);
  assert.equal(samples.at(-1)?.ratio, 1);
  assert.equal(new Set(samples.map((sample) => sample.percent)).size, samples.length);
});

test("progress clamps provider noise and validates throttle options", () => {
  const samples: import("../cli/progress.ts").ProgressSample[] = [];
  const report = subject.createThrottledProgressReporter((sample) => samples.push(sample));
  report(-1);
  report(2);
  assert.deepEqual(samples.map((sample) => sample.percent), [0, 100]);
  assert.throws(
    () => subject.createThrottledProgressReporter(() => {}, { minimumPercentStep: 0 }),
    /1 到 100/,
  );
});
