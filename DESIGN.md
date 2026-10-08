---
version: alpha
name: TermX-design-system
description: TermX 个人 SSH 客户端的设计系统。以 Meta 商业设计体系为风格基底（pill 按钮、大圆角卡片、扁平层级、克制的钴蓝强调色），管理类界面使用白色画布，终端工作区使用正式定义的深色表面体系。字体主用 Inter（Optimistic VF 为私有字体不可获取），终端等宽字体独立成栈。组件清单面向终端工具：标签栏、分屏格、主机卡片、侧边抽屉、命令面板、状态徽章。

colors:
  # ── 品牌与强调 ──────────────────────────────
  primary: "#0064e0"            # 钴蓝：仅用于「连接」等核心动作
  primary-deep: "#0457cb"       # 钴蓝 pressed / 深色面上的激活态
  primary-soft: "#0091ff"       # 钴蓝浅色变体 / 信息提示底色（15% alpha）
  on-primary: "#ffffff"
  ink-button: "#000000"         # 营销/管理面的黑色主按钮
  on-ink-button: "#ffffff"
  fb-blue: "#1876f2"            # 表单控件选中态（radio/checkbox/focus）

  # ── 浅色表面（管理类界面：主机库、密钥、片段、设置、欢迎页）──
  canvas: "#ffffff"
  surface-soft: "#f1f4f7"
  ink-deep: "#0a1317"
  ink: "#1c1e21"
  charcoal: "#444950"
  slate: "#4b4c4f"
  steel: "#5d6c7b"
  stone: "#8595a4"
  hairline: "#ced0d4"
  hairline-soft: "#dee3e9"
  disabled-text: "#bcc0c4"

  # ── 深色表面（终端工作区：标签栏、分屏、抽屉、状态栏）──
  dark-canvas: "#0d1117"        # 工作区最底层背景
  dark-surface: "#161b22"       # 面板 / 抽屉 / 标签栏
  dark-raised: "#1c2330"        # 浮层：命令面板、Popover、Modal
  dark-hover: "#21293a"         # 深色面上的悬停/选中填充
  dark-ink: "#e6edf3"           # 深色面主文本
  dark-ink-secondary: "#9da7b3" # 深色面次级文本
  dark-ink-muted: "#6e7a89"     # 深色面弱化文本（占位、时间戳）
  dark-hairline: "#2b3342"      # 深色面 1px 分隔线
  dark-hairline-soft: "#22293a" # 深色面更弱的分隔

  # ── 终端本体 ────────────────────────────────
  terminal-bg: "#0b0e14"        # xterm 画布背景（比 dark-canvas 再深半档）
  terminal-fg: "#d6deeb"
  terminal-cursor: "#0091ff"
  terminal-selection: "#264f78" # 选区底色（约 40% 钴蓝混合）

  # ── 语义色 ──────────────────────────────────
  success: "#31a24c"            # 已连接 / 在线
  attention: "#f2a918"          # 连接中 / 重连中
  warning: "#f7b928"
  critical: "#e41e3f"           # 断开 / 错误 / 危险操作
  critical-strong: "#f0284a"    # 表单错误边框与错误文本

typography:
  # 字阶沿用 Meta 体系骨架，但终端工具以 12–16px 为主战场，
  # display 级仅用于欢迎页/空状态，不用 64px hero。
  display-lg:
    fontFamily: Inter
    fontSize: 36px
    fontWeight: 500
    lineHeight: 1.28
  heading-lg:
    fontFamily: Inter
    fontSize: 28px
    fontWeight: 500
    lineHeight: 1.25
  heading-md:
    fontFamily: Inter
    fontSize: 22px
    fontWeight: 500
    lineHeight: 1.27
  heading-sm:
    fontFamily: Inter
    fontSize: 18px
    fontWeight: 600
    lineHeight: 1.33
  subtitle-lg:
    fontFamily: Inter
    fontSize: 16px
    fontWeight: 700
    lineHeight: 1.50
  body-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 400
    lineHeight: 1.50
    letterSpacing: -0.14px
  body-md-bold:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.50
    letterSpacing: -0.14px
  body-sm:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.43
  body-sm-bold:
    fontFamily: Inter
    fontSize: 13px
    fontWeight: 700
    lineHeight: 1.43
  caption:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.33
  caption-bold:
    fontFamily: Inter
    fontSize: 12px
    fontWeight: 700
    lineHeight: 1.33
  button-md:
    fontFamily: Inter
    fontSize: 14px
    fontWeight: 700
    lineHeight: 1.43
    letterSpacing: -0.14px
  mono-md:
    fontFamily: JetBrains Mono
    fontSize: 13px
    fontWeight: 400
    lineHeight: 1.45
  mono-sm:
    fontFamily: JetBrains Mono
    fontSize: 12px
    fontWeight: 400
    lineHeight: 1.40

