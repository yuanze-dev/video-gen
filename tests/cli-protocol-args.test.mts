import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// Production TypeScript uses bundler-style extensionless imports. Bundle this
// test subject in memory so node --experimental-strip-types can execute it
// without changing the repository's TypeScript module-resolution policy.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const bundle = await build({
  entryPoints: [path.join(root, "cli", "args.ts")],
  bundle: true,
  write: false,
  platform: "node",
  format: "esm",
  target: "node20",
  logLevel: "silent",
});
const argsModule = await import(
  `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].contents).toString("base64")}`
);
const { detectCliBootstrapOptions, parseCliArgs } = argsModule;

function parse(argv: readonly string[]) {
  return parseCliArgs(argv, { env: {} });
}

function expectCliError(argv: readonly string[], code: string) {
  try {
    parse(argv);
    assert.fail(`Expected ${code} for: ${argv.join(" ")}`);
  } catch (error) {
    assert.equal((error as { code?: string }).code, code);
    assert.equal(typeof (error as { exitCode?: number }).exitCode, "number");
    return error as { code: string; message: string; hint?: string; issues: unknown[] };
  }
}

test("covers every planned top-level and grouped command", () => {
  const cases: Array<[readonly string[], string, readonly string[]]> = [
    [["version"], "version", ["version"]],
    [["doctor"], "doctor", ["doctor"]],
    [["capabilities"], "capabilities", ["capabilities"]],
    [["init"], "init", ["init"]],
    [["validate", "video.json"], "validate", ["validate"]],
    [["plan", "video.json"], "plan", ["plan"]],
    [["produce", "video.json"], "produce", ["produce"]],
    [["render", "video.json"], "render", ["render"]],
    [["still", "video.json"], "still", ["still"]],
    [["probe", "clip.mp4"], "probe", ["probe"]],
    [["audio", "plan", "video.json", "--prompt", "quiet room ambience"], "audio.plan", ["audio", "plan"]],
    [["audio", "generate", "video.json", "--prompt", "quiet room ambience"], "audio.generate", ["audio", "generate"]],
    [["config", "schema"], "config.schema", ["config", "schema"]],
    [["config", "resolve", "video.json"], "config.resolve", ["config", "resolve"]],
    [["config", "lock", "video.json"], "config.lock", ["config", "lock"]],
    [["config", "migrate", "video.json"], "config.migrate", ["config", "migrate"]],
    [["templates"], "templates.list", ["templates", "list"]],
    [["templates", "show", "teleprompter@1"], "templates.show", ["templates", "show"]],
    [["assets"], "assets.list", ["assets", "list"]],
    [["assets", "inspect", "airport"], "assets.inspect", ["assets", "inspect"]],
    [["cache"], "cache.list", ["cache", "list"]],
    [["cache", "prune"], "cache.prune", ["cache", "prune"]],
    [["cache", "clear", "--force"], "cache.clear", ["cache", "clear"]],
    [["batch", "jobs.json", "--out-dir", "output"], "batch", ["batch"]],
    [["help"], "help", ["help"]],
  ];

  for (const [argv, id, commandPath] of cases) {
    const invocation = parse(argv);
    assert.equal(invocation.id, id, argv.join(" "));
    assert.deepEqual(invocation.commandPath, commandPath, argv.join(" "));
  }
});

test("global flags work before and after commands and normalize their values", () => {
  const invocation = parse([
    "--offline",
    "--cache-dir=/tmp/littlestart-cache",
    "render",
    "video.json",
    "--quality",
    "standard",
    "--resolution=720p",
    "--fps",
    "30",
    "--out",
    "video.mp4",
    "--quiet",
    "--no-color",
    "--json",
  ]);

  assert.deepEqual(invocation.global, {
    outputMode: "json",
    json: true,
    quiet: true,
    color: false,
    cacheDir: "/tmp/littlestart-cache",
    offline: true,
  });
  assert.deepEqual(invocation.positionals, ["video.json"]);
  assert.deepEqual(invocation.options, {
    quality: "standard",
    resolution: "720p",
    fps: 30,
    out: "video.mp4",
  });
});

test("events select NDJSON mode and conflict with single-document JSON", () => {
  const invocation = parse(["doctor", "--events", "ndjson"]);
  assert.equal(invocation.global.outputMode, "ndjson");
  assert.equal(invocation.global.events, "ndjson");
  assert.equal(invocation.global.json, false);

  expectCliError(["doctor", "--events", "ndjson", "--json"], "OPTION_CONFLICT");
  expectCliError(["doctor", "--events", "json"], "INVALID_OPTION_VALUE");
});

test("doctor audio probe and representative still progress are strictly parsed", () => {
  assert.deepEqual(parse(["doctor", "--audio"]).options, { audio: true });
  assert.deepEqual(
    parse(["still", "video.json", "--scene", "content", "--progress", "0.4"]).options,
    { scene: "content", progress: 0.4 },
  );
  expectCliError(
    ["still", "video.json", "--scene", "content", "--progress", "-0.01"],
    "INVALID_OPTION_VALUE",
  );
  expectCliError(
    ["still", "video.json", "--scene", "content", "--progress", "1.01"],
    "INVALID_OPTION_VALUE",
  );
});

