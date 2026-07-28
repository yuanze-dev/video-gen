const { execFileSync } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const COUNTDOWN_GLYPH_TEMPLATES = require("./countdown-glyph-templates.cjs");

const DEVICE_BASE_W = 820;
const DEVICE_ASPECT = 2438 / 1798;
const OFFICIAL_ENDING_SHA256 =
  "0dafa2391807a86ac20e5e1b749f7f896f7145398b70a26dbb2a6bf0af85fd54";
const SCROLL_EDGE_INSET_X = 0.04;
const SCROLL_EDGE_INSET_Y = 0.035;
const SCROLL_SKIP_SEC = 0.75;
const SCROLL_MAX_SHIFT = 8;
const MAX_SCROLL_RAW_BYTES = 256 * 1024 * 1024;
const SMALL_FRAME_WIDTH = 90;
const SMALL_FRAME_HEIGHT = 160;
const AUDIO_SAMPLE_RATE = 8_000;
// A true 720p render is rasterized independently rather than being a simple
// downscale of the 1080p calibration source. The observed glyph must still
// overlap its canonical mask substantially, while the separate margin check
// proves it matches the requested digit better than either alternative.
const COUNTDOWN_TEMPLATE_MIN_DICE = 0.75;
const COUNTDOWN_TEMPLATE_MIN_MARGIN = 0.08;
const COUNTDOWN_GLYPH_MAX_WIDTH = 80;
const COUNTDOWN_GLYPH_MAX_HEIGHT = 112;
const COUNTDOWN_WHITE_THRESHOLDS = [190, 205, 220, 235, 245];
const COUNTDOWN_EROSION_RADII = [0, 1, 2];

function fail(message) {
  throw new Error(`encoded production QA failed: ${message}`);
}

function finite(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(`${label} is not finite`);
  return value;
}

function integer(value, label) {
  finite(value, label);
  if (!Number.isInteger(value)) fail(`${label} is not an integer`);
  return value;
}

function roundMetric(value, digits = 6) {
  return Number(value.toFixed(digits));
}

function percentile(values, ratio) {
  if (values.length === 0) fail("cannot calculate a percentile from an empty sample");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * ratio)];
}

function median(values) {
  return percentile(values, 0.5);
}

function assertRegularFile(file, label) {
  let stat;
  try {
    stat = fs.lstatSync(file);
  } catch (error) {
    fail(`${label} is missing: ${file}${error instanceof Error ? ` (${error.message})` : ""}`);
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    fail(`${label} is not a non-empty regular file: ${file}`);
  }
  return stat;
}

