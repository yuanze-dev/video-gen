const { execFileSync, spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { verifyEncodedProduction } = require("./verify-encoded-production.cjs");

const {
  EXECUTABLE_NAME,
  MANIFEST_NAME,
  assertArm64MachO,
  assertGplPayloadPresent,
  createBundleInventory,
  sha256File,
  validatePinnedLock,
} = require("../mcp/elevenlabs/package-utils.cjs");

const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_SMOKE_API_KEY = "littlestart-packaged-smoke-invalid-key";
const PACKAGED_PRODUCTION_TIMEOUT_MS = 5 * 60 * 1000;
const PACKAGED_PRODUCTION_TITLE = "Littlestart packaged one-click production check";
const PACKAGED_PRODUCTION_SCRIPT = [
  "Mayday, Mayday, Mayday. Approach, Flight 724 reporting an engine fire.",
  "We have shut the affected engine down and are maintaining controlled flight.",
  "Request immediate vectors, priority landing clearance, and emergency services standing by.",
  "Confirm the runway, wind, and any further instructions. Flight 724 is ready to read back.",
].join("\n\n");
const MCP_REQUIRED_INPUTS = [
  "composition_plan",
  "force_instrumental",
  "model_id",
  "music_length_ms",
  "output_directory",
  "prompt",
  "seed",
  "store_for_inpainting",
];
const MCP_SOUND_EFFECT_REQUIRED_INPUTS = [
  "duration_seconds",
  "loop",
  "output_directory",
  "output_format",
  "text",
];

function writeJsonRpc(stream, message) {
  stream.write(`${JSON.stringify(message)}\n`);
}

function validateToolsList(tools, lock) {
  if (!Array.isArray(tools)) throw new Error("MCP tools/list did not return an array");
  if (tools.length !== lock.expectedToolCount) {
    throw new Error(`MCP tools/list count mismatch: ${tools.length} != ${lock.expectedToolCount}`);
  }
  const byName = new Map(tools.map((tool) => [tool?.name, tool]));
  for (const expectedName of lock.expectedTools) {
    if (!byName.has(expectedName)) throw new Error(`Packaged MCP tool missing: ${expectedName}`);
  }
  for (const expectedName of lock.expectedSoundEffectTools) {
    if (!byName.has(expectedName)) throw new Error(`Packaged MCP tool missing: ${expectedName}`);
  }

  const composeMusic = byName.get("compose_music");
  if (composeMusic.inputSchema?.type !== "object") {
    throw new Error("compose_music inputSchema must be an object");
  }
  const properties = composeMusic.inputSchema.properties;
  if (!properties || typeof properties !== "object" || Array.isArray(properties)) {
    throw new Error("compose_music inputSchema properties are missing");
  }
  for (const property of MCP_REQUIRED_INPUTS) {
    if (!Object.hasOwn(properties, property)) {
      throw new Error(`compose_music inputSchema property missing: ${property}`);
    }
  }

  const soundEffect = byName.get("text_to_sound_effects");
  if (soundEffect.inputSchema?.type !== "object") {
    throw new Error("text_to_sound_effects inputSchema must be an object");
  }
  const soundEffectProperties = soundEffect.inputSchema.properties;
  if (
    !soundEffectProperties ||
    typeof soundEffectProperties !== "object" ||
    Array.isArray(soundEffectProperties)
  ) {
    throw new Error("text_to_sound_effects inputSchema properties are missing");
  }
  for (const property of MCP_SOUND_EFFECT_REQUIRED_INPUTS) {
    if (!Object.hasOwn(soundEffectProperties, property)) {
      throw new Error(`text_to_sound_effects inputSchema property missing: ${property}`);
    }
  }
  return {
    toolCount: tools.length,
    musicTools: lock.expectedTools.filter((name) => byName.has(name)),
    soundEffectTools: lock.expectedSoundEffectTools.filter((name) => byName.has(name)),
  };
}

function compactChildOutput(value) {
  const text = Buffer.isBuffer(value) ? value.toString("utf8") : String(value ?? "");
  return text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 600);
}