rounded:
  xs: 2px
  sm: 4px
  md: 6px
  lg: 8px
  xl: 16px
  xxl: 24px
  full: 100px
  circle: 9999px

spacing:
  xxs: 4px
  xs: 8px
  sm: 10px
  md: 12px
  base: 16px
  lg: 20px
  xl: 24px
  xxl: 32px
  xxxl: 40px
  section: 64px

components:
  # ── 按钮 ────────────────────────────────────
  button-primary:
    backgroundColor: "{colors.ink-button}"
    textColor: "{colors.on-ink-button}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "12px 26px"
  button-primary-pressed:
    backgroundColor: "{colors.charcoal}"
    textColor: "{colors.on-ink-button}"
  button-primary-disabled:
    backgroundColor: "{colors.disabled-text}"
    textColor: "{colors.canvas}"
  button-connect:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "12px 26px"
  button-connect-pressed:
    backgroundColor: "{colors.primary-deep}"
    textColor: "{colors.on-primary}"
  button-secondary:
    backgroundColor: "transparent"
    textColor: "{colors.ink-deep}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "10px 24px"
    border: "2px solid {colors.ink-deep}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.ink-deep}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "8px 18px"
    border: "2px solid rgba(10, 19, 23, 0.12)"
  button-ghost-dark:
    backgroundColor: "transparent"
    textColor: "{colors.dark-ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "8px 18px"
    border: "2px solid {colors.dark-hairline}"
  button-icon-circular:
    backgroundColor: "transparent"
    textColor: "{colors.steel}"
    rounded: "{rounded.circle}"
    size: 32px
  button-icon-circular-dark:
    backgroundColor: "transparent"
    textColor: "{colors.dark-ink-secondary}"
    rounded: "{rounded.circle}"
    size: 32px

  # ── 表单 ────────────────────────────────────
  text-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
    border: "1px solid {colors.hairline}"
    height: 40px
  text-input-focused:
    border: "2px solid {colors.fb-blue}"
  text-input-error:
    border: "1px solid {colors.critical-strong}"
  text-input-dark:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "{spacing.md}"
    border: "1px solid {colors.dark-hairline}"
    height: 40px
  text-input-dark-focused:
    border: "2px solid {colors.primary-soft}"
  search-pill:
    backgroundColor: "{colors.surface-soft}"
    textColor: "{colors.steel}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.full}"
    padding: "{spacing.sm} {spacing.lg}"
    height: 36px

  # ── 徽章与状态 ───────────────────────────────
  badge-connected:
    backgroundColor: "{colors.success}"
    textColor: "{colors.canvas}"
    typography: "{typography.caption-bold}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  badge-connecting:
    backgroundColor: "{colors.attention}"
    textColor: "{colors.canvas}"
    typography: "{typography.caption-bold}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  badge-disconnected:
    backgroundColor: "{colors.stone}"
    textColor: "{colors.canvas}"
    typography: "{typography.caption-bold}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  badge-error:
    backgroundColor: "{colors.critical}"
    textColor: "{colors.canvas}"
    typography: "{typography.caption-bold}"
    rounded: "{rounded.full}"
    padding: "3px 10px"
  status-dot:
    rounded: "{rounded.circle}"
    size: 8px
  # 状态点用色：success / attention / stone / critical，与徽章同语义

  # ── 卡片 ────────────────────────────────────
  card-host:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    border: "1px solid {colors.hairline-soft}"
  card-host-selected:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.xl}"
    padding: "{spacing.lg}"
    border: "2px solid {colors.primary}"
  card-panel:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xl}"
    border: "1px solid {colors.hairline-soft}"
  card-empty-state:
    backgroundColor: "{colors.surface-soft}"
    rounded: "{rounded.xxl}"
    padding: "{spacing.xxxl}"

  # ── 工作区（深色）─────────────────────────────
  workspace-tab:
    backgroundColor: "transparent"
    textColor: "{colors.dark-ink-secondary}"
    typography: "{typography.body-sm}"
    rounded: "{rounded.lg}"
    padding: "6px 14px"
  workspace-tab-active:
    backgroundColor: "{colors.dark-hover}"
    textColor: "{colors.dark-ink}"
    typography: "{typography.body-sm-bold}"
    rounded: "{rounded.lg}"
    padding: "6px 14px"
  terminal-pane:
    backgroundColor: "{colors.terminal-bg}"
    rounded: "{rounded.md}"
    border: "1px solid {colors.dark-hairline-soft}"
  terminal-pane-focused:
    backgroundColor: "{colors.terminal-bg}"
    rounded: "{rounded.md}"
    border: "1px solid {colors.primary-deep}"
  side-drawer:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    border: "1px solid {colors.dark-hairline-soft}"
  # 宽度 240–320px，可折叠；内部列表行高 36px
  bottom-panel:
    backgroundColor: "{colors.dark-surface}"
    textColor: "{colors.dark-ink}"
    border: "1px solid {colors.dark-hairline-soft}"
  # 嵌入式 SFTP / 传输队列 / 日志，可收起
  command-palette:
    backgroundColor: "{colors.dark-raised}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.xl}"
    padding: "{spacing.xs}"
    border: "1px solid {colors.dark-hairline}"
    shadow: "rgba(0, 0, 0, 0.5) 0px 8px 32px 0px"
  command-palette-item-active:
    backgroundColor: "{colors.dark-hover}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.lg}"
  modal-overlay:
    backgroundColor: "rgba(10, 19, 23, 0.6)"
  modal-card:
    backgroundColor: "{colors.canvas}"
    rounded: "{rounded.xxl}"
    padding: "{spacing.xxl}"
    shadow: "rgba(20, 22, 26, 0.3) 0px 4px 16px 0px"
  modal-card-dark:
    backgroundColor: "{colors.dark-raised}"
    textColor: "{colors.dark-ink}"
    rounded: "{rounded.xxl}"
    padding: "{spacing.xxl}"
    border: "1px solid {colors.dark-hairline}"
  activity-bar:
    backgroundColor: "{colors.dark-canvas}"
    textColor: "{colors.dark-ink-muted}"
  activity-bar-item-active:
    textColor: "{colors.dark-ink}"
    border: "2px solid {colors.primary}"
  # 左侧 2px 钴蓝指示条标记当前活动面板
  status-bar:
    backgroundColor: "{colors.dark-canvas}"
    textColor: "{colors.dark-ink-muted}"
    typography: "{typography.caption}"
    border: "1px solid {colors.dark-hairline-soft}"
  # 高度 24–28px，承载会话状态、延迟、编码等微信息

  # ── 列表 ────────────────────────────────────
  list-row:
    backgroundColor: "transparent"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm} {spacing.md}"
    rounded: "{rounded.lg}"
  list-row-dark:
    backgroundColor: "transparent"
    textColor: "{colors.dark-ink}"
    typography: "{typography.body-md}"
    padding: "{spacing.sm} {spacing.md}"
    rounded: "{rounded.lg}"
  list-row-dark-active:
    backgroundColor: "{colors.dark-hover}"
    textColor: "{colors.dark-ink}"
