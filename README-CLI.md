# Littlestart CLI

`littlestart` 是“小音符起号助手”的无界面、本机视频生产入口。它复用 GUI 的配置、素材校验、时长计算和 Remotion 合成能力，让人、Codex、Claude Code 与 CI 在不打开编辑器的情况下完成预检、静帧检查、渲染和批量生产。

兼容命令名为 `video-gen`。两者指向同一个 CLI；新脚本建议使用 `littlestart`。

## 能力边界

- 本机读取配置与素材，在本机渲染 MP4 和静帧。
- 支持严格配置校验、媒体探测、渲染计划、可重现锁文件、缓存管理和可恢复批处理。
- 为自动化提供稳定的 JSON 结果与 NDJSON 事件流。
- 自带 Codex / Claude Code Skill 安装器。
- 当前不提供云端渲染、远程素材下载、模板市场或第三方模板插件。

CLI 与 GUI 共享核心模型，但 CLI 是独立可安装的生产工具，不要求启动 Next.js、Electron 或 GUI。

### 许可与内置素材

CLI 软件包本身为 `UNLICENSED`，并使用采用特殊许可的 Remotion。组织应在部署前核对自身资格；需要商业许可时通过 `REMOTION_LICENSE_KEY` 注入密钥，CLI 不会把密钥写入日志、锁文件或结果。当前已识别的第三方许可说明见随包的 `THIRD_PARTY_NOTICES.md`；正式发行仍需基于锁文件完成 SBOM 和许可审查。

所有内置图片、音视频都会进入发行包。`ASSET_RIGHTS.md` 记录了逐文件摘要与发行审批状态；其中仍为 `REQUIRES_CONFIRMATION` 的素材是发布门禁，而不是可以忽略的警告。

### Docker / CI 镜像

仓库提供 `Dockerfile.cli`，构建时会打包 CLI、安装 Chrome Headless Shell 依赖并预热专用离线缓存：

```bash
docker build -f Dockerfile.cli -t littlestart-cli .
docker run --rm -v "$PWD:/work" littlestart-cli \
  render video.json --out output/video.mp4 --offline
```

容器以非 root 用户（UID 1000）运行，工作目录固定为 `/work`。生产环境应挂载输入/输出目录，确保挂载目录对该 UID 可写（或显式使用适合宿主目录的 `--user`），并按业务负载设置 CPU 与内存上限。

镜像显式使用 `LITTLESTART_CHROMIUM_GL=swangle`，以 ANGLE + SwiftShader 软件后端适配无 GPU 容器。非容器环境默认为 `angle`；只接受 `angle` 或 `swangle`，非法值会在下载浏览器或开始渲染前以结构化错误退出。`doctor` 与真实渲染始终使用同一后端选择。

## 安装与首次检查

环境要求：Node.js 20 或更高版本。

从已配置 `@yuanze` 包源的 registry 安装：

```bash
npm install --global @yuanze/littlestart-cli
littlestart version
littlestart doctor
```

如果拿到的是 `.tgz` 发行包，也可把第一行替换为 `npm install --global ./yuanze-littlestart-cli-<版本>.tgz`。这份文档不代表软件包已经发布到公开 npm registry。

如果 `doctor` 提示缺少可自动准备的本机渲染依赖，运行：

```bash
littlestart doctor --fix
```

不带 `--fix` 的 doctor 也会实际启动 Chromium 并创建 WebGL 上下文，而不只是检查文件是否存在。`--fix` 可在联网时下载缺失的浏览器；`--offline` 从不下载。

如果必须使用已审核的系统 Chromium，可设置 `REMOTION_BROWSER_EXECUTABLE` 为可执行文件路径。`doctor` 会优先校验并真实启动同一文件；路径无效时不会改为下载 CLI 浏览器。

在没有网络的流水线中，先在联网环境用明确的缓存目录准备依赖，再持久化或传递同一目录。执行阶段先做离线探测，后续命令也必须传同一 `--cache-dir` 和 `--offline`：

```bash
littlestart doctor --fix --cache-dir .cache/littlestart --json
# 将 .cache/littlestart 持久化到离线执行环境
littlestart doctor --offline --cache-dir .cache/littlestart --json
littlestart render video.json --out output/video.mp4 \
  --offline --cache-dir .cache/littlestart
```

安装来源、版本或命令参数可能随发布变化。始终可用以下命令查询当前二进制，而不依赖这份文档猜测：

