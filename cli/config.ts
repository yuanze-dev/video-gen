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
import { ProjectConfig, makeDefaultConfig } from "../lib/config-schema";

export type LocalFile = { file: string; mime: string };

export type LoadedConfig = {
  config: ProjectConfig;
  files: Record<string, LocalFile>; // asset id -> local file backing it
};

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".ogg": "audio/ogg",
  ".flac": "audio/flac",
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4v": "video/x-m4v",
};

type MimeClass = "image" | "audio" | "video";

// Where asset refs live inside the config, and what media class each slot
// expects. Checked early so a wrong file type fails with a clear message
// instead of a broken render.
const ASSET_SLOTS: { path: string[]; label: string; expect: MimeClass }[] = [
  { path: ["opening", "curtain", "sfx"], label: "开场音效 opening.curtain.sfx", expect: "audio" },
  { path: ["content", "background"], label: "背景图 content.background", expect: "image" },
  { path: ["content", "mic", "asset"], label: "麦克风图 content.mic.asset", expect: "image" },
  { path: ["content", "device", "asset"], label: "设备图 content.device.asset", expect: "image" },
  {
    path: ["content", "teleprompter", "video", "asset"],
    label: "提词器视频 content.teleprompter.video.asset",
    expect: "video",
  },
  { path: ["content", "bgm", "asset"], label: "背景音乐 content.bgm.asset", expect: "audio" },
  {
    path: ["ending", "video", "asset"],
    label: "片尾视频 ending.video.asset",
    expect: "video",
  },
];

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

function getAt(obj: unknown, keys: string[]): unknown {
  let cur: unknown = obj;
  for (const k of keys) {
    if (!isPlainObject(cur)) return undefined;
    cur = cur[k];
  }
  return cur;
}

function setAt(obj: unknown, keys: string[], value: unknown): void {
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

async function probeVideoDurationSec(file: string): Promise<number> {
  const { getVideoMetadata } = await import("@remotion/renderer");
  const meta = await getVideoMetadata(file, { logLevel: "error" });
  const sec = meta.durationInSeconds;
  if (typeof sec !== "number" || !(sec > 0)) {
    throw new Error("视频元数据中没有有效时长");
  }
  return sec;
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

    const rawPath = ref.path;
    if (typeof rawPath !== "string" || rawPath.length === 0) {
      throw new Error(`${slot.label}: kind 为 "file" 时必须提供 path 字段`);
    }
    const abs = path.resolve(baseDir, rawPath);
    const stat = await fs.stat(abs).catch(() => null);
    if (!stat?.isFile()) {
      throw new Error(`${slot.label}: 文件不存在 — ${abs}`);
    }

    const ext = path.extname(abs).toLowerCase();
    const mime = MIME_BY_EXT[ext];
    if (!mime) {
      throw new Error(
        `${slot.label}: 不支持的文件格式 "${ext}"（支持 ${Object.keys(MIME_BY_EXT).join(" ")}）`,
      );
    }
    if (!mime.startsWith(`${slot.expect}/`)) {
      throw new Error(
        `${slot.label}: 需要${
          { image: "图片", audio: "音频", video: "视频" }[slot.expect]
        }文件，但 "${rawPath}" 是 ${mime}`,
      );
    }

    index += 1;
    const id = assetIdFor(index, abs);
    files[id] = { file: abs, mime };

    // Videos drive a scene's composition length, so a duration is required —
    // probe it unless the caller supplied one explicitly.
    let durationSec = typeof ref.durationSec === "number" ? ref.durationSec : undefined;
    if (slot.expect === "video" && durationSec === undefined) {
      try {
        durationSec = await probeVideoDurationSec(abs);
      } catch (e) {
        throw new Error(
          `${slot.label}: 无法读取视频时长（可在该 asset 上手动指定 durationSec）— ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
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

function formatZodIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  const lines = error.issues.map((i) => `  - ${i.path.join(".") || "(根节点)"}: ${i.message}`);
  return `配置校验失败:\n${lines.join("\n")}`;
}

// Load, merge, rewrite and validate a CLI config file.
export async function loadCliConfig(configPath: string): Promise<LoadedConfig> {
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch {
    throw new Error(`读不到配置文件: ${configPath}`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (e) {
    throw new Error(`配置不是合法 JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!isPlainObject(json)) {
    throw new Error("配置的顶层必须是 JSON 对象");
  }

  const merged = deepMerge(makeDefaultConfig(), json);
  const files = await rewriteFileRefs(merged, path.dirname(path.resolve(configPath)));

  const parsed = ProjectConfig.safeParse(merged);
  if (!parsed.success) {
    throw new Error(formatZodIssues(parsed.error));
  }

  const t = parsed.data.content.teleprompter;
  if (t.mode === "video" && !t.video) {
    throw new Error("teleprompter.mode 为 \"video\" 时必须提供 content.teleprompter.video");
  }
  if (t.mode === "text" && !t.text) {
    throw new Error("teleprompter.mode 为 \"text\" 时必须提供 content.teleprompter.text");
  }

  return { config: parsed.data, files };
}
