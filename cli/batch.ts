import crypto from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type {
  ExportFps,
  ExportOptions,
  ExportQuality,
  ExportResolution,
} from "../lib/export-options";
import { withFileLock } from "./cache";

const MAX_BATCH_JOBS = 10_000;
const DEFAULT_CONCURRENCY = 1;
const MAX_CONCURRENCY = 32;
export const MAX_BATCH_MANIFEST_BYTES = 10 * 1024 * 1024;
export const BATCH_LOCK_FILENAME = ".littlestart-batch.lock";
export const BATCH_LOCK_STALE_MS = 5 * 60 * 1000;
const BATCH_LOCK_RECOVERY_FILENAME = ".littlestart-batch.lock.recovery";
const BATCH_LOCK_POLL_MS = 100;
const JOURNAL_VERSION = 1 as const;

const BatchExportOptionsSchema = z
  .object({
    quality: z.enum(["high", "standard", "small"]).optional(),
    resolution: z.enum(["1080p", "720p"]).optional(),
    fps: z.union([z.literal(30), z.literal(60)]).optional(),
  })
  .strict();

const BatchJobSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .max(64)
      .regex(
        /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,63})$/,
        "id 只能包含字母、数字、点、下划线和连字符，并且必须以字母或数字开头",
      )
      .refine((value) => value !== "." && value !== "..", "id 不能是 . 或 .."),
    config: z.string().trim().min(1).max(4096),
    out: z.string().trim().min(1).max(4096).optional(),
    cover: z.string().trim().min(1).max(4096).optional(),
    options: BatchExportOptionsSchema.optional(),
  })
  .strict();

export const BatchManifestSchema = z
  .object({
    version: z.literal(1),
    defaults: BatchExportOptionsSchema.optional(),
    jobs: z.array(BatchJobSchema).min(1).max(MAX_BATCH_JOBS),
  })
  .strict();

export type BatchExportOptions = {
  quality?: ExportQuality;
  resolution?: ExportResolution;
  fps?: ExportFps;
};

export type BatchManifestJob = {
  id: string;
  config: string;
  out?: string;
  cover?: string;
  options?: BatchExportOptions;
};

export type BatchManifest = {
  version: 1;
  defaults?: BatchExportOptions;
  jobs: BatchManifestJob[];
};

export type PreparedBatchJob = {
  readonly index: number;
  readonly id: string;
  readonly manifestPath: string;
  readonly configPath: string;
  readonly outDir: string;
  readonly outputPath: string;
  readonly outputRelativePath: string;
  readonly coverPath?: string;
  readonly coverRelativePath?: string;
  readonly options: ExportOptions;
  /** Export fields explicitly supplied by manifest defaults or this job. */
  readonly exportOverrideKeys: readonly (keyof ExportOptions)[];
};

/**
 * The validator returns its already-loaded value for renderOne and explicitly
 * lists local assets whose bytes affect the render. This keeps the batch core
 * independent of the current config/runtime implementation while making
 * resume content-correct.
 */
export type BatchValidation<TValidated> = {
  readonly value: TValidated;
  readonly localAssetPaths?: readonly string[];
};

export type BatchValidationContext = {
  readonly signal?: AbortSignal;
};

export type BatchRenderContext = {
  readonly signal?: AbortSignal;
  /** The caller authorized replacing pre-existing, non-resumable artifacts. */
  readonly overwrite: boolean;
  readonly reportProgress: (
    ratio: number,
    detail?: Readonly<Record<string, unknown>>,
  ) => void;
};

export type BatchErrorInfo = {
  readonly name: string;
  readonly message: string;
  readonly code?: string;
};

export type BatchJobStatus = "succeeded" | "failed" | "skipped" | "cancelled";

export type BatchJobResult<TResult = unknown> = {
  readonly index: number;
  readonly id: string;
  readonly status: BatchJobStatus;
  readonly fingerprint: string;
  readonly outputPath: string;
  readonly coverPath?: string;
  readonly startedAt?: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly result?: TResult;
  readonly error?: BatchErrorInfo;
};

export type BatchSummary<TResult = unknown> = {
  readonly manifestPath: string;
  readonly outDir: string;
  readonly journalPath: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly cancelled: number;
  readonly partial: boolean;
  readonly interrupted: boolean;
  readonly jobs: readonly BatchJobResult<TResult>[];
};

type BatchEventBase = {
  readonly timestamp: string;
};

export type BatchEvent<TResult = unknown> =
  | (BatchEventBase & {
      readonly event: "preflight-started";
      readonly total: number;
    })
  | (BatchEventBase & {
      readonly event: "preflight-completed";
      readonly total: number;
    })
  | (BatchEventBase & {
      readonly event: "batch-started";
      readonly total: number;
      readonly concurrency: number;
      readonly resume: boolean;
    })
  | (BatchEventBase & {
      readonly event: "job-started";
      readonly id: string;
      readonly index: number;
    })
  | (BatchEventBase & {
      readonly event: "job-progress";
      readonly id: string;
      readonly index: number;
      readonly ratio: number;
      readonly detail?: Readonly<Record<string, unknown>>;
    })
  | (BatchEventBase & {
      readonly event: "job-finished";
      readonly job: BatchJobResult<TResult>;
      readonly completed: number;
      readonly total: number;
    })
  | (BatchEventBase & {
      readonly event: "batch-finished";
      readonly summary: BatchSummary<TResult>;
    });

