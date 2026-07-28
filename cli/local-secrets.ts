import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export const ELEVENLABS_API_KEY_NAME = "ELEVENLABS_API_KEY" as const;
export const LITTLESTART_ENV_FILE_NAME = "secrets.env" as const;
export const MAX_LOCAL_SECRETS_BYTES = 64 * 1024;

const ENV_ASSIGNMENT = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

export function resolveLittlestartEnvFile(options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): string {
  const override = options.env?.LITTLESTART_ENV_FILE?.trim();
  if (override) return path.resolve(override);
  return path.join(
    path.resolve(options.homeDir ?? os.homedir()),
    ".config",
    "littlestart",
    LITTLESTART_ENV_FILE_NAME,
  );
}

function decodeDoubleQuoted(value: string): string | null {
  try {
    const decoded = JSON.parse(value) as unknown;
    return typeof decoded === "string" ? decoded : null;
  } catch {
    return null;
  }
}

function decodeEnvValue(raw: string): string | null {
  const value = raw.trim();
  if (value === "") return "";
  if (value.startsWith('"')) {
    if (!value.endsWith('"')) return null;
    return decodeDoubleQuoted(value);
  }
  if (value.startsWith("'")) {
    if (!value.endsWith("'")) return null;
    return value.slice(1, -1);
  }
  const comment = value.search(/\s+#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

export function parseLocalSecrets(contents: string): Readonly<Record<string, string>> {
  const parsed: Record<string, string> = {};
  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const match = ENV_ASSIGNMENT.exec(line);
    if (!match) continue;
    const value = decodeEnvValue(match[2]);
    if (value !== null) parsed[match[1]] = value;
  }
  return parsed;
}

async function readRegularSecretsFile(file: string): Promise<string | null> {
  const stat = await fs.lstat(file).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`本地密钥配置必须是普通文件: ${file}`);
  }
  if (stat.size > MAX_LOCAL_SECRETS_BYTES) {
    throw new Error(`本地密钥配置超过 ${MAX_LOCAL_SECRETS_BYTES} bytes: ${file}`);
  }
  return fs.readFile(file, "utf8");
}

export type ElevenLabsCredential = {
  apiKey: string | null;
  configured: boolean;
  source: "process" | "file" | "missing";
  envFile: string;
};

export async function resolveElevenLabsCredential(options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<ElevenLabsCredential> {
  const env = options.env ?? process.env;
  const envFile = resolveLittlestartEnvFile({ homeDir: options.homeDir, env });
  const processValue = env[ELEVENLABS_API_KEY_NAME]?.trim();
  if (processValue) {
    return { apiKey: processValue, configured: true, source: "process", envFile };
  }
  const contents = await readRegularSecretsFile(envFile);
  const fileValue = contents
    ? parseLocalSecrets(contents)[ELEVENLABS_API_KEY_NAME]?.trim()
    : undefined;
  if (fileValue) {
    return { apiKey: fileValue, configured: true, source: "file", envFile };
  }
  return { apiKey: null, configured: false, source: "missing", envFile };
}

function encodedEnvValue(value: string): string {
  return JSON.stringify(value);
}

function replaceElevenLabsLine(contents: string, value: string): string {
  const lines = contents.split(/\r?\n/);
  const assignment = `${ELEVENLABS_API_KEY_NAME}=${encodedEnvValue(value)}`;
  let replaced = false;
  const next = lines.map((line) => {
    const match = ENV_ASSIGNMENT.exec(line);
    if (!match || match[1] !== ELEVENLABS_API_KEY_NAME) return line;
    // Never preserve a rotated or duplicate credential in a comment. Keeping
    // the old assignment verbatim would leave a still-valid key on disk.
    if (replaced) return `# ${ELEVENLABS_API_KEY_NAME} duplicate removed`;
    replaced = true;
    return assignment;
  });
  if (!replaced) {
    if (next.length > 0 && next[next.length - 1] !== "") next.push("");
    next.push(assignment);
  }
  while (next.length > 1 && next[next.length - 1] === "" && next[next.length - 2] === "") {
    next.pop();
  }
  return `${next.join("\n").replace(/\n+$/, "")}\n`;
}

async function atomicPrivateWrite(file: string, contents: string): Promise<void> {
  const directory = path.dirname(file);
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  await fs.chmod(directory, 0o700).catch(() => {});
  const existing = await fs.lstat(file).catch(() => null);
  if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
    throw new Error(`拒绝覆盖非普通密钥文件: ${file}`);
  }
  const temporary = path.join(
    directory,
    `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString("hex")}.tmp`,
  );
  const handle = await fs.open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await fs.rename(temporary, file);
    await fs.chmod(file, 0o600);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

export async function ensureLittlestartEnvFile(options: {
  homeDir?: string;
  env?: NodeJS.ProcessEnv;
} = {}): Promise<string> {
  const file = resolveLittlestartEnvFile(options);
  const existing = await readRegularSecretsFile(file);
  if (existing !== null) {
    await fs.chmod(file, 0o600).catch(() => {});
    return file;
  }
  const contents = [
    "# Littlestart 本机密钥。不要提交到 Git，也不要粘贴到聊天或日志。",
    "# Electron 与 littlestart CLI 会从这里读取 ElevenLabs MCP 凭据。",
    `${ELEVENLABS_API_KEY_NAME}=`,
    "",
  ].join("\n");
  await atomicPrivateWrite(file, contents);
  return file;
}

export async function writeElevenLabsApiKey(
  apiKey: string,
  options: { homeDir?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const value = apiKey.trim();
  if (value.length < 8 || value.length > 512 || /[\0\r\n]/.test(value)) {
    throw new Error("ElevenLabs API Key 格式无效");
  }
  const file = resolveLittlestartEnvFile(options);
  const existing =
    (await readRegularSecretsFile(file)) ??
    "# Littlestart 本机密钥。不要提交到 Git，也不要粘贴到聊天或日志。\n";
  await atomicPrivateWrite(file, replaceElevenLabsLine(existing, value));
  return file;
}
