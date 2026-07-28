import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { withFileLock } from "./cache";
import { probeMedia, type MediaProbe } from "./media";
import {
  callElevenLabsMcpTool,
  ELEVENLABS_MCP_PACKAGE,
  ELEVENLABS_MCP_SOURCE_COMMIT,
  ELEVENLABS_MCP_MUSIC_TOOL,
  ELEVENLABS_MCP_SOUND_EFFECT_TOOL,
  ELEVENLABS_MCP_VERSION,
  ELEVENLABS_MCP_WHEEL_SHA256,
  resolveElevenLabsMcpRuntime,
  type ElevenLabsMcpCall,
  type ElevenLabsMcpRuntime,
  type ElevenLabsMcpTool,
} from "./elevenlabs-mcp";
import { digestFile, stableStringify } from "./project";
import { CliError } from "./protocol";
import { commitArtifactsAtomically, temporaryArtifactPath } from "./render";

export const AUDIO_PLAN_VERSION = 1 as const;
export const AUDIO_MANIFEST_VERSION = 3 as const;
export const ELEVENLABS_MUSIC_TERMS_URL = "https://elevenlabs.io/music-terms";
export const ELEVENLABS_GENERAL_TERMS_URL = "https://elevenlabs.io/terms-of-use";
export const DEFAULT_AUDIO_MODEL = "music_v2" as const;
export const DEFAULT_AUDIO_KIND = "sound-effect" as const;
export const DEFAULT_SOUND_EFFECT_DURATION_SEC = 5 as const;
export const MIN_SOUND_EFFECT_DURATION_SEC = 0.5 as const;
export const MAX_SOUND_EFFECT_DURATION_SEC = 5 as const;
export const MAX_SOUND_EFFECT_PROMPT_CHARS = 450 as const;
export const SOUND_EFFECT_OUTPUT_FORMAT = "mp3_44100_128" as const;
export const DEFAULT_BGM_VOLUME = 0.25;
export const MAX_GENERATED_AUDIO_BYTES = 64 * 1024 * 1024;
/**
 * MP3 frame boundaries and container metadata can differ slightly from the
 * requested wall-clock duration. Half a second covers that rounding without
 * accepting an output that is missing a material part of the requested music.
 */
export const GENERATED_AUDIO_DURATION_TOLERANCE_SEC = 0.5;
const AUDIO_GENERATION_LOCK_TIMEOUT_MS = 16 * 60_000;
const AUDIO_GENERATION_LOCK_STALE_MS = 20 * 60_000;

export type AudioProvider = "elevenlabs";
export type AudioAuthMode = "mcp";
export type AudioGenerationKind = "music" | "sound-effect";
export type ElevenLabsMusicModel = "music_v2" | "music_v1";

export type AudioGenerationPlan = {
  planVersion: typeof AUDIO_PLAN_VERSION;
  kind: AudioGenerationKind;
  provider: AudioProvider;
  auth: {
    mode: AudioAuthMode;
    credentialSource: "ELEVENLABS_API_KEY";
  };
  transport: {
    kind: "mcp-stdio";
    package: typeof ELEVENLABS_MCP_PACKAGE;
    tool: ElevenLabsMcpTool;
  };
  model: ElevenLabsMusicModel | null;
  prompt: string;
  forceInstrumental: boolean;
  outputFormat?: typeof SOUND_EFFECT_OUTPUT_FORMAT;
  generationLoop?: true;
  contentDurationSec: number;
  generationDurationSec: number;
  loopRequired: boolean;
  volume: number;
  outputPath: string;
  manifestPath: string;
  requestKey: string;
  estimatedCost: null;
  license: {
    snapshotRequired: true;
    termsUrl: string;
  };
};

export type AudioGenerationResult = {
  output: string;
  manifest: string;
  kind: AudioGenerationKind;
  provider: AudioProvider;
  authMode: AudioAuthMode;
  model: ElevenLabsMusicModel | null;
  requestKey: string;
  requestId: null;
  reused: boolean;
  contentDurationSec: number;
  generatedDurationSec: number | null;
  loopRequired: boolean;
  digest: string;
  sizeBytes: number;
  media: MediaProbe;
  bgm: {
    asset: { kind: "file"; path: string };
    volume: number;
  };
};

