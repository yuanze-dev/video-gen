import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export type SkillInstallTarget = "codex" | "claude" | "both";
export type SkillInstallScope = "project" | "user";

export const MANAGED_SKILL_MARKER = ".littlestart-managed.json";

const MANAGED_SKILL_SCHEMA_VERSION = 1;
const MAX_MANAGED_SKILL_FILES = 512;
const MAX_MANAGED_SKILL_BYTES = 16 * 1024 * 1024;
const MAX_MANAGED_SKILL_MARKER_BYTES = 4096;

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
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Skill 包含符号链接，拒绝安装: ${from}`);
    if (stat.isDirectory()) await copyTreeWithoutSymlinks(from, to);
    else if (stat.isFile()) await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error(`Skill 包含不支持的文件类型: ${from}`);
  }
}

async function installOne(source: string, target: string, force: boolean): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true });
  const id = `${process.pid}-${crypto.randomBytes(8).toString("hex")}`;
  const stage = path.join(path.dirname(target), `.generate-video.${id}.partial`);
  const backup = path.join(path.dirname(target), `.generate-video.${id}.backup`);
  let movedOld = false;
  let preserveBackup = false;
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
      if (movedOld) {
        try {
          await fs.rename(backup, target);
          movedOld = false;
        } catch (restoreError) {
          preserveBackup = true;
          throw new Error(
            `Skill 替换失败，且自动恢复原 Skill 失败。原 Skill 备份仍保留在 ${backup}；请手动将其移动回 ${target}。替换错误: ${error instanceof Error ? error.message : String(error)}；恢复错误: ${restoreError instanceof Error ? restoreError.message : String(restoreError)}`,
            { cause: error },
          );
        }
      }
      throw error;
    }
    if (movedOld) {
      await fs.rm(backup, { recursive: true, force: true });
      movedOld = false;
    }
  } finally {
    await fs.rm(stage, { recursive: true, force: true }).catch(() => {});
    if (movedOld && !preserveBackup) {
      await fs.rm(backup, { recursive: true, force: true }).catch(() => {});
    }
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

type ManagedSkillMarker = {
  schemaVersion: typeof MANAGED_SKILL_SCHEMA_VERSION;
  manager: "littlestart-electron";
  skill: "generate-video";
  contentDigest: string;
};

export type ManagedSkillTargetStatus =
  | "missing"
  | "current"
  | "update-needed"
  | "adoptable"
  | "conflict";

export type ManagedSkillTargetInspection = {
  agent: "codex" | "claude";
  path: string;
  status: ManagedSkillTargetStatus;
  reason?: "unmanaged" | "modified" | "unsafe";
  fingerprint: string;
};

export type ManagedSkillInspection = {
  sourceDir: string;
  sourceDigest: string;
  status: "ready" | "install-needed" | "conflict";
  targets: ManagedSkillTargetInspection[];
};

export type ManagedSkillMutationOutcome = {
  ok: boolean;
  retainedPaths: string[];
};

export class ManagedSkillInstallError extends Error {
  readonly code: "SKILL_INSTALL_CONFLICT" | "SKILL_INSTALL_FAILED" | "ROLLBACK_FAILED";
  readonly paths: string[];

  constructor(
    code: ManagedSkillInstallError["code"],
    message: string,
    paths: string[] = [],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ManagedSkillInstallError";
    this.code = code;
    this.paths = paths;
  }
}

export type ManagedSkillInstallTransaction = {
  installed: Array<{ agent: "codex" | "claude"; path: string }>;
  verify: () => Promise<boolean>;
  rollback: () => Promise<ManagedSkillMutationOutcome>;
  commit: () => Promise<ManagedSkillMutationOutcome>;
};

type ManagedSkillReceipt = {
  target: ManagedSkillTargetInspection;
  backupPath: string | null;
  publishedFingerprint: string | null;
};

type DigestBudget = {
  files: number;
  bytes: number;
};

function digestEntryPath(relativePath: string): string {
  return relativePath.split(path.sep).join("/");
}

async function digestSkillTree(root: string): Promise<string> {
  const hash = crypto.createHash("sha256");
  const budget: DigestBudget = { files: 0, bytes: 0 };

  const visit = async (directory: string, relativeDirectory: string): Promise<void> => {
    const directoryBefore = await fs.lstat(directory);
    if (!directoryBefore.isDirectory() || directoryBefore.isSymbolicLink()) {
      throw new Error(`Skill 目录在读取期间发生变化: ${directory}`);
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) =>
      left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
    );
    for (const entry of entries) {
      if (relativeDirectory === "" && entry.name === MANAGED_SKILL_MARKER) continue;
      const absolute = path.join(directory, entry.name);
      const relative = path.join(relativeDirectory, entry.name);
      const normalized = digestEntryPath(relative);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) {
        throw new Error(`Skill 包含符号链接，拒绝管理: ${absolute}`);
      }
      budget.files += 1;
      if (budget.files > MAX_MANAGED_SKILL_FILES) {
        throw new Error(`Skill 文件过多，拒绝管理: ${root}`);
      }
      if (stat.isDirectory()) {
        hash.update(`D\0${normalized}\0`);
        await visit(absolute, relative);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Skill 包含不支持的文件类型: ${absolute}`);
      }
      budget.bytes += stat.size;
      if (budget.bytes > MAX_MANAGED_SKILL_BYTES) {
        throw new Error(`Skill 体积过大，拒绝管理: ${root}`);
      }
      const bytes = await fs.readFile(absolute);
      const after = await fs.lstat(absolute);
      if (
        !after.isFile() ||
        after.isSymbolicLink() ||
        after.dev !== stat.dev ||
        after.ino !== stat.ino ||
        after.size !== stat.size ||
        after.mtimeMs !== stat.mtimeMs ||
        bytes.length !== stat.size
      ) {
        throw new Error(`Skill 文件在读取期间发生变化: ${absolute}`);
      }
      hash.update(`F\0${normalized}\0${bytes.length}\0`);
      hash.update(bytes);
      hash.update("\0");
    }
    const directoryAfter = await fs.lstat(directory);
    if (
      !directoryAfter.isDirectory() ||
      directoryAfter.isSymbolicLink() ||
      directoryAfter.dev !== directoryBefore.dev ||
      directoryAfter.ino !== directoryBefore.ino ||
      directoryAfter.mtimeMs !== directoryBefore.mtimeMs
    ) {
      throw new Error(`Skill 目录在读取期间发生变化: ${directory}`);
    }
  };

  await visit(root, "");
  return hash.digest("hex");
}

