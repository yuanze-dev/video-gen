import fs from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_ENDING_ASSET_ID,
  type ProjectConfig,
} from "../lib/config-schema";
import type { ExportOptions } from "../lib/export-options";
import {
  createAudioGenerationPlan,
  createNarrationBgmPrompt,
  createNarrationSoundEffectPrompt,
  DEFAULT_AUDIO_KIND,
  generatePlannedAudio,
  type AudioGenerationKind,
  type AudioGenerationResult,
  type ElevenLabsMusicModel,
} from "./audio";
import { deepMerge } from "./config";
import type { ElevenLabsMcpCall, ElevenLabsMcpRuntime } from "./elevenlabs-mcp";
import {
  configForFileOutput,
  createProjectLock,
  createRenderPlan,
  loadProjectInput,
  writeJsonAtomic,
  type LoadedProjectInput,
  type ProjectLock,
} from "./project";
import { CliError, isCliError, type CliIssue } from "./protocol";
import type { CliRuntime } from "./runtime";

export type BgmProductionMode = "auto" | "off" | "required";

export type ProductionAudioStatus =
  | "generated"
  | "reused"
  | "preserved"
  | "disabled"
  | "skipped";

export type PreparedVideoProduction = {
  preparedInput: LoadedProjectInput;
  preparedConfig: string;
  lockPath: string;
  lock: ProjectLock;
  audio: {
    kind: AudioGenerationKind;
    mode: BgmProductionMode;
    status: ProductionAudioStatus;
    reason: string;
    prompt: string | null;
    output: string | null;
    manifest: string | null;
    requestKey: string | null;
    reused: boolean;
  };
};

export type PrepareVideoProductionOptions = {
  input: LoadedProjectInput;
  runtime: CliRuntime;
  exportOptions: ExportOptions;
  mode?: BgmProductionMode;
  prompt?: string;
  replaceBgm?: boolean;
  allowCustomStructure?: boolean;
  durationSec?: number;
  volume?: number;
  audioKind?: AudioGenerationKind;
  model?: ElevenLabsMusicModel;
  preparedConfigPath: string;
  lockPath: string;
  overwrite?: boolean;
  offline?: boolean;
  elevenLabsApiKey?: string;
  mcpRuntime?: ElevenLabsMcpRuntime;
  mcpCall?: ElevenLabsMcpCall;
  signal?: AbortSignal;
  now?: () => Date;
  onAudioProgress?: (ratio: number, stage: string) => void;
  onWarning?: (warning: CliIssue) => void;
};

export const STANDARD_COUNTDOWN_FROM = 3;
export const MIN_STANDARD_OPENING_SEC = 1.4;
export const MIN_STANDARD_CURTAIN_OPEN_SEC = 1;
export const MIN_STANDARD_ENDING_SEC = 1;

const INITIAL_TITLE_PLACEHOLDERS = new Set(["在这里填写视频标题"]);
const INITIAL_TELEPROMPTER_PLACEHOLDERS = new Set(["在这里填写提词文案。"]);

