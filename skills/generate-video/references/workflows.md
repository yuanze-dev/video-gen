# 视频生产工作流

在执行单条生产、视觉 QA、批量任务、CI 或故障恢复时读取本参考。

## 单条视频

先做本地预检和视觉检查，再用一条生产命令完成自动背景音与成片。源配置必须是最小补丁：用户没有明确要求改结构时，禁止写 `opening.countdown`、`opening.curtain` 或 `ending`。`produce` 会从标题与词稿推断环境和持续物理声源，不复制对白；省略 `--audio-kind` 时默认调用官方 ElevenLabs MCP 的 `text_to_sound_effects`，只有显式 `--audio-kind music` 才调用 `compose_music`。随后验证并持久化 MP3/manifest，把背景音写入 prepared config，生成 lock，最后用 lock 渲染并验收成片。不允许把中间拼装步骤推给用户。

```bash
littlestart validate video.json --json
littlestart plan video.json --json
littlestart still video.json --scene all --out-dir preview
littlestart produce video.json \
  --bgm auto \
  --out output/video.mp4 \
  --cover output/cover.jpg \
  --events ndjson
```

执行要点：

1. 校验配置和所有本地素材后再渲染。
2. 从 plan 读取三段时长、总帧数和输出规格；标准结构必须有 opening/content/ending，opening 至少 1.4 秒，ending 至少 1 秒。其 `assets` 只是已解析的本地文件，内置引用需另结合 `config resolve` 与 `assets` 命令。发现异常先停下修配置。
3. 实际查看静帧。内容段默认选择设备入场稳定后的代表帧；要检查滚动中段或末段时用 `--progress 0.5` 或 `--progress 1`。检查标题是否截断、文字与背景对比、幕帘、麦克风/设备位置、屏幕裁切和片尾画面。`still --scene all` 是预检而不是成片证明；最终仍以 `produce` 对编码后 MP4 的规格/时长/音轨验收和发布包的连续帧回归门禁为准。
4. 从唯一最终 result 获取成片、prepared config、lock、音频/manifest 路径与 `audio.status`。必须断言 `productionGuard.policy="standard"`、`passed=true`、`checks.layout.passed=true`，并核对 `checks.audioIntent.kind/status/requestKey` 与本次意图一致；`scenes` 三段齐全，`media` 的 H.264/MP4、宽高、fps、总时长与 plan 相符，需要声音时 `audioCodec` 非空。若只有进度、没有 result 终态，按失败处理。

没有自定义方向时默认不传 `--audio-kind`，CLI 走音效生成并追加稳定无缝循环、无音乐/人声/警报/突发瞬态约束，只生成一次最多 5 秒的循环素材。默认提示词会从画面/词稿识别声源；例如航空内容使用涡扇低鸣、通风、航电风扇和机身共鸣，而不使用 Mayday 对白、警报或剧情化声音。一旦传 `--bgm-prompt`，必须同时明确 `--audio-kind sound-effect|music`；CLI 不猜类型。只有用户明确给出配乐、曲风、乐器或旋律要求时才选择 Music，并追加纯器乐与旁白留白约束。只有明确要求必须新生成背景音时使用 `--bgm required`；它会为空 BGM 或内置 fallback 生成，显式本地/upload BGM 仍保留，要替换时再加 `--replace-bgm`。Key 只从环境或本机 secrets.env 读取。相同 request key 的已验证音频会在凭据与离线检查之前复用；`audio plan`、`audio generate` 与 `produce` 对相同输入使用同一 request key。未命中时，`auto` 缺 Key 会带 warning 使用现有 BGM/静音继续，`required` 或 `--replace-bgm` 缺 Key/离线时失败，不能悄悄保留旧 BGM。

若对未锁定配置选择非默认 `--quality`、`--resolution` 或 `--fps`，`validate`、`plan` 和 `produce` 必须传入完全相同的三元组。

## 纯机器流水线

短命令使用单文档 JSON：

```bash
littlestart doctor --offline --json
littlestart doctor --audio --offline --json
littlestart validate video.json --json
littlestart plan video.json --json
```

长命令使用 NDJSON：

```bash
littlestart produce video.json \
  --bgm auto \
  --out output/video.mp4 \
  --events ndjson > produce.events.ndjson
```

同时检查进程退出码和终态信封。把 stdout 当协议流，把 stderr 当诊断流。容忍未知附加字段；遇到不支持的 `protocolVersion` 时停止并升级消费者。

建议保存：源配置、`version --json`、`capabilities --json` 的版本快照、plan 或 config lock、最终 result/error，以及用于恢复的批次状态。

## 批量生产与恢复

先从当前版本读取批次格式和选项：

