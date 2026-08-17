import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceFile = path.join(root, "remotion", "elements", "Teleprompter.tsx");
const compiledDir = await fs.mkdtemp(path.join(root, ".teleprompter-scroll-test-"));
const compiledFile = path.join(compiledDir, "Teleprompter.mjs");

type TeleprompterModule = typeof import("../remotion/elements/Teleprompter.tsx");
let teleprompter: TeleprompterModule;

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
  teleprompter = (await import(
    `${pathToFileURL(compiledFile).href}?t=${Date.now()}`
  )) as TeleprompterModule;
});

after(async () => {
  await fs.rm(compiledDir, { recursive: true, force: true });
});

test("teleprompter scroll is constant and fully clears the screen before ending", () => {
  const contentFrames = 360;
  const renderedTextH = 2_740;
  const positions = Array.from({ length: contentFrames }, (_, frame) => {
    const transform = teleprompter.teleprompterScrollTransform(
      frame,
      contentFrames,
    );
    return (transform.yPercent / 100) * renderedTextH;
  });
  const expectedStep = positions[1] - positions[0];

  assert.ok(expectedStep < 0, "text must move upward");
  for (let frame = 2; frame < positions.length; frame += 1) {
    assert.ok(
      Math.abs(positions[frame] - positions[frame - 1] - expectedStep) < 1e-9,
      `frame ${frame} must keep the same displacement`,
    );
  }
  assert.equal(positions[0], 0);
  assert.ok(Math.abs(positions.at(-1)! + renderedTextH) < 1e-9);
});

test("teleprompter scroll clamps premounted and post-roll frames", () => {
  const first = teleprompter.teleprompterScrollTransform(-60, 360);
  const last = teleprompter.teleprompterScrollTransform(999, 360);
  const still = teleprompter.teleprompterScrollTransform(0, 1);

  assert.deepEqual(first, { yPercent: 0 });
  assert.deepEqual(last, { yPercent: -100 });
  assert.deepEqual(still, { yPercent: 0 });
});

test("teleprompter renderer does not restore asynchronous DOM height measurement", async () => {
  const source = await fs.readFile(sourceFile, "utf8");
  assert.doesNotMatch(
    source,
    /\.scrollHeight|useEffect\s*\(|useLayoutEffect\s*\(|delayRender\s*\(/,
  );
});