export type RunBatchOptions<TValidated, TResult = unknown> = {
  /** Virtual path used as the base for relative configs and journal metadata. */
  readonly manifestPath: string;
  /** Optional manifest contents, used for stdin without creating a temp file. */
  readonly manifestText?: string;
  readonly outDir: string;
  readonly concurrency?: number;
  readonly resume?: boolean;
  /**
   * Allow rendering over artifacts that exist but do not exactly match a
   * resumable journal record. Defaults to false and is checked for every job
   * before any render starts.
   */
  readonly overwrite?: boolean;
  /** Defaults to `<outDir>/.littlestart-batch-state.json`. */
  readonly journalPath?: string;
  readonly signal?: AbortSignal;
  readonly defaultExportOptions?: ExportOptions;
  /** Included in resume fingerprints (for example runtime digest + CLI version). */
  readonly fingerprintSalt?: string;
  readonly validateOne: (
    job: PreparedBatchJob,
    context: BatchValidationContext,
  ) => Promise<BatchValidation<TValidated>>;
  readonly renderOne: (
    job: PreparedBatchJob,
    validated: TValidated,
    context: BatchRenderContext,
  ) => Promise<TResult>;
  /** Receives JSON-safe progress objects suitable for an NDJSON emitter. */
  readonly onEvent?: (event: BatchEvent<TResult>) => void;
  /** Injectable clock for tests and deterministic integrations. */
  readonly now?: () => Date;
};

export type BatchPreflightIssue = {
  readonly index?: number;
  readonly id?: string;
  readonly path?: string;
  readonly message: string;
  readonly code?: string;
};

export class BatchManifestError extends Error {
  readonly issues: readonly BatchPreflightIssue[];

  constructor(message: string, issues: readonly BatchPreflightIssue[] = []) {
    super(message);
    this.name = "BatchManifestError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export class BatchPreflightError extends Error {
  readonly issues: readonly BatchPreflightIssue[];

  constructor(issues: readonly BatchPreflightIssue[]) {
    super(`批处理预检失败（${issues.length} 项）`);
    this.name = "BatchPreflightError";
    this.issues = Object.freeze(issues.map((issue) => Object.freeze({ ...issue })));
  }
}

export class BatchJournalError extends Error {
  override readonly cause?: unknown;

  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "BatchJournalError";
    this.cause = cause;
  }
}

/** Optional adapter for callers that prefer exception-based partial failure. */
export class BatchPartialFailureError<TResult = unknown> extends Error {
  readonly summary: BatchSummary<TResult>;

  constructor(summary: BatchSummary<TResult>) {
    super(
      `批处理未全部成功：${summary.failed} 项失败，${summary.cancelled} 项取消`,
    );
    this.name = "BatchPartialFailureError";
    this.summary = summary;
  }
}

type JournalJob = {
  fingerprint: string;
  status: "succeeded" | "failed" | "cancelled";
  outputRelativePath: string;
  coverRelativePath?: string;
  /**
   * Optional only for backwards compatibility with journal v1 records written
   * before artifact integrity was recorded. A succeeded record without this
   * block is deliberately not resumable and will be rendered again.
   */
  artifacts?: JournalArtifacts;
  updatedAt: string;
  error?: BatchErrorInfo;
};

type JournalArtifactIntegrity = {
  sizeBytes: number;
  sha256: string;
};

type JournalArtifacts = {
  output: JournalArtifactIntegrity;
  cover?: JournalArtifactIntegrity;
};

type BatchJournal = {
  version: typeof JOURNAL_VERSION;
  manifestPath: string;
  manifestHash: string;
  updatedAt: string;
  jobs: Record<string, JournalJob>;
};

const BatchErrorInfoSchema = z
  .object({
    name: z.string(),
    message: z.string(),
    code: z.string().optional(),
  })
  .strict();

const JournalArtifactIntegritySchema = z
  .object({
    sizeBytes: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const JournalArtifactsSchema = z
  .object({
    output: JournalArtifactIntegritySchema,
    cover: JournalArtifactIntegritySchema.optional(),
  })
  .strict();

const BatchJournalSchema = z
  .object({
    version: z.literal(JOURNAL_VERSION),
    manifestPath: z.string(),
    manifestHash: z.string().regex(/^[a-f0-9]{64}$/),
    updatedAt: z.string(),
    jobs: z.record(
      z.string(),
      z
        .object({
          fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          status: z.enum(["succeeded", "failed", "cancelled"]),
          outputRelativePath: z.string(),
          coverRelativePath: z.string().optional(),
          // Kept optional so a valid legacy v1 journal can be loaded safely.
          // Missing integrity never authorizes a skip (see artifactsMatch).
          artifacts: JournalArtifactsSchema.optional(),
          updatedAt: z.string(),
          error: BatchErrorInfoSchema.optional(),
        })
        .strict(),
    ),
  })
  .strict();

type ValidatedJob<TValidated> = {
  job: PreparedBatchJob;
  validation: BatchValidation<TValidated>;
  fingerprint: string;
};

const DEFAULT_EXPORT_OPTIONS: ExportOptions = {
  quality: "high",
  resolution: "1080p",
  fps: 60,
};

function errorInfo(error: unknown): BatchErrorInfo {
  if (error instanceof Error) {
    const code = (error as Error & { code?: unknown }).code;
    return {
      name: error.name || "Error",
      message: error.message || "未知错误",
      ...(typeof code === "string" || typeof code === "number"
        ? { code: String(code) }
        : {}),
    };
  }
  return { name: "Error", message: typeof error === "string" ? error : "未知错误" };
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === "AbortError") ||
    (error instanceof Error && error.name === "AbortError")
  );
}

function abortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  const error = new Error(
    reason instanceof Error
      ? reason.message
      : typeof reason === "string" && reason.trim()
        ? reason
        : "批处理已取消",
    reason === undefined ? undefined : { cause: reason },
  );
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function timeMs(now: () => Date): number {
  return now().getTime();
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function portableSegments(value: string): string[] {
  if (value.includes("\0")) throw new Error("路径不能包含 NUL 字符");
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("必须使用相对于输出目录的路径");
  }
  const segments = value.replaceAll("\\", "/").split("/");
  if (segments.some((segment) => segment === "..")) {
    throw new Error("路径不能包含 ..");
  }
  const meaningful = segments.filter((segment) => segment !== "" && segment !== ".");
  if (meaningful.length === 0) throw new Error("路径必须指向文件");
  for (const segment of meaningful) {
    if (/[-<>:"|?*]/.test(segment)) {
      throw new Error(`路径片段包含跨平台不支持的字符: ${segment}`);
    }
    if (/[. ]$/.test(segment)) {
      throw new Error(`路径片段不能以点或空格结尾: ${segment}`);
    }
    const windowsStem = segment.split(".", 1)[0].toUpperCase();
    if (/^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(windowsStem)) {
      throw new Error(`路径片段是 Windows 保留名称: ${segment}`);
    }
  }
  return meaningful;
}

function resolveOutputPath(outDir: string, value: string): { absolute: string; relative: string } {
  const segments = portableSegments(value);
  const absolute = path.resolve(outDir, ...segments);
  if (!isWithin(outDir, absolute) || absolute === outDir) {
    throw new Error("输出路径逃逸了输出目录");
  }
  return { absolute, relative: path.relative(outDir, absolute) };
}

function outputCollisionKey(relative: string): string {
  const normalized = path.normalize(relative);
  return process.platform === "win32" || process.platform === "darwin"
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

async function nearestExistingPath(candidate: string): Promise<string> {
  let current = candidate;
  for (;;) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertNoSymlinkEscape(realOutDir: string, candidate: string): Promise<void> {
  const existing = await nearestExistingPath(candidate);
  const realExisting = await fs.realpath(existing);
  if (!isWithin(realOutDir, realExisting)) {
    throw new Error("输出路径经过符号链接逃逸了输出目录");
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

async function hashFile(hash: crypto.Hash, file: string, label: string): Promise<void> {
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error(`${label} 不是普通文件: ${file}`);
  hash.update(label);
  hash.update("\0");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  hash.update("\0");
}

async function fingerprintJob<TValidated>(
  manifest: BatchManifest,
  manifestDir: string,
  manifestJob: BatchManifestJob,
  job: PreparedBatchJob,
  validation: BatchValidation<TValidated>,
  fingerprintSalt: string | undefined,
): Promise<string> {
  const hash = crypto.createHash("sha256");
  // Hash semantic manifest content so whitespace-only edits do not invalidate
  // every completed render.
  hash.update(
    stableJson({
      version: manifest.version,
      defaults: manifest.defaults,
      job: manifestJob,
      effectiveExportOptions: job.options,
      fingerprintSalt: fingerprintSalt ?? "",
    }),
  );
  hash.update("\0");
  await hashFile(hash, job.configPath, `config:${manifestJob.config}`);

  const assets = [...new Set(validation.localAssetPaths ?? [])]
    .map((asset) => path.resolve(asset))
    .sort((left, right) => left.localeCompare(right));
  for (const asset of assets) {
    const label = path.relative(manifestDir, asset).split(path.sep).join("/");
    await hashFile(hash, asset, `asset:${label}`);
  }
  return hash.digest("hex");
}

function manifestHash(manifest: BatchManifest): string {
  return crypto.createHash("sha256").update(stableJson(manifest)).digest("hex");
}

async function readManifest(file: string, providedText?: string): Promise<BatchManifest> {
  let text: string;
  if (providedText !== undefined) {
    const bytes = Buffer.byteLength(providedText, "utf8");
    if (bytes > MAX_BATCH_MANIFEST_BYTES) {
      throw new BatchManifestError(
        `批处理清单超过 ${MAX_BATCH_MANIFEST_BYTES} bytes 上限`,
        [{ path: file, message: `收到 ${bytes} bytes`, code: "MANIFEST_TOO_LARGE" }],
      );
    }
    text = providedText;
  } else {
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of createReadStream(file)) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BATCH_MANIFEST_BYTES) {
          throw new BatchManifestError(
            `批处理清单超过 ${MAX_BATCH_MANIFEST_BYTES} bytes 上限`,
            [{ path: file, message: `至少 ${bytes} bytes`, code: "MANIFEST_TOO_LARGE" }],
          );
        }
        chunks.push(buffer);
      }
      text = Buffer.concat(chunks).toString("utf8");
    } catch (error) {
      if (error instanceof BatchManifestError) throw error;
      throw new BatchManifestError(`无法读取批处理清单: ${file}`, [
        { path: file, message: errorInfo(error).message, code: errorInfo(error).code },
      ]);
    }
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text) as unknown;
  } catch (error) {
    throw new BatchManifestError(`批处理清单不是有效 JSON: ${file}`, [
      { path: file, message: errorInfo(error).message },
    ]);
  }

  const parsed = BatchManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues: BatchPreflightIssue[] = [];
    for (const issue of parsed.error.issues) {
      const basePath = issue.path.map(String).join(".");
      if (issue.code === "unrecognized_keys") {
        for (const key of issue.keys) {
          issues.push({
            path: basePath ? `${basePath}.${key}` : key,
            message: `未知字段: ${key}`,
            code: issue.code,
          });
        }
      } else {
        issues.push({ path: basePath, message: issue.message, code: issue.code });
      }
    }
    throw new BatchManifestError(
      `批处理清单格式无效: ${file}`,
      issues,
    );
  }
  return parsed.data as BatchManifest;
}