export type GenerateAudioOptions = {
  plan: AudioGenerationPlan;
  elevenLabsApiKey?: string;
  runtime?: ElevenLabsMcpRuntime;
  mcpCall?: ElevenLabsMcpCall;
  overwrite?: boolean;
  reuse?: boolean;
  /**
   * Permit a paid MCP request after checking the request-key cache.  Callers
   * use this for offline/auth preflight: a verified existing asset remains
   * usable, while a miss never reaches the provider.
   */
  remoteAllowed?: boolean;
  remoteDisabledError?: "AUTH_REQUIRED" | "OFFLINE_RESOURCE_MISSING";
  signal?: AbortSignal;
  now?: () => Date;
  configBaseDir?: string;
  onProgress?: (ratio: number, stage: string) => void;
};

type AudioManifest = {
  manifestVersion: typeof AUDIO_MANIFEST_VERSION;
  createdAt: string;
  request: {
    key: string;
    kind: AudioGenerationKind;
    provider: AudioProvider;
    authMode: AudioAuthMode;
    tool: ElevenLabsMcpTool;
    model: ElevenLabsMusicModel | null;
    prompt: string;
    generationDurationSec: number;
    musicLengthMs?: number;
    forceInstrumental: boolean;
    outputFormat?: typeof SOUND_EFFECT_OUTPUT_FORMAT;
    loop?: true;
  };
  providerResponse: {
    transport: "mcp-stdio";
    requestedDistribution: typeof ELEVENLABS_MCP_PACKAGE;
    tool: ElevenLabsMcpTool;
    runtime: {
      source: ElevenLabsMcpRuntime["source"];
      integrity: NonNullable<ElevenLabsMcpRuntime["integrity"]>;
      version: typeof ELEVENLABS_MCP_VERSION;
    };
    pinnedBundle?: {
      sourceCommit: typeof ELEVENLABS_MCP_SOURCE_COMMIT;
      wheelSha256: typeof ELEVENLABS_MCP_WHEEL_SHA256;
    };
  };
  audio: {
    file: string;
    sizeBytes: number;
    durationSec: number | null;
    digest: string;
    loopRequired: boolean;
    contentDurationSec: number;
  };
  configPatch: {
    content: {
      bgm: AudioGenerationResult["bgm"];
    };
  };
  cost: { estimated: null; reason: string };
  licenseSnapshot: { checkedAt: string; termsUrl: string; note: string };
};

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw new CliError("INTERRUPTED", "音频生成已取消", { cause: signal.reason });
}

function requestKeyFor(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

function generationLockPath(plan: AudioGenerationPlan): string {
  const outputPath = path.resolve(plan.outputPath);
  const outputKey = crypto.createHash("sha256").update(outputPath).digest("hex").slice(0, 32);
  // Default output names already contain the request key. Scoping the lock to
  // the resolved output additionally serializes callers that explicitly point
  // different requests at the same paid-audio destination.
  return path.join(path.dirname(outputPath), `.littlestart-audio-${outputKey}.lock`);
}

function portableRelative(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target);
  if (relative === "") return path.basename(target);
  return relative.split(path.sep).join("/");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function lstatRegularFile(file: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new CliError("OUTPUT_INVALID", `音频产物必须是普通文件: ${file}`);
  }
  return stat;
}

function bgmFor(plan: AudioGenerationPlan, configBaseDir?: string): AudioGenerationResult["bgm"] {
  return {
    asset: {
      kind: "file",
      path: portableRelative(configBaseDir ?? path.dirname(plan.manifestPath), plan.outputPath),
    },
    volume: plan.volume,
  };
}

function acceptableGeneratedDuration(
  durationSec: number | null,
  requestedDurationSec: number,
): durationSec is number {
  return (
    typeof durationSec === "number" &&
    Number.isFinite(durationSec) &&
    durationSec > 0 &&
    Math.abs(durationSec - requestedDurationSec) <= GENERATED_AUDIO_DURATION_TOLERANCE_SEC
  );
}