function managedMarker(contentDigest: string): ManagedSkillMarker {
  return {
    schemaVersion: MANAGED_SKILL_SCHEMA_VERSION,
    manager: "littlestart-electron",
    skill: "generate-video",
    contentDigest,
  };
}

async function readManagedMarker(target: string): Promise<ManagedSkillMarker | null> {
  const markerPath = path.join(target, MANAGED_SKILL_MARKER);
  const stat = await fs.lstat(markerPath).catch(() => null);
  if (!stat) return null;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MANAGED_SKILL_MARKER_BYTES) {
    throw new Error(`Skill 受管标记不安全: ${markerPath}`);
  }
  let value: Partial<ManagedSkillMarker> = {};
  try {
    const contents = await fs.readFile(markerPath, "utf8");
    const after = await fs.lstat(markerPath);
    if (
      !after.isFile() ||
      after.isSymbolicLink() ||
      after.dev !== stat.dev ||
      after.ino !== stat.ino ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs
    ) {
      throw new Error("MARKER_CHANGED");
    }
    value = JSON.parse(contents) as Partial<ManagedSkillMarker>;
  } catch {
    throw new Error(`Skill 受管标记无效: ${markerPath}`);
  }
  if (
    value.schemaVersion !== MANAGED_SKILL_SCHEMA_VERSION ||
    value.manager !== "littlestart-electron" ||
    value.skill !== "generate-video" ||
    typeof value.contentDigest !== "string" ||
    !/^[0-9a-f]{64}$/.test(value.contentDigest)
  ) {
    throw new Error(`Skill 受管标记无效: ${markerPath}`);
  }
  return value as ManagedSkillMarker;
}

