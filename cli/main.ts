// 小音符起号助手 — 本地渲染 CLI。
//
// 面向脚本 / AI 调用的无界面入口：读取一份（可以只写改动字段的）JSON 配置，
// 在本机渲染出 MP4。人类可读的进度走 stderr，机器可读的结果 JSON 走 stdout。
//
//   node scripts/cli.mjs render 配置.json --out 视频.mp4
//   node scripts/cli.mjs validate 配置.json
//   node scripts/cli.mjs init 配置.json
//   node scripts/cli.mjs assets
import path from "node:path";
import fs from "node:fs/promises";
import { loadCliConfig } from "./config";
import { renderVideo } from "./render";
import { makeDefaultConfig } from "../lib/config-schema";
import { resolveConfig } from "../lib/resolved";
import { totalSec, openingSec, contentSec, endingSec } from "../lib/duration";
import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportFps,
  type ExportOptions,
  type ExportQuality,
  type ExportResolution,
} from "../lib/export-options";

// Compiled to cli/dist/main.cjs, so the project root is two levels up.
const ROOT = path.resolve(__dirname, "..", "..");

const log = (msg: string): void => {
  process.stderr.write(`${msg}\n`);
};
const emit = (data: unknown): void => {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
};

const USAGE = `小音符起号助手 · 本地渲染 CLI

用法:
  node scripts/cli.mjs render <配置.json> [选项]   渲染视频
  node scripts/cli.mjs validate <配置.json>        校验配置并给出时长预估
  node scripts/cli.mjs init [路径]                 生成完整默认配置（默认 video-config.json）
  node scripts/cli.mjs assets                      列出内置素材
  node scripts/cli.mjs help                        显示本帮助

render 选项:
  --out <路径>          输出 MP4 路径（默认 output/video-<时间戳>.mp4）
  --cover <路径>        同时导出首帧封面 JPG
  --quality <档位>      画质: high | standard | small（默认 high）
  --resolution <档位>   清晰度: 1080p | 720p（默认 1080p）
  --fps <帧率>          流畅度: 30 | 60（默认 60）
  --rebuild             强制重新打包 Remotion 合成站点

配置说明:
  配置是"改哪写哪"的部分 JSON，会深合并到默认配置上。素材字段除内置
  { "kind": "builtin", "id": "airport" } 外，还支持本地文件
  { "kind": "file", "path": "./bg.jpg" }（路径相对配置文件所在目录）。
  完整字段参考 lib/config-schema.ts 或运行 init 查看默认配置。`;

type Flags = Record<string, string | boolean>;

// Minimal flag parser: `--key value` for known value flags, `--flag` boolean.
function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const valueFlags = new Set(["out", "cover", "quality", "resolution", "fps"]);
  const positional: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) {
      positional.push(a);
      continue;
    }
    const key = a.slice(2);
    if (valueFlags.has(key)) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) {
        throw new Error(`选项 --${key} 需要一个值`);
      }
      flags[key] = v;
      i += 1;
    } else {
      flags[key] = true;
    }
  }
  return { positional, flags };
}