---

## Overview

TermX 是一个个人 SSH 客户端：终端、SFTP、端口转发、主机监控在同一个窗口内协同工作。设计系统以 Meta 商业体系为风格基底——pill 形按钮、大圆角卡片、扁平层级、克制的钴蓝强调色——但面向的是生产力工具而非营销页面：密度更高、字阶更小、没有摄影内容，并且为终端工作区正式定义了一整套深色表面 token。

界面分两类表面：

- **浅色管理面**（`canvas` 白底）：主机库、密钥管理、片段库、设置、欢迎引导。承载配置与浏览任务，完整使用 Meta 式白底卡片语言。
- **深色工作面**（`dark-canvas` 系）：终端工作区、标签栏、侧边抽屉、底部面板、命令面板、状态栏。终端是应用的心脏，工作面永远深色，且作为常驻布局不被路由切换卸载。

**Key Characteristics:**
- 双表面体系：浅色管理面 + 深色工作面，token 各自成组，组件以 `-dark` 后缀区分变体
- 钴蓝 `{colors.primary}` 只出现在「连接」动作与激活指示上（活动标签、聚焦分屏边框、活动栏指示条），稀缺即语义
- Pill 按钮（`{rounded.full}`）+ `{rounded.xl}` 卡片为签名几何；终端分屏格用更紧的 `{rounded.md}` 以拉开层级
- 扁平为主，阴影只留给浮层（命令面板、Modal）
- 等宽字体栈（JetBrains Mono）独立于 UI 字体，用于终端、命令片段、路径、密钥指纹等一切代码性内容