test("bootstrap detection preserves machine output for parser failures", () => {
  assert.deepEqual(
    detectCliBootstrapOptions(["--json", "render", "video.json", "--unknown"], { env: {} }),
    { outputMode: "json", quiet: false, color: true },
  );
  assert.deepEqual(
    detectCliBootstrapOptions(["render", "video.json", "--events=ndjson", "--quiet"], {
      env: {},
    }),
    { outputMode: "ndjson", quiet: true, color: true },
  );
  assert.equal(
    detectCliBootstrapOptions(["--events", "ndjson", "--json"], { env: {} }).outputMode,
    "json",
  );
  assert.equal(
    detectCliBootstrapOptions(["probe", "--", "--json"], { env: {} }).outputMode,
    "human",
  );
});

test("NO_COLOR convention and explicit --no-color disable color", () => {
  assert.equal(parseCliArgs(["doctor"], { env: { NO_COLOR: "1" } }).global.color, false);
  assert.equal(parse(["doctor", "--no-color"]).global.color, false);
  assert.equal(parse(["doctor"]).global.color, true);
});

test("rejects unknown, duplicate, misplaced, and valueless options before execution", () => {
  const unknown = expectCliError(["render", "video.json", "--quailty", "high"], "UNKNOWN_OPTION");
  assert.equal(unknown.hint?.includes("--quality"), true);
  expectCliError(["render", "video.json", "--fps"], "OPTION_VALUE_REQUIRED");
  expectCliError(["render", "video.json", "--fps", "--json"], "OPTION_VALUE_REQUIRED");
  expectCliError(["render", "video.json", "--force=true"], "INVALID_OPTION_VALUE");
  expectCliError(["render", "video.json", "--fps", "30", "--fps=60"], "DUPLICATE_OPTION");
  expectCliError(["validate", "video.json", "--out", "result.json"], "OPTION_NOT_ALLOWED");
  expectCliError(["doctor", "-q"], "UNKNOWN_OPTION");
});

test("validates enum and bounded integer option values", () => {
  expectCliError(["render", "video.json", "--quality", "ultra"], "INVALID_OPTION_VALUE");
  expectCliError(["render", "video.json", "--resolution", "4k"], "INVALID_OPTION_VALUE");
  expectCliError(["render", "video.json", "--fps", "24"], "INVALID_OPTION_VALUE");
  expectCliError(["batch", "jobs.json", "--out-dir", "out", "--jobs", "0"], "INVALID_OPTION_VALUE");
  expectCliError(["batch", "jobs.json", "--out-dir", "out", "--jobs", "-1"], "INVALID_OPTION_VALUE");
  expectCliError(["batch", "jobs.json", "--out-dir", "out", "--jobs", "33"], "INVALID_OPTION_VALUE");

  const invocation = parse([
    "batch",
    "jobs.json",
    "--out-dir",
    "out",
    "--jobs",
    "8",
    "--resume",
  ]);
  assert.deepEqual(invocation.options, { outDir: "out", jobs: 8, resume: true });

  assert.deepEqual(
    parse([
      "config",
      "lock",
      "video.json",
      "--quality",
      "small",
      "--resolution",
      "720p",
      "--fps",
      "30",
    ]).options,
    { quality: "small", resolution: "720p", fps: 30 },
  );
  assert.deepEqual(
    parse(["plan", "video.json", "--resolution", "720p", "--fps", "30"]).options,
    { resolution: "720p", fps: 30 },
  );
});

