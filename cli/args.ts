import { CliError, type CliOutputMode } from "./protocol";

export type CliCommandId =
  | "version"
  | "doctor"
  | "capabilities"
  | "init"
  | "validate"
  | "plan"
  | "produce"
  | "render"
  | "still"
  | "probe"
  | "audio.plan"
  | "audio.generate"
  | "config.schema"
  | "config.resolve"
  | "config.lock"
  | "config.migrate"
  | "templates.list"
  | "templates.show"
  | "assets.list"
  | "assets.inspect"
  | "cache.list"
  | "cache.prune"
  | "cache.clear"
  | "skill.install"
  | "batch"
  | "help";

export type CliTopLevelCommand =
  | "version"
  | "doctor"
  | "capabilities"
  | "init"
  | "validate"
  | "plan"
  | "produce"
  | "render"
  | "still"
  | "probe"
  | "audio"
  | "config"
  | "templates"
  | "assets"
  | "cache"
  | "skill"
  | "batch"
  | "help";

export interface GlobalCliOptions {
  readonly outputMode: CliOutputMode;
  readonly json: boolean;
  readonly events?: "ndjson";
  readonly quiet: boolean;
  readonly color: boolean;
  readonly cacheDir?: string;
  readonly offline: boolean;
}

export interface CliCommandOptions {
  readonly fix?: true;
  readonly audio?: true;
  readonly template?: string;
  readonly minimal?: true;
  readonly force?: true;
  readonly out?: string;
  readonly outDir?: string;
  readonly cover?: string;
  readonly quality?: "high" | "standard" | "small";
  readonly resolution?: "1080p" | "720p";
  readonly fps?: 30 | 60;
  readonly rebuild?: true;
  readonly scene?: "opening" | "content" | "ending" | "all";
  /** Scene-relative still position, where 0 is the first frame and 1 is the last. */
  readonly progress?: number;
  readonly jobs?: number;
  readonly resume?: true;
  readonly target?: "codex" | "claude" | "both";
  readonly scope?: "project" | "user";
  readonly prompt?: string;
  readonly duration?: number;
  readonly volume?: number;
  readonly provider?: "elevenlabs";
  readonly audioKind?: "music" | "sound-effect";
  readonly model?: "music_v2" | "music_v1";
  readonly manifest?: string;
  readonly bgm?: "auto" | "off" | "required";
  readonly bgmPrompt?: string;
  readonly replaceBgm?: true;
  readonly allowCustomStructure?: true;
  readonly preparedConfig?: string;
  readonly lock?: string;
}

export interface ParsedCliInvocation {
  /** Canonical command identifier, including a group subcommand when present. */
  readonly id: CliCommandId;
  readonly command: CliTopLevelCommand;
  readonly subcommand?: string;
  /** Canonical path, e.g. `["assets", "list"]`. */
  readonly commandPath: readonly string[];
  /** Validated command operands, without command/subcommand tokens. */
  readonly positionals: readonly string[];
  readonly options: Readonly<CliCommandOptions>;
  readonly global: GlobalCliOptions;
  /** Set only for the help command. Empty means top-level help. */
  readonly helpTarget?: readonly string[];
}

export interface CliCommandSpec {
  readonly id: CliCommandId;
  readonly path: readonly string[];
  readonly usage: string;
  readonly summary: string;
  readonly minPositionals: number;
  readonly maxPositionals: number;
  readonly options: readonly string[];
  readonly requiredOptions?: readonly string[];
}

