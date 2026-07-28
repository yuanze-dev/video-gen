import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledDirectory = await fs.mkdtemp(path.join(ROOT, ".cli-mcp-test-"));
const compiledFile = path.join(compiledDirectory, "mcp.mjs");
const fakeServer = path.join(compiledDirectory, "fake-server.cjs");
const temporaryDirectories: string[] = [];
type McpModule = typeof import("../cli/elevenlabs-mcp.ts");
let mcp: McpModule;

before(async () => {
  await build({
    entryPoints: [path.join(ROOT, "cli", "elevenlabs-mcp.ts")],
    outfile: compiledFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  await fs.writeFile(
    fakeServer,
    `const fs = require("node:fs");\n` +
      `const path = require("node:path");\n` +
      `const mode = process.argv[2] || "ok";\n` +
      `let buffer = "";\n` +
      `process.stdout.write("Starting MCP server\\n");\n` +
      `process.stdin.setEncoding("utf8");\n` +
      `process.stdin.on("data", chunk => {\n` +
      `  buffer += chunk; const lines = buffer.split(/\\r?\\n/); buffer = lines.pop() || "";\n` +
      `  for (const line of lines) { if (!line.trim()) continue; const msg = JSON.parse(line);\n` +
      `    if (msg.method === "initialize") reply(msg.id, { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } });\n` +
      `    else if (msg.method === "tools/list") reply(msg.id, { tools: mode === "missing" ? [] : mode === "missing-sfx" ? [{ name: "compose_music", inputSchema: { type: "object" } }] : [{ name: "compose_music", inputSchema: { type: "object" } }, { name: "text_to_sound_effects", inputSchema: { type: "object" } }] });\n` +
      `    else if (msg.method === "tools/call") {\n` +
      `      fs.writeFileSync(path.join(process.cwd(), "observed.json"), JSON.stringify({ key: process.env.ELEVENLABS_API_KEY, unrelated: process.env.UNRELATED_SECRET || null, args: msg.params.arguments }));\n` +
      `      if (mode === "error") replyError(msg.id, -32000, "api_key=" + process.env.ELEVENLABS_API_KEY);\n` +
      `      else if (mode === "rate") replyError(msg.id, 429, "Too many requests: rate_limit; api_key=" + process.env.ELEVENLABS_API_KEY);\n` +
      `      else if (mode === "tool-rate") reply(msg.id, { isError: true, content: [{ type: "text", text: "rate limited (429)" }] });\n` +
      `      else reply(msg.id, { content: [{ type: "text", text: "done" }], structuredContent: { ok: true } });\n` +
      `    }\n` +
      `  }\n` +
      `});\n` +
      `process.stdin.on("end", () => process.exit(0));\n` +
      `function reply(id, result) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n"); }\n` +
      `function replyError(id, code, message) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }) + "\\n"); }\n`,
    { mode: 0o700 },
  );
  mcp = (await import(`${pathToFileURL(compiledFile).href}?t=${Date.now()}`)) as McpModule;
});

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  await fs.rm(compiledDirectory, { recursive: true, force: true });
});

