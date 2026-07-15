import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SkillInstallTarget = "codex" | "claude" | "both";
export type SkillInstallScope = "project" | "user";

export type InstallSkillOptions = {
  sourceDir: string;
  target?: SkillInstallTarget;
  scope?: SkillInstallScope;
  force?: boolean;
  cwd?: string;
  homeDir?: string;
};

function destinations(options: InstallSkillOptions): Array<{ agent: "codex" | "claude"; path: string }> {
  const target = options.target ?? "both";
  const scope = options.scope ?? "project";
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const home = path.resolve(options.homeDir ?? os.homedir());
  const agents = target === "both" ? (["codex", "claude"] as const) : ([target] as const);
  return agents.map((agent) => {
    if (scope === "project") {
      const root = agent === "codex" ? ".agents" : ".claude";
      return { agent, path: path.join(cwd, root, "skills", "generate-video") };
    }
    const root = agent === "codex" ? ".codex" : ".claude";
    return { agent, path: path.join(home, root, "skills", "generate-video") };
  });
}

async function assertSafeSkillSource(sourceDir: string): Promise<string> {
  const source = path.resolve(sourceDir);
  const stat = await fs.lstat(source).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`Skill 来源目录不存在或不安全: ${source}`);
  }
  const skill = await fs.lstat(path.join(source, "SKILL.md")).catch(() => null);
  if (!skill?.isFile() || skill.isSymbolicLink()) {
    throw new Error(`Skill 来源缺少 SKILL.md: ${source}`);
  }
  return source;
}

async function copyTreeWithoutSymlinks(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill 包含符号链接，拒绝安装: ${from}`);
    if (entry.isDirectory()) await copyTreeWithoutSymlinks(from, to);
    else if (entry.isFile()) await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error(`Skill 包含不支持的文件类型: ${from}`);
  }
}

async function installOne(source: string, target: string, force: boolean): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const id = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const stage = path.join(path.dirname(target), `.generate-video.${id}.partial`);
  const backup = path.join(path.dirname(target), `.generate-video.${id}.backup`);
  let movedOld = false;
  try {
    const existing = await fs.lstat(target).catch(() => null);
    if (existing && !force) throw new Error(`Skill 已存在: ${target}（使用 --force 覆盖）`);
    if (existing?.isSymbolicLink()) throw new Error(`Skill 目标是符号链接，拒绝覆盖: ${target}`);

    await copyTreeWithoutSymlinks(source, stage);
    if (existing) {
      await fs.rename(target, backup);
      movedOld = true;
    }
    try {
      await fs.rename(stage, target);
    } catch (error) {
      if (movedOld) await fs.rename(backup, target).catch(() => {});
      throw error;
    }
    if (movedOld) await fs.rm(backup, { recursive: true, force: true });
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
  }
}

export async function installGenerateVideoSkill(options: InstallSkillOptions): Promise<{
  installed: Array<{ agent: "codex" | "claude"; path: string }>;
  scope: SkillInstallScope;
}> {
  const source = await assertSafeSkillSource(options.sourceDir);
  const targets = destinations(options);

  // Preflight all destinations before mutating any, so a missing --force does
  // not leave one agent installed and the other rejected.
  if (!options.force) {
    for (const target of targets) {
      if (await fs.lstat(target.path).catch(() => null)) {
        throw new Error(`Skill 已存在: ${target.path}（使用 --force 覆盖）`);
      }
    }
  }
  for (const target of targets) await installOne(source, target.path, options.force === true);
  return { installed: targets, scope: options.scope ?? "project" };
}
