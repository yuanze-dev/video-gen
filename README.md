# 小音符起号助手 · 竖屏提词短视频生成器

> 填空式模板，把「开幕 + 提词器 + FlowPrompter 片尾」这套竖屏短视频做成所见即所得的一屏编辑器：填几项内容、在预览里拖两个素材，一键导出 1080×1920 无水印 MP4。

<p>
  <img alt="Next.js" src="https://img.shields.io/badge/Next.js-16-black?logo=next.js" />
  <img alt="React" src="https://img.shields.io/badge/React-19-149eca?logo=react" />
  <img alt="Remotion" src="https://img.shields.io/badge/Remotion-4-0b84f3" />
  <img alt="Electron" src="https://img.shields.io/badge/Electron-42-47848f?logo=electron" />
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-5-3178c6?logo=typescript" />
</p>

原则科技（Yuanze）内部工具，用于快速产出「起号」类竖屏短视频。编辑器预览与最终成片**复用同一套 Remotion 合成组件**，靠 `useCurrentFrame()` 驱动全部动画，因此预览与导出像素级一致。

---

## ✨ 功能特性

- **一屏编辑**：左侧配置表单 + 右侧 9:16 实时预览，所见即所得。
- **三段结构**：① 开场 `opening`（丝绒幕布 + 标题 + 3·2·1 倒计时 + 开场音效）→ ② 正片 `content`（背景 + 麦克风 + 提词设备 + 提词内容 + 背景音乐）→ ③ 片尾 `ending`（FlowPrompter 内置视频 + 原声）。
- **提词两种模式**：文字（提词器匀速上滚，可调速度）/ 视频（在设备屏幕区内播放，保留原声）。
- **固定片尾可替换**：新建及旧版配置默认带 FlowPrompter 片尾；可上传另一段视频整体替换，系统自动读取片尾时长并计入成片。
- **直接操作**：麦克风、提词设备可在预览上直接拖拽 / 缩放，坐标归一化回写，导出 1:1 还原。
- **代码生成的幕布**：纯 SVG/CSS 渐变 + `transform` 模拟丝绒对开，颜色可调，确定性渲染、可任意 seek。
- **首帧封面导出**：导出视频的同时输出第一帧（合幕状态）作为封面图。
- **无水印导出**：MP4 / H.264 + AAC，1080×1920，按内容自动计算时长。

> 明确不做：商业化 / 套餐 / 配额、账号登录、自由画布 / 图层树 / 多轨时间轴。版式写死，仅开放内容与两个素材的摆位。详见 [`SPEC.md`](SPEC.md)。

---

## 🧱 技术栈

