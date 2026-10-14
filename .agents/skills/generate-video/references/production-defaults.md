# 用户固定的视频生产规则

2026-10-14 用户明确要求后续飞书视频流水线采用以下默认规则。用户当次明确指定颜色或阅读时长时，遵从当次要求。

## 幕布颜色

每条新视频从以下绒布配色中随机选一个：深海蓝 `#234E70`、孔雀绿 `#24645E`、酒红 `#793D52`、烟紫 `#625078`、赤陶 `#985B46`、松绿 `#3C604E`。配色避开荧光色与过浅颜色，保持白色标题清晰。只写 `opening.curtain.color`；保留标准幕布动画、开场音效和完整 3-2-1。选择一次后写入该条源配置和生产记录，重试直接使用保存的配置，不再随机。若源配置显式指定颜色，则保留它。

## 正文阅读时间

正文滚动总时长默认增加 **4 秒**：依据当前 `plan` 的正文时长，按 `新速度 = 原速度 × 原正文秒数 / (原正文秒数 + 4)` 放慢整个正文滚动。这是连续、匀速地增加阅读时间，最后几行也会更慢地滚过；不能通过延长官方片尾或空白画面冒充。完整保留最后一行滚出后进入官方片尾的行为。

## 一次准备，随后生产

先创建包含真实标题、完整词稿、背景素材、字号和原速度的 `source.json`，然后执行本 skill 自带的脚本（路径相对于 skill 目录）：

```sh
node scripts/prepare-production.mjs /absolute/path/source.json \
  --out /absolute/path/video.json --extra-seconds 4
```

源码项目的 CLI 不在 PATH 时，加 `--cli /absolute/path/video-gen/scripts/cli.mjs`。脚本只调用离线 `config resolve` 和 `plan`，不生图、不生成音频、不扣费；检查调整后的正文实际帧数增加 4 秒，片头片尾帧数保持一致，并保存 `video.json.production-policy.json`。输出必须与源配置同目录。输出已存在会拒绝再次准备；后续恢复、重试直接使用 `video.json`，避免再次减速或重新抽色。非默认导出规格需给脚本、validate、plan 和 produce 使用相同选项；still 只接受 quality/resolution，fps 从配置或锁文件继承，不传 --fps。

触及 6 秒/600 秒时长边界、速度超出 0.3..3 或非文字模式时，脚本如实停止，先调整源配置，不绕过 schema 或成片护栏。准备完成后照常 validate → plan → still → produce；实际查看正文中后段及 `--progress 1` 的无词稿末帧。

在本机源码项目生产新音频时，设置 `LITTLESTART_SOURCE_ROOT` 为项目根目录，以使用已验证的 pinned ElevenLabs MCP；不要静默回退到损坏的 uvx 环境或改用 REST。

## 飞书入口

原工作表为 `FlowPrompter Reddit 记录 / 视频素材`，Base `E00pbaYnJazjYUsThQ4coTwEn1r`、Table `tblcTb4fnnABHo4N`、Grid `vewhE9YtEQ`。每次读取实时 schema，按该视图顺序筛选 `origin` 非空、`Video` 为空。截图只包含部分词稿时，读取 `original link` 的原视频核对全部内容，不猜剩余词稿。附件下载/成片回传使用 lark-base 附件专用 shortcut。用户要求先一条时，只生产并回传第一条，等用户评价后再批量。
