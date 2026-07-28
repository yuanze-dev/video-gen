import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = path.join(root, "remotion", "elements", "Countdown.tsx");
const compiledDir = await fs.mkdtemp(path.join(root, ".countdown-test-"));
const compiledFile = path.join(compiledDir, "Countdown.mjs");

type CountdownModule = typeof import("../remotion/elements/Countdown.tsx");
let countdown: CountdownModule;

before(async () => {
  await build({
    entryPoints: [sourceFile],
    outfile: compiledFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
  });
  countdown = (await import(
    `${pathToFileURL(compiledFile).href}?t=${Date.now()}`
  )) as CountdownModule;
});

after(async () => {
  await fs.rm(compiledDir, { recursive: true, force: true });
});

test("standard countdown renders exact 3, 2, 1 frame windows", () => {
  const value = (frame: number) => countdown.countdownValueAtFrame(frame, 30, 3, 1);

  for (let frame = 0; frame < 30; frame += 1) assert.equal(value(frame), 3);
  for (let frame = 30; frame < 60; frame += 1) assert.equal(value(frame), 2);
  for (let frame = 60; frame < 90; frame += 1) assert.equal(value(frame), 1);
  assert.equal(value(90), null);
  assert.equal(value(300), null);
});

test("countdown speed changes the tick rate without skipping boundary values", () => {
  assert.deepEqual(
    [0, 14, 15, 29, 30, 44, 45].map((frame) =>
      countdown.countdownValueAtFrame(frame, 30, 3, 2),
    ),
    [3, 3, 2, 2, 1, 1, null],
  );
});

test("premounted negative frames stay on the first countdown value", () => {
  assert.equal(countdown.countdownValueAtFrame(-30, 30, 3, 1), 3);
});
