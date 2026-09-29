# TermX

个人使用的跨平台 SSH 客户端。把**终端、SFTP、端口转发、主机监控**放在同一个工作区里，重点是交互顺手、界面耐看，能长时间使用。

> 当前状态：**骨架 + 真实连接**。16 个界面全部实现；**没有 mock 数据**——界面上出现的每一台主机、
> 每一条转发布规则都由你自己录入，并保存在本地配置文件里。
> **SSH 真实可用**（基于 `russh`，密码认证、PTY、交互式 shell 已验证能连上真实服务器）；
> SFTP、端口转发隧道、监控指标采集、多因素认证与 known_hosts 校验尚未实现，对应界面会如实说明而不是编数据。

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

## 哪些是真的、哪些还没接

| 能力 | 状态 |
| --- | --- |
| 本地终端（PTY） | ✅ 真实，原生壳内跑 PowerShell / `$SHELL` |
| SSH 连接（密码认证 + PTY + 交互 shell） | ✅ 真实，`russh` + ring 后端 |
| 主机库 / 分组 / 密钥 / 片段 / 转发规则的增删改 | ✅ 真实，落盘到 `%APPDATA%\dev.termx.app\termx.json` |
| 主机测速（TCP 延迟 / 抖动 / 丢包） | ✅ 真实，含中间盒接管的识别 |
| 命令面板 | ✅ 条目来自真实主机与片段 |
| 公钥指纹 | ✅ 真实（WebCrypto SHA-256，与 `ssh-keygen -lf` 一致） |
| SFTP 文件浏览与传输 | ❌ 未接入，界面显示空状态 |
| 端口转发隧道 | ❌ 未接入，规则可存但启停无真实隧道 |
| 监控指标 / 进程列表 | ❌ 未接入，界面显示空状态 |
| 多因素认证 / 键盘交互 | ❌ 未接入 |
| known_hosts 校验与首次连接人工确认 | ❌ 未接入（当前接受任何主机密钥并把真实指纹展示给你） |
| 应用内生成密钥对 | ❌ 未接入（可在密钥库登记已有公钥） |
| 更新服务 | ❌ 未接入 |

### 配置与凭据

- 配置文件是**明文** JSON，只存主机地址、用户名、分组这类非敏感信息。
- **密码不进配置文件**：只在连接时用于本次认证，存在内存里，应用退出即消失。
  系统钥匙串持久化尚未接入。
- 配置文件的真实路径可以在设置页的「数据与备份」里看到（`config_location` 命令返回）。

## 已知取舍

1. **浅色主题只覆盖基础语义层**。[`src/styles/theme.css`](src/styles/theme.css) 已经预留 `[data-theme="light"]` 与 token 间接层，设置页的主题切换是真实生效的，但 16 个界面尚未逐屏为浅色复核配色与对比度。
2. **设置页分区跟需求书、不跟设计帧**。需求书 06 定义设置分为 外观 / 终端 / 快捷键 / 安全 / 数据 五区；设计帧 `settings.tsx` 另有「数据同步」与「关于与版本更新」两项（前者在需求书里是 P2）。当前实现按需求书，没有加这两项。
3. **各界面角落的「状态」切换器是评审工具**。为了逐个查看需求书 06 要求的状态而加，不属于设计帧元素，正式出图或交付前应移除。已接入真实数据的界面（Monitor / Sftp / Editor / Updater）在无数据时已把切换器删掉——没有数据还提供状态切换会暗示这些状态真实存在。
4. **密码只存在内存里**。应用退出即消失；系统钥匙串持久化还没接入，所以每次连接都要重新输入密码。
5. **主机测速的结论是「TCP 可达」，不等于 SSH 可用**。实测环境里存在 DNS 劫持与透明中间盒（连 `.invalid` 保留域名都能连上），因此界面会把「往返不足 1 毫秒」标记为疑似被本地代理接管，而不是当成健康值。
6. **命令面板的 `/palette` 路由套了应用外壳**，为了对齐设计帧；已避免与全局浮层叠加成两个面板。

## 待确认问题的处置

设计需求书第 10 节留了四个问题。不等待拍板，已按需求书点名的两个参考产品（[Netcatty](https://github.com/binaricat/Netcatty)、[OxideTerm](https://github.com/AnalyseDeCircuit/oxideterm)）**已经验证过的做法**定下来，依据与出处见 **[docs/DECISIONS.md](docs/DECISIONS.md)**：

| 问题 | 决策 |
| --- | --- |
| 多台电脑之间要不要同步配置 | **不做云同步（移出当前范围）**；只做加密便携包（`.termx`）手动搬运 |
| AI 助手是否进入规划 | 进入规划，按 **BYOK** 模型：用户自带 provider，不内置 AI 服务，动作必须用户批准 |
| 主要用什么系统 | 三平台为目标、Windows 为主设计；窗口控件按平台分支（macOS 在左） |
| 是否对接堡垒机（JumpServer） | 不对接厂商 API；用 SSH 原生多跳表达跳板链，UI 参考 OxideTerm 的「钻入下一跳」 |
