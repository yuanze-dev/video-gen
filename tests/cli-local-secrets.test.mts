import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after, before } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const compiledDirectory = await fs.mkdtemp(path.join(ROOT, ".cli-secrets-test-"));
const compiledFile = path.join(compiledDirectory, "secrets.mjs");
const temporaryDirectories: string[] = [];
type SecretsModule = typeof import("../cli/local-secrets.ts");
let secrets: SecretsModule;

before(async () => {
  await build({
    entryPoints: [path.join(ROOT, "cli", "local-secrets.ts")],
    outfile: compiledFile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    logLevel: "silent",
  });
  secrets = (await import(`${pathToFileURL(compiledFile).href}?t=${Date.now()}`)) as SecretsModule;
});

after(async () => {
  await Promise.all(
    temporaryDirectories.map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
  await fs.rm(compiledDirectory, { recursive: true, force: true });
});

async function tempHome(label: string) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `littlestart-secrets-${label}-`));
  temporaryDirectories.push(directory);
  return directory;
}

test("creates the documented optional secrets template with private permissions", async () => {
  const homeDir = await tempHome("template");
  const file = await secrets.ensureLittlestartEnvFile({ homeDir, env: {} });
  assert.equal(file, path.join(homeDir, ".config", "littlestart", "secrets.env"));
  assert.match(await fs.readFile(file, "utf8"), /^# Littlestart[\s\S]*ELEVENLABS_API_KEY=\n$/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.dirname(file))).mode & 0o777, 0o700);
});

test("process env takes precedence and the file parser never expands shell expressions", async () => {
  const homeDir = await tempHome("precedence");
  const file = await secrets.ensureLittlestartEnvFile({ homeDir, env: {} });
  await fs.writeFile(
    file,
    "ELEVENLABS_API_KEY='file-secret'\nOTHER=$(touch must-not-run)\nQUOTED=\"hello\\nworld\"\n",
    { mode: 0o600 },
  );
  const processCredential = await secrets.resolveElevenLabsCredential({
    homeDir,
    env: { ELEVENLABS_API_KEY: "process-secret" },
  });
  assert.equal(processCredential.source, "process");
  assert.equal(processCredential.apiKey, "process-secret");
  const fileCredential = await secrets.resolveElevenLabsCredential({ homeDir, env: {} });
  assert.equal(fileCredential.source, "file");
  assert.equal(fileCredential.apiKey, "file-secret");
  assert.equal(await fs.lstat(path.join(process.cwd(), "must-not-run")).catch(() => null), null);
});

test("updates only ElevenLabs key atomically without returning or logging its value", async () => {
  const homeDir = await tempHome("write");
  const file = await secrets.ensureLittlestartEnvFile({ homeDir, env: {} });
  await fs.appendFile(file, "ELEVENLABS_API_KEY=old-private-key\nKEEP_ME=yes\n");
  const returnedPath = await secrets.writeElevenLabsApiKey("new-private-key", { homeDir, env: {} });
  assert.equal(returnedPath, file);
  assert.equal(returnedPath.includes("new-private-key"), false);
  const contents = await fs.readFile(file, "utf8");
  assert.match(contents, /ELEVENLABS_API_KEY="new-private-key"/);
  assert.equal(contents.includes("old-private-key"), false);
  assert.match(contents, /# ELEVENLABS_API_KEY duplicate removed/);
  assert.match(contents, /KEEP_ME=yes/);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal((await secrets.resolveElevenLabsCredential({ homeDir, env: {} })).apiKey, "new-private-key");
});

test("rejects symlink secret targets and invalid multiline keys", async () => {
  const homeDir = await tempHome("symlink");
  const directory = path.join(homeDir, ".config", "littlestart");
  await fs.mkdir(directory, { recursive: true });
  const outside = path.join(homeDir, "outside.env");
  await fs.writeFile(outside, "untouched\n");
  await fs.symlink(outside, path.join(directory, "secrets.env"));
  await assert.rejects(secrets.ensureLittlestartEnvFile({ homeDir, env: {} }), /普通文件/);
  await assert.rejects(
    secrets.writeElevenLabsApiKey("invalid\nkey", { homeDir, env: { LITTLESTART_ENV_FILE: path.join(homeDir, "other.env") } }),
    /格式无效/,
  );
  assert.equal(await fs.readFile(outside, "utf8"), "untouched\n");
});
