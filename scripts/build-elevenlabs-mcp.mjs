import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import packageUtils from "../mcp/elevenlabs/package-utils.cjs";

const {
  EXECUTABLE_NAME,
  MANIFEST_NAME,
  assertArm64MachO,
  assertGplPayloadPresent,
  createBundleInventory,
  sha256Buffer,
  sha256File,
  validatePinnedLock,
} = packageUtils;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpRoot = path.join(root, "mcp", "elevenlabs");
const lockPath = path.join(mcpRoot, "lock.json");
const entrypointPath = path.join(root, "mcp", "elevenlabs", "stdio_server.py");
const outputRoot = path.join(mcpRoot, "dist", "darwin-arm64");
const uvExecutable = process.env.UV_BIN || "uv";

function printHelp() {
  process.stdout.write(`Build the pinned ElevenLabs MCP macOS arm64 sidecar.\n\n`);
  process.stdout.write(`Usage:\n  node scripts/build-elevenlabs-mcp.mjs [--verify-only]\n\n`);
  process.stdout.write(`Output:\n  mcp/elevenlabs/dist/darwin-arm64/\n`);
}

function parseArguments(argv) {
  const options = { verifyOnly: false };
  for (const argument of argv) {
    if (argument === "--verify-only") options.verifyOnly = true;
    else if (argument === "--help" || argument === "-h") {
      printHelp();
      return null;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return options;
}

function buildEnvironment() {
  const environment = { ...process.env };
  for (const secretName of [
    "COMPOSIO_API_KEY",
    "ELEVENLABS_API_KEY",
    "REMOTION_LICENSE_KEY",
  ]) {
    delete environment[secretName];
  }
  environment.PYTHONUTF8 = "1";
  return environment;
}

function run(command, args, options = {}) {
  process.stdout.write(`  • ${path.basename(command)} ${args.join(" ")}\n`);
  return execFileSync(command, args, {
    cwd: root,
    env: buildEnvironment(),
    maxBuffer: 32 * 1024 * 1024,
    stdio: options.capture ? ["ignore", "pipe", "inherit"] : "inherit",
    encoding: options.capture ? "utf8" : undefined,
    timeout: options.timeout ?? 10 * 60_000,
  });
}

function assertBuildHost() {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error(
      `ElevenLabs MCP sidecar builds require a native darwin-arm64 host; received ${process.platform}-${process.arch}`,
    );
  }
}

function assertSafeDirectory(directory, expected) {
  if (path.resolve(directory) !== path.resolve(expected)) {
    throw new Error(`Refusing unexpected MCP output directory: ${directory}`);
  }
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error(`Refusing symlink MCP output directory: ${directory}`);
  }
}

