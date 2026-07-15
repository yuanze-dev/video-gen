// CLI-side config handling for the local render CLI.
//
// The CLI accepts a *partial* ProjectConfig: the input JSON is deep-merged over
// the app's default config, so callers (humans or AI) only write the fields
// they want to change. Asset references gain one extra form —
// `{ "kind": "file", "path": "./bg.jpg" }` — so local files can be used
// directly. File refs are registered and rewritten to standard
// `{ kind: "upload", id }` refs before zod validation, which keeps the render
// pipeline downstream byte-identical to the web/Electron paths.
import path from "node:path";
import fs from "node:fs/promises";
import { z } from "zod";
import {
  ASSET_MEDIA_TYPE_LABELS,
  ASSET_SLOTS,
  mediaTypeForMime,
  type AssetMediaType,
} from "../lib/asset-registry";
import {
  MAX_ASSET_DURATION_SEC,
  ProjectConfig,
  makeDefaultConfig,
  type AssetRef,
} from "../lib/config-schema";

export type LocalFile = { file: string; mime: string };

export type LoadedConfig = {
  config: ProjectConfig;
  files: Record<string, LocalFile>; // asset id -> local file backing it
};

export const CLI_MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

const LocalFileRef = z
  .object({
    kind: z.literal("file"),
    path: z
      .string()
      .trim()
      .min(1, { message: 'kind 为 "file" 时 path 不能为空' })
      .max(4096, { message: "素材路径不能超过 4096 个字符" }),
    durationSec: z
      .number()
      .positive({ message: "durationSec 必须大于 0" })
      .max(MAX_ASSET_DURATION_SEC, {
        message: `durationSec 不能超过 ${MAX_ASSET_DURATION_SEC} 秒`,
      })
      .optional(),
  })
  .strict();

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Deep-merge `patch` over `base`. Objects merge recursively; primitives,
// arrays and null replace. Asset references (any object carrying a `kind`
// field) replace wholesale so a `file`/`builtin` patch never inherits stale
// fields (e.g. a leftover builtin id) from the default config.
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  if ("kind" in patch) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    out[k] = k in out ? deepMerge(out[k], v) : v;
  }
  return out;
}

function getAt(obj: unknown, keys: readonly string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAt(obj: unknown, keys: readonly string[], value: unknown): void {
  let cur: unknown = obj;
  for (const k of keys.slice(0, -1)) {
    if (!isPlainObject(cur)) return;
    cur = cur[k];
  }
  if (isPlainObject(cur)) cur[keys[keys.length - 1]] = value;
}

function assetIdFor(index: number, filePath: string): string {
  const base = path.basename(filePath).replace(/[^A-Za-z0-9_.-]/g, "-");
  return `f${index}-${base}`.slice(0, 128);
}

function detectImageMime(bytes: Uint8Array): string | undefined {
  if (bytes.length >= 12) {
    const ascii = (start: number, end: number) =>
      String.fromCharCode(...bytes.subarray(start, end));
    if (
      bytes[0] === 0x89 &&
      ascii(1, 4) === "PNG" &&
      bytes[4] === 0x0d &&
      bytes[5] === 0x0a &&
      bytes[6] === 0x1a &&
      bytes[7] === 0x0a
    ) {
      return "image/png";
    }
    if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
      return "image/jpeg";
    }
    if (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a") {
      return "image/gif";
    }
    if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
      return "image/webp";
    }
  }
  return undefined;
}

async function inspectImage(file: string): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const bytes = new Uint8Array(32);
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    const mime = detectImageMime(bytes.subarray(0, bytesRead));
    if (!mime) throw new Error("文件头不是可识别的 PNG、JPEG、WebP 或 GIF");
    return mime;
  } finally {
    await handle.close();
  }
}

const CONTAINER_BY_EXT: Record<string, readonly string[]> = {
  ".mp3": ["mp3"],
  ".wav": ["wav"],
  ".m4a": ["mp4"],
  ".aac": ["aac"],
  ".flac": ["flac"],
  ".mp4": ["mp4"],
  ".mov": ["mp4"],
  ".webm": ["webm"],
  ".m4v": ["mp4"],
};

type InspectedMedia = {
  mediaType: AssetMediaType;
  durationSec?: number;
};

async function inspectAudioOrVideo(file: string): Promise<InspectedMedia & { container: string }> {
  const { parseMedia } = await import("@remotion/media-parser");
  const { nodeReader } = await import("@remotion/media-parser/node");
  const parsed = await parseMedia({
    src: file,
    reader: nodeReader,
    fields: {
      container: true,
      durationInSeconds: true,
      tracks: true,
    },
    acknowledgeRemotionLicense: true,
    logLevel: "error",
  });

  const hasVideo = parsed.tracks.some((track) => track.type === "video");
  const hasAudio = parsed.tracks.some((track) => track.type === "audio");
  if (!hasVideo && !hasAudio) {
    throw new Error("媒体容器中没有可用的音频或视频轨道");
  }

  const duration = parsed.durationInSeconds;
  return {
    container: parsed.container,
    mediaType: hasVideo ? "video" : "audio",
    ...(typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? { durationSec: duration }
      : {}),
  };
}