function assertGeneratedDuration(media: MediaProbe, plan: AudioGenerationPlan): number {
  if (
    typeof media.durationSec !== "number" ||
    !Number.isFinite(media.durationSec) ||
    media.durationSec <= 0
  ) {
    throw new CliError("ASSET_UNSUPPORTED", "无法确认生成音频的实际时长", {
      details: media,
    });
  }
  if (!acceptableGeneratedDuration(media.durationSec, plan.generationDurationSec)) {
    throw new CliError("REMOTE_REQUEST_FAILED", "ElevenLabs MCP 返回的音频时长与请求明显不符", {
      details: {
        requestedDurationSec: plan.generationDurationSec,
        actualDurationSec: media.durationSec,
        direction: media.durationSec < plan.generationDurationSec ? "shorter" : "longer",
        toleranceSec: GENERATED_AUDIO_DURATION_TOLERANCE_SEC,
      },
    });
  }
  return media.durationSec;
}

function loopRequiredFor(plan: AudioGenerationPlan, generatedDurationSec: number): boolean {
  return generatedDurationSec < plan.contentDurationSec;
}

export function createNarrationBgmPrompt(options: {
  title?: string;
  context?: string;
  durationSec: number;
}): string {
  const clean = (value: string | undefined, limit: number) =>
    (value ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
  const title = clean(options.title, 160) || "Untitled narrated video";
  const context = clean(options.context, 360) || "A clear spoken presentation";
  const duration = Math.max(3, Math.min(600, Math.round(options.durationSec)));
  return [
    `Create original instrumental background music for a narrated vertical video titled: ${title}.`,
    `Editorial context: ${context}.`,
    `Target duration: ${duration} seconds.`,
    "Keep the arrangement sparse and narration-friendly, with low-to-medium energy, a restrained intro, gentle development, and a clean loopable ending.",
    "No vocals, lyrics, spoken words, dramatic drops, harsh transients, or dense lead melodies.",
    "Do not imitate or quote any recognisable copyrighted song, artist, theme, or melody.",
  ].join(" ");
}

const AVIATION_SOUND_DIRECTION =
  "modern commercial aircraft cockpit and cabin ambience: low turbofan hum, steady ventilation airflow, subtle avionics fans, and gentle airframe resonance";

const ENVIRONMENT_SOUND_DIRECTIONS = [
  {
    terms: [
      "mayday",
      "flight",
      "pilot",
      "cockpit",
      "aircraft",
      "airplane",
      "aeroplane",
      "aviation",
      "airline",
      "airport",
      "runway",
      "air traffic",
      "emergency landing",
      "engine fire",
      "飞机",
      "飞行",
      "航空",
      "航班",
      "飞行员",
      "驾驶舱",
      "客舱",
      "机场",
      "跑道",
      "迫降",
      "空中交通",
    ],
    direction: AVIATION_SOUND_DIRECTION,
  },
  {
    terms: ["train", "railway", "railroad", "subway", "metro", "station", "火车", "铁路", "地铁", "车站"],
    direction:
      "steady modern passenger-train interior ambience with low rail rumble, soft ventilation airflow, and restrained carriage resonance",
  },
  {
    terms: ["car", "driving", "road", "highway", "vehicle", "bus", "taxi", "汽车", "驾车", "公路", "高速", "公交"],
    direction:
      "steady enclosed road-vehicle ambience with low engine hum, soft tire noise, gentle ventilation, and an even cabin resonance",
  },
  {
    terms: ["ocean", "sea", "beach", "shore", "coast", "boat", "ship", "海洋", "大海", "海边", "沙滩", "船"],
    direction:
      "calm coastal ambience with soft continuous surf, light sea breeze, and distant water movement",
  },
  {
    terms: ["forest", "woods", "nature", "garden", "rain", "mountain", "park", "森林", "自然", "花园", "下雨", "雨声", "山野", "公园"],
    direction:
      "calm outdoor nature ambience with soft wind through foliage and a distant, even environmental bed",
  },
  {
    terms: ["street", "city", "urban", "downtown", "traffic", "sidewalk", "街道", "城市", "市区", "交通", "人行道"],
    direction:
      "restrained modern city ambience with soft distant traffic, light ventilation-like air movement, and an even urban room tone",
  },
  {
    terms: ["office", "meeting", "workplace", "studio", "presentation", "办公室", "会议", "职场", "工作室", "演示"],
    direction:
      "quiet modern indoor workspace room tone with soft HVAC airflow, faint equipment fans, and subtle building ambience",
  },
  {
    terms: ["kitchen", "cafe", "coffee", "restaurant", "cooking", "厨房", "咖啡", "餐厅", "烹饪", "做饭"],
    direction:
      "quiet indoor kitchen and cafe ambience with soft ventilation, subtle appliance hum, and restrained room resonance",
  },
  {
    terms: ["factory", "machine", "mechanical", "workshop", "industrial", "工厂", "机器", "机械", "车间", "工业"],
    direction:
      "stable light-industrial room tone with low machinery hum, steady ventilation, and restrained mechanical resonance",
  },
] as const;

function normalizedSceneEvidence(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("en-US");
}

function includesSceneTerm(evidence: string, term: string): boolean {
  if (/[^\x00-\x7f]/u.test(term)) return evidence.includes(term);
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:$|[^a-z0-9])`, "u").test(evidence);
}

/**
 * Convert narration evidence into a deterministic sound-source description.
 * The returned value intentionally never copies the narration itself, because
 * ElevenLabs otherwise tends to interpret dialogue or emergency language as
 * speech, alarms, or cinematic action instead of a neutral environmental bed.
 */
export function inferEnvironmentalSoundDirection(options: {
  title?: string;
  context?: string;
}): string {
  const evidence = `${normalizedSceneEvidence(options.title)} ${normalizedSceneEvidence(options.context)}`.trim();
  const match = ENVIRONMENT_SOUND_DIRECTIONS.find(({ terms }) =>
    terms.some((term) => includesSceneTerm(evidence, term)),
  );
  return match?.direction ??
    "quiet neutral indoor room tone with soft HVAC airflow, faint equipment hum, and subtle building ambience";
}

function boundedSoundDirection(value: string, limit: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized.replace(/[\s,;:.!?]+$/u, "");

  const candidate = normalized.slice(0, limit + 1);
  const boundaries = [...candidate.matchAll(/[\s,;:.!?()[\]{}\-–—/]+/gu)];
  const lastBoundary = boundaries.at(-1)?.index ?? -1;
  if (lastBoundary <= 0) {
    throw new CliError(
      "INVALID_OPTION_VALUE",
      `音效场景提示词包含超过 ${limit} 个字符的不可截断单词`,
      { hint: "请用空格分隔声音来源，或缩短 --bgm-prompt。" },
    );
  }
  return candidate.slice(0, lastBoundary).replace(/[\s,;:.!?]+$/u, "");
}

export function createNarrationSoundEffectPrompt(options: {
  title?: string;
  context?: string;
  direction?: string;
}): string {
  const prefix = "Create one seamless looping environmental sound effect: ";
  const safety = " Stable, continuous, realistic, even, and narration-friendly. No music, melody, rhythm, voices, speech, dialogue, radio chatter, announcements, alarms, warning tones, beeps, chimes, impacts, turbulence, drama, or sudden transients.";
  const scene = options.direction?.trim() || inferEnvironmentalSoundDirection(options);
  const sceneLimit = MAX_SOUND_EFFECT_PROMPT_CHARS - prefix.length - safety.length - 1;
  const boundedScene = boundedSoundDirection(scene, sceneLimit);
  return `${prefix}${boundedScene}.${safety}`;
}

export function createAudioGenerationPlan(options: {
  kind?: AudioGenerationKind;
  provider?: AudioProvider;
  model?: ElevenLabsMusicModel;
  prompt: string;
  contentDurationSec: number;
  generationDurationSec?: number;
  volume?: number;
  outputPath?: string;
  manifestPath?: string;
  baseDir?: string;
}): AudioGenerationPlan {
  const kind = options.kind ?? DEFAULT_AUDIO_KIND;
  const provider = options.provider ?? "elevenlabs";
  if (kind === "sound-effect" && options.model !== undefined) {
    throw new CliError("OPTION_CONFLICT", "--audio-kind sound-effect 不支持 --model", {
      hint: "音效由 ElevenLabs text_to_sound_effects 生成，不使用音乐模型参数。",
      issues: [
        { path: "options.kind", message: "sound-effect" },
        { path: "options.model", message: options.model },
      ],
    });
  }
  const model = kind === "music" ? options.model ?? DEFAULT_AUDIO_MODEL : null;
  const prompt = options.prompt.trim();
  const maximumPromptChars = kind === "sound-effect" ? MAX_SOUND_EFFECT_PROMPT_CHARS : 4_100;
  if (prompt.length === 0 || prompt.length > maximumPromptChars) {
    throw new CliError("INVALID_OPTION_VALUE", `--prompt 在 ${kind} 模式下长度必须在 1 到 ${maximumPromptChars} 个字符之间`, {
      issues: [{ path: "options.prompt", message: `当前长度 ${prompt.length}` }],
    });
  }
  if (!Number.isFinite(options.contentDurationSec) || options.contentDurationSec <= 0) {
    throw new CliError("CONFIG_INVALID", "视频正片时长必须大于 0 才能规划背景音频");
  }
  const requestedDuration =
    options.generationDurationSec ??
    (kind === "sound-effect"
      ? DEFAULT_SOUND_EFFECT_DURATION_SEC
      : Math.min(600, Math.max(3, Math.ceil(options.contentDurationSec * 1_000) / 1_000)));
  const minimumDuration = kind === "sound-effect" ? MIN_SOUND_EFFECT_DURATION_SEC : 3;
  const maximumDuration = kind === "sound-effect" ? MAX_SOUND_EFFECT_DURATION_SEC : 600;
  if (
    !Number.isFinite(requestedDuration) ||
    requestedDuration < minimumDuration ||
    requestedDuration > maximumDuration
  ) {
    throw new CliError(
      "INVALID_OPTION_VALUE",
      `--duration 在 ${kind} 模式下必须在 ${minimumDuration} 到 ${maximumDuration} 秒之间`,
      {
      issues: [{ path: "options.duration", message: `收到 ${requestedDuration}` }],
      },
    );
  }
  const volume = options.volume ?? DEFAULT_BGM_VOLUME;
  if (!Number.isFinite(volume) || volume < 0 || volume > 1) {
    throw new CliError("INVALID_OPTION_VALUE", "--volume 必须在 0 到 1 之间", {
      issues: [{ path: "options.volume", message: `收到 ${volume}` }],
    });
  }
  const generationDurationSec = Math.round(requestedDuration * 1_000) / 1_000;
  const tool = kind === "sound-effect"
    ? ELEVENLABS_MCP_SOUND_EFFECT_TOOL
    : ELEVENLABS_MCP_MUSIC_TOOL;
  const request = {
    kind,
    provider,
    transport: "mcp-stdio",
    mcpVersion: ELEVENLABS_MCP_VERSION,
    tool,
    model,
    prompt,
    generationDurationSec,
    forceInstrumental: kind === "music",
    ...(kind === "sound-effect"
      ? { outputFormat: SOUND_EFFECT_OUTPUT_FORMAT, loop: true }
      : {}),
  } as const;
  const requestKey = requestKeyFor(request);
  const shortKey = requestKey.slice("sha256:".length, "sha256:".length + 16);
  const baseDir = path.resolve(options.baseDir ?? process.cwd());
  const outputPath = path.resolve(
    baseDir,
    options.outputPath ?? path.join("assets", `${kind === "sound-effect" ? "sfx" : "bgm"}-${shortKey}.mp3`),
  );
  const manifestPath = path.resolve(
    baseDir,
    options.manifestPath ?? `${outputPath}.manifest.json`,
  );
  return {
    planVersion: AUDIO_PLAN_VERSION,
    kind,
    provider,
    auth: { mode: "mcp", credentialSource: "ELEVENLABS_API_KEY" },
    transport: { kind: "mcp-stdio", package: ELEVENLABS_MCP_PACKAGE, tool },
    model,
    prompt,
    forceInstrumental: kind === "music",
    ...(kind === "sound-effect"
      ? { outputFormat: SOUND_EFFECT_OUTPUT_FORMAT, generationLoop: true as const }
      : {}),
    contentDurationSec: Math.round(options.contentDurationSec * 1_000) / 1_000,
    generationDurationSec,
    loopRequired: options.contentDurationSec > generationDurationSec,
    volume,
    outputPath,
    manifestPath,
    requestKey,
    estimatedCost: null,
    license: {
      snapshotRequired: true,
      termsUrl: kind === "music" ? ELEVENLABS_MUSIC_TERMS_URL : ELEVENLABS_GENERAL_TERMS_URL,
    },
  };
}

async function stageFile(file: string, contents: Uint8Array | string): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const handle = await fs.open(file, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function reusableResult(
  plan: AudioGenerationPlan,
  configBaseDir?: string,
): Promise<AudioGenerationResult | null> {
  const [audioStat, manifestStat] = await Promise.all([
    lstatRegularFile(plan.outputPath),
    lstatRegularFile(plan.manifestPath),
  ]);
  if (!audioStat && !manifestStat) return null;
  if (!audioStat || !manifestStat) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(plan.manifestPath, "utf8"));
  } catch {
    return null;
  }
  if (
    !isRecord(parsed) ||
    parsed.manifestVersion !== AUDIO_MANIFEST_VERSION ||
    !isRecord(parsed.request) ||
    !isRecord(parsed.audio)
  ) return null;
  if (
    parsed.request.key !== plan.requestKey ||
    parsed.request.kind !== plan.kind ||
    parsed.request.tool !== plan.transport.tool ||
    parsed.audio.sizeBytes !== audioStat.size
  ) return null;
  const digest = await digestFile(plan.outputPath);
  if (parsed.audio.digest !== digest) return null;
  const media = await probeMedia(plan.outputPath).catch(() => null);
  if (
    !media?.audioCodec ||
    !acceptableGeneratedDuration(media.durationSec, plan.generationDurationSec)
  ) {
    return null;
  }
  const generatedDurationSec = media.durationSec;
  return {
    output: plan.outputPath,
    manifest: plan.manifestPath,
    kind: plan.kind,
    provider: plan.provider,
    authMode: "mcp",
    model: plan.model,
    requestKey: plan.requestKey,
    requestId: null,
    reused: true,
    contentDurationSec: plan.contentDurationSec,
    generatedDurationSec,
    loopRequired: loopRequiredFor(plan, generatedDurationSec),
    digest,
    sizeBytes: media.sizeBytes,
    media: { ...media, path: plan.outputPath },
    bgm: bgmFor(plan, configBaseDir),
  };
}

async function assertGenerationTargetsAvailable(plan: AudioGenerationPlan, overwrite: boolean) {
  for (const file of [plan.outputPath, plan.manifestPath]) {
    const stat = await lstatRegularFile(file);
    if (stat && !overwrite) {
      throw new CliError("OUTPUT_EXISTS", `已有音频产物与当前请求不匹配: ${file}`, {
        hint: "不要重复付费生成；确认旧产物后改用新路径，或显式使用 --force 替换。",
      });
    }
  }
}

async function generatedMcpFile(options: GenerateAudioOptions): Promise<{
  file: string;
  runtime: ElevenLabsMcpRuntime;
  cleanup: () => Promise<void>;
}> {
  const key = options.elevenLabsApiKey?.trim();
  if (!key) {
    throw new CliError("AUTH_REQUIRED", "未配置 ElevenLabs API Key", {
      hint: "在 Electron 安装提示中填写，或在本机 secrets.env 中设置 ELEVENLABS_API_KEY。",
    });
  }
  await fs.mkdir(path.dirname(options.plan.outputPath), { recursive: true });
  const directory = await fs.mkdtemp(
    path.join(path.dirname(options.plan.outputPath), ".littlestart-elevenlabs-"),
  );
  const cleanup = () => fs.rm(directory, { recursive: true, force: true });
  try {
    const runtime = options.runtime ?? await resolveElevenLabsMcpRuntime();
    const call = options.mcpCall ?? callElevenLabsMcpTool;
    await call({
      runtime,
      apiKey: key,
      tool: options.plan.transport.tool,
      outputDirectory: directory,
      signal: options.signal,
      arguments: options.plan.kind === "sound-effect"
        ? {
            text: options.plan.prompt,
            duration_seconds: options.plan.generationDurationSec,
            output_directory: directory,
            output_format: SOUND_EFFECT_OUTPUT_FORMAT,
            loop: true,
          }
        : {
            prompt: options.plan.prompt,
            output_directory: directory,
            music_length_ms: Math.round(options.plan.generationDurationSec * 1_000),
            model_id: options.plan.model,
            force_instrumental: true,
          },
    });
    throwIfAborted(options.signal);
    const entries = await fs.readdir(directory, { withFileTypes: true });
    const mp3Names = entries.filter(
      (entry) => entry.isFile() && !entry.isSymbolicLink() && path.extname(entry.name).toLowerCase() === ".mp3",
    );
    if (mp3Names.length !== 1) {
      throw new CliError("MCP_PROTOCOL_ERROR", "ElevenLabs MCP 没有返回唯一的 MP3 产物", {
        details: { mp3Count: mp3Names.length, entries: entries.map((entry) => entry.name).slice(0, 20) },
      });
    }
    const file = path.join(directory, mp3Names[0].name);
    const stat = await lstatRegularFile(file);
    if (!stat || stat.size === 0 || stat.size > MAX_GENERATED_AUDIO_BYTES) {
      throw new CliError("REMOTE_REQUEST_FAILED", "ElevenLabs MCP 返回的音频为空或超过安全上限", {
        details: { sizeBytes: stat?.size ?? null, maxBytes: MAX_GENERATED_AUDIO_BYTES },
      });
    }
    return { file, runtime, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

async function generatePlannedAudioWithLockHeld(
  options: GenerateAudioOptions,
): Promise<AudioGenerationResult> {
  const { plan } = options;
  throwIfAborted(options.signal);
  if (options.reuse !== false) {
    const reusable = await reusableResult(plan, options.configBaseDir);
    if (reusable) {
      options.onProgress?.(1, "reused");
      return reusable;
    }
  }
  if (options.remoteAllowed === false) {
    const offline = options.remoteDisabledError === "OFFLINE_RESOURCE_MISSING";
    throw new CliError(
      options.remoteDisabledError ?? "AUTH_REQUIRED",
      offline ? "--offline 禁止远程生成背景音频" : "未配置 ElevenLabs API Key",
      {
        hint: offline
          ? "可复用与当前请求匹配的已验证背景音频；否则请联网后重试。"
          : "可复用与当前请求匹配的已验证背景音频；否则请配置 ElevenLabs API Key。",
      },
    );
  }
  await assertGenerationTargetsAvailable(plan, options.overwrite === true);
  options.onProgress?.(0.05, "request");
  const generated = await generatedMcpFile(options);
  const audioStage = temporaryArtifactPath(plan.outputPath, ".mp3");
  const manifestStage = temporaryArtifactPath(plan.manifestPath, ".json");
  let commitAttempted = false;
  try {
    options.onProgress?.(0.8, "verify");
    await fs.copyFile(generated.file, audioStage, fs.constants.COPYFILE_EXCL);
    await fs.chmod(audioStage, 0o600).catch(() => {});
    const media = await probeMedia(audioStage);
    if (!media.audioCodec) {
      throw new CliError("ASSET_UNSUPPORTED", "生成结果没有可读音频轨道", { details: media });
    }
    const generatedDurationSec = assertGeneratedDuration(media, plan);
    const loopRequired = loopRequiredFor(plan, generatedDurationSec);
    const digest = await digestFile(audioStage);
    const now = (options.now ?? (() => new Date()))().toISOString();
    const bgm = bgmFor(plan, options.configBaseDir);
    const manifest: AudioManifest = {
      manifestVersion: AUDIO_MANIFEST_VERSION,
      createdAt: now,
      request: {
        key: plan.requestKey,
        kind: plan.kind,
        provider: plan.provider,
        authMode: "mcp",
        tool: plan.transport.tool,
        model: plan.model,
        prompt: plan.prompt,
        generationDurationSec: plan.generationDurationSec,
        ...(plan.kind === "music"
          ? {
              musicLengthMs: Math.round(plan.generationDurationSec * 1_000),
              forceInstrumental: true as const,
            }
          : {
              forceInstrumental: false,
              outputFormat: SOUND_EFFECT_OUTPUT_FORMAT,
              loop: true as const,
            }),
      },
      providerResponse: {
        transport: "mcp-stdio",
        requestedDistribution: ELEVENLABS_MCP_PACKAGE,
        tool: plan.transport.tool,
        runtime: {
          source: generated.runtime.source,
          integrity: generated.runtime.integrity ?? "unverified",
          version: generated.runtime.version,
        },
        ...(generated.runtime.integrity === "pinned-bundle"
          ? {
              pinnedBundle: {
                sourceCommit: ELEVENLABS_MCP_SOURCE_COMMIT,
                wheelSha256: ELEVENLABS_MCP_WHEEL_SHA256,
              },
            }
          : {}),
      },
      audio: {
        file: portableRelative(path.dirname(plan.manifestPath), plan.outputPath),
        sizeBytes: media.sizeBytes,
        durationSec: generatedDurationSec,
        digest,
        loopRequired,
        contentDurationSec: plan.contentDurationSec,
      },
      configPatch: { content: { bgm } },
      cost: { estimated: null, reason: "账户套餐、额度和供应商价格会变化；CLI 不虚构费用。" },
      licenseSnapshot: {
        checkedAt: now,
        termsUrl: plan.license.termsUrl,
        note: "发行前按当前账户计划、用途和地区重新核对条款。",
      },
    };
    await stageFile(manifestStage, `${stableStringify(manifest, 2)}\n`);
    throwIfAborted(options.signal);
    options.onProgress?.(0.95, "commit");
    commitAttempted = true;
    await commitArtifactsAtomically(
      [
        { temporaryPath: audioStage, targetPath: plan.outputPath },
        { temporaryPath: manifestStage, targetPath: plan.manifestPath },
      ],
      options.overwrite === true,
    );
    options.onProgress?.(1, "complete");
    return {
      output: plan.outputPath,
      manifest: plan.manifestPath,
      kind: plan.kind,
      provider: plan.provider,
      authMode: "mcp",
      model: plan.model,
      requestKey: plan.requestKey,
      requestId: null,
      reused: false,
      contentDurationSec: plan.contentDurationSec,
      generatedDurationSec,
      loopRequired,
      digest,
      sizeBytes: media.sizeBytes,
      media: { ...media, path: plan.outputPath },
      bgm,
    };
  } finally {
    await generated.cleanup();
    if (!commitAttempted) {
      await Promise.allSettled([
        fs.rm(audioStage, { force: true }),
        fs.rm(manifestStage, { force: true }),
      ]);
    }
  }
}

export async function generatePlannedAudio(
  options: GenerateAudioOptions,
): Promise<AudioGenerationResult> {
  throwIfAborted(options.signal);
  try {
    return await withFileLock(
      generationLockPath(options.plan),
      () => generatePlannedAudioWithLockHeld(options),
      {
        signal: options.signal,
        timeoutMs: AUDIO_GENERATION_LOCK_TIMEOUT_MS,
        staleMs: AUDIO_GENERATION_LOCK_STALE_MS,
      },
    );
  } catch (error) {
    // withFileLock uses AbortError while waiting; keep the public audio command
    // on the CLI's stable cancellation envelope and never enter the paid call.
    if (options.signal?.aborted) throwIfAborted(options.signal);
    throw error;
  }
}