/** Shared by argument validation and the future generated help output. */
export const CLI_COMMAND_SPECS: readonly CliCommandSpec[] = Object.freeze([
  {
    id: "version",
    path: ["version"],
    usage: "littlestart version",
    summary: "显示 CLI 与协议版本",
    minPositionals: 0,
    maxPositionals: 0,
    options: [],
  },
  {
    id: "doctor",
    path: ["doctor"],
    usage: "littlestart doctor [--fix] [--audio]",
    summary: "检查本机渲染环境，可选探测音频 MCP runtime",
    minPositionals: 0,
    maxPositionals: 0,
    options: ["fix", "audio"],
  },
  {
    id: "capabilities",
    path: ["capabilities"],
    usage: "littlestart capabilities",
    summary: "输出可用模板、格式和运行能力",
    minPositionals: 0,
    maxPositionals: 0,
    options: [],
  },
  {
    id: "init",
    path: ["init"],
    usage: "littlestart init [配置.json] [--template <id>] [--minimal] [--force]",
    summary: "创建一份视频配置",
    minPositionals: 0,
    maxPositionals: 1,
    options: ["template", "minimal", "force"],
  },
  {
    id: "validate",
    path: ["validate"],
    usage: "littlestart validate <配置.json|-> [--quality <档位>] [--resolution <清晰度>] [--fps <帧率>]",
    summary: "严格校验配置与素材",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["quality", "resolution", "fps"],
  },
  {
    id: "plan",
    path: ["plan"],
    usage: "littlestart plan <配置.json|-> [--quality <档位>] [--resolution <清晰度>] [--fps <帧率>]",
    summary: "计算渲染计划但不生成视频",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["quality", "resolution", "fps"],
  },
  {
    id: "produce",
    path: ["produce"],
    usage: "littlestart produce <配置.json> [--bgm auto|off|required] [--audio-kind sound-effect|music] [渲染选项]",
    summary: "自动准备背景音频、配置和锁文件，并一键渲染视频",
    minPositionals: 1,
    maxPositionals: 1,
    options: [
      "bgm",
      "bgm-prompt",
      "replace-bgm",
      "allow-custom-structure",
      "duration",
      "volume",
      "audio-kind",
      "model",
      "prepared-config",
      "lock",
      "out",
      "cover",
      "quality",
      "resolution",
      "fps",
      "rebuild",
      "force",
    ],
  },
  {
    id: "render",
    path: ["render"],
    usage: "littlestart render <配置.json|-> [渲染选项]",
    summary: "渲染视频",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["out", "cover", "quality", "resolution", "fps", "rebuild", "force"],
  },
  {
    id: "still",
    path: ["still"],
    usage: "littlestart still <配置.json|-> [--scene <场景>] [--progress <0-1>] [--out <图片> | --out-dir <目录>]",
    summary: "导出用于视觉检查的静帧",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["scene", "progress", "out", "out-dir", "quality", "resolution", "force"],
  },
  {
    id: "probe",
    path: ["probe"],
    usage: "littlestart probe <媒体文件>",
    summary: "检查媒体文件的元数据与可读性",
    minPositionals: 1,
    maxPositionals: 1,
    options: [],
  },
  {
    id: "audio.plan",
    path: ["audio", "plan"],
    usage: "littlestart audio plan <配置.json|-> --prompt <描述> [音频选项]",
    summary: "规划 ElevenLabs 音乐或音效生成，但不联网、不扣费",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["prompt", "duration", "volume", "provider", "audio-kind", "model", "out", "manifest"],
    requiredOptions: ["prompt"],
  },
  {
    id: "audio.generate",
    path: ["audio", "generate"],
    usage: "littlestart audio generate <配置.json|-> --prompt <描述> [--out <音频.mp3>] [音频选项]",
    summary: "通过官方 ElevenLabs MCP 生成本地音乐或音效",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["prompt", "duration", "volume", "provider", "audio-kind", "model", "out", "manifest", "force"],
    requiredOptions: ["prompt"],
  },
  {
    id: "config.schema",
    path: ["config", "schema"],
    usage: "littlestart config schema [--template <id>] [--out <文件>]",
    summary: "输出配置 JSON Schema",
    minPositionals: 0,
    maxPositionals: 0,
    options: ["template", "out", "force"],
  },
  {
    id: "config.resolve",
    path: ["config", "resolve"],
    usage: "littlestart config resolve <配置.json|-> [--out <文件>]",
    summary: "展开默认值并输出完整配置",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["out", "force"],
  },
  {
    id: "config.lock",
    path: ["config", "lock"],
    usage: "littlestart config lock <配置.json|-> [--quality <档位>] [--resolution <清晰度>] [--fps <帧率>] [--out <文件>]",
    summary: "生成可重现渲染锁文件",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["quality", "resolution", "fps", "out", "force"],
  },
  {
    id: "config.migrate",
    path: ["config", "migrate"],
    usage: "littlestart config migrate <配置.json|-> [--out <文件>]",
    summary: "规范化 v1 配置并报告迁移状态",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["out", "force"],
  },
  {
    id: "templates.list",
    path: ["templates", "list"],
    usage: "littlestart templates [list]",
    summary: "列出可用模板",
    minPositionals: 0,
    maxPositionals: 0,
    options: [],
  },
  {
    id: "templates.show",
    path: ["templates", "show"],
    usage: "littlestart templates show <模板>",
    summary: "查看模板详情",
    minPositionals: 1,
    maxPositionals: 1,
    options: [],
  },
  {
    id: "assets.list",
    path: ["assets", "list"],
    usage: "littlestart assets [list]",
    summary: "列出内置素材",
    minPositionals: 0,
    maxPositionals: 0,
    options: [],
  },
  {
    id: "assets.inspect",
    path: ["assets", "inspect"],
    usage: "littlestart assets inspect <素材>",
    summary: "检查一个内置或本地素材",
    minPositionals: 1,
    maxPositionals: 1,
    options: [],
  },
  {
    id: "cache.list",
    path: ["cache", "list"],
    usage: "littlestart cache [list]",
    summary: "列出本地缓存",
    minPositionals: 0,
    maxPositionals: 0,
    options: [],
  },
  {
    id: "cache.prune",
    path: ["cache", "prune"],
    usage: "littlestart cache prune",
    summary: "清理不再使用的缓存",
    minPositionals: 0,
    maxPositionals: 0,
    options: [],
  },
  {
    id: "cache.clear",
    path: ["cache", "clear"],
    usage: "littlestart cache clear [--force]",
    summary: "清空本地缓存",
    minPositionals: 0,
    maxPositionals: 0,
    options: ["force"],
  },
  {
    id: "skill.install",
    path: ["skill", "install"],
    usage: "littlestart skill install [--target codex|claude|both] [--scope project|user] [--force]",
    summary: "安装 Codex / Claude Code 视频生成 Skill",
    minPositionals: 0,
    maxPositionals: 0,
    options: ["target", "scope", "force"],
  },
  {
    id: "batch",
    path: ["batch"],
    usage: "littlestart batch <批次.json|-> --out-dir <目录> [--jobs <数量>] [--resume]",
    summary: "预检并批量渲染视频",
    minPositionals: 1,
    maxPositionals: 1,
    options: ["out-dir", "jobs", "resume", "force"],
    requiredOptions: ["out-dir"],
  },
  {
    id: "help",
    path: ["help"],
    usage: "littlestart help [命令 [子命令]]",
    summary: "显示帮助",
    minPositionals: 0,
    maxPositionals: 2,
    options: [],
  },
]);

