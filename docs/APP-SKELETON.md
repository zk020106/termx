# TermX 应用骨架 —— 界面实现契约

这份文档是**所有界面实现的唯一契约**。实现界面之前先读完它，再读对应的设计帧。
目标：把 `termx.vetd/frames/*.tsx`（设计画布里的静态稿）变成**真实可交互的 React 界面**。

---

## 1. 项目结构

```
termx/
├── src/
│   ├── App.tsx                     # 路由表（16 个界面），已冻结
│   ├── main.tsx                    # 入口，已冻结
│   ├── styles/theme.css            # 设计 token（Tailwind v4 @theme），已冻结
│   ├── data/types.ts               # 领域模型，已冻结
│   ├── data/mock.ts                # 种子数据，已冻结
│   ├── lib/{cn,format,status,tauri,window}.ts   # 工具函数，已冻结
│   ├── store/{theme,ui,toast,hosts,sessions,transfers}.ts  # 状态，已冻结
│   ├── components/
│   │   ├── chrome/                 # 外壳：TitleBar / ActivityBar / StatusBar / WindowChrome / CommandPalette
│   │   └── ui/                     # 原语：Button / Input / Display / Toggle / Overlay
│   └── screens/*.tsx               # 16 个界面 ← 你要改的就是这里
├── src-tauri/                      # Rust 原生壳
└── tools/shot.ps1                  # 截图自检工具
```

**铁律**

1. **只改分配给你的文件**。`data/`、`store/`、`lib/`、`components/ui/`、`components/chrome/`（除 CommandPalette）都是冻结契约，不要改。缺字段就用自己的界面内局部数据，不要改 `types.ts`。
2. **禁止硬编码颜色**。不许出现 `#0d1117`、`bg-[#fff]`、`text-white`（除下面 EnvPill 说明外）。颜色一律用 token 类：`bg-surface` / `bg-surface-raised` / `bg-surface-sunk` / `text-surface-foreground` / `text-muted` / `text-faint` / `border-border` / `bg-primary` / `text-primary` / `text-accent` / `text-danger` / `text-warning` / `text-success` / `bg-term` / `text-term-ink` / `bg-env-prod|stage|test|dev`。
3. **中文文案**，风格与设计帧一致（技术名词、命令、路径保留英文）。
4. **缩进用 Tab**，与现有文件一致。
5. **`pnpm exec tsc --noEmit` 必须 0 错误**（只修自己文件里的报错）。
6. 所有非纯静态界面都要**真的能点**：状态用 `useState` 或对应 store，不要只画静态图。

---

## 2. 设计基准 = 逐帧复刻

每个界面都有对应设计帧，位于 `termx.vetd/frames/<name>.tsx`。**布局、间距、字号、层级一律照抄**，只把写死的数据换成从 store / mock 取。

| 界面文件 | 设计帧 | 路由 |
| --- | --- | --- |
| `src/screens/Workspace.tsx` | `frames/index.tsx` | `/workspace`（首页是主机库；`/` 与未知路径都重定向到 `/hosts`） |
| `src/screens/Hosts.tsx` | `frames/hosts.tsx` | `/hosts`（首页） |
| `src/screens/HostEdit.tsx` | `frames/host-edit.tsx` | `/hosts/new`, `/hosts/:hostId/edit` |
| `src/screens/Connect.tsx` | `frames/connect.tsx` | `/connect` |
| `src/screens/Sftp.tsx` | `frames/sftp.tsx` | `/sftp` |
| `src/screens/Editor.tsx` | `frames/editor.tsx` | `/editor` |
| `src/screens/Transfers.tsx` | `frames/transfers.tsx` | `/transfers` |
| `src/screens/Forward.tsx` | `frames/forward.tsx` | `/forward` |
| `src/screens/Snippets.tsx` | `frames/snippets.tsx` | `/snippets` |
| `src/screens/Keys.tsx` | `frames/keys.tsx` | `/keys` |
| `src/screens/Monitor.tsx` | `frames/monitor.tsx` | `/monitor` |
| `src/screens/Settings.tsx` | `frames/settings.tsx` | `/settings` |
| `src/screens/Welcome.tsx` | `frames/welcome.tsx` | `/welcome` |
| `src/screens/Lock.tsx` | `frames/lock.tsx` | `/lock` |
| `src/screens/Palette.tsx` | `frames/palette.tsx` | `/palette` |
| `src/screens/Updater.tsx` | `frames/updater.tsx` | `/updater` |

需求书全文在 `docs/termx-design-brief.html`，第 **06 节「设计交付清单」**列出每个界面必须覆盖的状态，第 **07 节**是关键交互细则。

---

## 3. 骨架约定

**带外壳的界面**（除 Welcome / Lock / Palette / Updater 外都是）：

