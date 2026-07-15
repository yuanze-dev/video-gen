import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { ASSET_SLOTS } from "../lib/asset-registry";
import { ProjectConfig, makeDefaultConfig } from "../lib/config-schema";
import {
  contentFrames,
  contentSec,
  endingFrames,
  endingSec,
  openingFrames,
  openingSec,
  totalFrames,
  totalSec,
} from "../lib/duration";
import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportOptions,
} from "../lib/export-options";
import { resolveConfig } from "../lib/resolved";
import {
  loadCliConfig,
  loadCliConfigText,
  type LoadedConfig,
  type LocalFile,
} from "./config";
import {
  CLI_PACKAGE_NAME,
  TEMPLATE_ID,
  TEMPLATE_VERSION,
  type CliRuntime,
} from "./runtime";
import { CLI_PROTOCOL_VERSION } from "./protocol";

export const MAX_CONFIG_BYTES = 10 * 1024 * 1024;
export const PROJECT_LOCK_VERSION = 1 as const;

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

const ExportOptionsSchema = z
  .object({
    quality: z.enum(["high", "standard", "small"]),
    resolution: z.enum(["1080p", "720p"]),
    fps: z.union([z.literal(30), z.literal(60)]),
  })
  .strict();

const ProjectLockAssetSchema = z
  .object({
    id: z.string().min(1).max(128),
    file: z.string().min(1).max(4096),
    mime: z.string().min(1).max(127),
    sizeBytes: z.number().int().nonnegative(),
    digest: z.string().regex(SHA256_RE),
  })
  .strict();

export const ProjectLockSchema = z
  .object({
    lockVersion: z.literal(PROJECT_LOCK_VERSION),
    protocolVersion: z.literal(CLI_PROTOCOL_VERSION),
    template: z
      .object({
        id: z.literal(TEMPLATE_ID),
        version: z.literal(TEMPLATE_VERSION),
        runtimeDigest: z.string().min(1),
      })
      .strict(),
    createdBy: z
      .object({
        package: z.literal(CLI_PACKAGE_NAME),
        version: z.string().min(1),
      })
      .strict(),
    export: ExportOptionsSchema,
    config: ProjectConfig,
    assets: z.array(ProjectLockAssetSchema),
    digest: z.string().regex(SHA256_RE),
  })
  .strict();

export type ProjectLock = z.infer<typeof ProjectLockSchema>;

export type LoadedProjectInput = LoadedConfig & {
  source: string;
  baseDir: string;
  lock?: ProjectLock;
  lockedExportOptions?: ExportOptions;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAt(value: unknown, keys: readonly string[]): unknown {
  let current = value;
  for (const key of keys) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

function setAt(value: unknown, keys: readonly string[], next: unknown): void {
  let current = value;
  for (const key of keys.slice(0, -1)) {
    if (!isRecord(current)) return;
    current = current[key];
  }
  if (isRecord(current)) current[keys[keys.length - 1]] = next;
}

export function stableStringify(value: unknown, indent = 0): string {
  const normalize = (input: unknown): unknown => {
    if (Array.isArray(input)) return input.map(normalize);
    if (!isRecord(input)) return input;
    return Object.fromEntries(
      Object.keys(input)
        .sort()
        .map((key) => [key, normalize(input[key])]),
    );
  };
  return JSON.stringify(normalize(value), null, indent);
}

export function digestJson(value: unknown): string {
  return `sha256:${crypto.createHash("sha256").update(stableStringify(value)).digest("hex")}`;
}

export async function digestFile(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(`sha256:${hash.digest("hex")}`));
  });
}

