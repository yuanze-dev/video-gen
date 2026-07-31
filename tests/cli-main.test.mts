import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let compiledDirectory = "";
let cliFile = "";
let audioModule: typeof import("../cli/audio.ts");
let produceModule: typeof import("../cli/produce.ts");
let projectModule: typeof import("../cli/project.ts");
const temporaryDirectories: string[] = [];

type CommandResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

type JsonEnvelope = {
  protocolVersion: string;
  ok: boolean;
  command?: string;
  result?: {
    name?: string;
    package?: string;
    runtime?: { template: string; bundleDigest: string };
    offlineLocalRender?: boolean;
    remoteAssets?: boolean;
    audioGeneration?: {
      providers?: Array<{ id: string; auth?: { default: string } }>;
    };
    export?: { resolution: string[] };
    commands?: Array<{ id: string }>;
    templates?: Array<{ ref: string }>;
    config?: string | ResolvedConfig;
    valid?: boolean;
    locked?: boolean;
    localFiles?: unknown[];
    plan?: {
      output: { width: number; height: number };
      timeline: { total: { frames: number } };
    };
    source?: string;
    $id?: string;
    additionalProperties?: boolean;
    description?: string;
    digest?: string;
    migrated?: boolean;
    fromVersion?: number;
    toVersion?: number;
  };
  error?: {
    code: string;
    message: string;
    exitCode: number;
    issues?: Array<{ path?: string; message: string; code?: string }>;
    details?: {
      total?: number;
      failed?: number;
      partial?: boolean;
      jobs?: Array<{
        status: string;
        error?: { code?: string };
      }>;
    };
  };
};

type ResolvedConfig = {
  version: number;
  canvas: { width: number; height: number; fps: number };
  opening: { title: { text: string } };
  content: { teleprompter: { screen: { w: number } } };
};

type NdjsonEvent = {
  event: string;
  sequence: number;
  data: {
    ok: boolean;
    command?: string;
    error?: { code: string };
  };
};

before(async () => {
  // Keep the artifact below the repository so external package resolution is
  // identical to scripts/cli.mjs, while still running every command from an
  // isolated project cwd.
  compiledDirectory = await fs.mkdtemp(path.join(ROOT, ".cli-main-test-"));
  cliFile = path.join(compiledDirectory, "main.cjs");
  await build({
    entryPoints: [path.join(ROOT, "cli", "main.ts")],
    outfile: cliFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "cjs",
    target: "node20",
    logLevel: "silent",
  });
  const helperDirectory = path.join(compiledDirectory, "helpers");
  await build({
    entryPoints: {
      audio: path.join(ROOT, "cli", "audio.ts"),
      produce: path.join(ROOT, "cli", "produce.ts"),
      project: path.join(ROOT, "cli", "project.ts"),
    },
    outdir: helperDirectory,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  audioModule = (await import(`${pathToFileURL(path.join(helperDirectory, "audio.js")).href}?t=${Date.now()}`)) as typeof audioModule;
  produceModule = (await import(`${pathToFileURL(path.join(helperDirectory, "produce.js")).href}?t=${Date.now()}`)) as typeof produceModule;
  projectModule = (await import(`${pathToFileURL(path.join(helperDirectory, "project.js")).href}?t=${Date.now()}`)) as typeof projectModule;
});

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) =>
      fs.rm(directory, { recursive: true, force: true }),
    ),
  );
  if (compiledDirectory) {
    await fs.rm(compiledDirectory, { recursive: true, force: true });
  }
});

async function temporaryDirectory(label: string): Promise<string> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), `littlestart-main-${label}-`),
  );
  temporaryDirectories.push(directory);
  return directory;
}

