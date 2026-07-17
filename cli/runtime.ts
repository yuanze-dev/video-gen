import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

export const CLI_PACKAGE_NAME = "@yuanze/littlestart-cli" as const;
export const TEMPLATE_ID = "teleprompter" as const;
export const TEMPLATE_VERSION = "1.0.0" as const;
export const TEMPLATE_REF = `${TEMPLATE_ID}@${TEMPLATE_VERSION}` as const;
export const COMPOSITION_ID = "Teleprompter" as const;
const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

const TEMPLATE_SOURCE_DIRECTORIES = ["remotion", "public/assets"] as const;
const TEMPLATE_SOURCE_FILES = [
  "lib/asset-registry.ts",
  "lib/config-schema.ts",
  "lib/constants.ts",
  "lib/duration.ts",
  "lib/export-options.ts",
  "lib/resolved.ts",
] as const;
const TEMPLATE_DEPENDENCIES = [
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
] as const;

export type RuntimeMetadata = {
  protocolVersion: string;
  template: string;
  composition: string;
  remotionVersion: string;
  /** Canonical template/config semantics, stable between source and package. */
  templateDigest: string;
  /** Exact bytes of the prebuilt site (equals templateDigest in source mode). */
  bundleDigest: string;
};

export type CliRuntime = {
  packaged: boolean;
  cliVersion: string;
  packageRoot: string;
  sourceRoot?: string;
  runtimeSite?: string;
  runtimeMetadata: RuntimeMetadata;
  skillsRoot: string;
};

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseRuntimeMetadata(value: unknown, source: string): RuntimeMetadata {
  if (!isRecord(value)) throw new Error(`CLI runtime 元数据不是对象: ${source}`);
  const keys = [
    "protocolVersion",
    "template",
    "composition",
    "remotionVersion",
    "templateDigest",
    "bundleDigest",
  ] as const;
  for (const key of keys) {
    if (typeof value[key] !== "string" || value[key].trim() === "") {
      throw new Error(`CLI runtime 元数据缺少 ${key}: ${source}`);
    }
  }
  for (const key of ["templateDigest", "bundleDigest"] as const) {
    if (!SHA256_RE.test(value[key] as string)) {
      throw new Error(`CLI runtime 元数据 ${key} 不是合法 SHA-256: ${source}`);
    }
  }
  if (value.protocolVersion !== "1") {
    throw new Error(`CLI runtime 协议不兼容: ${String(value.protocolVersion)}`);
  }
  if (value.template !== TEMPLATE_REF || value.composition !== COMPOSITION_ID) {
    throw new Error(`CLI runtime 模板标识不匹配: ${source}`);
  }
  return {
    protocolVersion: value.protocolVersion as string,
    template: value.template as string,
    composition: value.composition as string,
    remotionVersion: value.remotionVersion as string,
    templateDigest: value.templateDigest as string,
    bundleDigest: value.bundleDigest as string,
  };
}

async function readPackageVersion(file: string): Promise<string> {
  const value = await readJson(file);
  if (!isRecord(value) || typeof value.version !== "string") {
    throw new Error(`CLI package 缺少合法 version: ${file}`);
  }
  return value.version;
}

async function collectRuntimeFiles(directory: string, files: string[]): Promise<void> {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectRuntimeFiles(file, files);
    else if (entry.isFile()) files.push(file);
    else throw new Error(`runtime 输入包含不支持的文件类型: ${file}`);
  }
}

function portableRelative(root: string, file: string): string {
  return path.relative(root, file).split(path.sep).join("/");
}

