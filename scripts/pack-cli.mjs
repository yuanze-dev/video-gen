import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, ".artifacts");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} 失败（${signal ?? code}）`));
    });
  });
}

await run(process.execPath, [path.join(root, "scripts", "build-cli.mjs")]);
await fs.mkdir(artifacts, { recursive: true });
await run(npm, [
  "pack",
  path.join(root, "packages", "littlestart-cli"),
  "--pack-destination",
  artifacts,
]);