```bash
littlestart --help
littlestart help render
littlestart capabilities --json
littlestart config schema --out project.schema.json
```

## 五分钟生成第一条视频

```bash
mkdir my-video && cd my-video
littlestart init video.json --minimal
```

编辑 `video.json` 中的标题和词稿，然后依次预检、看静帧并渲染：

```bash
littlestart validate video.json
littlestart plan video.json
littlestart still video.json --scene all --out-dir preview
littlestart render video.json --out output/video.mp4 --cover output/cover.jpg
```

渲染不会默认覆盖已有产物。确认要替换时显式加 `--force`。成片和封面以临时文件渲染并原子提交；失败或中断不会把半成品冒充成功产物。

一个常用的最小补丁配置如下。未写字段由模板默认值补齐：

```json
{
  "opening": {
    "title": { "text": "机场英语跟读" }
  },
  "content": {
    "teleprompter": {
      "text": {
        "content": "\n\n\n\nGood afternoon, ladies and gentlemen..."
      }
    }
  }
}
```

配置是严格的：未知字段、越界数值、错误素材类型、缺失文件和伪装扩展名都会在渲染前失败。完整字段、范围和默认值以当前二进制输出的 JSON Schema 为准：

```bash
littlestart config schema --json
```

## 使用本地素材

CLI 配置支持内置素材和本地文件：

```json
{
  "content": {
    "background": { "kind": "file", "path": "./assets/background.jpg" },
    "bgm": {
      "asset": { "kind": "file", "path": "./assets/music.mp3" },
      "volume": 0.6
    }
  }
}
```

- 相对路径以配置文件所在目录为基准；配置从标准输入 `-` 传入时，自动化脚本应优先使用绝对素材路径。
- 不要把 GUI 会话里的临时 `upload` id 写进 CLI 配置。使用 `kind: "file"`，CLI 会验证实际文件并为本次渲染注册素材。
- 不要按文件扩展名猜兼容性。用 `capabilities` 查看当前支持格式，用 `probe` 或 `assets inspect` 检查具体文件。
- 内置素材 id 与允许的使用位置以 `assets list` 和 `assets inspect` 为准。

```bash
littlestart assets list --json
littlestart assets inspect airport --json
littlestart assets inspect ./assets/music.mp3 --json
littlestart probe ./assets/clip.mp4 --json
```

## 命令地图

以下是稳定的命令族；每个命令的精确选项用 `littlestart help <命令>` 查询。

| 命令 | 用途 |
|---|---|
| `version` | 输出 CLI、协议和运行时版本 |
| `doctor [--fix]` | 检查并按需准备本机渲染环境 |
| `capabilities` | 自描述模板、格式、场景和运行能力 |
| `init` | 生成完整或最小配置 |
| `validate` | 严格校验配置、字段和素材 |
| `plan` | 解析时长、帧数、输出规格与本地文件素材，但不渲染 |
| `render` | 渲染 MP4，并可同时输出封面 |
| `still` | 导出 opening / content / ending 或全部场景静帧 |
| `probe` | 读取本地媒体元数据与轨道信息 |
| `config schema` | 输出当前模板的 JSON Schema |
| `config resolve` | 合并默认值，输出完整规范化配置 |
| `config lock` | 固化配置、模板和素材摘要，生成可重现锁文件 |
| `config migrate` | 规范化当前 v1 配置并显式报告未发生迁移 |
| `templates list/show` | 列出或查看随 CLI 分发的模板 |
| `assets list/inspect` | 列出内置素材或检查内置/本地素材 |
| `cache list/prune/clear` | 查看和清理本机渲染缓存 |
| `batch` | 预检并批量渲染，支持有限并发与断点恢复 |
| `skill install` | 安装 Codex / Claude Code 的视频生成 Skill |

`templates`、`assets` 和 `cache` 均可省略默认的 `list` 子命令。`video-gen` 支持同样的命令与选项。

## 配置与可重现生产

推荐把“易读的源配置”和“机器可复现的锁文件”分开保存：

```bash
littlestart validate campaign.json
littlestart config resolve campaign.json --out build/campaign.resolved.json
littlestart config lock campaign.json --quality high --resolution 1080p --fps 60 \
  --out build/campaign.lock.json
littlestart plan build/campaign.lock.json
littlestart render build/campaign.lock.json --out output/campaign.mp4
```

