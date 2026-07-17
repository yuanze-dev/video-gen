import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const roots = [
  path.join(root, "skills", "generate-video"),
  path.join(root, ".agents", "skills", "generate-video"),
  path.join(root, ".claude", "skills", "generate-video"),
  path.join(root, "packages", "littlestart-cli", "skills", "generate-video"),
];

const documentMirrors = [
  ["README-CLI.md", "packages/littlestart-cli/README.md"],
  ["docs/cli/automation.md", "packages/littlestart-cli/docs/cli/automation.md"],
  ["ASSET_RIGHTS.md", "packages/littlestart-cli/ASSET_RIGHTS.md"],
  ["THIRD_PARTY_NOTICES.md", "packages/littlestart-cli/THIRD_PARTY_NOTICES.md"],
];

async function filesIn(directory, base = directory) {
  const result = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Skill 不能包含符号链接: ${absolute}`);
    if (entry.isDirectory()) result.push(...(await filesIn(absolute, base)));
    else if (entry.isFile()) result.push(path.relative(base, absolute));
  }
  return result.sort();
}

function digest(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function requirePattern(value, pattern, label) {
  if (!pattern.test(value)) throw new Error(`文档契约缺失: ${label}`);
}

const canonicalFiles = await filesIn(roots[0]);
if (!canonicalFiles.includes("SKILL.md")) throw new Error("canonical Skill 缺少 SKILL.md");
for (const directory of roots.slice(1)) {
  const files = await filesIn(directory);
  if (JSON.stringify(files) !== JSON.stringify(canonicalFiles)) {
    throw new Error(`Skill 文件清单漂移: ${directory}`);
  }
  for (const relative of files) {
    const [canonical, mirror] = await Promise.all([
      fs.readFile(path.join(roots[0], relative)),
      fs.readFile(path.join(directory, relative)),
    ]);
    if (digest(canonical) !== digest(mirror)) {
      throw new Error(`Skill 内容漂移: ${directory}/${relative}`);
    }
  }
}

for (const [sourceRelative, packagedRelative] of documentMirrors) {
  const [source, packaged] = await Promise.all([
    fs.readFile(path.join(root, sourceRelative)),
    fs.readFile(path.join(root, packagedRelative)),
  ]);
  if (digest(source) !== digest(packaged)) {
    throw new Error(`随包文档镜像漂移: ${packagedRelative}`);
  }
}

const skillText = await fs.readFile(path.join(roots[0], "SKILL.md"), "utf8");
const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skillText)?.[1];
if (!frontmatter) throw new Error("SKILL.md 缺少 YAML frontmatter");
if (!/^name:\s*generate-video\s*$/m.test(frontmatter)) throw new Error("Skill name 必须是 generate-video");
if (!/^description:\s*\S.+$/m.test(frontmatter)) throw new Error("Skill description 不能为空");
for (const match of skillText.matchAll(/\]\((references\/[^)]+)\)/g)) {
  const target = path.join(roots[0], match[1]);
  if (!(await fs.stat(target).catch(() => null))?.isFile()) {
    throw new Error(`SKILL.md 引用了不存在的文件: ${match[1]}`);
  }
}


const [configText, workflowsText, protocolText, readmeText, automationText, rightsText, noticesText] =
  await Promise.all([
    fs.readFile(path.join(roots[0], "references", "config.md"), "utf8"),
    fs.readFile(path.join(roots[0], "references", "workflows.md"), "utf8"),
    fs.readFile(path.join(roots[0], "references", "protocol.md"), "utf8"),
    fs.readFile(path.join(root, "README-CLI.md"), "utf8"),
    fs.readFile(path.join(root, "docs", "cli", "automation.md"), "utf8"),
    fs.readFile(path.join(root, "ASSET_RIGHTS.md"), "utf8"),
    fs.readFile(path.join(root, "THIRD_PARTY_NOTICES.md"), "utf8"),
  ]);

requirePattern(skillText, /--quality[\s\S]*--resolution[\s\S]*--fps/, "Skill 要求预检与渲染使用同一导出三元组");
requirePattern(skillText, /ASSET_RIGHTS\.md[\s\S]*REQUIRES_CONFIRMATION/, "Skill 包含内置素材发行门禁");
requirePattern(skillText, /REMOTION_LICENSE_KEY/, "Skill 包含 Remotion 密钥边界");
requirePattern(configText, /config migrate[\s\S]*migrated: false/, "config migrate 如实报告 v1 未迁移");
requirePattern(configText, /plan[\s\S]*assets[\s\S]*本地文件/, "plan assets 仅表示本地文件");
requirePattern(workflowsText, /output\/cover[\s\S]*SHA-256/, "batch resume 校验产物摘要");
requirePattern(workflowsText, /\.littlestart-batch\.lock/, "batch 输出目录锁");
requirePattern(workflowsText, /LITTLESTART_CHROMIUM_GL=swangle[\s\S]*angle[\s\S]*swangle/, "无 GPU 容器的 swangle 边界");
requirePattern(protocolText, /OUTPUT_EXISTS[\s\S]*--force/, "batch 不匹配产物的覆盖规则");
requirePattern(readmeText, /cache prune[\s\S]*partial\/rebuild/, "cache prune 仅清理临时条目");
requirePattern(readmeText, /doctor[\s\S]*Chromium[\s\S]*WebGL/, "doctor 主动浏览器与 WebGL 探测");
requirePattern(readmeText, /LITTLESTART_CHROMIUM_GL=swangle/, "README 记录容器 swangle 配置");
requirePattern(automationText, /--quality[\s\S]*--resolution[\s\S]*--fps/, "自动化文档要求导出规格一致");
requirePattern(automationText, /doctor --fix --cache-dir[\s\S]*--offline/, "离线流水线复用同一缓存");
requirePattern(rightsText, /Release status: BLOCKED[\s\S]*REQUIRES_CONFIRMATION/, "内置素材权利门禁");
requirePattern(noticesText, /Mediabunny 1\.47\.0[\s\S]*Mozilla Public License 2\.0/, "Mediabunny MPL-2.0 通知");
requirePattern(noticesText, /not a complete SBOM/, "第三方清单不冒充完整 SBOM");

process.stdout.write(
  `Skill 校验通过：${canonicalFiles.length} 个文件，4 份 Skill 和 ${documentMirrors.length} 组随包文档镜像内容一致。\n`,
);