function targetFingerprint(value: {
  status: ManagedSkillTargetStatus;
  reason?: ManagedSkillTargetInspection["reason"];
  contentDigest?: string;
  markerDigest?: string;
}): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

async function inspectManagedTarget(
  agent: "codex" | "claude",
  target: string,
  sourceDigest: string,
): Promise<ManagedSkillTargetInspection> {
  const stat = await fs.lstat(target).catch(() => null);
  if (!stat) {
    return {
      agent,
      path: target,
      status: "missing",
      fingerprint: targetFingerprint({ status: "missing" }),
    };
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    return {
      agent,
      path: target,
      status: "conflict",
      reason: "unsafe",
      fingerprint: targetFingerprint({ status: "conflict", reason: "unsafe" }),
    };
  }

  try {
    const [contentDigest, marker] = await Promise.all([
      digestSkillTree(target),
      readManagedMarker(target),
    ]);
    if (!marker) {
      const status = contentDigest === sourceDigest ? "adoptable" : "conflict";
      const reason = status === "conflict" ? "unmanaged" : undefined;
      return {
        agent,
        path: target,
        status,
        reason,
        fingerprint: targetFingerprint({ status, reason, contentDigest }),
      };
    }
    if (contentDigest !== marker.contentDigest) {
      return {
        agent,
        path: target,
        status: "conflict",
        reason: "modified",
        fingerprint: targetFingerprint({
          status: "conflict",
          reason: "modified",
          contentDigest,
          markerDigest: marker.contentDigest,
        }),
      };
    }
    const status = contentDigest === sourceDigest ? "current" : "update-needed";
    return {
      agent,
      path: target,
      status,
      fingerprint: targetFingerprint({
        status,
        contentDigest,
        markerDigest: marker.contentDigest,
      }),
    };
  } catch {
    return {
      agent,
      path: target,
      status: "conflict",
      reason: "unsafe",
      fingerprint: targetFingerprint({ status: "conflict", reason: "unsafe" }),
    };
  }
}

async function managedTargetParentsAreSafe(homeDir: string, target: string): Promise<boolean> {
  const home = path.resolve(homeDir);
  const parent = path.dirname(path.resolve(target));
  const relative = path.relative(home, parent);
  if (
    relative === "" ||
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return relative === "";
  }
  let current = home;
  const homeStat = await fs.lstat(home).catch(() => null);
  if (!homeStat?.isDirectory() || homeStat.isSymbolicLink()) return false;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    const stat = await fs.lstat(current).catch(() => null);
    if (!stat) return true;
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

export async function inspectManagedGenerateVideoSkill(options: {
  sourceDir: string;
  homeDir?: string;
  target?: SkillInstallTarget;
}): Promise<ManagedSkillInspection> {
  const sourceDir = await assertSafeSkillSource(options.sourceDir);
  const sourceDigest = await digestSkillTree(sourceDir);
  const homeDir = path.resolve(options.homeDir ?? os.homedir());
  const targets = destinations({
    sourceDir,
    homeDir,
    scope: "user",
    target: options.target ?? "both",
  });
  const inspected = await Promise.all(targets.map(async (target) => {
    if (!(await managedTargetParentsAreSafe(homeDir, target.path))) {
      return {
        agent: target.agent,
        path: target.path,
        status: "conflict" as const,
        reason: "unsafe" as const,
        fingerprint: targetFingerprint({ status: "conflict", reason: "unsafe" }),
      };
    }
    return inspectManagedTarget(target.agent, target.path, sourceDigest);
  }));
  return {
    sourceDir,
    sourceDigest,
    status: inspected.some((target) => target.status === "conflict")
      ? "conflict"
      : inspected.every((target) => target.status === "current")
        ? "ready"
        : "install-needed",
    targets: inspected,
  };
}

async function copyManagedSkillSource(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { recursive: true });
  for (const entry of await fs.readdir(source, { withFileTypes: true })) {
    if (entry.name === MANAGED_SKILL_MARKER) continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    const stat = await fs.lstat(from);
    if (stat.isSymbolicLink()) throw new Error(`Skill 包含符号链接，拒绝安装: ${from}`);
    if (stat.isDirectory()) await copyTreeWithoutSymlinks(from, to);
    else if (stat.isFile()) await fs.copyFile(from, to, fs.constants.COPYFILE_EXCL);
    else throw new Error(`Skill 包含不支持的文件类型: ${from}`);
  }
}