type OptionKind = "boolean" | "string" | "enum" | "positiveInteger" | "number";

interface OptionDefinition {
  readonly property: string;
  readonly kind: OptionKind;
  readonly values?: readonly string[];
  readonly global?: boolean;
  readonly min?: number;
  readonly max?: number;
}

const OPTION_DEFINITIONS: Readonly<Record<string, OptionDefinition>> = Object.freeze({
  json: { property: "json", kind: "boolean", global: true },
  events: { property: "events", kind: "enum", values: ["ndjson"], global: true },
  quiet: { property: "quiet", kind: "boolean", global: true },
  "no-color": { property: "noColor", kind: "boolean", global: true },
  "cache-dir": { property: "cacheDir", kind: "string", global: true },
  offline: { property: "offline", kind: "boolean", global: true },
  help: { property: "help", kind: "boolean", global: true },
  version: { property: "version", kind: "boolean", global: true },

  fix: { property: "fix", kind: "boolean" },
  audio: { property: "audio", kind: "boolean" },
  template: { property: "template", kind: "string" },
  minimal: { property: "minimal", kind: "boolean" },
  force: { property: "force", kind: "boolean" },
  out: { property: "out", kind: "string" },
  "out-dir": { property: "outDir", kind: "string" },
  cover: { property: "cover", kind: "string" },
  quality: {
    property: "quality",
    kind: "enum",
    values: ["high", "standard", "small"],
  },
  resolution: { property: "resolution", kind: "enum", values: ["1080p", "720p"] },
  fps: { property: "fps", kind: "enum", values: ["30", "60"] },
  rebuild: { property: "rebuild", kind: "boolean" },
  scene: {
    property: "scene",
    kind: "enum",
    values: ["opening", "content", "ending", "all"],
  },
  progress: { property: "progress", kind: "number", min: 0, max: 1 },
  jobs: { property: "jobs", kind: "positiveInteger", min: 1, max: 32 },
  resume: { property: "resume", kind: "boolean" },
  target: {
    property: "target",
    kind: "enum",
    values: ["codex", "claude", "both"],
  },
  scope: {
    property: "scope",
    kind: "enum",
    values: ["project", "user"],
  },
  prompt: { property: "prompt", kind: "string" },
  duration: { property: "duration", kind: "number", min: 0.5, max: 600 },
  volume: { property: "volume", kind: "number", min: 0, max: 1 },
  provider: {
    property: "provider",
    kind: "enum",
    values: ["elevenlabs"],
  },
  "audio-kind": {
    property: "audioKind",
    kind: "enum",
    values: ["music", "sound-effect"],
  },
  model: {
    property: "model",
    kind: "enum",
    values: ["music_v2", "music_v1"],
  },
  bgm: {
    property: "bgm",
    kind: "enum",
    values: ["auto", "off", "required"],
  },
  "bgm-prompt": { property: "bgmPrompt", kind: "string" },
  "replace-bgm": { property: "replaceBgm", kind: "boolean" },
  "allow-custom-structure": { property: "allowCustomStructure", kind: "boolean" },
  "prepared-config": { property: "preparedConfig", kind: "string" },
  lock: { property: "lock", kind: "string" },
  manifest: { property: "manifest", kind: "string" },
});

