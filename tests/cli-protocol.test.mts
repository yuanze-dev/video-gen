import assert from "node:assert/strict";
import test from "node:test";
import {
  CLI_ERROR_EXIT_CODES,
  CLI_EXIT_CODES,
  CLI_PROTOCOL_VERSION,
  CliError,
  asCliError,
  createCliEmitter,
  createFailureEnvelope,
  createSuccessEnvelope,
} from "../cli/protocol.ts";

function sink(isTTY = false) {
  let contents = "";
  return {
    isTTY,
    write(chunk: string) {
      contents += chunk;
    },
    read() {
      return contents;
    },
  };
}

test("exports a stable protocol version and category exit codes", () => {
  assert.equal(CLI_PROTOCOL_VERSION, "1");
  assert.equal(CLI_ERROR_EXIT_CODES.UNKNOWN_OPTION, CLI_EXIT_CODES.USAGE_ERROR);
  assert.equal(CLI_ERROR_EXIT_CODES.CONFIG_INVALID, CLI_EXIT_CODES.CONFIG_ERROR);
  assert.equal(CLI_ERROR_EXIT_CODES.PRODUCTION_GUARD_FAILED, CLI_EXIT_CODES.CONFIG_ERROR);
  assert.equal(CLI_ERROR_EXIT_CODES.ASSET_NOT_FOUND, CLI_EXIT_CODES.ASSET_ERROR);
  assert.equal(CLI_ERROR_EXIT_CODES.DEPENDENCY_MISSING, CLI_EXIT_CODES.ENVIRONMENT_ERROR);
  assert.equal(CLI_ERROR_EXIT_CODES.RENDER_FAILED, CLI_EXIT_CODES.RENDER_ERROR);
  assert.equal(CLI_ERROR_EXIT_CODES.OUTPUT_EXISTS, CLI_EXIT_CODES.OUTPUT_ERROR);
  assert.equal(
    CLI_ERROR_EXIT_CODES.BATCH_PARTIAL_FAILURE,
    CLI_EXIT_CODES.BATCH_PARTIAL_FAILURE,
  );
  assert.equal(CLI_ERROR_EXIT_CODES.INTERRUPTED, 130);
  assert.equal(CLI_ERROR_EXIT_CODES.TERMINATED, 143);
});

test("CliError carries stable automation fields and preserves its cause", () => {
  const cause = new Error("disk failure");
  const error = new CliError("OUTPUT_WRITE_FAILED", "无法写入文件", {
    cause,
    hint: "检查目录权限。",
    issues: [{ path: "output", message: "目录不可写", code: "EACCES" }],
  });

  assert.equal(error.name, "CliError");
  assert.equal(error.code, "OUTPUT_WRITE_FAILED");
  assert.equal(error.exitCode, CLI_EXIT_CODES.OUTPUT_ERROR);
  assert.equal(error.hint, "检查目录权限。");
  assert.equal(error.cause, cause);
  assert.deepEqual(error.issues, [
    { path: "output", message: "目录不可写", code: "EACCES" },
  ]);
  assert.throws(() => {
    (error.issues as Array<unknown>).push({});
  }, TypeError);
});

test("asCliError preserves known errors and wraps unknown failures", () => {
  const known = new CliError("CONFIG_INVALID", "配置无效");
  assert.equal(asCliError(known), known);

  const cause = new Error("boom");
  const wrapped = asCliError(cause, {
    code: "RENDER_FAILED",
    hint: "查看渲染日志。",
  });
  assert.equal(wrapped.code, "RENDER_FAILED");
  assert.equal(wrapped.message, "boom");
  assert.equal(wrapped.cause, cause);
  assert.equal(wrapped.hint, "查看渲染日志。");
});

test("success and failure envelopes never expose implementation causes", () => {
  assert.deepEqual(createSuccessEnvelope({ output: "/tmp/video.mp4" }, { command: "render" }), {
    protocolVersion: "1",
    ok: true,
    command: "render",
    result: { output: "/tmp/video.mp4" },
  });

  const failure = createFailureEnvelope(
    new CliError("ASSET_NOT_FOUND", "找不到素材", {
      cause: new Error("private path"),
      hint: "检查相对路径。",
      issues: [{ path: "spec.background.path", message: "文件不存在" }],
    }),
    { command: "validate" },
  );
  assert.deepEqual(failure, {
    protocolVersion: "1",
    ok: false,
    command: "validate",
    error: {
      code: "ASSET_NOT_FOUND",
      message: "找不到素材",
      exitCode: 4,
      hint: "检查相对路径。",
      issues: [{ path: "spec.background.path", message: "文件不存在" }],
    },
  });
  assert.equal(JSON.stringify(failure).includes("private path"), false);
});

