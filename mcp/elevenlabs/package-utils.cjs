/* eslint-disable @typescript-eslint/no-require-imports */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const MANIFEST_NAME = "manifest.json";
const EXECUTABLE_NAME = "elevenlabs-mcp";
const EXPECTED_SERVER = Object.freeze({
  distribution: "elevenlabs-mcp",
  version: "0.11.0",
  sourceCommit: "afc22357432db9e8b33991a83d41906001f6d759",
  wheelSha256: "814af638d3df2ec9d76ba2aeb1247ffa47f5ed8f8d11f60953b402667e4b172a",
});

const MACH_O_MAGICS = new Set([
  "cafebabe",
  "cafebabf",
  "cefaedfe",
  "cffaedfe",
  "feedface",
  "feedfacf",
  "bebafeca",
  "bfbafeca",
]);

function sha256Buffer(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function sha256File(filePath) {
  return sha256Buffer(fs.readFileSync(filePath));
}

function isMachO(filePath) {
  const handle = fs.openSync(filePath, "r");
  try {
    const magic = Buffer.alloc(4);
    if (fs.readSync(handle, magic, 0, magic.length, 0) !== magic.length) return false;
    return MACH_O_MAGICS.has(magic.toString("hex"));
  } finally {
    fs.closeSync(handle);
  }
}

function listBundleFiles(rootDirectory) {
  const files = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      const stat = fs.lstatSync(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`MCP bundle must not contain symlinks: ${absolute}`);
      }
      if (stat.isDirectory()) {
        visit(absolute);
      } else if (stat.isFile()) {
        files.push(path.relative(rootDirectory, absolute).split(path.sep).join("/"));
      } else {
        throw new Error(`Unsupported MCP bundle entry: ${absolute}`);
      }
    }
  };
  visit(rootDirectory);
  return files.sort();
}

function createBundleInventory(rootDirectory) {
  const files = listBundleFiles(rootDirectory).filter((relative) => relative !== MANIFEST_NAME);
  const machOFiles = [];
  const payloadFiles = [];
  for (const relative of files) {
    const absolute = path.join(rootDirectory, ...relative.split("/"));
    if (isMachO(absolute)) machOFiles.push(relative);
    else payloadFiles.push(relative);
  }

  const digest = crypto.createHash("sha256");
  for (const relative of payloadFiles) {
    digest.update(relative, "utf8");
    digest.update("\0", "utf8");
    digest.update(sha256File(path.join(rootDirectory, ...relative.split("/"))), "utf8");
    digest.update("\n", "utf8");
  }

  return {
    fileCount: files.length,
    machOFiles,
    payloadFileCount: payloadFiles.length,
    payloadSha256: digest.digest("hex"),
  };
}

function assertArm64MachO(rootDirectory, relativeFiles) {
  for (const relative of relativeFiles) {
    const absolute = path.join(rootDirectory, ...relative.split("/"));
    const architectures = execFileSync("/usr/bin/lipo", ["-archs", absolute], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
    }).trim();
    if (architectures !== "arm64") {
      throw new Error(`MCP native file is not thin arm64 (${architectures}): ${relative}`);
    }
  }
}

function assertGplPayloadPresent(lock, rootDirectory) {
  const normalizedFiles = listBundleFiles(rootDirectory).map((relative) => ({
    normalized: relative.toLowerCase().replaceAll("_", "-"),
  }));
  for (const distribution of Object.keys(lock.licenseGate.gplDistributions)) {
    const version = lock.runtimeDistributions[distribution];
    const metadataPrefix = `${distribution}-${version}.dist-info/`;
    const hasMetadata = normalizedFiles.some(({ normalized }) =>
      normalized.includes(metadataPrefix),
    );
    const hasLicense = normalizedFiles.some(
      ({ normalized }) =>
        normalized.includes(metadataPrefix) && /\/(license|copying)(\.[^/]*)?$/.test(normalized),
    );
    if (!hasMetadata || !hasLicense) {
      throw new Error(`GPL metadata/license missing from frozen sidecar: ${distribution}`);
    }
  }
  if (!normalizedFiles.some(({ normalized }) => normalized.includes("/fuzzywuzzy/"))) {
    throw new Error("fuzzywuzzy runtime code is missing from frozen sidecar");
  }
  if (
    !normalizedFiles.some(
      ({ normalized }) => normalized.includes("/levenshtein/") && normalized.endsWith(".so"),
    )
  ) {
    throw new Error("Levenshtein native extension is missing from frozen sidecar");
  }
}

function validatePinnedLock(lock) {
  if (!lock || lock.schemaVersion !== 1) throw new Error("Unsupported ElevenLabs MCP lock schema");
  if (lock.target?.platform !== "darwin" || lock.target?.arch !== "arm64") {
    throw new Error("ElevenLabs MCP lock must target darwin-arm64");
  }
  for (const [key, expected] of Object.entries(EXPECTED_SERVER)) {
    if (lock.server?.[key] !== expected) {
      throw new Error(`Unexpected ElevenLabs MCP ${key}: ${lock.server?.[key]}`);
    }
  }
  if (lock.target.pyinstallerVersion !== lock.buildDistributions?.pyinstaller) {
    throw new Error("PyInstaller target and build lock versions disagree");
  }
  for (const required of ["fuzzywuzzy", "python-levenshtein", "levenshtein"]) {
    if (!lock.runtimeDistributions?.[required] || !lock.licenseGate?.gplDistributions?.[required]) {
      throw new Error(`GPL dependency is missing from the release gate: ${required}`);
    }
  }
  if (!Array.isArray(lock.expectedTools) || !lock.expectedTools.includes("compose_music")) {
    throw new Error("compose_music is missing from the pinned MCP contract");
  }
  if (
    !Array.isArray(lock.expectedSoundEffectTools) ||
    !lock.expectedSoundEffectTools.includes("text_to_sound_effects")
  ) {
    throw new Error("text_to_sound_effects is missing from the pinned MCP contract");
  }
  if (lock.expectedToolCount !== 27) {
    throw new Error(`Unexpected ElevenLabs MCP tool count: ${lock.expectedToolCount}`);
  }
  return lock;
}

module.exports = {
  EXECUTABLE_NAME,
  EXPECTED_SERVER,
  MANIFEST_NAME,
  assertArm64MachO,
  assertGplPayloadPresent,
  createBundleInventory,
  isMachO,
  listBundleFiles,
  sha256Buffer,
  sha256File,
  validatePinnedLock,
};