async function writeManagedMarker(target: string, sourceDigest: string): Promise<void> {
  await fs.writeFile(
    path.join(target, MANAGED_SKILL_MARKER),
    `${JSON.stringify(managedMarker(sourceDigest), null, 2)}\n`,
    { flag: "wx", mode: 0o600 },
  );
}

async function copyPublishedTree(source: string, target: string): Promise<void> {
  await fs.mkdir(target, { mode: 0o755 });
  await copyTreeWithoutSymlinks(source, target);
}

async function safelyRemovePublishedTree(
  receipt: ManagedSkillReceipt,
  sourceDigest: string,
): Promise<ManagedSkillMutationOutcome> {
  if (!receipt.publishedFingerprint) {
    return { ok: false, retainedPaths: [receipt.target.path] };
  }
  const current = await inspectManagedTarget(
    receipt.target.agent,
    receipt.target.path,
    sourceDigest,
  );
  if (current.fingerprint !== receipt.publishedFingerprint) {
    return { ok: false, retainedPaths: [receipt.target.path] };
  }
  const quarantine = `${receipt.target.path}.littlestart-published-${crypto.randomUUID()}`;
  try {
    await fs.rename(receipt.target.path, quarantine);
    const moved = await inspectManagedTarget(receipt.target.agent, quarantine, sourceDigest);
    if (moved.fingerprint !== receipt.publishedFingerprint) {
      await fs.rename(quarantine, receipt.target.path).catch(() => {});
      return { ok: false, retainedPaths: [quarantine, receipt.target.path] };
    }
    await fs.rm(quarantine, { recursive: true });
    return { ok: true, retainedPaths: [] };
  } catch {
    return { ok: false, retainedPaths: [quarantine, receipt.target.path] };
  }
}

async function rollbackManagedSkillReceipt(
  receipt: ManagedSkillReceipt,
  sourceDigest: string,
): Promise<ManagedSkillMutationOutcome> {
  if (receipt.publishedFingerprint) {
    const removed = await safelyRemovePublishedTree(receipt, sourceDigest);
    if (!removed.ok) {
      return {
        ok: false,
        retainedPaths: [
          ...new Set([
            ...removed.retainedPaths,
            ...(receipt.backupPath ? [receipt.backupPath] : []),
          ]),
        ],
      };
    }
  } else if (await fs.lstat(receipt.target.path).catch(() => null)) {
    return {
      ok: false,
      retainedPaths: [
        receipt.target.path,
        ...(receipt.backupPath ? [receipt.backupPath] : []),
      ],
    };
  }
  if (!receipt.backupPath) return { ok: true, retainedPaths: [] };
  try {
    await copyPublishedTree(receipt.backupPath, receipt.target.path);
    const restored = await inspectManagedTarget(
      receipt.target.agent,
      receipt.target.path,
      sourceDigest,
    );
    if (restored.fingerprint !== receipt.target.fingerprint) {
      return {
        ok: false,
        retainedPaths: [receipt.target.path, receipt.backupPath],
      };
    }
    await fs.rm(receipt.backupPath, { recursive: true });
    return { ok: true, retainedPaths: [] };
  } catch {
    return {
      ok: false,
      retainedPaths: [receipt.target.path, receipt.backupPath],
    };
  }
}