function mergeOptions(
  base: ExportOptions,
  defaults: BatchExportOptions | undefined,
  job: BatchExportOptions | undefined,
): ExportOptions {
  return {
    quality: job?.quality ?? defaults?.quality ?? base.quality,
    resolution: job?.resolution ?? defaults?.resolution ?? base.resolution,
    fps: job?.fps ?? defaults?.fps ?? base.fps,
  };
}

function exportOverrideKeys(
  defaults: BatchExportOptions | undefined,
  job: BatchExportOptions | undefined,
): readonly (keyof ExportOptions)[] {
  return (["quality", "resolution", "fps"] as const).filter(
    (key) => job?.[key] !== undefined || defaults?.[key] !== undefined,
  );
}

async function prepareJobs(
  manifestPath: string,
  outDir: string,
  manifest: BatchManifest,
  defaultExportOptions: ExportOptions,
  journalPath: string,
  lockPath: string,
  recoveryPath: string,
): Promise<PreparedBatchJob[]> {
  const manifestDir = path.dirname(manifestPath);
  const seenIds = new Map<string, number>();
  const seenOutputs = new Map<string, { index: number; id: string; kind: string }>();
  const issues: BatchPreflightIssue[] = [];
  const jobs: PreparedBatchJob[] = [];
  const realOutDir = await fs.realpath(outDir);
  const reservedOutputs = new Map(
    [
      [journalPath, "批处理状态文件"],
      [lockPath, "批处理锁文件"],
      [recoveryPath, "批处理锁恢复路径"],
    ].map(([file, label]) => [
      outputCollisionKey(path.relative(outDir, path.resolve(file))),
      label,
    ]),
  );

  for (const [index, item] of manifest.jobs.entries()) {
    const previousId = seenIds.get(item.id);
    if (previousId !== undefined) {
      issues.push({
        index,
        id: item.id,
        path: `jobs.${index}.id`,
        message: `id 与 jobs.${previousId}.id 重复`,
        code: "DUPLICATE_ID",
      });
    } else {
      seenIds.set(item.id, index);
    }

    let output: { absolute: string; relative: string } | undefined;
    let cover: { absolute: string; relative: string } | undefined;
    try {
      output = resolveOutputPath(outDir, item.out ?? `${item.id}.mp4`);
      await assertNoSymlinkEscape(realOutDir, output.absolute);
      if (path.extname(output.relative).toLowerCase() !== ".mp4") {
        issues.push({
          index,
          id: item.id,
          path: `jobs.${index}.out`,
          message: `视频输出扩展名必须是 .mp4，收到 ${path.extname(output.relative) || "(无扩展名)"}`,
          code: "INVALID_OUTPUT_EXTENSION",
        });
      }
    } catch (error) {
      issues.push({
        index,
        id: item.id,
        path: `jobs.${index}.out`,
        message: errorInfo(error).message,
        code: "OUTPUT_TRAVERSAL",
      });
    }
    if (item.cover) {
      try {
        cover = resolveOutputPath(outDir, item.cover);
        await assertNoSymlinkEscape(realOutDir, cover.absolute);
        if (![".jpg", ".jpeg"].includes(path.extname(cover.relative).toLowerCase())) {
          issues.push({
            index,
            id: item.id,
            path: `jobs.${index}.cover`,
            message: `封面扩展名必须是 .jpg 或 .jpeg，收到 ${path.extname(cover.relative) || "(无扩展名)"}`,
            code: "INVALID_COVER_EXTENSION",
          });
        }
      } catch (error) {
        issues.push({
          index,
          id: item.id,
          path: `jobs.${index}.cover`,
          message: errorInfo(error).message,
          code: "OUTPUT_TRAVERSAL",
        });
      }
    }

    for (const [kind, candidate] of [
      ["out", output],
      ["cover", cover],
    ] as const) {
      if (!candidate) continue;
      const key = outputCollisionKey(candidate.relative);
      const previous = seenOutputs.get(key);
      if (previous) {
        issues.push({
          index,
          id: item.id,
          path: `jobs.${index}.${kind}`,
          message: `输出与 jobs.${previous.index}.${previous.kind} 重复`,
          code: "DUPLICATE_OUTPUT",
        });
      } else {
        seenOutputs.set(key, { index, id: item.id, kind });
      }
      const reserved = reservedOutputs.get(outputCollisionKey(candidate.relative));
      if (reserved) {
        issues.push({
          index,
          id: item.id,
          path: `jobs.${index}.${kind}`,
          message: `输出路径不能覆盖${reserved}`,
          code: "RESERVED_OUTPUT_PATH",
        });
      }
    }

    const configValue = item.config;
    if (path.isAbsolute(configValue) || path.win32.isAbsolute(configValue)) {
      issues.push({
        index,
        id: item.id,
        path: `jobs.${index}.config`,
        message: "config 必须是相对于批处理清单的路径",
        code: "ABSOLUTE_CONFIG_PATH",
      });
    }

    if (output && !(path.isAbsolute(configValue) || path.win32.isAbsolute(configValue))) {
      jobs.push({
        index,
        id: item.id,
        manifestPath,
        configPath: path.resolve(manifestDir, configValue),
        outDir,
        outputPath: output.absolute,
        outputRelativePath: output.relative,
        ...(cover
          ? { coverPath: cover.absolute, coverRelativePath: cover.relative }
          : {}),
        options: mergeOptions(defaultExportOptions, manifest.defaults, item.options),
        exportOverrideKeys: exportOverrideKeys(manifest.defaults, item.options),
      });
    }
  }

  if (issues.length > 0) throw new BatchPreflightError(issues);
  return jobs;
}