async function downloadPinnedWheel(lock, destination) {
  const maximumWheelBytes = 2 * 1024 * 1024;
  const response = await fetch(lock.server.wheelUrl, {
    headers: { "user-agent": "littlestart-elevenlabs-mcp-builder/1" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(`Unable to download pinned ElevenLabs MCP wheel: HTTP ${response.status}`);
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maximumWheelBytes) {
    throw new Error(`Pinned ElevenLabs MCP wheel exceeds ${maximumWheelBytes} bytes`);
  }
  if (!response.body) throw new Error("Pinned ElevenLabs MCP wheel response has no body");
  const chunks = [];
  let receivedBytes = 0;
  for await (const chunk of response.body) {
    receivedBytes += chunk.byteLength;
    if (receivedBytes > maximumWheelBytes) {
      throw new Error(`Pinned ElevenLabs MCP wheel exceeds ${maximumWheelBytes} bytes`);
    }
    chunks.push(Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks, receivedBytes);
  const digest = sha256Buffer(bytes);
  if (digest !== lock.server.wheelSha256) {
    throw new Error(`ElevenLabs MCP wheel SHA-256 mismatch: ${digest}`);
  }
  fs.writeFileSync(destination, bytes, { mode: 0o600, flag: "wx" });
}

function normalizeDistributionName(value) {
  return value.trim().toLowerCase().replace(/[_.-]+/g, "-");
}

function expectedDistributions(lock) {
  return new Map(
    Object.entries({
      ...lock.runtimeDistributions,
      ...lock.buildDistributions,
      [lock.server.distribution]: lock.server.version,
    }).map(([name, version]) => [normalizeDistributionName(name), version]),
  );
}

function assertInstalledResolution(lock, pythonExecutable) {
  const program = String.raw`
import importlib.metadata as metadata
import json
print(json.dumps([
    {"name": distribution.metadata.get("Name", ""), "version": distribution.version}
    for distribution in metadata.distributions()
]))
`;
  const records = JSON.parse(
    execFileSync(pythonExecutable, ["-c", program], {
      cwd: root,
      env: buildEnvironment(),
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 60_000,
    }),
  );
  const actual = new Map(
    records.map(({ name, version }) => [normalizeDistributionName(name), version]),
  );

  const expected = expectedDistributions(lock);
  for (const [name, version] of expected) {
    if (actual.get(name) !== version) {
      throw new Error(`Locked distribution mismatch for ${name}: ${actual.get(name)} != ${version}`);
    }
  }
  for (const name of actual.keys()) {
    if (!expected.has(name)) throw new Error(`Unlocked distribution entered build environment: ${name}`);
  }
}

function createPythonInventory(lock, pythonExecutable) {
  const wanted = [...expectedDistributions(lock).keys()].filter(
    (name) => !Object.hasOwn(lock.buildDistributions, name),
  );
  const program = String.raw`
import importlib.metadata as metadata
import json
import re
import sys

def normalize(value):
    return re.sub(r"[-_.]+", "-", value).lower()

wanted = set(json.loads(sys.argv[1]))
records = []
for distribution in metadata.distributions():
    name = normalize(distribution.metadata.get("Name", ""))
    if name not in wanted:
        continue
    license_expression = distribution.metadata.get("License-Expression")
    license_value = distribution.metadata.get("License")
    classifiers = distribution.metadata.get_all("Classifier") or []
    records.append({
        "name": name,
        "version": distribution.version,
        "licenseExpression": license_expression,
        "declaredLicense": license_value,
        "licenseClassifiers": [value for value in classifiers if value.startswith("License ::")],
    })
print(json.dumps({"schemaVersion": 1, "distributions": sorted(records, key=lambda item: item["name"])}, indent=2))
`;
  const output = execFileSync(pythonExecutable, ["-c", program, JSON.stringify(wanted)], {
    cwd: root,
    env: buildEnvironment(),
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
    timeout: 60_000,
  });
  const inventory = JSON.parse(output);
  if (inventory.distributions.length !== wanted.length) {
    throw new Error(
      `Python inventory is incomplete: ${inventory.distributions.length} != ${wanted.length}`,
    );
  }
  return inventory;
}

function createManifest(lock, bundleRoot) {
  const inventory = createBundleInventory(bundleRoot);
  assertArm64MachO(bundleRoot, inventory.machOFiles);
  return {
    schemaVersion: 1,
    target: lock.target,
    server: lock.server,
    executable: EXECUTABLE_NAME,
    entrypointSha256: sha256File(entrypointPath),
    lockSha256: sha256File(lockPath),
    expectedToolCount: lock.expectedToolCount,
    expectedTools: lock.expectedTools,
    expectedSoundEffectTools: lock.expectedSoundEffectTools,
    licenseGate: lock.licenseGate,
    bundle: inventory,
  };
}

function verifyExistingBundle(lock, bundleRoot) {
  assertSafeDirectory(bundleRoot, outputRoot);
  const manifestPath = path.join(bundleRoot, MANIFEST_NAME);
  const executablePath = path.join(bundleRoot, EXECUTABLE_NAME);
  if (!fs.statSync(executablePath).isFile()) throw new Error(`Missing MCP executable: ${executablePath}`);
  if ((fs.statSync(executablePath).mode & 0o111) === 0) {
    throw new Error(`MCP executable bit is missing: ${executablePath}`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  const current = createBundleInventory(bundleRoot);
  if (JSON.stringify(manifest.bundle) !== JSON.stringify(current)) {
    throw new Error("ElevenLabs MCP bundle inventory does not match manifest");
  }
  if (manifest.lockSha256 !== sha256File(lockPath)) {
    throw new Error("ElevenLabs MCP build lock does not match manifest");
  }
  if (manifest.entrypointSha256 !== sha256File(entrypointPath)) {
    throw new Error("ElevenLabs MCP stdio entrypoint does not match manifest");
  }
  assertArm64MachO(bundleRoot, current.machOFiles);
  assertGplPayloadPresent(lock, bundleRoot);
  return manifest;
}

function atomicPublish(stagedRoot) {
  assertSafeDirectory(outputRoot, path.join(mcpRoot, "dist", "darwin-arm64"));
  fs.mkdirSync(path.dirname(outputRoot), { recursive: true });
  const backup = `${outputRoot}.previous-${process.pid}`;
  if (fs.existsSync(backup)) {
    throw new Error(`Refusing existing MCP build backup: ${backup}`);
  }
  const hadPrevious = fs.existsSync(outputRoot);
  if (hadPrevious) fs.renameSync(outputRoot, backup);
  try {
    fs.renameSync(stagedRoot, outputRoot);
  } catch (error) {
    if (hadPrevious && fs.existsSync(backup) && !fs.existsSync(outputRoot)) {
      fs.renameSync(backup, outputRoot);
    }
    throw error;
  }
  if (hadPrevious) fs.rmSync(backup, { recursive: true, force: false });
}

async function buildSidecar(lock) {
  assertBuildHost();
  const workRoot = fs.mkdtempSync(path.join(mcpRoot, ".build-"));
  const venvRoot = path.join(workRoot, "venv");
  const pythonExecutable = path.join(venvRoot, "bin", "python");
  const wheelPath = path.join(workRoot, "elevenlabs_mcp-0.11.0-py3-none-any.whl");
  const requirementsPath = path.join(workRoot, "requirements.lock.txt");
  const pyinstallerDist = path.join(workRoot, "pyinstaller-dist");
  const stagedRoot = path.join(workRoot, "darwin-arm64");

  try {
    process.stdout.write("Building pinned ElevenLabs MCP sidecar (darwin-arm64 only)\n");
    run(uvExecutable, ["venv", "--python", lock.target.pythonVersion, venvRoot]);
    await downloadPinnedWheel(lock, wheelPath);

    const requirements = Object.entries({
      ...lock.runtimeDistributions,
      ...lock.buildDistributions,
    })
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, version]) => `${name}==${version}`)
      .join("\n");
    fs.writeFileSync(requirementsPath, `${requirements}\n`, { mode: 0o600, flag: "wx" });

    run(uvExecutable, [
      "pip",
      "install",
      "--python",
      pythonExecutable,
      "--no-deps",
      "--only-binary",
      ":all:",
      "--requirements",
      requirementsPath,
    ]);
    run(uvExecutable, [
      "pip",
      "install",
      "--python",
      pythonExecutable,
      "--no-deps",
      wheelPath,
    ]);
    run(uvExecutable, ["pip", "check", "--python", pythonExecutable]);
    assertInstalledResolution(lock, pythonExecutable);

    run(pythonExecutable, [
      "-m",
      "PyInstaller",
      "--noconfirm",
      "--clean",
      "--onedir",
      "--console",
      "--noupx",
      "--name",
      EXECUTABLE_NAME,
      "--target-arch",
      "arm64",
      "--collect-all",
      "elevenlabs_mcp",
      "--collect-all",
      "elevenlabs",
      "--collect-all",
      "mcp",
      "--collect-all",
      "fuzzywuzzy",
      "--collect-all",
      "Levenshtein",
      "--collect-all",
      "rapidfuzz",
      "--collect-all",
      "sounddevice",
      "--collect-all",
      "soundfile",
      "--recursive-copy-metadata",
      "elevenlabs-mcp",
      "--recursive-copy-metadata",
      "elevenlabs",
      "--recursive-copy-metadata",
      "mcp",
      "--distpath",
      pyinstallerDist,
      "--workpath",
      path.join(workRoot, "pyinstaller-work"),
      "--specpath",
      path.join(workRoot, "pyinstaller-spec"),
      entrypointPath,
    ]);

    fs.renameSync(path.join(pyinstallerDist, EXECUTABLE_NAME), stagedRoot);
    fs.copyFileSync(lockPath, path.join(stagedRoot, "BUILD-LOCK.json"));
    fs.copyFileSync(path.join(mcpRoot, "README.md"), path.join(stagedRoot, "README.md"));
    fs.copyFileSync(
      path.join(root, "THIRD_PARTY_NOTICES.md"),
      path.join(stagedRoot, "THIRD_PARTY_NOTICES.md"),
    );
    const pythonInventory = createPythonInventory(lock, pythonExecutable);
    fs.writeFileSync(
      path.join(stagedRoot, "python-distributions.json"),
      `${JSON.stringify(pythonInventory, null, 2)}\n`,
      { mode: 0o644 },
    );

    assertGplPayloadPresent(lock, stagedRoot);
    const manifest = createManifest(lock, stagedRoot);
    fs.writeFileSync(
      path.join(stagedRoot, MANIFEST_NAME),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o644, flag: "wx" },
    );
    atomicPublish(stagedRoot);
    verifyExistingBundle(lock, outputRoot);
    process.stdout.write(
      `✓ ElevenLabs MCP sidecar built: ${outputRoot} (${manifest.bundle.fileCount} files, ${manifest.bundle.machOFiles.length} arm64 Mach-O)\n`,
    );
  } finally {
    fs.rmSync(workRoot, { recursive: true, force: true });
  }
}

export { buildSidecar, outputRoot, verifyExistingBundle };

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (!options) return;
  const lock = validatePinnedLock(JSON.parse(fs.readFileSync(lockPath, "utf8")));
  if (options.verifyOnly) {
    assertBuildHost();
    const manifest = verifyExistingBundle(lock, outputRoot);
    process.stdout.write(
      `✓ ElevenLabs MCP sidecar verified: ${outputRoot} (${manifest.bundle.fileCount} files)\n`,
    );
    return;
  }
  await buildSidecar(lock);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
