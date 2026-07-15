---
name: generate-video
description: 用本地 CLI 生成"小音符起号助手"的提词器视频（1080x1920 竖屏 MP4），无需打开 GUI。当用户要求生成/渲染/导出提词器视频，或要修改视频元素（标题、词稿、颜色、背景图、背景音乐、倒计时、幕布、麦克风/设备位置、片尾视频）并出片时使用。触发词：生成视频、出个视频、渲染、出一版、改词稿、换背景、换 BGM、换音乐、改标题、改颜色、换片尾。
---

# 本地视频生成（AI 调用入口）

这个仓库的视频是一个三段固定模板：**开场 `opening`（粉色幕布 + 标题 + 倒计时）→ 正片 `content`（背景场景里的手持提词器手机滚动词稿，可配麦克风、背景音乐）→ 片尾 `ending`（默认 FlowPrompter 内置视频，保留原声）**。所有元素由一份 JSON 配置驱动，CLI 在本机渲染出 MP4；片尾始终存在，但可替换为另一段完整视频。

## 工作流程

1. **写配置**：按用户要求写一份*部分* JSON 配置（改哪写哪，未写字段用默认值），存到项目里或用户指定的位置，如 `output/my-video.json`。
2. **校验**：`node scripts/cli.mjs validate 配置.json` — 检查字段并返回三段时长预估（stdout 是 JSON）。
3. **渲染**：`node scripts/cli.mjs render 配置.json --out output/名字.mp4`
4. **报告**：把 stdout JSON 里的输出路径、时长、文件大小告诉用户。

命令必须在项目根目录运行（`package.json` 所在目录）。也可以用 `npm run cli -- render …`。

## 命令参考

```bash
node scripts/cli.mjs render <配置.json> [--out 视频.mp4] [--cover 封面.jpg] \
  [--quality high|standard|small] [--resolution 1080p|720p] [--fps 30|60] [--rebuild]
node scripts/cli.mjs validate <配置.json>   # 校验 + 时长预估
node scripts/cli.mjs init [路径]            # 导出完整默认配置（看全部字段用）
node scripts/cli.mjs assets                 # 列出内置素材
```

- 进度和日志走 stderr；`render` 的最终结果是 stdout 上的一段 JSON（`ok/output/cover/durationSec/sizeBytes/quality/resolution/fps`）。
- `validate` 返回 `ok/durationSec/openingSec/contentSec/endingSec/localFiles/canvas`；`assets` 返回 `ok/builtin`，其中每项包含 `id/type/usage/desc`。
- 渲染耗时大约与视频时长同量级；首次运行会自动下载无头 Chromium，首次/源码变更后会多花 10~30 秒打包合成站点（有缓存）。

## 素材引用（三种写法）

```jsonc
{ "kind": "builtin", "id": "airport" }          // 内置素材
{ "kind": "file", "path": "./bg.jpg" }          // 本地文件，路径相对配置文件所在目录
{ "kind": "file", "path": "/绝对/路径/music.mp3" }
```

内置素材：`airport`（机场背景图）、`mic`（麦克风图）、`phone`（提词器手机图）、`open-sfx`（开场音效）、`airport-bgm`（机场广播 BGM）、`flowprompter-outro`（FlowPrompter 默认片尾，使用位置 `ending.video.asset`）。

支持的本地格式 — 图片: jpg/png/webp/gif；音频: mp3/wav/m4a/aac/ogg/flac；视频: mp4/mov/webm/m4v。文件类型和槽位不匹配（比如给背景传了 mp3）会在校验时报错。

## 配置字段速查

配置会**深合并**到默认配置上，所以只写要改的字段。坐标一律是 0..1 归一化（相对 1080x1920 画布，`pos`/`x`/`y` 是元素中心点）。