## Colors

### 使用规则
- **钴蓝稀缺原则**：`{colors.primary}` 只用于连接 CTA、激活态指示（tab、分屏焦点、活动栏）。普通主按钮用黑色 `{colors.ink-button}`。
- **语义色即连接状态**：success=已连接、attention=连接中/重连中、stone=未连接、critical=断开/错误。状态徽章与状态点共用这套映射，全应用一致。
- **深浅不混用**：浅色面组件不引用 `dark-*` token，反之亦然。跨表面的浮层（如命令面板）固定使用深色变体。

### 深色表面层级
从底到顶：`dark-canvas`（工作区底）→ `dark-surface`（抽屉/面板/标签栏）→ `dark-raised`（浮层）→ `dark-hover`（交互填充）。终端本体用比 canvas 更深半档的 `terminal-bg`，让终端在视觉上"沉"进工作区。

## Typography

### Font Family
- **UI 字体**：Inter（fallback: system-ui, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif）。Optimistic VF 为 Meta 私有字体不可获取，Inter 的几何人文气质是最接近的公开替代。
- **等宽字体**：JetBrains Mono（fallback: "Cascadia Code", Consolas, "JetBrains Mono", monospace）。用于终端渲染、命令片段、SSH 指纹、文件路径、日志。

### 字阶原则
- 终端工具的主战场是 12–14px：`body-md`（14px）为默认正文，`body-sm`（13px）为列表与次级内容，`caption`（12px）为状态栏与元信息。
- `display-lg`（36px）只用于欢迎页与空状态标题，全应用不出现更大的字。
- 中文环境下 letter-spacing 归零（负字距只对拉丁字符生效）。

## Layout

### 主窗口结构（与架构审计 6.1 一致）
```
┌──────────────────────────────────────────────────────┐
│ TitleBar（自定义标题栏 + 居中命令面板入口）            │
├────┬───────────┬─────────────────────────────────────┤
│ 活 │ 侧边抽屉   │ 终端工作区（常驻，永不卸载）          │
│ 动 │ 240–320px │ 标签栏 + 分屏网格                    │
│ 栏 │ 可折叠     ├─────────────────────────────────────┤
│ 48 │           │ 底部面板（SFTP/传输/日志，可收起）     │
├────┴───────────┴─────────────────────────────────────┤
│ StatusBar（24–28px）                                  │
└──────────────────────────────────────────────────────┘
```

### 密度
- 基础步进 4px，组件内边距以 `xs`(8) / `sm`(10) / `md`(12) 为主；`xl`(24) 以上只用于卡片与空状态。
- 列表行高 36px，标签栏高度 36–40px，状态栏 24–28px。不追求营销页的呼吸感，追求一屏内的信息密度。

## Elevation & Depth

