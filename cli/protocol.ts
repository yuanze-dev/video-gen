/**
 * Stable, machine-readable protocol primitives for the CLI.
 *
 * stdout is reserved for command results and NDJSON events. Human-facing
 * diagnostics always go to stderr, which lets agents and CI parse stdout
 * without having to strip progress messages first.
 */

export const CLI_PROTOCOL_VERSION = "1" as const;

export const CLI_EXIT_CODES = {
  SUCCESS: 0,
  INTERNAL_ERROR: 1,
  USAGE_ERROR: 2,
  CONFIG_ERROR: 3,
  ASSET_ERROR: 4,
  ENVIRONMENT_ERROR: 5,
  RENDER_ERROR: 6,
  OUTPUT_ERROR: 7,
  BATCH_PARTIAL_FAILURE: 10,
  INTERRUPTED: 130,
  TERMINATED: 143,
} as const;

export type CliExitCode = (typeof CLI_EXIT_CODES)[keyof typeof CLI_EXIT_CODES];

/**
 * Error codes are API: rename or remove one only in a new protocol version.
 * New codes may be added without changing the protocol version.
 */
export const CLI_ERROR_EXIT_CODES = {
  INTERNAL_ERROR: CLI_EXIT_CODES.INTERNAL_ERROR,
  PROTOCOL_VIOLATION: CLI_EXIT_CODES.INTERNAL_ERROR,

  UNKNOWN_COMMAND: CLI_EXIT_CODES.USAGE_ERROR,
  UNKNOWN_OPTION: CLI_EXIT_CODES.USAGE_ERROR,
  OPTION_NOT_ALLOWED: CLI_EXIT_CODES.USAGE_ERROR,
  OPTION_VALUE_REQUIRED: CLI_EXIT_CODES.USAGE_ERROR,
  INVALID_OPTION_VALUE: CLI_EXIT_CODES.USAGE_ERROR,
  DUPLICATE_OPTION: CLI_EXIT_CODES.USAGE_ERROR,
  OPTION_CONFLICT: CLI_EXIT_CODES.USAGE_ERROR,
  MISSING_ARGUMENT: CLI_EXIT_CODES.USAGE_ERROR,
  TOO_MANY_ARGUMENTS: CLI_EXIT_CODES.USAGE_ERROR,

  CONFIG_INVALID: CLI_EXIT_CODES.CONFIG_ERROR,
  PRODUCTION_GUARD_FAILED: CLI_EXIT_CODES.CONFIG_ERROR,
  CONFIG_READ_FAILED: CLI_EXIT_CODES.CONFIG_ERROR,
  CONFIG_WRITE_FAILED: CLI_EXIT_CODES.CONFIG_ERROR,

  ASSET_NOT_FOUND: CLI_EXIT_CODES.ASSET_ERROR,
  ASSET_UNREADABLE: CLI_EXIT_CODES.ASSET_ERROR,
  ASSET_UNSUPPORTED: CLI_EXIT_CODES.ASSET_ERROR,

  ENVIRONMENT_UNSUPPORTED: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  DEPENDENCY_MISSING: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  OFFLINE_RESOURCE_MISSING: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  AUTH_REQUIRED: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  MCP_RUNTIME_MISSING: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  MCP_RUNTIME_FAILED: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  MCP_TOOL_MISSING: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  MCP_PROTOCOL_ERROR: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  REMOTE_REQUEST_FAILED: CLI_EXIT_CODES.ENVIRONMENT_ERROR,
  REMOTE_RATE_LIMITED: CLI_EXIT_CODES.ENVIRONMENT_ERROR,

  RENDER_FAILED: CLI_EXIT_CODES.RENDER_ERROR,
  RENDER_CANCELLED: CLI_EXIT_CODES.INTERRUPTED,

  OUTPUT_EXISTS: CLI_EXIT_CODES.OUTPUT_ERROR,
  OUTPUT_WRITE_FAILED: CLI_EXIT_CODES.OUTPUT_ERROR,
  OUTPUT_INVALID: CLI_EXIT_CODES.OUTPUT_ERROR,

  BATCH_PARTIAL_FAILURE: CLI_EXIT_CODES.BATCH_PARTIAL_FAILURE,
  INTERRUPTED: CLI_EXIT_CODES.INTERRUPTED,
  TERMINATED: CLI_EXIT_CODES.TERMINATED,
} as const satisfies Record<string, CliExitCode>;

