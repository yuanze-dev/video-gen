---
name: generate-video
description: 使用 Littlestart 本地 CLI 在不打开 GUI 的情况下创建、校验、预览、渲染或批量生产“小音符起号助手”竖屏提词视频。用于用户要求生成视频、出片、改标题或词稿、替换背景/BGM/片尾、检查静帧、探测媒体、排查本地渲染失败、编排 Codex 或 Claude Code 视频流水线时；也用于维护可复现配置、锁文件和断点续跑批次。
---

# 使用 Littlestart 生成视频

优先调用 `littlestart`；`video-gen` 是兼容别名。通过当前二进制自发现能力，不凭记忆猜配置字段、素材 id 或选项。

## 执行流程

1. 运行 `littlestart version --json` 确认二进制与协议；若二进制存在但环境失败，再运行 `littlestart doctor --json`。怀疑音频 sidecar 时运行 `doctor --audio --json`，它只做 initialize 与 tools/list，不生成、不扣费。只有用户允许准备依赖时才运行 `doctor --fix`。若 shell 明确提示命令不存在，先尝试兼容名 `video-gen`；两者都不存在时，不要继续调用 `doctor`，应按项目提供的 tgz / registry 安装说明定位 CLI，或向用户索取安装来源。
2. 在首次使用或版本变化后运行 `capabilities --json`。需要字段时运行 `config schema --json`，需要命令参数时运行 `help <命令>`。
3. 创建一份只包含用户改动的 JSON 配置。优先用 `init --minimal` 起步，必须替换其标题和提词占位文案；用户没有明确要求改片头/片尾时，不得写入 `opening.countdown`、`opening.curtain` 或 `ending`，让模板保留完整 3-2-1 幕帘和 FlowPrompter 片尾。本地素材使用 `kind: "file"`，不要复用 GUI 的临时 `upload` id。
4. 依次运行 `validate --json` 与 `plan --json`。核对 timeline 必须同时包含 opening、content、ending；标准生产的 opening 不得少于 1.4 秒，ending 不得少于 1 秒。若选择了非默认 `--quality` / `--resolution` / `--fps`，预检和最终生产必须使用完全相同的值。根据 `error.code`、`issues[].path` 和 hint 修复问题，不要用日志文本猜原因。
5. 对视觉改动先运行 `still --scene all`，实际查看静帧；内容段默认抓取入场稳定后的代表帧。要检查滚动中段或末段时使用 `--progress 0..1`。文本模式下 `--scene content --progress 1` 必须已经没有可见词稿，证明最后一行完整滚出后才会进入片尾。标题换行、背景、幕布颜色、素材位置或设备屏幕区域变化时必须执行这一步。
6. 用户要求生成完整视频时，默认运行 `produce <配置> --bgm auto`，不要把 `audio generate`、手工合并 JSON 和 `render` 暴露成需要用户完成的三个步骤。`produce` 会从标题和提词识别“空间 + 持续物理声源”，不会把台词直接当作音效 prompt；它通过官方 ElevenLabs MCP 生成或安全复用 MP3，写入 prepared config 与 lock，再完成本地渲染。整个项目没有音频方向时默认走 `sound-effect`，可以省略 `--audio-kind`；一旦传 `--bgm-prompt`，必须同时明确 `--audio-kind sound-effect|music`，CLI 不猜类型。只有用户明确要求配乐、曲风、乐器或旋律时才显式传 `--audio-kind music`；音效方向只描述环境和可听声源，不复制台词。长任务使用 `--events ndjson`。
7. 只有 `produce` 唯一终态 result 同时满足以下条件才可交付：`productionGuard.policy` 为 `standard` 且 `passed=true`；`productionGuard.checks.layout.passed=true` 且设备档案/麦克风上下关系符合场景，`checks.audioIntent.kind/status/requestKey` 与本次意图一致；`scenes` 同时有 opening/content/ending 且时长合理；`media` 为 H.264/MP4、宽高/fps/总时长与 plan 一致，需要声音时有音轨；成片、prepared config、lock、音频与 manifest 正式路径真实存在。同时报告 `audio.kind`、`audio.status`；对已配置 Key 且明确要求新音效的任务，只有 `generated` 或 `reused` 可称为已生成。不要把预期路径、进度事件或临时文件当成成功结果。

## 决策规则

