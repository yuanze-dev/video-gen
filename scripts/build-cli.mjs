// Builds a self-contained npm package for the public CLI surface. The command
// implementation is precompiled and the Remotion composition is prebundled, so
// installed users never need the source checkout, Next.js, esbuild or the
// Remotion bundler at runtime.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { bundle } from "@remotion/bundler";
import { normalizeAndAuditRuntimeArtifacts } from "./cli-runtime-artifacts.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = path.join(root, "packages", "littlestart-cli");
const distDir = path.join(packageDir, "dist");
const runtimeDir = path.join(packageDir, "runtime");
const runtimeSite = path.join(runtimeDir, "remotion-site");
const packageSkillsDir = path.join(packageDir, "skills");
const buildRoot = path.join(root, ".remotion-build", "cli");
const publicDir = path.join(buildRoot, "public");
const templateSourceDirectories = ["remotion", "public/assets"];
const templateSourceFiles = [
  "lib/asset-registry.ts",
  "lib/config-schema.ts",
  "lib/constants.ts",
  "lib/duration.ts",
  "lib/export-options.ts",
  "lib/resolved.ts",
];
const templateDependencies = [
  "@fontsource-variable/noto-sans-sc",
  "@remotion/bundler",
  "@remotion/media-parser",
  "@remotion/renderer",
  "@remotion/three",
  "react",
  "react-dom",
  "remotion",
  "three",
  "zod",
];

async function collectFiles(directory, files) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(absolute, files);
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`runtime 输入包含不支持的文件类型: ${absolute}`);
  }
}

const portableRelative = (base, file) => path.relative(base, file).split(path.sep).join("/");

async function exactDependencyVersions() {
  const versions = {};
  for (const dependency of templateDependencies) {
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, "node_modules", dependency, "package.json"), "utf8"),
    );
    if (typeof manifest.version !== "string" || manifest.version.trim() === "") {
      throw new Error(`无法确定模板依赖版本: ${dependency}`);
    }
    versions[dependency] = manifest.version;
  }
  return versions;
}

async function sourceTemplateDigest() {
  const files = templateSourceFiles.map((relative) => path.join(root, relative));
  for (const relative of templateSourceDirectories) {
    await collectFiles(path.join(root, relative), files);
  }
  files.sort((left, right) => portableRelative(root, left).localeCompare(portableRelative(root, right)));
  const hash = crypto.createHash("sha256");
  for (const file of files) {
    hash.update(portableRelative(root, file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  hash.update("dependencies.json\0");
  hash.update(JSON.stringify(await exactDependencyVersions()));
  hash.update("\0");
  return `sha256:${hash.digest("hex")}`;
}

await fs.rm(distDir, { recursive: true, force: true });
await fs.rm(runtimeDir, { recursive: true, force: true });
await fs.rm(packageSkillsDir, { recursive: true, force: true });
await fs.rm(buildRoot, { recursive: true, force: true });
await fs.mkdir(distDir, { recursive: true });
await fs.mkdir(path.join(publicDir, "assets"), { recursive: true });

// Only template assets belong in the renderer bundle. In particular, never
// feed public/remotion-site back into the bundler and recursively double it.
await fs.cp(path.join(root, "public", "assets"), path.join(publicDir, "assets"), {
  recursive: true,
});

await build({
  entryPoints: [path.join(root, "cli", "main.ts")],
  outfile: path.join(distDir, "littlestart.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: {
    "process.env.LITTLESTART_PACKAGED": JSON.stringify("1"),
  },
  external: [
    "@remotion/bundler",
    "@remotion/media-parser",
    "@remotion/media-parser/node",
    "@remotion/renderer",
  ],
  logLevel: "info",
});
await fs.chmod(path.join(distDir, "littlestart.cjs"), 0o755);

await build({
  entryPoints: [path.join(root, "cli", "elevenlabs-mcp-launcher.ts")],
  outfile: path.join(packageDir, "elevenlabs-mcp-launcher.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  define: {
    "process.env.LITTLESTART_PACKAGED": JSON.stringify("1"),
  },
  logLevel: "info",
});
await fs.chmod(path.join(packageDir, "elevenlabs-mcp-launcher.cjs"), 0o755);

await fs.cp(
  path.join(root, "skills", "generate-video"),
  path.join(packageSkillsDir, "generate-video"),
  { recursive: true },
);
await fs.copyFile(path.join(root, "README-CLI.md"), path.join(packageDir, "README.md"));
await fs.copyFile(path.join(root, "THIRD_PARTY_NOTICES.md"), path.join(packageDir, "THIRD_PARTY_NOTICES.md"));
await fs.copyFile(path.join(root, "ASSET_RIGHTS.md"), path.join(packageDir, "ASSET_RIGHTS.md"));
await fs.rm(path.join(packageDir, "docs"), { recursive: true, force: true });
await fs.mkdir(path.join(packageDir, "docs", "cli"), { recursive: true });
await fs.copyFile(
  path.join(root, "docs", "cli", "automation.md"),
  path.join(packageDir, "docs", "cli", "automation.md"),
);

let lastProgress = -1;
const bundled = await bundle({
  entryPoint: path.join(root, "remotion", "index.ts"),
  publicDir,
  publicPath: "/",
  onProgress: (progress) => {
    if (progress >= lastProgress + 20) {
      lastProgress = progress;
      process.stderr.write(`CLI renderer bundle ${progress}%\n`);
    }
  },
});
await fs.mkdir(runtimeDir, { recursive: true });
await fs.cp(bundled, runtimeSite, { recursive: true });
await normalizeAndAuditRuntimeArtifacts({ runtimeSite, projectRoot: root });
await fs.mkdir(path.join(runtimeDir, "licenses"), { recursive: true });
await fs.copyFile(
  path.join(root, "node_modules", "@fontsource-variable", "noto-sans-sc", "LICENSE"),
  path.join(runtimeDir, "licenses", "Noto-Sans-SC-OFL-1.1.txt"),
);
for (const [source, destination] of [
  ["react/LICENSE", "React-MIT.txt"],
  ["three/LICENSE", "Three-MIT.txt"],
  ["zod/LICENSE", "Zod-MIT.txt"],
]) {
  await fs.copyFile(
    path.join(root, "node_modules", source),
    path.join(runtimeDir, "licenses", destination),
  );
}

const files = [];
await collectFiles(runtimeSite, files);
files.sort((left, right) => portableRelative(runtimeSite, left).localeCompare(portableRelative(runtimeSite, right)));
const digest = crypto.createHash("sha256");
for (const file of files) {
  digest.update(portableRelative(runtimeSite, file));
  digest.update("\0");
  digest.update(await fs.readFile(file));
  digest.update("\0");
}

const rootPackage = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
await fs.writeFile(
  path.join(runtimeDir, "runtime.json"),
  `${JSON.stringify(
    {
      protocolVersion: "1",
      template: "teleprompter@1.0.0",
      composition: "Teleprompter",
      remotionVersion: rootPackage.dependencies.remotion.replace(/^\^/, ""),
      templateDigest: await sourceTemplateDigest(),
      bundleDigest: `sha256:${digest.digest("hex")}`,
    },
    null,
    2,
  )}\n`,
);

process.stdout.write(`${packageDir}\n`);