async function tempDir(label: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `littlestart-mcp-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

function runtime(mode = "ok") {
  return {
    command: process.execPath,
    args: [fakeServer, mode],
    source: "explicit",
    version: "0.11.0",
  } as const;
}

test("MCP client initializes, verifies audio tools, calls one, and isolates child env", async () => {
  const directory = await tempDir("success");
  process.env.UNRELATED_SECRET = "must-not-cross";
  try {
    const result = await mcp.callElevenLabsMcpTool({
      runtime: runtime(),
      apiKey: "private-eleven-key",
      tool: "compose_music",
      arguments: { prompt: "quiet instrumental", output_directory: directory },
      outputDirectory: directory,
    });
    assert.equal(result.content[0]?.text, "done");
    assert.deepEqual(result.structuredContent, { ok: true });
    const observed = JSON.parse(await fs.readFile(path.join(directory, "observed.json"), "utf8"));
    assert.equal(observed.key, "private-eleven-key");
    assert.equal(observed.unrelated, null);
    assert.equal(observed.args.prompt, "quiet instrumental");
  } finally {
    delete process.env.UNRELATED_SECRET;
  }
});

test("MCP client can call the official sound-effect tool", async () => {
  const directory = await tempDir("sound-effect");
  const result = await mcp.callElevenLabsMcpTool({
    runtime: runtime(),
    apiKey: "private-eleven-key",
    tool: "text_to_sound_effects",
    arguments: {
      text: "steady aircraft cabin ambience",
      duration_seconds: 5,
      output_format: "mp3_44100_128",
      loop: true,
    },
    outputDirectory: directory,
  });
  assert.equal(result.content[0]?.text, "done");
});

test("runtime inspection exercises initialize and tools/list without a paid tools/call", async () => {
  // The fake "error" server rejects tools/call. A successful inspection proves
  // the self-check stopped after tools/list.
  const inspected = await mcp.inspectElevenLabsMcpRuntime(runtime("error"));
  assert.equal(inspected.toolCount, 2);
  assert.deepEqual(inspected.musicTools, ["compose_music"]);
  assert.deepEqual(inspected.soundEffectTools, ["text_to_sound_effects"]);
  await assert.rejects(
    mcp.inspectElevenLabsMcpRuntime(runtime("missing-sfx")),
    (error: unknown) => (error as { code?: string }).code === "MCP_TOOL_MISSING",
  );
});

test("missing official tool and remote failures are stable and redact the API key", async () => {
  const missingDirectory = await tempDir("missing");
  await assert.rejects(
    mcp.callElevenLabsMcpTool({
      runtime: runtime("missing"),
      apiKey: "private-key",
      tool: "compose_music",
      arguments: {},
      outputDirectory: missingDirectory,
    }),
    (error: unknown) => (error as { code?: string }).code === "MCP_TOOL_MISSING",
  );

  const errorDirectory = await tempDir("error");
  await assert.rejects(
    mcp.callElevenLabsMcpTool({
      runtime: runtime("error"),
      apiKey: "must-never-leak",
      tool: "compose_music",
      arguments: {},
      outputDirectory: errorDirectory,
    }),
    (error: unknown) => {
      const typed = error as { code?: string; details?: unknown };
      assert.equal(typed.code, "REMOTE_REQUEST_FAILED");
      assert.equal(JSON.stringify(typed.details).includes("must-never-leak"), false);
      return true;
    },
  );
});

test("JSON-RPC and tool-level 429 responses expose the documented rate-limit code", async () => {
  for (const mode of ["rate", "tool-rate"]) {
    const directory = await tempDir(mode);
    await assert.rejects(
      mcp.callElevenLabsMcpTool({
        runtime: runtime(mode),
        apiKey: "rate-limit-secret",
        tool: "compose_music",
        arguments: {},
        outputDirectory: directory,
      }),
      (error: unknown) => {
        const typed = error as { code?: string; details?: unknown };
        assert.equal(typed.code, "REMOTE_RATE_LIMITED");
        assert.equal(JSON.stringify(typed.details).includes("rate-limit-secret"), false);
        return true;
      },
    );
  }
});

test("pre-aborted requests never spawn and explicit runtime paths fail closed", async () => {
  const directory = await tempDir("abort");
  const controller = new AbortController();
  controller.abort(new Error("stop"));
  await assert.rejects(
    mcp.callElevenLabsMcpTool({
      runtime: { command: path.join(directory, "does-not-exist"), args: [], source: "explicit", version: "0.11.0" },
      apiKey: "private-key",
      tool: "compose_music",
      arguments: {},
      outputDirectory: directory,
      signal: controller.signal,
    }),
    (error: unknown) => (error as { code?: string }).code === "INTERRUPTED",
  );
  await assert.rejects(
    mcp.resolveElevenLabsMcpRuntime({ LITTLESTART_ELEVENLABS_MCP_EXECUTABLE: path.join(directory, "missing") }),
    (error: unknown) => (error as { code?: string }).code === "MCP_RUNTIME_MISSING",
  );
});

test("darwin arm64 resolves the built and packaged sidecar at the canonical direct path", async (t) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    t.skip("the bundled Electron target is darwin-arm64 only");
    return;
  }
  const sourceRoot = await tempDir("source-runtime");
  const sourceExecutable = path.join(
    sourceRoot,
    "mcp",
    "elevenlabs",
    "dist",
    "darwin-arm64",
    "elevenlabs-mcp",
  );
  await fs.mkdir(path.dirname(sourceExecutable), { recursive: true });
  await fs.writeFile(sourceExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const sourceRuntime = await mcp.resolveElevenLabsMcpRuntime({
    LITTLESTART_SOURCE_ROOT: sourceRoot,
  });
  assert.equal(sourceRuntime.command, sourceExecutable);
  assert.equal(sourceRuntime.source, "bundled");
  assert.equal(sourceRuntime.integrity, "unverified");

  const resourcesRoot = await tempDir("resources-runtime");
  const packagedExecutable = path.join(
    resourcesRoot,
    "mcp",
    "elevenlabs",
    "darwin-arm64",
    "elevenlabs-mcp",
  );
  await fs.mkdir(path.dirname(packagedExecutable), { recursive: true });
  await fs.writeFile(packagedExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const packagedRuntime = await mcp.resolveElevenLabsMcpRuntime({
    LITTLESTART_RESOURCES_PATH: resourcesRoot,
  });
  assert.equal(packagedRuntime.command, packagedExecutable);
  assert.equal(packagedRuntime.source, "bundled");
  assert.equal(packagedRuntime.integrity, "unverified");
});

test("Electron bundled overrides require the canonical path and pinned manifest", async (t) => {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    t.skip("the bundled Electron target is darwin-arm64 only");
    return;
  }
  const resourcesRoot = await tempDir("verified-bundle");
  const executable = path.join(
    resourcesRoot,
    "mcp",
    "elevenlabs",
    "darwin-arm64",
    "elevenlabs-mcp",
  );
  await fs.mkdir(path.dirname(executable), { recursive: true });
  await fs.writeFile(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const env = {
    LITTLESTART_RESOURCES_PATH: resourcesRoot,
    LITTLESTART_ELEVENLABS_MCP_EXECUTABLE: executable,
    LITTLESTART_ELEVENLABS_MCP_BUNDLED: "1",
  };
  await assert.rejects(
    mcp.resolveElevenLabsMcpRuntime(env),
    (error: unknown) => (error as { code?: string }).code === "MCP_RUNTIME_FAILED",
  );
  await fs.writeFile(
    path.join(path.dirname(executable), "manifest.json"),
    `${JSON.stringify({
      schemaVersion: 1,
      executable: "elevenlabs-mcp",
      server: {
        distribution: "elevenlabs-mcp",
        version: "0.11.0",
        sourceCommit: "afc22357432db9e8b33991a83d41906001f6d759",
        wheelSha256: "814af638d3df2ec9d76ba2aeb1247ffa47f5ed8f8d11f60953b402667e4b172a",
      },
    })}\n`,
  );
  const verified = await mcp.resolveElevenLabsMcpRuntime(env);
  assert.equal(verified.command, executable);
  assert.equal(verified.integrity, "pinned-bundle");

  const otherExecutable = path.join(resourcesRoot, "other-mcp");
  await fs.writeFile(otherExecutable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await assert.rejects(
    mcp.resolveElevenLabsMcpRuntime({
      ...env,
      LITTLESTART_ELEVENLABS_MCP_EXECUTABLE: otherExecutable,
    }),
    (error: unknown) => (error as { code?: string }).code === "MCP_RUNTIME_FAILED",
  );
});
