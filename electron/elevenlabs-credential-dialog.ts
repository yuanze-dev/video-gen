import { execFile } from "node:child_process";
import {
  ensureLittlestartEnvFile,
  resolveElevenLabsCredential,
  writeElevenLabsApiKey,
} from "../cli/local-secrets.ts";

const SKIP_SENTINEL = "__LITTLESTART_ELEVENLABS_SKIP__";
const PROMPT_TIMEOUT_MS = 10 * 60 * 1000;

const ELEVENLABS_PROMPT_SCRIPT = `
set promptResult to display dialog "ElevenLabs 可以在一键视频工作流中自动生成背景音乐或环境音效。\n\nAPI Key 只会保存在本机 ~/.config/littlestart/secrets.env，不会发送给网页或写入日志。" default answer "" with title "配置 ElevenLabs" with hidden answer buttons {"跳过", "保存"} default button "保存"
if button returned of promptResult is "跳过" then
  return "${SKIP_SENTINEL}"
end if
return text returned of promptResult
`;

type AppleScriptRunner = (script: string) => Promise<string | null>;

function runAppleScript(script: string): Promise<string | null> {
  return new Promise((resolve, reject) => {
    execFile(
      "/usr/bin/osascript",
      ["-e", script],
      {
        encoding: "utf8",
        maxBuffer: 8 * 1024,
        timeout: PROMPT_TIMEOUT_MS,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout.replace(/[\r\n]+$/, ""));
          return;
        }
        // Closing the native dialog is equivalent to choosing Skip. Never
        // surface AppleScript stderr because it is irrelevant to the user and
        // keeping this boundary silent prevents accidental credential logging.
        if (/\(-128\)/.test(stderr)) {
          resolve(null);
          return;
        }
        reject(new Error("无法打开 ElevenLabs 本地密钥窗口"));
      },
    );
  });
}

export async function getElevenLabsCredentialStatus(homeDir: string): Promise<"configured" | "missing"> {
  const credential = await resolveElevenLabsCredential({ homeDir, env: {} });
  return credential.configured ? "configured" : "missing";
}

export async function ensureElevenLabsCredentialFile(homeDir: string): Promise<string> {
  return ensureLittlestartEnvFile({ homeDir, env: {} });
}

export async function promptAndStoreElevenLabsCredential(
  homeDir: string,
  options: { runAppleScript?: AppleScriptRunner } = {},
): Promise<"configured" | "skipped"> {
  await ensureElevenLabsCredentialFile(homeDir);
  const value = await (options.runAppleScript ?? runAppleScript)(ELEVENLABS_PROMPT_SCRIPT);
  if (value === null || value === SKIP_SENTINEL || value.trim() === "") return "skipped";
  await writeElevenLabsApiKey(value, { homeDir, env: {} });
  return "configured";
}