export const CLI_GLOBAL_OPTION_NAMES = Object.freeze([
  "--json",
  "--events ndjson",
  "--quiet",
  "--no-color",
  "--cache-dir <目录>",
  "--offline",
] as const);

interface PositionedValue {
  readonly value: string;
  readonly index: number;
}

interface ParsedRawOption {
  readonly name: string;
  readonly value: string | number | true;
  readonly index: number;
}

interface TokenizedArguments {
  readonly positionals: readonly PositionedValue[];
  readonly options: ReadonlyMap<string, ParsedRawOption>;
}

const SHORT_OPTIONS: Readonly<Record<string, string>> = Object.freeze({
  "-h": "help",
  "-V": "version",
});

function editDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= right.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (left[i - 1] === right[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

function closest(value: string, candidates: readonly string[]): string | undefined {
  let match: string | undefined;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    const next = editDistance(value, candidate);
    if (next < distance) {
      match = candidate;
      distance = next;
    }
  }
  const threshold = Math.max(2, Math.floor(value.length / 3));
  return distance <= threshold ? match : undefined;
}

function optionError(
  code:
    | "UNKNOWN_OPTION"
    | "OPTION_VALUE_REQUIRED"
    | "INVALID_OPTION_VALUE"
    | "DUPLICATE_OPTION",
  message: string,
  index: number,
  options: { readonly hint?: string; readonly value?: unknown } = {},
): CliError {
  return new CliError(code, message, {
    issues: [{ path: `argv[${index}]`, message, value: options.value }],
    hint: options.hint,
  });
}

function parseOptionValue(
  name: string,
  definition: OptionDefinition,
  rawValue: string,
  index: number,
): string | number {
  if (rawValue === "") {
    throw optionError("INVALID_OPTION_VALUE", `选项 --${name} 的值不能为空`, index);
  }
  if (definition.kind === "string") return rawValue;

  if (definition.kind === "enum") {
    if (!definition.values?.includes(rawValue)) {
      throw optionError(
        "INVALID_OPTION_VALUE",
        `--${name} 只能是 ${definition.values?.join(" | ")}，收到 "${rawValue}"`,
        index,
        { value: rawValue },
      );
    }
    if (name === "fps") return Number(rawValue);
    return rawValue;
  }

  if (definition.kind === "number") {
    const parsed = Number(rawValue);
    if (
      !Number.isFinite(parsed) ||
      parsed < (definition.min ?? -Number.MAX_VALUE) ||
      parsed > (definition.max ?? Number.MAX_VALUE)
    ) {
      throw optionError(
        "INVALID_OPTION_VALUE",
        `--${name} 必须在 ${definition.min ?? "-∞"} 到 ${definition.max ?? "∞"} 之间`,
        index,
        { value: rawValue },
      );
    }
    return parsed;
  }

  if (!/^\d+$/.test(rawValue)) {
    throw optionError(
      "INVALID_OPTION_VALUE",
      `--${name} 需要一个正整数，收到 "${rawValue}"`,
      index,
      { value: rawValue },
    );
  }
  const parsed = Number(rawValue);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < (definition.min ?? 1) ||
    parsed > (definition.max ?? Number.MAX_SAFE_INTEGER)
  ) {
    throw optionError(
      "INVALID_OPTION_VALUE",
      `--${name} 必须在 ${definition.min ?? 1} 到 ${definition.max ?? Number.MAX_SAFE_INTEGER} 之间`,
      index,
      { value: rawValue },
    );
  }
  return parsed;
}

