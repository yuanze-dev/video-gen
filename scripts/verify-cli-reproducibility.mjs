import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import { auditRuntimeArtifacts } from "./cli-runtime-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeFile = path.join(
  root,
  "packages",
  "littlestart-cli",
  "runtime",
  "runtime.json",
);
const packagedCli = path.join(
  root,
  "packages",
  "littlestart-cli",
  "dist",
  "littlestart.cjs",
);
const packageDir = path.join(root, "packages", "littlestart-cli");
const runtimeSite = path.join(path.dirname(runtimeFile), "remotion-site");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, env = {}, cwd = root) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} ${args.join(" ")} 失败（${signal ?? code}）\n${stderr}`));
    });
  });
}

async function buildMetadata() {
  await run(process.execPath, [path.join(root, "scripts", "build-cli.mjs")]);
  return JSON.parse(await fs.readFile(runtimeFile, "utf8"));
}

async function packDigest(destination) {
  await fs.mkdir(destination, { recursive: true });
  await run(npm, [
    "pack",
    packageDir,
    "--pack-destination",
    destination,
    "--silent",
  ]);
  const archives = (await fs.readdir(destination)).filter((file) => file.endsWith(".tgz"));
  if (archives.length !== 1) {
    throw new Error(`npm pack 产物数量异常: ${archives.length}`);
  }
  return `sha256:${crypto
    .createHash("sha256")
    .update(await fs.readFile(path.join(destination, archives[0])))
    .digest("hex")}`;
}

const packageBuilds = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-package-repro-"));
let first;
let second;
let firstPackageDigest;
let secondPackageDigest;
try {
  first = await buildMetadata();
  firstPackageDigest = await packDigest(path.join(packageBuilds, "first"));
  second = await buildMetadata();
  secondPackageDigest = await packDigest(path.join(packageBuilds, "second"));
} finally {
  await fs.rm(packageBuilds, { recursive: true, force: true });
}
for (const key of ["templateDigest", "bundleDigest"]) {
  if (first[key] !== second[key]) {
    throw new Error(`连续两次 clean build 的 ${key} 不一致: ${first[key]} / ${second[key]}`);
  }
}
if (firstPackageDigest !== secondPackageDigest) {
  throw new Error(
    `连续两次 clean build 的 npm 包不一致: ${firstPackageDigest} / ${secondPackageDigest}`,
  );
}

await auditRuntimeArtifacts({ runtimeSite, projectRoot: root });

const packaged = JSON.parse(
  (await run(process.execPath, [packagedCli, "version", "--json"])).stdout,
);
const source = JSON.parse(
  (await run(process.execPath, [path.join(root, "scripts", "cli.mjs"), "version", "--json"])).stdout,
);
if (packaged.result.runtime.templateDigest !== source.result.runtime.templateDigest) {
  throw new Error("源码模式与安装包的 templateDigest 不一致");
}

const compatibilityDir = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-runtime-lock-"));
try {
  await fs.writeFile(path.join(compatibilityDir, "video.json"), "{}\n");
  const sourceCli = path.join(root, "cli", "dist", "main.cjs");
  await run(
    process.execPath,
    [sourceCli, "config", "lock", "video.json", "--out", "video.lock.json", "--json"],
    { LITTLESTART_PACKAGED: "0", LITTLESTART_SOURCE_ROOT: root },
    compatibilityDir,
  );
  await run(
    process.execPath,
    [packagedCli, "validate", "video.lock.json", "--json"],
    {},
    compatibilityDir,
  );
} finally {
  await fs.rm(compatibilityDir, { recursive: true, force: true });
}

process.stdout.write(
  `${JSON.stringify({
    ok: true,
    templateDigest: second.templateDigest,
    bundleDigest: second.bundleDigest,
    packageDigest: secondPackageDigest,
  })}\n`,
);