async function readFileLimited(file: string): Promise<string> {
  const absolute = path.resolve(file);
  const stat = await fs.stat(absolute).catch(() => null);
  if (!stat?.isFile()) throw new Error(`读不到配置文件: ${absolute}`);
  if (stat.size > MAX_CONFIG_BYTES) {
    throw new Error(`配置文件过大: ${stat.size} bytes（上限 ${MAX_CONFIG_BYTES} bytes）`);
  }
  return fs.readFile(absolute, "utf8");
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  - ${issue.path.join(".") || "(根节点)"}: ${issue.message}`)
    .join("\n");
}

function portableRelative(fromDir: string, target: string): string {
  const relative = path.relative(fromDir, target);
  if (path.isAbsolute(relative)) {
    throw new Error(`素材与锁文件不在同一磁盘，无法生成可移植路径: ${target}`);
  }
  return relative.split(path.sep).join("/") || path.basename(target);
}

function configUploadIds(config: ProjectConfig): Set<string> {
  const ids = new Set<string>();
  for (const slot of ASSET_SLOTS) {
    const value = getAt(config, slot.path);
    if (isRecord(value) && value.kind === "upload" && typeof value.id === "string") {
      ids.add(value.id);
    }
  }
  return ids;
}

async function loadProjectLockText(
  raw: string,
  baseDir: string,
  source: string,
): Promise<LoadedProjectInput> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (error) {
    throw new Error(`${source} 不是合法 JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = ProjectLockSchema.safeParse(json);
  if (!parsed.success) {
    throw new Error(`渲染锁文件校验失败:\n${formatZodError(parsed.error)}`);
  }
  const lock = parsed.data;
  const expectedDigest = digestJson({ ...lock, digest: undefined });
  if (lock.digest !== expectedDigest) {
    throw new Error(`渲染锁文件摘要不匹配（期望 ${expectedDigest}，收到 ${lock.digest}）`);
  }

  const files: Record<string, LocalFile> = {};
  const seen = new Set<string>();
  for (const asset of lock.assets) {
    if (seen.has(asset.id)) throw new Error(`渲染锁文件包含重复素材 id: ${asset.id}`);
    seen.add(asset.id);
    const file = path.resolve(baseDir, asset.file);
    const stat = await fs.stat(file).catch(() => null);
    if (!stat?.isFile()) throw new Error(`锁定素材不存在: ${file}`);
    if (stat.size !== asset.sizeBytes) {
      throw new Error(`锁定素材大小已变化: ${file}（期望 ${asset.sizeBytes}，实际 ${stat.size}）`);
    }
    const actualDigest = await digestFile(file);
    if (actualDigest !== asset.digest) {
      throw new Error(`锁定素材内容已变化: ${file}（摘要不匹配）`);
    }
    files[asset.id] = { file, mime: asset.mime };
  }
  for (const id of configUploadIds(lock.config)) {
    if (!Object.hasOwn(files, id)) throw new Error(`渲染锁缺少 upload 素材: ${id}`);
  }
  for (const id of Object.keys(files)) {
    if (!configUploadIds(lock.config).has(id)) throw new Error(`渲染锁含有未使用素材: ${id}`);
  }
  return {
    config: lock.config,
    files,
    source,
    baseDir,
    lock,
    lockedExportOptions: lock.export,
  };
}

/** Load either a regular partial config or a reproducible `.lock.json`. */
export async function loadProjectInput(
  source: string,
  options: { stdin?: string; cwd?: string } = {},
): Promise<LoadedProjectInput> {
  const cwd = path.resolve(options.cwd ?? process.cwd());
  if (source === "-") {
    if (options.stdin === undefined) throw new Error("配置来源是 -，但没有收到 stdin 内容");
    if (Buffer.byteLength(options.stdin) > MAX_CONFIG_BYTES) {
      throw new Error(`stdin 配置过大（上限 ${MAX_CONFIG_BYTES} bytes）`);
    }
    let value: unknown;
    try {
      value = JSON.parse(options.stdin);
    } catch {
      value = undefined;
    }
    if (isRecord(value) && Object.hasOwn(value, "lockVersion")) {
      return loadProjectLockText(options.stdin, cwd, "stdin 渲染锁");
    }
    const loaded = await loadCliConfigText(options.stdin, { baseDir: cwd, source: "stdin 配置" });
    return { ...loaded, source: "-", baseDir: cwd };
  }

  const absolute = path.resolve(cwd, source);
  const raw = await readFileLimited(absolute);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    value = undefined;
  }
  const baseDir = path.dirname(absolute);
  if (isRecord(value) && Object.hasOwn(value, "lockVersion")) {
    return loadProjectLockText(raw, baseDir, absolute);
  }
  const loaded = await loadCliConfig(absolute);
  return { ...loaded, source: absolute, baseDir };
}

