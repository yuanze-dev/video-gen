# 机器协议与退出码

短命令使用 `--json`，长渲染使用 `--events ndjson`；两者互斥。stdout 只读机器协议，stderr 只读诊断。

JSON 成功终态：

```json
{"protocolVersion":"1","ok":true,"command":"plan","result":{}}
```

JSON 失败终态：

```json
{"protocolVersion":"1","ok":false,"error":{"code":"CONFIG_INVALID","message":"...","exitCode":3}}
```

NDJSON 每行是一个完整事件，`event` 为 `started`、`progress`、`warning`、`result` 或 `error`；必须等到唯一终态。渲染 progress 会按百分比合并，不保证逐帧事件，也不要用事件数量推断总帧数。批处理部分失败的 `error.details` 保存逐任务 summary。

`batch --resume` 会校验任务指纹，并重算 output/cover 的大小与 SHA-256。旧 journal 缺少完整性字段或产物已被替换时不可恢复；如果不匹配的目标已存在，命令会以 `OUTPUT_EXISTS` / 退出码 `7` 失败。只在用户明确允许替换时加 `--force`。同一输出目录的整个批次由 `.littlestart-batch.lock` 串行化。

退出码：`0` 成功；`1` 内部/协议错误；`2` 命令用法；`3` 配置；`4` 素材；`5` 环境/离线依赖；`6` 渲染；`7` 输出；`10` 批量部分失败；`130` 中断；`143` 终止。自动化优先按 `error.code` 分支，并把未知新增 code 当成同一退出码类别处理。

一键生产的成功 `result` 包含 `scenes`、`productionGuard`、`media`、`audio`、`preparedConfig` 与 `lock`。标准交付必须看到 `productionGuard.policy="standard"`、`passed=true`、`checks.layout.passed=true`，并核对 `checks.audioIntent.kind/status/requestKey`；`scenes.opening/content/ending` 都必须存在。CLI 会在发布输出前对 `media` 的 H.264/MP4、宽高、fps、总时长和应有音轨做失败关闭验证。

`result.audio.status` 为 `generated`、`reused`、`preserved`、`disabled` 或 `skipped`。`--bgm auto` 缺 Key 时命令仍可成功，但信封包含 code 为 `BGM_GENERATION_SKIPPED` 的 warning；不要只看退出码后误称生成了新背景音频。`--bgm required` 对空或内置 fallback BGM 要求生成，缺 Key 返回 `AUTH_REQUIRED`；显式本地/upload BGM 需要 `--replace-bgm` 才会替换。

显式 `--bgm-prompt` 而没有 `--audio-kind sound-effect|music` 会在任何副作用前返回 `OPTION_CONFLICT`。`audio plan`、`audio generate` 与 `produce` 共享旁白安全提示词和 request key；相同输入在三个入口产生不同 key 应视为回归。

`PRODUCTION_GUARD_FAILED` 属于退出码 `3`，表示标题/词稿仍为空或占位文案，或标准 3-2-1 幕帘、开场音效、官方片尾及其音轨被移除/缩短/静音。该错误在凭据读取、付费请求和渲染之前发生。只有用户明确要求非标准结构时才能用 `--allow-custom-structure`。

官方 MCP 相关稳定错误都在退出码 `5`：`MCP_RUNTIME_MISSING`、`MCP_RUNTIME_FAILED`、`MCP_TOOL_MISSING`、`MCP_PROTOCOL_ERROR`、`REMOTE_REQUEST_FAILED` 与 `REMOTE_RATE_LIMITED`。它们分别表示 sidecar 不存在/不可执行、缺少所选模式需要的 `compose_music` 或 `text_to_sound_effects`、stdio/tool 结果不符合协议、供应商请求失败与限流。不要并发重试、不要静默切换 Composio 或 REST；先修复对应根因。`--offline` 下单独调用 `audio generate` 返回 `OFFLINE_RESOURCE_MISSING`。

不要解析中文 message 判断成功。诊断需要更多上下文时可临时设置 `LITTLESTART_DEBUG=1`，但不得把 stderr 混入 JSON 解析器。