export type CliErrorCode = keyof typeof CLI_ERROR_EXIT_CODES;

export interface CliIssue {
  readonly message: string;
  readonly code?: string;
  /** A config path such as `spec.content.background.path` or `argv[2]`. */
  readonly path?: string;
  readonly hint?: string;
  readonly value?: unknown;
}

export interface CliErrorOptions {
  readonly issues?: readonly CliIssue[];
  readonly hint?: string;
  /** JSON-safe structured context, for example a partial batch summary. */
  readonly details?: unknown;
  readonly cause?: unknown;
}

/** An operational error whose code and exit status are safe for automation. */
export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: CliExitCode;
  readonly issues: readonly CliIssue[];
  readonly hint?: string;
  readonly details?: unknown;
  override readonly cause?: unknown;

  constructor(code: CliErrorCode, message: string, options: CliErrorOptions = {}) {
    super(message);
    this.name = "CliError";
    this.code = code;
    this.exitCode = CLI_ERROR_EXIT_CODES[code];
    this.issues = Object.freeze(
      (options.issues ?? []).map((issue) => Object.freeze({ ...issue })),
    );
    this.hint = options.hint;
    this.details = options.details;
    this.cause = options.cause;
  }
}

export function isCliError(value: unknown): value is CliError {
  return value instanceof CliError;
}

export interface NormalizeCliErrorOptions {
  readonly code?: CliErrorCode;
  readonly message?: string;
  readonly hint?: string;
}

/** Preserve known CLI errors and safely wrap everything else. */
export function asCliError(
  error: unknown,
  options: NormalizeCliErrorOptions = {},
): CliError {
  if (isCliError(error)) return error;

  const message =
    options.message ??
    (error instanceof Error && error.message.trim() !== ""
      ? error.message
      : typeof error === "string" && error.trim() !== ""
        ? error
        : "发生了未预期的错误");

  return new CliError(options.code ?? "INTERNAL_ERROR", message, {
    hint: options.hint,
    cause: error,
  });
}

export interface CliEnvelopeContext {
  readonly command?: string;
  readonly warnings?: readonly CliIssue[];
}

interface CliEnvelopeBase {
  readonly protocolVersion: typeof CLI_PROTOCOL_VERSION;
  readonly command?: string;
  readonly warnings?: readonly CliIssue[];
}

export interface CliSuccessEnvelope<T = unknown> extends CliEnvelopeBase {
  readonly ok: true;
  readonly result: T;
}

export interface CliFailureDetails {
  readonly code: CliErrorCode;
  readonly message: string;
  readonly exitCode: CliExitCode;
  readonly issues?: readonly CliIssue[];
  readonly hint?: string;
  readonly details?: unknown;
}

export interface CliFailureEnvelope extends CliEnvelopeBase {
  readonly ok: false;
  readonly error: CliFailureDetails;
}

function safeIssueValue(value: unknown): unknown {
  try {
    const serialized = JSON.stringify(value);
    if (serialized !== undefined) return JSON.parse(serialized) as unknown;
  } catch {
    // Fall through to a compact diagnostic representation. Error reporting
    // itself must never fail because a rejected value was circular or BigInt.
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Error) return { name: value.name, message: value.message };
  try {
    return String(value);
  } catch {
    return "[不可序列化的值]";
  }
}

function copyIssues(
  warnings: readonly CliIssue[] | undefined,
): readonly CliIssue[] | undefined {
  if (!warnings || warnings.length === 0) return undefined;
  return warnings.map(({ value, ...warning }) => ({
    ...warning,
    ...(value === undefined ? {} : { value: safeIssueValue(value) }),
  }));
}

