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

NDJSON 每行是一个完整事件，`event` 为 `started`、`progress`、`warning`、`result` 或 `error`；必须等到唯一终态。批处理部分失败的 `error.details` 保存逐任务 summary。

`batch --resume` 会校验任务指纹，并重算 output/cover 的大小与 SHA-256。旧 journal 缺少完整性字段或产物已被替换时不可恢复；如果不匹配的目标已存在，命令会以 `OUTPUT_EXISTS` / 退出码 `7` 失败。只在用户明确允许替换时加 `--force`。同一输出目录的整个批次由 `.littlestart-batch.lock` 串行化。

退出码：`0` 成功；`1` 内部/协议错误；`2` 命令用法；`3` 配置；`4` 素材；`5` 环境/离线依赖；`6` 渲染；`7` 输出；`10` 批量部分失败；`130` 中断；`143` 终止。自动化优先按 `error.code` 分支，并把未知新增 code 当成同一退出码类别处理。

不要解析中文 message 判断成功。诊断需要更多上下文时可临时设置 `LITTLESTART_DEBUG=1`，但不得把 stderr 混入 JSON 解析器。
