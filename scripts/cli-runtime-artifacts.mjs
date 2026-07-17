import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function collectFiles(directory, files) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await collectFiles(absolute, files);
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`runtime 包含不支持的文件类型: ${absolute}`);
  }
}

function pathTokens(value) {
  if (typeof value !== "string" || value.length < 3) return [];
  const forward = value.replaceAll("\\", "/").replace(/\/$/, "");
  const backward = forward.replaceAll("/", "\\");
  const tokens = new Set([value.replace(/[\\/]$/, ""), forward, backward]);
  try {
    tokens.add(pathToFileURL(value).href.replace(/\/$/, ""));
  } catch {
    // The native path forms above still cover unusual synthetic test paths.
  }
  tokens.add(encodeURI(forward));
  return [...tokens]
    .filter((token) => token.length >= 3)
    .sort((left, right) => right.length - left.length);
}

function machineSpecificPathTokens(value) {
  if (typeof value !== "string") return [];
  const forward = value.replaceAll("\\", "/").replace(/^[A-Za-z]:/, "");
  const segments = forward.split("/").filter(Boolean);
  // Container roots such as /src and /app are common runtime literals, not
  // identifying build-machine data. Sourcemap entries are still checked
  // independently below and may never contain any absolute path.
  return segments.length >= 2 ? pathTokens(value) : [];
}

function replacePathTokens(value, tokens) {
  let normalized = value;
  for (const token of tokens) {
    const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    normalized = normalized.replace(
      new RegExp(`(^|[|])${escaped}(?=$|[/\\\\|])`, "g"),
      (_match, prefix) => `${prefix}.`,
    );
  }
  return normalized;
}

function sourceMapPathIsAbsolute(source) {
  for (const segment of source.split("|")) {
    if (segment.startsWith("file://")) return true;
    if (path.posix.isAbsolute(segment) || path.win32.isAbsolute(segment)) return true;
  }
  return false;
}

async function normalizeRuntimeIndex(file) {
  let html = await fs.readFile(file, "utf8");
  let cwdFields = 0;
  let staticFileFields = 0;
  html = html.replace(/window\.remotion_cwd = [^;]+;/g, () => {
    cwdFields += 1;
    return 'window.remotion_cwd = "/littlestart";';
  });
  html = html.replace(/window\.remotion_staticFiles = (\[[^\n]*\]);?/g, (_match, json) => {
    staticFileFields += 1;
    const files = JSON.parse(json).map((entry) => ({ ...entry, lastModified: 0 }));
    return `window.remotion_staticFiles = ${JSON.stringify(files)};`;
  });
  if (cwdFields !== 1 || staticFileFields !== 1) {
    throw new Error(
      `无法规范化 Remotion runtime index（cwd=${cwdFields}, staticFiles=${staticFileFields}）`,
    );
  }
  await fs.writeFile(file, html, "utf8");
}

async function normalizeSourceMaps(runtimeSite, projectRoot) {
  const files = [];
  await collectFiles(runtimeSite, files);
  const sourceMaps = files.filter((file) => file.endsWith(".map"));
  if (sourceMaps.length === 0) throw new Error("Remotion runtime 缺少 sourcemap");
  const tokens = pathTokens(projectRoot);
  for (const file of sourceMaps) {
    const parsed = JSON.parse(await fs.readFile(file, "utf8"));
    if (!Array.isArray(parsed.sources)) {
      throw new Error(`Remotion sourcemap 缺少 sources: ${file}`);
    }
    parsed.sources = parsed.sources.map((source) =>
      typeof source === "string" ? replacePathTokens(source, tokens) : source,
    );
    if (typeof parsed.sourceRoot === "string") {
      parsed.sourceRoot = replacePathTokens(parsed.sourceRoot, tokens);
    }
    await fs.writeFile(file, JSON.stringify(parsed), "utf8");
  }
}

function assertNoToken(buffer, file, label, tokens) {
  for (const token of tokens) {
    if (buffer.includes(Buffer.from(token))) {
      throw new Error(`Remotion runtime ${file} 泄露了${label}: ${token}`);
    }
  }
}

export async function auditRuntimeArtifacts({
  runtimeSite,
  projectRoot,
  homeDirectory = os.homedir(),
}) {
  const files = [];
  await collectFiles(runtimeSite, files);
  const projectTokens = machineSpecificPathTokens(projectRoot);
  const homeTokens = machineSpecificPathTokens(homeDirectory);
  let sourceMapCount = 0;

  for (const file of files) {
    const relative = path.relative(runtimeSite, file).split(path.sep).join("/");
    const bytes = await fs.readFile(file);
    assertNoToken(bytes, relative, "构建仓库绝对路径", projectTokens);
    assertNoToken(bytes, relative, "构建用户主目录", homeTokens);

    if (!file.endsWith(".map")) continue;
    sourceMapCount += 1;
    const sourceMap = JSON.parse(bytes.toString("utf8"));
    if (sourceMap.version !== 3 || !Array.isArray(sourceMap.sources)) {
      throw new Error(`Remotion sourcemap 格式非法: ${relative}`);
    }
    if (
      typeof sourceMap.sourceRoot === "string" &&
      sourceMapPathIsAbsolute(sourceMap.sourceRoot)
    ) {
      throw new Error(
        `Remotion sourcemap ${relative} 包含绝对 sourceRoot: ${sourceMap.sourceRoot}`,
      );
    }
    const absolute = sourceMap.sources.find(
      (source) => typeof source === "string" && sourceMapPathIsAbsolute(source),
    );
    if (absolute) {
      throw new Error(`Remotion sourcemap ${relative} 包含绝对文件路径: ${absolute}`);
    }
  }

  if (sourceMapCount === 0) throw new Error("Remotion runtime 缺少 sourcemap");

  const index = await fs.readFile(path.join(runtimeSite, "index.html"), "utf8");
  if (!index.includes('window.remotion_cwd = "/littlestart";')) {
    throw new Error("Remotion runtime index 缺少固定的 cwd");
  }
  const staticFilesMatch = index.match(/window\.remotion_staticFiles = (\[[^\n]*\]);?/);
  if (!staticFilesMatch) throw new Error("Remotion runtime index 缺少静态素材元数据");
  const staticFiles = JSON.parse(staticFilesMatch[1]);
  if (
    !Array.isArray(staticFiles) ||
    staticFiles.some((entry) => entry?.lastModified !== 0)
  ) {
    throw new Error("Remotion runtime index 包含非确定性素材时间戳");
  }

  return { fileCount: files.length, sourceMapCount };
}

export async function normalizeAndAuditRuntimeArtifacts({
  runtimeSite,
  projectRoot,
  homeDirectory = os.homedir(),
}) {
  await normalizeRuntimeIndex(path.join(runtimeSite, "index.html"));
  await normalizeSourceMaps(runtimeSite, projectRoot);
  return auditRuntimeArtifacts({ runtimeSite, projectRoot, homeDirectory });
}
