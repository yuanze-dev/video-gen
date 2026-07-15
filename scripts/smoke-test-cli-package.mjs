import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const shouldRender = process.argv.includes("--render");
const skipBuild = process.argv.includes("--skip-build");
const npmCli = process.env.npm_execpath;

function execute(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, ...options.env },
      stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve({ stdout, stderr });
      else {
        reject(
          new Error(
            `${command} ${args.join(" ")} 失败（${signal ?? code}）\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
      }
    });
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
  });
}

function executeNpm(args, options = {}) {
  if (npmCli) return execute(process.execPath, [npmCli, ...args], options);
  if (process.platform === "win32") {
    throw new Error("Windows 上请通过 npm run smoke:cli 调用此脚本");
  }
  return execute("npm", args, options);
}

function parseEnvelope(output, command) {
  const envelope = JSON.parse(output);
  if (envelope?.ok !== true || envelope?.protocolVersion !== "1") {
    throw new Error(`${command} 没有返回成功的 protocol v1 信封`);
  }
  return envelope.result;
}

const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "littlestart-package-smoke-"));
try {
  if (!skipBuild) await execute(process.execPath, [path.join(root, "scripts", "build-cli.mjs")]);

  const packDir = path.join(temporary, "pack");
  const projectDir = path.join(temporary, "empty-project");
  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, "package.json"),
    `${JSON.stringify({ private: true, name: "littlestart-empty-smoke" }, null, 2)}\n`,
  );

  const packed = await executeNpm([
    "pack",
    path.join(root, "packages", "littlestart-cli"),
    "--json",
    "--pack-destination",
    packDir,
  ]);
  const packResult = JSON.parse(packed.stdout);
  const tarball = path.join(packDir, packResult[0].filename);
  await executeNpm(["install", tarball, "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: projectDir,
  });

  const cli = path.join(
    projectDir,
    "node_modules",
    "@yuanze",
    "littlestart-cli",
    "dist",
    "littlestart.cjs",
  );
  const runCli = async (args, stdin) => {
    const completed = await execute(process.execPath, [cli, ...args], { cwd: projectDir, stdin });
    return parseEnvelope(completed.stdout, args.join(" "));
  };

  const version = await runCli(["version", "--json"]);
  if (!version.packaged) throw new Error("空目录安装后 CLI 未进入 packaged runtime 模式");
  const capabilities = await runCli(["capabilities", "--json"]);
  const builtin = await runCli(["assets", "inspect", "airport", "--json"]);
  if (!builtin.builtin || builtin.id !== "airport") {
    throw new Error("安装包无法读取内置素材 airport");
  }
  const configPath = path.join(projectDir, "video.json");
  await runCli(["init", configPath, "--minimal", "--json"]);
  await fs.writeFile(
    configPath,
    `${JSON.stringify(
      {
        opening: {
          title: { text: "CLI 空目录验收" },
          countdown: { enabled: false },
          curtain: { openDurationSec: 0.4 },
        },
        content: { teleprompter: { mode: "text", text: { content: "第一句。\n第二句。" } } },
      },
      null,
      2,
    )}\n`,
  );
  const validation = await runCli(["validate", configPath, "--json"]);
  const plan = await runCli(["plan", configPath, "--json"]);
  await runCli(["config", "schema", "--out", "schema.json", "--json"]);
  await runCli(["config", "lock", configPath, "--out", "video.lock.json", "--json"]);
  await runCli(["validate", "video.lock.json", "--json"]);
  const skill = await runCli([
    "skill",
    "install",
    "--target",
    "both",
    "--scope",
    "project",
    "--json",
  ]);

  let rendered = null;
  if (shouldRender) {
    const cacheDir = path.join(projectDir, ".cache");
    await runCli(["doctor", "--fix", "--cache-dir", cacheDir, "--json"]);
    await runCli([
      "still",
      configPath,
      "--scene",
      "content",
      "--out",
      "preview.png",
      "--resolution",
      "720p",
      "--cache-dir",
      cacheDir,
      "--offline",
      "--json",
    ]);
    rendered = await runCli([
      "render",
      configPath,
      "--out",
      "output.mp4",
      "--cover",
      "cover.jpg",
      "--quality",
      "small",
      "--resolution",
      "720p",
      "--fps",
      "30",
      "--cache-dir",
      cacheDir,
      "--offline",
      "--json",
    ]);
    await runCli(["probe", "output.mp4", "--json"]);
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        tarballBytes: packResult[0].size,
        unpackedBytes: packResult[0].unpackedSize,
        version: version.version,
        commands: capabilities.commands.length,
        durationSec: plan.plan.timeline.total.seconds,
        localFiles: validation.localFiles.length,
        skills: skill.installed.length,
        rendered,
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (process.env.KEEP_LITTLESTART_SMOKE !== "1") {
    await fs.rm(temporary, { recursive: true, force: true });
  } else {
    process.stderr.write(`保留 smoke 目录: ${temporary}\n`);
  }
}
