import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledDirectory = await fs.mkdtemp(path.join(ROOT, ".cli-audio-test-"));
const compiledFile = path.join(compiledDirectory, "audio.mjs");
const temporaryDirectories: string[] = [];

type AudioModule = typeof import("../cli/audio.ts");
let audio: AudioModule;

before(async () => {
  await build({
    entryPoints: [path.join(ROOT, "cli", "audio.ts")],
    outfile: compiledFile,
    bundle: true,
    packages: "external",
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  audio = (await import(`${pathToFileURL(compiledFile).href}?t=${Date.now()}`)) as AudioModule;
});

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  await fs.rm(compiledDirectory, { recursive: true, force: true });
});

async function tempDir(label: string): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `littlestart-audio-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

async function fixtureMp3(): Promise<Uint8Array> {
  return fs.readFile(path.join(ROOT, "public", "assets", "builtin", "airport-bgm.mp3"));
}

async function fixtureSoundEffectMp3(): Promise<Uint8Array> {
  return fs.readFile(path.join(ROOT, "public", "assets", "builtin", "open-sfx.mp3"));
}

const runtime = {
  command: "/fake/elevenlabs-mcp",
  args: [],
  source: "bundled",
  version: "0.11.0",
  integrity: "pinned-bundle",
} as const;

test("explicit music plan is deterministic, bounded, instrumental, and MCP-only", async () => {
  const directory = await tempDir("plan");
  const first = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Warm minimal ambient instrumental under spoken narration",
    contentDurationSec: 725.5,
    baseDir: directory,
  });
  const second = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "  Warm minimal ambient instrumental under spoken narration  ",
    contentDurationSec: 725.5,
    baseDir: directory,
  });

  assert.equal(first.auth.mode, "mcp");
  assert.equal(first.auth.credentialSource, "ELEVENLABS_API_KEY");
  assert.equal(first.transport.kind, "mcp-stdio");
  assert.equal(first.transport.tool, "compose_music");
  assert.equal(first.model, "music_v2");
  assert.equal(first.generationDurationSec, 600);
  assert.equal(first.loopRequired, true);
  assert.equal(first.forceInstrumental, true);
  assert.equal("outputFormat" in first, false);
  assert.equal(first.volume, 0.25);
  assert.equal(first.requestKey, second.requestKey);
  assert.match(first.outputPath, /bgm-[a-f0-9]{16}\.mp3$/);

  const prompt = audio.createNarrationBgmPrompt({
    title: "Launch update",
    context: "A calm product explanation",
    durationSec: 18,
  });
  assert.match(prompt, /instrumental/i);
  assert.match(prompt, /No vocals/i);
  assert.match(prompt, /narration-friendly/i);
  assert.match(prompt, /copyrighted/i);

  assert.throws(
    () => audio.createAudioGenerationPlan({ kind: "music", prompt: "test", contentDurationSec: 10, generationDurationSec: 2.9 }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_OPTION_VALUE",
  );
});

test("default sound-effect prompt infers aircraft sources without copying emergency dialogue", () => {
  const dialogue =
    "Mayday, Mayday, Mayday. Approach, Flight 724. Engine fire on the number 2 engine. We have shut it down and are requesting immediate vectors t";
  const direction = audio.inferEnvironmentalSoundDirection({ context: dialogue });
  assert.match(direction, /modern commercial aircraft/i);
  assert.match(direction, /cockpit and cabin/i);
  assert.match(direction, /turbofan/i);
  assert.match(direction, /ventilation/i);
  assert.match(direction, /avionics/i);
  assert.match(direction, /airframe/i);

  const prompt = audio.createNarrationSoundEffectPrompt({ context: dialogue });
  assert.ok(prompt.length <= audio.MAX_SOUND_EFFECT_PROMPT_CHARS);
  assert.match(prompt, /modern commercial aircraft/i);
  assert.match(prompt, /No music/i);
  assert.match(prompt, /voices/i);
  assert.match(prompt, /dialogue/i);
  assert.match(prompt, /alarms/i);
  assert.match(prompt, /drama/i);
  assert.doesNotMatch(prompt, /Mayday|Flight 724|Engine fire|vectors t/i);

  const explicit = audio.createNarrationSoundEffectPrompt({
    context: dialogue,
    direction: "dry library room tone with soft ventilation and faint page movement",
  });
  assert.match(explicit, /dry library room tone with soft ventilation and faint page movement/i);
  assert.doesNotMatch(explicit, /commercial aircraft/i);

  const trainingPresentation = audio.inferEnvironmentalSoundDirection({
    context: "A business training presentation for a product update",
  });
  assert.match(trainingPresentation, /workspace room tone/i);
  assert.doesNotMatch(trainingPresentation, /passenger-train|road-vehicle/i);

  const wordBounded = audio.createNarrationSoundEffectPrompt({
    direction: `${"soft ventilation ambience ".repeat(20)}distinctiveendingword`,
  });
  assert.ok(wordBounded.length <= audio.MAX_SOUND_EFFECT_PROMPT_CHARS);
  assert.doesNotMatch(wordBounded, /distinctiveendingw?o?r?d?/i);
});

test("default plan uses the official looping sound-effect MCP contract and records kind plus tool", async () => {
  const directory = await tempDir("sound-effect");
  const defaultPlan = audio.createAudioGenerationPlan({
    prompt: "Steady commercial aircraft cabin ambience, no music or voices",
    contentDurationSec: 24,
    baseDir: directory,
  });
  assert.equal(defaultPlan.kind, "sound-effect");
  assert.equal(defaultPlan.transport.tool, "text_to_sound_effects");
  assert.equal(defaultPlan.model, null);
  assert.equal(defaultPlan.generationDurationSec, 5);
  assert.equal(defaultPlan.outputFormat, "mp3_44100_128");
  assert.equal(defaultPlan.generationLoop, true);
  assert.match(defaultPlan.outputPath, /sfx-[a-f0-9]{16}\.mp3$/);
  assert.throws(
    () => audio.createAudioGenerationPlan({
      kind: "sound-effect",
      prompt: "x".repeat(451),
      contentDurationSec: 24,
    }),
    (error: unknown) => (error as { code?: string }).code === "INVALID_OPTION_VALUE",
  );
  assert.throws(
    () => audio.createAudioGenerationPlan({
      kind: "sound-effect",
      model: "music_v2",
      prompt: "aircraft ambience",
      contentDurationSec: 24,
    }),
    (error: unknown) => (error as { code?: string }).code === "OPTION_CONFLICT",
  );

  const plan = audio.createAudioGenerationPlan({
    kind: "sound-effect",
    prompt: "Steady commercial aircraft cabin ambience, no music or voices",
    contentDurationSec: 24,
    generationDurationSec: 2.4,
    baseDir: directory,
  });
  const bytes = await fixtureSoundEffectMp3();
  let requestTool = "";
  let received: Record<string, unknown> = {};
  const result = await audio.generatePlannedAudio({
    plan,
    elevenLabsApiKey: "test-secret",
    runtime,
    mcpCall: async (request) => {
      requestTool = request.tool;
      received = { ...request.arguments };
      await fs.writeFile(path.join(request.outputDirectory, "ambience.mp3"), bytes);
      return { content: [] };
    },
  });
  assert.equal(requestTool, "text_to_sound_effects");
  assert.equal(received.text, plan.prompt);
  assert.equal(received.duration_seconds, 2.4);
  assert.equal(received.output_format, "mp3_44100_128");
  assert.equal(received.loop, true);
  assert.equal("model_id" in received, false);
  assert.equal(result.kind, "sound-effect");
  const manifest = JSON.parse(await fs.readFile(plan.manifestPath, "utf8")) as {
    request: { kind: string; tool: string; loop?: boolean; outputFormat?: string };
    providerResponse: { tool: string };
  };
  assert.equal(manifest.request.kind, "sound-effect");
  assert.equal(manifest.request.tool, "text_to_sound_effects");
  assert.equal(manifest.request.loop, true);
  assert.equal(manifest.request.outputFormat, "mp3_44100_128");
  assert.equal(manifest.providerResponse.tool, "text_to_sound_effects");
});

test("official MCP generation verifies and atomically commits audio plus manifest", async () => {
  const directory = await tempDir("mcp");
  const output = path.join(directory, "bgm.mp3");
  const manifest = path.join(directory, "bgm.manifest.json");
  const bytes = await fixtureMp3();
  let received: Record<string, unknown> | undefined;
  let receivedKey: string | undefined;
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Soft electronic instrumental under narration",
    contentDurationSec: 34.1,
    generationDurationSec: 34,
    outputPath: output,
    manifestPath: manifest,
  });
  const result = await audio.generatePlannedAudio({
    plan,
    elevenLabsApiKey: "eleven-secret-for-test",
    runtime,
    mcpCall: async (request) => {
      received = { ...request.arguments };
      receivedKey = request.apiKey;
      await fs.writeFile(path.join(request.outputDirectory, "generated.mp3"), bytes);
      return { content: [{ type: "text", text: "saved" }] };
    },
    now: () => new Date("2026-07-28T00:00:00.000Z"),
  });

  assert.equal(receivedKey, "eleven-secret-for-test");
  assert.equal(received?.force_instrumental, true);
  assert.equal(received?.music_length_ms, 34_000);
  assert.equal(received?.model_id, "music_v2");
  assert.equal(received?.output_directory !== undefined, true);
  assert.equal(result.authMode, "mcp");
  assert.equal(result.reused, false);
  assert.equal(result.media.audioCodec !== null, true);
  assert.equal(plan.loopRequired, true);
  assert.equal(result.loopRequired, false, "looping follows the probed audio duration");
  assert.match(result.digest, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(await fs.readFile(output), Buffer.from(bytes));

  const manifestText = await fs.readFile(manifest, "utf8");
  const body = JSON.parse(manifestText) as Record<string, unknown>;
  assert.equal(manifestText.includes("eleven-secret-for-test"), false);
  assert.equal((body.request as { authMode: string }).authMode, "mcp");
  const providerResponse = body.providerResponse as {
    tool: string;
    runtime: { source: string; integrity: string };
    pinnedBundle?: { wheelSha256: string };
  };
  assert.equal(providerResponse.tool, "compose_music");
  assert.deepEqual(providerResponse.runtime, {
    source: "bundled",
    integrity: "pinned-bundle",
    version: "0.11.0",
  });
  assert.match(providerResponse.pinnedBundle?.wheelSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal((body.audio as { loopRequired: boolean }).loopRequired, false);
});

test("an explicit unverified MCP runtime is recorded without pinned bundle attestation", async () => {
  const directory = await tempDir("unverified-runtime");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Minimal instrumental bed",
    contentDurationSec: 34,
    generationDurationSec: 34,
    baseDir: directory,
  });
  const bytes = await fixtureMp3();
  await audio.generatePlannedAudio({
    plan,
    elevenLabsApiKey: "test-secret",
    runtime: {
      command: "/custom/mcp",
      args: [],
      source: "explicit",
      version: "0.11.0",
      integrity: "unverified",
    },
    mcpCall: async (request) => {
      await fs.writeFile(path.join(request.outputDirectory, "custom.mp3"), bytes);
      return { content: [] };
    },
  });
  const manifest = JSON.parse(await fs.readFile(plan.manifestPath, "utf8")) as {
    providerResponse: {
      requestedDistribution: string;
      runtime: { source: string; integrity: string };
      pinnedBundle?: unknown;
    };
  };
  assert.equal(manifest.providerResponse.requestedDistribution, "elevenlabs-mcp==0.11.0");
  assert.deepEqual(manifest.providerResponse.runtime, {
    source: "explicit",
    integrity: "unverified",
    version: "0.11.0",
  });
  assert.equal("pinnedBundle" in manifest.providerResponse, false);
});

test("matching manifest safely reuses paid audio without key or MCP call", async () => {
  const directory = await tempDir("reuse");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Quiet acoustic bed",
    contentDurationSec: 34,
    generationDurationSec: 34,
    baseDir: directory,
  });
  const bytes = await fixtureMp3();
  let calls = 0;
  const call = async (request: Parameters<NonNullable<Parameters<typeof audio.generatePlannedAudio>[0]["mcpCall"]>>[0]) => {
    calls += 1;
    await fs.writeFile(path.join(request.outputDirectory, "first.mp3"), bytes);
    return { content: [] };
  };
  const first = await audio.generatePlannedAudio({
    plan,
    elevenLabsApiKey: "test-secret",
    runtime,
    mcpCall: call,
  });
  const second = await audio.generatePlannedAudio({ plan, runtime, mcpCall: call });
  const forced = await audio.generatePlannedAudio({
    plan,
    runtime,
    mcpCall: call,
    overwrite: true,
  });
  const offline = await audio.generatePlannedAudio({
    plan,
    runtime,
    mcpCall: call,
    remoteAllowed: false,
    remoteDisabledError: "OFFLINE_RESOURCE_MISSING",
  });
  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(forced.reused, true);
  assert.equal(offline.reused, true);
  assert.equal(calls, 1);
  assert.equal(second.digest, first.digest);
  assert.equal(forced.digest, first.digest);
  assert.equal(offline.digest, first.digest);
});

test("remote-disabled cache miss never reaches MCP and preserves the caller's reason", async () => {
  const directory = await tempDir("cache-only-miss");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Verified cache only",
    contentDurationSec: 12,
    generationDurationSec: 3,
    baseDir: directory,
  });
  let calls = 0;
  await assert.rejects(
    audio.generatePlannedAudio({
      plan,
      remoteAllowed: false,
      remoteDisabledError: "OFFLINE_RESOURCE_MISSING",
      mcpCall: async () => {
        calls += 1;
        return { content: [] };
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "OFFLINE_RESOURCE_MISSING",
  );
  assert.equal(calls, 0);
});

test("concurrent identical generation is paid once and a cancelled waiter cannot release its lock", async () => {
  const directory = await tempDir("race");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Sparse piano texture",
    contentDurationSec: 34,
    generationDurationSec: 34,
    baseDir: directory,
  });
  const bytes = await fixtureMp3();
  let calls = 0;
  let markStarted!: () => void;
  let releaseProvider!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const providerGate = new Promise<void>((resolve) => {
    releaseProvider = resolve;
  });
  const mcpCall = async (
    request: Parameters<NonNullable<Parameters<typeof audio.generatePlannedAudio>[0]["mcpCall"]>>[0],
  ) => {
    calls += 1;
    markStarted();
    await providerGate;
    await fs.writeFile(path.join(request.outputDirectory, "race.mp3"), bytes);
    return { content: [] };
  };

  const firstPromise = audio.generatePlannedAudio({
    plan,
    elevenLabsApiKey: "test-secret",
    runtime,
    mcpCall,
  });
  await started;

  const controller = new AbortController();
  const cancelledWaiter = audio.generatePlannedAudio({
    plan,
    runtime,
    mcpCall,
    signal: controller.signal,
  });
  controller.abort(new Error("cancel duplicate"));
  await assert.rejects(
    cancelledWaiter,
    (error: unknown) => (error as { code?: string }).code === "INTERRUPTED",
  );

  const secondPromise = audio.generatePlannedAudio({ plan, runtime, mcpCall });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls, 1, "the waiter must not enter the paid call");
  releaseProvider();
  const [first, second] = await Promise.all([firstPromise, secondPromise]);

  assert.equal(first.reused, false);
  assert.equal(second.reused, true);
  assert.equal(calls, 1);
  const lockLeftovers = (await fs.readdir(path.dirname(plan.outputPath))).filter((name) =>
    name.startsWith(".littlestart-audio-"),
  );
  assert.deepEqual(lockLeftovers, []);
});

test("materially truncated generated audio is rejected before publication", async () => {
  const directory = await tempDir("truncated");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Long restrained ambient bed",
    contentDurationSec: 40,
    generationDurationSec: 40,
    baseDir: directory,
  });
  const bytes = await fixtureMp3();
  await assert.rejects(
    audio.generatePlannedAudio({
      plan,
      elevenLabsApiKey: "test-secret",
      runtime,
      mcpCall: async (request) => {
        await fs.writeFile(path.join(request.outputDirectory, "truncated.mp3"), bytes);
        return { content: [] };
      },
    }),
    (error: unknown) => {
      const value = error as { code?: string; details?: { toleranceSec?: number } };
      return (
        value.code === "REMOTE_REQUEST_FAILED" &&
        value.details?.toleranceSec === audio.GENERATED_AUDIO_DURATION_TOLERANCE_SEC
      );
    },
  );
  assert.equal(await fs.lstat(plan.outputPath).catch(() => null), null);
  assert.equal(await fs.lstat(plan.manifestPath).catch(() => null), null);
  const leftovers = await fs.readdir(path.dirname(plan.outputPath));
  assert.equal(leftovers.some((name) => name.includes(".partial")), false);
  assert.equal(leftovers.some((name) => name.startsWith(".littlestart-elevenlabs-")), false);
  assert.equal(leftovers.some((name) => name.startsWith(".littlestart-audio-")), false);
});

test("materially overlong generated audio is rejected before publication", async () => {
  const directory = await tempDir("overlong");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Short restrained musical sting",
    contentDurationSec: 3,
    generationDurationSec: 3,
    baseDir: directory,
  });
  const bytes = await fixtureMp3();
  await assert.rejects(
    audio.generatePlannedAudio({
      plan,
      elevenLabsApiKey: "test-secret",
      runtime,
      mcpCall: async (request) => {
        await fs.writeFile(path.join(request.outputDirectory, "overlong.mp3"), bytes);
        return { content: [] };
      },
    }),
    (error: unknown) => {
      const value = error as {
        code?: string;
        details?: { direction?: string; toleranceSec?: number };
      };
      return value.code === "REMOTE_REQUEST_FAILED" &&
        value.details?.direction === "longer" &&
        value.details?.toleranceSec === audio.GENERATED_AUDIO_DURATION_TOLERANCE_SEC;
    },
  );
  assert.equal(await fs.lstat(plan.outputPath).catch(() => null), null);
  assert.equal(await fs.lstat(plan.manifestPath).catch(() => null), null);
});

test("missing auth and mismatched existing outputs fail before paid MCP call", async () => {
  const directory = await tempDir("preflight");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Quiet instrumental",
    contentDurationSec: 10,
    generationDurationSec: 3,
    baseDir: directory,
  });
  let calls = 0;
  const mcpCall = async () => {
    calls += 1;
    return { content: [] };
  };
  await assert.rejects(
    audio.generatePlannedAudio({ plan, runtime, mcpCall }),
    (error: unknown) => (error as { code?: string }).code === "AUTH_REQUIRED",
  );
  assert.equal(calls, 0);

  await fs.mkdir(path.dirname(plan.outputPath), { recursive: true });
  await fs.writeFile(plan.outputPath, "old");
  await assert.rejects(
    audio.generatePlannedAudio({
      plan,
      elevenLabsApiKey: "test-secret",
      runtime,
      mcpCall,
    }),
    (error: unknown) => (error as { code?: string }).code === "OUTPUT_EXISTS",
  );
  assert.equal(calls, 0);
});

test("MCP output must contain exactly one regular MP3 and staging is cleaned", async () => {
  const directory = await tempDir("contract");
  const plan = audio.createAudioGenerationPlan({
    kind: "music",
    prompt: "Quiet instrumental",
    contentDurationSec: 10,
    generationDurationSec: 3,
    baseDir: directory,
  });
  const bytes = await fixtureMp3();
  await assert.rejects(
    audio.generatePlannedAudio({
      plan,
      elevenLabsApiKey: "test-secret",
      runtime,
      mcpCall: async (request) => {
        await Promise.all([
          fs.writeFile(path.join(request.outputDirectory, "one.mp3"), bytes),
          fs.writeFile(path.join(request.outputDirectory, "two.mp3"), bytes),
        ]);
        return { content: [] };
      },
    }),
    (error: unknown) => (error as { code?: string }).code === "MCP_PROTOCOL_ERROR",
  );
  const leftovers = (await fs.readdir(directory)).filter((name) => name.startsWith(".littlestart-elevenlabs-"));
  assert.deepEqual(leftovers, []);
});