test("audio options are strict, bounded, and default-safe", () => {
  const invocation = parse([
    "audio",
    "generate",
    "video.json",
    "--prompt",
    "warm minimal instrumental",
    "--duration",
    "12.5",
    "--volume",
    "0.2",
    "--provider",
    "elevenlabs",
    "--audio-kind",
    "music",
    "--model",
    "music_v2",
    "--out",
    "assets/bgm.mp3",
    "--manifest",
    "assets/bgm.manifest.json",
  ]);
  assert.deepEqual(invocation.options, {
    prompt: "warm minimal instrumental",
    duration: 12.5,
    volume: 0.2,
    provider: "elevenlabs",
    audioKind: "music",
    model: "music_v2",
    out: "assets/bgm.mp3",
    manifest: "assets/bgm.manifest.json",
  });

  expectCliError(["audio", "plan", "video.json"], "MISSING_ARGUMENT");
  assert.deepEqual(
    parse(["audio", "plan", "video.json", "--prompt", "room tone", "--duration", "2.9"]).options,
    { prompt: "room tone", duration: 2.9 },
  );
  expectCliError(
    ["produce", "video.json", "--bgm-prompt", "warm award ceremony score"],
    "OPTION_CONFLICT",
  );
  assert.deepEqual(
    parse([
      "produce",
      "video.json",
      "--bgm-prompt",
      "warm award ceremony score",
      "--audio-kind",
      "music",
    ]).options,
    {
      bgmPrompt: "warm award ceremony score",
      audioKind: "music",
    },
  );
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--duration", "0.4"], "INVALID_OPTION_VALUE");
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--duration", "5.1"], "INVALID_OPTION_VALUE");
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--audio-kind", "music", "--duration", "2.9"], "INVALID_OPTION_VALUE");
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--audio-kind", "music", "--duration", "601"], "INVALID_OPTION_VALUE");
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--volume", "-0.1"], "INVALID_OPTION_VALUE");
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--auth", "direct"], "UNKNOWN_OPTION");
  expectCliError(["audio", "plan", "video.json", "--prompt", "x", "--force"], "OPTION_NOT_ALLOWED");
  assert.deepEqual(
    parse([
      "audio", "plan", "video.json", "--prompt", "aircraft cabin ambience",
      "--duration", "0.5",
    ]).options,
    { prompt: "aircraft cabin ambience", duration: 0.5 },
  );
  expectCliError(
    ["audio", "plan", "video.json", "--prompt", "x", "--audio-kind", "sound-effect", "--duration", "5.1"],
    "INVALID_OPTION_VALUE",
  );
  expectCliError(
    ["audio", "plan", "video.json", "--prompt", "x", "--model", "music_v2"],
    "OPTION_CONFLICT",
  );

  assert.deepEqual(
    parse([
      "produce",
      "video.json",
      "--bgm",
      "required",
      "--bgm-prompt",
      "warm optimistic acoustic",
      "--audio-kind",
      "music",
      "--replace-bgm",
      "--allow-custom-structure",
      "--prepared-config",
      "output/prepared.json",
      "--lock",
      "output/video.lock.json",
    ]).options,
    {
      bgm: "required",
      bgmPrompt: "warm optimistic acoustic",
      audioKind: "music",
      replaceBgm: true,
      allowCustomStructure: true,
      preparedConfig: "output/prepared.json",
      lock: "output/video.lock.json",
    },
  );
  expectCliError(["produce", "video.json", "--bgm", "sometimes"], "INVALID_OPTION_VALUE");
  expectCliError(["render", "video.json", "--allow-custom-structure"], "OPTION_NOT_ALLOWED");
});

test("enforces missing and excess positionals as well as required options", () => {
  expectCliError(["render"], "MISSING_ARGUMENT");
  const extra = expectCliError(["render", "one.json", "two.json"], "TOO_MANY_ARGUMENTS");
  assert.equal(extra.issues.length, 1);
  expectCliError(["version", "extra"], "TOO_MANY_ARGUMENTS");
  expectCliError(["config"], "MISSING_ARGUMENT");
  expectCliError(["batch", "jobs.json"], "MISSING_ARGUMENT");
});

test("rejects unknown commands and group subcommands with suggestions", () => {
  const command = expectCliError(["rendr", "video.json"], "UNKNOWN_COMMAND");
  assert.equal(command.hint?.includes("render"), true);
  const subcommand = expectCliError(["config", "schem"], "UNKNOWN_COMMAND");
  assert.equal(subcommand.hint?.includes("schema"), true);
  expectCliError(["assets", "unknown"], "UNKNOWN_COMMAND");
});

test("help and version shortcuts are side-effect-free parsed commands", () => {
  assert.equal(parse([]).id, "help");
  assert.equal(parse(["-h"]).id, "help");
  assert.deepEqual(parse(["render", "--help"]).helpTarget, ["render"]);
  assert.deepEqual(parse(["render", "video.json", "--help"]).helpTarget, ["render"]);
  assert.deepEqual(parse(["config", "--help"]).helpTarget, ["config"]);
  assert.deepEqual(parse(["help", "config", "schema"]).helpTarget, ["config", "schema"]);
  assert.equal(parse(["-V"]).id, "version");
  assert.equal(parse(["--version", "--json"]).global.outputMode, "json");

  expectCliError(["help", "render", "extra"], "TOO_MANY_ARGUMENTS");
  expectCliError(["render", "--help", "--fix"], "OPTION_NOT_ALLOWED");
  expectCliError(["--help", "--version"], "OPTION_CONFLICT");
  expectCliError(["render", "video.json", "--version"], "OPTION_CONFLICT");
  expectCliError(["--version", "--fix"], "OPTION_NOT_ALLOWED");
});

test("a literal dash is a valid stdin operand and -- ends option parsing", () => {
  assert.deepEqual(parse(["validate", "-"]).positionals, ["-"]);
  const invocation = parse(["probe", "--", "--strangely-named-file"]);
  assert.deepEqual(invocation.positionals, ["--strangely-named-file"]);
  assert.deepEqual(invocation.options, {});
});