锁文件固定模板语义、完整配置、素材摘要和导出规格；`render` / `still` / `batch` 不允许用命令行或 manifest 覆盖这些导出参数。要改清晰度、帧率或质量，请从源配置重新生成锁文件。建议在代码评审中提交源配置，并把锁文件与 `version --json` 一并归档。

当前配置版本只有 v1。`config migrate` 可把 v1 部分配置规范化并明确返回 `migrated: false`；遇到未来受支持的旧版本前，它不会假装完成不存在的迁移。

`--cache-dir <目录>` 可把浏览器、合成站点和内容摘要缓存固定到 CI 持久卷。`cache prune` 只清除过期的 partial/rebuild 临时条目，`cache clear --force` 才会清空全部缓存；它们与正在写入缓存的命令使用同一维护锁。

## 批量与断点恢复

批次清单格式由当前 CLI 自描述；先查看帮助和 capabilities，不要从旧示例猜字段：

```bash
littlestart help batch
littlestart capabilities --json
```

典型调用：

```bash
littlestart batch batch.json \
  --out-dir output \
  --jobs 2 \
  --resume \
  --events ndjson > batch.events.ndjson
```

批处理先预检任务，再开始渲染。`--resume` 同时核对配置、素材、模板 runtime、导出规格以及 output/cover 的大小和 SHA-256；不要仅凭“文件存在”自行判成功。旧 journal 缺少产物完整性字段时不会被当作可恢复；若目标文件已存在但与 journal 不匹配，只有在确认覆盖后加 `--force` 才会替换。同一 `--out-dir` 的整个批次会由 `.littlestart-batch.lock` 串行化，不要依赖并发调度多个写者。批次可能部分失败，此时进程会返回非零状态，机器结果会保留逐任务状态以便修复后重跑。

## 面向 Agent 与 CI 的输出协议

人类模式适合终端；自动化必须选择以下一种机器模式：

```bash
# 一个最终 JSON 文档，适合 validate / plan / probe 等短命令
littlestart plan video.json --json > plan.json

# 一行一个事件，适合 render / batch 的实时进度
littlestart render video.json --out output/video.mp4 \
  --events ndjson > render.events.ndjson
```

- `--json` 的 stdout 只有一个 `{protocolVersion, ok, result|error}` 信封。
- `--events ndjson` 的 stdout 只有 `started`、`progress`、`warning`、`result` 或 `error` 事件，每行都是完整 JSON。
- 进度和人类诊断写到 stderr；`--quiet` 只抑制非必要诊断，不隐藏最终错误。
- `--json` 与 `--events ndjson` 互斥。自动化同时检查进程退出码和最终信封，不以日志文本判断成功。
- 错误包含稳定的 `error.code`、`error.exitCode`、可选字段路径 `issues[].path` 和修复提示。

完整协议和退出码见 [docs/cli/automation.md](docs/cli/automation.md)。

## 安装 Agent Skill

在项目根目录为 Codex 和 Claude Code 安装随当前 CLI 分发的 Skill：

```bash
littlestart skill install
```

完整语法：

```text
littlestart skill install [--target codex|claude|both] [--scope project|user] [--force]
```

默认是 `--target both --scope project`，写入当前项目的 `.agents/skills/generate-video` 与 `.claude/skills/generate-video`。用户级安装使用 `--scope user`。安装器默认不覆盖已存在的 Skill；确认替换时再加 `--force`。

安装完成后可对 Agent 说：

```text
使用 $generate-video，把 ./copy.txt 和 ./assets/background.jpg 做成一条视频，先给我看三段静帧，再渲染成片。
```

Skill 会先从 `capabilities`、`config schema` 和 `help` 自发现当前 CLI 能力，避免把旧字段或过期选项写进流水线。

## 故障处理

1. 先运行 `validate <配置> --json`，按 `issues[].path` 修复配置或素材。
2. 素材问题运行 `probe <文件> --json` 或 `assets inspect <文件> --json`。
3. 环境问题运行 `doctor --json`；允许准备依赖时再运行 `doctor --fix`。
4. 只在缓存明确损坏时用 `cache prune` 或 `cache clear --force`；普通渲染失败无需先清缓存。
5. 需要确认最终默认值和时长时运行 `config resolve` 与 `plan`。
6. 首次自动化上线前，用 `still --scene all` 做视觉检查，再放开批量渲染。

`SIGINT`（Ctrl-C）会请求安全取消并清理本次临时产物。脚本仍应等待进程结束并检查退出码，不要在外部直接把临时文件改名成正式产物。