export function standardProductionStructureIssues(
  config: ProjectConfig,
): CliIssue[] {
  const issues: CliIssue[] = [];
  const title = config.opening.title.text.trim();
  if (!title || INITIAL_TITLE_PLACEHOLDERS.has(title)) {
    issues.push({
      code: "STANDARD_TITLE_REQUIRED",
      path: "opening.title.text",
      message: title
        ? "一键生产前必须替换 init 生成的标题占位文案。"
        : "一键生产默认必须包含非空开场标题。",
    });
  }

  const teleprompter = config.content.teleprompter;
  if (teleprompter.mode === "text") {
    const content = teleprompter.text?.content.trim() ?? "";
    if (!content || INITIAL_TELEPROMPTER_PLACEHOLDERS.has(content)) {
      issues.push({
        code: "STANDARD_TELEPROMPTER_REQUIRED",
        path: "content.teleprompter.text.content",
        message: content
          ? "一键生产前必须替换 init 生成的提词占位文案。"
          : "一键生产默认必须包含非空提词文案。",
      });
    }
  }

  const countdown = config.opening.countdown;
  if (!countdown.enabled) {
    issues.push({
      code: "STANDARD_COUNTDOWN_REQUIRED",
      path: "opening.countdown.enabled",
      message: "一键生产默认必须保留幕布与 3-2-1 倒计时。",
    });
  } else if (countdown.from !== STANDARD_COUNTDOWN_FROM) {
    issues.push({
      code: "STANDARD_COUNTDOWN_START_INVALID",
      path: "opening.countdown.from",
      message: `一键生产必须保留完整的 ${STANDARD_COUNTDOWN_FROM}-2-1 倒计时。`,
      value: countdown.from,
    });
  } else if (countdown.from / countdown.speed < MIN_STANDARD_OPENING_SEC) {
    issues.push({
      code: "STANDARD_COUNTDOWN_TOO_FAST",
      path: "opening.countdown.speed",
      message: `一键生产的 3-2-1 倒计时必须至少持续 ${MIN_STANDARD_OPENING_SEC} 秒。`,
      value: countdown.speed,
    });
  }

  const curtain = config.opening.curtain;
  if (curtain.openDurationSec < MIN_STANDARD_CURTAIN_OPEN_SEC) {
    issues.push({
      code: "STANDARD_CURTAIN_TOO_FAST",
      path: "opening.curtain.openDurationSec",
      message: `一键生产幕帘拉开效果必须至少持续 ${MIN_STANDARD_CURTAIN_OPEN_SEC} 秒。`,
      value: curtain.openDurationSec,
    });
  }
  if (curtain.sfx === null) {
    issues.push({
      code: "STANDARD_OPENING_SFX_REQUIRED",
      path: "opening.curtain.sfx",
      message: "一键生产默认必须保留幕帘开场音效。",
    });
  }

  const endingAsset = config.ending.video.asset;
  const endingDuration = endingAsset.durationSec;
  if (endingAsset.kind !== "builtin" || endingAsset.id !== DEFAULT_ENDING_ASSET_ID) {
    issues.push({
      code: "STANDARD_ENDING_REQUIRED",
      path: "ending.video.asset",
      message: "一键生产默认必须保留内置 FlowPrompter 完整片尾。",
      value: endingAsset.id,
    });
  }
  if (typeof endingDuration !== "number" || endingDuration < MIN_STANDARD_ENDING_SEC) {
    issues.push({
      code: "STANDARD_ENDING_TOO_SHORT",
      path: "ending.video.asset.durationSec",
      message: `一键生产片尾必须至少持续 ${MIN_STANDARD_ENDING_SEC} 秒；删除 ending 覆盖即可恢复内置 FlowPrompter 片尾。`,
      value: endingDuration ?? null,
    });
  }
  if (!config.ending.video.keepAudio) {
    issues.push({
      code: "STANDARD_ENDING_AUDIO_REQUIRED",
      path: "ending.video.keepAudio",
      message: "一键生产默认必须保留 FlowPrompter 官方片尾音轨。",
    });
  }
  return issues;
}

export function assertStandardProductionStructure(
  config: ProjectConfig,
  allowCustomStructure = false,
): void {
  if (allowCustomStructure) return;
  const issues = standardProductionStructureIssues(config);
  if (issues.length === 0) return;
  throw new CliError(
    "PRODUCTION_GUARD_FAILED",
    "一键生产的内容未完成，或标准片头/片尾被移除或缩短；已在生成音频和渲染前停止。",
    {
      issues,
      hint: "替换 init 占位内容并保留默认 opening/ending；只有用户明确要求自定义结构时才使用 --allow-custom-structure。",
    },
  );
}

export function isGeneratedCandidate(
  config: ProjectConfig,
  mode: BgmProductionMode,
  replace: boolean,
) {
  if (mode === "off") return false;
  if (replace) return true;
  const bgm = config.content.bgm;
  if (mode === "required") return bgm === null || bgm.asset.kind === "builtin";
  // The built-in track is the template fallback, so auto mode upgrades it.
  // Explicit local/upload BGM and explicit null remain user-owned decisions.
  return bgm?.asset.kind === "builtin";
}

export function createProductionAudioPlan(options: Pick<
  PrepareVideoProductionOptions,
  "input" | "mode" | "replaceBgm" | "durationSec" | "volume" | "audioKind" | "model" | "prompt"
>) {
  const mode = options.mode ?? "auto";
  if (!isGeneratedCandidate(options.input.config, mode, options.replaceBgm === true)) return null;
  const videoPlan = createRenderPlan(options.input);
  const prompt = tunedPrompt(
    options.input.config,
    options.durationSec ?? videoPlan.timeline.content.seconds,
    options.prompt,
    options.audioKind,
  );
  return {
    prompt,
    plan: createAudioGenerationPlan({
      kind: options.audioKind,
      model: options.model,
      prompt,
      contentDurationSec: videoPlan.timeline.content.seconds,
      generationDurationSec: options.durationSec,
      volume: options.volume,
      baseDir: options.input.baseDir,
    }),
  };
}