async function runCli(
  args: readonly string[],
  options: {
    cwd: string;
    stdin?: string;
    timeoutMs?: number;
    env?: NodeJS.ProcessEnv;
    keepStdinOpen?: boolean;
    signalAfterMs?: { signal: NodeJS.Signals; delay: number };
  },
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const waitForSignalReadiness = options.signalAfterMs !== undefined;
    const child = spawn(process.execPath, [cliFile, ...args], {
      cwd: options.cwd,
      env: {
        ...process.env,
        HOME: options.cwd,
        USERPROFILE: options.cwd,
        LITTLESTART_PACKAGED: "0",
        LITTLESTART_SOURCE_ROOT: ROOT,
        ...(waitForSignalReadiness ? { LITTLESTART_READY_FD: "3" } : {}),
        ...options.env,
      },
      stdio: ["pipe", "pipe", "pipe", ...(waitForSignalReadiness ? ["pipe" as const] : [])],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.on("error", reject);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 30_000);
    let signalTimer: NodeJS.Timeout | undefined;
    if (options.signalAfterMs) {
      const scheduleSignal = () => {
        signalTimer = setTimeout(
          () => child.kill(options.signalAfterMs?.signal),
          options.signalAfterMs!.delay,
        );
      };
      const ready = child.stdio[3];
      if (!ready || typeof ready === "string") {
        reject(new Error("CLI readiness pipe was not created"));
        return;
      }
      ready.once("data", scheduleSignal);
    }
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (signalTimer) clearTimeout(signalTimer);
      const result = {
        code: code ?? 1,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      };
      if (timedOut) {
        reject(
          new Error(
            `CLI timed out: ${args.join(" ")}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
          ),
        );
      } else {
        resolve(result);
      }
    });
    if (!options.keepStdinOpen) child.stdin.end(options.stdin);
  });
}

function envelope(result: CommandResult): JsonEnvelope {
  assert.notEqual(result.stdout.trim(), "", `stderr:\n${result.stderr}`);
  return JSON.parse(result.stdout) as JsonEnvelope;
}

function ndjson(result: CommandResult): NdjsonEvent[] {
  return result.stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as NdjsonEvent);
}

async function writeJson(file: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

const fakeMcpRuntime = {
  command: "/fake/elevenlabs-mcp",
  args: [],
  source: "bundled",
  version: "0.11.0",
  integrity: "pinned-bundle",
} as const;

async function seedVerifiedAudioCache(
  plan: ReturnType<typeof audioModule.createAudioGenerationPlan>,
  configBaseDir: string,
): Promise<void> {
  const fixture = await fs.readFile(path.join(ROOT, "public", "assets", "builtin", "airport-bgm.mp3"));
  await audioModule.generatePlannedAudio({
    plan,
    elevenLabsApiKey: "test-secret",
    runtime: fakeMcpRuntime,
    configBaseDir,
    mcpCall: async (request) => {
      await fs.writeFile(path.join(request.outputDirectory, "cached.mp3"), fixture);
      return { content: [] };
    },
  });
}

test("version, capabilities, and help expose the production command surface", async () => {
  const cwd = await temporaryDirectory("metadata");

  const version = await runCli(["version", "--json"], { cwd });
  assert.equal(version.code, 0);
  assert.equal(version.stderr, "");
  const versionBody = envelope(version);
  assert.equal(versionBody.ok, true);
  assert.equal(versionBody.protocolVersion, "1");
  assert.equal(versionBody.command, "version");
  assert.equal(versionBody.result?.name, "littlestart");
  assert.equal(versionBody.result?.package, "@yuanze/littlestart-cli");
  assert.equal(versionBody.result?.runtime?.template, "teleprompter@1.0.0");
  assert.match(versionBody.result?.runtime?.bundleDigest ?? "", /^sha256:[a-f0-9]{64}$/);

  const capabilities = await runCli(["capabilities", "--json"], { cwd });
  assert.equal(capabilities.code, 0);
  assert.equal(capabilities.stderr, "");
  const capabilitiesBody = envelope(capabilities);
  assert.equal(capabilitiesBody.result?.offlineLocalRender, true);
  assert.equal(capabilitiesBody.result?.remoteAssets, false);
  assert.deepEqual(capabilitiesBody.result?.export?.resolution, ["1080p", "720p"]);
  assert.ok(
    capabilitiesBody.result?.commands?.some(
      (command: { id: string }) => command.id === "skill.install",
    ),
  );
  assert.ok(
    capabilitiesBody.result?.commands?.some(
      (command: { id: string }) => command.id === "produce",
    ),
  );
  assert.equal(capabilitiesBody.result?.audioGeneration?.providers?.[0]?.id, "elevenlabs");
  assert.equal(capabilitiesBody.result?.audioGeneration?.providers?.[0]?.auth?.default, "mcp");
  const audioProvider = capabilitiesBody.result?.audioGeneration?.providers?.[0] as {
    defaultKind?: string;
    defaultModel?: string | null;
    defaultDurationSec?: number;
    durationSec?: { min?: number; max?: number };
    forceInstrumental?: boolean;
    mcp?: { tool?: string; tools?: string[] };
    kinds?: Array<{ id?: string; defaultDurationSec?: number }>;
  } | undefined;
  assert.equal(audioProvider?.defaultKind, "sound-effect");
  assert.equal(audioProvider?.defaultModel, null);
  assert.equal(audioProvider?.defaultDurationSec, 5);
  assert.deepEqual(audioProvider?.durationSec, { min: 0.5, max: 5 });
  assert.equal(audioProvider?.forceInstrumental, false);
  assert.equal(audioProvider?.mcp?.tool, "text_to_sound_effects");
  assert.deepEqual(
    audioProvider?.mcp?.tools,
    ["text_to_sound_effects", "compose_music"],
  );
  assert.equal(
    audioProvider?.kinds?.find((kind) => kind.id === "sound-effect")?.defaultDurationSec,
    5,
  );
  assert.equal(capabilitiesBody.result?.templates?.[0]?.ref, "teleprompter@1.0.0");

  const help = await runCli(["help", "skill", "install"], { cwd });
  assert.equal(help.code, 0);
  assert.equal(help.stderr, "");
  assert.match(help.stdout, /littlestart skill install/);
  assert.match(help.stdout, /--target/);

  const shortVersion = await runCli(["-V", "--json"], { cwd });
  assert.equal(shortVersion.code, 0);
  assert.equal(envelope(shortVersion).result?.name, "littlestart");
});

test("audio plan defaults to sound effects and generation fails closed without auth", async () => {
  const cwd = await temporaryDirectory("audio-plan");
  const config = path.join(cwd, "video.json");
  const output = path.join(cwd, "assets", "bgm.mp3");
  const manifest = path.join(cwd, "assets", "bgm.manifest.json");
  await writeJson(config, {
    content: { teleprompter: { text: { content: "Narration" } } },
  });

  const planned = await runCli(
    [
      "audio",
      "plan",
      config,
      "--prompt",
      "steady neutral room ambience under narration",
      "--duration",
      "5",
      "--out",
      output,
      "--manifest",
      manifest,
      "--offline",
      "--json",
    ],
    { cwd },
  );
  assert.equal(planned.code, 0);
  const planResult = envelope(planned).result as unknown as {
    plan: {
      kind: string;
      auth: { mode: string };
      transport: { tool: string };
      model: string | null;
      generationDurationSec: number;
      generationLoop?: boolean;
      outputPath: string;
    };
    configPatch: { content: { bgm: { asset: { path: string }; volume: number } } };
  };
  assert.equal(planResult.plan.auth.mode, "mcp");
  assert.equal(planResult.plan.kind, "sound-effect");
  assert.equal(planResult.plan.transport.tool, "text_to_sound_effects");
  assert.equal(planResult.plan.model, null);
  assert.equal(planResult.plan.generationDurationSec, 5);
  assert.equal(planResult.plan.generationLoop, true);
  assert.equal(planResult.plan.outputPath, output);
  assert.equal(planResult.configPatch.content.bgm.asset.path, "assets/bgm.mp3");
  assert.equal(await fs.lstat(output).catch(() => null), null);

  const missingAuth = await runCli(
    [
      "audio",
      "generate",
      config,
      "--prompt",
      "steady neutral room ambience under narration",
      "--duration",
      "3",
      "--out",
      output,
      "--manifest",
      manifest,
      "--json",
    ],
    { cwd, env: { ELEVENLABS_API_KEY: "" } },
  );
  assert.equal(missingAuth.code, 5);
  assert.equal(envelope(missingAuth).error?.code, "AUTH_REQUIRED");
  assert.equal(await fs.lstat(output).catch(() => null), null);
  assert.equal(await fs.lstat(manifest).catch(() => null), null);

  const offline = await runCli(
    [
      "audio",
      "generate",
      config,
      "--prompt",
      "steady neutral room ambience under narration",
      "--offline",
      "--json",
    ],
    { cwd, env: { ELEVENLABS_API_KEY: "test-would-not-be-used" } },
  );
  assert.equal(offline.code, 5);
  assert.equal(envelope(offline).error?.code, "OFFLINE_RESOURCE_MISSING");
});

test("audio generate reuses a verified request-key cache before offline or credential checks", async () => {
  const cwd = await temporaryDirectory("audio-cache-before-auth");
  const config = path.join(cwd, "video.json");
  const output = path.join(cwd, "assets", "bgm.mp3");
  const manifest = path.join(cwd, "assets", "bgm.manifest.json");
  const prompt = "warm minimal instrumental under narration";
  await writeJson(config, {
    content: { teleprompter: { text: { content: "Narration" } } },
  });
  const loaded = await projectModule.loadProjectInput(config);
  const plan = produceModule.createNarrationAudioPlan({
    input: loaded,
    audioKind: "music",
    prompt,
    durationSec: 34,
    outputPath: output,
    manifestPath: manifest,
  }).plan;
  await seedVerifiedAudioCache(plan, loaded.baseDir);

  const result = await runCli(
    [
      "audio",
      "generate",
      config,
      "--prompt",
      prompt,
      "--audio-kind",
      "music",
      "--duration",
      "34",
      "--out",
      output,
      "--manifest",
      manifest,
      "--offline",
      "--json",
    ],
    {
      cwd,
      env: {
        ELEVENLABS_API_KEY: "",
        LITTLESTART_ENV_FILE: path.join(cwd, "missing-secrets.env"),
      },
    },
  );
  assert.equal(result.code, 0, result.stderr);
  assert.equal((envelope(result).result as { reused?: boolean }).reused, true);
});

test("produce cache preflight bypasses required offline/auth short-circuit", async () => {
  const cwd = await temporaryDirectory("produce-cache-before-auth");
  const config = path.join(cwd, "video.json");
  const prepared = path.join(cwd, "output", "prepared.json");
  const lock = path.join(cwd, "output", "video.lock.json");
  const missingBrowser = path.join(cwd, "missing-chromium");
  await writeJson(config, {
    opening: { title: { text: "Cached audio" } },
    content: { teleprompter: { text: { content: "Narration" } }, bgm: null },
  });
  const input = await projectModule.loadProjectInput(config);
  const planned = produceModule.createProductionAudioPlan({
    input,
    mode: "required",
    audioKind: "music",
    durationSec: 34,
    volume: undefined,
    model: undefined,
    prompt: undefined,
  });
  assert.ok(planned);
  await seedVerifiedAudioCache(planned.plan, path.dirname(prepared));

  const result = await runCli(
    [
      "produce",
      config,
      "--bgm",
      "required",
      "--audio-kind",
      "music",
      "--duration",
      "34",
      "--offline",
      "--prepared-config",
      prepared,
      "--lock",
      lock,
      "--out",
      path.join(cwd, "video.mp4"),
      "--json",
    ],
    {
      cwd,
      env: {
        ELEVENLABS_API_KEY: "",
        LITTLESTART_ENV_FILE: path.join(cwd, "missing-secrets.env"),
        REMOTION_BROWSER_EXECUTABLE: missingBrowser,
      },
    },
  );
  // It reaches renderer validation rather than failing as offline/auth: the
  // cached asset was accepted without reading a usable credential.
  assert.equal(result.code, 5);
  assert.equal(envelope(result).error?.code, "DEPENDENCY_MISSING");
  assert.doesNotMatch(result.stderr, /BGM 生成已被明确请求|--offline 下无法生成/);
});

test("produce validates its one-click outputs and required credential before browser preparation", async () => {
  const cwd = await temporaryDirectory("produce-preflight");
  const config = path.join(cwd, "video.json");
  const missingBrowser = path.join(cwd, "missing-chromium");
  await writeJson(config, { content: { bgm: null } });

  const sharedJson = path.join(cwd, "shared.json");
  const conflicting = await runCli(
    [
      "produce",
      config,
      "--bgm",
      "off",
      "--prepared-config",
      sharedJson,
      "--lock",
      sharedJson,
      "--out",
      path.join(cwd, "video.mp4"),
      "--force",
      "--json",
    ],
    { cwd, env: { REMOTION_BROWSER_EXECUTABLE: missingBrowser } },
  );
  assert.equal(conflicting.code, 2);
  assert.equal(envelope(conflicting).error?.code, "OPTION_CONFLICT");
  assert.equal(await fs.lstat(sharedJson).catch(() => null), null);

  const required = await runCli(
    [
      "produce",
      config,
      "--bgm",
      "required",
      "--prepared-config",
      path.join(cwd, "prepared.json"),
      "--lock",
      path.join(cwd, "video.lock.json"),
      "--out",
      path.join(cwd, "video.mp4"),
      "--json",
    ],
    {
      cwd,
      env: {
        ELEVENLABS_API_KEY: "",
        LITTLESTART_ENV_FILE: path.join(cwd, "missing-secrets.env"),
        REMOTION_BROWSER_EXECUTABLE: missingBrowser,
      },
    },
  );
  assert.equal(required.code, 5);
  assert.equal(envelope(required).error?.code, "AUTH_REQUIRED");
  assert.doesNotMatch(required.stderr, /Chromium/);
  assert.equal(await fs.lstat(path.join(cwd, "prepared.json")).catch(() => null), null);
  assert.equal(await fs.lstat(path.join(cwd, "video.lock.json")).catch(() => null), null);
});

test("produce rejects a damaged standard opening before credentials, browser, or outputs", async () => {
  const cwd = await temporaryDirectory("produce-structure-guard");
  const config = path.join(cwd, "video.json");
  const prepared = path.join(cwd, "prepared.json");
  const lock = path.join(cwd, "video.lock.json");
  await writeJson(config, {
    opening: {
      title: { text: "Pilot emergency practice" },
      countdown: { enabled: false },
      curtain: { openDurationSec: 0.4, sfx: null },
    },
    content: { teleprompter: { text: { content: "Mayday practice narration" } } },
  });

  const result = await runCli(
    [
      "produce",
      config,
      "--bgm",
      "required",
      "--prepared-config",
      prepared,
      "--lock",
      lock,
      "--out",
      path.join(cwd, "video.mp4"),
      "--json",
    ],
    {
      cwd,
      env: {
        ELEVENLABS_API_KEY: "",
        LITTLESTART_ENV_FILE: path.join(cwd, "missing-secrets.env"),
        REMOTION_BROWSER_EXECUTABLE: path.join(cwd, "missing-chromium"),
      },
    },
  );

  assert.equal(result.code, 3);
  assert.equal(envelope(result).error?.code, "PRODUCTION_GUARD_FAILED");
  assert.deepEqual(
    envelope(result).error?.issues?.map((issue) => issue.path),
    [
      "opening.countdown.enabled",
      "opening.curtain.openDurationSec",
      "opening.curtain.sfx",
    ],
  );
  assert.doesNotMatch(result.stderr, /Chromium|API Key|AUTH_REQUIRED/);
  assert.equal(await fs.lstat(prepared).catch(() => null), null);
  assert.equal(await fs.lstat(lock).catch(() => null), null);
});

test("produce does not read optional credentials when BGM generation is not a candidate", async () => {
  const cwd = await temporaryDirectory("produce-lazy-credential");
  const config = path.join(cwd, "video.json");
  const outside = path.join(cwd, "outside.env");
  const unsafeSecrets = path.join(cwd, "secrets.env");
  await writeJson(config, { content: { bgm: null } });
  await fs.writeFile(outside, "must-not-read\n");
  await fs.symlink(outside, unsafeSecrets);

  const result = await runCli(
    ["produce", config, "--bgm", "off", "--out", path.join(cwd, "video.mp4"), "--json"],
    {
      cwd,
      env: {
        LITTLESTART_ENV_FILE: unsafeSecrets,
        REMOTION_BROWSER_EXECUTABLE: path.join(cwd, "missing-chromium"),
      },
    },
  );
  assert.equal(result.code, 5);
  assert.equal(envelope(result).error?.code, "DEPENDENCY_MISSING");
  assert.equal(await fs.readFile(outside, "utf8"), "must-not-read\n");
});

test("skill install arguments are strict before any project mutation", async () => {
  const cwd = await temporaryDirectory("strict-skill-parser");

  const invalidTarget = await runCli(
    ["skill", "install", "--target", "cursor", "--json"],
    { cwd },
  );
  assert.equal(invalidTarget.code, 2);
  assert.equal(envelope(invalidTarget).error?.code, "INVALID_OPTION_VALUE");
  assert.match(invalidTarget.stderr, /--target/);

  const duplicate = await runCli(
    [
      "skill",
      "install",
      "--target",
      "codex",
      "--target",
      "claude",
      "--json",
    ],
    { cwd },
  );
  assert.equal(duplicate.code, 2);
  assert.equal(envelope(duplicate).error?.code, "DUPLICATE_OPTION");

  const extraOperand = await runCli(
    ["skill", "install", "unexpected", "--json"],
    { cwd },
  );
  assert.equal(extraOperand.code, 2);
  assert.equal(envelope(extraOperand).error?.code, "TOO_MANY_ARGUMENTS");
  assert.equal(await fs.lstat(path.join(cwd, ".agents")).catch(() => null), null);
  assert.equal(await fs.lstat(path.join(cwd, ".claude")).catch(() => null), null);
});

test("init, validate, plan, and stdin form a headless project workflow", async () => {
  const cwd = await temporaryDirectory("project-flow");
  const config = path.join(cwd, "project.json");

  const initialized = await runCli(
    ["init", config, "--minimal", "--json"],
    { cwd },
  );
  assert.equal(initialized.code, 0);
  assert.equal(envelope(initialized).result?.config, config);
  const initializedConfig = JSON.parse(await fs.readFile(config, "utf8"));
  assert.equal(initializedConfig.version, 1);
  assert.equal(initializedConfig.content.teleprompter.mode, "text");
  assert.equal(initializedConfig.canvas, undefined);

  const validated = await runCli(["validate", config, "--json"], { cwd });
  assert.equal(validated.code, 0);
  const validatedBody = envelope(validated);
  assert.equal(validatedBody.result?.valid, true);
  assert.equal(validatedBody.result?.locked, false);
  assert.deepEqual(validatedBody.result?.localFiles, []);
  assert.ok((validatedBody.result?.plan?.timeline.total.frames ?? 0) > 0);

  const stdinConfig = JSON.stringify({
    opening: { title: { text: "stdin title" } },
    content: { teleprompter: { text: { content: "stdin content" } } },
  });
  const planned = await runCli(
    ["plan", "-", "--resolution", "720p", "--fps", "30", "--json"],
    {
    cwd,
    stdin: stdinConfig,
    },
  );
  assert.equal(planned.code, 0);
  const plannedBody = envelope(planned);
  assert.equal(plannedBody.result?.source, "-");
  assert.equal(plannedBody.result?.plan?.output.width, 720);
  assert.equal(plannedBody.result?.plan?.output.height, 1280);

  const invalidStdin = await runCli(["validate", "-", "--json"], {
    cwd,
    stdin: JSON.stringify({ opening: { title: { fontSzie: 80 } } }),
  });
  assert.equal(invalidStdin.code, 3);
  assert.equal(envelope(invalidStdin).error?.code, "CONFIG_INVALID");
  assert.match(invalidStdin.stderr, /opening\.title\.fontSzie/);
});

test("schema and resolve describe and materialize the accepted partial config", async () => {
  const cwd = await temporaryDirectory("schema-resolve");
  const config = path.join(cwd, "partial.json");
  await writeJson(config, { opening: { title: { text: "resolved title" } } });

  const schema = await runCli(["config", "schema", "--json"], { cwd });
  assert.equal(schema.code, 0);
  const schemaBody = envelope(schema);
  assert.equal(
    schemaBody.result?.$id,
    "https://yuanze.dev/schemas/littlestart/teleprompter-v1.json",
  );
  assert.equal(schemaBody.result?.additionalProperties, false);
  assert.match(schemaBody.result?.description ?? "", /Partial configuration/);

  const resolved = await runCli(["config", "resolve", config, "--json"], {
    cwd,
  });
  assert.equal(resolved.code, 0);
  const full = envelope(resolved).result?.config as ResolvedConfig;
  assert.equal(full.version, 1);
  assert.equal(full.opening.title.text, "resolved title");
  assert.deepEqual(full.canvas, { width: 1080, height: 1920, fps: 60 });
  assert.ok(full.content.teleprompter.screen.w > 0);

  const migration = await runCli(["config", "migrate", config, "--json"], { cwd });
  assert.equal(migration.code, 0);
  assert.equal(envelope(migration).result?.migrated, false);
  assert.equal(envelope(migration).result?.fromVersion, 1);
  assert.equal(envelope(migration).result?.toVersion, 1);

  const output = path.join(cwd, "resolved.json");
  const written = await runCli(
    ["config", "resolve", config, "--out", output, "--json"],
    { cwd },
  );
  assert.equal(written.code, 0);
  const original = await fs.readFile(output, "utf8");
  const refused = await runCli(
    ["config", "resolve", config, "--out", output, "--json"],
    { cwd },
  );
  assert.equal(refused.code, 7);
  assert.equal(envelope(refused).error?.code, "OUTPUT_EXISTS");
  assert.equal(await fs.readFile(output, "utf8"), original);
  assert.equal(
    (await fs.readdir(cwd)).some((name) => name.includes(".partial")),
    false,
  );
});

test("config lock round-trips and detects same-size asset tampering", async () => {
  const cwd = await temporaryDirectory("lock");
  const asset = path.join(cwd, "background.png");
  await fs.copyFile(path.join(ROOT, "public/assets/builtin/microphone.png"), asset);
  const config = path.join(cwd, "project.json");
  const lock = path.join(cwd, "project.lock.json");
  await writeJson(config, {
    content: { background: { kind: "file", path: "./background.png" } },
  });

  const locked = await runCli(
    [
      "config",
      "lock",
      config,
      "--quality",
      "small",
      "--resolution",
      "720p",
      "--fps",
      "30",
      "--out",
      lock,
      "--json",
    ],
    { cwd },
  );
  assert.equal(locked.code, 0);
  assert.match(envelope(locked).result?.digest ?? "", /^sha256:[a-f0-9]{64}$/);
  const lockJson = JSON.parse(await fs.readFile(lock, "utf8"));
  assert.equal(lockJson.assets.length, 1);
  assert.deepEqual(lockJson.export, { quality: "small", resolution: "720p", fps: 30 });
  assert.equal(lockJson.assets[0].file, "background.png");
  assert.match(lockJson.assets[0].digest, /^sha256:[a-f0-9]{64}$/);

  const roundTrip = await runCli(["validate", lock, "--json"], { cwd });
  assert.equal(roundTrip.code, 0);
  assert.equal(envelope(roundTrip).result?.locked, true);

  const override = await runCli(
    [
      "render",
      lock,
      "--quality",
      "high",
      "--out",
      "should-not-render.mp4",
      "--offline",
      "--json",
    ],
    { cwd },
  );
  assert.equal(override.code, 2);
  assert.equal(envelope(override).error?.code, "OPTION_CONFLICT");
  assert.equal(envelope(override).error?.issues?.[0]?.path, "options.quality");

  const bytes = await fs.readFile(asset);
  bytes[bytes.length - 1] ^= 0xff;
  await fs.writeFile(asset, bytes);
  const tampered = await runCli(["validate", lock, "--json"], { cwd });
  assert.equal(tampered.code, 4);
  assert.equal(envelope(tampered).error?.code, "ASSET_UNSUPPORTED");
  assert.match(tampered.stderr, /内容已变化|摘要不匹配/);
});

test("JSON config failures preserve structured field paths", async () => {
  const cwd = await temporaryDirectory("config-issues");
  const config = path.join(cwd, "invalid.json");
  await writeJson(config, {
    content: { teleprompter: { speeed: 2 } },
  });
  const result = await runCli(["validate", config, "--json"], { cwd });
  assert.equal(result.code, 3);
  const body = envelope(result);
  assert.equal(body.error?.code, "CONFIG_INVALID");
  assert.ok(
    body.error?.issues?.some(
      (issue) => issue.path === "content.teleprompter.speeed" && issue.code === "unrecognized_keys",
    ),
  );
  assert.equal(body.error?.message, "配置校验失败");
  assert.equal(
    result.stderr.match(/content\.teleprompter\.speeed/g)?.length,
    1,
  );
});

test("JSON and NDJSON reserve stdout for one parseable protocol", async () => {
  const cwd = await temporaryDirectory("protocol");

  const success = await runCli(
    ["capabilities", "--events", "ndjson", "--quiet"],
    { cwd },
  );
  assert.equal(success.code, 0);
  assert.equal(success.stderr, "");
  const successEvents = ndjson(success);
  assert.equal(successEvents.length, 1);
  assert.equal(successEvents[0].event, "result");
  assert.equal(successEvents[0].sequence, 1);
  assert.equal(successEvents[0].data.ok, true);
  assert.equal(successEvents[0].data.command, "capabilities");

  const failure = await runCli(
    ["definitely-not-a-command", "--events", "ndjson", "--quiet"],
    { cwd },
  );
  assert.equal(failure.code, 2);
  const failureEvents = ndjson(failure);
  assert.equal(failureEvents.length, 1);
  assert.equal(failureEvents[0]?.event, "error");
  assert.equal(failureEvents[0]?.data.ok, false);
  assert.equal(failureEvents[0]?.data.error?.code, "UNKNOWN_COMMAND");
  // --quiet suppresses chatter, but final diagnostics remain visible.
  assert.match(failure.stderr, /UNKNOWN_COMMAND/);
});

test("existing outputs are protected unless force is explicit", async () => {
  const cwd = await temporaryDirectory("overwrite");
  const target = path.join(cwd, "project.json");
  await fs.writeFile(target, "user-owned\n");

  const refused = await runCli(["init", target, "--minimal", "--json"], {
    cwd,
  });
  assert.equal(refused.code, 7);
  assert.equal(envelope(refused).error?.code, "OUTPUT_EXISTS");
  assert.equal(await fs.readFile(target, "utf8"), "user-owned\n");

  const forced = await runCli(
    ["init", target, "--minimal", "--force", "--json"],
    { cwd },
  );
  assert.equal(forced.code, 0);
  assert.equal(JSON.parse(await fs.readFile(target, "utf8")).version, 1);
  assert.equal(
    (await fs.readdir(cwd)).some((name) => name.includes(".partial")),
    false,
  );
});

test("render and still reject existing outputs before browser preparation", async () => {
  const cwd = await temporaryDirectory("render-overwrite-preflight");
  const config = path.join(cwd, "project.json");
  const video = path.join(cwd, "existing.mp4");
  const still = path.join(cwd, "existing.jpg");
  const cache = path.join(cwd, "state", "cache");
  await writeJson(config, {});
  await fs.writeFile(video, "owned video");
  await fs.writeFile(still, "owned still");

  for (const args of [
    ["render", config, "--out", video],
    ["still", config, "--out", still],
  ]) {
    const result = await runCli(
      [...args, "--offline", "--cache-dir", cache, "--json"],
      { cwd },
    );
    assert.equal(result.code, 7);
    assert.equal(envelope(result).error?.code, "OUTPUT_EXISTS");
    assert.doesNotMatch(result.stderr, /浏览器|Chromium/);
  }
  assert.equal(await fs.lstat(cache).catch(() => null), null);
  assert.equal(await fs.readFile(video, "utf8"), "owned video");
  assert.equal(await fs.readFile(still, "utf8"), "owned still");
});

test("forced render rejects unsafe output targets before browser preparation", async () => {
  const cwd = await temporaryDirectory("unsafe-render-target");
  const config = path.join(cwd, "project.json");
  const outputDirectory = path.join(cwd, "not-a-file.mp4");
  const cache = path.join(cwd, "state", "cache");
  await writeJson(config, {});
  await fs.mkdir(outputDirectory);

  const result = await runCli(
    [
      "render",
      config,
      "--out",
      outputDirectory,
      "--force",
      "--offline",
      "--cache-dir",
      cache,
      "--json",
    ],
    { cwd },
  );
  assert.equal(result.code, 7);
  assert.equal(envelope(result).error?.code, "OUTPUT_INVALID");
  assert.doesNotMatch(result.stderr, /浏览器|Chromium/);
  assert.equal(await fs.lstat(cache).catch(() => null), null);
  assert.equal((await fs.lstat(outputDirectory)).isDirectory(), true);
});

test("still option conflicts fail before browser preparation", async () => {
  const cwd = await temporaryDirectory("still-conflict");
  const config = path.join(cwd, "project.json");
  const cache = path.join(cwd, "state", "cache");
  await writeJson(config, {});

  const result = await runCli(
    [
      "still",
      config,
      "--scene",
      "all",
      "--out",
      "conflict.jpg",
      "--offline",
      "--cache-dir",
      cache,
      "--json",
    ],
    { cwd },
  );
  assert.equal(result.code, 2);
  assert.equal(envelope(result).error?.code, "OPTION_CONFLICT");
  assert.match(result.stderr, /--scene all/);
  assert.equal(await fs.lstat(cache).catch(() => null), null);
});

test("invalid custom Chromium path fails before rendering", async () => {
  const cwd = await temporaryDirectory("custom-browser");
  const config = path.join(cwd, "project.json");
  await writeJson(config, {});
  const result = await runCli(
    ["render", config, "--out", "never.mp4", "--json"],
    {
      cwd,
      env: { REMOTION_BROWSER_EXECUTABLE: path.join(cwd, "missing-chrome") },
    },
  );
  assert.equal(result.code, 5);
  assert.equal(envelope(result).error?.code, "DEPENDENCY_MISSING");
  assert.equal(
    envelope(result).error?.issues?.[0]?.path,
    "env.REMOTION_BROWSER_EXECUTABLE",
  );
  assert.equal(await fs.stat(path.join(cwd, "never.mp4")).catch(() => null), null);
});

test("invalid Chromium GL environment value is a structured usage error", async () => {
  const cwd = await temporaryDirectory("custom-chromium-gl");
  const config = path.join(cwd, "project.json");
  await writeJson(config, {});
  const result = await runCli(
    ["render", config, "--out", "never.mp4", "--json"],
    {
      cwd,
      env: { LITTLESTART_CHROMIUM_GL: "hardware-magic" },
    },
  );
  assert.equal(result.code, 2);
  assert.equal(envelope(result).error?.code, "INVALID_OPTION_VALUE");
  assert.equal(
    envelope(result).error?.issues?.[0]?.path,
    "env.LITTLESTART_CHROMIUM_GL",
  );
  assert.equal(await fs.stat(path.join(cwd, "never.mp4")).catch(() => null), null);

  const doctor = await runCli(["doctor", "--json"], {
    cwd,
    env: { LITTLESTART_CHROMIUM_GL: "hardware-magic" },
  });
  assert.equal(doctor.code, 2);
  assert.equal(envelope(doctor).error?.code, "INVALID_OPTION_VALUE");
  assert.equal(
    envelope(doctor).error?.issues?.[0]?.path,
    "env.LITTLESTART_CHROMIUM_GL",
  );
});

test("SIGTERM interrupts an idle stdin read with exit 143", async (t) => {
  if (process.platform === "win32") t.skip("POSIX signal exit semantics");
  const cwd = await temporaryDirectory("stdin-sigterm");
  const result = await runCli(["validate", "-", "--json"], {
    cwd,
    keepStdinOpen: true,
    signalAfterMs: { signal: "SIGTERM", delay: 100 },
    timeoutMs: 5_000,
  });
  assert.equal(result.signal, null);
  assert.equal(result.code, 143);
  assert.equal(envelope(result).error?.code, "TERMINATED");
});

test("batch stdin preflights every job and reports partial failure structurally", async () => {
  const cwd = await temporaryDirectory("batch-stdin");
  const cache = path.join(cwd, "state", "cache");

  const invalidManifest = {
    version: 1,
    jobs: [
      { id: "missing-a", config: "missing-a.json" },
      { id: "missing-b", config: "missing-b.json" },
    ],
  };
  const preflight = await runCli(
    [
      "batch",
      "-",
      "--out-dir",
      "preflight-out",
      "--jobs",
      "2",
      "--offline",
      "--cache-dir",
      cache,
      "--json",
    ],
    { cwd, stdin: JSON.stringify(invalidManifest) },
  );
  assert.equal(preflight.code, 3);
  const preflightBody = envelope(preflight);
  assert.equal(preflightBody.error?.code, "CONFIG_INVALID");
  assert.equal(preflightBody.error?.issues?.length, 2);
  assert.deepEqual(
    preflightBody.error?.issues?.map((issue) => issue.path),
    ["jobs.0.config", "jobs.1.config"],
  );
  assert.equal(await fs.lstat(cache).catch(() => null), null);

  await writeJson(path.join(cwd, "a.json"), {});
  await writeJson(path.join(cwd, "b.json"), {});
  const validManifest = {
    version: 1,
    jobs: [
      { id: "a", config: "a.json" },
      { id: "b", config: "b.json" },
    ],
  };
  const partial = await runCli(
    [
      "batch",
      "-",
      "--out-dir",
      "render-out",
      "--jobs",
      "2",
      "--offline",
      "--cache-dir",
      cache,
      "--json",
    ],
    { cwd, stdin: JSON.stringify(validManifest) },
  );
  assert.equal(partial.code, 10);
  const partialBody = envelope(partial);
  assert.equal(partialBody.error?.code, "BATCH_PARTIAL_FAILURE");
  assert.equal(partialBody.error?.details?.total, 2);
  assert.equal(partialBody.error?.details?.failed, 2);
  assert.equal(partialBody.error?.details?.partial, true);
  assert.deepEqual(
    partialBody.error?.details?.jobs?.map((job) => job.status),
    ["failed", "failed"],
  );
  assert.ok(
    partialBody.error?.details?.jobs?.every(
      (job) => job.error?.code === "OFFLINE_RESOURCE_MISSING",
    ),
  );
  assert.equal(
    await fs.lstat(path.join(cwd, "render-out", "a.mp4")).catch(() => null),
    null,
  );
  assert.equal(await fs.lstat(cache).catch(() => null), null);
});