function parseCliEnvelope(stdout, expectedCommand) {
  let envelope;
  try {
    envelope = JSON.parse(String(stdout).trim());
  } catch (error) {
    throw new Error(
      `packaged CLI ${expectedCommand} emitted invalid JSON: ${compactChildOutput(stdout) || "<empty>"}`,
      { cause: error },
    );
  }
  if (
    !envelope ||
    typeof envelope !== "object" ||
    envelope.ok !== true ||
    envelope.protocolVersion !== "1" ||
    envelope.command !== expectedCommand ||
    !envelope.result ||
    typeof envelope.result !== "object" ||
    Array.isArray(envelope.result)
  ) {
    throw new Error(`packaged CLI ${expectedCommand} did not return a successful protocol v1 envelope`);
  }
  return envelope.result;
}

function requireFiniteNumber(value, label) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`packaged production result is missing numeric ${label}`);
  }
  return value;
}

function requireScene(scenes, name, fps) {
  const scene = scenes?.[name];
  if (!scene || typeof scene !== "object" || Array.isArray(scene)) {
    throw new Error(`packaged production result is missing scenes.${name}`);
  }
  const seconds = requireFiniteNumber(scene.seconds, `scenes.${name}.seconds`);
  const frames = requireFiniteNumber(scene.frames, `scenes.${name}.frames`);
  if (!Number.isInteger(frames) || frames < 1 || seconds <= 0) {
    throw new Error(`packaged production scenes.${name} is not a positive timeline segment`);
  }
  if (Math.abs(seconds - frames / fps) > 1 / fps + 1e-6) {
    throw new Error(`packaged production scenes.${name} seconds/frames disagree`);
  }
  return { seconds, frames };
}

/**
 * Validate the final one-click result without trusting a successful exit code.
 * This intentionally fails closed when the CLI response schema changes: the
 * release gate must be updated alongside any intentional protocol change.
 */
function validatePackagedProductionResult(result, expected) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("packaged production result is not an object");
  }
  const output = path.resolve(String(result.output ?? ""));
  const expectedOutput = path.resolve(expected.output);
  if (output !== expectedOutput) {
    throw new Error(`packaged production output mismatch: ${output} != ${expectedOutput}`);
  }
  const outputStat = fs.lstatSync(expectedOutput);
  if (!outputStat.isFile() || outputStat.isSymbolicLink() || outputStat.size <= 0) {
    throw new Error("packaged production output is not a non-empty regular MP4 file");
  }

  for (const [field, file] of [
    ["preparedConfig", expected.preparedConfig],
    ["lock", expected.lock],
  ]) {
    if (path.resolve(String(result[field] ?? "")) !== path.resolve(file)) {
      throw new Error(`packaged production ${field} path mismatch`);
    }
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
      throw new Error(`packaged production ${field} is not a non-empty regular file`);
    }
  }

  if (
    result.export?.quality !== "small" ||
    result.export?.resolution !== "720p" ||
    result.export?.fps !== 30
  ) {
    throw new Error("packaged production export options do not match the smoke request");
  }
  if (
    result.productionGuard?.policy !== "standard" ||
    result.productionGuard?.passed !== true
  ) {
    throw new Error("packaged production did not pass the standard production guard");
  }
  const audioPrompt = String(result.audio?.prompt ?? "");
  if (
    result.audio?.kind !== "sound-effect" ||
    result.audio?.mode !== "auto" ||
    result.audio?.status !== "skipped" ||
    result.audio?.reason !== "missing-key" ||
    result.audio?.output !== null ||
    result.audio?.manifest !== null ||
    result.audio?.requestKey !== null ||
    result.audio?.reused !== false ||
    !/environmental sound effect/i.test(audioPrompt) ||
    !/aircraft cockpit and cabin ambience/i.test(audioPrompt) ||
    !/turbofan/i.test(audioPrompt) ||
    /mayday|flight\s*724|engine fire/i.test(audioPrompt)
  ) {
    throw new Error(
      "packaged production auto audio did not plan a narration-safe aircraft sound effect before its isolated missing-key fallback",
    );
  }

  const fps = 30;
  const opening = requireScene(result.scenes, "opening", fps);
  const content = requireScene(result.scenes, "content", fps);
  const ending = requireScene(result.scenes, "ending", fps);
  const total = requireScene(result.scenes, "total", fps);
  if (opening.seconds < 1) {
    throw new Error("packaged production standard opening is shorter than 1 second");
  }
  if (ending.seconds < 1) {
    throw new Error("packaged production standard ending is shorter than 1 second");
  }
  if (total.frames !== opening.frames + content.frames + ending.frames) {
    throw new Error("packaged production scene frames do not sum to the total timeline");
  }
  if (Math.abs(total.seconds - (opening.seconds + content.seconds + ending.seconds)) > 3 / fps) {
    throw new Error("packaged production scene seconds do not sum to the total timeline");
  }

  const plannedDuration = requireFiniteNumber(result.durationSec, "durationSec");
  if (Math.abs(plannedDuration - total.seconds) > 1 / fps + 1e-6) {
    throw new Error("packaged production duration does not match its planned timeline");
  }
  const media = result.media;
  if (!media || typeof media !== "object" || Array.isArray(media)) {
    throw new Error("packaged production result is missing media metadata");
  }
  if (
    media.videoCodec !== "h264" ||
    media.audioCodec !== "aac" ||
    media.container !== "mp4" ||
    media.width !== 720 ||
    media.height !== 1280
  ) {
    throw new Error(
      `packaged production media mismatch: ${media.videoCodec}/${media.audioCodec} ${media.container} ${media.width}x${media.height}`,
    );
  }
  const mediaFps = requireFiniteNumber(media.fps, "media.fps");
  if (Math.abs(mediaFps - fps) > 0.01) {
    throw new Error(`packaged production media fps mismatch: ${mediaFps}`);
  }
  const containerDuration = requireFiniteNumber(media.durationSec, "media.durationSec");
  const durationTolerance = Math.max(0.15, 3 / fps);
  if (Math.abs(containerDuration - plannedDuration) > durationTolerance) {
    throw new Error(
      `packaged production container duration mismatch: ${containerDuration} vs ${plannedDuration}`,
    );
  }
  if (requireFiniteNumber(media.sizeBytes, "media.sizeBytes") !== outputStat.size) {
    throw new Error("packaged production media size does not match the output file");
  }
  if (requireFiniteNumber(result.sizeBytes, "sizeBytes") !== outputStat.size) {
    throw new Error("packaged production result size does not match the output file");
  }

  return {
    output: expectedOutput,
    durationSec: plannedDuration,
    openingSec: opening.seconds,
    contentSec: content.seconds,
    endingSec: ending.seconds,
    sizeBytes: outputStat.size,
  };
}