| Level | Treatment | Use |
|---|---|---|
| 0（扁平） | 无阴影，hairline 边框 | 所有卡片、面板、抽屉 |
| 1（浮层） | `rgba(0,0,0,0.5) 0 8px 32px` | 命令面板、Popover |
| 2（模态） | `rgba(20,22,26,0.3) 0 4px 16px` + overlay | Modal、确认对话框 |

阴影是"浮于工作区之上"的信号，常驻界面元素一律不用阴影。

## Components

### 按钮
- **`button-primary`**：黑色 pill，管理面的默认主按钮（保存、导入、新建）。
- **`button-connect`**：钴蓝 pill，**只**用于「连接」动作——主机卡片、In-Tab Connect 表单、欢迎页快速连接。全应用任何视口内钴蓝按钮不应超过一个。
- **`button-secondary` / `button-ghost`**：浅色面的次要与三级动作；`button-ghost-dark` 为深色面对应物。
- **`button-icon-circular(-dark)`**：32px 圆形图标按钮，用于标签栏、抽屉头部、分屏工具区。

### 工作区
- **`workspace-tab` / `-active`**：标签不闭合时用幽灵态，激活标签用 `dark-hover` 填充 + 粗体；连接状态用 8px `status-dot` 前缀表达，不用文字徽章。
- **`terminal-pane` / `-focused`**：分屏格默认 `dark-hairline-soft` 边框，焦点格边框变为 `primary-deep`——这是钴蓝在深色面最核心的语义出现。
- **`side-drawer`**：活动栏点击展开，承载主机树/文件/片段/转发/密钥；终端工作区始终可见。
- **`command-palette`**：居中浮层，深色 `dark-raised` + 全系统唯一允许的大阴影；条目激活态 `dark-hover`。
- **`status-bar`**：会话状态、延迟、编码、行列号等微信息，`caption` 字号。

### 徽章与状态
连接状态四色（connected/connecting/disconnected/error）在主机卡片、标签状态点、状态栏三处必须一致。徽章只用于列表与卡片；标签栏内一律用 8px 状态点，避免拥挤。

## Do's and Don'ts

### Do
- 把 `{colors.primary}` 留给「连接」与激活指示；用户扫一眼就知道当前焦点和可连接入口。
- 管理面用白底卡片，工作面用深色面板——两类表面各自完整，不混搭。
- 一切代码性内容（命令、路径、指纹、日志）使用等宽字体栈。
- 按钮一律 pill（`{rounded.full}`）；卡片 `{rounded.xl}`；终端分屏格 `{rounded.md}`。
- 状态表达优先用色点与徽章，其次才是文字。

### Don't
- 不要在深色工作面使用纯白卡片或黑色 pill 按钮——深色面的主按钮是 `button-connect` 或 `button-ghost-dark`。
- 不要给常驻面板（抽屉、标签栏、状态栏）加阴影；阴影只属于浮层。
- 不要在终端工作区使用 display 级大字；工作区最大字号为 `heading-sm`（18px）。
- 不要引入钴蓝之外的第二强调色；语义四色（绿/橙/灰/红）已覆盖全部状态表达。
- 不要把圆角降到 `{rounded.sm}` 以下（checkbox 等微控件除外）。

## Responsive Behavior

桌面工具，窗口最小宽度 960px。低于此宽度时侧边抽屉自动折叠为仅活动栏，底部面板默认收起。不支持移动端布局。

## Iteration Guide

1. 一次只改一个组件；token 引用必须写全（`{colors.primary}`），不要散落硬编码色值。
2. 新增深色组件时，先确认浅色变体是否存在，命名以 `-dark` 后缀成对维护。
3. 新增状态表达时，复用语义四色；确实需要第五种状态时，先审视能否合并。
4. 终端相关组件的规格以 `src/styles/theme.css` 为实现落点，本文件为单一事实来源，两边保持同步。

## Known Gaps

- 终端 ANSI 16 色调色板（xterm theme）未在本文件定义，当前由 `src/components/terminal/terminalTheme.ts` 承载；后续应作为 `terminal-palette` 一节并入。
- 动画时长未规范；建议浮层 150–200ms ease-out，抽屉展开 200ms ease-in-out。
- 高对比度/无障碍模式 token 未定义。