/** Convert internal upload ids back to portable CLI `{kind:"file"}` refs. */
export function configForFileOutput(
  loaded: LoadedConfig,
  outputBaseDir: string,
): unknown {
  const clone = JSON.parse(JSON.stringify(loaded.config)) as unknown;
  for (const slot of ASSET_SLOTS) {
    const value = getAt(clone, slot.path);
    if (!isRecord(value) || value.kind !== "upload" || typeof value.id !== "string") continue;
    const local = loaded.files[value.id];
    if (!local) throw new Error(`${slot.label}: 找不到 upload 素材 ${value.id}`);
    setAt(clone, slot.path, {
      kind: "file",
      path: portableRelative(path.resolve(outputBaseDir), local.file),
      ...(typeof value.durationSec === "number" ? { durationSec: value.durationSec } : {}),
    });
  }
  return clone;
}

export async function createProjectLock(
  loaded: LoadedConfig,
  runtime: CliRuntime,
  options: {
    outputBaseDir?: string;
    exportOptions?: ExportOptions;
  } = {},
): Promise<ProjectLock> {
  const outputBaseDir = path.resolve(options.outputBaseDir ?? process.cwd());
  const assets = [];
  for (const [id, local] of Object.entries(loaded.files).sort(([a], [b]) => a.localeCompare(b))) {
    const stat = await fs.stat(local.file);
    assets.push({
      id,
      file: portableRelative(outputBaseDir, local.file),
      mime: local.mime,
      sizeBytes: stat.size,
      digest: await digestFile(local.file),
    });
  }
  const body = {
    lockVersion: PROJECT_LOCK_VERSION,
    protocolVersion: CLI_PROTOCOL_VERSION,
    template: {
      id: TEMPLATE_ID,
      version: TEMPLATE_VERSION,
      runtimeDigest: runtime.runtimeMetadata.templateDigest,
    },
    createdBy: { package: CLI_PACKAGE_NAME, version: runtime.cliVersion },
    export: options.exportOptions ?? DEFAULT_EXPORT_OPTIONS,
    config: loaded.config,
    assets,
  } as const;
  return ProjectLockSchema.parse({ ...body, digest: digestJson({ ...body, digest: undefined }) });
}

export function makeMinimalConfig(): unknown {
  return {
    version: 1,
    opening: { title: { text: "在这里填写视频标题" } },
    content: {
      teleprompter: {
        mode: "text",
        text: { content: "在这里填写提词文案。" },
      },
    },
  };
}

export type RenderPlan = ReturnType<typeof createRenderPlan>;

export function createRenderPlan(
  loaded: LoadedConfig,
  options: ExportOptions = DEFAULT_EXPORT_OPTIONS,
) {
  const urls = Object.fromEntries(Object.keys(loaded.files).map((id) => [id, `local://${id}`]));
  const base = resolveConfig(loaded.config, urls);
  const resolved = { ...base, canvas: { ...base.canvas, fps: options.fps } };
  const scale = options.resolution === "720p" ? 2 / 3 : 1;
  return {
    template: { id: TEMPLATE_ID, version: TEMPLATE_VERSION },
    export: options,
    output: {
      width: Math.round(resolved.canvas.width * scale),
      height: Math.round(resolved.canvas.height * scale),
      fps: resolved.canvas.fps,
      codec: "h264",
      container: "mp4",
    },
    timeline: {
      opening: { seconds: openingSec(resolved), frames: openingFrames(resolved) },
      content: { seconds: contentSec(resolved), frames: contentFrames(resolved) },
      ending: { seconds: endingSec(resolved), frames: endingFrames(resolved) },
      total: { seconds: totalSec(resolved), frames: totalFrames(resolved) },
    },
    assets: Object.entries(loaded.files).map(([id, file]) => ({ id, ...file })),
  };
}