```tsx
import { WindowChrome } from "@/components/chrome/WindowChrome";

export default function Example() {
	return (
		<WindowChrome>
			{/* 顶部工具栏（h-10，border-b）+ 主体 flex-1 布局 */}
		</WindowChrome>
	);
}
```

`WindowChrome` 已经提供标题栏、活动栏、状态栏、命令面板浮层、Toast，并处理好 `Ctrl+K` / `Ctrl+B` / `Ctrl+Shift+S` / `Ctrl+,`。
**不要**自己再套一层状态栏或标题栏。

Welcome / Lock / Palette / Updater 是整页或浮层，**不套** `WindowChrome`，自己写 `h-full` 根节点。

---

## 4. 可用 API 速查

### 4.1 原语 —— `@/components/ui/*`

```tsx
import { Button, IconButton, Kbd } from "@/components/ui/Button";
import { Input, Textarea, Select, Field, ReadonlyValue } from "@/components/ui/Input";
import { EnvPill, EnvStripe, StatusDot, StatusText, Badge, ProgressBar, MetricBar,
         Panel, SectionLabel, EmptyState, Segmented } from "@/components/ui/Display";
import { Switch, Checkbox, SettingRow } from "@/components/ui/Toggle";
import { Drawer, Modal, DangerousConfirm, Toaster, Hint } from "@/components/ui/Overlay";
```

| 组件 | 关键 props |
| --- | --- |
| `Button` | `variant: primary \| default \| ghost \| danger`，`size: sm \| md`，`icon`（Iconify 类名），`kbd` |
| `IconButton` | `icon`，`label`，`active` |
| `Fields` | `Field(label, hint, error, required)`；`ReadonlyValue` |
| `EnvPill` | `env: "prod" \| "stage" \| "test" \| "dev"`，`size: xs \| sm` — **环境标的唯一实现，不要自己写** |
| `EnvStripe` | `env` — 标签左侧 3px 色条 |
| `StatusDot` | `status: ConnectionStatus`，`size` |
| `ProgressBar` | `value`，`max`，`tone` |
| `MetricBar` | `label`，`value`，`progress`，`warn` |
| `Panel` | `title`，`actions`，`children` |
| `Segmented` | `value`，`onChange`，`options: {value,label,icon?}[]` |
| `EmptyState` | `icon`，`title`，`description`，`action` |
| `Drawer` | `open`，`onClose`，`title`，`subtitle`，`width`，`footer`，`children` |
| `Modal` | `open`，`onClose`，`title`，`icon`，`footer`，`children` |
| `DangerousConfirm` | `open`，`onClose`，`onConfirm`，`hostName`，`action` — 需手输主机名 |
| `Toaster` | 无 props，由 `WindowChrome` 挂载 |

图标统一用 Iconify 类名：`className="icon-[lucide--server]"`；发行版图标形如：`icon-[simple-icons--ubuntu]`、`icon-[simple-icons--debian]`。

### 4.2 状态 —— `@/store/*`

```ts
import { useHostsStore, filterHosts } from "@/store/hosts";     // hosts, groups, view, query, scope, selectedIds...
import { useSessionsStore } from "@/store/sessions";            // tabs, panes, activeTabId, openSession, setLayout...
import { useTransfersStore, transferSummary } from "@/store/transfers";
import { useUiStore } from "@/store/ui";                        // sidebarOpen, paletteOpen, rightPanel*, setPaletteOpen...
import { useThemeStore } from "@/store/theme";                  // mode, resolved, density, setMode, setDensity
import { toast } from "@/store/toast";                          // toast({title, description?, tone?, action?: {label, run}})
```

### 4.3 真实数据层（**没有 mock 了**）

`src/data/mock.ts` **已删除**。应用只呈现真实数据，规则如下：

- **用户自己的数据**（主机、分组、密钥、片段、转发规则）来自 `@/store/*`，启动时从磁盘载入，变更后自动落盘。
  首次启动这些列表**都是空的**，界面必须给出可用的空状态与下一步指引。
- **未接入真实协议的能力**（会话、传输队列、SFTP 文件、编辑器内容、监控指标、进程列表、
  连接步骤、更新信息、远程监听端口）**没有任何数据源**，一律显示空状态并说明「需要什么才能有数据」，
  不允许再造示例数据。

```ts
// 用户数据（可增删改，会自动持久化）
import { useHostsStore, filterHosts } from "@/store/hosts";       // hosts / groups / upsertHost / addGroup ...
import { useSnippetsStore, extractVariables, draftSnippet } from "@/store/snippets";
import { useKeysStore } from "@/store/keys";
import { useForwardsStore, draftForwardRule } from "@/store/forwards";

// 运行时状态
import { useSessionsStore } from "@/store/sessions";             // tabs / panes / openSession（初始为空）
import { useTransfersStore, transferSummary } from "@/store/transfers";  // 初始为空
import { useProbeStore } from "@/store/probe";                   // 真实的 TCP 测速结果
import { useUiStore } from "@/store/ui";
import { useThemeStore } from "@/store/theme";
import { toast } from "@/store/toast";

// 持久化（一般不用直接调，store 变更已自动保存）
import { flushNow, configLocation } from "@/lib/persist";
```

