import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";

// Randomness belongs in the saved source configuration, never in a render frame.
export const CURTAIN_PALETTE = [
  { name: "深海蓝", color: "#234E70" },
  { name: "孔雀绿", color: "#24645E" },
  { name: "酒红", color: "#793D52" },
  { name: "烟紫", color: "#625078" },
  { name: "赤陶", color: "#985B46" },
  { name: "松绿", color: "#3C604E" },
];

async function main() {
  const args = process.argv.slice(2);
  const source = args.shift();
  const options = {};
  while (args.length) {
    const flag = args.shift();
    if (!["--out", "--cli", "--extra-seconds", "--quality", "--resolution", "--fps"].includes(flag) || !args.length) {
      throw new Error(`未知选项或缺少值: ${flag}`);
    }
    if (options[flag] !== undefined) throw new Error(`重复选项: ${flag}`);
    options[flag] = args.shift();
  }
  if (!source || !options["--out"]) {
    throw new Error("用法: node prepare-production.mjs <源配置.json> --out <新配置.json> [--cli <CLI.mjs|CLI.cjs>] [--extra-seconds 4] [--quality high --resolution 1080p --fps 60]");
  }
  const sourcePath = path.resolve(source);
  const outputPath = path.resolve(options["--out"]);
  const reportPath = `${outputPath}.production-policy.json`;
  if (path.dirname(sourcePath) !== path.dirname(outputPath)) {
    throw new Error("新配置须与源配置同目录，保持素材相对路径有效");
  }
  for (const file of [outputPath, reportPath]) {
    try { await fs.access(file); } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    throw new Error(`已有输出，重试请直接使用保存的配置: ${file}`);
  }
  const extraSeconds = Number(options["--extra-seconds"] ?? 4);
  if (!Number.isFinite(extraSeconds) || extraSeconds < 0 || extraSeconds > 30) {
    throw new Error("extra-seconds 须在 0..30 之间");
  }
  const cli = options["--cli"] ? [process.execPath, path.resolve(options["--cli"])] : ["littlestart"];
  const exportArgs = ["--quality", "--resolution", "--fps"].flatMap(flag =>
    options[flag] === undefined ? [] : [flag, options[flag]],
  );
  function run(command, file) {
    const child = spawnSync(cli[0], [...cli.slice(1), ...command, file, ...(command[0] === "plan" ? exportArgs : []), "--json"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    if (child.error) throw child.error;
    const envelope = JSON.parse(child.stdout);
    if (child.status !== 0 || !envelope.ok) throw new Error(JSON.stringify(envelope.error ?? envelope));
    return envelope.result;
  }
  const sourceBytes = await fs.readFile(sourcePath);
  const config = JSON.parse(sourceBytes);
  if (config.lockVersion !== undefined) throw new Error("请使用源配置，不能重新准备已锁定视频");
  const resolved = run(["config", "resolve"], sourcePath).config;
  if (resolved.content.teleprompter.mode !== "text") {
    throw new Error("正文延长规则只适用于文字滚动，不改变上传视频的播放速度");
  }
  const before = run(["plan"], sourcePath).plan;
  const baseSeconds = before.timeline.content.seconds;
  const originalSpeed = resolved.content.teleprompter.text.speed;
  if (extraSeconds && (baseSeconds <= 6 || baseSeconds + extraSeconds > 600)) {
    throw new Error("正文触及最短或最长时长限制，请先调整源配置，再准备延长");
  }
  const speed = originalSpeed * baseSeconds / (baseSeconds + extraSeconds);
  if (speed < 0.3 || speed > 3) {
    throw new Error("延长后的速度超出 schema 范围，请调整源速度或 extra-seconds");
  }
  const explicitColor = config.opening?.curtain?.color;
  const curtain = explicitColor
    ? { name: "源配置指定", color: explicitColor }
    : CURTAIN_PALETTE[crypto.randomInt(CURTAIN_PALETTE.length)];
  config.opening ??= {};
  config.opening.curtain = { ...config.opening.curtain, color: curtain.color };
  config.content ??= {};
  config.content.teleprompter ??= {};
  config.content.teleprompter.text = { ...config.content.teleprompter.text, speed };
  await fs.writeFile(outputPath, JSON.stringify(config, null, 2) + "\n", { flag: "wx" });
  const after = run(["plan"], outputPath).plan;
  const fps = after.output.fps;
  const actualExtraSeconds = (after.timeline.content.frames - before.timeline.content.frames) / fps;
  if (Math.abs(actualExtraSeconds - extraSeconds) > 1 / fps + 1e-8 ||
      after.timeline.opening.frames !== before.timeline.opening.frames ||
      after.timeline.ending.frames !== before.timeline.ending.frames) {
    throw new Error("时长验证失败，已保留配置供检查，请勿生产");
  }
  const report = {
    policyVersion: 1, source: sourcePath, sourceSha256: crypto.createHash("sha256").update(sourceBytes).digest("hex"),
    config: outputPath, curtain, originalSpeed, speed, requestedExtraSeconds: extraSeconds, actualExtraSeconds,
    before: before.timeline, after: after.timeline, export: after.export,
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  process.stdout.write(JSON.stringify({ ok: true, ...report, report: reportPath }, null, 2) + "\n");
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
