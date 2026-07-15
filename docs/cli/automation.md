# Littlestart 自动化协议

本文面向调用 `littlestart` 的 Agent、Shell 脚本和 CI。协议版本与当前命令能力应始终从 `version --json` 和 `capabilities --json` 读取。

## 输出通道

| 模式 | stdout | stderr | 适用场景 |
|---|---|---|---|
| 默认人类模式 | 最终可读结果 | 日志、进度、警告和错误 | 人工终端 |
| `--json` | 一个最终 JSON 信封 | 日志、进度和错误摘要 | 短命令、CI 步骤 |
| `--events ndjson` | 每行一个事件 | 非必要的人类诊断 | 长渲染、批处理、实时 UI |

不要混用 `--json` 与 `--events ndjson`，不要从 stderr 文案推断成功，也不要只检查输出文件是否存在。

## JSON 信封

成功：

```json
{
  "protocolVersion": "1",
  "ok": true,
  "command": "plan",
  "result": {}
}
```

失败：

```json
{
  "protocolVersion": "1",
  "ok": false,
  "command": "validate",
  "error": {
    "code": "CONFIG_INVALID",
    "message": "配置校验失败",
    "exitCode": 3,
    "issues": [
      {
        "path": "content.teleprompter.text.speed",
        "message": "提词滚动速度不能小于 0.3"
      }
    ],
    "hint": "修复配置后重新运行 validate。"
  }
}
```

调用方应容忍信封中新增字段，但不得忽略 `protocolVersion` 的不兼容变化。`result` 的命令专属结构应通过 `capabilities`、命令帮助和实际版本的测试夹具确认。

## NDJSON 事件

每一行都是可独立解析的 JSON 对象：

```json
{"protocolVersion":"1","sequence":1,"timestamp":"2026-07-15T00:00:00.000Z","event":"started","command":"render","data":{}}
{"protocolVersion":"1","sequence":2,"timestamp":"2026-07-15T00:00:01.000Z","event":"progress","command":"render","data":{"ratio":0.25,"percent":25,"stage":"render"}}
{"protocolVersion":"1","sequence":3,"timestamp":"2026-07-15T00:00:04.000Z","event":"result","command":"render","data":{"protocolVersion":"1","ok":true,"command":"render","result":{}}}
```

消费规则：

1. 按 `sequence` 处理事件；同一进程内序号单调递增。
2. 以 `result` 或 `error` 作为唯一终态；收到终态后不应再期待事件。
3. `progress.data.ratio` 是 0 到 1，`percent` 仅用于显示。
4. 将未知事件或未知 data 字段记录下来并忽略，避免新增字段破坏旧消费者。
5. 流结束但没有终态时视为调用失败，即使已有目标路径。

## 退出码

| 退出码 | 分类 | 建议动作 |
|---:|---|---|
| `0` | 成功 | 接受最终结果 |
| `1` | 内部或协议错误 | 保存日志和版本，报告缺陷 |
| `2` | 命令用法错误 | 修正命令和选项，不重试 |
| `3` | 配置错误 | 按字段问题修复配置 |
| `4` | 素材错误 | 检查路径、格式、媒体内容和槽位 |
| `5` | 环境错误 | 运行 doctor；准备依赖后再试 |
| `6` | 渲染错误 | 保留诊断，修复原因后重试 |
| `7` | 输出错误 | 检查目录、权限和覆盖策略 |
| `10` | 批次部分失败 | 读取逐任务状态，修复后 `--resume` |
| `130` | SIGINT / 取消 | 由调度器决定是否恢复 |
| `143` | SIGTERM | 由调度器决定是否恢复 |

错误类别会通过稳定的 `error.code` 进一步细分。新增错误 code 不一定提升协议主版本，因此消费者应按退出码提供保底分支。

## 推荐调用模式

短命令：

```bash
if ! littlestart validate video.json --json > validate.json; then
  # 解析 validate.json 的 error，而不是 grep 日志
  exit 1
fi
```