```jsonc
{
  "opening": {
    "title": {
      "text": "标题文字（支持 \n 换行）",   // 常改
      "fontSize": 92,                        // 画布像素
      "color": "#ffffff",
      "stroke": true,                        // 黑色描边
      "pos": { "x": 0.5, "y": 0.24 }
    },
    "countdown": {
      "enabled": true,
      "from": 3,                             // 从几开始倒数（1-10）
      "speed": 2,                            // 每秒跳几个数（0.5-3）
      "fontSize": 170,
      "pos": { "x": 0.5, "y": 0.39 }
    },
    "curtain": {
      "color": "#d11069",                    // 幕布颜色，常改
      "openDurationSec": 1.4,                // 拉开耗时（0.4-4）
      "sfx": { "kind": "builtin", "id": "open-sfx" }   // 可设 null 关掉音效
    }
  },
  "content": {
    "background": { "kind": "file", "path": "./bg.jpg" },   // 背景图，常改
    "mic":    { "asset": {…}, "transform": { "x": 0.9, "y": 0.09, "scale": 1.43, "rotation": 0, "flipH": false, "flipV": true } },
    "device": { "asset": {…}, "transform": { "x": 0.58, "y": 0.7, "scale": 1.04, "rotation": 0, "flipH": false, "flipV": false } },
    "teleprompter": {
      "mode": "text",                        // "text" 滚动词稿 | "video" 播放视频
      "screen": { "x": 0.1258, "y": 0.03, "w": 0.5534, "h": 0.8516 },  // 屏幕区域，用内置手机图时别动
      "text": {
        "content": "词稿正文……（开头留几个 \n 让文字从屏幕下方滚入）",  // 最常改
        "fontSize": 60,
        "color": "#ffffff",
        "bgColor": "#000000",
        "align": "left",                     // left | center
        "speed": 0.7                         // 滚动速度倍率（0.3-3），决定视频长度
      },
      "video": { "asset": { "kind": "file", "path": "./录屏.mp4" }, "keepAudio": true }  // mode=video 时用
    },
    "bgm": { "asset": { "kind": "file", "path": "./music.mp3" }, "volume": 0.8 }  // 设 null 关掉 BGM
  },
  "ending": {
    "video": {
      "asset": { "kind": "builtin", "id": "flowprompter-outro", "durationSec": 2.227664 },
      "keepAudio": true
    }
  }
}
```

**时长是自动算的**：开场 = 倒计时秒数 ÷ speed；正文 = 词稿滚完所需时间（文字越长/速度越慢视频越长，6~600 秒封顶），`mode: "video"` 时 = 视频时长；片尾 = `ending.video.asset.durationSec`。三段分别对齐到帧后相加，`validate` 会同时给出 `openingSec/contentSec/endingSec/durationSec`。本地视频的时长会自动探测，也可在 `asset` 上手动指定 `durationSec`。

## 常见配方

**改词稿 + 标题出一版**（最常见，其余全默认）：

```json
{
  "opening": { "title": { "text": "新标题" } },
  "content": { "teleprompter": { "text": { "content": "\n\n\n\n新的词稿正文……" } } }
}
```

**换背景图 + 换音乐 + 改幕布颜色**：

```json
{
  "opening": { "curtain": { "color": "#1e40af" } },
  "content": {
    "background": { "kind": "file", "path": "./咖啡馆.jpg" },
    "bgm": { "asset": { "kind": "file", "path": "./轻音乐.mp3" }, "volume": 0.6 }
  }
}
```

**提词器里放自己的视频**（时长自动探测）：

```json
{
  "content": {
    "teleprompter": {
      "mode": "video",
      "video": { "asset": { "kind": "file", "path": "./口播.mp4" }, "keepAudio": true }
    },
    "bgm": null
  }
}
```

**替换默认片尾**（整段替换，时长自动探测并保留原声）：

```json
{
  "ending": {
    "video": {
      "asset": { "kind": "file", "path": "./my-outro.mp4" },
      "keepAudio": true
    }
  }
}
```

## 注意事项

- 词稿开头留 4 个左右 `\n`，让首行从屏幕内滚起（默认配置就是这么做的）。
- 换了自定义设备图才需要调 `screen`；用内置 `phone` 图时保持默认。
- 渲染失败先跑 `validate` 看报错；报错信息是中文的、按字段定位。
- 没有写 `ending` 时会自动使用内置 `flowprompter-outro`；正片 BGM 只覆盖 `content`，片尾默认播放自身原声。
- 用户没说输出路径时，默认放到 `output/`，文件名用内容起（如 `output/口语练习-0710.mp4`）。
- 批量出片：写多份配置循环调用 render 即可，bundle 和浏览器会复用缓存。