async function inspectLocalMedia(
  file: string,
  ext: string,
  declaredMime: string,
  expected: AssetMediaType,
): Promise<InspectedMedia> {
  const declaredType = mediaTypeForMime(declaredMime);
  if (declaredType !== expected) {
    throw new Error(
      `需要${ASSET_MEDIA_TYPE_LABELS[expected]}文件，但扩展名 "${ext}" 表示${
        ASSET_MEDIA_TYPE_LABELS[declaredType ?? "image"]
      }文件`,
    );
  }

  if (expected === "image") {
    const actualMime = await inspectImage(file);
    if (actualMime !== declaredMime) {
      throw new Error(
        `扩展名 "${ext}" 与文件内容不一致（实际是 ${actualMime}）`,
      );
    }
    return { mediaType: "image" };
  }

  const inspected = await inspectAudioOrVideo(file);
  if (inspected.mediaType !== expected) {
    throw new Error(
      `需要${ASSET_MEDIA_TYPE_LABELS[expected]}文件，但实际媒体内容是${ASSET_MEDIA_TYPE_LABELS[inspected.mediaType]}`,
    );
  }

  const allowedContainers = CONTAINER_BY_EXT[ext];
  if (!allowedContainers?.includes(inspected.container)) {
    throw new Error(
      `扩展名 "${ext}" 与实际媒体容器 ${inspected.container} 不一致`,
    );
  }
  return inspected;
}

