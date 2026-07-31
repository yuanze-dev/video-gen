import { CLI_COMMAND_SPECS, CLI_GLOBAL_OPTION_NAMES } from "./args";

const OPTION_HELP: Readonly<Record<string, string>> = {
  fix: "--fix                 下载或修复缺失的浏览器（可能联网）",
  audio: "--audio               本地启动 ElevenLabs MCP 并检查工具列表（不生成、不扣费）",
  template: "--template <id>       选择模板（当前为 teleprompter）",
  minimal: "--minimal             仅写入常用改动字段",
  force: "--force               显式覆盖已有目标",
  out: "--out <路径>          指定单个输出文件",
  "out-dir": "--out-dir <目录>     指定多产物输出目录",
  cover: "--cover <路径>        同时输出首帧封面 JPG",
  quality: "--quality <档位>      high | standard | small",
  resolution: "--resolution <清晰度>  1080p | 720p",
  fps: "--fps <帧率>          30 | 60",
  rebuild: "--rebuild             忽略现有源码 bundle 缓存",
  scene: "--scene <场景>        opening | content | ending | all",
  progress: "--progress <0-1>      场景内取帧位置；content 默认避开入场透明帧",
  jobs: "--jobs <数量>         批量渲染并发数（1-32）",
  resume: "--resume              使用内容摘要安全断点续跑",
  target: "--target <目标>       codex | claude | both",
  scope: "--scope <范围>        project | user",
  prompt: "--prompt <描述>       音效或音乐描述（默认音效 1-450；music 1-4100 字符）",
  duration: "--duration <秒>      music: 3-600；sound-effect: 0.5-5（默认 5）",
  volume: "--volume <音量>       写入配置补丁的建议音量（0-1，默认 0.25）",
  provider: "--provider <服务>    elevenlabs（当前唯一 Provider）",
  "audio-kind": "--audio-kind <类型>  sound-effect | music（默认 sound-effect）",
  model: "--model <模型>        music_v2 | music_v1",
  manifest: "--manifest <路径>   指定生成旁路 manifest 路径",
  bgm: "--bgm <策略>           auto | off | required（默认 auto）",
  "bgm-prompt": "--bgm-prompt <方向>  补充音频方向；同时必须明确 --audio-kind",
  "replace-bgm": "--replace-bgm         明确替换已有 BGM；无缓存且缺 Key/离线时失败",
  "allow-custom-structure": "--allow-custom-structure  仅在用户明确要求时，允许自定义标准 3-2-1 幕帘或官方片尾",
  "prepared-config": "--prepared-config <路径>  持久化已接入 BGM 的配置",
  lock: "--lock <路径>          持久化可重现渲染锁",
};

const GROUPS = ["audio", "config", "templates", "assets", "cache", "skill"] as const;

function commandLines(): string[] {
  return CLI_COMMAND_SPECS.filter((spec) => spec.id !== "help").map(
    (spec) => `  ${spec.path.join(" ").padEnd(22)} ${spec.summary}`,
  );
}

function topHelp(): string {
  return [
    "Littlestart · 小音符起号助手本地视频 CLI",
    "",
    "用法:",
    "  littlestart <命令> [参数] [选项]",
    "  video-gen <命令> [参数] [选项]   # 兼容别名",
    "",
    "命令:",
    ...commandLines(),
    "",
    "全局选项:",
    ...CLI_GLOBAL_OPTION_NAMES.map((option) => `  ${option}`),
    "  -h, --help",
    "  -V, --version",
    "",
    "自动化:",
    "  --json                 stdout 输出单个稳定 JSON 信封",
    "  --events ndjson        stdout 输出实时 NDJSON 事件",
    "  人类诊断始终写入 stderr；两种机器模式不能同时使用。",
    "",
    "快速开始:",
    "  littlestart init video.json --minimal",
    "  littlestart validate video.json",
    "  littlestart still video.json --scene all --out-dir preview",
    "  littlestart produce video.json --out output/video.mp4",
    "",
    "运行 `littlestart help <命令>` 查看命令详情。",
  ].join("\n");
}

function groupHelp(group: string): string {
  const specs = CLI_COMMAND_SPECS.filter((spec) => spec.path[0] === group);
  return [
    `Littlestart ${group} 命令`,
    "",
    "子命令:",
    ...specs.map((spec) => `  ${spec.path.join(" ").padEnd(22)} ${spec.summary}`),
    "",
    `运行 \`littlestart help ${group} <子命令>\` 查看详情。`,
  ].join("\n");
}

export function renderCliHelp(target: readonly string[] = []): string {
  if (target.length === 0 || target[0] === "help") return topHelp();
  if (target.length === 1 && (GROUPS as readonly string[]).includes(target[0])) {
    return groupHelp(target[0]);
  }
  const spec = CLI_COMMAND_SPECS.find(
    (candidate) => candidate.path.join("\0") === target.join("\0"),
  );
  if (!spec) return topHelp();
  return [
    spec.summary,
    "",
    "用法:",
    `  ${spec.usage}`,
    ...(spec.options.length > 0
      ? ["", "选项:", ...spec.options.map((name) => `  ${OPTION_HELP[name] ?? `--${name}`}`)]
      : []),
    "",
    "全局机器选项可放在命令前后：--json、--events ndjson、--quiet、--cache-dir、--offline。",
  ].join("\n");
}