export function createSuccessEnvelope<T>(
  result: T,
  context: CliEnvelopeContext = {},
): CliSuccessEnvelope<T> {
  const warnings = copyIssues(context.warnings);
  return {
    protocolVersion: CLI_PROTOCOL_VERSION,
    ok: true,
    ...(context.command ? { command: context.command } : {}),
    result,
    ...(warnings ? { warnings } : {}),
  };
}

export function createFailureEnvelope(
  error: unknown,
  context: CliEnvelopeContext = {},
): CliFailureEnvelope {
  const normalized = asCliError(error);
  const warnings = copyIssues(context.warnings);
  const issues = copyIssues(normalized.issues);
  return {
    protocolVersion: CLI_PROTOCOL_VERSION,
    ok: false,
    ...(context.command ? { command: context.command } : {}),
    error: {
      code: normalized.code,
      message: normalized.message,
      exitCode: normalized.exitCode,
      ...(issues ? { issues } : {}),
      ...(normalized.hint ? { hint: normalized.hint } : {}),
      ...(normalized.details === undefined
        ? {}
        : { details: safeIssueValue(normalized.details) }),
    },
    ...(warnings ? { warnings } : {}),
  };
}

export type CliOutputMode = "human" | "json" | "ndjson";
export type CliEventName = "started" | "progress" | "warning" | "result" | "error";

export interface CliEvent<T = unknown> {
  readonly protocolVersion: typeof CLI_PROTOCOL_VERSION;
  readonly sequence: number;
  readonly timestamp: string;
  readonly event: CliEventName;
  readonly command?: string;
  readonly data: T;
}

export interface CliWritable {
  write(chunk: string): unknown;
  readonly isTTY?: boolean;
}

export interface CreateCliEmitterOptions {
  readonly mode?: CliOutputMode;
  readonly command?: string;
  readonly stdout?: CliWritable;
  readonly stderr?: CliWritable;
  /** Suppresses informational diagnostics; final errors are never hidden. */
  readonly quiet?: boolean;
  /** ANSI color is used only when both this and stderr.isTTY are true. */
  readonly color?: boolean;
  readonly now?: () => Date;
}

export interface CliFinalOutputOptions {
  /** Human-mode text. Machine modes always emit the stable envelope. */
  readonly message?: string;
}

export interface CliProgressDetails {
  readonly stage?: string;
  readonly message?: string;
  readonly current?: number;
  readonly total?: number;
  readonly [key: string]: unknown;
}

export interface CliEmitter {
  readonly mode: CliOutputMode;
  readonly isFinalized: boolean;
  log(message: string): void;
  warn(issue: CliIssue | string): void;
  started(data?: unknown): void;
  progress(ratio: number, details?: CliProgressDetails): void;
  success<T>(result: T, options?: CliFinalOutputOptions): CliSuccessEnvelope<T>;
  failure(error: unknown): CliError;
}

function serializeJson(value: unknown, pretty: boolean): string {
  try {
    const serialized = JSON.stringify(value, null, pretty ? 2 : undefined);
    if (serialized === undefined) {
      throw new TypeError("JSON.stringify returned undefined");
    }
    return serialized;
  } catch (error) {
    throw new CliError("PROTOCOL_VIOLATION", "无法将 CLI 结果序列化为 JSON", {
      hint: "请确保结果中不包含 BigInt、循环引用或其他不可序列化的值。",
      cause: error,
    });
  }
}

function paint(enabled: boolean, code: 31 | 33, text: string): string {
  return enabled ? `\u001B[${code}m${text}\u001B[0m` : text;
}

function humanFailure(error: CliError, color: boolean): string {
  const lines = [
    `${paint(color, 31, "错误")} [${error.code}]: ${error.message}`,
    ...error.issues.map((issue) => {
      const location = issue.path ? `${issue.path}: ` : "";
      return `  - ${location}${issue.message}${issue.hint ? `（${issue.hint}）` : ""}`;
    }),
    ...(error.hint ? [`${paint(color, 33, "提示")}: ${error.hint}`] : []),
  ];
  return `${lines.join("\n")}\n`;
}

