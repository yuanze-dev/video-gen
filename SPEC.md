# 提词秀 · 竖屏视频生成器 — 工程 Spec

> 内部工具。把"机场提词器/开幕"这套竖屏短视频做成填空式模板：用户填几项内容、在预览里拖两个素材，点导出即得一条 1080×1920 MP4。

---

## 1. 目标与非目标

**目标**
- 一屏完成：左配置 + 右竖屏实时预览，所见即所得。
- 两幕结构：① 开场（幕布 + 标题 + 倒计时 + 音效）→ ② 正片（背景 + 麦克风 + 提词设备 + 提词内容 + 背景音乐）。
- 提词内容两种模式：文字（提词器匀速上滚）/ 视频（在设备屏幕区内播放，保留原声）。
- 麦克风、提词设备可在预览上直接拖拽 / 缩放。
- 导出无水印 MP4，预览与成片像素级一致。

**非目标（明确不做）**
- 不做任何商业化：无套餐、无配额、无付费、无水印。
- 不做账号体系 / 登录（默认内网信任环境，见 §11 假设）。
- 不做自由画布 / 图层树 / 多轨时间轴 / 关键帧。版式写死，只开放内容与两个素材的摆位。
- 不做多人协作、不做模板市场。

---

## 2. 关键决策（已与产品确认）

| 决策 | 结论 |
|---|---|
| 渲染形态 | 本地实时预览（Remotion Player）+ 云端高清导出（同一套合成组件） |
| 编辑形态 | 固定模板 + 局部可拖拽（仅麦克风 / 提词设备） |
| 视频时长 | 由内容自动决定（见 §6 时长公式），用户用"滚动速度"间接调 |
| 提词视频模式 | 在提词设备的"屏幕区"内播放，保留原声 |
| 幕布 | 前端代码生成（SVG/CSS 渐变 + frame 驱动），**非**素材视频（见 §7） |
| 幕布素材形态 | 不再需要用户上传透明视频；改为内置可调的代码幕布 |
| 提词文字区 | 独立于设备素材的矩形蒙版，与设备解耦 |
| 默认素材 | 内置一套（麦克风 / 手+手机 / 机场背景 / 开屏音效），用户可逐个替换 |

> 注：早期"幕布=透明视频上传"的方案已废弃，改为代码生成（见 §7 调研结论）。

---

## 3. 技术栈