| 领域 | 选型 |
|---|---|
| 框架 | Next.js 16（App Router）+ TypeScript |
| UI | shadcn/ui（Radix + Tailwind v4）、lucide、sonner |
| 视频合成 / 渲染 | [Remotion 4](https://www.remotion.dev) — `@remotion/player`（预览）/ `@remotion/renderer`（导出）|
| 状态 / 校验 | Zustand + Zod |
| 桌面壳 | Electron 42 + electron-builder |

---

## 🏗 架构

项目提供 **Web 渲染** 与 **桌面本机渲染** 两条导出路径，共用同一套 `/remotion` 合成组件与 `lib/` 业务逻辑：

```
┌──────────────── 浏览器 / Electron 窗口（Next.js UI） ────────────────┐
│  EditorShell                                                          │
│  ┌─ 左：配置表单 ─┐        ┌─ 右：<Player/> 预览 + 拖拽交互层 ─┐      │
│  │ 写入 Config    │ ─────▶ │ 同一套 Remotion 合成组件          │      │
│  └────────────────┘        └───────────────────────────────────┘      │
│         ProjectConfig（单一数据源，坐标 0–1 归一化）                   │
└───────────────┬───────────────────────────────┬──────────────────────┘
                │ Web：POST /api/render          │ 桌面：IPC render:start
                ▼                                ▼
   ┌─ Next 服务端 bundle + renderMedia ─┐   ┌─ Electron 主进程 ─────────┐
   │ 服务器本地 headless Chromium+ffmpeg│   │ serveUrl 指向 Vercel 托管 │
   │ 输出 MP4，job 轮询进度             │   │ 的 /remotion-site/，仅在   │
   └────────────────────────────────────┘   │ 本机跑 Chromium+ffmpeg     │
                                             └────────────────────────────┘
```

**桌面端是一个「薄壳」**：窗口直接加载远程 UI（生产为 Vercel 部署，开发为 localhost），UI / 合成更新随 Vercel 上线、无需重新分发 App；桌面进程只负责本机 MP4 渲染，通过窄 IPC 桥（`electron/preload.ts`）暴露给页面。上传素材经 IPC 落盘，再由一个仅监听 loopback 的微型 HTTP 服务回流给 headless 浏览器。

详细数据模型、时间轴公式与幕布实现见 [`SPEC.md`](SPEC.md)。

---

## 🚀 快速开始

环境要求：Node.js ≥ 20。

```bash
npm install
npm run dev
```

打开 http://localhost:3000 即可使用编辑器。左侧依次是开场、正片和片尾三张配置卡片；右侧可用 `① 开场 / ② 正片 / ③ 片尾` 快速跳到对应段落预览，播放时仍会完整播放三段。

### 本地 CLI

无需打开编辑器即可创建、校验、预览和渲染视频：

Electron 桌面版可直接从顶栏点击 `CLI` → `安装 CLI`：安装器会把随 App 分发的受控启动器写入 `~/.local/bin`，按需配置新终端的 `PATH`，并在完成前执行版本自检；遇到已有同名命令、非稳定 App 路径或 shell 配置竞态时会停止并保留原内容，不要求管理员权限，也不会联网下载 CLI。

```bash
npm run cli -- version --json
npm run cli -- init video.json --minimal
npm run cli -- validate video.json --json
npm run cli -- plan video.json --json
npm run cli -- still video.json --scene all --out-dir preview
npm run cli -- render video.json --out output/video.mp4
```

本地开发用 `npm run cli --`；安装发行包后命令为 `littlestart`，兼容别名为 `video-gen`。JSON 机器输出使用 `{protocolVersion, ok, result|error}` 信封，命令字段以当前二进制的 `help`、`capabilities --json` 和 `config schema --json` 为准。完整的安装、锁文件、批处理、离线缓存与 Agent Skill 说明见 [README-CLI.md](README-CLI.md)。

---

## 📜 可用脚本

| 命令 | 说明 |
|---|---|
| `npm run dev` | 启动 Next.js 开发服务器 |
| `npm run build` | 构建 Remotion 静态站点 + Next.js 生产产物 |
| `npm run start` | 以生产模式启动 |
| `npm run lint` | ESLint 检查 |
| `npm run cli -- <命令>` | 运行无界面的本地校验 / 渲染 CLI |
| `npm run build:cli` | 构建可分发 CLI 与内嵌 Remotion runtime |
| `npm run pack:cli` | 生成 CLI `.tgz` 发行包 |
| `npm run smoke:cli` | 安装并冒烟验证 CLI 发行包 |
| `npm run test:cli` | 运行 CLI 测试套件 |
| `npm run test:skills` | 校验 canonical / Codex / Claude / 随包 Skill 及文档镜像 |
| `npm run build:remotion-site` | 仅把 `/remotion` 打包到 `public/remotion-site`（供托管站点 `serveUrl` 使用）|
| `npm run electron:dev` | 编译并以源码运行桌面壳（加载 localhost UI）|
| `npm run electron:build` | 构建并用 electron-builder 打包 macOS DMG |

---

## 🗂 项目结构

```
app/
  page.tsx                  # 编辑器壳入口
  api/render/…              # Web 渲染：提交、查询进度、下载、封面
  api/asset/…               # 上传素材回流
components/
  editor/                   # 左侧配置面板、顶栏、导出弹窗、上传器
  preview/Preview.tsx       # <Player> 封装 + 拖拽 / 缩放交互层
  ui/                       # shadcn/ui 组件
remotion/
  Root.tsx                  # registerRoot + <Composition calculateMetadata>
  TeleprompterVideo.tsx     # 根合成
  scenes/ · elements/       # Opening/Content/Ending、Curtain、Title、Countdown…
lib/
  config-schema.ts          # Zod ProjectConfig（单一数据源）
  duration.ts               # 时长公式（编辑器与合成共用）
  coords.ts · resolved.ts   # 归一化↔像素换算、素材 URL 解析
  store.ts                  # 配置状态（Zustand）
  render/jobs.ts            # Web 端渲染 job
electron/
  main.ts                   # 主进程（薄渲染壳）
  preload.ts                # IPC 桥
  render.ts                 # 本机 @remotion/renderer 驱动
scripts/                    # build-remotion-site / build-electron
public/assets/builtin/      # 内置默认素材（麦克风 / 设备 / 背景 / 音效 / FlowPrompter 片尾）
```

---

## 🖥 桌面端打包

macOS DMG（Apple Silicon）通过 electron-builder 产出，配置见 [`electron-builder.yml`](electron-builder.yml)：

- UI 远程加载；桌面包携带 Electron 主/预载 bundle、`@remotion/renderer`、原生 compositor 与 Littlestart CLI runtime，`chrome-headless-shell` 和 CLI 均通过 `extraResources` 放在 `app.asar` 外。
- 桌面更新会在后台下载，顶栏持续显示真实状态且不影响编辑与导出；下载完成后由用户选择合适时机重启。导出期间会保留已下载的安装包并暂时禁用重启，正常退出应用时也会自动完成安装。`v0.2.2` 可显示只读下载/错误状态，但不会暴露不安全的“立即重启”；`v0.2.1` 的旧壳会在下载后出现一次无法延后的重启提示，新版 Web 会提前说明这个迁移例外。
- 客户端发行只接受已合入 `main` 的 `v*` tag。CI 会先预建唯一草稿 Release，再把 DMG、自动更新 ZIP、blockmap 和 manifest 上传到同一草稿，逐项核验后才公开；线上 UI 也只在 manifest、ZIP 和手动安装包都可用时展示更新。
- 签名使用 *Developer ID Application* 证书并开启 Hardened Runtime；生产凭据保存在 GitHub Actions Secrets。
- 公证与 staple 统一由 `build/notarize.cjs` 完成；缺少 Apple 凭据时只允许本地签名构建。

```bash
npm run electron:build
```

生产发布只通过 [`.github/workflows/release.yml`](.github/workflows/release.yml) 的 `v*` tag 流程完成：tag 必须与 `package.json` 版本一致并指向 `main` 中的提交；内置素材权利清单不得残留待确认项，仓库变量 `CLI_DISTRIBUTION_APPROVED` 也必须在 Remotion 与第三方许可复核后设为 `true`。流水线会预建唯一 draft、完成签名/公证、核对 DMG、ZIP、blockmap 与 `latest-mac.yml` 后才公开 Release，禁止用手动 workflow 绕过这些门禁。

---

## 🔒 安全说明

桌面壳对远程内容做了收口：窗口固定在可信源（trusted origin），其他导航 / `window.open` 一律转交系统浏览器；远程页面不获得摄像头 / 麦克风 / 定位等隐式权限；`render:start` 仅接受指向可信源 `/remotion-site/` 的 `serveUrl`，并对上传 asset id 做路径穿越校验。

---

## 📄 License

内部项目（`private`），版权归 © 原则科技 Yuanze，暂未开源。
