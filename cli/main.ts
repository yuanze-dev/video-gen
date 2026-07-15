#!/usr/bin/env node
import { constants as fsConstants, writeSync as writeFileDescriptorSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  BatchJournalError,
  BatchManifestError,
  BatchManifestSchema,
  BatchPreflightError,
  runBatch,
  type BatchEvent,
} from "./batch";
import {
  CLI_COMMAND_SPECS,
  detectCliBootstrapOptions,
  formatCliCommand,
  parseCliArgs,
  type CliCommandId,
  type ParsedCliInvocation,
} from "./args";
import {
  CLI_MIME_BY_EXTENSION,
  inspectCliAsset,
  isCliConfigValidationError,
  type LoadedConfig,
} from "./config";
import {
  clearCache,
  doctor,
  ensureCliBrowser,
  listCache,
  pruneCache,
} from "./doctor";
import { renderCliHelp } from "./help";
import { probeMedia } from "./media";
import {
  MAX_CONFIG_BYTES,
  configForFileOutput,
  createProjectLock,
  createRenderPlan,
  defaultConfig,
  getCliConfigJsonSchema,
  loadProjectInput,
  makeMinimalConfig,
  writeJsonAtomic,
  type LoadedProjectInput,
} from "./project";
import {
  CLI_EXIT_CODES,
  CLI_PROTOCOL_VERSION,
  CliError,
  createCliEmitter,
  isCliError,
  type CliEmitter,
} from "./protocol";
import {
  RenderCancelledError,
  getCacheDirectory,
  renderSceneStills,
  renderStill,
  renderVideo,
} from "./render";
import {
  COMPOSITION_ID,
  TEMPLATE_ID,
  TEMPLATE_REF,
  TEMPLATE_VERSION,
  builtinAssetFile,
  renderRuntimeParams,
  resolveCliRuntime,
  type CliRuntime,
} from "./runtime";
import { installGenerateVideoSkill } from "./skills";
import {
  ASSET_SLOT_REGISTRY,
  getBuiltinAsset,
  listBuiltinAssetMetadata,
} from "../lib/asset-registry";
import {
  DEFAULT_EXPORT_OPTIONS,
  type ExportOptions,
} from "../lib/export-options";
import {
  ChromiumGlConfigurationError,
  resolveChromiumGlRenderer,
} from "./chromium";

type CommandResult = {
  result: unknown;
  message?: string;
};

type CommandContext = {
  invocation: ParsedCliInvocation;
  emitter: CliEmitter;
  signal: AbortSignal;
  getRuntime: () => Promise<CliRuntime>;
  cacheDir: string;
};