async function readJournal(file: string): Promise<BatchJournal | null> {
  let text: string;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new BatchJournalError(`无法读取批处理状态文件: ${file}`, error);
  }
  try {
    const parsed = BatchJournalSchema.parse(JSON.parse(text) as unknown);
    return parsed as BatchJournal;
  } catch (error) {
    throw new BatchJournalError(
      `批处理状态文件已损坏，请备份后删除再重试: ${file}`,
      error,
    );
  }
}

async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.partial`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temp, file);
    // Persisting the directory entry is best-effort; some filesystems reject
    // directory fsync even though rename itself succeeded.
    const directory = await fs.open(path.dirname(file), "r").catch(() => undefined);
    if (directory) {
      await directory.sync().catch(() => {});
      await directory.close().catch(() => {});
    }
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}

function journalWriter(journal: BatchJournal, journalPath: string): () => Promise<void> {
  let tail = Promise.resolve();
  return () => {
    const snapshot = structuredClone(journal);
    const write = tail.then(() => atomicWriteJson(journalPath, snapshot));
    tail = write.catch(() => {});
    return write;
  };
}

async function artifactIntegrity(file: string): Promise<JournalArtifactIntegrity> {
  const before = await fs.stat(file);
  if (!before.isFile()) throw new Error(`产物不是普通文件: ${file}`);
  if (before.size <= 0) throw new Error(`产物不存在或为空: ${file}`);

  const hash = crypto.createHash("sha256");
  let sizeBytes = 0;
  for await (const chunk of createReadStream(file)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    sizeBytes += buffer.length;
    hash.update(buffer);
  }

  const after = await fs.stat(file);
  if (
    !after.isFile() ||
    after.size !== before.size ||
    after.mtimeMs !== before.mtimeMs ||
    after.ctimeMs !== before.ctimeMs ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    sizeBytes !== after.size
  ) {
    throw new Error(`计算摘要时产物发生了变化: ${file}`);
  }

  return { sizeBytes, sha256: hash.digest("hex") };
}

async function collectArtifactIntegrity(job: PreparedBatchJob): Promise<JournalArtifacts> {
  const output = await artifactIntegrity(job.outputPath);
  const cover = job.coverPath ? await artifactIntegrity(job.coverPath) : undefined;
  return { output, ...(cover ? { cover } : {}) };
}

async function artifactMatches(
  file: string,
  expected: JournalArtifactIntegrity,
): Promise<boolean> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size !== expected.sizeBytes || stat.size <= 0) return false;
    const actual = await artifactIntegrity(file);
    return actual.sizeBytes === expected.sizeBytes && actual.sha256 === expected.sha256;
  } catch {
    // An unreadable, missing, concurrently modified, or otherwise suspicious
    // artifact is never trusted for resume. Rendering it again is the safe path.
    return false;
  }
}

async function artifactsMatch(
  job: PreparedBatchJob,
  expected: JournalArtifacts | undefined,
): Promise<boolean> {
  if (!expected) return false;
  if ((job.coverPath === undefined) !== (expected.cover === undefined)) return false;
  if (!(await artifactMatches(job.outputPath, expected.output))) return false;
  return !job.coverPath || artifactMatches(job.coverPath, expected.cover!);
}

type OutputTarget = {
  index: number;
  id: string;
  kind: "out" | "cover";
  file: string;
};

function outputTargets<TValidated>(
  validated: readonly ValidatedJob<TValidated>[],
): OutputTarget[] {
  return validated.flatMap(({ job }) => [
    { index: job.index, id: job.id, kind: "out" as const, file: job.outputPath },
    ...(job.coverPath
      ? [{ index: job.index, id: job.id, kind: "cover" as const, file: job.coverPath }]
      : []),
  ]);
}

async function probeOutputParent(
  outDir: string,
  parent: string,
): Promise<void> {
  await fs.mkdir(parent, { recursive: true });
  const realParent = await fs.realpath(parent);
  if (!isWithin(outDir, realParent)) {
    throw new Error(`输出父目录经过符号链接越界: ${parent}`);
  }

  const probe = path.join(
    parent,
    `.littlestart-write-probe-${process.pid}-${crypto.randomBytes(8).toString("hex")}`,
  );
  let handle: fs.FileHandle | undefined;
  let created = false;
  try {
    handle = await fs.open(probe, "wx", 0o600);
    created = true;
    await handle.writeFile("ok", "utf8");
    await handle.sync();
  } finally {
    await handle?.close().catch(() => {});
    if (created) {
      await fs.unlink(probe).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}

/**
 * Validate every destination before any render worker starts. A resume record
 * whose artifact no longer matches is a normal render candidate, so it still
 * requires explicit overwrite authorization when a target exists.
 */
async function preflightOutputTargets<TValidated>(
  validated: readonly ValidatedJob<TValidated>[],
  resumable: ReadonlySet<number>,
  options: { overwrite: boolean; realOutDir: string },
): Promise<void> {
  const issues: BatchPreflightIssue[] = [];
  const parents = new Map<string, OutputTarget[]>();

  for (const target of outputTargets(validated)) {
    const parent = path.dirname(target.file);
    const key = path.resolve(parent);
    const siblings = parents.get(key) ?? [];
    siblings.push(target);
    parents.set(key, siblings);

    const existing = await fs.lstat(target.file).catch((error) => {
      const code = (error as NodeJS.ErrnoException).code;
      // A regular-file ancestor makes the target itself unstatable. Let the
      // parent-directory probe report the actionable preflight issue.
      if (code === "ENOENT" || code === "ENOTDIR") return null;
      throw error;
    });
    if (!existing) continue;
    if (!existing.isFile() || existing.isSymbolicLink()) {
      issues.push({
        index: target.index,
        id: target.id,
        path: `jobs.${target.index}.${target.kind}`,
        message: `输出目标已存在且不是可安全替换的普通文件: ${target.file}`,
        code: "OUTPUT_INVALID",
      });
    } else if (!resumable.has(target.index) && !options.overwrite) {
      issues.push({
        index: target.index,
        id: target.id,
        path: `jobs.${target.index}.${target.kind}`,
        message: `输出已存在，且当前任务未获准跳过或覆盖: ${target.file}（需启用 resume 或显式允许 overwrite）`,
        code: "OUTPUT_EXISTS",
      });
    }
  }

  for (const [parent, targets] of parents) {
    try {
      await probeOutputParent(options.realOutDir, parent);
    } catch (error) {
      const target = targets[0];
      issues.push({
        index: target.index,
        id: target.id,
        path: `jobs.${target.index}.${target.kind}`,
        message: `输出父目录无法创建或写入: ${parent}（${errorInfo(error).message}）`,
        code: "OUTPUT_PARENT_UNWRITABLE",
      });
    }
  }

  if (issues.length > 0) {
    issues.sort((left, right) =>
      (left.index ?? -1) - (right.index ?? -1) ||
      String(left.path).localeCompare(String(right.path)),
    );
    throw new BatchPreflightError(issues);
  }
}

async function validateAll<TValidated, TResult>(
  manifest: BatchManifest,
  jobs: readonly PreparedBatchJob[],
  concurrency: number,
  options: RunBatchOptions<TValidated, TResult>,
): Promise<ValidatedJob<TValidated>[]> {
  const validations: Array<ValidatedJob<TValidated> | undefined> = new Array(jobs.length);
  const issues: BatchPreflightIssue[] = [];
  let cursor = 0;
  const manifestDir = path.dirname(path.resolve(options.manifestPath));

  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const index = cursor++;
      if (index >= jobs.length) return;
      const job = jobs[index];
      try {
        const validation = await options.validateOne(job, { signal: options.signal });
        throwIfAborted(options.signal);
        if (!validation || typeof validation !== "object" || !("value" in validation)) {
          throw new TypeError("validateOne 必须返回 { value, localAssetPaths? }");
        }
        const fingerprint = await fingerprintJob(
          manifest,
          manifestDir,
          manifest.jobs[job.index],
          job,
          validation,
          options.fingerprintSalt,
        );
        validations[index] = { job, validation, fingerprint };
      } catch (error) {
        if (options.signal?.aborted || isAbortError(error)) return;
        const info = errorInfo(error);
        issues.push({
          index: job.index,
          id: job.id,
          path: `jobs.${job.index}.config`,
          message: info.message,
          code: info.code ?? "VALIDATION_FAILED",
        });
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()),
  );
  throwIfAborted(options.signal);
  if (issues.length > 0) {
    issues.sort((left, right) => (left.index ?? -1) - (right.index ?? -1));
    throw new BatchPreflightError(issues);
  }
  return validations as ValidatedJob<TValidated>[];
}

function validateConcurrency(value: number | undefined): number {
  const concurrency = value ?? DEFAULT_CONCURRENCY;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > MAX_CONCURRENCY) {
    throw new BatchManifestError(
      `并发数必须是 1-${MAX_CONCURRENCY} 之间的整数`,
      [{ path: "concurrency", message: String(concurrency), code: "INVALID_CONCURRENCY" }],
    );
  }
  return concurrency;
}

async function runBatchWithLockHeld<TValidated, TResult = unknown>(
  options: RunBatchOptions<TValidated, TResult>,
): Promise<BatchSummary<TResult>> {
  const now = options.now ?? (() => new Date());
  const concurrency = validateConcurrency(options.concurrency);
  const manifestPath = path.resolve(options.manifestPath);
  const outDir = path.resolve(options.outDir);
  const journalPath = path.resolve(
    options.journalPath ?? path.join(outDir, ".littlestart-batch-state.json"),
  );
  const lockPath = path.join(outDir, BATCH_LOCK_FILENAME);
  const recoveryPath = path.join(outDir, BATCH_LOCK_RECOVERY_FILENAME);
  if (!isWithin(outDir, journalPath) || journalPath === outDir) {
    throw new BatchJournalError("批处理状态文件必须位于输出目录内");
  }
  if ([lockPath, recoveryPath].some((reserved) => path.resolve(reserved) === journalPath)) {
    throw new BatchJournalError("批处理状态文件不能使用批处理锁的保留路径");
  }

  throwIfAborted(options.signal);
  const manifest = await readManifest(manifestPath, options.manifestText);
  await fs.mkdir(outDir, { recursive: true });
  const realOutDir = await fs.realpath(outDir);
  try {
    await assertNoSymlinkEscape(realOutDir, journalPath);
  } catch (error) {
    throw new BatchJournalError("批处理状态文件经过符号链接逃逸了输出目录", error);
  }
  const startedAt = iso(now);
  const startedMs = timeMs(now);
  options.onEvent?.({ event: "preflight-started", timestamp: iso(now), total: manifest.jobs.length });

  const prepared = await prepareJobs(
    manifestPath,
    outDir,
    manifest,
    options.defaultExportOptions ?? DEFAULT_EXPORT_OPTIONS,
    journalPath,
    lockPath,
    recoveryPath,
  );
  const validated = await validateAll(manifest, prepared, concurrency, options);
  throwIfAborted(options.signal);

  const oldJournal = options.resume ? await readJournal(journalPath) : null;
  const resumable = new Set<number>();
  if (options.resume) {
    for (const [index, item] of validated.entries()) {
      const previous = oldJournal?.jobs[item.job.id];
      if (
        previous?.status === "succeeded" &&
        previous.fingerprint === item.fingerprint &&
        previous.outputRelativePath === item.job.outputRelativePath &&
        previous.coverRelativePath === item.job.coverRelativePath &&
        (await artifactsMatch(item.job, previous.artifacts))
      ) {
        resumable.add(index);
      }
    }
  }
  await preflightOutputTargets(validated, resumable, {
    overwrite: options.overwrite === true,
    realOutDir,
  });
  throwIfAborted(options.signal);
  options.onEvent?.({
    event: "preflight-completed",
    timestamp: iso(now),
    total: validated.length,
  });

  const journal: BatchJournal = {
    version: JOURNAL_VERSION,
    manifestPath,
    manifestHash: manifestHash(manifest),
    updatedAt: iso(now),
    jobs: oldJournal ? { ...oldJournal.jobs } : {},
  };
  const persist = journalWriter(journal, journalPath);
  await persist();

  options.onEvent?.({
    event: "batch-started",
    timestamp: iso(now),
    total: validated.length,
    concurrency,
    resume: options.resume === true,
  });

  const results: Array<BatchJobResult<TResult> | undefined> = new Array(validated.length);
  let completed = 0;
  const emitFinished = (result: BatchJobResult<TResult>): void => {
    completed += 1;
    options.onEvent?.({
      event: "job-finished",
      timestamp: iso(now),
      job: result,
      completed,
      total: validated.length,
    });
  };

  const runnable: number[] = [];
  for (const [index, item] of validated.entries()) {
    if (!resumable.has(index)) {
      runnable.push(index);
      continue;
    }
    const finishedAt = iso(now);
    const result: BatchJobResult<TResult> = {
      index: item.job.index,
      id: item.job.id,
      status: "skipped",
      fingerprint: item.fingerprint,
      outputPath: item.job.outputPath,
      ...(item.job.coverPath ? { coverPath: item.job.coverPath } : {}),
      finishedAt,
      durationMs: 0,
    };
    results[index] = result;
    emitFinished(result);
  }

  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      if (options.signal?.aborted) return;
      const runnableIndex = cursor++;
      if (runnableIndex >= runnable.length) return;
      const resultIndex = runnable[runnableIndex];
      const item = validated[resultIndex];
      const jobStartedAt = iso(now);
      const jobStartedMs = timeMs(now);
      options.onEvent?.({
        event: "job-started",
        timestamp: jobStartedAt,
        id: item.job.id,
        index: item.job.index,
      });

      try {
        const resultValue = await options.renderOne(item.job, item.validation.value, {
          signal: options.signal,
          overwrite: options.overwrite === true,
          reportProgress: (ratio, detail) => {
            if (!Number.isFinite(ratio)) return;
            options.onEvent?.({
              event: "job-progress",
              timestamp: iso(now),
              id: item.job.id,
              index: item.job.index,
              ratio: Math.max(0, Math.min(1, ratio)),
              ...(detail ? { detail } : {}),
            });
          },
        });
        const artifacts = await collectArtifactIntegrity(item.job);
        const finishedAt = iso(now);
        const result: BatchJobResult<TResult> = {
          index: item.job.index,
          id: item.job.id,
          status: "succeeded",
          fingerprint: item.fingerprint,
          outputPath: item.job.outputPath,
          ...(item.job.coverPath ? { coverPath: item.job.coverPath } : {}),
          startedAt: jobStartedAt,
          finishedAt,
          durationMs: Math.max(0, timeMs(now) - jobStartedMs),
          ...(resultValue === undefined ? {} : { result: resultValue }),
        };
        results[resultIndex] = result;
        journal.jobs[item.job.id] = {
          fingerprint: item.fingerprint,
          status: "succeeded",
          outputRelativePath: item.job.outputRelativePath,
          ...(item.job.coverRelativePath
            ? { coverRelativePath: item.job.coverRelativePath }
            : {}),
          artifacts,
          updatedAt: finishedAt,
        };
        journal.updatedAt = finishedAt;
        await persist();
        emitFinished(result);
      } catch (error) {
        const cancelled = options.signal?.aborted || isAbortError(error);
        const finishedAt = iso(now);
        const info = errorInfo(cancelled ? abortError(options.signal) : error);
        const result: BatchJobResult<TResult> = {
          index: item.job.index,
          id: item.job.id,
          status: cancelled ? "cancelled" : "failed",
          fingerprint: item.fingerprint,
          outputPath: item.job.outputPath,
          ...(item.job.coverPath ? { coverPath: item.job.coverPath } : {}),
          startedAt: jobStartedAt,
          finishedAt,
          durationMs: Math.max(0, timeMs(now) - jobStartedMs),
          error: info,
        };
        results[resultIndex] = result;
        journal.jobs[item.job.id] = {
          fingerprint: item.fingerprint,
          status: cancelled ? "cancelled" : "failed",
          outputRelativePath: item.job.outputRelativePath,
          ...(item.job.coverRelativePath
            ? { coverRelativePath: item.job.coverRelativePath }
            : {}),
          updatedAt: finishedAt,
          error: info,
        };
        journal.updatedAt = finishedAt;
        await persist();
        emitFinished(result);
      }
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, runnable.length) }, () => worker()),
  );

  // Workers stop claiming jobs after cancellation. Record every queued item so
  // callers get a complete, manifest-ordered summary and resume never mistakes
  // an unstarted job for success.
  for (const resultIndex of runnable) {
    if (results[resultIndex]) continue;
    const item = validated[resultIndex];
    const finishedAt = iso(now);
    const info = errorInfo(abortError(options.signal));
    const result: BatchJobResult<TResult> = {
      index: item.job.index,
      id: item.job.id,
      status: "cancelled",
      fingerprint: item.fingerprint,
      outputPath: item.job.outputPath,
      ...(item.job.coverPath ? { coverPath: item.job.coverPath } : {}),
      finishedAt,
      durationMs: 0,
      error: info,
    };
    results[resultIndex] = result;
    journal.jobs[item.job.id] = {
      fingerprint: item.fingerprint,
      status: "cancelled",
      outputRelativePath: item.job.outputRelativePath,
      ...(item.job.coverRelativePath
        ? { coverRelativePath: item.job.coverRelativePath }
        : {}),
      updatedAt: finishedAt,
      error: info,
    };
    journal.updatedAt = finishedAt;
    await persist();
    emitFinished(result);
  }

  const ordered = results as BatchJobResult<TResult>[];
  const succeeded = ordered.filter((result) => result.status === "succeeded").length;
  const failed = ordered.filter((result) => result.status === "failed").length;
  const skipped = ordered.filter((result) => result.status === "skipped").length;
  const cancelled = ordered.filter((result) => result.status === "cancelled").length;
  const finishedAt = iso(now);
  const summary: BatchSummary<TResult> = {
    manifestPath,
    outDir,
    journalPath,
    startedAt,
    finishedAt,
    durationMs: Math.max(0, timeMs(now) - startedMs),
    total: ordered.length,
    succeeded,
    failed,
    skipped,
    cancelled,
    partial: failed > 0 || cancelled > 0,
    interrupted: cancelled > 0 && options.signal?.aborted === true,
    jobs: ordered,
  };
  options.onEvent?.({ event: "batch-finished", timestamp: iso(now), summary });
  return summary;
}

/**
 * Run one batch while holding the output directory's process-wide lease.
 * Parsing, preflight, journal mutation, and rendering all happen under the
 * same lock so two CLI processes can never race the same artifacts.
 */
export async function runBatch<TValidated, TResult = unknown>(
  options: RunBatchOptions<TValidated, TResult>,
): Promise<BatchSummary<TResult>> {
  throwIfAborted(options.signal);
  const outDir = path.resolve(options.outDir);
  await fs.mkdir(outDir, { recursive: true });
  const lockPath = path.join(outDir, BATCH_LOCK_FILENAME);
  try {
    return await withFileLock(lockPath, () => runBatchWithLockHeld(options), {
      signal: options.signal,
      staleMs: BATCH_LOCK_STALE_MS,
      retryMinMs: BATCH_LOCK_POLL_MS,
      retryMaxMs: BATCH_LOCK_POLL_MS,
      // Batch runs intentionally wait until the current owner finishes unless
      // the caller cancels. Preserve that contract while using the shared,
      // inode-verified recovery and release primitive.
      timeoutMs: Number.POSITIVE_INFINITY,
    });
  } catch (error) {
    // The shared lock reports cancellation generically. Keep the batch API's
    // caller-provided abort reason and error shape stable.
    if (options.signal?.aborted && isAbortError(error)) {
      throw abortError(options.signal);
    }
    throw error;
  }
}