async function digestNamedFiles(root: string, files: readonly string[]): Promise<string> {
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    portableRelative(root, left).localeCompare(portableRelative(root, right)))) {
    hash.update(portableRelative(root, file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function exactDependencyVersions(sourceRoot: string): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const dependency of TEMPLATE_DEPENDENCIES) {
    const value = await readJson(path.join(sourceRoot, "node_modules", dependency, "package.json"));
    if (!isRecord(value) || typeof value.version !== "string" || value.version.trim() === "") {
      throw new Error(`无法确定模板依赖版本: ${dependency}`);
    }
    versions[dependency] = value.version;
  }
  return versions;
}

/** Canonical identity used by project locks in both source and packaged mode. */
export async function sourceTemplateDigest(sourceRoot: string): Promise<string> {
  const files: string[] = [];
  for (const relative of TEMPLATE_SOURCE_DIRECTORIES) {
    await collectRuntimeFiles(path.join(sourceRoot, relative), files);
  }
  files.push(...TEMPLATE_SOURCE_FILES.map((relative) => path.join(sourceRoot, relative)));
  const hash = crypto.createHash("sha256");
  for (const file of [...files].sort((left, right) =>
    portableRelative(sourceRoot, left).localeCompare(portableRelative(sourceRoot, right)))) {
    hash.update(portableRelative(sourceRoot, file));
    hash.update("\0");
    hash.update(await fs.readFile(file));
    hash.update("\0");
  }
  hash.update("dependencies.json\0");
  hash.update(JSON.stringify(await exactDependencyVersions(sourceRoot)));
  hash.update("\0");
  return `sha256:${hash.digest("hex")}`;
}

/** Exact integrity digest for every byte under the prebuilt Remotion site. */
export async function runtimeSiteDigest(runtimeSite: string): Promise<string> {
  const site = path.resolve(runtimeSite);
  const files: string[] = [];
  await collectRuntimeFiles(site, files);
  return digestNamedFiles(site, files);
}

export async function verifyPackagedRuntime(
  runtimeSite: string,
  runtimeFile = path.join(path.dirname(runtimeSite), "runtime.json"),
): Promise<RuntimeMetadata> {
  const metadata = parseRuntimeMetadata(await readJson(runtimeFile), runtimeFile);
  const actual = await runtimeSiteDigest(runtimeSite);
  if (actual !== metadata.bundleDigest) {
    throw new Error(
      `CLI runtime 内容摘要不匹配（期望 ${metadata.bundleDigest}，实际 ${actual}）`,
    );
  }
  return metadata;
}

async function sourceRuntimeMetadata(
  sourceRoot: string,
  remotionVersion: string,
): Promise<RuntimeMetadata> {
  const templateDigest = await sourceTemplateDigest(sourceRoot);
  return {
    protocolVersion: "1",
    template: TEMPLATE_REF,
    composition: COMPOSITION_ID,
    remotionVersion,
    templateDigest,
    bundleDigest: templateDigest,
  };
}

async function readSourceRemotionVersion(sourceRoot: string): Promise<string> {
  const value = await readJson(path.join(sourceRoot, "package.json"));
  if (!isRecord(value) || !isRecord(value.dependencies)) return "unknown";
  const version = value.dependencies.remotion;
  return typeof version === "string" ? version.replace(/^\^/, "") : "unknown";
}

/**
 * Locate immutable runtime files without depending on the caller's cwd.
 * `scripts/cli.mjs` produces cli/dist/main.cjs while the npm package puts the
 * same bundle under dist/, hence the two explicit layouts.
 */
export async function resolveCliRuntime(): Promise<CliRuntime> {
  const packaged = process.env.LITTLESTART_PACKAGED === "1";

  if (packaged) {
    const packageRoot = path.resolve(__dirname, "..");
    const runtimeSite = path.join(packageRoot, "runtime", "remotion-site");
    const runtimeFile = path.join(packageRoot, "runtime", "runtime.json");
    const packageFile = path.join(packageRoot, "package.json");
    const [cliVersion, runtimeMetadata] = await Promise.all([
      readPackageVersion(packageFile),
      verifyPackagedRuntime(runtimeSite, runtimeFile),
    ]);
    return {
      packaged: true,
      cliVersion,
      packageRoot,
      runtimeSite,
      runtimeMetadata,
      skillsRoot: path.join(packageRoot, "skills", "generate-video"),
    };
  }

  const sourceRoot = path.resolve(
    process.env.LITTLESTART_SOURCE_ROOT?.trim() || path.resolve(__dirname, "..", ".."),
  );
  const packageRoot = path.join(sourceRoot, "packages", "littlestart-cli");
  const cliVersion = await readPackageVersion(path.join(packageRoot, "package.json")).catch(
    async () => readPackageVersion(path.join(sourceRoot, "package.json")),
  );
  const runtimeMetadata = await sourceRuntimeMetadata(
    sourceRoot,
    await readSourceRemotionVersion(sourceRoot),
  );
  return {
    packaged: false,
    cliVersion,
    packageRoot,
    sourceRoot,
    runtimeMetadata,
    skillsRoot: path.join(sourceRoot, "skills", "generate-video"),
  };
}

export function renderRuntimeParams(runtime: CliRuntime):
  | { runtimeSite: string }
  | { root: string } {
  if (runtime.packaged && runtime.runtimeSite) return { runtimeSite: runtime.runtimeSite };
  if (runtime.sourceRoot) return { root: runtime.sourceRoot };
  throw new Error("找不到 Remotion 渲染 runtime");
}

export function builtinAssetFile(runtime: CliRuntime, publicPath: string): string {
  const publicRoot = runtime.runtimeSite
    ? path.join(runtime.runtimeSite, "public")
    : runtime.sourceRoot
      ? path.join(runtime.sourceRoot, "public")
      : undefined;
  if (!publicRoot) throw new Error("找不到内置素材目录");

  const root = path.resolve(publicRoot);
  const file = path.resolve(root, publicPath);
  if (file === root || !file.startsWith(`${root}${path.sep}`)) {
    throw new Error(`内置素材路径越界: ${publicPath}`);
  }
  return file;
}
