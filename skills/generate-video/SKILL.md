---
name: generate-video
description: 使用 Littlestart 本地 CLI 在不打开 GUI 的情况下创建、校验、预览、渲染或批量生产“小音符起号助手”竖屏提词视频。用于用户要求生成视频、出片、改标题或词稿、替换背景/BGM/片尾、检查静帧、探测媒体、排查本地渲染失败、编排 Codex 或 Claude Code 视频流水线时；也用于维护可复现配置、锁文件和断点续跑批次。
---

# 使用 Littlestart 生成视频

优先调用 `littlestart`；`video-gen` 是兼容别名。通过当前二进制自发现能力，不凭记忆猜配置字段、素材 id 或选项。

## 执行流程

1. 运行 `littlestart version --json` 确认二进制与协议；若二进制存在但环境失败，再运行 `littlestart doctor --json`。只有用户允许准备依赖时才运行 `doctor --fix`。若 shell 明确提示命令不存在，先尝试兼容名 `video-gen`；两者都不存在时，不要继续调用 `doctor`，应按项目提供的 tgz / registry 安装说明定位 CLI，或向用户索取安装来源。
2. 在首次使用或版本变化后运行 `capabilities --json`。需要字段时运行 `config schema --json`，需要命令参数时运行 `help <命令>`。
3. 创建一份只包含用户改动的 JSON 配置。优先用 `init --minimal` 起步；本地素材使用 `kind: "file"`，不要复用 GUI 的临时 `upload` id。
4. 依次运行 `validate --json` 与 `plan --json`。若选择了非默认 `--quality` / `--resolution` / `--fps`，这三个命令和最终 `render` 必须使用完全相同的值；稳定流水线优先生成锁文件。根据 `error.code`、`issues[].path` 和 hint 修复问题，不要用日志文本猜原因。
5. 对视觉改动先运行 `still --scene all`，实际查看静帧；标题换行、背景、幕布颜色、素材位置或设备屏幕区域变化时必须执行这一步。
6. 运行 `render`。长任务使用 `--events ndjson`，同时检查退出码与最终 `result`/`error` 终态。
7. 向用户报告 CLI 返回的正式输出路径、成片时长和关键规格；不要把预期路径或临时文件当成成功结果。

## 决策规则

- 读取或修改配置前，按需阅读 [references/config.md](references/config.md)。不要复制一份完整 schema 到对话或脚本中。
- 编排单条、批量、离线 CI、断点恢复或错误恢复时，阅读 [references/workflows.md](references/workflows.md)。解析机器输出或退出码时，阅读 [references/protocol.md](references/protocol.md)。
- 默认不覆盖已有产物。只有用户明确允许替换时才加 `--force`。
- 素材路径必须存在且与槽位类型匹配。相对路径以配置文件目录为基准；配置从 stdin 传入时优先使用绝对路径。
- `plan` 的 `assets` 只表示已解析的本地文件，不是全部内置素材清单。核对内置引用时结合 `config resolve`、`assets list` 和 `assets inspect`。
- 不虚构远程下载、云端渲染、模板市场或第三方模板能力。当前工作流以 CLI 随包提供的本机模板和素材为边界。
- 公开发行 CLI、向客户分发，或交付使用内置素材生成的视频前，必须审查随包 `ASSET_RIGHTS.md`；任何 `REQUIRES_CONFIRMATION` 都阻断发行。
- 不推断用户或组织已获得 Remotion 许可。需要密钥时只使用 `REMOTION_LICENSE_KEY`，不把它写入配置、manifest、锁文件、日志或回复。
- 不因一次失败就清空缓存。先按错误分类运行 `validate`、`probe`、`assets inspect` 或 `doctor`，仅在证据指向缓存问题时清理。
- 收到取消请求时让 CLI 处理信号并等待退出，不手动发布半成品。

## 机器输出

短命令使用 `--json`；渲染和批量任务使用 `--events ndjson`。stdout 只作为机器协议读取，stderr 只用于诊断。不要混用两种模式，也不要 grep 人类文案判断成功。

在自动化中保留源配置、`version`、`plan` 或锁文件、最终结果信封。安装后的 Skill 已随附 [references/protocol.md](references/protocol.md)；仍应以当前二进制的 `protocolVersion`、`help` 与 `capabilities` 为准。
