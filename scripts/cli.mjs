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

await build({
  entryPoints: [path.join(root, "cli", "main.ts")],
  outfile,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  external: ["@remotion/renderer", "@remotion/bundler"],
  logLevel: "silent",
});

const child = spawn(process.execPath, [outfile, ...process.argv.slice(2)], {
  stdio: "inherit",
  cwd: process.cwd(),
});
child.on("exit", (code, signal) => {
  process.exit(signal ? 1 : (code ?? 1));
});