test("JSON emitter keeps one machine document on stdout and diagnostics on stderr", () => {
  const stdout = sink();
  const stderr = sink();
  const emitter = createCliEmitter({
    mode: "json",
    command: "render",
    stdout,
    stderr,
    color: false,
  });

  emitter.log("准备渲染");
  emitter.started({ input: "video.json" });
  emitter.progress(0.25, { stage: "render", message: "渲染 25%" });
  emitter.warn({ code: "FONT_FALLBACK", message: "使用了后备字体" });
  const envelope = emitter.success({ output: "/tmp/video.mp4" });

  assert.equal(emitter.isFinalized, true);
  assert.deepEqual(JSON.parse(stdout.read()), envelope);
  assert.deepEqual(envelope, {
    protocolVersion: "1",
    ok: true,
    command: "render",
    result: { output: "/tmp/video.mp4" },
    warnings: [{ code: "FONT_FALLBACK", message: "使用了后备字体" }],
  });
  assert.equal(stderr.read(), "准备渲染\n渲染 25%\n警告: 使用了后备字体\n");
  assert.equal(stdout.read().trim().split("\n").filter((line) => line.startsWith("准备")).length, 0);
});

test("NDJSON emitter streams ordered events and a final result", () => {
  const stdout = sink();
  const stderr = sink();
  const emitter = createCliEmitter({
    mode: "ndjson",
    command: "batch",
    stdout,
    stderr,
    color: false,
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  });

  emitter.started({ total: 2 });
  emitter.progress(0.5, { current: 1, total: 2, stage: "render" });
  emitter.warn("第二项会覆盖缓存");
  emitter.success({ completed: 2 });

  const events = stdout
    .read()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    events.map((event) => [event.sequence, event.event]),
    [
      [1, "started"],
      [2, "progress"],
      [3, "warning"],
      [4, "result"],
    ],
  );
  assert.equal(events.every((event) => event.protocolVersion === "1"), true);
  assert.equal(events.every((event) => event.command === "batch"), true);
  assert.equal(events.every((event) => event.timestamp === "2026-07-15T00:00:00.000Z"), true);
  assert.deepEqual(events[1].data, {
    ratio: 0.5,
    percent: 50,
    current: 1,
    total: 2,
    stage: "render",
  });
  assert.equal(events[3].data.ok, true);
  assert.deepEqual(events[3].data.result, { completed: 2 });
  assert.equal(stderr.read(), "警告: 第二项会覆盖缓存\n");
});

test("failure emits a machine envelope and always keeps a concise stderr diagnostic", () => {
  const stdout = sink();
  const stderr = sink();
  const emitter = createCliEmitter({
    mode: "json",
    command: "validate",
    stdout,
    stderr,
    quiet: true,
    color: false,
  });
  emitter.log("not visible");
  emitter.warn("also not visible");
  const normalized = emitter.failure(
    new CliError("CONFIG_INVALID", "配置校验失败", {
      hint: "运行 config schema 查看字段。",
      issues: [{ path: "canvas.fps", message: "必须是 30 或 60" }],
    }),
  );

  assert.equal(normalized.exitCode, 3);
  const output = JSON.parse(stdout.read());
  assert.equal(output.ok, false);
  assert.equal(output.error.code, "CONFIG_INVALID");
  assert.deepEqual(output.warnings, [{ message: "also not visible" }]);
  assert.equal(stderr.read().includes("错误 [CONFIG_INVALID]: 配置校验失败"), true);
  assert.equal(stderr.read().includes("canvas.fps"), true);
  assert.equal(stderr.read().includes("not visible"), false);
});

test("diagnostic issue values cannot break machine error reporting", () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const stdout = sink();
  const stderr = sink();
  const emitter = createCliEmitter({ mode: "ndjson", stdout, stderr, color: false });

  emitter.warn({ message: "循环值", value: circular });
  emitter.failure(
    new CliError("CONFIG_INVALID", "值无效", {
      issues: [{ message: "BigInt 值", value: 42n }],
    }),
  );

  const events = stdout
    .read()
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.equal(events[0].event, "warning");
  assert.equal(typeof events[0].data.value, "string");
  assert.equal(events[1].event, "error");
  assert.equal(events[1].data.error.issues[0].value, "42");
});

test("human mode is readable and never adds ANSI color to non-TTY sinks", () => {
  const stdout = sink();
  const stderr = sink(false);
  const emitter = createCliEmitter({ mode: "human", stdout, stderr, color: true });
  emitter.log("检查环境");
  emitter.success({ ok: true }, { message: "完成 → output/video.mp4" });

  assert.equal(stdout.read(), "完成 → output/video.mp4\n");
  assert.equal(stderr.read(), "检查环境\n");
  assert.equal(stdout.read().includes("\u001B"), false);
  assert.equal(stderr.read().includes("\u001B"), false);
});

test("emitter rejects invalid progress and output after a final event", () => {
  const emitter = createCliEmitter({ stdout: sink(), stderr: sink(), color: false });
  assert.throws(
    () => emitter.progress(1.01),
    (error: unknown) => error instanceof CliError && error.code === "PROTOCOL_VIOLATION",
  );
  emitter.success(undefined);
  assert.throws(
    () => emitter.log("too late"),
    (error: unknown) => error instanceof CliError && error.code === "PROTOCOL_VIOLATION",
  );
});
