import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureElevenLabsCredentialFile,
  getElevenLabsCredentialStatus,
  promptAndStoreElevenLabsCredential,
} from "../electron/elevenlabs-credential-dialog.ts";

async function temporaryHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "littlestart-elevenlabs-home-"));
}

test("creates a private optional ElevenLabs env file when setup is skipped", async (t) => {
  const homeDir = await temporaryHome();
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));

  const result = await promptAndStoreElevenLabsCredential(homeDir, {
    runAppleScript: async () => null,
  });

  assert.equal(result, "skipped");
  assert.equal(await getElevenLabsCredentialStatus(homeDir), "missing");
  const file = await ensureElevenLabsCredentialFile(homeDir);
  assert.equal(file, path.join(homeDir, ".config", "littlestart", "secrets.env"));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(file, "utf8"), /^ELEVENLABS_API_KEY=$/m);
});

test("stores the submitted key locally without returning it", async (t) => {
  const homeDir = await temporaryHome();
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const apiKey = "sk_test_local_only_123456789";

  const result = await promptAndStoreElevenLabsCredential(homeDir, {
    runAppleScript: async () => apiKey,
  });

  assert.equal(result, "configured");
  assert.equal(await getElevenLabsCredentialStatus(homeDir), "configured");
  const file = path.join(homeDir, ".config", "littlestart", "secrets.env");
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.match(await fs.readFile(file, "utf8"), new RegExp(apiKey));
});

test("keeps credential bytes out of the remote desktop bridge", () => {
  const preload = readFileSync(new URL("../electron/preload.ts", import.meta.url), "utf8");
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  const bridge = readFileSync(new URL("../lib/desktop-bridge.ts", import.meta.url), "utf8");

  assert.match(
    preload,
    /configureElevenLabsCredential:\s*\(\):\s*Promise<DesktopElevenLabsConfigureResult>\s*=>\s*ipcRenderer\.invoke\(DESKTOP_CLI_CHANNELS\.configureElevenLabs\)/,
  );
  assert.match(
    main,
    /DESKTOP_CLI_CHANNELS\.configureElevenLabs[\s\S]+isTrustedCliRequest\(event, args\.length\)/,
  );
  assert.match(main, /安装或修复 Littlestart CLI/);
  assert.match(main, /配置 ElevenLabs API Key/);
  assert.match(main, /installNativeMenu\(cli\)/);
  assert.match(bridge, /credential:\s*"configured"\s*\|\s*"missing"/);
  assert.doesNotMatch(bridge, /apiKey|ELEVENLABS_API_KEY/);
});