export function createCliEmitter(options: CreateCliEmitterOptions = {}): CliEmitter {
  const mode = options.mode ?? "human";
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  const quiet = options.quiet ?? false;
  const color = (options.color ?? true) && stderr.isTTY === true;
  const now = options.now ?? (() => new Date());
  const warnings: CliIssue[] = [];
  let sequence = 0;
  let finalized = false;

  const ensureOpen = (): void => {
    if (finalized) {
      throw new CliError("PROTOCOL_VIOLATION", "CLI 已输出最终结果，不能继续写入事件", {
        hint: "每次 CLI 调用只能输出一个 result 或 error 终态。",
      });
    }
  };

  const event = (name: CliEventName, data: unknown): void => {
    ensureOpen();
    if (mode !== "ndjson") return;
    const payload: CliEvent = {
      protocolVersion: CLI_PROTOCOL_VERSION,
      sequence: ++sequence,
      timestamp: now().toISOString(),
      event: name,
      ...(options.command ? { command: options.command } : {}),
      data,
    };
    stdout.write(`${serializeJson(payload, false)}\n`);
  };

  const emitter: CliEmitter = {
    mode,
    get isFinalized() {
      return finalized;
    },
    log(message) {
      ensureOpen();
      if (!quiet) stderr.write(`${message}\n`);
    },
    warn(issueOrMessage) {
      ensureOpen();
      const issue =
        typeof issueOrMessage === "string"
          ? { message: issueOrMessage }
          : copyIssues([issueOrMessage])?.[0] ?? { message: issueOrMessage.message };
      warnings.push(issue);
      if (!quiet) stderr.write(`${paint(color, 33, "警告")}: ${issue.message}\n`);
      event("warning", issue);
    },
    started(data = {}) {
      event("started", data);
    },
    progress(ratio, details = {}) {
      if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
        throw new CliError("PROTOCOL_VIOLATION", "进度必须是 0 到 1 之间的有限数字", {
          issues: [{ path: "progress.ratio", message: `收到 ${String(ratio)}`, value: ratio }],
        });
      }
      const roundedRatio = Math.round(ratio * 1_000_000) / 1_000_000;
      event("progress", {
        ...details,
        ratio: roundedRatio,
        percent: Math.round(roundedRatio * 10_000) / 100,
      });
      // JSON is a single-document mode, so live progress stays on stderr.
      // NDJSON already carries the same message in its progress event.
      if (mode !== "ndjson" && !quiet && details.message) {
        stderr.write(`${details.message}\n`);
      }
    },
    success(result, finalOptions = {}) {
      ensureOpen();
      const envelope = createSuccessEnvelope(result, {
        command: options.command,
        warnings,
      });

      // Serialize before setting finalized so callers can still emit a clean
      // protocol error when a result is accidentally not JSON-safe.
      if (mode === "json") {
        const serialized = serializeJson(envelope, true);
        stdout.write(`${serialized}\n`);
      } else if (mode === "ndjson") {
        event("result", envelope);
      } else if (finalOptions.message) {
        stdout.write(`${finalOptions.message}\n`);
      } else if (typeof result === "string") {
        stdout.write(`${result}\n`);
      } else if (result !== undefined) {
        stdout.write(`${serializeJson(result, true)}\n`);
      }

      finalized = true;
      return envelope;
    },
    failure(error) {
      ensureOpen();
      const normalized = asCliError(error);
      const envelope = createFailureEnvelope(normalized, {
        command: options.command,
        warnings,
      });

      if (mode === "json") {
        stdout.write(`${serializeJson(envelope, true)}\n`);
      } else if (mode === "ndjson") {
        event("error", envelope);
      }
      stderr.write(humanFailure(normalized, color));
      finalized = true;
      return normalized;
    },
  };

  return emitter;
}