- **框架**：Next.js（App Router）+ TypeScript
- **UI 组件**：shadcn/ui（Radix + Tailwind）
- **视频合成/渲染**：[Remotion](https://www.remotion.dev) — `remotion` + `@remotion/player`（预览）+ `@remotion/renderer`（导出）
- **校验**：zod（配置 schema + 上传校验）
- **状态**：React 状态 + 轻量 store（Zustand 或 React Context，单页足够）
- **渲染服务**：Node 服务（容器化），跑 `@remotion/renderer`

---

## 4. 架构总览

```
┌──────────────────────── Browser (Next.js) ────────────────────────┐
│  Editor 壳                                                          │
│  ┌── 左：配置表单（shadcn） ──┐   ┌── 右：预览 ──────────────────┐ │
│  │  开场 / 正片 字段           │   │  <Player/>  ← 同一套合成组件  │ │
│  │  写入 ProjectConfig         │──▶│  叠加：拖拽/缩放交互层        │ │
│  └────────────────────────────┘   └──────────────────────────────┘ │
│        │ ProjectConfig (单一数据源)            ▲ 读 transform 回写    │
│        │ 素材：File → blob: URL（仅预览用）                          │
└────────┼────────────────────────────────────────────────────────────┘
         │  导出：POST /api/render  (ProjectConfig + 素材 multipart)
         ▼
┌──────────────────── Render Service (Node 容器) ───────────────────┐
│  接收配置+素材 → 写临时目录 → bundle + renderMedia()                │
│  同一套 Remotion 合成组件 → 输出 MP4 → 返回下载 URL / 流            │
│  job 队列 + 进度（onProgress），前端轮询                            │
└────────────────────────────────────────────────────────────────────┘
```

**核心原则**：编辑器预览和导出渲染**复用同一个 Remotion 合成组件**（`/remotion` 下），靠 `useCurrentFrame()` 驱动所有动画，保证两端一致。这是选 Remotion 的根本理由。

---

## 5. 数据模型（单一数据源）

所有空间坐标用**归一化值（0–1，相对画布）**，使小尺寸预览与 1080×1920 渲染等价。

```ts
// /lib/config-schema.ts
import { z } from "zod";

const Transform = z.object({
  x: z.number(),        // 0..1，元素中心相对画布宽
  y: z.number(),        // 0..1，相对画布高
  scale: z.number().min(0.2).max(3).default(1),
  rotation: z.number().default(0), // deg
});

const Rect = z.object({  // 归一化矩形（提词屏幕区）
  x: z.number(), y: z.number(), w: z.number(), h: z.number(),
});

const AssetRef = z.object({
  kind: z.enum(["builtin", "upload"]),
  id: z.string(),        // builtin 资源 key 或上传文件 id
  mime: z.string().optional(),
  durationSec: z.number().optional(), // 视频/音频
});

export const ProjectConfig = z.object({
  version: z.literal(1),
  canvas: z.object({ width: z.literal(1080), height: z.literal(1920), fps: z.literal(30) }),

  opening: z.object({
    title: z.object({
      text: z.string().max(120),
      fontFamily: z.string().default("Inter"),
      fontSize: z.number().default(96),     // 相对 1080 宽
      color: z.string().default("#ffffff"),
      stroke: z.boolean().default(true),
      pos: Transform,
    }),
    countdown: z.object({ enabled: z.boolean().default(true), from: z.number().int().default(3) }),
    curtain: z.object({
      color: z.string().default("#d11069"),  // 丝绒主色
      openDurationSec: z.number().default(1.4),
      sfx: AssetRef.nullable(),               // null=默认音效
    }),
  }),

  content: z.object({
    background: AssetRef,                       // 图片
    mic: z.object({ asset: AssetRef, transform: Transform }),
    device: z.object({ asset: AssetRef, transform: Transform }),
    teleprompter: z.object({
      mode: z.enum(["text", "video"]).default("text"),
      screen: Rect,                             // 屏幕蒙版区（文字/视频都在此区）
      text: z.object({
        content: z.string(),
        fontSize: z.number().default(64),
        color: z.string().default("#ffffff"),
        bgColor: z.string().default("#000000"),
        align: z.enum(["left", "center"]).default("left"),
        speed: z.number().min(0.3).max(3).default(1), // 滚动速度倍率
      }).optional(),
      video: z.object({ asset: AssetRef, keepAudio: z.boolean().default(true) }).optional(),
    }),
    bgm: z.object({ asset: AssetRef, volume: z.number().min(0).max(1).default(0.55) }).nullable(),
  }),
});

export type ProjectConfig = z.infer<typeof ProjectConfig>;
```

---

## 6. 视频合成模型（Remotion）

### 时间轴
```
0 ─── 开场 ─── openingEnd ─────────── 正片 ─────────── total
      倒计时 from→0     幕布拉开            提词滚动 / 视频播放
```

### 时长公式（编辑器与合成组件共用 `/lib/duration.ts`）
- `countdownSec = countdown.enabled ? countdown.from : 0`
- `openingEnd = countdownSec + curtain.openDurationSec`（幕布在倒计时结束后拉开）
- 正片时长 `contentSec`：
  - **文字模式**：`contentSec = max(MIN_CONTENT, scrollPx / (BASE_PX_PER_SEC * speed))`，`scrollPx = 文本渲染高度 − 屏幕区高度`（文本不足以滚动则取 `MIN_CONTENT`，如 6s）。
  - **视频模式**：`contentSec = video.durationSec`。
- `totalSec = openingEnd + contentSec`，`durationInFrames = round(totalSec * fps)`。
- **背景音乐**：循环或裁剪铺满 `totalSec`，不参与时长决定。

Remotion 用 `calculateMetadata()` 由 `ProjectConfig` 算出 `durationInFrames`，预览与渲染一致。

### 合成结构
```
<TeleprompterVideo config>           // 根合成
  <Sequence 0..openingEnd>  <Opening/>   </Sequence>
  <Sequence openingEnd..>   <Content/>   </Sequence>
  <Audio bgm loop volume/>             // 贯穿正片
</TeleprompterVideo>
```
- `<Opening/>`：背景静帧 + `<Title/>` + `<Countdown/>` + `<Curtain/>`（最上层）+ 开场音效 `<Audio/>`。
- `<Content/>`：`<Background/>` + `<Teleprompter/>`（屏幕区，文字滚动或 `<OffthreadVideo/>`）+ `<Device/>`（设备素材，纯装饰）+ `<Mic/>`。
  - 图层顺序（下→上）：背景 → 提词屏幕内容 → 设备素材（盖住屏幕区边框）→ 麦克风。
  - 注意：提词屏幕区在设备素材**之下**还是**之上**取决于素材是否透明屏幕。默认设备素材的屏幕处透明 → 屏幕内容在其下方透出。

---

## 7. 幕布实现（调研结论，已核对 Remotion 官方文档）

**结论：纯 SVG/CSS 渐变 + `transform`，由 `useCurrentFrame()` 驱动。不引入任何动画库/物理引擎/WebGL。**

- 丝绒质感来源：**多层线性渐变**（竖向明暗交替带 = 打褶；顶部高光带；底部加深 = 垂坠），不是物理模拟。
- 对开动作：`translateX`（拉向两侧）+ 轻微 `scaleX` 压扁（聚拢垂坠感），`transform-origin` 在外侧边缘，缓动 `Easing.bezier(0.22,1,0.36,1)`（厚重惯性）。
- 进度：`interpolate(frame, [countdownSec*fps, openingEnd*fps], [0,1], {easing})` → 完全可 seek、确定性渲染。
- 可选增强：小面积 `feTurbulence + feDisplacementMap` 做布料微动，但 `numOctaves=1`、限定滤镜区域（headless Chromium 下 SVG 滤镜是 CPU 重活）。
- **不用**：Framer Motion（无 Remotion 集成）、Matter.js（run-to-run 不确定）、GSAP（多余依赖）、R3F/Three/Pixi（需 `--gl=angle`、ANGLE 有内存泄漏，杀鸡用牛刀）。
- 备选：Lottie（让设计师 AE 出片），但**只能选无表达式的文件**，否则 headless 渲染会闪烁（官方已记录）。

> 原型 `prototype/index.html` 里的幕布已用此技术（褶皱渐变 + translateX + scaleX + easeOutCubic），可直接平移成 `<Curtain/>` 组件。

铁律（来自官方文档）：
1. 所有动画必须由 `useCurrentFrame()` 驱动，禁止 `setTimeout/requestAnimationFrame/useFrame` 自带时钟。
2. 异步资源（自定义字体、上传素材）必须 `delayRender()/continueRender()` 包裹，防止 headless 截到未就绪帧。

---

## 8. 编辑器 UI

### 布局（一屏）
```
┌ topbar: logo · 项目名 · [▶ 预览] [⤓ 导出视频] ───────────────────┐
├──────────────── 左：配置（≈420px） ──┬──── 右：预览（flex，居中）──┤
│  ① 开场                              │   ┌ 9:16 <Player/> ┐        │
│    标题文字                          │   │  叠加拖拽交互层  │        │
│    3·2·1 倒计时 [开关]               │   └─────────────────┘        │
│    （幕布/音效：内置，无需配置）     │   ▶ —————scrubber——— 00:00/00:36 │
│  ② 正片                              │   [① 开场 / ② 正片] peek 切换 │
│    背景图 [上传]                     │                              │
│    提词内容 [文字|视频] tab          │                              │
│    背景音乐 [上传] + 音量            │                              │
└──────────────────────────────────────┴──────────────────────────────┘
```

### shadcn/ui 组件映射
| 区域 | 组件 |
|---|---|
| 顶栏按钮 | `Button` |
| 标题 / 文本输入 | `Input`、`Textarea`、`Label` |
| 倒计时 / 保留原声开关 | `Switch` |
| 提词模式、开场/正片切换 | `Tabs` 或 `ToggleGroup` |
| 滚动速度 / 音量 | `Slider` |
| 上传区 | 自定义 dropzone（`Button` + 隐藏 input + `Card`） |
| 配置分组 | `Card` |
| 导出进度弹窗 | `Dialog` + `Progress` |
| 提示 | `Sonner`(toast)、`Tooltip` |

### 配置项（删无可删后的最终集）
**① 开场**：标题文字；倒计时开关。（幕布、音效内置；幕布颜色作为"进阶"可选项，默认折叠不展示。）
**② 正片**：背景图上传；提词内容（文字 tab：文本 + 滚动速度；视频 tab：上传 + 保留原声开关）；背景音乐上传 + 音量。
**预览上直接操作**：拖动麦克风 / 提词设备改位置，拖角缩放，选中显示"↻ 替换素材"。

---

## 9. 预览（Player）+ 直接操作层

- 预览 = `@remotion/player` 的 `<Player>` 渲染根合成，`inputProps = { config }`，随配置实时更新。
- `<Player>` 自身不处理我们的元素拖拽；在其上叠一个**透明交互层**：
  - 选中麦克风/提词设备 → 画选择框 + 右下角缩放手柄 + 替换入口。
  - 指针拖动 → 换算成归一化 `transform`（除以预览像素尺寸）→ 回写 `ProjectConfig`。
  - 因为坐标归一化，导出时按 1080×1920 还原，完全一致。
- "开场/正片" peek 切换 = 把 `<Player>` 跳到对应幕的代表帧做静态查看；▶ 播放整段。

---

## 10. 导出 / 渲染服务

- 触发：前端 `POST /api/render`，body = `ProjectConfig` + 素材文件（multipart）。
- 服务端（Node 容器，**非** edge runtime，需 headless Chromium）：
  1. 落临时目录，把上传素材路径注入 config（`staticFile`/绝对路径）。
  2. `bundle()` 合成入口 → `renderMedia({ codec: "h264", ... })`。
  3. `onProgress` 写 job 状态。
- **异步 job**：`POST /api/render` 返回 `jobId`；`GET /api/render/:jobId` 返回 `{ status, progress, url }`，前端轮询并显示进度弹窗，完成后下载。
- 输出：MP4 / H.264 + AAC，1080×1920，30fps，无水印。
- 并发：内部工具量小，单机串行 + 简单内存队列即可；需要时再加队列中间件。

---

## 11. 素材处理

| 类型 | 预览（浏览器） | 导出（服务端） | 约束 |
|---|---|---|---|
| 背景图 | `URL.createObjectURL(File)` | 随任务上传 | jpg/png/webp，建议 ≥1080×1920 |
| 麦克风 / 设备 | 同上 | 同上 | png（建议带透明通道） |
| 提词视频 | `<OffthreadVideo>` 用 blob URL | 上传文件 | mp4/mov/webm，读取 `durationSec` 决定时长 |
| 背景音乐 | `<Audio>` blob URL | 上传文件 | mp3/m4a/wav |
| 内置默认素材 | 打包在 `/public` | 同源读取 | 见 §13 待补 |

- 上传大小上限（建议）：图片 10MB、音频 30MB、视频 200MB（内部可放宽，前端 zod 校验）。
- 提词文字区默认矩形：取设备默认素材屏幕位置的归一化值；换素材后用户可在预览里调整该区域。

---

## 12. 项目结构（建议）

```
/app
  /(editor)/page.tsx          # 编辑器壳
  /api/render/route.ts        # 提交渲染（或独立服务）
  /api/render/[jobId]/route.ts# 查询进度
/components
  /editor/                    # 左侧配置表单（基于 shadcn）
    OpeningPanel.tsx  ContentPanel.tsx  Uploader.tsx
  /preview/
    PreviewPlayer.tsx         # <Player> 封装
    InteractionLayer.tsx      # 拖拽/缩放叠加层
    Transport.tsx             # 播放条/scrubber/peek
/remotion
  Root.tsx                    # registerRoot + <Composition calculateMetadata>
  TeleprompterVideo.tsx       # 根合成
  scenes/Opening.tsx  scenes/Content.tsx
  elements/Curtain.tsx  Title.tsx  Countdown.tsx
           Teleprompter.tsx  Device.tsx  Mic.tsx  Background.tsx
/lib
  config-schema.ts            # zod ProjectConfig
  duration.ts                 # 时长公式（编辑器+合成共用）
  coords.ts                   # 归一化 <-> 像素换算
  store.ts                    # 配置状态
/server (可选独立)
  render-worker/              # @remotion/renderer 容器
/public/assets/builtin/       # 内置默认素材
```

---

## 13. 实施里程碑

- **M0 脚手架**：Next.js + Tailwind + shadcn + Remotion；`<Player>` 跑通一个静态合成。
- **M1 合成组件**：Opening/Content、`<Curtain>`、提词文字滚动、`calculateMetadata` 动态时长。
- **M2 编辑器壳 + 配置表单**：左配置右预览，配置实时驱动 `<Player>`。
- **M3 直接操作层**：麦克风/设备拖拽 + 缩放，归一化回写。
- **M4 素材 + 视频模式**：上传背景/素材/视频/音频；提词视频模式；背景音乐。
- **M5 渲染服务 + 导出**：`/api/render` job 流程、进度、下载。
- **M6 打磨**：幕布质感与缓动、字体加载（delayRender）、边界与错误处理、localStorage 草稿 + JSON 导入导出。

---

## 14. 待确认 / 假设（可推翻）

以下按"内部工具、从简"取了默认值，若不符随时改：

1. **渲染部署**（假设：自托管 Node 渲染服务，容器化部署到你们自有环境，不绑 AWS Lambda）。若想用 Remotion Lambda / 阿里云 FC 容器，渲染层接口不变、换实现即可。
2. **持久化**（假设：配置自动存 `localStorage` + 可导出/导入 JSON；上传素材仅浏览器内，导出时随任务上传，不入库/不落对象存储）。若要后端保存、复用模板或共享，需加 DB + 对象存储。
3. **访问控制**（假设：无登录，内网/信任环境）。若需接公司 SSO 再加。
4. **内置默认素材待提供**：麦克风 png、手+手机 png（屏幕处透明）、机场背景 jpg、开场音效 mp3。先用占位，正式素材你给。
5. **字体**：标题/提词默认字体（Inter / 思源黑体？）需确定并自托管，确保渲染端可用。
6. **提词文字模式无人声**：正片若只有背景音乐、无旁白，是否需要"文字转语音/配音"？当前不做，按纯滚动文字。
```

