import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import encodedVerifier from "../build/verify-encoded-production.cjs";
import countdownTemplates from "../build/countdown-glyph-templates.cjs";

const {
  analyzeCurtainFrames,
  analyzePcm16,
  analyzeScrollProjections,
  classifyCountdownGlyph,
  compareGrayFrames,
  countdownGlyph,
  deriveTeleprompterCrop,
} = encodedVerifier as unknown as {
  analyzeCurtainFrames: (
    frames: Buffer[],
    width: number,
    height: number,
    color: string,
  ) => {
    first: { full: number; center: number };
    last: { full: number; center: number; valance: number };
  };
  analyzePcm16: (pcm: Buffer) => { samples: number; rms: number; dbfs: number };
  analyzeScrollProjections: (
    projections: Float64Array[],
    brightRatios: number[],
    fps: number,
  ) => {
    minimumShift: number;
    maximumShift: number;
    reversePairs: number;
    stalledPairs: number;
    largeJumpPairs: number;
  };
  classifyCountdownGlyph: (
    observed: Uint8Array,
    expectedDigit: number,
  ) => { templateDice: number; templateMargin: number };
  compareGrayFrames: (
    left: Buffer,
    right: Buffer,
  ) => { correlation: number; mae: number; psnr: number };
  countdownGlyph: (
    rgbFrame: Buffer,
    width: number,
    height: number,
    fontPixels: number,
    expectedDigit: number,
  ) => {
    minimumChannel: number;
    erosionRadius: number;
    normalized: Uint8Array;
    match: { expectedDice: number; margin: number };
  };
  deriveTeleprompterCrop: (
    config: Record<string, unknown>,
    media: Record<string, unknown>,
  ) => { x: number; y: number; width: number; height: number };
};

function unpackCountdownTemplate(digit: "3" | "2" | "1"): Uint8Array {
  const packed = Buffer.from(countdownTemplates.digits[digit].bitmapBase64, "base64");
  return Uint8Array.from({ length: countdownTemplates.width * countdownTemplates.height }, (_, index) =>
    (packed[index >> 3] >> (7 - (index & 7))) & 1,
  );
}

function seededNoise(length: number): Float64Array {
  let state = 0x12345678;
  return Float64Array.from({ length }, () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return (state & 0xffff) / 0xffff;
  });
}

function movingProjections(frames: number, height: number, shift: number): Float64Array[] {
  const padding = Math.abs(shift) * frames + 32;
  const source = seededNoise(height + padding * 2);
  const origin = padding;
  return Array.from({ length: frames }, (_, frame) => {
    const offset = origin + frame * shift;
    return source.slice(offset, offset + height);
  });
}

test("encoded scroll gate accepts only continuous, unambiguous upward movement", () => {
  const frames = 180;
  const bright = Array.from({ length: frames }, () => 0.08);
  const accepted = analyzeScrollProjections(movingProjections(frames, 320, 2), bright, 30);
  assert.equal(accepted.minimumShift, 2);
  assert.equal(accepted.maximumShift, 2);
  assert.equal(accepted.reversePairs, 0);
  assert.equal(accepted.stalledPairs, 0);
  assert.equal(accepted.largeJumpPairs, 0);

  assert.throws(
    () => analyzeScrollProjections(movingProjections(frames, 320, -2), bright, 30),
    /scroll reversed/,
  );
  const stalled = movingProjections(1, 320, 0)[0];
  assert.throws(
    () =>
      analyzeScrollProjections(
        Array.from({ length: frames }, () => stalled),
        bright,
        30,
      ),
    /scroll stalled/,
  );
  assert.throws(
    () => analyzeScrollProjections(movingProjections(frames, 320, 5), bright, 30),
    /jumped by more than 4px/,
  );
  assert.throws(
    () =>
      analyzeScrollProjections(
        movingProjections(frames, 320, 2),
        Array.from({ length: frames }, () => 0),
        30,
      ),
    /text is visible in only/,
  );
});

function curtainFrame(
  width: number,
  height: number,
  options: { closed?: boolean; sideFraction?: number },
): Buffer {
  const output = Buffer.alloc(width * height * 3);
  const valanceRows = Math.ceil(height * 0.08);
  const sideWidth = Math.ceil(width * (options.sideFraction ?? 0));
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const curtain =
        options.closed === true || y < valanceRows || x < sideWidth || x >= width - sideWidth;
      const offset = (y * width + x) * 3;
      output[offset] = curtain ? 209 : 10;
      output[offset + 1] = curtain ? 16 : 20;
      output[offset + 2] = curtain ? 105 : 30;
    }
  }
  return output;
}

test("encoded curtain gate proves a closed frame, opening center, side stacks, and valance", () => {
  const width = 90;
  const height = 160;
  const accepted = analyzeCurtainFrames(
    [
      curtainFrame(width, height, { closed: true }),
      curtainFrame(width, height, { sideFraction: 0.16 }),
      curtainFrame(width, height, { sideFraction: 0.1 }),
    ],
    width,
    height,
    "#d11069",
  );
  assert.equal(accepted.first.full, 1);
  assert.equal(accepted.last.center, 0);
  assert.equal(accepted.last.valance, 1);

  assert.throws(
    () =>
      analyzeCurtainFrames(
        [
          curtainFrame(width, height, { sideFraction: 0.1 }),
          curtainFrame(width, height, { sideFraction: 0.1 }),
          curtainFrame(width, height, { sideFraction: 0.1 }),
        ],
        width,
        height,
        "#d11069",
      ),
    /not visibly closed/,
  );
});