const FILE_REF_SCHEMA = {
  type: "object",
  properties: {
    kind: { const: "file", type: "string" },
    path: { type: "string", minLength: 1, maxLength: 4096 },
    durationSec: { type: "number", exclusiveMinimum: 0, maximum: 21600 },
  },
  required: ["kind", "path"],
  additionalProperties: false,
} as const;

function adaptSchemaForCliInput(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(adaptSchemaForCliInput);
  if (!isRecord(value)) return value;

  const properties = value.properties;
  const kind = isRecord(properties) && isRecord(properties.kind) ? properties.kind : undefined;
  const enumValues = kind?.enum;
  const isAssetRef =
    value.type === "object" &&
    Array.isArray(enumValues) &&
    enumValues.length === 2 &&
    enumValues.includes("builtin") &&
    enumValues.includes("upload");
  if (isAssetRef) {
    const resolved = Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, adaptSchemaForCliInput(entry)]),
    );
    return { oneOf: [resolved, FILE_REF_SCHEMA] };
  }

  const adapted = Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => key !== "required")
      .map(([key, entry]) => [key, adaptSchemaForCliInput(entry)]),
  );
  return adapted;
}

/** JSON Schema for the actual partial CLI input, including local file refs. */
export function getCliConfigJsonSchema(): unknown {
  const resolvedSchema = z.toJSONSchema(ProjectConfig);
  const schema = adaptSchemaForCliInput(resolvedSchema) as Record<string, unknown>;
  return {
    ...schema,
    $id: "https://yuanze.dev/schemas/littlestart/teleprompter-v1.json",
    title: "LittleStart teleprompter CLI config",
    description:
      "Partial configuration accepted by littlestart. Missing fields inherit template defaults; asset references are atomic and must be complete.",
  };
}

export async function writeFileAtomic(
  target: string,
  contents: string,
  overwrite = false,
): Promise<string> {
  const absolute = path.resolve(target);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  const partial = path.join(
    path.dirname(absolute),
    `.${path.basename(absolute)}.${process.pid}-${crypto.randomBytes(8).toString("hex")}.partial`,
  );
  let backup: string | undefined;
  let preserveBackup = false;
  try {
    const handle = await fs.open(partial, "wx", 0o600);
    try {
      await handle.writeFile(contents);
      await handle.sync();
    } finally {
      await handle.close();
    }

    const existing = await fs.lstat(absolute).catch(() => null);
    if (existing?.isDirectory()) throw new Error(`输出路径是目录: ${absolute}`);
    if (existing && !overwrite) throw new Error(`输出文件已存在: ${absolute}（使用 --force 覆盖）`);
    if (existing) {
      backup = `${partial}.backup`;
      await fs.rename(absolute, backup);
    }
    try {
      await fs.rename(partial, absolute);
    } catch (error) {
      if (backup) {
        try {
          await fs.rename(backup, absolute);
          backup = undefined;
        } catch (restoreError) {
          preserveBackup = true;
          throw new Error(
            `替换输出文件失败，且自动恢复原文件失败。原文件备份仍保留在 ${backup}；请手动将其移动回 ${absolute}。替换错误: ${error instanceof Error ? error.message : String(error)}；恢复错误: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    if (backup) {
      await fs.rm(backup, { force: true });
      backup = undefined;
    }
    return absolute;
  } finally {
    await fs.rm(partial, { force: true }).catch(() => {});
    if (backup && !preserveBackup) await fs.rm(backup, { force: true }).catch(() => {});
  }
}

export async function writeJsonAtomic(
  target: string,
  value: unknown,
  overwrite = false,
): Promise<string> {
  return writeFileAtomic(target, `${stableStringify(value, 2)}\n`, overwrite);
}

export function defaultConfig(): ProjectConfig {
  return makeDefaultConfig();
}