function tokenize(argv: readonly string[]): TokenizedArguments {
  const positionals: PositionedValue[] = [];
  const parsedOptions = new Map<string, ParsedRawOption>();
  let endOfOptions = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const optionIndex = index;
    if (endOfOptions) {
      positionals.push({ value: token, index });
      continue;
    }
    if (token === "--") {
      endOfOptions = true;
      continue;
    }
    if (token === "-" || !token.startsWith("-")) {
      positionals.push({ value: token, index });
      continue;
    }

    let name: string;
    let attachedValue: string | undefined;
    if (token.startsWith("--")) {
      const separator = token.indexOf("=");
      name = token.slice(2, separator === -1 ? undefined : separator);
      attachedValue = separator === -1 ? undefined : token.slice(separator + 1);
    } else {
      const expanded = SHORT_OPTIONS[token];
      if (!expanded) {
        throw optionError("UNKNOWN_OPTION", `未知选项 "${token}"`, index, {
          hint: "当前只支持短选项 -h 和 -V；其他选项请使用完整的 --long-name。",
        });
      }
      name = expanded;
    }

    const definition = OPTION_DEFINITIONS[name];
    if (!definition) {
      const suggestion = closest(name, Object.keys(OPTION_DEFINITIONS));
      throw optionError("UNKNOWN_OPTION", `未知选项 "--${name}"`, index, {
        hint: suggestion ? `你是不是想输入 --${suggestion}？` : "运行 littlestart help 查看可用选项。",
      });
    }
    if (parsedOptions.has(name)) {
      throw optionError("DUPLICATE_OPTION", `选项 --${name} 只能出现一次`, index);
    }

    if (definition.kind === "boolean") {
      if (attachedValue !== undefined) {
        throw optionError(
          "INVALID_OPTION_VALUE",
          `布尔选项 --${name} 不接受值`,
          index,
          { hint: `直接使用 --${name} 即可。`, value: attachedValue },
        );
      }
      parsedOptions.set(name, { name, value: true, index });
      continue;
    }

    let rawValue = attachedValue;
    if (rawValue === undefined) {
      const next = argv[index + 1];
      const nextLooksLikeOption =
        next === undefined ||
        next === "--" ||
        (next.startsWith("-") &&
          next !== "-" &&
          !(
            (definition.kind === "positiveInteger" || definition.kind === "number") &&
            /^-\d/.test(next)
          ));
      if (nextLooksLikeOption) {
        throw optionError(
          "OPTION_VALUE_REQUIRED",
          `选项 --${name} 需要一个值`,
          index,
          { hint: `使用 --${name}=<值>，或把值写在选项后面。` },
        );
      }
      rawValue = next;
      index += 1;
    }

    parsedOptions.set(name, {
      name,
      value: parseOptionValue(name, definition, rawValue, optionIndex),
      index: optionIndex,
    });
  }

  return { positionals, options: parsedOptions };
}

const SPECS_BY_ID = new Map(CLI_COMMAND_SPECS.map((spec) => [spec.id, spec]));
const TOP_LEVEL_COMMANDS = Object.freeze([
  "version",
  "doctor",
  "capabilities",
  "init",
  "validate",
  "plan",
  "produce",
  "render",
  "still",
  "probe",
  "audio",
  "config",
  "templates",
  "assets",
  "cache",
  "skill",
  "batch",
  "help",
] as const);

const GROUPS: Readonly<
  Record<
    "audio" | "config" | "templates" | "assets" | "cache" | "skill",
    { readonly subcommands: readonly string[]; readonly defaultId?: CliCommandId }
  >
> = Object.freeze({
  audio: { subcommands: ["plan", "generate"] },
  config: { subcommands: ["schema", "resolve", "lock", "migrate"] },
  templates: { subcommands: ["list", "show"], defaultId: "templates.list" },
  assets: { subcommands: ["list", "inspect"], defaultId: "assets.list" },
  cache: { subcommands: ["list", "prune", "clear"], defaultId: "cache.list" },
  skill: { subcommands: ["install"] },
});

interface ResolvedCommand {
  readonly spec: CliCommandSpec;
  readonly consumed: number;
}

function specById(id: CliCommandId): CliCommandSpec {
  const spec = SPECS_BY_ID.get(id);
  if (!spec) throw new Error(`Missing CLI command spec for ${id}`);
  return spec;
}