function runPackagedCliJson(executable, cliEntry, args, options) {
  try {
    const stdout = execFileSync(executable, [cliEntry, ...args, "--json"], {
      cwd: options.cwd,
      encoding: "utf8",
      env: options.env,
      maxBuffer: 16 * 1024 * 1024,
      timeout: options.timeoutMs,
    });
    return parseCliEnvelope(stdout, args[0]);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("packaged CLI ")) throw error;
    const status = typeof error === "object" && error !== null && "status" in error
      ? String(error.status)
      : "unknown";
    const stderr = typeof error === "object" && error !== null && "stderr" in error
      ? compactChildOutput(error.stderr)
      : "";
    throw new Error(
      `packaged CLI ${args[0]} failed (status=${status})${stderr ? `: ${stderr}` : ""}`,
      { cause: error },
    );
  }
}

/**
 * Run the actual final-app CLI and render a no-network, no-provider-credit MP4.
 * HOME, config, cache and outputs are all disposable and are always removed.
 */
function runPackagedCliProductionSmoke({ executable, cliEntry, resources }) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), "littlestart-app-production-smoke-"));
  try {
    const home = path.join(temporary, "home");
    const project = path.join(temporary, "project");
    const tmp = path.join(temporary, "tmp");
    const cache = path.join(temporary, "cache");
    const config = path.join(project, "video.json");
    const output = path.join(project, "output.mp4");
    const preparedConfig = path.join(project, "video.prepared.json");
    const lock = path.join(project, "video.lock.json");
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(project, { recursive: true, mode: 0o700 });
    fs.mkdirSync(tmp, { recursive: true, mode: 0o700 });
    fs.mkdirSync(cache, { recursive: true, mode: 0o700 });

    const browserExecutable = path.join(
      resources,
      "render-bin",
      "chrome-headless-shell",
      "mac-arm64",
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    );
    const binariesDirectory = path.join(
      resources,
      "app.asar.unpacked",
      "node_modules",
      "@remotion",
      "compositor-darwin-arm64",
    );
    // Deliberately do not inherit process.env. In particular, a developer or CI
    // ElevenLabs key can neither influence this smoke nor appear in child logs.
    // Auto audio therefore exercises the real aircraft sound-effect planner,
    // then takes its missing-key fallback before any network/provider request.
    const env = {
      ALL_PROXY: "http://127.0.0.1:9",
      ELECTRON_RUN_AS_NODE: "1",
      HOME: home,
      HTTPS_PROXY: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      LITTLESTART_ENV_FILE: path.join(home, ".config", "littlestart", "secrets.env"),
      LITTLESTART_RESOURCES_PATH: resources,
      LOGNAME: "littlestart-smoke",
      NODE_PATH: path.join(resources, "app.asar", "node_modules"),
      NO_PROXY: "127.0.0.1,localhost,::1",
      PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
      REMOTION_BINARIES_DIR: binariesDirectory,
      REMOTION_BROWSER_EXECUTABLE: browserExecutable,
      TMPDIR: tmp,
      TZ: "UTC",
      USER: "littlestart-smoke",
      XDG_CACHE_HOME: path.join(home, ".cache"),
      XDG_CONFIG_HOME: path.join(home, ".config"),
    };

    const initialized = runPackagedCliJson(
      executable,
      cliEntry,
      ["init", config, "--minimal"],
      { cwd: project, env, timeoutMs: 60_000 },
    );
    if (
      initialized.minimal !== true ||
      path.resolve(String(initialized.config ?? "")) !== config ||
      !fs.statSync(config).isFile()
    ) {
      throw new Error("packaged CLI init --minimal did not create the requested config");
    }

    const minimal = JSON.parse(fs.readFileSync(config, "utf8"));
    if (
      !minimal?.opening?.title ||
      !minimal?.content?.teleprompter?.text ||
      Object.hasOwn(minimal.opening, "countdown") ||
      Object.hasOwn(minimal.opening, "curtain") ||
      Object.hasOwn(minimal.content, "bgm") ||
      Object.hasOwn(minimal, "ending")
    ) {
      throw new Error("packaged CLI init --minimal unexpectedly overrides standard structure");
    }
    minimal.opening.title.text = PACKAGED_PRODUCTION_TITLE;
    minimal.content.teleprompter.text.content = PACKAGED_PRODUCTION_SCRIPT;
    fs.writeFileSync(config, `${JSON.stringify(minimal, null, 2)}\n`, { mode: 0o600 });

    const produced = runPackagedCliJson(
      executable,
      cliEntry,
      [
        "produce",
        config,
        "--bgm",
        "auto",
        "--quality",
        "small",
        "--resolution",
        "720p",
        "--fps",
        "30",
        "--cache-dir",
        cache,
        "--out",
        output,
        "--prepared-config",
        preparedConfig,
        "--lock",
        lock,
      ],
      { cwd: project, env, timeoutMs: PACKAGED_PRODUCTION_TIMEOUT_MS },
    );
    const validated = validatePackagedProductionResult(produced, {
      output,
      preparedConfig,
      lock,
    });
    // Exit status and container metadata cannot detect a missing curtain, a
    // jumping teleprompter, a substituted/truncated outro, or silent timeline
    // segments. Decode the final MP4 itself while every disposable artifact is
    // still present and fail the app build on any visual/audio regression.
    const encoded = verifyEncodedProduction({
      videoPath: output,
      preparedConfigPath: preparedConfig,
      scenes: produced.scenes,
      media: produced.media,
      binariesDirectory,
      endingAssetPath: path.join(
        resources,
        "cli",
        "runtime",
        "remotion-site",
        "public",
        "assets",
        "builtin",
        "flowprompter-outro.mp4",
      ),
    });
    return { ...validated, encoded };
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}