function timestamp(): string {
  const date = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function resolveTemplate(value: string | undefined): void {
  if (!value) return;
  const normalized = value.trim().toLowerCase();
  if (![TEMPLATE_ID, `${TEMPLATE_ID}@1`, TEMPLATE_REF].includes(normalized as typeof TEMPLATE_ID)) {
    throw new CliError("CONFIG_INVALID", `未知模板 "${value}"`, {
      hint: "运行 littlestart templates list 查看随 CLI 提供的模板。",
    });
  }
}

function exportOptionsFor(
  invocation: ParsedCliInvocation,
  locked?: ExportOptions,
): ExportOptions {
  const base = locked ?? DEFAULT_EXPORT_OPTIONS;
  return {
    quality: invocation.options.quality ?? base.quality,
    resolution: invocation.options.resolution ?? base.resolution,
    fps: invocation.options.fps ?? base.fps,
  };
}

const EXPORT_OPTION_NAMES = ["quality", "resolution", "fps"] as const;

function assertNoLockedExportOverrides(
  input: LoadedProjectInput,
  invocation: ParsedCliInvocation,
): void {
  if (!input.lock) return;
  const overrides = EXPORT_OPTION_NAMES.filter(
    (name) => invocation.options[name] !== undefined,
  );
  if (overrides.length === 0) return;
  throw new CliError("OPTION_CONFLICT", "锁文件的导出参数不能在渲染时覆盖", {
    issues: overrides.map((name) => ({
      path: `options.${name}`,
      message: `已由锁文件固定为 ${String(input.lockedExportOptions?.[name])}`,
    })),
    hint: "如需更改导出参数，请从源配置重新运行 config lock。",
  });
}

async function readStdinLimited(signal: AbortSignal): Promise<string> {
  if (process.stdin.isTTY) {
    throw new CliError("CONFIG_READ_FAILED", "命令要求从 stdin 读取 JSON，但 stdin 是终端", {
      hint: "传入配置文件路径，或通过管道将 JSON 传给 `-`。",
    });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  if (signal.aborted) throw signal.reason;
  const onAbort = () => {
    process.stdin.destroy(
      signal.reason instanceof Error ? signal.reason : new Error("stdin 读取已取消"),
    );
  };
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    for await (const chunk of process.stdin) {
      if (signal.aborted) throw signal.reason;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytes += buffer.length;
      if (bytes > MAX_CONFIG_BYTES) {
        throw new CliError("CONFIG_READ_FAILED", `stdin JSON 超过 ${MAX_CONFIG_BYTES} bytes 上限`);
      }
      chunks.push(buffer);
    }
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function loadInput(context: CommandContext, source: string): Promise<LoadedProjectInput> {
  const stdin = source === "-" ? await readStdinLimited(context.signal) : undefined;
  return loadProjectInput(source, { stdin });
}

function assertLockRuntime(input: LoadedProjectInput, runtime: CliRuntime): void {
  const locked = input.lock?.template.runtimeDigest;
  if (locked && locked !== runtime.runtimeMetadata.templateDigest) {
    throw new CliError("CONFIG_INVALID", "锁文件的渲染 runtime 与当前 CLI 不一致", {
      issues: [
        {
          path: "template.runtimeDigest",
          message: `锁定 ${locked}，当前 ${runtime.runtimeMetadata.templateDigest}`,
        },
      ],
      hint: "使用生成该锁文件的 CLI 版本，或审核变更后重新运行 config lock。",
    });
  }
}

function assertExtension(file: string, extensions: readonly string[], label: string): void {
  const extension = path.extname(file).toLowerCase();
  if (!extensions.includes(extension)) {
    throw new CliError("INVALID_OPTION_VALUE", `${label}扩展名必须是 ${extensions.join(" | ")}`, {
      issues: [{ path: label, message: `收到 ${extension || "(无扩展名)"}` }],
    });
  }
}

async function assertOutputsAvailable(
  files: readonly string[],
  overwrite: boolean,
): Promise<void> {
  for (const file of files) {
    const existing = await fs.lstat(file).then(
      (stat) => stat,
      (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      },
    );
    if (!existing) continue;
    if (overwrite) {
      if (!existing.isFile() || existing.isSymbolicLink()) {
        throw new CliError("OUTPUT_INVALID", `输出目标不是可安全替换的普通文件: ${file}`, {
          hint: "请改用普通文件路径；CLI 不会覆盖目录或符号链接。",
        });
      }
    } else {
      throw new CliError("OUTPUT_EXISTS", `输出文件已存在: ${file}`, {
        hint: "选择新输出路径，或确认允许替换后显式使用 --force。",
      });
    }
  }
}

async function browserExecutable(context: CommandContext, runtime: CliRuntime): Promise<string> {
  // Fail before browser downloads or output preparation when the shared
  // render/doctor WebGL selection is invalid.
  resolveChromiumGlRenderer();
  const configured = process.env.REMOTION_BROWSER_EXECUTABLE?.trim();
  if (configured) {
    const candidate = path.resolve(configured);
    const stat = await fs.stat(candidate).catch(() => null);
    const executable = stat?.isFile()
      ? await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK)
        .then(() => true)
        .catch(() => false)
      : false;
    if (!executable) {
      throw new CliError("DEPENDENCY_MISSING", "REMOTION_BROWSER_EXECUTABLE 不是可执行文件", {
        issues: [{ path: "env.REMOTION_BROWSER_EXECUTABLE", message: candidate }],
        hint: "修正或移除该环境变量，让 CLI 使用自己的 Chromium 缓存。",
      });
    }
    return fs.realpath(candidate);
  }
  const browser = await ensureCliBrowser({
    cacheDir: context.cacheDir,
    fix: !context.invocation.global.offline,
    offline: context.invocation.global.offline,
    sourceRoot: runtime.sourceRoot,
    signal: context.signal,
    log: (message) => context.emitter.log(message),
  });
  if (!browser.ok || !browser.path) {
    throw new CliError(
      context.invocation.global.offline ? "OFFLINE_RESOURCE_MISSING" : "DEPENDENCY_MISSING",
      context.invocation.global.offline
        ? "离线缓存中没有匹配的 Chromium"
        : "无法准备 Chromium 渲染环境",
      {
        hint: context.invocation.global.offline
          ? "先在联网环境运行 littlestart doctor --fix，再复用同一个 --cache-dir。"
          : "运行 littlestart doctor --fix 查看详细诊断。",
        details: browser,
      },
    );
  }
  return browser.path;
}

function throttledProgress(emitter: CliEmitter, stage: string): (ratio: number) => void {
  let lastPercent = -1;
  return (ratio) => {
    const percent = Math.floor(ratio * 100);
    if (percent < 100 && percent < lastPercent + 2) return;
    lastPercent = percent;
    emitter.progress(ratio, { stage, message: `渲染进度 ${percent}%` });
  };
}

function runtimeRenderBase(
  context: CommandContext,
  runtime: CliRuntime,
  browser: string,
  loaded: LoadedConfig,
  options: ExportOptions,
) {
  return {
    ...renderRuntimeParams(runtime),
    config: loaded.config,
    files: loaded.files,
    options,
    cacheDir: path.join(context.cacheDir, "remotion-bundles"),
    browserExecutable: browser,
    signal: context.signal,
    logLevel: "error" as const,
    log: (message: string) => context.emitter.log(message),
  };
}

function templateDetails(runtime?: CliRuntime) {
  return {
    id: TEMPLATE_ID,
    version: TEMPLATE_VERSION,
    ref: TEMPLATE_REF,
    composition: COMPOSITION_ID,
    canvas: { width: 1080, height: 1920, fps: 60 },
    scenes: ["opening", "content", "ending"],
    teleprompterModes: ["text", "video"],
    builtinAssets: listBuiltinAssetMetadata(),
    ...(runtime ? { runtimeDigest: runtime.runtimeMetadata.templateDigest } : {}),
  };
}

async function dispatch(context: CommandContext): Promise<CommandResult> {
  const { invocation, emitter, signal } = context;
  switch (invocation.id) {
    case "help": {
      const help = renderCliHelp(invocation.helpTarget);
      return { result: { help, target: invocation.helpTarget ?? [] }, message: help };
    }
    case "version": {
      const runtime = await context.getRuntime();
      const result = {
        name: "littlestart",
        version: runtime.cliVersion,
        protocolVersion: CLI_PROTOCOL_VERSION,
        package: "@yuanze/littlestart-cli",
        runtime: runtime.runtimeMetadata,
        packaged: runtime.packaged,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
      };
      return {
        result,
        message: `littlestart ${runtime.cliVersion} · protocol ${CLI_PROTOCOL_VERSION} · ${TEMPLATE_REF}`,
      };
    }
    case "doctor": {
      resolveChromiumGlRenderer();
      const runtime = await context.getRuntime();
      const result = await doctor({
        fix: invocation.options.fix,
        offline: invocation.global.offline,
        cacheDir: context.cacheDir,
        runtimeSite: runtime.runtimeSite,
        sourceRoot: runtime.sourceRoot,
        signal,
        log: (message) => emitter.log(message),
      });
      for (const check of result.checks) {
        emitter.log(`${check.status === "ok" ? "✓" : check.status === "warn" ? "!" : "✗"} ${check.message}`);
      }
      if (!result.ok) {
        throw new CliError("ENVIRONMENT_UNSUPPORTED", "本机渲染环境检查未通过", {
          issues: result.checks
            .filter((check) => check.status === "error")
            .map((check) => ({ path: check.id, message: check.message })),
          hint: invocation.options.fix
            ? "请按上方错误修复环境后重试。"
            : "可运行 littlestart doctor --fix 自动准备可修复项。",
          details: result,
        });
      }
      return { result, message: "环境检查通过" };
    }
    case "capabilities": {
      const runtime = await context.getRuntime();
      return {
        result: {
          protocolVersion: CLI_PROTOCOL_VERSION,
          cliVersion: runtime.cliVersion,
          offlineLocalRender: true,
          remoteAssets: false,
          cloudRender: false,
          templates: [templateDetails(runtime)],
          export: {
            containers: ["mp4"],
            codecs: ["h264"],
            quality: ["high", "standard", "small"],
            resolution: ["1080p", "720p"],
            fps: [30, 60],
            stillFormats: ["jpeg", "png"],
          },
          localAssetFormats: Object.entries(CLI_MIME_BY_EXTENSION).map(([extension, mime]) => ({
            extension,
            mime,
          })),
          commands: CLI_COMMAND_SPECS.map(({ id, path: commandPath, usage, summary }) => ({
            id,
            path: commandPath,
            usage,
            summary,
          })),
          configSchemaCommand: "littlestart config schema --json",
          batchManifestSchema: z.toJSONSchema(BatchManifestSchema),
        },
      };
    }
    case "init": {
      resolveTemplate(invocation.options.template);
      const target = path.resolve(invocation.positionals[0] ?? "video-config.json");
      const config = invocation.options.minimal ? makeMinimalConfig() : defaultConfig();
      await writeJsonAtomic(target, config, invocation.options.force === true);
      return { result: { config: target, template: TEMPLATE_REF, minimal: Boolean(invocation.options.minimal) }, message: `已创建配置 → ${target}` };
    }
    case "validate":
    case "plan": {
      const source = invocation.positionals[0];
      const input = await loadInput(context, source);
      const runtime = await context.getRuntime();
      assertLockRuntime(input, runtime);
      assertNoLockedExportOverrides(input, invocation);
      const plan = createRenderPlan(input, exportOptionsFor(invocation, input.lockedExportOptions));
      const result = {
        valid: true,
        source: input.source,
        locked: Boolean(input.lock),
        localFiles: Object.values(input.files).map(({ file, mime }) => ({ file, mime })),
        plan,
      };
      return invocation.id === "validate"
        ? { result, message: `配置有效 · ${plan.timeline.total.seconds.toFixed(2)} 秒 · ${plan.output.width}×${plan.output.height} @ ${plan.output.fps}fps` }
        : { result };
    }
    case "render": {
      const source = invocation.positionals[0];
      const input = await loadInput(context, source);
      const runtime = await context.getRuntime();
      assertLockRuntime(input, runtime);
      assertNoLockedExportOverrides(input, invocation);
      if (runtime.packaged && invocation.options.rebuild) {
        emitter.warn("安装版使用不可变预构建 runtime，--rebuild 不会改写它");
      }
      const options = exportOptionsFor(invocation, input.lockedExportOptions);
      const outPath = path.resolve(
        invocation.options.out ?? path.join("output", `video-${timestamp()}.mp4`),
      );
      assertExtension(outPath, [".mp4"], "options.out");
      const coverPath = invocation.options.cover ? path.resolve(invocation.options.cover) : undefined;
      if (coverPath) assertExtension(coverPath, [".jpg", ".jpeg"], "options.cover");
      await assertOutputsAvailable(
        [outPath, ...(coverPath ? [coverPath] : [])],
        invocation.options.force === true,
      );
      const browser = await browserExecutable(context, runtime);
      emitter.started({ source: input.source, output: outPath, cover: coverPath ?? null, options });
      const rendered = await renderVideo({
        ...runtimeRenderBase(context, runtime, browser, input, options),
        outPath,
        coverPath,
        overwrite: invocation.options.force === true,
        rebuild: !runtime.packaged && invocation.options.rebuild === true,
        onProgress: throttledProgress(emitter, "render"),
      });
      const result = {
        output: rendered.outputPath,
        cover: rendered.coverPath ?? null,
        durationSec: rendered.durationSec,
        sizeBytes: rendered.media.sizeBytes,
        media: rendered.media,
        export: options,
      };
      return { result, message: `渲染完成 → ${rendered.outputPath}` };
    }
    case "still": {
      const source = invocation.positionals[0];
      const input = await loadInput(context, source);
      const runtime = await context.getRuntime();
      assertLockRuntime(input, runtime);
      assertNoLockedExportOverrides(input, invocation);
      const options = exportOptionsFor(invocation, input.lockedExportOptions);
      const scene = invocation.options.scene ?? "opening";
      if (scene === "all") {
        if (invocation.options.out) {
          throw new CliError("OPTION_CONFLICT", "--scene all 不能与 --out 同时使用", {
            hint: "请使用 --out-dir 指定三张静帧的目录。",
          });
        }
        const outDir = path.resolve(invocation.options.outDir ?? "stills");
        await assertOutputsAvailable(
          (["opening", "content", "ending"] as const).map((name) =>
            path.join(outDir, `${name}.jpg`),
          ),
          invocation.options.force === true,
        );
        const browser = await browserExecutable(context, runtime);
        emitter.started({ source: input.source, scene });
        const rendered = await renderSceneStills({
          ...runtimeRenderBase(context, runtime, browser, input, options),
          outDir,
          overwrite: invocation.options.force === true,
        });
        return {
          result: { scene: "all", outDir, outputs: rendered.outputs },
          message: `已导出三场景静帧 → ${outDir}`,
        };
      }
      if (invocation.options.outDir) {
        throw new CliError("OPTION_CONFLICT", "单场景静帧不能使用 --out-dir", {
          hint: "使用 --out 指定图片，或改用 --scene all。",
        });
      }
      const outPath = path.resolve(invocation.options.out ?? `${scene}.jpg`);
      assertExtension(outPath, [".jpg", ".jpeg", ".png"], "options.out");
      await assertOutputsAvailable([outPath], invocation.options.force === true);
      const browser = await browserExecutable(context, runtime);
      emitter.started({ source: input.source, scene });
      const rendered = await renderStill({
        ...runtimeRenderBase(context, runtime, browser, input, options),
        outPath,
        scene,
        imageFormat: path.extname(outPath).toLowerCase() === ".png" ? "png" : "jpeg",
        overwrite: invocation.options.force === true,
      });
      return { result: rendered, message: `静帧已导出 → ${rendered.outputPath}` };
    }
    case "probe": {
      const media = await probeMedia(invocation.positionals[0]);
      return { result: media };
    }
    case "config.schema": {
      resolveTemplate(invocation.options.template);
      const schema = getCliConfigJsonSchema();
      if (!invocation.options.out) return { result: schema };
      const output = await writeJsonAtomic(
        invocation.options.out,
        schema,
        invocation.options.force === true,
      );
      return { result: { output, schemaId: (schema as { $id?: string }).$id }, message: `JSON Schema 已写入 → ${output}` };
    }
    case "config.resolve":
    case "config.migrate": {
      const input = await loadInput(context, invocation.positionals[0]);
      const outputBase = invocation.options.out
        ? path.dirname(path.resolve(invocation.options.out))
        : process.cwd();
      const config = configForFileOutput(input, outputBase);
      const result = invocation.id === "config.migrate"
        ? {
            migrated: false,
            fromVersion: input.config.version,
            toVersion: 1,
            reason: "当前 CLI 仅支持 v1；输入已经是 v1，未执行迁移",
            config,
          }
        : { config };
      if (!invocation.options.out) return { result };
      const output = await writeJsonAtomic(
        invocation.options.out,
        config,
        invocation.options.force === true,
      );
      return {
        result: {
          output,
          version: 1,
          ...(invocation.id === "config.migrate" ? { migrated: false } : {}),
        },
        message: `${invocation.id === "config.migrate" ? "规范化配置（无需迁移）" : "完整配置"}已写入 → ${output}`,
      };
    }
    case "config.lock": {
      const input = await loadInput(context, invocation.positionals[0]);
      const runtime = await context.getRuntime();
      const outputBase = invocation.options.out
        ? path.dirname(path.resolve(invocation.options.out))
        : process.cwd();
      const lock = await createProjectLock(input, runtime, {
        outputBaseDir: outputBase,
        exportOptions: exportOptionsFor(invocation, input.lockedExportOptions),
      });
      if (!invocation.options.out) return { result: lock };
      const output = await writeJsonAtomic(
        invocation.options.out,
        lock,
        invocation.options.force === true,
      );
      return { result: { output, digest: lock.digest }, message: `渲染锁已写入 → ${output}` };
    }
    case "templates.list": {
      const runtime = await context.getRuntime();
      return { result: { templates: [templateDetails(runtime)] } };
    }
    case "templates.show": {
      resolveTemplate(invocation.positionals[0]);
      const runtime = await context.getRuntime();
      return { result: templateDetails(runtime) };
    }
    case "assets.list": {
      return { result: { builtin: listBuiltinAssetMetadata(), slots: ASSET_SLOT_REGISTRY } };
    }
    case "assets.inspect": {
      const value = invocation.positionals[0];
      const builtin = getBuiltinAsset(value);
      if (builtin) {
        const runtime = await context.getRuntime();
        const file = builtinAssetFile(runtime, builtin.publicPath);
        const inspection = await inspectCliAsset(file);
        // Registry identity/duration is authoritative; probing contributes
        // only physical file facts such as bytes, container and resolved path.
        return { result: { builtin: true, ...inspection, ...builtin } };
      }
      const inspection = await inspectCliAsset(value);
      return { result: { builtin: false, ...inspection } };
    }
    case "cache.list": {
      return { result: await listCache(context.cacheDir) };
    }
    case "cache.prune": {
      const result = await pruneCache(context.cacheDir, { signal });
      return { result, message: `已清理 ${result.items} 个缓存项，释放 ${result.bytes} bytes` };
    }
    case "cache.clear": {
      if (!invocation.options.force) {
        throw new CliError("MISSING_ARGUMENT", "清空缓存必须显式提供 --force", {
          hint: "先运行 cache list 确认范围；普通维护优先使用 cache prune。",
        });
      }
      const result = await clearCache(context.cacheDir, { force: true, signal });
      return { result, message: `已清空 ${result.root}（${result.items} 项）` };
    }
    case "skill.install": {
      const runtime = await context.getRuntime();
      const installed = await installGenerateVideoSkill({
        sourceDir: runtime.skillsRoot,
        target: invocation.options.target,
        scope: invocation.options.scope,
        force: invocation.options.force === true,
      });
      return {
        result: installed,
        message: `Skill 已安装 → ${installed.installed.map((item) => item.path).join(", ")}`,
      };
    }
    case "batch": {
      const runtime = await context.getRuntime();
      const manifestSource = invocation.positionals[0];
      const manifestText = manifestSource === "-" ? await readStdinLimited(signal) : undefined;
      const manifestPath = manifestSource === "-"
        ? path.join(process.cwd(), "stdin.batch.json")
        : path.resolve(manifestSource);
      let sharedBrowser: Promise<string> | undefined;
      const getBrowser = () => (sharedBrowser ??= browserExecutable(context, runtime));
      const jobProgress = new Map<string, number>();
      let finished = 0;
      let total = 1;
      const onEvent = (event: BatchEvent<unknown>) => {
        if (event.event === "preflight-started") {
          total = event.total;
          emitter.log(`批处理预检: ${event.total} 项`);
        } else if (event.event === "batch-started") {
          emitter.started({ total: event.total, concurrency: event.concurrency, resume: event.resume });
        } else if (event.event === "job-started") {
          jobProgress.set(event.id, 0);
          emitter.log(`开始任务 ${event.id}`);
        } else if (event.event === "job-progress") {
          jobProgress.set(event.id, event.ratio);
          const active = [...jobProgress.values()].reduce((sum, value) => sum + value, 0);
          emitter.progress(Math.min(1, (finished + active) / Math.max(1, total)), {
            stage: "batch-render",
            job: event.id,
            jobProgress: event.ratio,
          });
        } else if (event.event === "job-finished") {
          jobProgress.delete(event.job.id);
          finished = event.completed;
          emitter.progress(finished / Math.max(1, event.total), {
            stage: "batch",
            current: finished,
            total: event.total,
            job: event.job.id,
            status: event.job.status,
            message: `${event.job.id}: ${event.job.status}`,
          });
        }
      };
      const summary = await runBatch({
        manifestPath,
        ...(manifestText === undefined ? {} : { manifestText }),
        outDir: invocation.options.outDir!,
        concurrency: invocation.options.jobs,
        resume: invocation.options.resume,
        overwrite: invocation.options.force === true,
        fingerprintSalt: JSON.stringify({
          cliVersion: runtime.cliVersion,
          templateDigest: runtime.runtimeMetadata.templateDigest,
          bundleDigest: runtime.runtimeMetadata.bundleDigest,
          platform: process.platform,
          arch: process.arch,
          chromiumGl: resolveChromiumGlRenderer(),
          browserExecutable: process.env.REMOTION_BROWSER_EXECUTABLE?.trim() || null,
          binariesDirectory: process.env.REMOTION_BINARIES_DIR?.trim() || null,
        }),
        signal,
        validateOne: async (job) => {
          const loaded = await loadProjectInput(job.configPath);
          assertLockRuntime(loaded, runtime);
          if (loaded.lock && job.exportOverrideKeys.length > 0) {
            throw new CliError("OPTION_CONFLICT", "批处理不能覆盖锁文件的导出参数", {
              issues: job.exportOverrideKeys.map((name) => ({
                path: `jobs.${job.index}.options.${name}`,
                message: `已由锁文件固定为 ${String(loaded.lockedExportOptions?.[name])}`,
              })),
              hint: "移除 manifest 的对应 defaults/options，或从源配置重新生成锁文件。",
            });
          }
          return {
            value: {
              loaded,
              options: loaded.lockedExportOptions ?? job.options,
            },
            localAssetPaths: Object.values(loaded.files).map((item) => item.file),
          };
        },
        renderOne: async (job, validated, { reportProgress, overwrite }) => {
          const browser = await getBrowser();
          const rendered = await renderVideo({
            ...runtimeRenderBase(
              context,
              runtime,
              browser,
              validated.loaded,
              validated.options,
            ),
            outPath: job.outputPath,
            coverPath: job.coverPath,
            overwrite,
            onProgress: (ratio) => reportProgress(ratio),
          });
          return {
            output: rendered.outputPath,
            cover: rendered.coverPath ?? null,
            durationSec: rendered.durationSec,
            sizeBytes: rendered.media.sizeBytes,
          };
        },
        onEvent,
      });
      if (summary.partial) {
        throw new CliError(summary.interrupted ? "INTERRUPTED" : "BATCH_PARTIAL_FAILURE", "批处理未全部成功", {
          hint: summary.interrupted
            ? "任务已安全停止；使用 --resume 可从已完成项继续。"
            : "修复失败任务后使用 --resume 重试。",
          details: summary,
        });
      }
      return {
        result: summary,
        message: `批处理完成 · 成功 ${summary.succeeded} · 跳过 ${summary.skipped}`,
      };
    }
  }
}

function issuesFromBatch(error: BatchManifestError | BatchPreflightError) {
  return error.issues.map((issue) => ({
    path: issue.path,
    message: issue.id ? `[${issue.id}] ${issue.message}` : issue.message,
    code: issue.code,
  }));
}

function normalizeCommandError(
  error: unknown,
  command: CliCommandId,
  signalName?: NodeJS.Signals,
): CliError {
  if (signalName) {
    return new CliError(signalName === "SIGTERM" ? "TERMINATED" : "INTERRUPTED", "操作已安全取消", {
      ...(isCliError(error) && error.details !== undefined ? { details: error.details } : {}),
      cause: error,
    });
  }
  if (isCliError(error)) return error;
  if (error instanceof RenderCancelledError) {
    return new CliError("INTERRUPTED", "操作已安全取消", { cause: error });
  }
  if (error instanceof ChromiumGlConfigurationError) {
    return new CliError("INVALID_OPTION_VALUE", error.message, {
      issues: [
        {
          path: "env.LITTLESTART_CHROMIUM_GL",
          message: `收到 ${error.value}`,
          value: error.value,
        },
      ],
      hint: "本机默认使用 angle；无 GPU 容器可显式设为 swangle。",
      cause: error,
    });
  }
  if (isCliConfigValidationError(error)) {
    // Field diagnostics already live in `issues`. Keep the top-level message
    // concise so human output does not print every issue twice, while JSON
    // consumers retain the stable path/message/code details.
    return new CliError("CONFIG_INVALID", "配置校验失败", {
      issues: error.issues,
      cause: error,
    });
  }
  if (error instanceof BatchManifestError || error instanceof BatchPreflightError) {
    const outputExists = error.issues.some((issue) => issue.code === "OUTPUT_EXISTS");
    return new CliError(outputExists ? "OUTPUT_EXISTS" : "CONFIG_INVALID", error.message, {
      issues: issuesFromBatch(error),
      hint: outputExists
        ? "选择新的输出目录，使用 --resume 恢复已验证任务，或确认替换后显式使用 --force。"
        : "所有任务都通过预检后，批处理才会开始渲染。",
      cause: error,
    });
  }
  if (error instanceof BatchJournalError) {
    return new CliError("OUTPUT_WRITE_FAILED", error.message, { cause: error });
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/已存在|同名文件|覆盖/.test(message)) {
    return new CliError("OUTPUT_EXISTS", message, {
      hint: "选择新输出路径，或确认允许替换后显式使用 --force。",
      cause: error,
    });
  }
  if (/素材|媒体|MIME|轨道|容器|文件头|upload/.test(message)) {
    return new CliError(/不存在|读不到|无法访问/.test(message) ? "ASSET_NOT_FOUND" : "ASSET_UNSUPPORTED", message, {
      cause: error,
    });
  }
  if (["validate", "plan", "config.resolve", "config.lock", "config.migrate"].includes(command)) {
    return new CliError(/读不到|不是合法 JSON/.test(message) ? "CONFIG_READ_FAILED" : "CONFIG_INVALID", message, {
      cause: error,
    });
  }
  if (["render", "still", "batch"].includes(command)) {
    return new CliError("RENDER_FAILED", message, {
      hint: "运行 validate、probe 与 doctor 可进一步定位问题。",
      cause: error,
    });
  }
  if (["doctor", "cache.list", "cache.prune", "cache.clear"].includes(command)) {
    return new CliError("ENVIRONMENT_UNSUPPORTED", message, { cause: error });
  }
  if (["init", "config.schema", "skill.install"].includes(command)) {
    return new CliError("OUTPUT_WRITE_FAILED", message, { cause: error });
  }
  return new CliError("INTERNAL_ERROR", message || "发生了未预期的错误", { cause: error });
}

export async function runCli(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
  const bootstrap = detectCliBootstrapOptions(argv);
  let invocation: ParsedCliInvocation;
  try {
    invocation = parseCliArgs(argv);
  } catch (error) {
    const emitter = createCliEmitter({
      mode: bootstrap.outputMode,
      quiet: bootstrap.quiet,
      color: bootstrap.color,
    });
    const normalized = emitter.failure(error);
    return normalized.exitCode;
  }

  const emitter = createCliEmitter({
    mode: invocation.global.outputMode,
    command: formatCliCommand(invocation),
    quiet: invocation.global.quiet,
    color: invocation.global.color,
  });
  const abortController = new AbortController();
  let receivedSignal: NodeJS.Signals | undefined;
  const handleSignal = (signal: NodeJS.Signals) => {
    if (!abortController.signal.aborted) {
      receivedSignal = signal;
      abortController.abort(new Error(`收到 ${signal}`));
      emitter.log(`收到 ${signal}，正在安全停止…`);
    }
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  // The source-development wrapper may receive a termination signal while
  // esbuild is still compiling this bundle. A private extra file descriptor
  // lets it wait until these handlers are installed before forwarding a queued
  // signal, preserving the same structured 130/143 response as the packaged
  // executable. Normal CLI launches do not set this variable.
  const readyFd = Number(process.env.LITTLESTART_READY_FD);
  if (Number.isInteger(readyFd) && readyFd >= 3) {
    try {
      writeFileDescriptorSync(readyFd, "ready\n");
    } catch {
      // Readiness notification is best-effort and never affects CLI behavior.
    }
  }

  let runtimePromise: Promise<CliRuntime> | undefined;
  const getRuntime = () => (runtimePromise ??= resolveCliRuntime());
  const cacheDir = path.resolve(invocation.global.cacheDir ?? getCacheDirectory());
  try {
    const output = await dispatch({
      invocation,
      emitter,
      signal: abortController.signal,
      getRuntime,
      cacheDir,
    });
    emitter.success(output.result, { message: output.message });
    return CLI_EXIT_CODES.SUCCESS;
  } catch (error) {
    if (process.env.LITTLESTART_DEBUG && error instanceof Error && error.stack) {
      emitter.log(error.stack);
    }
    const normalized = normalizeCommandError(error, invocation.id, receivedSignal);
    emitter.failure(normalized);
    return normalized.exitCode;
  } finally {
    process.removeListener("SIGINT", handleSignal);
    process.removeListener("SIGTERM", handleSignal);
  }
}

if (require.main === module) {
  void runCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
