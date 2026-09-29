# TermX

个人使用的跨平台 SSH 客户端。把**终端、SFTP、端口转发、主机监控**放在同一个工作区里，重点是交互顺手、界面耐看，能长时间使用。

> 当前状态：**可运行的产品骨架**。设计体系、组件库、状态层、16 个界面的路由与原生壳已就位；
> 本地终端已经接上真实 PTY（原生壳里跑的是 PowerShell），但**远程 SSH / SFTP / 转发 / 监控尚未接入真实协议**，
> 界面数据来自 [`src/data/mock.ts`](src/data/mock.ts) 的种子数据。

---

## 技术栈

| 层 | 选型 |
| --- | --- |
| 桌面壳 | Tauri v2（Rust，无边框窗口 + 本地 PTY） |
| 前端 | React 19 + TypeScript 7 + Vite 8 |
| 路由 | react-router 8（HashRouter，适配桌面端自定义协议） |
| 样式 | Tailwind CSS v4（CSS-first `@theme` token） |
| 图标 | Iconify（Lucide + Simple Icons，`icon-[lucide--server]` 类名写法） |
| 状态 | zustand |
| 终端 | xterm.js 6 + fit / web-links 插件 |

## 前置要求

- Node.js 22+、pnpm 11+
- Rust 1.77+（MSVC 工具链）、Visual Studio 2022 Build Tools
- Windows 上需要 WebView2 Runtime（Win11 自带）

## 快速开始

```bash
pnpm install

# 只跑前端（浏览器里预览，终端降级为演示模式）
pnpm dev                  # http://localhost:5183

# 跑桌面应用（真实窗口 + 本地 shell）
pnpm tauri:dev

# 构建
pnpm build                # 前端产物到 dist/
pnpm tauri:build          # 安装包
```

## 目录结构

```
termx/
├── src/                        前端
│   ├── App.tsx                 路由表（16 个界面）
│   ├── styles/theme.css        设计 token：:root 原始变量 → @theme 映射成 Tailwind 工具类
│   ├── data/
│   │   ├── types.ts            领域模型（唯一的类型契约）
│   │   └── mock.ts             种子数据，命名与设计稿一致
│   ├── lib/                    cn / format / status / tauri / window
│   ├── store/                  theme / ui / toast / hosts / sessions / transfers
│   ├── components/
│   │   ├── chrome/             应用外壳：标题栏、活动栏、状态栏、命令面板
│   │   └── ui/                 UI 原语：Button / Input / Display / Toggle / Overlay
│   └── screens/                16 个界面
├── src-tauri/                  Rust 原生壳
│   ├── src/pty.rs              本地终端 PTY（portable-pty）
│   └── tauri.conf.json         无边框窗口配置
├── termx.vetd/                 Vetta 设计画布工程（设计稿源文件，非应用代码）
├── docs/
│   ├── termx-design-brief.html 设计需求书
│   └── APP-SKELETON.md         界面实现契约（改界面前必读）
├── tools/
│   ├── shot.ps1                界面截图工具，用于与设计稿比对
│   └── make-icon.py            生成应用图标源图
└── shots/                      自检截图产物（git 忽略）
```

## 设计体系

界面遵循 **Linear 体系**（见 [`termx.vetd/DESIGN.md`](termx.vetd/DESIGN.md)）：近黑工作区、软靛蓝主色、克制的强调色、发丝级边框、15–24px 紧凑标题、高密度列表。

约定：

- **颜色零硬编码**。所有颜色来自 [`src/styles/theme.css`](src/styles/theme.css) 的 token，用法是 `bg-surface`、`text-muted`、`border-border`、`text-env-prod` 这类工具类。
- **深色为默认，浅色可切换**。主题属性写在 `<html data-theme>`，由 `useThemeStore` 维护。
- **环境辨识贯穿全局**。生产 / 预发 / 测试 / 开发有固定颜色，在主机库、标签、终端边框、状态栏四处的表现由 `EnvPill` / `EnvStripe` 统一提供。

设计稿是 [`termx.vetd/frames/*.tsx`](termx.vetd/frames/) 里的 16 个静态帧，界面实现按帧 1:1 复刻布局与密度，只把写死的数据换成从 store 取。

## 界面自检

改完界面后，用截图和设计稿比对：

```powershell
# 需要 pnpm dev 已经跑起来
& .\tools\shot.ps1 -Route "hosts" -Out "shots/hosts.png"
```

设计稿参考截图在 `termx.vetd/.snapshots/`（注意：文件后缀是 `.png`，实际字节是 JPEG，读图前先复制成 `.jpg`）。

类型检查：`pnpm typecheck`

## 已知取舍（骨架期）

1. **浅色主题只覆盖基础语义层**。[`src/styles/theme.css`](src/styles/theme.css) 已经预留 `[data-theme="light"]` 与 token 间接层，设置页的主题切换是真实生效的，但 16 个界面尚未逐屏为浅色复核配色与对比度。
2. **设置页分区跟需求书、不跟设计帧**。需求书 06 定义设置分为 外观 / 终端 / 快捷键 / 安全 / 数据 五区；设计帧 `settings.tsx` 另有「数据同步」与「关于与版本更新」两项（前者在需求书里是 P2）。当前实现按需求书，没有加这两项。
3. **各界面右下角/角落的「状态」切换器是评审工具**。为了逐个查看需求书 06 要求的状态而加，不属于设计帧元素，正式出图或交付前应移除。
4. **界面数据来自 mock**。真实 SSH / SFTP / 端口转发 / 指标采集都还没接入；**本地终端已经是真实 PTY**（原生壳里跑 PowerShell）。
5. **命令面板的 `/palette` 路由套了应用外壳**，为了对齐设计帧；已避免与全局浮层叠加成两个面板。

## 待确认问题

来自设计需求书第 10 节，会影响信息架构，动手做 P1 之前需要定下来：

1. 多台电脑之间要不要同步配置？（不做 / 同步到自己的 WebDAV、S3、Gist / 延后）
2. AI 助手是否进入规划？（目前按 P2 只预留右侧面板入口）
3. 主要使用 Windows 还是 macOS？决定标题栏与窗口控件的主次
4. 是否需要对接公司堡垒机（如 JumpServer）？
