import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CliError } from "./protocol";

export const ELEVENLABS_MCP_VERSION = "0.11.0" as const;
export const ELEVENLABS_MCP_PACKAGE = `elevenlabs-mcp==${ELEVENLABS_MCP_VERSION}` as const;
export const ELEVENLABS_MCP_MUSIC_TOOL = "compose_music" as const;
export const ELEVENLABS_MCP_SOUND_EFFECT_TOOL = "text_to_sound_effects" as const;
/** Compatibility alias for callers that ask for the project-wide default tool. */
export const ELEVENLABS_MCP_TOOL = ELEVENLABS_MCP_SOUND_EFFECT_TOOL;
export const ELEVENLABS_MCP_WHEEL_SHA256 =
  "814af638d3df2ec9d76ba2aeb1247ffa47f5ed8f8d11f60953b402667e4b172a" as const;
export const ELEVENLABS_MCP_SOURCE_COMMIT =
  "afc22357432db9e8b33991a83d41906001f6d759" as const;
export const ELEVENLABS_MCP_EXPECTED_TOOL_COUNT = 27 as const;
export const ELEVENLABS_MCP_MUSIC_TOOLS = [
  "compose_music",
  "create_composition_plan",
  "upload_music_for_inpainting",
  "video_to_music",
] as const;
export const ELEVENLABS_MCP_SOUND_EFFECT_TOOLS = [
  ELEVENLABS_MCP_SOUND_EFFECT_TOOL,
] as const;

export type ElevenLabsMcpTool =
  | typeof ELEVENLABS_MCP_MUSIC_TOOL
  | typeof ELEVENLABS_MCP_SOUND_EFFECT_TOOL;

const MCP_PYTHON_ENTRY = "from elevenlabs_mcp.server import mcp; mcp.run()";
const MAX_MCP_STDERR_BYTES = 64 * 1024;
const MAX_MCP_STDOUT_BUFFER_BYTES = 1024 * 1024;
const INITIALIZE_TIMEOUT_MS = 30_000;
const TOOL_TIMEOUT_MS = 15 * 60_000;
const SELF_CHECK_TIMEOUT_MS = 20_000;
const SHUTDOWN_TIMEOUT_MS = 2_000;
const SELF_CHECK_API_KEY = "littlestart-local-self-check-invalid-key";

export type ElevenLabsMcpRuntime = {
  command: string;
  args: readonly string[];
  source: "bundled" | "explicit" | "uvx";
  version: typeof ELEVENLABS_MCP_VERSION;
  /** Whether the executable provenance was actually verified by this resolver. */
  integrity?: "pinned-bundle" | "version-pinned" | "unverified";
};

export type McpContentBlock = {
  type?: string;
  text?: string;
  [key: string]: unknown;
};

export type McpToolCallResult = {
  content: McpContentBlock[];
  isError?: boolean;
  structuredContent?: unknown;
};

export type ElevenLabsMcpInspection = {
  toolCount: number;
  musicTools: string[];
  soundEffectTools: string[];
};

export type ElevenLabsMcpCall = (options: {
  runtime: ElevenLabsMcpRuntime;
  apiKey: string;
  tool: ElevenLabsMcpTool;
  arguments: Readonly<Record<string, unknown>>;
  outputDirectory: string;
  signal?: AbortSignal;
}) => Promise<McpToolCallResult>;

async function isExecutable(file: string): Promise<boolean> {
  const stat = await fs.stat(file).catch(() => null);
  if (!stat?.isFile()) return false;
  if (process.platform === "win32") return true;
  return (stat.mode & 0o111) !== 0;
}

function packagedExecutable(resourcesPath: string): string {
  return path.join(
    path.resolve(resourcesPath),
    "mcp",
    "elevenlabs",
    "darwin-arm64",
    "elevenlabs-mcp",
  );
}

async function hasPinnedBundleManifest(executable: string): Promise<boolean> {
  const manifestPath = path.join(path.dirname(executable), "manifest.json");
  const stat = await fs.lstat(manifestPath).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return false;
  try {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      executable?: unknown;
      server?: Record<string, unknown>;
    };
    return (
      manifest.schemaVersion === 1 &&
      manifest.executable === path.basename(executable) &&
      manifest.server?.distribution === "elevenlabs-mcp" &&
      manifest.server?.version === ELEVENLABS_MCP_VERSION &&
      manifest.server?.sourceCommit === ELEVENLABS_MCP_SOURCE_COMMIT &&
      manifest.server?.wheelSha256 === ELEVENLABS_MCP_WHEEL_SHA256
    );
  } catch {
    return false;
  }
}

export async function resolveElevenLabsMcpRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ElevenLabsMcpRuntime> {
  const explicit = env.LITTLESTART_ELEVENLABS_MCP_EXECUTABLE?.trim();
  if (explicit) {
    const command = path.resolve(explicit);
    if (!(await isExecutable(command))) {
      throw new CliError("MCP_RUNTIME_MISSING", "找不到可执行的 ElevenLabs MCP runtime", {
        hint: "请从 Electron 客户端修复安装，或检查 LITTLESTART_ELEVENLABS_MCP_EXECUTABLE。",
        details: { command },
      });
    }
    const expectedBundled = env.LITTLESTART_ELEVENLABS_MCP_BUNDLED === "1";
    if (expectedBundled) {
      const resourcesPath = env.LITTLESTART_RESOURCES_PATH?.trim();
      const canonical = resourcesPath ? packagedExecutable(resourcesPath) : null;
      if (!canonical || command !== canonical || !(await hasPinnedBundleManifest(command))) {
        throw new CliError("MCP_RUNTIME_FAILED", "ElevenLabs MCP 打包身份验证失败", {
          hint: "请从 Electron 客户端修复 CLI/MCP 安装。",
          details: { command, canonical },
        });
      }
    }
    return {
      command,
      args: [],
      source: expectedBundled ? "bundled" : "explicit",
      version: ELEVENLABS_MCP_VERSION,
      integrity: expectedBundled ? "pinned-bundle" : "unverified",
    };
  }

  const sourceRoot = env.LITTLESTART_SOURCE_ROOT?.trim();
  if (sourceRoot) {
    const executable = process.platform === "win32" ? "elevenlabs-mcp.exe" : "elevenlabs-mcp";
    const candidates = [
      ...(process.platform === "darwin" && process.arch === "arm64"
        ? [
            path.join(
              path.resolve(sourceRoot),
              "mcp",
              "elevenlabs",
              "dist",
              "darwin-arm64",
              executable,
            ),
          ]
        : []),
      path.join(path.resolve(sourceRoot), ".mcp-build", "runtime", "elevenlabs-mcp", executable),
      path.join(path.resolve(sourceRoot), ".mcp-build", "runtime", "elevenlabs-mcp", "elevenlabs-mcp", executable),
    ];
    for (const bundled of candidates) {
      if (await isExecutable(bundled)) {
        return {
          command: bundled,
          args: [],
          source: "bundled",
          version: ELEVENLABS_MCP_VERSION,
          integrity: (await hasPinnedBundleManifest(bundled)) ? "pinned-bundle" : "unverified",
        };
      }
    }
  }

  const resourcesPath = env.LITTLESTART_RESOURCES_PATH?.trim();
  if (resourcesPath && process.platform === "darwin" && process.arch === "arm64") {
    const bundled = packagedExecutable(resourcesPath);
    if (await isExecutable(bundled)) {
      return {
        command: bundled,
        args: [],
        source: "bundled",
        version: ELEVENLABS_MCP_VERSION,
        integrity: (await hasPinnedBundleManifest(bundled)) ? "pinned-bundle" : "unverified",
      };
    }
  }

  return {
    command: env.LITTLESTART_UVX_EXECUTABLE?.trim() || "uvx",
    args: ["--from", ELEVENLABS_MCP_PACKAGE, "python", "-c", MCP_PYTHON_ENTRY],
    source: "uvx",
    version: ELEVENLABS_MCP_VERSION,
    integrity: "version-pinned",
  };
}

function safeChildEnvironment(
  apiKey: string,
  outputDirectory: string,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const allowed = [
    "HOME",
    "USERPROFILE",
    "PATH",
    "TMPDIR",
    "TEMP",
    "TMP",
    "LANG",
    "LC_ALL",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "http_proxy",
    "https_proxy",
    "no_proxy",
  ] as const;
  const env = {} as NodeJS.ProcessEnv;
  for (const name of allowed) {
    if (source[name]) env[name] = source[name];
  }
  env.ELEVENLABS_API_KEY = apiKey;
  env.ELEVENLABS_MCP_BASE_PATH = outputDirectory;
  env.ELEVENLABS_MCP_OUTPUT_MODE = "files";
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  return env;
}

function redactDiagnostic(value: string, apiKey: string): string {
  const exact = apiKey ? value.split(apiKey).join("[REDACTED]") : value;
  return exact.replace(
    /((?:api[_-]?key|authorization|bearer|password|secret|token)\s*[:=]\s*)[^\s,}"']+/gi,
    "$1[REDACTED]",
  );
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string;
  result?: unknown;
  error?: { code?: number; message?: string; data?: unknown };
};

function looksRateLimited(code: number | undefined, message: string): boolean {
  return (
    code === 429 ||
    /(?:\b429\b|rate[_ -]?limit(?:ed|ing)?|too many requests)/i.test(message)
  );
}