function parseExportOptions(flags: Flags): ExportOptions {
  const quality = (flags.quality ?? DEFAULT_EXPORT_OPTIONS.quality) as string;
  const resolution = (flags.resolution ?? DEFAULT_EXPORT_OPTIONS.resolution) as string;
  const fps = String(flags.fps ?? DEFAULT_EXPORT_OPTIONS.fps);

  if (!["high", "standard", "small"].includes(quality)) {
    throw new Error(`--quality 只能是 high | standard | small，收到 "${quality}"`);
  }
  if (!["1080p", "720p"].includes(resolution)) {
    throw new Error(`--resolution 只能是 1080p | 720p，收到 "${resolution}"`);
  }
  if (!["30", "60"].includes(fps)) {
    throw new Error(`--fps 只能是 30 | 60，收到 "${fps}"`);
  }
  return {
    quality: quality as ExportQuality,
    resolution: resolution as ExportResolution,
    fps: Number(fps) as ExportFps,
  };
}

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function cmdRender(configPath: string, flags: Flags): Promise<void> {
  const options = parseExportOptions(flags);
  const outPath = path.resolve(
    typeof flags.out === "string" ? flags.out : path.join("output", `video-${timestamp()}.mp4`),
  );
  const coverPath = typeof flags.cover === "string" ? path.resolve(flags.cover) : undefined;

  log(`读取配置: ${configPath}`);
  const { config, files } = await loadCliConfig(configPath);
  const fileCount = Object.keys(files).length;
  if (fileCount > 0) log(`本地素材: ${fileCount} 个文件`);

  let lastShown = -1;
  const result = await renderVideo({
    root: ROOT,
    config,
    files,
    options,
    outPath,
    coverPath,
    rebuild: flags.rebuild === true,
    log,
    onProgress: (p) => {
      const pct = Math.floor(p * 100);
      if (pct >= lastShown + 5 || pct === 100) {
        lastShown = pct;
        log(`渲染进度 ${pct}%`);
      }
    },
  });

  const size = (await fs.stat(result.outputPath)).size;
  log(`完成 → ${result.outputPath}`);
  emit({
    ok: true,
    output: result.outputPath,
    cover: result.coverPath ?? null,
    durationSec: Math.round(result.durationSec * 100) / 100,
    sizeBytes: size,
    ...options,
  });
}

async function cmdValidate(configPath: string): Promise<void> {
  const { config, files } = await loadCliConfig(configPath);
  // A non-empty placeholder URL keeps file-backed uploads resolved to their
  // probed metadata during validation. No media is fetched in this command.
  const validationUrls = Object.fromEntries(
    Object.keys(files).map((id) => [id, `validation://${id}`]),
  );
  const resolved = resolveConfig(config, validationUrls);
  emit({
    ok: true,
    durationSec: Math.round(totalSec(resolved) * 100) / 100,
    openingSec: Math.round(openingSec(resolved) * 100) / 100,
    contentSec: Math.round(contentSec(resolved) * 100) / 100,
    endingSec: Math.round(endingSec(resolved) * 100) / 100,
    localFiles: Object.values(files).map((f) => f.file),
    canvas: config.canvas,
  });
}

async function cmdInit(outPath: string, flags: Flags): Promise<void> {
  const target = path.resolve(outPath);
  const exists = await fs.stat(target).then(() => true, () => false);
  if (exists && flags.force !== true) {
    throw new Error(`${target} 已存在（用 --force 覆盖）`);
  }
  await fs.writeFile(target, `${JSON.stringify(makeDefaultConfig(), null, 2)}\n`);
  log(`已生成默认配置 → ${target}`);
  emit({ ok: true, config: target });
}

function cmdAssets(): void {
  emit({
    ok: true,
    builtin: [
      { id: "airport", type: "image", usage: "content.background", desc: "机场值机口背景图" },
      { id: "mic", type: "image", usage: "content.mic.asset", desc: "手持麦克风" },
      { id: "phone", type: "image", usage: "content.device.asset", desc: "手持提词器手机" },
      { id: "open-sfx", type: "audio", usage: "opening.curtain.sfx", desc: "开场幕布音效" },
      { id: "airport-bgm", type: "audio", usage: "content.bgm.asset", desc: "机场广播背景音" },
      {
        id: "flowprompter-outro",
        type: "video",
        usage: "ending.video.asset",
        desc: "FlowPrompter 默认片尾",
      },
    ],
  });
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (cmd) {
    case "render": {
      if (!positional[0]) throw new Error("用法: render <配置.json> [选项]");
      await cmdRender(positional[0], flags);
      return;
    }
    case "validate": {
      if (!positional[0]) throw new Error("用法: validate <配置.json>");
      await cmdValidate(positional[0]);
      return;
    }
    case "init": {
      await cmdInit(positional[0] ?? "video-config.json", flags);
      return;
    }
    case "assets": {
      cmdAssets();
      return;
    }
    case undefined:
    case "help":
    case "--help":
    case "-h": {
      log(USAGE);
      return;
    }
    default:
      throw new Error(`未知命令 "${cmd}"，运行 help 查看用法`);
  }
}

main().catch((e: unknown) => {
  log(`错误: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
});
