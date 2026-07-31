import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledDirectory = await fs.mkdtemp(path.join(ROOT, ".cli-produce-test-"));
const temporaryDirectories: string[] = [];

type ProduceModule = typeof import("../cli/produce.ts");
type ProjectModule = typeof import("../cli/project.ts");
let produce: ProduceModule;
let project: ProjectModule;

before(async () => {
  await build({
    entryPoints: {
      produce: path.join(ROOT, "cli", "produce.ts"),
      project: path.join(ROOT, "cli", "project.ts"),
    },
    outdir: compiledDirectory,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  produce = (await import(`${pathToFileURL(path.join(compiledDirectory, "produce.js")).href}?t=${Date.now()}`)) as ProduceModule;
  project = (await import(`${pathToFileURL(path.join(compiledDirectory, "project.js")).href}?t=${Date.now()}`)) as ProjectModule;
});

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  await fs.rm(compiledDirectory, { recursive: true, force: true });
});

async function tempDir(label: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `littlestart-produce-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function sourceProject(directory: string, bgm?: unknown) {
  const file = path.join(directory, "video.json");
  await fs.writeFile(
    file,
    `${JSON.stringify({
      opening: { title: { text: "A calm product launch" } },
      content: {
        teleprompter: { text: { content: "Explain the new workflow in a clear, optimistic voice." } },
        ...(bgm === undefined ? {} : { bgm }),
      },
    })}\n`,
  );
  return { file, input: await project.loadProjectInput(file) };
}

const runtime = {
  packaged: false,
  cliVersion: "test",
  packageRoot: ROOT,
  sourceRoot: ROOT,
  skillsRoot: path.join(ROOT, "skills", "generate-video"),
  runtimeMetadata: {
    protocolVersion: "1",
    template: "teleprompter@1.0.0",
    composition: "Teleprompter",
    remotionVersion: "test",
    templateDigest: `sha256:${"1".repeat(64)}`,
    bundleDigest: `sha256:${"2".repeat(64)}`,
  },
} as const;

const exportOptions = { quality: "standard", resolution: "1080p", fps: 60 } as const;
const mcpRuntime = {
  command: "/fake/elevenlabs-mcp",
  args: [],
  source: "bundled",
  version: "0.11.0",
  integrity: "pinned-bundle",
} as const;

test("one-click production guard rejects a removed countdown and placeholder ending before writes", async () => {
  const directory = await tempDir("structure-guard");
  const { input } = await sourceProject(directory);
  const config = structuredClone(input.config);
  config.opening.countdown.enabled = false;
  config.opening.curtain.openDurationSec = 0.4;
  config.opening.curtain.sfx = null;
  config.ending.video.asset = {
    kind: "upload",
    id: "short-placeholder",
    mime: "video/mp4",
    durationSec: 0.2,
  };
  const guardedInput = { ...input, config };
  const issues = produce.standardProductionStructureIssues(config);
  assert.deepEqual(
    issues.map((issue) => issue.code),
    [
      "STANDARD_COUNTDOWN_REQUIRED",
      "STANDARD_CURTAIN_TOO_FAST",
      "STANDARD_OPENING_SFX_REQUIRED",
      "STANDARD_ENDING_REQUIRED",
      "STANDARD_ENDING_TOO_SHORT",
    ],
  );

  const prepared = path.join(directory, "prepared.json");
  const lock = path.join(directory, "video.lock.json");
  await assert.rejects(
    produce.prepareVideoProduction({
      input: guardedInput,
      runtime,
      exportOptions,
      mode: "off",
      preparedConfigPath: prepared,
      lockPath: lock,
    }),
    (error: unknown) => {
      const value = error as { code?: string; issues?: Array<{ path?: string }> };
      assert.equal(value.code, "PRODUCTION_GUARD_FAILED");
      assert.deepEqual(value.issues?.map((issue) => issue.path), [
        "opening.countdown.enabled",
        "opening.curtain.openDurationSec",
        "opening.curtain.sfx",
        "ending.video.asset",
        "ending.video.asset.durationSec",
      ]);
      return true;
    },
  );
  assert.equal(await fs.lstat(prepared).catch(() => null), null);
  assert.equal(await fs.lstat(lock).catch(() => null), null);

  const customOpeningInput = {
    ...guardedInput,
    config: { ...config, ending: structuredClone(input.config.ending) },
  };
  const allowed = await produce.prepareVideoProduction({
    input: customOpeningInput,
    runtime,
    exportOptions,
    mode: "off",
    allowCustomStructure: true,
    preparedConfigPath: prepared,
    lockPath: lock,
  });
  assert.equal(allowed.audio.status, "disabled");
});

test("one-click production guard rejects empty or init placeholder content", async () => {
  const directory = await tempDir("content-guard");
  const { input } = await sourceProject(directory);
  const config = structuredClone(input.config);
  config.opening.title.text = "  ";
  config.content.teleprompter.text!.content = "在这里填写提词文案。";

  assert.deepEqual(
    produce.standardProductionStructureIssues(config).map((issue) => issue.code),
    ["STANDARD_TITLE_REQUIRED", "STANDARD_TELEPROMPTER_REQUIRED"],
  );
  assert.throws(
    () => produce.assertStandardProductionStructure(config),
    (error: unknown) => (error as { code?: string }).code === "PRODUCTION_GUARD_FAILED",
  );
});

test("one-click production guard requires an exact 3-2-1 start and official outro audio", async () => {
  const directory = await tempDir("exact-standard-structure");
  const { input } = await sourceProject(directory);
  const config = structuredClone(input.config);
  config.opening.countdown.from = 4;
  config.ending.video.keepAudio = false;

  assert.deepEqual(
    produce.standardProductionStructureIssues(config).map((issue) => [issue.code, issue.path]),
    [
      ["STANDARD_COUNTDOWN_START_INVALID", "opening.countdown.from"],
      ["STANDARD_ENDING_AUDIO_REQUIRED", "ending.video.keepAudio"],
    ],
  );
});

test("auto mode without a key writes durable config and lock while preserving fallback BGM", async () => {
  const directory = await tempDir("fallback");
  const { input } = await sourceProject(directory);
  const warnings: Array<{ code?: string; message: string }> = [];
  const result = await produce.prepareVideoProduction({
    input,
    runtime,
    exportOptions,
    mode: "auto",
    preparedConfigPath: path.join(directory, "output", "prepared.json"),
    lockPath: path.join(directory, "output", "video.lock.json"),
    onWarning: (warning) => warnings.push(warning),
  });

  assert.equal(result.audio.status, "skipped");
  assert.equal(result.audio.kind, "sound-effect");
  assert.equal(result.audio.reason, "missing-key");
  assert.equal(warnings[0]?.code, "BGM_GENERATION_SKIPPED");
  assert.equal((await fs.stat(result.preparedConfig)).isFile(), true);
  assert.equal((await fs.stat(result.lockPath)).isFile(), true);
  assert.equal(result.lock.config.content.bgm?.asset.kind, "builtin");
});

test("required mode without a key fails before any config, lock, or provider call", async () => {
  const directory = await tempDir("required");
  const { input } = await sourceProject(directory);
  assert.equal(input.config.content.bgm?.asset.kind, "builtin");
  assert.equal(produce.isGeneratedCandidate(input.config, "required", false), true);
  let calls = 0;
  const prepared = path.join(directory, "prepared.json");
  const lock = path.join(directory, "video.lock.json");
  await assert.rejects(
    produce.prepareVideoProduction({
      input,
      runtime,
      exportOptions,
      mode: "required",
      preparedConfigPath: prepared,
      lockPath: lock,
      mcpCall: async () => {
        calls += 1;
        return { content: [] };
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTH_REQUIRED",
  );
  assert.equal(calls, 0);
  assert.equal(await fs.lstat(prepared).catch(() => null), null);
  assert.equal(await fs.lstat(lock).catch(() => null), null);
});

test("required generates for null or built-in fallback but preserves a local upload", async () => {
  const directory = await tempDir("required-candidates");
  const { input } = await sourceProject(directory);
  assert.equal(produce.isGeneratedCandidate(input.config, "required", false), true);

  const withoutBgm = structuredClone(input.config);
  withoutBgm.content.bgm = null;
  assert.equal(produce.isGeneratedCandidate(withoutBgm, "required", false), true);

  // CLI `{kind: "file"}` references are normalized to an internal upload
  // before production candidate selection.
  const localUpload = structuredClone(input.config);
  localUpload.content.bgm = {
    asset: { kind: "upload", id: "local-bgm" },
    volume: 0.25,
  };
  assert.equal(produce.isGeneratedCandidate(localUpload, "required", false), false);
  assert.equal(produce.isGeneratedCandidate(localUpload, "required", true), true);
});

test("direct audio and one-click production share the tuned prompt and request key", async () => {
  const directory = await tempDir("shared-audio-plan");
  const { input } = await sourceProject(directory);
  const options = {
    input,
    audioKind: "music" as const,
    model: "music_v2" as const,
    prompt: "restrained cinematic award ceremony score",
    durationSec: 34,
    volume: 0.18,
  };
  const direct = produce.createNarrationAudioPlan(options);
  const production = produce.createProductionAudioPlan({
    ...options,
    mode: "auto",
    replaceBgm: false,
  });
  assert.ok(production);
  assert.equal(direct.prompt, production.prompt);
  assert.equal(direct.plan.requestKey, production.plan.requestKey);
});

test("production QA records professional geometry and explicit audio intent", async () => {
  const directory = await tempDir("quality-summary");
  const { input } = await sourceProject(directory);
  const config = structuredClone(input.config);
  config.content.device.profile = {
    id: "award-stage-prompter-v1",
    kind: "professional-teleprompter",
    aspectRatio: 1461 / 1076,
    screen: { x: 0.196, y: 0.14, w: 0.606, h: 0.314 },
  };
  config.content.layout = {
    preset: "stage-mic-above-prompter",
    minimumVerticalSeparation: 0.05,
  };
  config.content.mic.transform.y = 0.17;
  config.content.device.transform.y = 0.58;
  const audio = {
    kind: "music" as const,
    mode: "required" as const,
    status: "generated" as const,
    reason: "elevenlabs-mcp",
    prompt: "safe prompt",
    output: "/tmp/bgm.mp3",
    manifest: "/tmp/bgm.manifest.json",
    requestKey: "request-key",
    reused: false,
  };

  const summary = produce.createProductionQualitySummary(config, audio);
  assert.equal(summary.layout.passed, true);
  assert.equal(summary.layout.deviceProfile.kind, "professional-teleprompter");
  assert.equal(summary.layout.deviceProfile.screenSource, "device-profile");
  assert.equal(summary.layout.microphoneAboveDevice, true);
  assert.equal(summary.audioIntent.kind, "music");
  assert.equal(summary.audioIntent.requestKey, "request-key");
});

test("explicit music preparation tunes prompt, calls MCP, wires BGM, and force still reuses it", async () => {
  const directory = await tempDir("mcp");
  const { input } = await sourceProject(directory);
  const fixture = await fs.readFile(path.join(ROOT, "public", "assets", "builtin", "airport-bgm.mp3"));
  let calls = 0;
  let prompt = "";
  const mcpCall = async (request: Parameters<NonNullable<Parameters<typeof produce.prepareVideoProduction>[0]["mcpCall"]>>[0]) => {
    calls += 1;
    prompt = String(request.arguments.prompt);
    await fs.writeFile(path.join(request.outputDirectory, "music.mp3"), fixture);
    return { content: [] };
  };
  const first = await produce.prepareVideoProduction({
    input,
    runtime,
    exportOptions,
    mode: "auto",
    audioKind: "music",
    prompt: "warm modern acoustic textures",
    durationSec: 34,
    preparedConfigPath: path.join(directory, "output", "first.prepared.json"),
    lockPath: path.join(directory, "output", "first.lock.json"),
    elevenLabsApiKey: "test-secret",
    mcpRuntime,
    mcpCall,
  });

  assert.equal(first.audio.status, "generated");
  assert.match(prompt, /A calm product launch/);
  assert.match(prompt, /warm modern acoustic textures/);
  assert.match(prompt, /No vocals/);
  assert.equal(first.lock.config.content.bgm?.asset.kind, "upload");
  assert.equal(first.lock.assets.some((asset) => asset.mime === "audio/mpeg"), true);
  assert.equal((await fs.stat(first.audio.output!)).isFile(), true);
  assert.equal((await fs.stat(first.audio.manifest!)).isFile(), true);

  const second = await produce.prepareVideoProduction({
    input,
    runtime,
    exportOptions,
    mode: "auto",
    audioKind: "music",
    prompt: "warm modern acoustic textures",
    durationSec: 34,
    preparedConfigPath: first.preparedConfig,
    lockPath: first.lockPath,
    overwrite: true,
    elevenLabsApiKey: "test-secret",
    mcpRuntime,
    mcpCall,
  });
  assert.equal(second.audio.status, "reused");
  assert.equal(calls, 1);
  assert.equal(second.audio.output, first.audio.output);

  const offlineReuse = await produce.prepareVideoProduction({
    input,
    runtime,
    exportOptions,
    mode: "auto",
    audioKind: "music",
    prompt: "warm modern acoustic textures",
    durationSec: 34,
    replaceBgm: true,
    offline: true,
    preparedConfigPath: path.join(directory, "output", "offline-reuse.prepared.json"),
    lockPath: path.join(directory, "output", "offline-reuse.lock.json"),
    mcpRuntime,
    mcpCall,
  });
  assert.equal(offlineReuse.audio.status, "reused");
  assert.equal(offlineReuse.audio.output, first.audio.output);
  assert.equal(calls, 1, "offline cache reuse must not call MCP");

  await fs.writeFile(first.audio.manifest!, "{}\n");
  await assert.rejects(
    produce.prepareVideoProduction({
      input,
      runtime,
      exportOptions,
      mode: "auto",
      audioKind: "music",
      prompt: "warm modern acoustic textures",
      durationSec: 34,
      preparedConfigPath: path.join(directory, "output", "third.prepared.json"),
      lockPath: path.join(directory, "output", "third.lock.json"),
      overwrite: true,
      elevenLabsApiKey: "test-secret",
      mcpRuntime,
      mcpCall,
    }),
    (error: unknown) => (error as { code?: string }).code === "OUTPUT_EXISTS",
  );
  assert.equal(calls, 1, "produce --force must not authorize a fresh paid audio call");
});

test("one-click default builds a narration-safe sound-effect loop and wires it through content.bgm", async () => {
  const directory = await tempDir("sound-effect");
  const { input } = await sourceProject(directory);
  const fixture = await fs.readFile(path.join(ROOT, "public", "assets", "builtin", "open-sfx.mp3"));
  let tool = "";
  let argumentsReceived: Record<string, unknown> = {};
  const result = await produce.prepareVideoProduction({
    input,
    runtime,
    exportOptions,
    mode: "auto",
    prompt: "steady commercial aircraft cockpit and cabin ambience",
    durationSec: 2.4,
    preparedConfigPath: path.join(directory, "output", "prepared.json"),
    lockPath: path.join(directory, "output", "video.lock.json"),
    elevenLabsApiKey: "test-secret",
    mcpRuntime,
    mcpCall: async (request) => {
      tool = request.tool;
      argumentsReceived = { ...request.arguments };
      await fs.writeFile(path.join(request.outputDirectory, "aircraft.mp3"), fixture);
      return { content: [] };
    },
  });

  assert.equal(result.audio.kind, "sound-effect");
  assert.equal(result.audio.status, "generated");
  assert.equal(tool, "text_to_sound_effects");
  assert.match(String(argumentsReceived.text), /aircraft cockpit and cabin ambience/);
  assert.match(String(argumentsReceived.text), /No music/);
  assert.ok(String(argumentsReceived.text).length <= 450);
  assert.equal(argumentsReceived.loop, true);
  assert.equal(argumentsReceived.output_format, "mp3_44100_128");
  assert.equal(result.lock.config.content.bgm?.asset.kind, "upload");
});

test("one-click default infers stable aircraft ambience without a bgm prompt", async () => {
  const directory = await tempDir("sound-effect-default-inference");
  const { input } = await sourceProject(directory);
  const config = structuredClone(input.config);
  config.opening.title.text = "Controlled emergency practice";
  assert.equal(config.content.teleprompter.mode, "text");
  if (config.content.teleprompter.mode !== "text" || !config.content.teleprompter.text) {
    throw new Error("expected text teleprompter fixture");
  }
  config.content.teleprompter.text.content =
    "Mayday, Mayday, Mayday. Approach, Flight 724. Engine fire on the number 2 engine. We have shut it down and are requesting immediate vectors t";
  const aviationInput = { ...input, config };
  const fixture = await fs.readFile(path.join(ROOT, "public", "assets", "builtin", "open-sfx.mp3"));
  let argumentsReceived: Record<string, unknown> = {};
  const result = await produce.prepareVideoProduction({
    input: aviationInput,
    runtime,
    exportOptions,
    mode: "auto",
    durationSec: 2.4,
    preparedConfigPath: path.join(directory, "output", "prepared.json"),
    lockPath: path.join(directory, "output", "video.lock.json"),
    elevenLabsApiKey: "test-secret",
    mcpRuntime,
    mcpCall: async (request) => {
      argumentsReceived = { ...request.arguments };
      await fs.writeFile(path.join(request.outputDirectory, "aircraft.mp3"), fixture);
      return { content: [] };
    },
  });

  const prompt = String(argumentsReceived.text);
  assert.equal(result.audio.prompt, prompt);
  assert.ok(prompt.length <= 450);
  assert.match(prompt, /modern commercial aircraft/i);
  assert.match(prompt, /cockpit and cabin/i);
  assert.match(prompt, /turbofan/i);
  assert.match(prompt, /ventilation/i);
  assert.match(prompt, /avionics/i);
  assert.match(prompt, /airframe/i);
  assert.match(prompt, /No music/i);
  assert.match(prompt, /voices/i);
  assert.match(prompt, /dialogue/i);
  assert.match(prompt, /alarms/i);
  assert.match(prompt, /drama/i);
  assert.doesNotMatch(prompt, /Mayday|Flight 724|Engine fire|vectors t/i);
  assert.equal(argumentsReceived.loop, true);
  assert.equal(argumentsReceived.output_format, "mp3_44100_128");
});

test("replace-bgm makes offline or missing credentials a hard service error", async () => {
  const directory = await tempDir("replace-required");
  const { input } = await sourceProject(directory, null);
  assert.equal(produce.isGeneratedCandidate(input.config, "auto", false), false);
  assert.equal(produce.isGeneratedCandidate(input.config, "auto", true), true);

  await assert.rejects(
    produce.prepareVideoProduction({
      input,
      runtime,
      exportOptions,
      mode: "auto",
      replaceBgm: true,
      offline: true,
      preparedConfigPath: path.join(directory, "offline.prepared.json"),
      lockPath: path.join(directory, "offline.lock.json"),
    }),
    (error: unknown) => (error as { code?: string }).code === "OFFLINE_RESOURCE_MISSING",
  );
  await assert.rejects(
    produce.prepareVideoProduction({
      input,
      runtime,
      exportOptions,
      mode: "auto",
      replaceBgm: true,
      preparedConfigPath: path.join(directory, "missing-key.prepared.json"),
      lockPath: path.join(directory, "missing-key.lock.json"),
    }),
    (error: unknown) => (error as { code?: string }).code === "AUTH_REQUIRED",
  );
  assert.equal(await fs.lstat(path.join(directory, "offline.prepared.json")).catch(() => null), null);
  assert.equal(await fs.lstat(path.join(directory, "missing-key.prepared.json")).catch(() => null), null);
});

test("auto respects explicit null and existing local BGM unless replace is requested", async () => {
  const directory = await tempDir("preserve");
  const explicitNull = await sourceProject(directory, null);
  const preserved = await produce.prepareVideoProduction({
    input: explicitNull.input,
    runtime,
    exportOptions,
    mode: "auto",
    preparedConfigPath: path.join(directory, "null.prepared.json"),
    lockPath: path.join(directory, "null.lock.json"),
  });
  assert.equal(preserved.audio.status, "preserved");
  assert.equal(preserved.lock.config.content.bgm, null);
});