function narrationContext(config: ProjectConfig): string {
  const teleprompter = config.content.teleprompter;
  if (teleprompter.mode === "text") return teleprompter.text?.content ?? "";
  return "A narrated presentation whose spoken content is supplied as a teleprompter video.";
}

function tunedPrompt(
  config: ProjectConfig,
  durationSec: number,
  creativeDirection?: string,
  audioKind: AudioGenerationKind = DEFAULT_AUDIO_KIND,
): string {
  const custom = creativeDirection?.replace(/\s+/g, " ").trim();
  if (custom && custom.length > 2_000) {
    throw new CliError("INVALID_OPTION_VALUE", "--bgm-prompt 不能超过 2000 个字符");
  }
  if (audioKind === "sound-effect") {
    // The provider caps sound-effect text at 450 characters. Prefer the
    // caller's scene direction when present, then let the prompt builder keep
    // the scene plus all loop/narration safety constraints within that limit.
    return createNarrationSoundEffectPrompt({
      title: config.opening.title.text,
      context: narrationContext(config),
      direction: custom,
    });
  }
  const base = createNarrationBgmPrompt({
    title: config.opening.title.text,
    context: narrationContext(config),
    durationSec,
  });
  if (!custom) return base;
  return `${base} Additional creative direction: ${custom}. Preserve every narration-safety constraint above.`;
}

async function assertFreshOutput(file: string, overwrite: boolean): Promise<void> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CliError("OUTPUT_INVALID", `输出目标不是可替换的普通文件: ${file}`);
  }
  if (!overwrite) {
    throw new CliError("OUTPUT_EXISTS", `输出文件已存在: ${file}`, {
      hint: "选择新路径，或确认后显式使用 --force。",
    });
  }
}

function skippedAudio(
  kind: AudioGenerationKind,
  mode: BgmProductionMode,
  status: ProductionAudioStatus,
  reason: string,
  prompt: string | null,
): PreparedVideoProduction["audio"] {
  return {
    kind,
    mode,
    status,
    reason,
    prompt,
    output: null,
    manifest: null,
    requestKey: null,
    reused: false,
  };
}

