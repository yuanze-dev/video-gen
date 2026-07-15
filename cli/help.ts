import { CLI_COMMAND_SPECS, CLI_GLOBAL_OPTION_NAMES } from "./args";

const OPTION_HELP: Readonly<Record<string, string>> = {
  fix: "--fix                 下载或修复缺失的浏览器（可能联网）",
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
  jobs: "--jobs <数量>         批量渲染并发数（1-32）",
  resume: "--resume              使用内容摘要安全断点续跑",
  target: "--target <目标>       codex | claude | both",
  scope: "--scope <范围>        project | user",
};

const GROUPS = ["config", "templates", "assets", "cache", "skill"] as const;

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
    "  littlestart render video.json --out output/video.mp4",
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
