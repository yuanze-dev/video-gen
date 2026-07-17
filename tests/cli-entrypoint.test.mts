import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

test("source entrypoint forwards SIGTERM and preserves the JSON protocol", async () => {
  const child = spawn(
    process.execPath,
    ["scripts/cli.mjs", "validate", "-", "--json"],
    {
      cwd: root,
      stdio: ["pipe", "pipe", "pipe"],
    },
  );

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8").on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.setEncoding("utf8").on("data", (chunk) => {
    stderr += chunk;
  });

  await new Promise<void>((resolve) => {
    // esbuild must finish and the child CLI must attach its own signal handlers.
    const timeout = setTimeout(resolve, 1_000);
    child.stderr.once("data", () => {
      clearTimeout(timeout);
      resolve();
    });
  });
  child.kill("SIGTERM");

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("source CLI did not stop after SIGTERM"));
    }, 5_000);
    child.once("exit", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });

  assert.deepEqual(result, { code: 143, signal: null });
  assert.equal(stderr.includes("SIGTERM"), true);
  const envelope = JSON.parse(stdout) as {
    ok: boolean;
    error?: { code?: string; exitCode?: number };
  };
  assert.equal(envelope.ok, false);
  assert.equal(envelope.error?.code, "TERMINATED");
  assert.equal(envelope.error?.exitCode, 143);
});