export async function prepareVideoProduction(
  options: PrepareVideoProductionOptions,
): Promise<PreparedVideoProduction> {
  if (options.input.lock) {
    throw new CliError("OPTION_CONFLICT", "produce 需要源配置，不能修改渲染锁文件", {
      hint: "将源 video.json 传给 produce；锁文件只供确定性 render 使用。",
    });
  }
  assertStandardProductionStructure(
    options.input.config,
    options.allowCustomStructure === true,
  );
  const mode = options.mode ?? "auto";
  const audioKind = options.audioKind ?? DEFAULT_AUDIO_KIND;
  const preparedConfig = path.resolve(options.preparedConfigPath);
  const lockPath = path.resolve(options.lockPath);
  if (preparedConfig === lockPath) {
    throw new CliError("OPTION_CONFLICT", "prepared config 与 lock 不能写入同一路径");
  }
  await Promise.all([
    assertFreshOutput(preparedConfig, options.overwrite === true),
    assertFreshOutput(lockPath, options.overwrite === true),
  ]);

  const videoPlan = createRenderPlan(options.input, options.exportOptions);
  const shouldGenerate = isGeneratedCandidate(
    options.input.config,
    mode,
    options.replaceBgm === true,
  );
  const plannedAudio = createProductionAudioPlan(options);
  const prompt = plannedAudio?.prompt ?? (shouldGenerate
    ? tunedPrompt(
        options.input.config,
        options.durationSec ?? videoPlan.timeline.content.seconds,
        options.prompt,
        options.audioKind,
      )
    : null);
  let generated: AudioGenerationResult | null = null;
  let audio: PreparedVideoProduction["audio"];

  // Offline mode and a missing Key only prohibit a new remote request.  A
  // request-key matched manifest+MP3 is still a local, verified input and is
  // checked under the same generation lock before either condition changes
  // auto/required/replace behavior.
  if (shouldGenerate && (options.offline || !options.elevenLabsApiKey?.trim())) {
    try {
      generated = await generatePlannedAudio({
        plan: plannedAudio!.plan,
        configBaseDir: path.dirname(preparedConfig),
        remoteAllowed: false,
        remoteDisabledError: options.offline ? "OFFLINE_RESOURCE_MISSING" : "AUTH_REQUIRED",
        signal: options.signal,
        onProgress: options.onAudioProgress,
      });
    } catch (error) {
      if (!isCliError(error) || !["AUTH_REQUIRED", "OFFLINE_RESOURCE_MISSING"].includes(error.code)) {
        throw error;
      }
    }
  }

  if (generated) {
    audio = {
      kind: generated.kind,
      mode,
      status: "reused",
      reason: "request-key-match",
      prompt: plannedAudio!.prompt,
      output: generated.output,
      manifest: generated.manifest,
      requestKey: generated.requestKey,
      reused: true,
    };
  } else if (!shouldGenerate) {
    audio = skippedAudio(
      audioKind,
      mode,
      mode === "off" ? "disabled" : "preserved",
      mode === "off"
        ? "BGM 自动生成已关闭；保留配置中的现有音频设置。"
        : options.input.config.content.bgm === null
          ? "源配置明确未设置 BGM；auto 模式尊重该选择。"
          : "源配置已有本地或上传 BGM；未重复生成。",
      null,
    );
  } else if (options.offline) {
    if (mode === "required" || options.replaceBgm === true) {
      throw new CliError("OFFLINE_RESOURCE_MISSING", "--offline 下无法生成请求的 BGM", {
        hint: "先联网完成 produce，之后可用生成的 prepared config 或 lock 离线 render。",
      });
    }
    const warning: CliIssue = {
      code: "BGM_GENERATION_SKIPPED",
      path: "content.bgm",
      message: "离线模式跳过 ElevenLabs BGM 生成，继续使用现有 BGM 或静音。",
    };
    options.onWarning?.(warning);
    audio = skippedAudio(audioKind, mode, "skipped", "offline", prompt);
  } else if (!options.elevenLabsApiKey?.trim()) {
    if (mode === "required" || options.replaceBgm === true) {
      throw new CliError("AUTH_REQUIRED", "BGM 生成已被明确请求，但未配置 ElevenLabs API Key", {
        hint: "在 Electron 客户端配置 Key，或填写本机 secrets.env 后重试。",
      });
    }
    const warning: CliIssue = {
      code: "BGM_GENERATION_SKIPPED",
      path: "env.ELEVENLABS_API_KEY",
      message: "未配置 ElevenLabs API Key，跳过自动 BGM，继续使用现有 BGM 或静音。",
    };
    options.onWarning?.(warning);
    audio = skippedAudio(audioKind, mode, "skipped", "missing-key", prompt);
  } else {
    const plan = plannedAudio!.plan;
    generated = await generatePlannedAudio({
      plan,
      elevenLabsApiKey: options.elevenLabsApiKey,
      runtime: options.mcpRuntime,
      mcpCall: options.mcpCall,
      reuse: true,
      signal: options.signal,
      now: options.now,
      configBaseDir: path.dirname(preparedConfig),
      onProgress: options.onAudioProgress,
    });
    audio = {
      kind: generated.kind,
      mode,
      status: generated.reused ? "reused" : "generated",
      reason: generated.reused ? "request-key-match" : "elevenlabs-mcp",
      prompt,
      output: generated.output,
      manifest: generated.manifest,
      requestKey: generated.requestKey,
      reused: generated.reused,
    };
  }

  const portable = configForFileOutput(options.input, path.dirname(preparedConfig));
  const preparedBody = generated
    ? deepMerge(portable, { content: { bgm: generated.bgm } })
    : portable;
  await writeJsonAtomic(preparedConfig, preparedBody, options.overwrite === true);
  const preparedInput = await loadProjectInput(preparedConfig);
  const lock = await createProjectLock(preparedInput, options.runtime, {
    outputBaseDir: path.dirname(lockPath),
    exportOptions: options.exportOptions,
  });
  await writeJsonAtomic(lockPath, lock, options.overwrite === true);
  return { preparedInput, preparedConfig, lockPath, lock, audio };
}
