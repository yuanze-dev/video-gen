import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import verifier from "../build/verify-cli-resource.cjs";

const root = path.resolve(import.meta.dirname, "..");
const { runMcpStdioSmoke } = verifier as {
  runMcpStdioSmoke: (
    executablePath: string,
    lock: Record<string, unknown>,
    options?: { timeoutMs?: number },
  ) => Promise<{ toolCount: number; musicTools: string[]; soundEffectTools: string[] }>;
};

async function source(relative: string): Promise<string> {
  return readFile(path.join(root, relative), "utf8");
}

test("ElevenLabs MCP lock pins upstream identity and the GPL runtime closure", async () => {
  const lock = JSON.parse(await source("mcp/elevenlabs/lock.json"));
  assert.equal(lock.target.platform, "darwin");
  assert.equal(lock.target.arch, "arm64");
  assert.equal(lock.target.pythonVersion, "3.12.11");
  assert.equal(lock.target.pyinstallerVersion, "6.21.0");
  assert.equal(lock.server.version, "0.11.0");
  assert.equal(lock.server.sourceCommit, "afc22357432db9e8b33991a83d41906001f6d759");
  assert.equal(
    lock.server.wheelSha256,
    "814af638d3df2ec9d76ba2aeb1247ffa47f5ed8f8d11f60953b402667e4b172a",
  );
  assert.equal(lock.expectedToolCount, 27);
  assert.ok(lock.expectedTools.includes("compose_music"));
  assert.deepEqual(lock.expectedSoundEffectTools, ["text_to_sound_effects"]);
  assert.equal(lock.licenseGate.environmentVariable, "ELEVENLABS_MCP_DISTRIBUTION_APPROVED");
  assert.equal(lock.licenseGate.gplDistributions.fuzzywuzzy, "GPLv2");
  assert.equal(
    lock.licenseGate.gplDistributions["python-levenshtein"],
    "GPL-2.0-or-later",
  );
  assert.equal(lock.licenseGate.gplDistributions.levenshtein, "GPL-2.0-or-later");
});

test("strict stdio wrapper bypasses the upstream stdout banner without replacing tools", async () => {
  const wrapper = await source("mcp/elevenlabs/stdio_server.py");
  assert.match(wrapper, /from elevenlabs_mcp\.server import mcp/);
  assert.match(wrapper, /mcp\.run\(\)/);
  assert.doesNotMatch(wrapper, /\bprint\s*\(/);
});

test("sidecar build is an arm64 PyInstaller onedir and Electron keeps it outside asar", async () => {
  const build = await source("scripts/build-elevenlabs-mcp.mjs");
  assert.match(build, /"--onedir"/);
  assert.doesNotMatch(build, /"--onefile"/);
  assert.match(build, /"--target-arch",\s*\n\s*"arm64"/);
  assert.match(build, /process\.platform !== "darwin" \|\| process\.arch !== "arm64"/);
  assert.match(build, /downloadPinnedWheel/);
  assert.match(build, /wheelSha256/);

  const builder = await source("electron-builder.yml");
  assert.match(builder, /from: mcp\/elevenlabs\/dist/);
  assert.match(builder, /to: mcp\/elevenlabs/);
  assert.match(builder, /darwin-arm64\/\*\*\/\*/);

  const afterPack = await source("build/verify-cli-resource.cjs");
  assert.match(afterPack, /elevenlabs-mcp-launcher\.cjs/);
  assert.match(afterPack, /--littlestart-self-check/);
  assert.match(afterPack, /integrity !== "pinned-bundle"/);

  const packageJson = JSON.parse(await source("package.json"));
  assert.equal(
    packageJson.scripts["build:mcp:elevenlabs"],
    "node scripts/build-elevenlabs-mcp.mjs",
  );
  assert.match(packageJson.scripts["electron:build"], /build:mcp:elevenlabs/);
  assert.match(packageJson.scripts["electron:build"], /LITTLESTART_REQUIRE_ELEVENLABS_MCP=true/);
});

function fakeServerSource(withBanner: boolean): string {
  return `#!${process.execPath}
const readline = require("node:readline");
${withBanner ? 'process.stdout.write("Starting MCP server\\n");' : ""}
const musicNames = ["compose_music", "create_composition_plan", "upload_music_for_inpainting", "video_to_music"];
const composeProperties = Object.fromEntries([
  "composition_plan", "force_instrumental", "model_id", "music_length_ms",
  "output_directory", "prompt", "seed", "store_for_inpainting",
].map((name) => [name, {}]));
const soundEffectProperties = Object.fromEntries([
  "duration_seconds", "loop", "output_directory", "output_format", "text",
].map((name) => [name, {}]));
const tools = [
  ...musicNames.map((name) => ({
    name,
    inputSchema: { type: "object", properties: name === "compose_music" ? composeProperties : {} },
  })),
  { name: "text_to_sound_effects", inputSchema: { type: "object", properties: soundEffectProperties } },
  ...Array.from({ length: 22 }, (_, index) => ({
    name: \`fixture_\${index}\`,
    inputSchema: { type: "object", properties: {} },
  })),
];
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "tools/call") process.exit(91);
  if (message.method === "initialize") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: message.id,
      result: {
        protocolVersion: "2025-06-18", capabilities: { tools: {} },
        serverInfo: { name: "fixture", version: "0.0.0" },
      },
    }) + "\\n");
  }
  if (message.method === "tools/list") {
    process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools } }) + "\\n");
  }
});
`;
}

async function withFakeServer(
  banner: boolean,
  callback: (executable: string) => Promise<void>,
): Promise<void> {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "littlestart-mcp-fixture-"));
  const executable = path.join(temporary, "fixture-mcp");
  try {
    await writeFile(executable, fakeServerSource(banner), { mode: 0o755 });
    await chmod(executable, 0o755);
    await callback(executable);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

test("packaged smoke sends initialize/list only and accepts pinned music plus sound-effect contracts", async () => {
  const lock = JSON.parse(await source("mcp/elevenlabs/lock.json"));
  await withFakeServer(false, async (executable) => {
    const result = await runMcpStdioSmoke(executable, lock, { timeoutMs: 5_000 });
    assert.equal(result.toolCount, 27);
    assert.deepEqual(result.musicTools, lock.expectedTools);
    assert.deepEqual(result.soundEffectTools, lock.expectedSoundEffectTools);
  });
});

test("packaged smoke resolves a relative executable before changing its working directory", async () => {
  const lock = JSON.parse(await source("mcp/elevenlabs/lock.json"));
  await withFakeServer(false, async (executable) => {
    const relativeExecutable = path.relative(process.cwd(), executable);
    assert.equal(path.isAbsolute(relativeExecutable), false);
    const result = await runMcpStdioSmoke(relativeExecutable, lock, { timeoutMs: 5_000 });
    assert.equal(result.toolCount, 27);
  });
});

test("packaged smoke rejects the upstream-style non-JSON stdout banner", async () => {
  const lock = JSON.parse(await source("mcp/elevenlabs/lock.json"));
  await withFakeServer(true, async (executable) => {
    await assert.rejects(
      runMcpStdioSmoke(executable, lock, { timeoutMs: 5_000 }),
      /non-JSON stdout: Starting MCP server/,
    );
  });
});