function unknownCommand(value: PositionedValue, candidates: readonly string[]): CliError {
  const suggestion = closest(value.value, candidates);
  return new CliError("UNKNOWN_COMMAND", `未知命令 "${value.value}"`, {
    issues: [{ path: `argv[${value.index}]`, message: `无法识别 "${value.value}"` }],
    hint: suggestion ? `你是不是想输入 ${suggestion}？` : "运行 littlestart help 查看可用命令。",
  });
}

function resolveCommand(positionals: readonly PositionedValue[]): ResolvedCommand {
  const first = positionals[0];
  if (!first) return { spec: specById("help"), consumed: 0 };
  if (!(TOP_LEVEL_COMMANDS as readonly string[]).includes(first.value)) {
    throw unknownCommand(first, TOP_LEVEL_COMMANDS);
  }

  if (first.value in GROUPS) {
    const groupName = first.value as keyof typeof GROUPS;
    const group = GROUPS[groupName];
    const second = positionals[1];
    if (!second) {
      if (group.defaultId) return { spec: specById(group.defaultId), consumed: 1 };
      throw new CliError("MISSING_ARGUMENT", `命令 ${groupName} 需要一个子命令`, {
        issues: [{ path: "arguments.subcommand", message: `可选：${group.subcommands.join(" | ")}` }],
        hint: `运行 littlestart help ${groupName} 查看详情。`,
      });
    }
    if (!group.subcommands.includes(second.value)) {
      throw unknownCommand(second, group.subcommands);
    }
    return {
      spec: specById(`${groupName}.${second.value}` as CliCommandId),
      consumed: 2,
    };
  }

  return { spec: specById(first.value as CliCommandId), consumed: 1 };
}

function validateArity(
  spec: CliCommandSpec,
  operands: readonly PositionedValue[],
  options: { readonly requireMinimum?: boolean } = {},
): void {
  if ((options.requireMinimum ?? true) && operands.length < spec.minPositionals) {
    throw new CliError("MISSING_ARGUMENT", `缺少必需参数。用法: ${spec.usage}`, {
      issues: [{ path: "arguments", message: `至少需要 ${spec.minPositionals} 个参数` }],
      hint: `运行 littlestart help ${spec.path.join(" ")} 查看详情。`,
    });
  }
  if (operands.length > spec.maxPositionals) {
    const extra = operands.slice(spec.maxPositionals);
    throw new CliError("TOO_MANY_ARGUMENTS", `参数过多。用法: ${spec.usage}`, {
      issues: extra.map((item) => ({
        path: `argv[${item.index}]`,
        message: `多余参数 "${item.value}"`,
        value: item.value,
      })),
    });
  }
}

function validateOptions(
  spec: CliCommandSpec,
  options: ReadonlyMap<string, ParsedRawOption>,
  validation: { readonly requireRequired?: boolean } = {},
): void {
  const allowed = new Set(spec.options);
  for (const option of options.values()) {
    const definition = OPTION_DEFINITIONS[option.name];
    if (definition.global) continue;
    if (!allowed.has(option.name)) {
      throw new CliError(
        "OPTION_NOT_ALLOWED",
        `命令 ${spec.path.join(" ")} 不支持选项 --${option.name}`,
        {
          issues: [{ path: `argv[${option.index}]`, message: `此命令不能使用 --${option.name}` }],
          hint: `用法: ${spec.usage}`,
        },
      );
    }
  }
  for (const required of validation.requireRequired === false ? [] : spec.requiredOptions ?? []) {
    if (!options.has(required)) {
      throw new CliError("MISSING_ARGUMENT", `命令 ${spec.path.join(" ")} 缺少 --${required}`, {
        issues: [{ path: `options.${OPTION_DEFINITIONS[required].property}`, message: `必须提供 --${required}` }],
        hint: `用法: ${spec.usage}`,
      });
    }
  }
}

