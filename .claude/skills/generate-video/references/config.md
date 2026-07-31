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

标准一键成片中，用户未明确要求改结构时，最小补丁不得包含 `opening.countdown`、`opening.curtain` 或 `ending`。这些字段由当前模板提供完整 3-2-1 幕帘、开场音效以及保留音轨的 FlowPrompter 片尾。`init --minimal` 生成的中文标题/词稿是占位文案，必须替换后才能 `produce`。

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

完整视频默认让 `produce` 一次完成 BGM 规划、生成、配置落盘、锁定和渲染，不要让用户手工拼音视频：

```bash
littlestart produce video.json \
  --bgm auto \
  --out output/video.mp4 \
  --prepared-config output/video.prepared.json \
  --lock output/video.lock.json \
  --events ndjson
```

整个项目省略 `--audio-kind` 时默认使用 `sound-effect`。CLI 从标题和提词文案推断环境的持续物理声源，但不会复制或截断对白当作音效内容；它自动追加稳定、连续、旁白友好、无音乐/人声/广播/警报/突发瞬态等约束，只生成一次 0.5–5 秒的无缝 MP3 并在正片循环：

```bash
littlestart produce video.json \
  --bgm auto \
  --out output/video.mp4 \
  --events ndjson
```

只有用户给出更具体的环境音方向时才需要 `--bgm-prompt`；内容必须是“空间 + 持续声源”，例如 `modern aircraft cockpit ambience with turbofan hum, ventilation and avionics fans`，不能是台词、故事事件或报警指令。一旦写 `--bgm-prompt`，必须同时写 `--audio-kind sound-effect`；CLI 不根据文案猜类型。

只有用户明确要求配乐、曲风、乐器或旋律时才显式使用 Music；不能因题材或模糊的“BGM”一词自行切换：

```bash
littlestart produce video.json \
  --bgm auto \
  --audio-kind music \
  --bgm-prompt "warm minimal acoustic texture with gentle optimism" \
  --out output/video.mp4 \
  --events ndjson
```

默认音效 prompt 应描述稳定的声音来源与空间，并排除音乐、人声、广播、警报和突发瞬态。CLI 通过 `text_to_sound_effects` 生成一次 0.5–5 秒的无缝 MP3，再在正片中循环；不要为了覆盖长视频发起多次生成。显式 Music 通过 `compose_music` 生成，并追加纯器乐、旁白留白、低到中等能量、可循环结尾和不模仿可识别作品等约束。凭据只从 `ELEVENLABS_API_KEY` 或 `~/.config/littlestart/secrets.env` 读取。密钥不能写入 argv、配置、manifest、锁文件、日志或回复。不要使用 Composio 或直连 REST 作为隐式后备。

同一 request key 的 MP3 与 manifest 会先经过摘要、时长和音轨校验；命中后即使缺 Key 或离线也能复用，避免重跑重复扣费。没有可复用缓存时，`--bgm auto` 缺 Key 会保留现有 BGM 或静音继续渲染，并在最终信封返回 warning；`--bgm required` 对空 BGM 或内置模板 BGM 都是生成候选，缺 Key 时零写入失败。已有本地/上传 BGM 默认保留，只有明确要求替换时才加 `--replace-bgm`；该选项表示强制生成意图，无可复用缓存且缺 Key 或离线时必须失败，不能悄悄保留旧 BGM。音乐生成时长限制为 3–600 秒；音效生成时长限制为 0.5–5 秒并默认循环覆盖更长正片。

`audio plan` / `audio generate` 保留给诊断和高级自动化；它们不是最终用户的一键视频主路径。若单独使用，仍必须由调用方把 result 的 `configPatch` 接入配置后再渲染。三条音频路径共用同一套旁白安全提示词拼装，因此相同配置、方向、类型、时长和音量必须产生相同 request key。

## 专业提词器设备档案

自定义设备素材不能只换 `content.device.asset` 后继续沿用手机的几何假设。专业舞台提词器应同时写入设备档案和布局契约：

```json
{
  "content": {
    "mic": {
      "transform": { "x": 0.82, "y": 0.17, "scale": 1.25, "rotation": -30 }
    },
    "device": {
      "asset": { "kind": "file", "path": "./assets/pro-stage-teleprompter.png" },
      "transform": { "x": 0.5, "y": 0.58, "scale": 1.05 },
      "profile": {
        "id": "award-stage-prompter-v1",
        "kind": "professional-teleprompter",
        "aspectRatio": 1.3578,
        "screen": { "x": 0.196, "y": 0.14, "w": 0.606, "h": 0.314 }
      }
    },
    "layout": {
      "preset": "stage-mic-above-prompter",
      "minimumVerticalSeparation": 0.05
    }
  }
}
```

`profile.screen` 是相对设备素材外框的 0..1 矩形，并优先于旧的 `teleprompter.screen`；`aspectRatio` 是素材高度除以宽度。舞台 preset 会要求档案类型确实是专业提词器，并在 `validate` 阶段拒绝“麦克风在下、提词器在上”或间距不足的配置。它不阻止有意的边缘裁切和旋转，所以仍必须实际查看静帧。

把提词器内容切成视频时，不要只改 `mode`。先从 schema 确认当前 `video` 对象结构，再同时提供本地视频并决定是否保留原声。标准一键生产不得替换片尾；只有用户明确要求自定义片尾时，才使用 schema 中的 ending 素材槽位并在 `produce` 上加 `--allow-custom-structure`，且必须实际检查其完整时长和首中末画面。

调整麦克风、设备或屏幕区域时，保持归一化坐标语义，先校验边界，再导出三段静帧进行视觉检查。`still --scene content` 默认避开入场透明帧；检查滚动中段可加 `--progress 0.5`。不要仅凭 JSON 数值判断位置正确。

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