- 读取或修改配置前，按需阅读 [references/config.md](references/config.md)。不要复制一份完整 schema 到对话或脚本中。
- 编排单条、批量、离线 CI、断点恢复或错误恢复时，阅读 [references/workflows.md](references/workflows.md)。解析机器输出或退出码时，阅读 [references/protocol.md](references/protocol.md)。
- 默认不覆盖已有产物。只有用户明确允许替换时才加 `--force`。
- 素材路径必须存在且与槽位类型匹配。相对路径以配置文件目录为基准；配置从 stdin 传入时优先使用绝对路径。
- `plan` 的 `assets` 只表示已解析的本地文件，不是全部内置素材清单。核对内置引用时结合 `config resolve`、`assets list` 和 `assets inspect`。
- 不虚构通用远程下载、云端渲染、模板市场或第三方模板能力。`produce` 的背景音准备阶段是唯一联网步骤；其后的 `render` 只消费已经固化的本地音频。
- BGM 生成只使用随 Electron 安装的官方 ElevenLabs MCP：音乐走 `compose_music`，环境声/拟音走 `text_to_sound_effects`。凭据只从进程环境或本机 `~/.config/littlestart/secrets.env` 的 `ELEVENLABS_API_KEY` 读取；不能进入 argv、视频配置、manifest、锁文件、日志或回复。不要再走 Composio 或静默切换直连 REST。
- 整个工程的生成默认固定为 `sound-effect`，并在 prompt 中要求稳定、无缝循环、无音乐、无人声、无警报和无突发瞬态。即使题材不是机舱、街道、自然或机械，也不要自行切到 Music；只有用户明确要求配乐、曲风、乐器或旋律时才显式使用 `--audio-kind music`。
- 显式写 `--bgm-prompt` 时必须同时显式写 `--audio-kind sound-effect|music`。不要让默认值替用户解释模糊的 “BGM”，也不要根据舞台、飞机等关键词猜测类型。
- 自定义专业提词器素材应配置 `content.device.profile` 的真实宽高比和屏幕矩形；舞台构图再使用 `content.layout.preset="stage-mic-above-prompter"`。这会在渲染前验证专业设备身份和麦克风在上、提词器在下的语义关系。
- `produce` 默认执行标准成片护栏：空/占位标题与词稿、不是完整 3-2-1 或过快的倒计时、过快/无音效幕帘、被替换、过短或被静音的官方片尾都在付费请求和渲染前以 `PRODUCTION_GUARD_FAILED` 停止。只有用户明确要求非标准片头/片尾时才能使用 `--allow-custom-structure`；不得为了让错误配置通过而添加它。
- `--bgm auto` 缺 Key 时会产生 `BGM_GENERATION_SKIPPED` warning，并继续使用已有 BGM 或静音；若用户明确要求必须有新背景音频，使用 `--bgm required`。`required` 会将空 BGM 或内置模板 BGM 升级为 ElevenLabs 生成；显式本地/upload BGM 仍保留，要替换它必须另加 `--replace-bgm`。缺 Key 时 `required` 返回 `AUTH_REQUIRED`。不要把可选 Key 误报成安装失败。
- 同一背景音请求的已验证 MP3 会复用，避免渲染失败后重跑产生重复费用。音效模式只生成一次最多 5 秒的无缝素材并在正片循环，不要按成片时长拆成多次付费请求。只有用户明确要求替换已有本地 BGM 时才加 `--replace-bgm`；遇到远程失败不要并发猛试或切换 Provider。
- `--offline` 允许 `produce --bgm auto` 消费已有/内置 BGM，但跳过新背景音频生成；`--bgm required` 在没有可复用生成缓存时必须失败。
- 公开发行 CLI、向客户分发，或交付使用内置素材生成的视频前，必须审查随包 `ASSET_RIGHTS.md`；任何 `REQUIRES_CONFIRMATION` 都阻断发行。
- 不推断用户或组织已获得 Remotion 许可。需要密钥时只使用 `REMOTION_LICENSE_KEY`，不把它写入配置、manifest、锁文件、日志或回复。
- 不因一次失败就清空缓存。先按错误分类运行 `validate`、`probe`、`assets inspect` 或 `doctor`，仅在证据指向缓存问题时清理。
- 收到取消请求时让 CLI 处理信号并等待退出，不手动发布半成品。

## 机器输出

短命令使用 `--json`；渲染和批量任务使用 `--events ndjson`。stdout 只作为机器协议读取，stderr 只用于诊断。不要混用两种模式，也不要 grep 人类文案判断成功。

在自动化中保留源配置、`version`、`plan` 或锁文件、最终结果信封。安装后的 Skill 已随附 [references/protocol.md](references/protocol.md)；仍应以当前二进制的 `protocolVersion`、`help` 与 `capabilities` 为准。