test("encoded countdown gate identifies the exact canonical 3-2-1 glyphs", () => {
  for (const digit of [3, 2, 1] as const) {
    const matched = classifyCountdownGlyph(
      unpackCountdownTemplate(String(digit) as "3" | "2" | "1"),
      digit,
    );
    assert.equal(matched.templateDice, 1);
    assert.ok(matched.templateMargin >= 0.08);
  }
  assert.throws(
    () => classifyCountdownGlyph(unpackCountdownTemplate("3"), 2),
    /expected 2.*canonical glyph/,
  );
});

test("encoded countdown identity rejects an H.264 bridge to pale aircraft scenery", () => {
  const width = 160;
  const height = 148;
  const sourceWidth = countdownTemplates.width;
  const sourceHeight = countdownTemplates.height;
  const source = unpackCountdownTemplate("3");
  const offsetX = 28;
  const offsetY = 10;
  const rgb = Buffer.alloc(width * height * 3);
  let glyphMaxX = 0;
  let bridgeY = 0;
  for (let y = 0; y < sourceHeight; y += 1) {
    for (let x = 0; x < sourceWidth; x += 1) {
      if (!source[y * sourceWidth + x]) continue;
      const targetX = offsetX + x;
      const targetY = offsetY + y;
      const pixel = (targetY * width + targetX) * 3;
      rgb[pixel] = 255;
      rgb[pixel + 1] = 255;
      rgb[pixel + 2] = 255;
      if (targetX > glyphMaxX) {
        glyphMaxX = targetX;
        bridgeY = targetY;
      }
    }
  }
  const stripeStart = glyphMaxX + 5;
  const setNeutral = (x: number, y: number, value: number) => {
    const pixel = (y * width + x) * 3;
    rgb[pixel] = value;
    rgb[pixel + 1] = value;
    rgb[pixel + 2] = value;
  };
  for (let y = 0; y < height; y += 1) {
    for (let x = stripeStart; x < Math.min(width, stripeStart + 8); x += 1) {
      setNeutral(x, y, 218);
    }
  }
  for (let x = glyphMaxX + 1; x <= stripeStart; x += 1) {
    setNeutral(x, bridgeY, 218);
  }

  const recovered = countdownGlyph(rgb, width, height, 113, 3);
  assert.ok(recovered.minimumChannel >= 220);
  assert.ok(recovered.match.expectedDice >= 0.75);
  assert.ok(recovered.match.margin >= 0.08);
  assert.doesNotThrow(() => classifyCountdownGlyph(recovered.normalized, 3));
  assert.throws(
    () => classifyCountdownGlyph(recovered.normalized, 2),
    /expected 2.*canonical glyph/,
  );
});

test("encoded ending and PCM helpers expose strict visual and audible metrics", () => {
  const gray = Buffer.from(
    Array.from({ length: 256 }, (_, index) => (index * 37) % 256),
  );
  const identical = compareGrayFrames(gray, Buffer.from(gray));
  assert.equal(identical.correlation, 1);
  assert.equal(identical.mae, 0);
  assert.equal(identical.psnr, 99);
  const inverted = compareGrayFrames(
    gray,
    Buffer.from(Array.from(gray, (value) => 255 - value)),
  );
  assert.ok(inverted.correlation < -0.99);
  assert.ok(inverted.mae > 100);

  const pcm = Buffer.alloc(8_000 * 2);
  for (let index = 0; index < 8_000; index += 1) {
    pcm.writeInt16LE(Math.round(Math.sin((index / 8_000) * Math.PI * 440 * 2) * 8_192), index * 2);
  }
  const audio = analyzePcm16(pcm);
  assert.equal(audio.samples, 8_000);
  assert.ok(audio.rms > 0.17 && audio.rms < 0.18);
  assert.ok(audio.dbfs > -16 && audio.dbfs < -14);
});

test("teleprompter crop is derived from prepared geometry at encoded resolution", () => {
  const crop = deriveTeleprompterCrop(
    {
      canvas: { width: 1080, height: 1920 },
      content: {
        device: {
          transform: { x: 0.57, y: 0.7, scale: 1.08, rotation: 0 },
        },
        teleprompter: {
          screen: { x: 0.1258, y: 0.03, w: 0.5534, h: 0.8516 },
        },
      },
    },
    { width: 720, height: 1280 },
  );
  assert.deepEqual(crop, { x: 202, y: 542, width: 300, height: 634 });
});

test("afterPack calls encoded QA before disposable production artifacts are cleaned", async () => {
  const testDir = path.dirname(fileURLToPath(import.meta.url));
  const root = path.dirname(testDir);
  const hook = await readFile(path.join(root, "build", "verify-cli-resource.cjs"), "utf8");
  const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };
  assert.match(hook, /const encoded = verifyEncodedProduction\(\{/);
  assert.match(hook, /scenes: produced\.scenes/);
  assert.match(hook, /media: produced\.media/);
  assert.ok(hook.indexOf("verifyEncodedProduction({") < hook.indexOf("fs.rmSync(temporary"));
  assert.match(packageJson.scripts["test:mcp-packaging"], /encoded-production-gate\.test\.mts/);
});
