// Builds the local render CLI with esbuild (fast enough to run every time, so
// the compiled output can never go stale) and executes it with the given args.
//
//   node scripts/cli.mjs render 配置.json --out 视频.mp4
//
// Same pattern as build-electron.mjs: @remotion/renderer and @remotion/bundler
// stay external (native compositor binaries) and are dynamically imported from
// node_modules at runtime.
import { build } from "esbuild";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outfile = path.join(root, "cli", "dist", "main.cjs");

let child;
let childReady = false;
let forwardedSignal;

const signalExitCode = (signal) => (signal === "SIGTERM" ? 143 : 130);
const forwardQueuedSignal = () => {
  if (childReady && child && forwardedSignal) child.kill(forwardedSignal);
};

// Install handlers before the asynchronous build. Signals received during a
// cold compile are queued and forwarded only after the generated CLI confirms
// that its own graceful-shutdown handlers are active.
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    if (forwardedSignal) {
      child?.kill("SIGKILL");
      process.exit(signalExitCode(signal));
    }
    forwardedSignal = signal;
    forwardQueuedSignal();
  });
}

await build({
  entryPoints: [path.join(root, "cli", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: [
    "@remotion/renderer",
    "@remotion/bundler",
    "@remotion/media-parser",
    "@remotion/media-parser/node",
  ],
  logLevel: "silent",
});

child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit", "pipe"],
  cwd: process.cwd(),
  env: { ...process.env, LITTLESTART_READY_FD: "3" },
});

// Keep the development entrypoint behavior identical to the packaged binary:
// the actual CLI owns graceful cancellation, structured JSON/NDJSON output,
// and the documented 130/143 exit codes. Without forwarding, terminating this
// thin esbuild wrapper kills only the parent and can leave the CLI rendering in
// the background. FD 3 is private and never touches stdout/stderr protocols.
child.stdio[3]?.once("data", () => {
  childReady = true;
  forwardQueuedSignal();
});

child.on("exit", (code, signal) => {
  const exitCode = signal === "SIGTERM" ? 143 : signal === "SIGINT" ? 130 : 1;
  process.exit(code ?? exitCode);
});