function helpTargetFrom(
  positionals: readonly PositionedValue[],
  fromHelpCommand: boolean,
): { readonly target?: readonly string[]; readonly targetSpec?: CliCommandSpec } {
  const values = fromHelpCommand ? positionals.slice(1) : positionals;
  if (values.length === 0) return {};

  const first = values[0];
  if (!(TOP_LEVEL_COMMANDS as readonly string[]).includes(first.value)) {
    throw unknownCommand(first, TOP_LEVEL_COMMANDS);
  }
  if (first.value === "help") return { target: ["help"], targetSpec: specById("help") };

  if (first.value in GROUPS) {
    const groupName = first.value as keyof typeof GROUPS;
    const group = GROUPS[groupName];
    const second = values[1];
    if (!second) return { target: [groupName] };
    if (!group.subcommands.includes(second.value)) {
      throw unknownCommand(second, group.subcommands);
    }
    const targetSpec = specById(`${groupName}.${second.value}` as CliCommandId);
    const trailing = values.slice(2);
    if (fromHelpCommand) {
      if (trailing.length > 0) {
        throw new CliError("TOO_MANY_ARGUMENTS", "help 的命令目标最多包含一个子命令", {
          issues: trailing.map((item) => ({
            path: `argv[${item.index}]`,
            message: `多余参数 "${item.value}"`,
          })),
        });
      }
    } else {
      validateArity(targetSpec, trailing, { requireMinimum: false });
    }
    return { target: targetSpec.path, targetSpec };
  }

  if (values.length > 1) {
    if (fromHelpCommand) {
      const extra = values.slice(1);
      throw new CliError("TOO_MANY_ARGUMENTS", `help ${first.value} 后不能再跟其他命令`, {
        issues: extra.map((item) => ({
          path: `argv[${item.index}]`,
          message: `多余参数 "${item.value}"`,
        })),
      });
    }
  }
  const targetSpec = specById(first.value as CliCommandId);
  if (!fromHelpCommand) {
    validateArity(targetSpec, values.slice(1), { requireMinimum: false });
  }
  return { target: targetSpec.path, targetSpec };
}

function hasOwn(object: object, property: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(object, property);
}

export interface ParseCliArgsOptions {
  /** Used only for the NO_COLOR convention. Pass `{}` for deterministic tests. */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface CliBootstrapOptions {
  readonly outputMode: CliOutputMode;
  readonly quiet: boolean;
  readonly color: boolean;
}

/**
 * Tolerantly detect only the settings needed to report an argument-parser
 * failure. Call this before parseCliArgs so even `--json --unknown` can return
 * a machine-readable failure envelope. Full validation still belongs to
 * parseCliArgs; this helper never accepts or rejects an invocation.
 */
export function detectCliBootstrapOptions(
  argv: readonly string[],
  parseOptions: ParseCliArgsOptions = {},
): CliBootstrapOptions {
  let json = false;
  let ndjson = false;
  let quiet = false;
  let noColor = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") break;
    if (token === "--json") json = true;
    if (token === "--events=ndjson") ndjson = true;
    if (token === "--events" && argv[index + 1] === "ndjson") ndjson = true;
    if (token === "--quiet") quiet = true;
    if (token === "--no-color") noColor = true;
  }

  const env = parseOptions.env ?? process.env;
  // When mutually exclusive modes are both present, prefer one JSON document
  // for the OPTION_CONFLICT response. parseCliArgs will still reject the call.
  const outputMode: CliOutputMode = json ? "json" : ndjson ? "ndjson" : "human";
  return Object.freeze({
    outputMode,
    quiet,
    color: !noColor && !hasOwn(env, "NO_COLOR"),
  });
}

/**
 * Parse and fully validate process.argv.slice(2).
 *
 * Global options may appear before or after the command. Unknown options,
 * duplicate options, options belonging to another command, missing operands,
 * and extra operands all fail before any command side effect can run.
 */
