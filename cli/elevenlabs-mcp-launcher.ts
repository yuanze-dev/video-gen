import { spawn } from "node:child_process";
import {
  inspectElevenLabsMcpRuntime,
  resolveElevenLabsMcpRuntime,
} from "./elevenlabs-mcp.ts";
import { resolveElevenLabsCredential } from "./local-secrets.ts";

export const ELEVENLABS_MCP_SELF_CHECK_ARG = "--littlestart-self-check" as const;

function childEnvironment(apiKey: string): NodeJS.ProcessEnv {
  const env = {} as NodeJS.ProcessEnv;
  for (const name of [
    "HOME", "USERPROFILE", "PATH", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
    "http_proxy", "https_proxy", "no_proxy",
  ]) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.ELEVENLABS_API_KEY = apiKey;
  env.ELEVENLABS_MCP_OUTPUT_MODE = process.env.ELEVENLABS_MCP_OUTPUT_MODE || "files";
  env.ELEVENLABS_MCP_BASE_PATH = process.env.ELEVENLABS_MCP_BASE_PATH || process.cwd();
  env.PYTHONIOENCODING = "utf-8";
  env.PYTHONUNBUFFERED = "1";
  return env;
}

export async function runElevenLabsMcpLauncher(): Promise<number> {
  if (
    process.argv.length >= 3 &&
    process.argv.slice(2).length === 1 &&
    process.argv[2] === ELEVENLABS_MCP_SELF_CHECK_ARG
  ) {
    const runtime = await resolveElevenLabsMcpRuntime();
    const controller = new AbortController();
    let interruptedExitCode: 130 | 143 | null = null;
    const interrupt = (exitCode: 130 | 143, signal: NodeJS.Signals) => {
      interruptedExitCode = exitCode;
      controller.abort(new Error(`ElevenLabs MCP 自检收到 ${signal}`));
    };
    const onSigint = () => interrupt(130, "SIGINT");
    const onSigterm = () => interrupt(143, "SIGTERM");
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    let inspection: Awaited<ReturnType<typeof inspectElevenLabsMcpRuntime>>;
    try {
      inspection = await inspectElevenLabsMcpRuntime(runtime, { signal: controller.signal });
    } catch (error) {
      if (interruptedExitCode !== null) return interruptedExitCode;
      throw error;
    } finally {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    }
    process.stdout.write(`${JSON.stringify({
      ok: true,
      command: "elevenlabs-mcp.self-check",
      result: {
        version: runtime.version,
        source: runtime.source,
        integrity: runtime.integrity ?? "unverified",
        toolCount: inspection.toolCount,
        musicTools: inspection.musicTools,
        soundEffectTools: inspection.soundEffectTools,
      },
    })}\n`);
    return 0;
  }
  const credential = await resolveElevenLabsCredential();
  if (!credential.apiKey) {
    process.stderr.write(
      `ElevenLabs MCP 未启用：请在 ${credential.envFile} 填写 ELEVENLABS_API_KEY。\n`,
    );
    return 5;
  }
  const runtime = await resolveElevenLabsMcpRuntime();
  const child = spawn(runtime.command, [...runtime.args, ...process.argv.slice(2)], {
    stdio: "inherit",
    env: childEnvironment(credential.apiKey),
  });
  const forwardSigint = () => child.kill("SIGINT");
  const forwardSigterm = () => child.kill("SIGTERM");
  process.once("SIGINT", forwardSigint);
  process.once("SIGTERM", forwardSigterm);
  return new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      process.removeListener("SIGINT", forwardSigint);
      process.removeListener("SIGTERM", forwardSigterm);
      resolve(code ?? (signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1));
    });
  });
}

if (require.main === module) {
  void runElevenLabsMcpLauncher()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "ElevenLabs MCP 启动失败"}\n`,
      );
      process.exitCode = 5;
    });
}