/**
 * Performs a no-cost, strict-stdio smoke against a packaged MCP executable.
 * It sends initialize and tools/list only. Every stdout line must be JSON-RPC;
 * tools/call is deliberately unsupported here so this cannot consume credits.
 */
function runMcpStdioSmoke(executablePath, lock, options = {}) {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const resolvedExecutablePath = path.resolve(executablePath);
  const basePath = fs.mkdtempSync(path.join(os.tmpdir(), "littlestart-mcp-smoke-"));
  return new Promise((resolve, reject) => {
    let stdoutBuffer = "";
    let stderr = "";
    let initialized = false;
    let result = null;
    let settled = false;
    let shutdownTimer = null;

    const child = spawn(resolvedExecutablePath, [], {
      cwd: basePath,
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ALL_PROXY: "http://127.0.0.1:9",
        ELEVENLABS_API_KEY: MCP_SMOKE_API_KEY,
        ELEVENLABS_MCP_BASE_PATH: basePath,
        ELEVENLABS_MCP_OUTPUT_MODE: "files",
        HOME: basePath,
        HTTPS_PROXY: "http://127.0.0.1:9",
        HTTP_PROXY: "http://127.0.0.1:9",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        NO_PROXY: "",
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        PYTHONUNBUFFERED: "1",
        PYTHONUTF8: "1",
        TMPDIR: basePath,
      },
    });

    const cleanup = () => {
      clearTimeout(timeout);
      if (shutdownTimer) clearTimeout(shutdownTimer);
      fs.rmSync(basePath, { recursive: true, force: true });
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      cleanup();
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    const succeed = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(result);
    };
    const acceptLine = (line) => {
      if (line.length === 0) throw new Error("Packaged MCP emitted a blank stdout line");
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        throw new Error(
          `Packaged MCP emitted non-JSON stdout: ${line.slice(0, 160)}`,
          { cause: error },
        );
      }
      if (!message || message.jsonrpc !== "2.0") {
        throw new Error("Packaged MCP emitted a non-JSON-RPC stdout message");
      }
      if (message.id === 1) {
        if (!message.result || message.error) throw new Error("Packaged MCP initialize failed");
        initialized = true;
        writeJsonRpc(child.stdin, {
          jsonrpc: "2.0",
          method: "notifications/initialized",
        });
        writeJsonRpc(child.stdin, {
          jsonrpc: "2.0",
          id: 2,
          method: "tools/list",
          params: {},
        });
      } else if (message.id === 2) {
        if (!initialized || !message.result || message.error) {
          throw new Error("Packaged MCP tools/list failed");
        }
        result = validateToolsList(message.result.tools, lock);
        child.stdin.end();
        shutdownTimer = setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        }, 5_000);
      }
    };
    const consumeLines = () => {
      let newlineIndex = stdoutBuffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).replace(/\r$/, "");
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        acceptLine(line);
        newlineIndex = stdoutBuffer.indexOf("\n");
      }
    };

    const timeout = setTimeout(
      () => fail(new Error(`Packaged MCP stdio smoke timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
    child.on("error", fail);
    child.stdin.on("error", fail);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      stdoutBuffer += chunk;
      if (stdoutBuffer.length > 8 * 1024 * 1024) {
        fail(new Error("Packaged MCP stdout exceeded 8 MiB during smoke"));
        return;
      }
      try {
        consumeLines();
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      if (stderr.length <= 1024 * 1024) stderr += chunk;
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      try {
        if (stdoutBuffer.length > 0) {
          const trailing = stdoutBuffer.replace(/\r$/, "");
          stdoutBuffer = "";
          acceptLine(trailing);
        }
        if (stderr.includes(MCP_SMOKE_API_KEY)) {
          throw new Error("Packaged MCP leaked its smoke API key to stderr");
        }
        if (!result) {
          throw new Error(`Packaged MCP exited before tools/list (code=${code}, signal=${signal})`);
        }
        if (code !== 0 || signal !== null) {
          throw new Error(`Packaged MCP exited abnormally (code=${code}, signal=${signal})`);
        }
        succeed();
      } catch (error) {
        fail(error);
      }
    });

    writeJsonRpc(child.stdin, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: "littlestart-packaged-smoke", version: "1.0.0" },
      },
    });
  });
}

function verifyPinnedMcpBundle(mcpRoot, lockPath) {
  const lock = validatePinnedLock(JSON.parse(fs.readFileSync(lockPath, "utf8")));
  const manifestPath = path.join(mcpRoot, MANIFEST_NAME);
  const executablePath = path.join(mcpRoot, EXECUTABLE_NAME);
  for (const required of [manifestPath, executablePath, path.join(mcpRoot, "BUILD-LOCK.json")]) {
    if (!fs.statSync(required).isFile()) throw new Error(`packaged MCP resource missing: ${required}`);
  }
  if ((fs.statSync(executablePath).mode & 0o111) === 0) {
    throw new Error(`packaged MCP resource is not executable: ${executablePath}`);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  for (const key of ["distribution", "version", "sourceCommit", "wheelSha256"]) {
    if (manifest.server?.[key] !== lock.server[key]) {
      throw new Error(`packaged MCP manifest has unexpected server ${key}`);
    }
  }
  if (
    manifest.target?.platform !== "darwin" ||
    manifest.target?.arch !== "arm64" ||
    manifest.target?.pythonVersion !== lock.target.pythonVersion ||
    manifest.target?.pyinstallerVersion !== lock.target.pyinstallerVersion
  ) {
    throw new Error("packaged MCP manifest target does not match lock");
  }
  if (manifest.lockSha256 !== sha256File(lockPath)) {
    throw new Error("packaged MCP manifest lock digest does not match source lock");
  }
  if (sha256File(path.join(mcpRoot, "BUILD-LOCK.json")) !== sha256File(lockPath)) {
    throw new Error("packaged MCP build lock does not match source lock");
  }
  const sourceEntrypoint = path.join(path.dirname(lockPath), "stdio_server.py");
  if (manifest.entrypointSha256 !== sha256File(sourceEntrypoint)) {
    throw new Error("packaged MCP strict-stdio entrypoint digest does not match source");
  }
  if (manifest.expectedToolCount !== lock.expectedToolCount) {
    throw new Error("packaged MCP expected tool count does not match source lock");
  }
  if (JSON.stringify(manifest.expectedTools) !== JSON.stringify(lock.expectedTools)) {
    throw new Error("packaged MCP expected tool contract does not match source lock");
  }
  if (
    JSON.stringify(manifest.expectedSoundEffectTools) !==
    JSON.stringify(lock.expectedSoundEffectTools)
  ) {
    throw new Error("packaged MCP expected sound-effect tool contract does not match source lock");
  }

  const currentInventory = createBundleInventory(mcpRoot);
  if (JSON.stringify(currentInventory) !== JSON.stringify(manifest.bundle)) {
    throw new Error("packaged MCP payload digest does not match manifest");
  }
  assertArm64MachO(mcpRoot, currentInventory.machOFiles);
  assertGplPayloadPresent(lock, mcpRoot);
  return { executablePath, lock, manifest };
}

/**
 * electron-builder afterPack hook. Fail before signing or publishing when the
 * real app no longer contains an executable, integrity-valid CLI runtime.
 */
async function verifyCliResource(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appRoot = path.join(context.appOutDir, appName, "Contents");
  const resources = path.join(appRoot, "Resources");
  const cliRoot = path.join(resources, "cli");
  const cliEntry = path.join(cliRoot, "dist", "littlestart.cjs");
  const mcpCliEntry = path.join(cliRoot, "elevenlabs-mcp-launcher.cjs");
  const executable = path.join(appRoot, "MacOS", context.packager.appInfo.productFilename);
  const manifest = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"));

  for (const required of [
    cliEntry,
    mcpCliEntry,
    path.join(cliRoot, "runtime", "runtime.json"),
    path.join(
      resources,
      "render-bin",
      "chrome-headless-shell",
      "mac-arm64",
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    ),
    path.join(
      resources,
      "app.asar.unpacked",
      "node_modules",
      "@remotion",
      "compositor-darwin-arm64",
      "ffmpeg",
    ),
  ]) {
    if (!fs.statSync(required).isFile()) throw new Error(`packaged CLI resource missing: ${required}`);
  }

  const cliVerificationEnv = {
    ELECTRON_RUN_AS_NODE: "1",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    NODE_PATH: path.join(resources, "app.asar", "node_modules"),
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
  };
  const stdout = execFileSync(executable, [cliEntry, "version", "--json"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
    env: cliVerificationEnv,
  });
  const version = JSON.parse(stdout);
  if (
    version.ok !== true ||
    version.command !== "version" ||
    version.result?.packaged !== true ||
    version.result?.version !== manifest.version
  ) {
    throw new Error("packaged CLI version self-check failed");
  }
  process.stdout.write(`  • packaged CLI verified  version=${manifest.version}\n`);

  const capabilitiesStdout = execFileSync(
    executable,
    [cliEntry, "capabilities", "--json"],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
      env: cliVerificationEnv,
    },
  );
  const capabilities = JSON.parse(capabilitiesStdout);
  const provider = capabilities.result?.audioGeneration?.providers?.find(
    (candidate) => candidate?.id === "elevenlabs",
  );
  const soundEffect = provider?.kinds?.find((kind) => kind?.id === "sound-effect");
  if (
    capabilities.ok !== true ||
    capabilities.command !== "capabilities" ||
    provider?.defaultKind !== "sound-effect" ||
    soundEffect?.tool !== "text_to_sound_effects" ||
    provider?.mcp?.tool !== "text_to_sound_effects" ||
    !provider?.mcp?.tools?.includes("text_to_sound_effects")
  ) {
    throw new Error("packaged CLI sound-effect default self-check failed");
  }
  process.stdout.write("  • packaged CLI audio default verified  kind=sound-effect\n");

  const productionSmoke = runPackagedCliProductionSmoke({ executable, cliEntry, resources });
  process.stdout.write(
    `  • packaged CLI one-click production verified  ` +
      `opening=${productionSmoke.openingSec.toFixed(2)}s ` +
      `content=${productionSmoke.contentSec.toFixed(2)}s ` +
      `ending=${productionSmoke.endingSec.toFixed(2)}s ` +
      `total=${productionSmoke.durationSec.toFixed(2)}s h264/aac 720x1280@30fps ` +
      `scroll=${productionSmoke.encoded.scroll.minimumShift}-` +
      `${productionSmoke.encoded.scroll.maximumShift}px/frame encoded-QA=pass\n`,
  );

  const mcpRoot = path.join(resources, "mcp", "elevenlabs", "darwin-arm64");
  const mcpExecutable = path.join(mcpRoot, EXECUTABLE_NAME);
  const requireMcp = process.env.LITTLESTART_REQUIRE_ELEVENLABS_MCP === "true";
  if (!fs.existsSync(mcpExecutable)) {
    if (requireMcp) throw new Error(`required packaged ElevenLabs MCP sidecar missing: ${mcpRoot}`);
    process.stdout.write("  • packaged ElevenLabs MCP omitted (optional local build)\n");
    return;
  }

  const sourceLockPath = path.resolve(__dirname, "..", "mcp", "elevenlabs", "lock.json");
  const verified = verifyPinnedMcpBundle(mcpRoot, sourceLockPath);
  const smoke = await runMcpStdioSmoke(verified.executablePath, verified.lock);
  const launcherStdout = execFileSync(
    executable,
    [mcpCliEntry, "--littlestart-self-check"],
    {
      encoding: "utf8",
      maxBuffer: 2 * 1024 * 1024,
      timeout: 60_000,
      env: {
        ELECTRON_RUN_AS_NODE: "1",
        LANG: "en_US.UTF-8",
        LC_ALL: "en_US.UTF-8",
        NODE_PATH: path.join(resources, "app.asar", "node_modules"),
        PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        LITTLESTART_ELEVENLABS_MCP_EXECUTABLE: mcpExecutable,
        LITTLESTART_ELEVENLABS_MCP_BUNDLED: "1",
        LITTLESTART_RESOURCES_PATH: resources,
      },
    },
  );
  const launcher = JSON.parse(launcherStdout);
  if (
    launcher.ok !== true ||
    launcher.command !== "elevenlabs-mcp.self-check" ||
    launcher.result?.version !== verified.lock.server.version ||
    launcher.result?.source !== "bundled" ||
    launcher.result?.integrity !== "pinned-bundle" ||
    launcher.result?.toolCount !== verified.lock.expectedToolCount ||
    !Array.isArray(launcher.result?.musicTools) ||
    !verified.lock.expectedTools.every((name) => launcher.result.musicTools.includes(name)) ||
    !Array.isArray(launcher.result?.soundEffectTools) ||
    !verified.lock.expectedSoundEffectTools.every((name) =>
      launcher.result.soundEffectTools.includes(name)
    )
  ) {
    throw new Error("packaged ElevenLabs MCP launcher self-check failed");
  }
  process.stdout.write(
    `  • packaged ElevenLabs MCP verified  version=${verified.lock.server.version} tools=${smoke.toolCount}\n`,
  );
}

module.exports = {
  MCP_PROTOCOL_VERSION,
  parseCliEnvelope,
  runMcpStdioSmoke,
  runPackagedCliProductionSmoke,
  validateToolsList,
  validatePackagedProductionResult,
  verifyPinnedMcpBundle,
};
module.exports.default = verifyCliResource;