export function parseCliArgs(
  argv: readonly string[],
  parseOptions: ParseCliArgsOptions = {},
): ParsedCliInvocation {
  const tokenized = tokenize(argv);
  const helpRequested = tokenized.options.has("help");
  const versionRequested = tokenized.options.has("version");

  if (helpRequested && versionRequested) {
    throw new CliError("OPTION_CONFLICT", "--help 与 --version 不能同时使用", {
      issues: [
        { path: "options.help", message: "与 --version 冲突" },
        { path: "options.version", message: "与 --help 冲突" },
      ],
    });
  }
  if (versionRequested && tokenized.positionals.length > 0) {
    throw new CliError("OPTION_CONFLICT", "--version 不能与命令同时使用", {
      hint: "请单独运行 littlestart --version。",
    });
  }

  const json = tokenized.options.has("json");
  const events = tokenized.options.get("events")?.value;
  if (json && events !== undefined) {
    throw new CliError("OPTION_CONFLICT", "--json 与 --events ndjson 不能同时使用", {
      issues: [
        { path: "options.json", message: "单文档 JSON 模式" },
        { path: "options.events", message: "流式 NDJSON 模式" },
      ],
      hint: "需要最终单个结果时用 --json；需要实时事件时用 --events ndjson。",
    });
  }

  const bootstrap = detectCliBootstrapOptions(argv, parseOptions);
  const outputMode: CliOutputMode = events === "ndjson" ? "ndjson" : json ? "json" : "human";
  const global: GlobalCliOptions = Object.freeze({
    outputMode,
    json,
    ...(events === "ndjson" ? { events: "ndjson" as const } : {}),
    quiet: tokenized.options.has("quiet"),
    color: bootstrap.color,
    ...(tokenized.options.has("cache-dir")
      ? { cacheDir: tokenized.options.get("cache-dir")?.value as string }
      : {}),
    offline: tokenized.options.has("offline"),
  });

  let spec: CliCommandSpec;
  let operands: readonly PositionedValue[];
  let helpTarget: readonly string[] | undefined;

  if (versionRequested) {
    spec = specById("version");
    operands = [];
    validateOptions(spec, tokenized.options);
  } else if (helpRequested || tokenized.positionals[0]?.value === "help") {
    const fromHelpCommand = tokenized.positionals[0]?.value === "help";
    const target = helpTargetFrom(tokenized.positionals, fromHelpCommand);
    spec = specById("help");
    operands = [];
    helpTarget = target.target;
    validateOptions(target.targetSpec ?? spec, tokenized.options, { requireRequired: false });
  } else {
    const resolved = resolveCommand(tokenized.positionals);
    spec = resolved.spec;
    operands = tokenized.positionals.slice(resolved.consumed);
    validateArity(spec, operands);
    validateOptions(spec, tokenized.options);
  }

  // Help and version are control flags, not options passed to handlers.
  const commandOptions: Record<string, string | number | true> = {};
  for (const option of tokenized.options.values()) {
    const definition = OPTION_DEFINITIONS[option.name];
    if (definition.global) continue;
    commandOptions[definition.property] = option.value;
  }

  if (["produce", "audio.plan", "audio.generate"].includes(spec.id)) {
    if (
      spec.id === "produce" &&
      commandOptions.bgmPrompt !== undefined &&
      commandOptions.audioKind === undefined
    ) {
      throw new CliError(
        "OPTION_CONFLICT",
        "--bgm-prompt 必须同时明确 --audio-kind，CLI 不会猜测你要音乐还是环境音效",
        {
          issues: [
            {
              path: "options.audioKind",
              message: "使用 --audio-kind music 或 --audio-kind sound-effect",
            },
          ],
          hint: "舞台配乐使用 --audio-kind music；房间声、风声等环境音使用 --audio-kind sound-effect。",
        },
      );
    }
    const audioKind = commandOptions.audioKind ?? "sound-effect";
    if (audioKind === "sound-effect" && commandOptions.model !== undefined) {
      throw new CliError("OPTION_CONFLICT", "--audio-kind sound-effect 不能与 --model 同时使用", {
        issues: [
          { path: "options.audioKind", message: "sound-effect" },
          { path: "options.model", message: String(commandOptions.model) },
        ],
        hint: "--model 只用于 music；音效固定调用 text_to_sound_effects。",
      });
    }
    const duration = commandOptions.duration;
    if (typeof duration === "number") {
      const minimum = audioKind === "sound-effect" ? 0.5 : 3;
      const maximum = audioKind === "sound-effect" ? 5 : 600;
      if (duration < minimum || duration > maximum) {
        const parsed = tokenized.options.get("duration");
        throw optionError(
          "INVALID_OPTION_VALUE",
          `--duration 在 ${audioKind} 模式下必须在 ${minimum} 到 ${maximum} 之间`,
          parsed?.index ?? 0,
          { value: duration },
        );
      }
    }
  }

  const path = Object.freeze([...spec.path]);
  const values = Object.freeze(operands.map((operand) => operand.value));
  return Object.freeze({
    id: spec.id,
    command: path[0] as CliTopLevelCommand,
    ...(path[1] ? { subcommand: path[1] } : {}),
    commandPath: path,
    positionals: values,
    options: Object.freeze(commandOptions) as Readonly<CliCommandOptions>,
    global,
    ...(helpTarget ? { helpTarget: Object.freeze([...helpTarget]) } : {}),
  });
}

export function formatCliCommand(invocation: ParsedCliInvocation): string {
  return invocation.commandPath.join(" ");
}
