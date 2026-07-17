# 视频生产工作流

在执行单条生产、视觉 QA、批量任务、CI 或故障恢复时读取本参考。

## 单条视频

```bash
littlestart validate video.json --json
littlestart plan video.json --json
littlestart still video.json --scene all --out-dir preview
littlestart render video.json \
  --out output/video.mp4 \
  --cover output/cover.jpg \
  --events ndjson
```

执行要点：

1. 校验配置和所有本地素材后再渲染。
2. 从 plan 读取三段时长、总帧数和输出规格；其 `assets` 只是已解析的本地文件，内置引用需另结合 `config resolve` 与 `assets` 命令。发现异常先停下修配置。
3. 实际查看静帧。检查标题是否截断、文字与背景对比、幕布状态、麦克风/设备位置、屏幕裁切和片尾画面。
4. 从最终 result 获取正式产物路径与规格。若只有进度、没有 result 终态，按失败处理。

若对未锁定配置选择非默认 `--quality`、`--resolution` 或 `--fps`，`validate`、`plan` 和 `render` 必须传入完全相同的三元组。稳定流水线优先用 `config lock` 固化三元组；锁文件不允许 render/still/batch 覆盖它们。

## 纯机器流水线

短命令使用单文档 JSON：

```bash
littlestart doctor --offline --json
littlestart validate video.json --json
littlestart plan video.json --json
```

长命令使用 NDJSON：

```bash
littlestart render video.json \
  --out output/video.mp4 \
  --events ndjson > render.events.ndjson
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

之后的 validate、plan、render 或 batch 都传同一个 `--cache-dir` 与 `--offline`。doctor 会实际启动 Chromium 并创建 WebGL 上下文；离线模式仍探测，但不下载。缺少离线资源时让任务明确失败，不临时开放网络或切换成云端服务。

无 GPU 的容器或 CI 可设置 `LITTLESTART_CHROMIUM_GL=swangle`；其他本机环境默认为 `angle`。只允许 `angle` 或 `swangle`，其他值应被视为配置错误并失败，不要为了继续而改成未知值。

## 许可与素材发行

- 不推断用户或组织已获得 Remotion 许可。如果需要，只从 `REMOTION_LICENSE_KEY` 环境变量注入密钥，不在配置、manifest、锁文件、日志或回复中暴露。
- 公开发行 CLI、向客户分发，或交付使用内置素材生成的视频前，检查随包 `ASSET_RIGHTS.md`。任何 `REQUIRES_CONFIRMATION` 都阻断发行。

## 安装 Agent Skill

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
| 环境或离线资源 | 运行 `doctor --json`；获准后再 `doctor --fix` |
| 输出已存在或不可写 | 选择新路径或在获准覆盖后使用 `--force` |
| 渲染 | 保留版本、plan、错误信封和 stderr，修复根因后重试 |
| 批次部分失败 | 修复失败项后使用 `--resume` |
| 用户取消 | 等待 CLI 清理并退出，不发布临时文件 |

只有证据表明缓存损坏时才运行 `cache prune`。`cache clear --force` 是最后手段，因为它会移除已经准备好的渲染资源并增加下一次启动成本。
