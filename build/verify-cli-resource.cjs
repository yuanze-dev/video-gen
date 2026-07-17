const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

/**
 * electron-builder afterPack hook. Fail before signing or publishing when the
 * real app no longer contains an executable, integrity-valid CLI runtime.
 */
exports.default = async function verifyCliResource(context) {
  if (context.electronPlatformName !== "darwin") return;

  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appRoot = path.join(context.appOutDir, appName, "Contents");
  const resources = path.join(appRoot, "Resources");
  const cliRoot = path.join(resources, "cli");
  const cliEntry = path.join(cliRoot, "dist", "littlestart.cjs");
  const executable = path.join(appRoot, "MacOS", context.packager.appInfo.productFilename);
  const manifest = JSON.parse(fs.readFileSync(path.join(cliRoot, "package.json"), "utf8"));

  for (const required of [
    cliEntry,
    path.join(cliRoot, "runtime", "runtime.json"),
    path.join(
      resources,
      "render-bin",
      "chrome-headless-shell",
      "mac-arm64",
      "chrome-headless-shell-mac-arm64",
      "chrome-headless-shell",
    ),
    path.join(
      resources,
      "app.asar.unpacked",
      "node_modules",
      "@remotion",
      "compositor-darwin-arm64",
      "ffmpeg",
    ),
  ]) {
    if (!fs.statSync(required).isFile()) throw new Error(`packaged CLI resource missing: ${required}`);
  }

  const stdout = execFileSync(executable, [cliEntry, "version", "--json"], {
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
    timeout: 60_000,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
      NODE_PATH: path.join(resources, "app.asar", "node_modules"),
    },
  });
  const version = JSON.parse(stdout);
  if (
    version.ok !== true ||
    version.command !== "version" ||
    version.result?.packaged !== true ||
    version.result?.version !== manifest.version
  ) {
    throw new Error("packaged CLI version self-check failed");
  }
  process.stdout.write(`  • packaged CLI verified  version=${manifest.version}\n`);
};