async function commitManagedSkillReceipt(
  receipt: ManagedSkillReceipt,
  sourceDigest: string,
): Promise<ManagedSkillMutationOutcome> {
  if (!receipt.backupPath) return { ok: true, retainedPaths: [] };
  const cleanupPath = `${receipt.backupPath}.commit-${crypto.randomUUID()}`;
  let moved = false;
  try {
    await fs.rename(receipt.backupPath, cleanupPath);
    moved = true;
    const backup = await inspectManagedTarget(
      receipt.target.agent,
      cleanupPath,
      sourceDigest,
    );
    if (backup.fingerprint !== receipt.target.fingerprint) {
      const restored = await fs.rename(cleanupPath, receipt.backupPath)
        .then(() => true)
        .catch(() => false);
      if (restored) moved = false;
      return {
        ok: false,
        retainedPaths: [restored ? receipt.backupPath : cleanupPath],
      };
    }
    await fs.rm(cleanupPath, { recursive: true });
    return { ok: true, retainedPaths: [] };
  } catch {
    return { ok: false, retainedPaths: [moved ? cleanupPath : receipt.backupPath] };
  }
}

export async function beginManagedGenerateVideoSkillInstall(options: {
  sourceDir: string;
  homeDir?: string;
  target?: SkillInstallTarget;
  testHooks?: {
    afterTargetPublish?: (target: ManagedSkillTargetInspection) => Promise<void>;
  };
}): Promise<ManagedSkillInstallTransaction> {
  const inspection = await inspectManagedGenerateVideoSkill(options);
  const conflicts = inspection.targets.filter((target) => target.status === "conflict");
  if (conflicts.length > 0) {
    throw new ManagedSkillInstallError(
      "SKILL_INSTALL_CONFLICT",
      `检测到用户管理或已修改的 generate-video Skill，未进行覆盖: ${conflicts.map((target) => target.path).join("、")}`,
      conflicts.map((target) => target.path),
    );
  }

  const pending = inspection.targets.filter((target) => target.status !== "current");
  if (pending.length === 0) {
    return {
      installed: inspection.targets.map(({ agent, path: targetPath }) => ({
        agent,
        path: targetPath,
      })),
      verify: async () =>
        (await inspectManagedGenerateVideoSkill(options)).status === "ready",
      rollback: async () => ({ ok: true, retainedPaths: [] }),
      commit: async () => ({ ok: true, retainedPaths: [] }),
    };
  }

  const stages = new Map<string, string>();
  const receipts: ManagedSkillReceipt[] = [];
  let finished = false;
  try {
    // Build every staged tree before the first user-directory mutation.
    for (const target of pending) {
      if (!(await managedTargetParentsAreSafe(options.homeDir ?? os.homedir(), target.path))) {
        throw new ManagedSkillInstallError(
          "SKILL_INSTALL_CONFLICT",
          `generate-video Skill 目标的父目录不安全，未进行写入: ${target.path}`,
          [target.path],
        );
      }
      await fs.mkdir(path.dirname(target.path), { recursive: true });
      if (!(await managedTargetParentsAreSafe(options.homeDir ?? os.homedir(), target.path))) {
        throw new ManagedSkillInstallError(
          "SKILL_INSTALL_CONFLICT",
          `generate-video Skill 目标的父目录不安全，未进行写入: ${target.path}`,
          [target.path],
        );
      }
      const stage = path.join(
        path.dirname(target.path),
        `.generate-video.littlestart-stage-${crypto.randomUUID()}`,
      );
      await fs.mkdir(stage, { mode: 0o700 });
      stages.set(target.path, stage);
      await copyManagedSkillSource(inspection.sourceDir, stage);
      await writeManagedMarker(stage, inspection.sourceDigest);
      const staged = await inspectManagedTarget(target.agent, stage, inspection.sourceDigest);
      if (staged.status !== "current") throw new Error("SKILL_STAGE_VERIFY_FAILED");
    }

    const refreshed = await inspectManagedGenerateVideoSkill(options);
    const refreshedByPath = new Map(refreshed.targets.map((target) => [target.path, target]));
    for (const target of inspection.targets) {
      if (refreshedByPath.get(target.path)?.fingerprint !== target.fingerprint) {
        throw new ManagedSkillInstallError(
          "SKILL_INSTALL_CONFLICT",
          `generate-video Skill 在安装期间发生变化，未进行覆盖: ${target.path}`,
          [target.path],
        );
      }
    }

    for (const target of pending) {
      const stage = stages.get(target.path);
      if (!stage) throw new Error("SKILL_STAGE_MISSING");
      const backupPath =
        target.status === "missing"
          ? null
          : `${target.path}.littlestart-previous-${crypto.randomUUID()}`;
      if (backupPath) {
        await fs.rename(target.path, backupPath);
        const moved = await inspectManagedTarget(target.agent, backupPath, inspection.sourceDigest);
        if (moved.fingerprint !== target.fingerprint) {
          await fs.rename(backupPath, target.path).catch(() => {});
          throw new ManagedSkillInstallError(
            "SKILL_INSTALL_CONFLICT",
            `generate-video Skill 在安装期间发生变化，未进行覆盖: ${target.path}`,
            [target.path, backupPath],
          );
        }
      }
      const receipt: ManagedSkillReceipt = {
        target,
        backupPath,
        publishedFingerprint: null,
      };
      receipts.push(receipt);
      await copyPublishedTree(stage, target.path);
      const published = await inspectManagedTarget(
        target.agent,
        target.path,
        inspection.sourceDigest,
      );
      if (published.status !== "current") throw new Error("SKILL_PUBLISH_VERIFY_FAILED");
      receipt.publishedFingerprint = published.fingerprint;
      await options.testHooks?.afterTargetPublish?.(target);
      await fs.rm(stage, { recursive: true });
      stages.delete(target.path);
    }

    let active = true;
    const transaction: ManagedSkillInstallTransaction = {
      installed: inspection.targets.map(({ agent, path: targetPath }) => ({
        agent,
        path: targetPath,
      })),
      verify: async () => active && (await inspectManagedGenerateVideoSkill(options)).status === "ready",
      rollback: async () => {
        if (!active) return { ok: true, retainedPaths: [] };
        active = false;
        const outcomes: ManagedSkillMutationOutcome[] = [];
        for (const receipt of [...receipts].reverse()) {
          outcomes.push(await rollbackManagedSkillReceipt(receipt, inspection.sourceDigest));
        }
        return {
          ok: outcomes.every((outcome) => outcome.ok),
          retainedPaths: [...new Set(outcomes.flatMap((outcome) => outcome.retainedPaths))],
        };
      },
      commit: async () => {
        if (!active) return { ok: true, retainedPaths: [] };
        active = false;
        const outcomes = await Promise.all(
          receipts.map((receipt) =>
            commitManagedSkillReceipt(receipt, inspection.sourceDigest),
          ),
        );
        return {
          ok: outcomes.every((outcome) => outcome.ok),
          retainedPaths: [...new Set(outcomes.flatMap((outcome) => outcome.retainedPaths))],
        };
      },
    };
    finished = true;
    return transaction;
  } catch (error) {
    const outcomes: ManagedSkillMutationOutcome[] = [];
    for (const receipt of [...receipts].reverse()) {
      outcomes.push(await rollbackManagedSkillReceipt(receipt, inspection.sourceDigest));
    }
    const retainedPaths = [...new Set(outcomes.flatMap((outcome) => outcome.retainedPaths))];
    if (outcomes.some((outcome) => !outcome.ok)) {
      throw new ManagedSkillInstallError(
        "ROLLBACK_FAILED",
        `generate-video Skill 安装失败，且无法安全恢复: ${retainedPaths.join("、")}`,
        retainedPaths,
        { cause: error },
      );
    }
    if (error instanceof ManagedSkillInstallError) throw error;
    throw new ManagedSkillInstallError(
      "SKILL_INSTALL_FAILED",
      "generate-video Skill 安装失败，已撤销本次 Skill 变更。",
      [],
      { cause: error },
    );
  } finally {
    if (!finished) {
      await Promise.all(
        [...stages.values()].map((stage) =>
          fs.rm(stage, { recursive: true, force: true }).catch(() => {}),
        ),
      );
    }
  }
}