长命令：

```bash
littlestart render video.json \
  --out output/video.mp4 \
  --events ndjson \
  > render.events.ndjson
status=$?
test "$status" -eq 0
```

生产流水线推荐顺序为 `doctor --offline` → `validate` → `plan` → 可选静帧审查 → `render`。先在联网准备阶段执行 `doctor --fix --cache-dir <dir>`，再把同一目录持久化给离线执行环境；离线 doctor 与后续 render/batch 都传相同的 `--cache-dir <dir> --offline`。不要在每次任务前清空缓存。

## 导出计划与锁文件

- 对未锁定的源配置选择了非默认规格时，必须给 `validate`、`plan` 和 `render` 传入完全相同的 `--quality`、`--resolution` 和 `--fps`；否则预检的不是最终产物。
- 稳定流水线应用 `config lock` 固化完整配置、模板语义摘要、本地素材摘要和导出三元组。`render` / `still` / `batch` 会拒绝用命令行或 manifest 覆盖锁文件中的导出规格。
- `plan` 结果中的 `assets` 是已解析的本地文件素材，不是全部内置素材清单。审计内置引用时结合 `config resolve`、`assets list` 和 `assets inspect`。

## 幂等、覆盖与取消

- 正式输出默认不覆盖。只有业务上确认替换时才传 `--force`。
- 渲染使用临时产物并在成功后原子提交。调用方只接受终态结果中报告的路径。
- `batch --resume` 依据配置、本地素材字节、manifest/有效导出选项和 runtime 摘要恢复，并重算 output/cover 的大小与 SHA-256；外部调度器不要用 `test -f` 替代它。
- 旧 journal 没有产物完整性记录时不可恢复。已存在但与 journal 不匹配的输出会导致 `OUTPUT_EXISTS`；只在业务确认覆盖后使用 `--force`。
- 同一 `--out-dir` 使用 `.littlestart-batch.lock` 串行化整个批次。调度器仍应避免并发启动多个写者。
- 收到取消信号后等待 CLI 退出。不要并发启动另一个任务写同一路径。
- 将源配置、CLI 版本、模板标识、锁文件和最终机器结果一起留档，便于复现。

## 环境、缓存与离线边界

- `doctor` 会实际启动 Chromium 并创建 WebGL 上下文。`doctor --offline` 仍执行该探测，但绝不下载缺失资源。
- `doctor` 与渲染共享 `LITTLESTART_CHROMIUM_GL`：默认 `angle`，无 GPU 容器可显式使用 `swangle`（ANGLE + SwiftShader）。其他值会返回 `INVALID_OPTION_VALUE`，不会静默回退。
- 设置 `REMOTION_BROWSER_EXECUTABLE` 时，`doctor` 与渲染会优先使用同一个经过存在性、文件类型和执行权限校验的真实路径。无效的自定义路径不会触发自动下载。
- `cache prune` 只清除过期的 partial/rebuild 临时条目；`cache clear --force` 才清空整个缓存。缓存写入、prune 和 clear 共享维护锁。
- 离线任务缺少精确浏览器或 runtime 缓存时应明确失败，不得临时开放网络或切换云端渲染。

## 许可与素材发行门禁

CLI 为 `UNLICENSED`，使用 Remotion 特殊许可。负责发行或部署的组织必须自行确认资格，并在需要时仅通过 `REMOTION_LICENSE_KEY` 注入密钥。不要把密钥写进配置、manifest、锁文件或日志。

公开发行 CLI、向客户分发，或交付使用内置素材生成的视频前，必须审查随包 `ASSET_RIGHTS.md`。任何 `REQUIRES_CONFIRMATION` 都是阻断性发行门禁。当前已识别的第三方说明见 `THIRD_PARTY_NOTICES.md`；正式发行仍需基于锁文件完成 SBOM 和许可审查。