function remoteToolError(options: {
  apiKey: string;
  message: string;
  code?: number;
}): CliError {
  const redacted = redactDiagnostic(options.message, options.apiKey).slice(0, 2_000);
  const rateLimited = looksRateLimited(options.code, redacted);
  return new CliError(
    rateLimited ? "REMOTE_RATE_LIMITED" : "REMOTE_REQUEST_FAILED",
    rateLimited ? "ElevenLabs MCP 触发了远程限流" : "ElevenLabs MCP 音频生成失败",
    {
      ...(rateLimited
        ? { hint: "请按 ElevenLabs 返回的等待时间退避，不要并发重试。" }
        : {}),
      details: { ...(options.code === undefined ? {} : { code: options.code }), message: redacted },
    },
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

type ElevenLabsMcpSessionOptions = Parameters<ElevenLabsMcpCall>[0] & {
  listOnly?: boolean;
};

async function runElevenLabsMcpSession(
  options: ElevenLabsMcpSessionOptions,
): Promise<McpToolCallResult | ElevenLabsMcpInspection> {
  if (options.signal?.aborted) {
    throw new CliError("INTERRUPTED", "ElevenLabs MCP 调用已取消", {
      cause: options.signal.reason,
    });
  }
  const childEnv = safeChildEnvironment(options.apiKey, options.outputDirectory);
  if (options.listOnly) {
    // Installer inspection is intentionally local-only. The invalid sentinel
    // credential cannot be used, and loopback proxy endpoints make accidental
    // provider calls fail closed while initialize/tools-list remain available.
    childEnv.HOME = options.outputDirectory;
    childEnv.USERPROFILE = options.outputDirectory;
    childEnv.TMPDIR = options.outputDirectory;
    childEnv.TEMP = options.outputDirectory;
    childEnv.TMP = options.outputDirectory;
    childEnv.ALL_PROXY = "http://127.0.0.1:9";
    childEnv.HTTP_PROXY = "http://127.0.0.1:9";
    childEnv.HTTPS_PROXY = "http://127.0.0.1:9";
    childEnv.NO_PROXY = "";
    childEnv.all_proxy = "http://127.0.0.1:9";
    childEnv.http_proxy = "http://127.0.0.1:9";
    childEnv.https_proxy = "http://127.0.0.1:9";
    childEnv.no_proxy = "";
  }
  const child = spawn(options.runtime.command, [...options.runtime.args], {
    cwd: options.outputDirectory,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdoutBuffer = "";
  let stderr = "";
  let closed = false;
  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: unknown) => void; timer: NodeJS.Timeout }
  >();

  const failPending = (error: unknown) => {
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(error);
    }
    pending.clear();
  };

  const terminate = () => {
    if (!closed) child.kill("SIGTERM");
  };
  const abort = () => {
    const error = new CliError("INTERRUPTED", "ElevenLabs MCP 调用已取消", {
      cause: options.signal?.reason,
    });
    failPending(error);
    terminate();
  };
  options.signal?.addEventListener("abort", abort, { once: true });

  child.stderr.on("data", (chunk: string) => {
    if (stderr.length >= MAX_MCP_STDERR_BYTES) return;
    stderr += chunk.slice(0, MAX_MCP_STDERR_BYTES - stderr.length);
  });
  child.stdout.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    if (Buffer.byteLength(stdoutBuffer) > MAX_MCP_STDOUT_BUFFER_BYTES) {
      failPending(
        new CliError("MCP_PROTOCOL_ERROR", "ElevenLabs MCP 输出了超大或未分行的协议消息"),
      );
      terminate();
      return;
    }
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim().startsWith("{")) continue;
      let message: JsonRpcResponse;
      try {
        message = JSON.parse(line) as JsonRpcResponse;
      } catch {
        continue;
      }
      if (typeof message.id !== "number") continue;
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.error) {
        request.reject(remoteToolError({
          apiKey: options.apiKey,
          code: message.error.code,
          message: message.error.message ?? "MCP error",
        }));
      } else {
        request.resolve(message.result);
      }
    }
  });

  const processFailure = (message: string, cause?: unknown) =>
    new CliError("MCP_RUNTIME_FAILED", message, {
      hint: "请从 Electron 客户端修复 ElevenLabs MCP，或运行 MCP 状态检查。",
      details: stderr
        ? { stderr: redactDiagnostic(stderr, options.apiKey).slice(0, 2_000) }
        : undefined,
      cause,
    });

  child.once("error", (error) => {
    failPending(processFailure("无法启动 ElevenLabs MCP runtime", error));
  });
  child.once("close", (code, signal) => {
    closed = true;
    if (pending.size > 0) {
      failPending(
        processFailure(`ElevenLabs MCP 提前退出（code=${code ?? "null"}, signal=${signal ?? "null"}）`),
      );
    }
  });

  const send = (message: unknown): void => {
    if (!child.stdin.writable) throw processFailure("ElevenLabs MCP stdin 已关闭");
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const request = (method: string, params: unknown, timeoutMs: number): Promise<unknown> => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(
          new CliError("REMOTE_REQUEST_FAILED", `ElevenLabs MCP ${method} 超时`, {
            hint: "避免并发重试；先检查网络和 ElevenLabs 服务状态。",
          }),
        );
        terminate();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      try {
        send({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  };

  try {
    await request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "littlestart", version: "1" },
      },
      options.listOnly ? SELF_CHECK_TIMEOUT_MS : INITIALIZE_TIMEOUT_MS,
    );
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = asRecord(
      await request(
        "tools/list",
        {},
        options.listOnly ? SELF_CHECK_TIMEOUT_MS : INITIALIZE_TIMEOUT_MS,
      ),
    );
    if (!listed) {
      throw new CliError("MCP_PROTOCOL_ERROR", "ElevenLabs MCP tools/list 返回格式无效");
    }
    const tools = Array.isArray(listed?.tools) ? listed.tools : [];
    if (!tools.some((tool) => asRecord(tool)?.name === options.tool)) {
      throw new CliError("MCP_TOOL_MISSING", `官方 MCP 未提供 ${options.tool} 工具`, {
        details: { runtimeVersion: options.runtime.version },
      });
    }
    if (options.listOnly) {
      const names = new Set(
        tools
          .map((tool) => asRecord(tool)?.name)
          .filter((name): name is string => typeof name === "string"),
      );
      const missingRequiredTools = [
        ELEVENLABS_MCP_MUSIC_TOOL,
        ELEVENLABS_MCP_SOUND_EFFECT_TOOL,
      ].filter((name) => !names.has(name));
      if (missingRequiredTools.length > 0) {
        throw new CliError("MCP_TOOL_MISSING", "官方 MCP 缺少一键音频工作流所需工具", {
          details: {
            runtimeVersion: options.runtime.version,
            missingTools: missingRequiredTools,
          },
        });
      }
      return {
        toolCount: tools.length,
        musicTools: ELEVENLABS_MCP_MUSIC_TOOLS.filter((name) => names.has(name)),
        soundEffectTools: ELEVENLABS_MCP_SOUND_EFFECT_TOOLS.filter((name) => names.has(name)),
      };
    }
    const raw = asRecord(
      await request(
        "tools/call",
        { name: options.tool, arguments: options.arguments },
        TOOL_TIMEOUT_MS,
      ),
    );
    if (!raw) {
      throw new CliError("MCP_PROTOCOL_ERROR", "ElevenLabs MCP tools/call 返回格式无效");
    }
    const result: McpToolCallResult = {
      content: Array.isArray(raw?.content)
        ? raw.content.filter((entry): entry is McpContentBlock => asRecord(entry) !== null)
        : [],
      ...(raw?.isError === true ? { isError: true } : {}),
      ...(Object.hasOwn(raw, "structuredContent")
        ? { structuredContent: raw.structuredContent }
        : {}),
    };
    if (result.isError) {
      const text = result.content
        .map((entry) => (typeof entry.text === "string" ? entry.text : ""))
        .filter(Boolean)
        .join("\n");
      throw remoteToolError({ apiKey: options.apiKey, message: text || "MCP tool error" });
    }
    return result;
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (child.stdin.writable) child.stdin.end();
    if (!closed) {
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
      ]);
      if (!closed) child.kill("SIGTERM");
      await Promise.race([
        new Promise<void>((resolve) => child.once("close", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
      if (!closed) child.kill("SIGKILL");
    }
  }
}

export const callElevenLabsMcpTool: ElevenLabsMcpCall = async (options) =>
  runElevenLabsMcpSession(options) as Promise<McpToolCallResult>;

/**
 * Starts the resolved MCP and performs initialize + tools/list only. This is
 * deliberately incapable of sending tools/call, so installer self-checks
 * exercise the real Node-to-sidecar stdio path without consuming credits.
 */
export async function inspectElevenLabsMcpRuntime(
  runtime: ElevenLabsMcpRuntime,
  options: { signal?: AbortSignal } = {},
): Promise<ElevenLabsMcpInspection> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-mcp-self-check-"));
  try {
    return await runElevenLabsMcpSession({
      runtime,
      apiKey: SELF_CHECK_API_KEY,
      tool: ELEVENLABS_MCP_TOOL,
      arguments: {},
      outputDirectory: directory,
      signal: options.signal,
      listOnly: true,
    }) as ElevenLabsMcpInspection;
  } finally {
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
  }
}
