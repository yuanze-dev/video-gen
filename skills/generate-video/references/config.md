# 配置与素材

只在创建、检查或修改视频配置时读取本参考。字段与范围可能随版本演进，当前二进制的 JSON Schema 是唯一权威来源。

## 先发现，再编辑

```bash
littlestart capabilities --json
littlestart config schema --json
littlestart templates list --json
littlestart templates show teleprompter@1.0.0 --json
littlestart assets list --json
```

不要把模板 id、完整字段表、格式白名单或内置素材清单硬编码到长期流水线。选择项从 `capabilities` 和列表命令读取，配置校验交给 `validate`。

## 最小补丁配置

CLI 会把输入对象深合并到所选模板的默认配置。只写用户要求改变的字段，减少版本升级时的漂移：

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

需要查看合并后的完整对象时运行：

```bash
littlestart config resolve video.json --json
```

不要用 `resolve` 的完整输出替代易读源配置，除非流水线明确要求冻结全部默认值。

## 素材引用

内置素材：

```json
{ "kind": "builtin", "id": "从 assets list 获取" }
```

本地素材：

```json
{ "kind": "file", "path": "./assets/background.jpg" }
```

规则：

- 以配置文件所在目录解析相对路径；从标准输入读取配置时优先写绝对路径。
- 让 CLI 读取文件头和媒体轨道，不根据扩展名自行断定文件有效。
- 用 `probe <文件> --json` 查看媒体元数据，用 `assets inspect <id|文件> --json` 检查素材是否适用于槽位。
- 对视频时长优先采用探测结果；只有当前格式无法提供时长且 schema 允许时才显式填写 `durationSec`。
- 不在 CLI 配置中直接写 `kind: "upload"`。它是 GUI 会话内部引用，没有对应本地文件时必须失败。
- `plan` 输出的 `assets` 只包含已解析的本地文件，不包含完整内置素材清单。核对内置引用时结合 `config resolve`、`assets list` 和 `assets inspect`。

公开发行 CLI、向客户分发，或交付使用内置素材生成的视频前，必须检查随包 `ASSET_RIGHTS.md`。其中任何 `REQUIRES_CONFIRMATION` 都是阻断性发行门禁。

## 常见改动

替换背景和 BGM：

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

把提词器内容切成视频时，不要只改 `mode`。先从 schema 确认当前 `video` 对象结构，再同时提供本地视频并决定是否保留原声。替换片尾时同理，使用 schema 中的 ending 素材槽位。

调整麦克风、设备或屏幕区域时，保持归一化坐标语义，先校验边界，再导出三段静帧进行视觉检查。不要仅凭 JSON 数值判断位置正确。

## 严格校验与迁移

```bash
littlestart validate video.json --json
littlestart plan video.json --json
```

未知字段不会被静默丢弃。按 `issues[].path` 修复拼写、范围、条件字段和素材类型。若选择非默认导出规格，必须给预检与最终渲染传入完全相同的三元组：

```bash
littlestart validate video.json --quality high --resolution 1080p --fps 60 --json
littlestart plan video.json --quality high --resolution 1080p --fps 60 --json
littlestart render video.json --quality high --resolution 1080p --fps 60 \
  --out output/video.mp4
```

当前只支持配置 v1。`config migrate` 会规范化 v1 部分配置，并明确返回 `migrated: false`；它不会假装迁移未支持版本。未来旧版本只能在当前二进制明确宣布支持后才运行迁移。

需要审计或复现时生成锁文件：

```bash
littlestart config lock video.json --quality high --resolution 1080p --fps 60 \
  --out video.lock.json
```

保存源配置、锁文件、CLI 版本和最终结果；模板或素材摘要变化后重新生成锁文件。锁文件固定模板语义摘要、本地素材摘要以及 quality、resolution 和 fps；`render` / `still` / `batch` 不能用命令行或 manifest 覆盖这三项。需要更改时从源配置重新生成锁。