类型与格式化：

```ts
import { ENV_LABEL, ENV_NAME, CONNECTION_LABEL, AUTH_LABEL, FORWARD_LABEL,
         SNIPPET_TARGET_LABEL, type Env, type Host, type ConnectionStatus } from "@/data/types";
import { formatBytes, formatSpeed, formatDuration, formatPercent, formatRelative } from "@/lib/format";
import { connVisual, envBg, envText, envBorder } from "@/lib/status";
import { cn } from "@/lib/cn";
```

### 4.5 空状态的写法

界面没数据时不要留白，也不要造数据，用 `EmptyState` 说清楚「现在为什么是空的、怎么才能有数据」：

```tsx
<EmptyState
	icon="icon-[lucide--server-off]"
	title="还没有主机"
	description="导入 ~/.ssh/config 或手动新建一台，这里就会出现你的服务器。"
	action={<Button variant="primary" onClick={() => navigate("/hosts/new")}>新建主机</Button>}
/>
```

### 4.4 本地终端

```tsx
import { Terminal } from "@/components/terminal/Terminal";
<Terminal paneId="pane-1" hostId="order-api-01" className="h-full" />
```
浏览器下自动降级为演示输出；Tauri 内接真实 PTY。

---

## 5. 必须覆盖的状态

按需求书 06 逐个实现，**同一界面用局部 state 切换出一个状态切换器**（放在工具栏右侧或页面角落，小号 Segmented / 一组小按钮，标注「状态」），方便评审时逐个查看。状态切换器属于骨架期的评审工具。

各界面重点（详见需求书 06 表格）：

- **Welcome**：欢迎页 → 导入 `~/.ssh/config` → 手动新建 → 设置主密码（可跳过）
- **Hosts**：卡片 / 列表 / 树形三视图；空状态；搜索无结果；多选；拖拽进行中
- **HostEdit**：基本信息 / 认证 / 跳板机 / 高级 / 外观 五个分区；校验失败；未保存离开提示
- **Connect**：分步进度；输入密码 / 二次验证码；首次指纹确认；指纹变化警告；各步骤失败态
- **Workspace**：单屏 / 2 格 / 4 格分屏；搜索栏；右键菜单；广播中；重连宽限期横幅；已断开覆盖层
- **Sftp**：底部面板与双栏两模式；拖拽放置高亮；权限编辑；同名冲突；空目录；无权限
- **Editor**：多文件标签；未保存标记；保存冲突对比
- **Transfers**：进行中 / 已暂停 / 失败 / 已完成 / 空状态
- **Forward**：规则列表；三种类型表单；运行中 / 已停止 / 出错
- **Snippets**：列表；编辑；发送前填变量；选择发送目标
- **Keys**：密钥列表；生成；导入；部署公钥
- **Monitor**：正常；超阈值；无法获取数据
- **Settings**：外观 / 终端 / 快捷键 / 安全 / 数据五个分区
- **Lock**：输入主密码解锁；密码错误
- **Palette**：默认显示最近；结果按主机 / 命令 / 设置分组；`>` 前缀只搜命令
- **Updater**：当前版本 / 新版本 / 渠道切换 / 更新日志 / 后台下载开关

---

## 6. 自检流程（必须做完再说完成）

```powershell
# 1. 类型检查（必须 0 错误）
pnpm exec tsc --noEmit

# 2. 截图（dev server 已在 5183 常驻；没跑就 pnpm dev）
& .\tools\shot.ps1 -Route "hosts" -Out "shots/hosts.png"

# 3. 用读图工具打开 shots/hosts.png 自己看一眼，和 termx.vetd/.snapshots/<name>-*.png 比对
```

设计帧截图（JPEG 字节但后缀是 .png，读图前先复制成 .jpg）：
`.snapshots/<界面名>-<时间戳>.png`，例如 `hosts-1790240227282.png`。

**自查要点**
- 布局密度、行高、间距是否与设计稿一致；
- 深色底上是否出现刺眼的纯白或高饱和色；
- 环境标记（PROD/STG/TEST/DEV）、连接状态点是否到位；
- 你的界面在 1440×900 下是否溢出或出现纵向滚动条；
- 有没有控制台报错（Chrome 截图看不出，但 `tsc` 和代码审阅要过）。

---

## 7. 交付回报格式

完成后回报：**改动文件清单** + **每个界面覆盖了哪些状态** + **`tsc --noEmit` 结果** + **截图路径** + **未完成或存疑的点**。