function sha256File(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function compactError(value) {
  return String(value ?? "")
    .replace(/[\r\n]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 800);
}

function runBinary(executable, args, options = {}) {
  try {
    return execFileSync(executable, args, {
      cwd: options.cwd,
      encoding: options.encoding,
      maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
      timeout: options.timeoutMs ?? 120_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const stderr =
      typeof error === "object" && error !== null && "stderr" in error
        ? compactError(error.stderr)
        : "";
    fail(
      `${path.basename(executable)} inspection failed${stderr ? `: ${stderr}` : ""}`,
    );
  }
}

function decodeFrameRange({
  ffmpeg,
  binariesDirectory,
  videoPath,
  startFrame,
  endFrame,
  width,
  height,
  pixelFormat,
  crop,
}) {
  const bytesPerPixel = pixelFormat === "gray" ? 1 : 3;
  const frameCount = endFrame - startFrame;
  if (frameCount < 1) fail(`invalid frame range ${startFrame}..${endFrame}`);
  const filter = [
    `trim=start_frame=${startFrame}:end_frame=${endFrame}`,
    crop ? `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}` : null,
    width && height ? `scale=${width}:${height}` : null,
    `format=${pixelFormat}`,
  ]
    .filter(Boolean)
    .join(",");
  const expectedBytes = frameCount * width * height * bytesPerPixel;
  const output = runBinary(
    ffmpeg,
    [
      "-v",
      "error",
      "-i",
      videoPath,
      "-vf",
      filter,
      "-an",
      "-fps_mode",
      "passthrough",
      "-c:v",
      "rawvideo",
      "-f",
      "image2pipe",
      "pipe:1",
    ],
    {
      cwd: binariesDirectory,
      maxBuffer: expectedBytes + 256 * 1024,
    },
  );
  if (!Buffer.isBuffer(output) || output.length !== expectedBytes) {
    fail(
      `decoded frame range ${startFrame}..${endFrame} returned ${output?.length ?? 0} bytes, expected ${expectedBytes}`,
    );
  }
  return output;
}

function evenFloor(value) {
  return Math.floor(value / 2) * 2;
}

function evenSize(value) {
  return Math.max(2, evenFloor(value));
}

function deriveTeleprompterCrop(config, media) {
  const canvas = config?.canvas;
  const deviceNode = config?.content?.device;
  const transform = deviceNode?.transform ?? deviceNode;
  const screen = config?.content?.teleprompter?.screen;
  const canvasWidth = finite(canvas?.width, "prepared config canvas.width");
  const canvasHeight = finite(canvas?.height, "prepared config canvas.height");
  const mediaWidth = integer(media?.width, "media.width");
  const mediaHeight = integer(media?.height, "media.height");
  if (!transform || !screen) fail("prepared config is missing the device transform or screen");
  if (Math.abs(finite(transform.rotation, "content.device.transform.rotation")) > 0.001) {
    fail("the encoded scroll crop does not permit a rotated teleprompter device");
  }

  const deviceWidth = DEVICE_BASE_W * finite(transform.scale, "content.device.transform.scale");
  const deviceHeight = deviceWidth * DEVICE_ASPECT;
  const deviceLeft =
    finite(transform.x, "content.device.transform.x") * canvasWidth - deviceWidth / 2;
  const deviceTop =
    finite(transform.y, "content.device.transform.y") * canvasHeight - deviceHeight / 2;
  const screenLeft = deviceLeft + finite(screen.x, "content.teleprompter.screen.x") * deviceWidth;
  const screenTop = deviceTop + finite(screen.y, "content.teleprompter.screen.y") * deviceHeight;
  const screenWidth = finite(screen.w, "content.teleprompter.screen.w") * deviceWidth;
  const screenHeight = finite(screen.h, "content.teleprompter.screen.h") * deviceHeight;
  const scaleX = mediaWidth / canvasWidth;
  const scaleY = mediaHeight / canvasHeight;

  let x = evenFloor((screenLeft + screenWidth * SCROLL_EDGE_INSET_X) * scaleX);
  let y = evenFloor((screenTop + screenHeight * SCROLL_EDGE_INSET_Y) * scaleY);
  let width = evenSize(screenWidth * (1 - SCROLL_EDGE_INSET_X * 2) * scaleX);
  let height = evenSize(screenHeight * (1 - SCROLL_EDGE_INSET_Y * 2) * scaleY);
  x = Math.max(0, Math.min(mediaWidth - 2, x));
  y = Math.max(0, Math.min(mediaHeight - 2, y));
  width = evenSize(Math.min(width, mediaWidth - x));
  height = evenSize(Math.min(height, mediaHeight - y));
  if (width < 80 || height < 120) {
    fail(`derived teleprompter crop is implausibly small: ${width}x${height}`);
  }
  return { x, y, width, height };
}

function rowProjectionFromGray(frame, width, height) {
  const projection = new Float64Array(height);
  let brightPixels = 0;
  for (let y = 0; y < height; y += 1) {
    let sum = 0;
    const rowStart = y * width;
    for (let x = 0; x < width; x += 1) {
      const value = frame[rowStart + x];
      if (value >= 96) {
        brightPixels += 1;
        sum += Math.max(value - 48, 0);
      }
    }
    projection[y] = sum / width;
  }
  return { projection, brightRatio: brightPixels / (width * height) };
}

function shiftedCorrelation(previous, next, shift) {
  const startPrevious = shift >= 0 ? shift : 0;
  const startNext = shift >= 0 ? 0 : -shift;
  const length = Math.min(previous.length - startPrevious, next.length - startNext);
  if (length < 8) return -1;
  let meanPrevious = 0;
  let meanNext = 0;
  for (let index = 0; index < length; index += 1) {
    meanPrevious += previous[startPrevious + index];
    meanNext += next[startNext + index];
  }
  meanPrevious /= length;
  meanNext /= length;
  let numerator = 0;
  let denominatorPrevious = 0;
  let denominatorNext = 0;
  for (let index = 0; index < length; index += 1) {
    const left = previous[startPrevious + index] - meanPrevious;
    const right = next[startNext + index] - meanNext;
    numerator += left * right;
    denominatorPrevious += left * left;
    denominatorNext += right * right;
  }
  const denominator = Math.sqrt(denominatorPrevious * denominatorNext);
  return denominator > 1e-12 ? numerator / denominator : -1;
}

function analyzeScrollProjections(projections, brightRatios, fps) {
  if (!Array.isArray(projections) || projections.length < 2) {
    fail("scroll analysis has fewer than two frames");
  }
  if (!Array.isArray(brightRatios) || brightRatios.length !== projections.length) {
    fail("scroll visibility samples do not match projection frames");
  }
  const minimumPairs = Math.ceil(fps * 4);
  const pairCount = projections.length - 1;
  if (pairCount < minimumPairs) {
    fail(`scroll analysis has only ${pairCount} adjacent pairs; ${minimumPairs} required`);
  }
  const visibleRatio = brightRatios.filter((ratio) => ratio >= 0.002).length / brightRatios.length;
  if (visibleRatio < 0.98) {
    fail(`teleprompter text is visible in only ${(visibleRatio * 100).toFixed(2)}% of frames`);
  }

  const shifts = [];
  const correlations = [];
  const margins = [];
  for (let frame = 0; frame < pairCount; frame += 1) {
    const candidates = [];
    for (let shift = -SCROLL_MAX_SHIFT; shift <= SCROLL_MAX_SHIFT; shift += 1) {
      candidates.push({
        shift,
        correlation: shiftedCorrelation(projections[frame], projections[frame + 1], shift),
      });
    }
    candidates.sort((left, right) => right.correlation - left.correlation);
    shifts.push(candidates[0].shift);
    correlations.push(candidates[0].correlation);
    margins.push(candidates[0].correlation - candidates[1].correlation);
  }

  const reversePairs = shifts.filter((shift) => shift < 0).length;
  const stalledPairs = shifts.filter((shift) => shift === 0).length;
  const largeJumpPairs = shifts.filter((shift) => shift > 4).length;
  const minimumShift = Math.min(...shifts);
  const maximumShift = Math.max(...shifts);
  const medianShift = median(shifts);
  const minimumCorrelation = Math.min(...correlations);
  const p01Correlation = percentile(correlations, 0.01);
  const p01Margin = percentile(margins, 0.01);

  if (reversePairs !== 0) fail(`teleprompter scroll reversed in ${reversePairs} adjacent pairs`);
  if (stalledPairs !== 0) fail(`teleprompter scroll stalled in ${stalledPairs} adjacent pairs`);
  if (largeJumpPairs !== 0) fail(`teleprompter scroll jumped by more than 4px in ${largeJumpPairs} pairs`);
  if (medianShift < 1 || medianShift > 3) {
    fail(`teleprompter median movement is ${medianShift}px/frame; expected 1..3`);
  }
  if (maximumShift - minimumShift > 1) {
    fail(`teleprompter movement is not uniform: ${minimumShift}..${maximumShift}px/frame`);
  }
  if (minimumCorrelation < 0.85 || p01Correlation < 0.94) {
    fail(
      `teleprompter adjacent-frame correlation is too low: min=${minimumCorrelation.toFixed(4)} p01=${p01Correlation.toFixed(4)}`,
    );
  }
  if (p01Margin < 0.002) {
    fail(`teleprompter motion direction is ambiguous: p01 margin=${p01Margin.toFixed(5)}`);
  }

  return {
    frames: projections.length,
    pairs: pairCount,
    visibleRatio: roundMetric(visibleRatio),
    minimumBrightRatio: roundMetric(Math.min(...brightRatios)),
    minimumShift,
    maximumShift,
    medianShift,
    reversePairs,
    stalledPairs,
    largeJumpPairs,
    minimumCorrelation: roundMetric(minimumCorrelation),
    p01Correlation: roundMetric(p01Correlation),
    p01Margin: roundMetric(p01Margin),
  };
}

function inspectEncodedScroll({
  ffmpeg,
  binariesDirectory,
  videoPath,
  config,
  scenes,
  media,
}) {
  if (config?.content?.teleprompter?.mode !== "text") {
    fail("standard encoded scroll QA requires text teleprompter mode");
  }
  const fps = finite(media.fps, "media.fps");
  const openingFrames = integer(scenes.opening.frames, "scenes.opening.frames");
  const contentFrames = integer(scenes.content.frames, "scenes.content.frames");
  const edgeSkip = Math.round(SCROLL_SKIP_SEC * fps);
  const startFrame = openingFrames + edgeSkip;
  const endFrame = openingFrames + contentFrames - edgeSkip;
  const frameCount = endFrame - startFrame;
  if (frameCount - 1 < Math.ceil(fps * 4)) {
    fail("content scene is too short for four seconds of interior scroll analysis");
  }
  const crop = deriveTeleprompterCrop(config, media);
  const expectedBytes = frameCount * crop.width * crop.height;
  if (expectedBytes > MAX_SCROLL_RAW_BYTES) {
    fail(
      `scroll QA raw decode would exceed ${MAX_SCROLL_RAW_BYTES} bytes (${expectedBytes}); refusing unbounded inspection`,
    );
  }

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "littlestart-scroll-qa-"));
  const rawPath = path.join(temporary, "scroll.gray");
  try {
    runBinary(
      ffmpeg,
      [
        "-v",
        "error",
        "-i",
        videoPath,
        "-vf",
        `trim=start_frame=${startFrame}:end_frame=${endFrame},crop=${crop.width}:${crop.height}:${crop.x}:${crop.y},format=gray`,
        "-an",
        "-fps_mode",
        "passthrough",
        "-c:v",
        "rawvideo",
        "-f",
        "image2pipe",
        "-y",
        rawPath,
      ],
      { cwd: binariesDirectory, maxBuffer: 1024 * 1024 },
    );
    const stat = assertRegularFile(rawPath, "scroll raw decode");
    if (stat.size !== expectedBytes) {
      fail(`scroll raw decode has ${stat.size} bytes, expected ${expectedBytes}`);
    }
    const descriptor = fs.openSync(rawPath, "r");
    try {
      const frameBytes = crop.width * crop.height;
      const frame = Buffer.allocUnsafe(frameBytes);
      const projections = [];
      const brightRatios = [];
      for (let index = 0; index < frameCount; index += 1) {
        const bytesRead = fs.readSync(
          descriptor,
          frame,
          0,
          frameBytes,
          index * frameBytes,
        );
        if (bytesRead !== frameBytes) fail(`short scroll frame read at index ${index}`);
        const analyzed = rowProjectionFromGray(frame, crop.width, crop.height);
        projections.push(analyzed.projection);
        brightRatios.push(analyzed.brightRatio);
      }
      return {
        crop,
        startFrame,
        endFrame,
        ...analyzeScrollProjections(projections, brightRatios, fps),
      };
    } finally {
      fs.closeSync(descriptor);
    }
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

function rgbToHsv(red, green, blue) {
  const r = red / 255;
  const g = green / 255;
  const b = blue / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const delta = max - min;
  let hue = 0;
  if (delta > 0) {
    if (max === r) hue = ((g - b) / delta) % 6;
    else if (max === g) hue = (b - r) / delta + 2;
    else hue = (r - g) / delta + 4;
    hue /= 6;
    if (hue < 0) hue += 1;
  }
  return { hue, saturation: max === 0 ? 0 : delta / max, value: max };
}

function parseHexColor(color) {
  const match = /^#([\da-f]{6})$/i.exec(String(color ?? ""));
  if (!match) fail(`curtain color is not #RRGGBB: ${color}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function curtainRatios(frame, width, height, color) {
  const targetRgb = parseHexColor(color);
  const target = rgbToHsv(...targetRgb);
  const minimumValue = target.value * 0.63;
  const minimumSaturation = Math.max(0.25, target.saturation * 0.55);
  const centerLeft = Math.floor(width * 0.25);
  const centerRight = Math.ceil(width * 0.75);
  const centerTop = Math.floor(height * 0.2);
  const centerBottom = Math.ceil(height * 0.9);
  const valanceBottom = Math.max(1, Math.ceil(height * 0.08));
  let fullMatches = 0;
  let centerMatches = 0;
  let centerPixels = 0;
  let valanceMatches = 0;
  let valancePixels = 0;
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    const offset = pixel * 3;
    const actual = rgbToHsv(frame[offset], frame[offset + 1], frame[offset + 2]);
    const hueDistance = Math.min(
      Math.abs(actual.hue - target.hue),
      1 - Math.abs(actual.hue - target.hue),
    );
    const matches =
      hueDistance <= 0.055 &&
      actual.saturation >= minimumSaturation &&
      actual.value >= minimumValue;
    const x = pixel % width;
    const y = Math.floor(pixel / width);
    if (matches) fullMatches += 1;
    if (x >= centerLeft && x < centerRight && y >= centerTop && y < centerBottom) {
      centerPixels += 1;
      if (matches) centerMatches += 1;
    }
    if (y < valanceBottom) {
      valancePixels += 1;
      if (matches) valanceMatches += 1;
    }
  }
  return {
    full: fullMatches / (width * height),
    center: centerMatches / centerPixels,
    valance: valanceMatches / valancePixels,
  };
}

function analyzeCurtainFrames(frames, width, height, color) {
  if (!Array.isArray(frames) || frames.length < 3) fail("curtain analysis needs three frames");
  const ratios = frames.map((frame) => curtainRatios(frame, width, height, color));
  const [first, oneThird, last] = ratios;
  if (first.full < 0.75 || first.center < 0.75) {
    fail(
      `curtain is not visibly closed at the opening: full=${first.full.toFixed(3)} center=${first.center.toFixed(3)}`,
    );
  }
  if (oneThird.center > 0.35) {
    fail(`curtain did not open through the center: one-third=${oneThird.center.toFixed(3)}`);
  }
  if (last.center > 0.08) {
    fail(`curtain still obscures the center at the end: ${last.center.toFixed(3)}`);
  }
  if (last.full < 0.08 || last.full > 0.35) {
    fail(`curtain side stacks are missing or implausible at the end: ${last.full.toFixed(3)}`);
  }
  if (first.full - last.full < 0.45) {
    fail(`curtain coverage decreased by only ${(first.full - last.full).toFixed(3)}`);
  }
  if (last.valance < 0.6) {
    fail(`curtain valance is missing at the end: ${last.valance.toFixed(3)}`);
  }
  return {
    first: Object.fromEntries(Object.entries(first).map(([key, value]) => [key, roundMetric(value)])),
    oneThird: Object.fromEntries(
      Object.entries(oneThird).map(([key, value]) => [key, roundMetric(value)]),
    ),
    last: Object.fromEntries(Object.entries(last).map(([key, value]) => [key, roundMetric(value)])),
  };
}

function deriveCountdownCrop(config, media) {
  const countdown = config.opening.countdown;
  const canvas = config.canvas;
  const scaleX = media.width / canvas.width;
  const scaleY = media.height / canvas.height;
  const fontPixels = countdown.fontSize * Math.min(scaleX, scaleY);
  const centerX = countdown.pos.x * media.width;
  const centerY = countdown.pos.y * media.height;
  const width = evenSize(fontPixels * 1.42);
  const height = evenSize(fontPixels * 1.31);
  const x = Math.max(0, Math.min(media.width - width, evenFloor(centerX - width / 2)));
  const y = Math.max(0, Math.min(media.height - height, evenFloor(centerY - height / 2)));
  return { x, y, width, height, fontPixels };
}

function whiteMask(rgbFrame, width, height, minimumChannel = 190) {
  const mask = new Uint8Array(width * height);
  for (let pixel = 0; pixel < mask.length; pixel += 1) {
    const offset = pixel * 3;
    const r = rgbFrame[offset];
    const g = rgbFrame[offset + 1];
    const b = rgbFrame[offset + 2];
    if (
      r >= minimumChannel &&
      g >= minimumChannel &&
      b >= minimumChannel &&
      Math.max(r, g, b) - Math.min(r, g, b) <= 35
    ) {
      mask[pixel] = 1;
    }
  }
  return mask;
}

function erodeBinaryMask(mask, width, height, radius) {
  if (radius === 0) return mask;
  const eroded = new Uint8Array(mask.length);
  for (let y = radius; y < height - radius; y += 1) {
    for (let x = radius; x < width - radius; x += 1) {
      let keep = true;
      for (let dy = -radius; dy <= radius && keep; dy += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (!mask[(y + dy) * width + x + dx]) {
            keep = false;
            break;
          }
        }
      }
      if (keep) eroded[y * width + x] = 1;
    }
  }
  return eroded;
}

function connectedComponents(mask, width, height) {
  const seen = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const components = [];
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || seen[start]) continue;
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    seen[start] = 1;
    let area = 0;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    let sumX = 0;
    let sumY = 0;
    while (head < tail) {
      const pixel = queue[head++];
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      area += 1;
      sumX += x;
      sumY += y;
      minX = Math.min(minX, x);
      maxX = Math.max(maxX, x);
      minY = Math.min(minY, y);
      maxY = Math.max(maxY, y);
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          const nextX = x + dx;
          const nextY = y + dy;
          if (nextX < 0 || nextX >= width || nextY < 0 || nextY >= height) continue;
          const next = nextY * width + nextX;
          if (mask[next] && !seen[next]) {
            seen[next] = 1;
            queue[tail++] = next;
          }
        }
      }
    }
    components.push({
      pixels: Int32Array.from(queue.subarray(0, tail)),
      area,
      minX,
      maxX,
      minY,
      maxY,
      width: maxX - minX + 1,
      height: maxY - minY + 1,
      centerX: sumX / area,
      centerY: sumY / area,
    });
  }
  return components;
}

function normalizeComponent(mask, sourceWidth, component, width = 96, height = 128) {
  const normalized = new Uint8Array(width * height);
  const componentPixels = new Set(component.pixels);
  const scale = Math.min(
    COUNTDOWN_GLYPH_MAX_WIDTH / component.width,
    COUNTDOWN_GLYPH_MAX_HEIGHT / component.height,
  );
  const targetWidth = Math.max(1, Math.round(component.width * scale));
  const targetHeight = Math.max(1, Math.round(component.height * scale));
  const offsetX = Math.floor((width - targetWidth) / 2);
  const offsetY = Math.floor((height - targetHeight) / 2);
  for (let y = 0; y < targetHeight; y += 1) {
    const sourceY =
      component.minY +
      Math.min(
        component.height - 1,
        Math.round(
          (y * (component.height - 1)) / Math.max(1, targetHeight - 1),
        ),
      );
    for (let x = 0; x < targetWidth; x += 1) {
      const sourceX =
        component.minX +
        Math.min(
          component.width - 1,
          Math.round(
            (x * (component.width - 1)) / Math.max(1, targetWidth - 1),
          ),
        );
      const sourceIndex = sourceY * sourceWidth + sourceX;
      normalized[(offsetY + y) * width + offsetX + x] =
        componentPixels.has(sourceIndex) && mask[sourceIndex] ? 1 : 0;
    }
  }
  return normalized;
}

function dice(left, right) {
  if (left.length !== right.length) fail("cannot compare normalized glyphs of different sizes");
  let intersection = 0;
  let leftCount = 0;
  let rightCount = 0;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]) leftCount += 1;
    if (right[index]) rightCount += 1;
    if (left[index] && right[index]) intersection += 1;
  }
  return leftCount + rightCount === 0 ? 0 : (2 * intersection) / (leftCount + rightCount);
}

let countdownTemplateMasks = null;

function getCountdownTemplateMasks() {
  if (countdownTemplateMasks) return countdownTemplateMasks;
  const width = COUNTDOWN_GLYPH_TEMPLATES.width;
  const height = COUNTDOWN_GLYPH_TEMPLATES.height;
  if (
    width !== 96 ||
    height !== 128 ||
    COUNTDOWN_GLYPH_TEMPLATES.packing !== "row-major-msb-first"
  ) {
    fail("countdown glyph templates have an unsupported geometry or packing");
  }
  const pixelCount = width * height;
  const packedBytes = Math.ceil(pixelCount / 8);
  const decoded = {};
  for (const digit of ["3", "2", "1"]) {
    const template = COUNTDOWN_GLYPH_TEMPLATES.digits?.[digit];
    const packed = Buffer.from(String(template?.bitmapBase64 ?? ""), "base64");
    const digest = crypto.createHash("sha256").update(packed).digest("hex");
    if (packed.length !== packedBytes || digest !== template?.sha256) {
      fail(`countdown glyph template ${digit} failed its integrity check`);
    }
    const mask = new Uint8Array(pixelCount);
    for (let index = 0; index < pixelCount; index += 1) {
      mask[index] = (packed[index >> 3] >> (7 - (index & 7))) & 1;
    }
    decoded[digit] = mask;
  }
  countdownTemplateMasks = decoded;
  return decoded;
}

function scoreCountdownGlyph(observed, expectedDigit) {
  const templates = getCountdownTemplateMasks();
  const scores = Object.fromEntries(
    Object.entries(templates).map(([digit, template]) => [digit, dice(observed, template)]),
  );
  const ranked = Object.entries(scores).sort((left, right) => right[1] - left[1]);
  const predictedDigit = Number(ranked[0][0]);
  const bestDice = ranked[0][1];
  const classificationMargin = ranked[0][1] - ranked[1][1];
  const expectedDice = scores[String(expectedDigit)];
  const runnerUpDice = Math.max(
    ...Object.entries(scores)
      .filter(([digit]) => digit !== String(expectedDigit))
      .map(([, score]) => score),
  );
  const margin = expectedDice - runnerUpDice;
  return {
    scores,
    predictedDigit,
    bestDice,
    classificationMargin,
    expectedDice,
    runnerUpDice,
    margin,
  };
}

function classifyCountdownGlyph(observed, expectedDigit) {
  const { scores, expectedDice, margin } = scoreCountdownGlyph(observed, expectedDigit);
  if (expectedDice < COUNTDOWN_TEMPLATE_MIN_DICE || margin < COUNTDOWN_TEMPLATE_MIN_MARGIN) {
    fail(
      `countdown slot expected ${expectedDigit} but did not match its canonical glyph: ` +
        `Dice=${expectedDice.toFixed(3)} margin=${margin.toFixed(3)}`,
    );
  }
  return {
    templateDice: roundMetric(expectedDice),
    templateMargin: roundMetric(margin),
    templateScores: Object.fromEntries(
      Object.entries(scores).map(([digit, score]) => [digit, roundMetric(score)]),
    ),
  };
}

function countdownGlyph(rgbFrame, width, height, fontPixels, expectedDigit) {
  const centerX = width / 2;
  const centerY = height / 2;
  // A bright background can become joined to the white glyph fill through
  // H.264 ringing even though the rendered black stroke visibly separates
  // them. Evaluate multiple neutral-white thresholds and light erosions. The
  // higher thresholds reject pale aircraft/window scenery; erosion removes a
  // remaining one- or two-pixel bridge. The selected component must still pass
  // the canonical digit Dice and runner-up margin, so segmentation flexibility
  // cannot turn an arbitrary blob or the wrong digit into 3/2/1.
  const segmentationMasks = COUNTDOWN_WHITE_THRESHOLDS.flatMap((minimumChannel) => {
    const thresholdMask = whiteMask(rgbFrame, width, height, minimumChannel);
    return COUNTDOWN_EROSION_RADII.map((erosionRadius) => ({
      minimumChannel,
      erosionRadius,
      mask: erodeBinaryMask(thresholdMask, width, height, erosionRadius),
    }));
  });
  const allComponents = [];
  const candidates = segmentationMasks
    .flatMap(({ minimumChannel, erosionRadius, mask }) =>
      connectedComponents(mask, width, height).map((component) => {
        allComponents.push({ ...component, minimumChannel, erosionRadius });
        return { component, minimumChannel, erosionRadius, mask };
      }),
    )
    .filter(({ component: candidate }) => {
      const distance = Math.hypot(candidate.centerX - centerX, candidate.centerY - centerY);
      return (
        candidate.area >= 0.03 * fontPixels * fontPixels &&
        candidate.area <= 0.4 * fontPixels * fontPixels &&
        candidate.width >= 0.15 * fontPixels &&
        candidate.width <= 0.85 * fontPixels &&
        candidate.height >= 0.4 * fontPixels &&
        // Independent 720p rasterization and the 5px black stroke can make the
        // connected white fill slightly taller than the nominal CSS font size.
        // Identity is still decided by the canonical template below.
        candidate.height <= 1.15 * fontPixels &&
        distance <= 0.45 * fontPixels
      );
    })
    .map(({ component, minimumChannel, erosionRadius, mask }) => {
      const normalized = normalizeComponent(mask, width, component);
      const match = scoreCountdownGlyph(normalized, expectedDigit);
      return { component, minimumChannel, erosionRadius, normalized, match };
    })
    .sort(
      (left, right) =>
        right.match.bestDice - left.match.bestDice ||
        right.match.classificationMargin - left.match.classificationMargin ||
        right.component.area - left.component.area,
    );
  const selected = candidates[0];
  if (!selected) {
    const largest = allComponents
      .sort((left, right) => right.area - left.area)
      .slice(0, 5)
      .map(
        ({
          area,
          width: boxWidth,
          height: boxHeight,
          centerX: x,
          centerY: y,
          minimumChannel,
          erosionRadius,
        }) => ({
          area,
          width: boxWidth,
          height: boxHeight,
          centerX: roundMetric(x, 2),
          centerY: roundMetric(y, 2),
          minimumChannel,
          erosionRadius,
        }),
      );
    fail(
      `countdown glyph is missing from an expected digit slot; largest components=${JSON.stringify(largest)}`,
    );
  }
  return selected;
}

function analyzeCountdownFrames(buffer, crop, countdown, fps, openingFrames) {
  const bytesPerFrame = crop.width * crop.height * 3;
  const slots = [];
  for (let digit = countdown.from; digit >= 1; digit -= 1) {
    const centerFrame = Math.floor(((countdown.from - digit + 0.5) * fps) / countdown.speed);
    if (centerFrame < 2 || centerFrame + 2 >= openingFrames) {
      fail(`countdown slot for digit ${digit} falls outside the opening timeline`);
    }
    const glyphs = [];
    for (let frame = centerFrame - 2; frame <= centerFrame + 2; frame += 1) {
      const rgb = buffer.subarray(frame * bytesPerFrame, (frame + 1) * bytesPerFrame);
      glyphs.push(countdownGlyph(rgb, crop.width, crop.height, crop.fontPixels, digit));
    }
    const reference = glyphs[2].normalized;
    const minimumConsistency = Math.min(...glyphs.map((glyph) => dice(reference, glyph.normalized)));
    if (minimumConsistency < 0.95) {
      fail(`countdown glyph ${digit} flickers within its slot: Dice=${minimumConsistency.toFixed(3)}`);
    }
    const identity = classifyCountdownGlyph(reference, digit);
    slots.push({
      digit,
      centerFrame,
      minimumConsistency: roundMetric(minimumConsistency),
      area: glyphs[2].component.area,
      width: glyphs[2].component.width,
      height: glyphs[2].component.height,
      segmentationMinimumChannel: glyphs[2].minimumChannel,
      segmentationErosionRadius: glyphs[2].erosionRadius,
      ...identity,
      normalized: reference,
    });
  }
  for (let left = 0; left < slots.length; left += 1) {
    for (let right = left + 1; right < slots.length; right += 1) {
      const similarity = dice(slots[left].normalized, slots[right].normalized);
      if (similarity > 0.92) {
        fail(
          `countdown slots ${slots[left].digit} and ${slots[right].digit} render the same glyph (Dice=${similarity.toFixed(3)})`,
        );
      }
    }
  }
  return {
    slots: slots.map((slot) => ({
      digit: slot.digit,
      centerFrame: slot.centerFrame,
      minimumConsistency: slot.minimumConsistency,
      area: slot.area,
      width: slot.width,
      height: slot.height,
      segmentationMinimumChannel: slot.segmentationMinimumChannel,
      segmentationErosionRadius: slot.segmentationErosionRadius,
      templateDice: slot.templateDice,
      templateMargin: slot.templateMargin,
      templateScores: slot.templateScores,
    })),
  };
}

function inspectEncodedOpening({ ffmpeg, binariesDirectory, videoPath, config, scenes, media }) {
  const countdown = config?.opening?.countdown;
  const curtain = config?.opening?.curtain;
  if (!countdown?.enabled || countdown.from !== 3) {
    fail("prepared opening does not contain the standard enabled 3-2-1 countdown");
  }
  const fps = finite(media.fps, "media.fps");
  const openingFrames = integer(scenes.opening.frames, "scenes.opening.frames");
  const expectedOpeningFrames = Math.round((countdown.from / countdown.speed) * fps);
  if (openingFrames !== expectedOpeningFrames) {
    fail(`opening timeline is ${openingFrames} frames; expected ${expectedOpeningFrames}`);
  }
  if (openingFrames < Math.ceil(fps * 1.4)) {
    fail(`opening timeline is shorter than 1.4 seconds: ${openingFrames} frames`);
  }

  const small = decodeFrameRange({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startFrame: 0,
    endFrame: openingFrames,
    width: SMALL_FRAME_WIDTH,
    height: SMALL_FRAME_HEIGHT,
    pixelFormat: "rgb24",
  });
  const smallBytes = SMALL_FRAME_WIDTH * SMALL_FRAME_HEIGHT * 3;
  const sampleIndexes = [0, Math.floor((openingFrames - 1) / 3), openingFrames - 2];
  const curtainFrames = sampleIndexes.map((frame) =>
    small.subarray(frame * smallBytes, (frame + 1) * smallBytes),
  );
  const curtainMetrics = analyzeCurtainFrames(
    curtainFrames,
    SMALL_FRAME_WIDTH,
    SMALL_FRAME_HEIGHT,
    curtain.color,
  );

  const countdownCrop = deriveCountdownCrop(config, media);
  const countdownRgb = decodeFrameRange({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startFrame: 0,
    endFrame: openingFrames,
    width: countdownCrop.width,
    height: countdownCrop.height,
    pixelFormat: "rgb24",
    crop: countdownCrop,
  });
  const countdownMetrics = analyzeCountdownFrames(
    countdownRgb,
    countdownCrop,
    countdown,
    fps,
    openingFrames,
  );
  return {
    frames: openingFrames,
    seconds: roundMetric(openingFrames / fps),
    curtain: { sampleFrames: sampleIndexes, ...curtainMetrics },
    countdown: {
      from: countdown.from,
      speed: countdown.speed,
      crop: {
        x: countdownCrop.x,
        y: countdownCrop.y,
        width: countdownCrop.width,
        height: countdownCrop.height,
      },
      ...countdownMetrics,
    },
  };
}

function parseRate(value) {
  const [numerator, denominator] = String(value ?? "0/1").split("/").map(Number);
  return denominator > 0 && Number.isFinite(numerator) ? numerator / denominator : 0;
}

function probeVideo(ffprobe, binariesDirectory, videoPath) {
  const stdout = runBinary(
    ffprobe,
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate,avg_frame_rate,nb_frames,duration:format=duration",
      "-of",
      "json",
      videoPath,
    ],
    { cwd: binariesDirectory, encoding: "utf8" },
  );
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    fail(`ffprobe emitted invalid JSON for ${videoPath}`);
  }
  const stream = parsed?.streams?.[0];
  const fps = parseRate(stream?.avg_frame_rate) || parseRate(stream?.r_frame_rate);
  const duration = Number(stream?.duration ?? parsed?.format?.duration);
  let frames = Number(stream?.nb_frames);
  if (!Number.isInteger(frames) || frames < 1) frames = Math.round(duration * fps);
  if (!(fps > 0) || !(duration > 0) || !(frames > 0)) {
    fail(`official ending probe is incomplete for ${videoPath}`);
  }
  return { fps, duration, frames };
}

function compareGrayFrames(left, right) {
  if (left.length !== right.length || left.length === 0) {
    fail("cannot compare empty or differently sized ending frames");
  }
  let meanLeft = 0;
  let meanRight = 0;
  let absoluteError = 0;
  let squaredError = 0;
  for (let index = 0; index < left.length; index += 1) {
    meanLeft += left[index];
    meanRight += right[index];
    const difference = left[index] - right[index];
    absoluteError += Math.abs(difference);
    squaredError += difference * difference;
  }
  meanLeft /= left.length;
  meanRight /= right.length;
  let numerator = 0;
  let denominatorLeft = 0;
  let denominatorRight = 0;
  for (let index = 0; index < left.length; index += 1) {
    const centeredLeft = left[index] - meanLeft;
    const centeredRight = right[index] - meanRight;
    numerator += centeredLeft * centeredRight;
    denominatorLeft += centeredLeft * centeredLeft;
    denominatorRight += centeredRight * centeredRight;
  }
  const denominator = Math.sqrt(denominatorLeft * denominatorRight);
  const correlation = denominator > 1e-12 ? numerator / denominator : 0;
  const mae = absoluteError / left.length;
  const mse = squaredError / left.length;
  const psnr = mse === 0 ? 99 : 10 * Math.log10((255 * 255) / mse);
  return {
    correlation: roundMetric(correlation),
    mae: roundMetric(mae),
    psnr: roundMetric(psnr),
  };
}

function inspectEncodedEnding({
  ffmpeg,
  ffprobe,
  binariesDirectory,
  videoPath,
  endingAssetPath,
  config,
  scenes,
  media,
}) {
  const ending = config?.ending?.video;
  if (
    ending?.asset?.kind !== "builtin" ||
    ending.asset.id !== "flowprompter-outro" ||
    ending.keepAudio !== true
  ) {
    fail("prepared ending is not the audible official flowprompter-outro asset");
  }
  assertRegularFile(endingAssetPath, "official ending source");
  const endingSha256 = sha256File(endingAssetPath);
  if (endingSha256 !== OFFICIAL_ENDING_SHA256) {
    fail(`official ending source digest changed: ${endingSha256}`);
  }
  const fps = finite(media.fps, "media.fps");
  const openingFrames = integer(scenes.opening.frames, "scenes.opening.frames");
  const contentFrames = integer(scenes.content.frames, "scenes.content.frames");
  const endingFrames = integer(scenes.ending.frames, "scenes.ending.frames");
  const endingStart = openingFrames + contentFrames;
  if (endingFrames < Math.ceil(fps)) fail("encoded ending is shorter than one second");
  const outputEnding = decodeFrameRange({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startFrame: endingStart,
    endFrame: endingStart + endingFrames,
    width: SMALL_FRAME_WIDTH,
    height: SMALL_FRAME_HEIGHT,
    pixelFormat: "gray",
  });
  const sourceProbe = probeVideo(ffprobe, binariesDirectory, endingAssetPath);
  const sourceFrames = decodeFrameRange({
    ffmpeg,
    binariesDirectory,
    videoPath: endingAssetPath,
    startFrame: 0,
    endFrame: sourceProbe.frames,
    width: SMALL_FRAME_WIDTH,
    height: SMALL_FRAME_HEIGHT,
    pixelFormat: "gray",
  });
  const frameBytes = SMALL_FRAME_WIDTH * SMALL_FRAME_HEIGHT;
  const relativeSamples = [2, Math.floor(endingFrames / 2), endingFrames - 4];
  const comparisons = relativeSamples.map((outputFrame) => {
    const sourceFrame = Math.max(
      0,
      Math.min(sourceProbe.frames - 1, Math.round((outputFrame / fps) * sourceProbe.fps)),
    );
    const metrics = compareGrayFrames(
      outputEnding.subarray(outputFrame * frameBytes, (outputFrame + 1) * frameBytes),
      sourceFrames.subarray(sourceFrame * frameBytes, (sourceFrame + 1) * frameBytes),
    );
    if (metrics.correlation < 0.995 || metrics.mae > 3 || metrics.psnr < 32) {
      fail(
        `official ending mismatch at output frame ${endingStart + outputFrame}: corr=${metrics.correlation} mae=${metrics.mae} psnr=${metrics.psnr}`,
      );
    }
    return { outputFrame: endingStart + outputFrame, sourceFrame, ...metrics };
  });

  const before = decodeFrameRange({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startFrame: endingStart - 2,
    endFrame: endingStart - 1,
    width: SMALL_FRAME_WIDTH,
    height: SMALL_FRAME_HEIGHT,
    pixelFormat: "gray",
  });
  const early = compareGrayFrames(before, sourceFrames.subarray(0, frameBytes));
  if (early.correlation >= 0.98 && early.mae <= 8) {
    fail("official ending begins before the ending scene boundary");
  }
  return {
    asset: "flowprompter-outro",
    sha256: endingSha256,
    startFrame: endingStart,
    frames: endingFrames,
    comparisons,
    preEnding: early,
  };
}

function parsePcm16Wave(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 44 || buffer.toString("ascii", 0, 4) !== "RIFF") {
    fail("audio decoder did not return a RIFF/WAVE stream");
  }
  let offset = 12;
  let format = null;
  let data = null;
  while (offset + 8 <= buffer.length) {
    const id = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = Math.min(buffer.length, start + size);
    if (id === "fmt " && size >= 16) {
      format = {
        encoding: buffer.readUInt16LE(start),
        channels: buffer.readUInt16LE(start + 2),
        sampleRate: buffer.readUInt32LE(start + 4),
        bitsPerSample: buffer.readUInt16LE(start + 14),
      };
    } else if (id === "data") {
      data = buffer.subarray(start, end);
    }
    offset = start + size + (size & 1);
  }
  if (
    !format ||
    format.encoding !== 1 ||
    format.channels !== 1 ||
    format.bitsPerSample !== 16 ||
    format.sampleRate !== AUDIO_SAMPLE_RATE ||
    !data ||
    data.length < 2
  ) {
    fail("decoded audio is not non-empty mono 8kHz PCM16");
  }
  return data;
}

function analyzePcm16(pcm) {
  const samples = Math.floor(pcm.length / 2);
  if (samples < 1) fail("cannot analyze empty PCM audio");
  let squares = 0;
  let peak = 0;
  for (let index = 0; index < samples; index += 1) {
    const value = pcm.readInt16LE(index * 2) / 32768;
    squares += value * value;
    peak = Math.max(peak, Math.abs(value));
  }
  const rms = Math.sqrt(squares / samples);
  return {
    samples,
    rms,
    dbfs: rms > 0 ? 20 * Math.log10(rms) : -Infinity,
    peak,
  };
}

function decodeAudioInterval({ ffmpeg, binariesDirectory, videoPath, startSec, durationSec }) {
  if (!(durationSec > 0.1) || startSec < 0) fail("invalid audio inspection interval");
  const expectedBytes = Math.ceil(durationSec * AUDIO_SAMPLE_RATE * 2 + 256 * 1024);
  const wave = runBinary(
    ffmpeg,
    [
      "-v",
      "error",
      "-ss",
      startSec.toFixed(6),
      "-t",
      durationSec.toFixed(6),
      "-i",
      videoPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      String(AUDIO_SAMPLE_RATE),
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "pipe:1",
    ],
    { cwd: binariesDirectory, maxBuffer: expectedBytes },
  );
  return analyzePcm16(parsePcm16Wave(wave));
}

function audibleMetrics(metrics, label) {
  if (!Number.isFinite(metrics.dbfs) || metrics.dbfs < -55) {
    fail(`${label} audio is silent or inaudible: ${metrics.dbfs.toFixed(2)} dBFS`);
  }
  return {
    samples: metrics.samples,
    rms: roundMetric(metrics.rms, 8),
    dbfs: roundMetric(metrics.dbfs),
    peak: roundMetric(metrics.peak),
  };
}

function inspectEncodedAudio({
  ffmpeg,
  binariesDirectory,
  videoPath,
  endingAssetPath,
  scenes,
}) {
  const openingSec = finite(scenes.opening.seconds, "scenes.opening.seconds");
  const contentSec = finite(scenes.content.seconds, "scenes.content.seconds");
  const endingSec = finite(scenes.ending.seconds, "scenes.ending.seconds");
  const opening = decodeAudioInterval({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startSec: 0,
    durationSec: openingSec,
  });
  const content = decodeAudioInterval({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startSec: openingSec,
    durationSec: contentSec,
  });
  const ending = decodeAudioInterval({
    ffmpeg,
    binariesDirectory,
    videoPath,
    startSec: openingSec + contentSec,
    durationSec: endingSec,
  });
  const endingSource = decodeAudioInterval({
    ffmpeg,
    binariesDirectory,
    videoPath: endingAssetPath,
    startSec: 0,
    durationSec: endingSec,
  });
  audibleMetrics(opening, "opening");
  audibleMetrics(content, "content");
  audibleMetrics(ending, "ending");
  audibleMetrics(endingSource, "official ending source");
  const endingRmsRatio = ending.rms / endingSource.rms;
  if (endingRmsRatio < 0.35 || endingRmsRatio > 2) {
    fail(`ending audio RMS differs from the official source by ${endingRmsRatio.toFixed(3)}x`);
  }
  return {
    sampleRate: AUDIO_SAMPLE_RATE,
    opening: audibleMetrics(opening, "opening"),
    content: audibleMetrics(content, "content"),
    ending: audibleMetrics(ending, "ending"),
    endingSource: audibleMetrics(endingSource, "official ending source"),
    endingRmsRatio: roundMetric(endingRmsRatio),
  };
}

function verifyEncodedProduction({
  videoPath,
  preparedConfigPath,
  scenes,
  media,
  binariesDirectory,
  endingAssetPath,
}) {
  assertRegularFile(videoPath, "final MP4");
  assertRegularFile(preparedConfigPath, "prepared config");
  assertRegularFile(path.join(binariesDirectory, "ffmpeg"), "packaged Remotion ffmpeg");
  assertRegularFile(path.join(binariesDirectory, "ffprobe"), "packaged Remotion ffprobe");
  const ffmpeg = path.join(binariesDirectory, "ffmpeg");
  const ffprobe = path.join(binariesDirectory, "ffprobe");
  let config;
  try {
    config = JSON.parse(fs.readFileSync(preparedConfigPath, "utf8"));
  } catch (error) {
    fail(`prepared config is invalid JSON${error instanceof Error ? `: ${error.message}` : ""}`);
  }
  if (!scenes || !media) fail("CLI result is missing scenes or media metadata");

  const opening = inspectEncodedOpening({
    ffmpeg,
    binariesDirectory,
    videoPath,
    config,
    scenes,
    media,
  });
  const scroll = inspectEncodedScroll({
    ffmpeg,
    binariesDirectory,
    videoPath,
    config,
    scenes,
    media,
  });
  const ending = inspectEncodedEnding({
    ffmpeg,
    ffprobe,
    binariesDirectory,
    videoPath,
    endingAssetPath,
    config,
    scenes,
    media,
  });
  const audio = inspectEncodedAudio({
    ffmpeg,
    binariesDirectory,
    videoPath,
    endingAssetPath,
    scenes,
  });
  return { opening, scroll, ending, audio };
}

module.exports = {
  OFFICIAL_ENDING_SHA256,
  analyzeCurtainFrames,
  analyzePcm16,
  analyzeScrollProjections,
  classifyCountdownGlyph,
  compareGrayFrames,
  countdownGlyph,
  deriveTeleprompterCrop,
  shiftedCorrelation,
  verifyEncodedProduction,
};