// Rewrite `{kind:"file"}` refs in-place (on the freshly merged object) into
// `{kind:"upload"}` refs, collecting the backing files. Returns the file map.
async function rewriteFileRefs(
  merged: unknown,
  baseDir: string,
): Promise<Record<string, LocalFile>> {
  const files: Record<string, LocalFile> = {};
  let index = 0;

  for (const slot of ASSET_SLOTS) {
    const ref = getAt(merged, slot.path);
    if (!isPlainObject(ref) || ref.kind !== "file") continue;

    const localRef = LocalFileRef.safeParse(ref);
    if (!localRef.success) {
      throw configValidationErrorFromZod(localRef.error, slot.path);
    }
    const rawPath = localRef.data.path;
    const abs = path.resolve(baseDir, rawPath);
    let stat;
    try {
      stat = await fs.stat(abs);
    } catch (error) {
      const detail = error instanceof Error ? `（${error.message}）` : "";
      throw new Error(`${slot.label}: 无法访问文件 — ${abs}${detail}`);
    }
    if (!stat?.isFile()) {
      throw new Error(`${slot.label}: 路径不是普通文件 — ${abs}`);
    }

    const ext = path.extname(abs).toLowerCase();
    const mime = CLI_MIME_BY_EXTENSION[ext];
    if (!mime) {
      throw new Error(
        `${slot.label}: 不支持的文件格式 "${ext}"（支持 ${Object.keys(CLI_MIME_BY_EXTENSION).join(" ")}）`,
      );
    }

    let inspected: InspectedMedia;
    try {
      inspected = await inspectLocalMedia(abs, ext, mime, slot.mediaType);
    } catch (error) {
      throw new Error(
        `${slot.label}: 媒体校验失败 — ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    index += 1;
    const id = assetIdFor(index, abs);
    files[id] = { file: abs, mime };

    // Parsed metadata is authoritative. A caller-provided duration remains a
    // fallback for containers where the parser can validate tracks but cannot
    // determine the duration.
    const durationSec = inspected.durationSec ?? localRef.data.durationSec;
    if (slot.mediaType === "video" && durationSec === undefined) {
      throw new Error(
        `${slot.label}: 视频媒体中没有可用时长，请在该素材上提供 durationSec`,
      );
    }

    setAt(merged, slot.path, {
      kind: "upload",
      id,
      mime,
      ...(durationSec !== undefined ? { durationSec } : {}),
    });
  }

  return files;
}

export type InspectedCliAsset = InspectedMedia & {
  file: string;
  mime: string;
  sizeBytes: number;
};

/** Validate a standalone local asset using the same rules as config loading. */
export async function inspectCliAsset(filePath: string): Promise<InspectedCliAsset> {
  const file = path.resolve(filePath);
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) throw new Error(`素材文件不存在: ${file}`);
  if (stat.size === 0) throw new Error(`素材文件为空: ${file}`);
  const ext = path.extname(file).toLowerCase();
  const mime = CLI_MIME_BY_EXTENSION[ext];
  if (!mime) {
    throw new Error(
      `不支持的素材格式 "${ext}"（支持 ${Object.keys(CLI_MIME_BY_EXTENSION).join(" ")}）`,
    );
  }
  const mediaType = mediaTypeForMime(mime);
  if (!mediaType) throw new Error(`无法识别素材 MIME: ${mime}`);
  const inspected = await inspectLocalMedia(file, ext, mime, mediaType);
  return { file, mime, sizeBytes: stat.size, ...inspected };
}

function formatPath(parts: readonly PropertyKey[]): string {
  return parts.length > 0 ? parts.map(String).join(".") : "(根节点)";
}

type FormattableIssue = {
  path: PropertyKey[];
  message: string;
  code?: unknown;
  expected?: unknown;
  values?: unknown;
  keys?: unknown;
};

function localizeZodMessage(issue: FormattableIssue): string {
  if (issue.code === "invalid_type") {
    return `值类型不正确${typeof issue.expected === "string" ? `，应为 ${issue.expected}` : ""}`;
  }
  if (issue.code === "invalid_value") {
    const values = Array.isArray(issue.values) ? issue.values.map(String).join(" | ") : "";
    return values ? `值不受支持，可选值为 ${values}` : "值不受支持";
  }
  return issue.message;
}

/** A stable, protocol-friendly representation of one config validation failure. */
export type CliConfigValidationIssue = Readonly<{
  path: string;
  message: string;
  code: string;
}>;

function formatConfigValidationIssues(
  issues: readonly CliConfigValidationIssue[],
): string {
  const lines = issues.map((issue) => `  - ${issue.path}: ${issue.message}`);
  return `配置校验失败:\n${lines.join("\n")}`;
}

/**
 * A Zod-backed config error that keeps the existing human-readable message
 * while exposing individual issues for JSON output and automation.
 */
export class CliConfigValidationError extends Error {
  readonly issues: readonly CliConfigValidationIssue[];
  override readonly cause?: unknown;

  constructor(
    issues: readonly CliConfigValidationIssue[],
    options: { cause?: unknown } = {},
  ) {
    const stableIssues = Object.freeze(
      issues.map((issue) => Object.freeze({ ...issue })),
    );
    super(formatConfigValidationIssues(stableIssues));
    this.name = "CliConfigValidationError";
    this.issues = stableIssues;
    this.cause = options.cause;
  }
}

export function isCliConfigValidationError(
  value: unknown,
): value is CliConfigValidationError {
  return value instanceof CliConfigValidationError;
}

function configValidationErrorFromZod(
  error: { issues: FormattableIssue[] },
  prefix: readonly PropertyKey[] = [],
): CliConfigValidationError {
  const issues = error.issues.flatMap<CliConfigValidationIssue>((issue) => {
    const code = typeof issue.code === "string" && issue.code !== ""
      ? issue.code
      : "custom";
    if (issue.code === "unrecognized_keys" && Array.isArray(issue.keys)) {
      return issue.keys.map(
        (key) => ({
          path: formatPath([...prefix, ...issue.path, String(key)]),
          message: `未知字段 "${String(key)}"`,
          code,
        }),
      );
    }
    return [
      {
        path: formatPath([...prefix, ...issue.path]),
        message: localizeZodMessage(issue),
        code,
      },
    ];
  });
  return new CliConfigValidationError(issues, { cause: error });
}

function assertUploadBackings(
  config: ProjectConfig,
  files: Record<string, LocalFile>,
): void {
  for (const slot of ASSET_SLOTS) {
    const value = getAt(config, slot.path);
    if (!value || typeof value !== "object" || !("kind" in value)) continue;
    const ref = value as AssetRef;
    if (ref.kind === "upload" && !Object.hasOwn(files, ref.id)) {
      throw new Error(
        `${slot.label}: upload 素材 "${ref.id}" 没有本地文件。CLI 中请使用 {"kind":"file","path":"..."}，不能直接复用 GUI 的临时 upload id`,
      );
    }
  }
}

export type LoadCliConfigTextOptions = {
  /** Base directory used to resolve `{kind:"file",path}` references. */
  baseDir?: string;
  /** Human-readable source label used in diagnostics. */
  source?: string;
};

/** Parse a config supplied by stdin or another in-memory automation source. */
export async function loadCliConfigText(
  raw: string,
  options: LoadCliConfigTextOptions = {},
): Promise<LoadedConfig> {
  const source = options.source ?? "配置";
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`${source}不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(json)) {
    throw new Error(`${source}的顶层必须是 JSON 对象`);
  }

  const merged = deepMerge(makeDefaultConfig(), json);
  const files = await rewriteFileRefs(merged, path.resolve(options.baseDir ?? process.cwd()));

  const parsed = ProjectConfig.safeParse(merged);
  if (!parsed.success) {
    throw configValidationErrorFromZod(parsed.error);
  }
  assertUploadBackings(parsed.data, files);

  return { config: parsed.data, files };
}

// Load, merge, rewrite and validate a CLI config file.
export async function loadCliConfig(configPath: string): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    const detail = error instanceof Error ? `（${error.message}）` : "";
    throw new Error(`读不到配置文件: ${configPath}${detail}`);
  }
  return loadCliConfigText(raw, {
    baseDir: path.dirname(path.resolve(configPath)),
    source: `配置文件 ${configPath}`,
  });
}