```bash
littlestart help batch
littlestart capabilities --json
```

再运行：

```bash
littlestart batch batch.json \
  --out-dir output \
  --jobs 2 \
  --resume \
  --events ndjson > batch.events.ndjson
```

- 让 batch 做全量预检，不用外部循环绕过预检。
- 根据机器、磁盘和视频复杂度设置保守并发；不要把 `--jobs` 设成 CPU 核数后直接假设稳定。
- 部分失败时读取逐任务错误，修复源配置或素材后用 `--resume` 继续。
- 断点恢复依赖配置、本地素材字节、manifest/有效导出选项和 runtime 摘要，并重算 output/cover 的大小与 SHA-256。不要用“目标文件存在”代替成功判定。
- 旧 journal 没有产物完整性记录时不可恢复。目标已存在但与 journal 不匹配时会失败；只在用户确认覆盖后加 `--force`。
- 同一 `--out-dir` 通过 `.littlestart-batch.lock` 串行化整个批次。外部调度器仍不应并发启动多个写者。

## 离线 CI

在联网的准备阶段运行 `doctor --fix --cache-dir .cache/littlestart`，把该精确目录持久化。执行阶段固定相同 CLI 版本并检查：

```bash
littlestart doctor --offline --cache-dir .cache/littlestart --json
```

之后的 validate、plan、render 或 batch 都传同一个 `--cache-dir` 与 `--offline`。doctor 会实际启动 Chromium 并创建 WebGL 上下文；`doctor --audio` 还会在本地执行 MCP initialize 与 tools/list，但不会调用生成工具。离线模式仍探测已安装资源，但不下载。缺少离线资源时让任务明确失败，不临时开放网络或切换成云端服务。

无 GPU 的容器或 CI 可设置 `LITTLESTART_CHROMIUM_GL=swangle`；其他本机环境默认为 `angle`。只允许 `angle` 或 `swangle`，其他值应被视为配置错误并失败，不要为了继续而改成未知值。

## 许可与素材发行

- 不推断用户或组织已获得 Remotion 许可。如果需要，只从 `REMOTION_LICENSE_KEY` 环境变量注入密钥，不在配置、manifest、锁文件、日志或回复中暴露。
- 公开发行 CLI、向客户分发，或交付使用内置素材生成的视频前，检查随包 `ASSET_RIGHTS.md`。任何 `REQUIRES_CONFIRMATION` 都阻断发行。

## Agent Skill 安装与修复

Electron 客户端的“安装或修复 CLI”会在同一本地事务中安装 CLI、ElevenLabs MCP 启动器，并把该 Skill 部署到 Codex 和 Claude 用户目录。无需让用户再手动跑第二条命令。发现未受管或已被用户修改的同名 Skill 时，安装必须保留用户内容并明确报告冲突，不得覆盖或部分安装。

以下命令仅供诊断、开发或客户端外的手动修复：

```bash
littlestart skill install
```

完整形式：

```text
littlestart skill install [--target codex|claude|both] [--scope project|user] [--force]
```

默认安装到当前项目的 Codex 与 Claude Code Skill 目录。需要用户级复用时指定 `--scope user`；已存在内容默认不覆盖，只有确认替换时使用 `--force`。参数变化时运行 `littlestart help skill install` 获取当前语法。

## 分层排错

按错误类别处理，不盲目重试：

| 类别 | 首选动作 |
|---|---|
| 命令或选项 | 运行 `help <命令>`，修正调用 |
| 配置 | 运行 `validate --json`，按 `issues[].path` 修复 |
| 本地素材 | 运行 `probe` 或 `assets inspect`，检查路径、内容和槽位 |
| ElevenLabs 未配置 | `auto` 查看 warning 和 fallback；`required` 时在 Electron 或 secrets.env 填 Key |
| MCP runtime / tool | 先运行 `doctor --audio --json`；再从 Electron 修复 CLI/MCP 安装，确认 bundled sidecar 以及 `compose_music` / `text_to_sound_effects` |
| 远程音频限流 | 按 Retry-After 退避，复用 request key，避免并发重试或切换 Provider |
| 环境或离线资源 | 运行 `doctor --json`；获准后再 `doctor --fix` |
| 输出已存在或不可写 | 选择新路径或在获准覆盖后使用 `--force` |
| 渲染 | 保留版本、plan、错误信封和 stderr，修复根因后重试 |
| 批次部分失败 | 修复失败项后使用 `--resume` |
| 用户取消 | 等待 CLI 清理并退出，不发布临时文件 |

只有证据表明缓存损坏时才运行 `cache prune`。`cache clear --force` 是最后手段，因为它会移除已经准备好的渲染资源并增加下一次启动成本。
