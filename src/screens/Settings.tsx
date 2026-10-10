import { WindowChrome } from "@/components/chrome/WindowChrome";
import { KeywordHighlightSettings } from "@/components/settings/TerminalBehaviorSettings";
import { ShortcutsSettings } from "@/components/settings/ShortcutsSettings";
import { KnownHostsList } from "@/components/settings/KnownHostsList";
import { TERMINAL_SCHEMES, schemeColors, schemeTones } from "@/components/terminal/terminalSchemes";
import { Button } from "@/components/ui/Button";
import { Badge, Panel, Segmented } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { SettingRow, Switch } from "@/components/ui/Toggle";
import {
	AUTO_LOCK_CHOICES,
	CURSOR_STYLES,
	DEFAULT_WORD_SEPARATORS,
	FONT_FAMILIES,
	FONT_SIZES,
	FONT_WEIGHTS,
	LINE_HEIGHTS,
	MIDDLE_CLICK_ACTIONS,
	RIGHT_CLICK_ACTIONS,
	SCROLLBACK_CHOICES,
	TAB_DOUBLE_CLICK_ACTIONS,
	type AutoLockChoice,
	type CursorStyle,
	type MiddleClickAction,
	type RightClickAction,
	type ScrollbackChoice,
	type SftpDoubleClickBehavior,
	type TabDoubleClickAction,
	type TerminalSchemeId,
} from "@/data/preferences";
import type { Accent, ThemeMode } from "@/data/types";
import { cn } from "@/lib/cn";
import { exportConfig, mergeConfig, parseConfigFile } from "@/lib/configBackup";
import { createVerifier, lockCryptoAvailable, verifyPassword } from "@/lib/lock";
import { expandHome, parseSshConfig, toHosts } from "@/lib/hostImport";
import { detectPlatform } from "@/lib/platform";
import { fsLocalHome, fsLocalReadFile } from "@/lib/sftp";
import { useHostsStore } from "@/store/hosts";
import { useLockStore } from "@/store/lock";
import { useSettingsStore } from "@/store/settings";
import { useThemeStore } from "@/store/theme";
import { toast } from "@/store/toast";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";

/** 运行平台：真实探测 */
const PLATFORM_LABEL = { windows: "Windows", macos: "macOS", linux: "Linux" }[detectPlatform()];

/** 系统钥匙串名称 */
const KEYCHAIN_LABEL = {
	windows: "Windows 凭据管理器",
	macos: "macOS 钥匙串",
	linux: "Secret Service",
}[detectPlatform()];

/* =============================================================================
 * 设置中心 —— 对齐 Netcatty 完整体系，融入 Vercel Geist 现代高密度设计
 *
 * 8 大分类体系：
 *   1. appearance: 外观与个性化 (UI主题 / 7强调色 / 密度 / UI字体 / 自定义CSS注入)
 *   2. terminal:   终端排版与渲染 (实时模拟卡片 / 字体字号 / 双字重 / 光标闪烁 / 最小对比度 / 回滚 / 配色方案)
 *   3. behavior:   终端交互行为 (右键 / 中键 / 选区复制 / 换行过滤 / Option作Meta / 清屏清回滚 / 预测补全)
 *   4. highlight:  关键字高亮引擎 (独立全宽面板 / 内置与自定义规则 / 取色器 / 正则校验)
 *   5. sftp:       SFTP 文件传输 (终端CWD跟随 / 活跃标签联动 / 外部编辑自动同步 / 可见列 / 文件打开方式)
 *   6. shortcuts:  快捷键绑定 (快捷键矩阵 / 单项录制 / 重置)
 *   7. security:   安全与凭据库 (应用锁 / 自动锁定 / 凭据存储 / 主机指纹 / 已知主机)
 *   8. data:       系统与数据管理 (会话恢复 / 配置导入导出 / OpenSSH导入 / 资源管理器集成 / 版本检查)
 *
 * 全局即时搜索：输入关键词跨分类过滤匹配所有设置项，支持一键精准跳转定位。
 * ========================================================================== */

export type Section =
	| "appearance"
	| "terminal"
	| "behavior"
	| "highlight"
	| "sftp"
	| "shortcuts"
	| "security"
	| "data";

interface NavItem {
	id: Section;
	name: string;
	icon: string;
	tag?: string;
}

const NAV: NavItem[] = [
	{ id: "appearance", name: "外观与个性化", icon: "icon-[lucide--palette]" },
	{ id: "terminal", name: "终端排版与渲染", icon: "icon-[lucide--terminal]" },
	{ id: "behavior", name: "终端交互行为", icon: "icon-[lucide--sliders-horizontal]" },
	{ id: "highlight", name: "关键字高亮引擎", icon: "icon-[lucide--highlighter]" },
	{ id: "sftp", name: "SFTP 文件传输", icon: "icon-[lucide--folder-sync]" },
	{ id: "shortcuts", name: "快捷键绑定", icon: "icon-[lucide--keyboard]" },
	{ id: "security", name: "安全与凭据库", icon: "icon-[lucide--shield-check]" },
	{ id: "data", name: "系统与数据管理", icon: "icon-[lucide--database-backup]" },
];

const SECTION_TITLE: Record<Section, string> = {
	appearance: "外观与界面个性化",
	terminal: "终端排版与渲染引擎",
	behavior: "终端交互与微观行为",
	highlight: "实时关键字高亮引擎",
	sftp: "SFTP 与远程文件传输",
	shortcuts: "快捷键绑定与键位方案",
	security: "安全防御与主密码凭据库",
	data: "系统集成与配置数据管理",
};

/* ------------------------------- 外观 ------------------------------- */

const THEME_CARDS: { id: ThemeMode; label: string; desc?: string }[] = [
	{ id: "dark", label: "深色模式 (Linear Dark)", desc: "暗黑纯粹基底，适合暗光环境专注编码" },
	{ id: "light", label: "浅色模式 (Linear Light)", desc: "明亮清晰排版，高对比度日常办公" },
	{ id: "system", label: "跟随系统 (Auto)", desc: "自动根据操作系统外观偏好无缝切换" },
];

const ACCENTS: { id: Accent; name: string; dot: string; desc: string }[] = [
	{ id: "vercel", name: "Vercel 经典蓝", dot: "bg-swatch-vercel", desc: "标志性电光蓝" },
	{ id: "indigo", name: "Linear 经典靛蓝", dot: "bg-swatch-indigo", desc: "质感工程靛蓝" },
	{ id: "cyan", name: "电光青", dot: "bg-swatch-cyan", desc: "高能极客霓虹" },
	{ id: "emerald", name: "翡翠绿", dot: "bg-swatch-emerald", desc: "护眼自然森林" },
	{ id: "amber", name: "琥珀金", dot: "bg-swatch-amber", desc: "醒目温暖暖橙" },
	{ id: "rose", name: "玫瑰粉", dot: "bg-swatch-rose", desc: "先锋活力亮粉" },
	{ id: "steel", name: "金属银灰", dot: "bg-swatch-steel", desc: "沉稳纯黑白灰" },
];

const COMMON_UI_FONTS = [
	{ label: "系统默认 (IBM Plex Sans / Inter / 苹方 / 微软雅黑)", value: "" },
	{ label: "Microsoft YaHei (微软雅黑)", value: "Microsoft YaHei" },
	{ label: "PingFang SC (苹方)", value: "PingFang SC" },
	{ label: "Segoe UI", value: "Segoe UI" },
	{ label: "Inter", value: "Inter" },
	{ label: "Fira Sans", value: "Fira Sans" },
	{ label: "MiSans (小米兰亭)", value: "MiSans" },
];

const CSS_TEMPLATES = [
	{ label: "紧凑终端行间距", css: ".xterm-rows { line-height: 1.15 !important; }" },
	{ label: "强制禁用等宽连字", css: ".xterm { font-variant-ligatures: normal !important; }" },
	{ label: "侧栏轻度毛玻璃", css: "aside { backdrop-filter: blur(8px) !important; }" },
	{ label: "微调卡片圆角", css: ":root { --radius-control: 8px; --radius-card: 10px; }" },
];

/* ------------------------------- 终端 ------------------------------- */

const SCROLLBACK_LABEL: Record<ScrollbackChoice, string> = {
	"1000": "1,000 行",
	"5000": "5,000 行",
	"10000": "10,000 行（推荐）",
	"50000": "50,000 行",
	unlimited: "不限制（占用内存）",
};

const CURSOR_LABEL: Record<CursorStyle, string> = { block: "块状 (Block)", bar: "竖线 (Bar)", underline: "下划线 (Underline)" };
const RIGHT_CLICK_LABEL: Record<RightClickAction, string> = { paste: "粘贴", menu: "显示菜单", select: "复制选区", "select-word": "选择单词" };
const MIDDLE_CLICK_LABEL: Record<MiddleClickAction, string> = { "context-menu": "显示菜单", paste: "粘贴", disabled: "禁用" };
const TAB_DOUBLE_CLICK_LABEL: Record<TabDoubleClickAction, string> = { rename: "重命名", duplicate: "复制会话", copy: "复制标签页", disabled: "无操作" };
const CONTRAST_CHOICES = [1, 3, 4.5, 7, 21];

const AUTO_LOCK_LABEL: Record<AutoLockChoice, string> = {
	never: "永不锁定",
	"1": "1 分钟",
	"5": "5 分钟",
	"15": "15 分钟",
	"30": "30 分钟",
	"60": "1 小时",
};

const SCHEME_CARDS: { id: TerminalSchemeId; name: string; tones: string[] | null }[] = [
	{ id: "theme", name: "跟随界面主题", tones: null },
	...TERMINAL_SCHEMES.map((scheme) => ({ id: scheme.id, name: scheme.name, tones: schemeTones(scheme.colors) })),
];

const THEME_TONES = ["bg-primary", "bg-accent", "bg-success", "bg-warning", "bg-muted"];

/* ----------------------------- SFTP ----------------------------- */

const SFTP_COLUMNS_INFO: { key: "size" | "modified" | "type" | "owner"; label: string; desc: string }[] = [
	{ key: "size", label: "文件大小", desc: "显示文件字节数及易读单位 (KB/MB/GB)" },
	{ key: "modified", label: "修改时间", desc: "显示文件最后写入与更新时间戳" },
	{ key: "type", label: "文件类型", desc: "按扩展名或系统 MIME 呈现文件类型标记" },
	{ key: "owner", label: "所有者与权限", desc: "显示 Unix 权限位 (-rw-r--r--) 与归属用户" },
];

/* -------------------------- 搜索索引条目 -------------------------- */

interface SearchableOption {
	id: string;
	section: Section;
	title: string;
	description: string;
	keywords: string;
}

const SEARCH_CATALOG: SearchableOption[] = [
	{ id: "theme-mode", section: "appearance", title: "界面主题模式", description: "深色模式 / 浅色模式 / 跟随系统外观", keywords: "theme dark light system 深色 浅色 主题 外观" },
	{ id: "theme-accent", section: "appearance", title: "全局强调色", description: "7 种预设品牌色（含 Vercel 经典蓝、Linear 靛蓝等）", keywords: "accent vercel indigo cyan color 强调色 主题色 蓝色 颜色" },
	{ id: "theme-density", section: "appearance", title: "界面显示密度", description: "紧凑 (26px) / 标准 (32px) 布局高度", keywords: "density compact standard 密度 紧凑 标准 间距" },
	{ id: "ui-font", section: "appearance", title: "UI 界面字体族", description: "自定义应用外壳 UI 的主无衬线 Sans 字体", keywords: "font ui sans 界面字体 微软雅黑 苹方 字体" },
	{ id: "custom-css", section: "appearance", title: "自定义 CSS 注入", description: "实时编写 CSS 覆盖应用样式，配合 DevTools", keywords: "css style custom 注入 样式 覆盖 自定义样式" },
	{ id: "term-font", section: "terminal", title: "终端等宽字体", description: "等宽字体族名（支持系统已安装的 Nerd Fonts）", keywords: "font monospace nerd jetbrains fira 终端字体 等宽" },
	{ id: "term-size", section: "terminal", title: "字号与行高", description: "微调终端文本大小与每行上下留白倍数", keywords: "font size line height 字号 行高 大小" },
	{ id: "term-weight", section: "terminal", title: "常规字重与粗体字重", description: "独立调节标准字体与加粗文本的粗细 (100~900)", keywords: "font weight bold regular 字重 粗体 细体 加粗" },
	{ id: "term-bold-bright", section: "terminal", title: "粗体使用亮色", description: "是否使用明亮的 ANSI 高亮色渲染粗体字符", keywords: "bold bright color 粗体 亮色 高亮" },
	{ id: "term-cursor", section: "terminal", title: "光标样式与闪烁", description: "块状 / 竖线 / 下划线及呼吸闪烁动画", keywords: "cursor blink block bar underline 光标 闪烁 样式" },
	{ id: "term-contrast", section: "terminal", title: "最小对比度比例", description: "强制提高极端配色下的文本可读性 (1~21)", keywords: "contrast ratio 对比度 辨识度" },
	{ id: "term-scrollback", section: "terminal", title: "滚动回溯行数", description: "终端保留的历史输出行数 (1,000 ~ 50,000 或无限制)", keywords: "scrollback buffer 滚动 回滚 缓冲区 历史" },
	{ id: "term-scroll-input", section: "terminal", title: "输入时自动滚动", description: "在终端键入内容时自动回滚到底部", keywords: "scroll input 自动滚动 滚动到底部" },
	{ id: "term-smooth-scroll", section: "terminal", title: "平滑滚动动画", description: "滚轮滚动时启用顺滑平滑动画效果", keywords: "smooth scrolling 平滑滚动 动画" },
	{ id: "term-scheme", section: "terminal", title: "终端配色方案", description: "60+ 种主流主题配色（Dracula, Nord, Tokyo Night 等）", keywords: "scheme theme dracula nord tokyo night 配色 主题 终端颜色" },
	{ id: "mouse-right", section: "behavior", title: "鼠标右键行为", description: "在终端点击右键时：显示菜单 / 粘贴 / 复制选区 / 选词", keywords: "right click context menu paste 右键 菜单 粘贴" },
	{ id: "mouse-middle", section: "behavior", title: "鼠标中键行为", description: "按下鼠标滚轮中键时：显示菜单 / 粘贴 / 禁用", keywords: "middle click 中键 滚轮 粘贴 菜单" },
	{ id: "copy-on-select", section: "behavior", title: "选择即复制", description: "用鼠标选中终端文本后自动复制到系统剪贴板", keywords: "copy on select 划词 选中复制 选择即复制" },
	{ id: "trim-newline", section: "behavior", title: "复制时去除末尾换行", description: "防止粘贴多行内容时直接在远端触发执行命令", keywords: "trim newline 换行 回车 去除换行 安全复制" },
	{ id: "fullscreen-menu", section: "behavior", title: "在全屏应用中也显示菜单", description: "tmux / vim 抓取鼠标时仍弹出右键菜单", keywords: "fullscreen tmux vim 菜单 右键" },
	{ id: "word-separators", section: "behavior", title: "双击选词边界分隔符", description: "双击选择单个单词时的分界标点符号", keywords: "word separators 单词 分隔符 选词" },
	{ id: "alt-as-meta", section: "behavior", title: "将 Option 作为 Meta 键", description: "macOS 上 Option 键发送 ESC 快捷键前缀", keywords: "alt meta option esc 组合键" },
	{ id: "bracketed-paste", section: "behavior", title: "禁用括号粘贴模式", description: "关闭后多行粘贴不再包裹保护转义符", keywords: "bracketed paste 括号粘贴" },
	{ id: "tab-double-click", section: "behavior", title: "标签页双击行为", description: "双击会话标签执行：重命名 / 复制会话 / 复制标签页", keywords: "tab double click 双击 标签页 重命名" },
	{ id: "clear-scrollback", section: "behavior", title: "clear 清空回滚历史", description: "终端输入 clear 是否同步清空回滚缓冲区", keywords: "clear scrollback 清屏 清空回滚" },
	{ id: "term-bell", section: "behavior", title: "终端响铃提示音", description: "远端输出 BEL 蜂鸣字符时播放提示声音", keywords: "bell 响铃 蜂鸣 提示音" },
	{ id: "img-paste-sftp", section: "behavior", title: "粘贴图片自动转 SFTP 上传", description: "剪贴板含图片时自动上传到远端目录并插入路径", keywords: "image paste sftp upload 粘贴图片 上传图片" },
	{ id: "command-suggestions", section: "behavior", title: "命令预测与智能补全", description: "Warp / VS Code 风格根据历史频次与片段弹出推荐气泡", keywords: "suggestions autocomplete 补全 预测 提示 warp" },
	{ id: "ghost-text", section: "behavior", title: "行内幽灵文本预测", description: "在光标后呈现半透明淡灰色预测文字，按 Tab 采纳", keywords: "ghost text tab 幽灵文本 建议" },
	{ id: "highlight-engine", section: "highlight", title: "关键字高亮引擎", description: "ERROR, WARN, SUCCESS, IPv4, MAC 与自定义正则着色", keywords: "highlight keyword regex 关键字 高亮 日志 正则" },
	{ id: "sftp-follow-tab", section: "sftp", title: "SFTP 联动跟随活跃终端", description: "切换终端标签时底部 SFTP 自动切换到对应主机", keywords: "sftp follow active tab 跟随 联动 标签" },
	{ id: "sftp-follow-cwd", section: "sftp", title: "跟随终端工作目录 (OSC 7)", description: "终端执行 cd 命令后文件浏览器自动跳转该目录", keywords: "sftp cwd osc 7 追随 目录 工作目录 cd" },
	{ id: "sftp-double-click", section: "sftp", title: "SFTP 双击文件行为", description: "双击文件在内置编辑器打开或传输到对侧", keywords: "sftp double click 打开 传输 双击" },
	{ id: "sftp-auto-sync", section: "sftp", title: "外部编辑自动同步到远程", description: "使用外部程序打开远程文件，保存后自动上传", keywords: "sftp auto sync 外部程序 自动同步 回传" },
	{ id: "sftp-hidden", section: "sftp", title: "显示隐藏文件 (点文件)", description: "浏览文件系统时显示以点开头的隐藏项", keywords: "hidden files dotfiles 隐藏文件 点文件" },
	{ id: "sftp-directories-first", section: "sftp", title: "目录优先置顶显示", description: "文件列表排序时文件夹始终排在普通文件前面", keywords: "directories first 目录置顶 文件夹" },
	{ id: "sftp-columns", section: "sftp", title: "SFTP 列表显示列设置", description: "自定义文件大小、修改时间、类型与所有者列显示", keywords: "columns visible 显示列 列配置 属性" },
	{ id: "sftp-openers", section: "sftp", title: "文件打开方式关联管理", description: "管理记住的后缀名与打开程序关联规则", keywords: "openers associations 关联 打开方式 扩展名" },
	{ id: "shortcuts-matrix", section: "shortcuts", title: "快捷键绑定矩阵", description: "查看、录制与重置标签、终端、分屏与 SFTP 键位", keywords: "shortcuts keybindings hotkeys 快捷键 键位 录制" },
	{ id: "shortcuts-zoom", section: "shortcuts", title: "禁用滚轮字体缩放", description: "防止按住 Ctrl/Cmd 滚动鼠标滚轮误触缩放终端字号", keywords: "zoom font wheel 缩放 滚轮 字体缩放" },
	{ id: "app-lock", section: "security", title: "应用锁与主解锁密码", description: "设置加盐摘要主密码，支持开机锁定与即时锁屏", keywords: "lock password verifier 密码 锁屏 锁定 主密码" },
	{ id: "auto-lock", section: "security", title: "闲置自动锁定与剪贴板保护", description: "超时无操作自动锁屏，复制密码 30 秒清空剪贴板", keywords: "auto lock clipboard 超时 自动锁定 剪贴板" },
	{ id: "keychain", section: "security", title: "系统凭据管理器 / 钥匙串", description: "将密码与私钥交给操作系统安全加密保管", keywords: "keychain credential manager 凭据 钥匙串 密码存储" },
	{ id: "known-hosts", section: "security", title: "已知主机指纹与公钥安全", description: "主机指纹比对策略与已信任服务器列表管理", keywords: "known hosts fingerprint 指纹 公钥 主机信任" },
	{ id: "session-restore", section: "data", title: "启动时恢复会话 (Session Restore)", description: "启动 TermX 时自动恢复上次未关闭的主机标签页", keywords: "session restore startup 启动 恢复会话 会话恢复 标签" },
	{ id: "config-export", section: "data", title: "导出完整配置 JSON", description: "导出主机、分组、密钥引用、片段、转发规则与偏好", keywords: "export backup 导出 配置 备份" },
	{ id: "config-import", section: "data", title: "导入并合并配置", description: "从备份文件合并主机与配置，按地址去重更新", keywords: "import restore 导入 恢复 合并" },
	{ id: "ssh-config-import", section: "data", title: "导入 ~/.ssh/config", description: "快速解析 OpenSSH 配置文件并批量录入主机库", keywords: "ssh config import openssh 导入 ssh" },
	{ id: "win-explorer-reg", section: "data", title: "Windows 资源管理器右键集成", description: "在文件夹右键添加「在 TermX 中打开」菜单", keywords: "explorer context menu windows 资源管理器 右键" },
	{ id: "about-updater", section: "data", title: "关于与检查版本更新", description: "查看当前版本、平台运行环境与升级通道", keywords: "updater version about 版本 更新 检查更新" },
];

/* ============================================================================= */

export default function Settings() {
	const [section, setSection] = useState<Section>("appearance");
	const [searchQuery, setSearchQuery] = useState("");

	/* 外观 store */
	const mode = useThemeStore((s) => s.mode);
	const resolved = useThemeStore((s) => s.resolved);
	const setMode = useThemeStore((s) => s.setMode);
	const density = useThemeStore((s) => s.density);
	const setDensity = useThemeStore((s) => s.setDensity);
	const accent = useThemeStore((s) => s.accent);
	const setAccent = useThemeStore((s) => s.setAccent);

	/* 终端 / 行为 / 安全 / 数据 store */
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const lineHeight = useSettingsStore((s) => s.lineHeight);
	const fontWeight = useSettingsStore((s) => s.fontWeight);
	const fontWeightBold = useSettingsStore((s) => s.fontWeightBold);
	const drawBoldInBrightColors = useSettingsStore((s) => s.drawBoldInBrightColors);
	const scrollback = useSettingsStore((s) => s.scrollback);
	const cursorStyle = useSettingsStore((s) => s.cursorStyle);
	const cursorBlink = useSettingsStore((s) => s.cursorBlink);
	const minimumContrastRatio = useSettingsStore((s) => s.minimumContrastRatio);
	const smoothScrolling = useSettingsStore((s) => s.smoothScrolling);
	const scrollOnInput = useSettingsStore((s) => s.scrollOnInput);
	const bell = useSettingsStore((s) => s.bell);
	const rightClick = useSettingsStore((s) => s.rightClick);
	const middleClick = useSettingsStore((s) => s.middleClick);
	const showContextMenuOverFullscreenApps = useSettingsStore((s) => s.showContextMenuOverFullscreenApps);
	const copyOnSelect = useSettingsStore((s) => s.copyOnSelect);
	const wordSeparators = useSettingsStore((s) => s.wordSeparators);
	const altAsMeta = useSettingsStore((s) => s.altAsMeta);
	const trimNewline = useSettingsStore((s) => s.trimNewline);
	const disableBracketedPaste = useSettingsStore((s) => s.disableBracketedPaste);
	const clearWipesScrollback = useSettingsStore((s) => s.clearWipesScrollback);
	const autoUploadClipboardImageOnPaste = useSettingsStore((s) => s.autoUploadClipboardImageOnPaste);
	const tabDoubleClick = useSettingsStore((s) => s.tabDoubleClick);
	const scheme = useSettingsStore((s) => s.scheme);
	const commandSuggestions = useSettingsStore((s) => s.commandSuggestions);
	const ghostText = useSettingsStore((s) => s.ghostText);

	/* 新增高级选项：CSS 注入、UI 字体、会话恢复 */
	const customCss = useSettingsStore((s) => s.customCss);
	const uiFontFamily = useSettingsStore((s) => s.uiFontFamily);
	const sessionRestore = useSettingsStore((s) => s.sessionRestore);

	/* SFTP 偏好 */
	const sftpFollowActiveTab = useSettingsStore((s) => s.sftpFollowActiveTab);
	const sftpFollowTerminalCwd = useSettingsStore((s) => s.sftpFollowTerminalCwd);
	const sftpDoubleClickBehavior = useSettingsStore((s) => s.sftpDoubleClickBehavior);
	const sftpAutoSync = useSettingsStore((s) => s.sftpAutoSync);
	const sftpShowHiddenFiles = useSettingsStore((s) => s.sftpShowHiddenFiles);
	const sftpDirectoriesFirst = useSettingsStore((s) => s.sftpDirectoriesFirst);
	const sftpVisibleColumns = useSettingsStore((s) => s.sftpVisibleColumns);
	const sftpFileOpeners = useSettingsStore((s) => s.sftpFileOpeners);

	/* 安全与数据 */
	const keychain = useSettingsStore((s) => s.keychain);
	const clearClipboard = useSettingsStore((s) => s.clearClipboard);
	const autoLock = useSettingsStore((s) => s.autoLock);
	const startLocked = useSettingsStore((s) => s.startLocked);
	const lockVerifier = useSettingsStore((s) => s.lockVerifier);
	const sshConfigPath = useSettingsStore((s) => s.sshConfigPath);

	const setTerminal = useSettingsStore((s) => s.setTerminal);
	const setSecurity = useSettingsStore((s) => s.setSecurity);
	const setSshConfigPath = useSettingsStore((s) => s.setSshConfigPath);

	const hasPassword = lockVerifier !== null;
	const cryptoOk = lockCryptoAvailable();

	/* 弹窗与表单状态 */
	const [pwdOpen, setPwdOpen] = useState(false);
	const [pwdCurrent, setPwdCurrent] = useState("");
	const [pwdNew, setPwdNew] = useState("");
	const [pwdConfirm, setPwdConfirm] = useState("");
	const [pwdError, setPwdError] = useState<string | null>(null);
	const [pwdBusy, setPwdBusy] = useState(false);

	const fileRef = useRef<HTMLInputElement | null>(null);
	const [importing, setImporting] = useState(false);
	const [sshImporting, setSshImporting] = useState(false);

	const preview = schemeColors(scheme);

	const cursorShape =
		cursorStyle === "block"
			? "inline-block h-3.5 w-2 align-middle"
			: cursorStyle === "bar"
				? "inline-block h-3.5 w-0.5 align-middle"
				: "inline-block h-0.5 w-2.5 align-middle";

	/* 搜索匹配结果 */
	const searchResults = useMemo(() => {
		const q = searchQuery.trim().toLowerCase();
		if (!q) return [];
		return SEARCH_CATALOG.filter(
			(item) =>
				item.title.toLowerCase().includes(q) ||
				item.description.toLowerCase().includes(q) ||
				item.keywords.toLowerCase().includes(q),
		);
	}, [searchQuery]);

	const submitPassword = async () => {
		setPwdError(null);
		if (!cryptoOk) {
			setPwdError("当前环境没有 WebCrypto，无法安全保存密码");
			return;
		}
		if (pwdNew.length < 8) {
			setPwdError("新密码至少 8 位");
			return;
		}
		if (pwdNew !== pwdConfirm) {
			setPwdError("两次输入的新密码不一致");
			return;
		}
		setPwdBusy(true);
		try {
			if (lockVerifier && !(await verifyPassword(pwdCurrent, lockVerifier))) {
				setPwdError("当前密码不正确");
				return;
			}
			setSecurity({ lockVerifier: await createVerifier(pwdNew) });
			setPwdOpen(false);
			setPwdCurrent("");
			setPwdNew("");
			setPwdConfirm("");
			toast({ title: lockVerifier ? "解锁密码已更新" : "解锁密码已设置", tone: "success" });
		} catch (error) {
			setPwdError(error instanceof Error ? error.message : "保存失败");
		} finally {
			setPwdBusy(false);
		}
	};

	const clearPassword = () => {
		setSecurity({ lockVerifier: null, startLocked: false, autoLock: "never" });
		useLockStore.setState({ locked: false });
		toast({ title: "已清除解锁密码", description: "启动锁定与自动锁定同时关闭", tone: "default" });
	};

	const toggleKeychain = (next: boolean) => {
		setSecurity({ keychain: next });
		toast(
			next
				? { title: "已改用系统钥匙串", description: "之后保存的密码交给操作系统保管", tone: "success" }
				: {
						title: "已停用系统钥匙串",
						description: "TermX 不再读写钥匙串；连接页仍可删除已保存的密码",
						tone: "warning",
					},
		);
	};

	const runImport = async (file: File) => {
		setImporting(true);
		try {
			const summary = await mergeConfig(parseConfigFile(await file.text()));
			toast({
				title: "配置已导入",
				description: `新增 ${summary.hostsAdded} 台主机，更新 ${summary.hostsUpdated} 台`,
				tone: "success",
			});
			if (summary.secretsMigrated + summary.secretsSessionOnly > 0) {
				toast({
					title: "导入文件里的明文密码已移出配置",
					description:
						summary.secretsSessionOnly > 0
							? `${summary.secretsMigrated} 个存入系统钥匙串；${summary.secretsSessionOnly} 个因钥匙串不可用只保留到本次退出`
							: `${summary.secretsMigrated} 个已存入系统钥匙串`,
					tone: summary.secretsSessionOnly > 0 ? "warning" : "default",
				});
			}
		} catch (error) {
			toast({ title: "导入失败", description: error instanceof Error ? error.message : "文件读不动", tone: "danger" });
		} finally {
			setImporting(false);
		}
	};

	const importSshConfig = async () => {
		setSshImporting(true);
		try {
			const home = await fsLocalHome();
			const path = expandHome(sshConfigPath.trim(), home) ?? sshConfigPath;
			const result = parseSshConfig(await fsLocalReadFile(path));
			const store = useHostsStore.getState();
			const defaultUser = home.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || undefined;
			const { hosts, conflicts } = toHosts(result.hosts, store.hosts, { home, defaultUser });
			for (const h of hosts) store.upsertHost(h);
			const notes = [...conflicts, ...result.skipped];
			toast({
				title: hosts.length > 0 ? `已从 ${path} 导入 ${hosts.length} 台主机` : "没有新的主机可导入",
				description: notes.length ? `跳过 ${notes.length} 项：${notes.slice(0, 3).join("；")}${notes.length > 3 ? "…" : ""}` : "密码未导入，首次连接时输入",
				tone: hosts.length > 0 ? "success" : "warning",
			});
		} catch (error) {
			toast({ title: "导入 ~/.ssh/config 失败", description: String(error), tone: "danger" });
		} finally {
			setSshImporting(false);
		}
	};

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧设置导航 (224px) */}
				<aside className="flex w-[224px] shrink-0 flex-col border-r border-border bg-surface-sunk p-2.5">
					<div className="px-2 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">偏好设置中心</div>

					{/* 搜索框 */}
					<div className="relative mt-1 mb-2">
						<span className="icon-[lucide--search] absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-faint" />
						<input
							type="text"
							value={searchQuery}
							onChange={(e) => setSearchQuery(e.target.value)}
							placeholder="搜索所有设置项..."
							className="h-7 w-full rounded-control border border-border bg-surface pl-8 pr-7 text-[11px] text-surface-foreground placeholder:text-faint focus:border-accent focus:outline-none focus:ring-1 focus:ring-accent/30"
						/>
						{searchQuery && (
							<button
								type="button"
								onClick={() => setSearchQuery("")}
								className="absolute right-2 top-1/2 -translate-y-1/2 text-faint hover:text-surface-foreground"
							>
								<span className="icon-[lucide--x] size-3" />
							</button>
						)}
					</div>

					{/* 导航列表 */}
					<div role="tablist" aria-label="设置分区" className="space-y-0.5">
						{NAV.map((n) => (
							<button
								key={n.id}
								type="button"
								role="tab"
								aria-selected={section === n.id && !searchQuery}
								onClick={() => {
									setSection(n.id);
									setSearchQuery("");
								}}
								className={cn(
									"flex h-7.5 w-full cursor-pointer items-center gap-2 rounded-control border px-2.5 text-left text-[11.5px] transition-colors",
									section === n.id && !searchQuery
										? "border-accent/40 bg-accent/15 font-medium text-accent shadow-xs"
										: "border-transparent text-muted hover:bg-surface-foreground/5 hover:text-surface-foreground",
								)}
							>
								<span className={cn(n.icon, "size-3.5", section === n.id && !searchQuery ? "text-accent" : "text-muted")} />
								<span className="truncate">{n.name}</span>
							</button>
						))}
					</div>

					{/* 底部版本与检查更新 */}
					<div className="mt-auto rounded-card border border-border bg-surface-raised/40 p-2.5">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--terminal] size-3.5 text-surface-foreground/90" />
							<span className="text-[11.5px] font-medium text-surface-foreground">TermX Desktop</span>
							<Badge>v{__APP_VERSION__}</Badge>
						</div>
						<div className="mt-1 font-mono text-[10px] text-faint">{PLATFORM_LABEL} · 本地与配置中心</div>
						<Link
							to="/updater"
							className="mt-2 flex h-6 items-center justify-center gap-1 rounded-control border border-border bg-surface text-[11px] font-medium text-muted transition-colors hover:border-surface-foreground/20 hover:text-surface-foreground"
						>
							<span className="icon-[lucide--sparkles] size-3" />
							检查版本更新
						</Link>
					</div>
				</aside>

				{/* 右侧设置主内容区 */}
				<div className="flex min-w-0 flex-1 flex-col">
					{/* 顶栏标题 */}
					<div className="flex h-9 shrink-0 items-center justify-between border-b border-border/40 px-6">
						<span className="text-[10px] font-medium tracking-wider text-faint uppercase">
							{searchQuery ? `搜索结果 ("${searchQuery}")` : SECTION_TITLE[section]}
						</span>
						{searchQuery && (
							<span className="text-[11px] text-muted">共找到 {searchResults.length} 项匹配</span>
						)}
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-6 pt-3 pb-8">
						{/* ------------------- 搜索结果展现 ------------------- */}
						{searchQuery ? (
							<div className="max-w-3xl space-y-3">
								{searchResults.length === 0 ? (
									<div className="flex flex-col items-center justify-center py-16 text-center">
										<span className="icon-[lucide--search-x] size-10 text-faint" />
										<p className="mt-2 text-[13px] font-medium text-surface-foreground">未找到相关的设置项</p>
										<p className="mt-1 text-[11.5px] text-muted">尝试更换关键字（例如：光标、字体、sftp、高亮、密码、css 等）</p>
									</div>
								) : (
									searchResults.map((item) => {
										const navItem = NAV.find((n) => n.id === item.section);
										return (
											<button
												key={item.id}
												type="button"
												onClick={() => {
													setSection(item.section);
													setSearchQuery("");
												}}
												className="flex w-full cursor-pointer items-start justify-between rounded-control border border-border bg-surface p-3 text-left transition-colors hover:border-accent/40 hover:bg-surface-raised"
											>
												<div className="space-y-1">
													<div className="flex items-center gap-2">
														<span className="text-[12.5px] font-semibold text-surface-foreground">{item.title}</span>
														<Badge className="text-[9.5px]">
															<span className={cn(navItem?.icon, "size-2.5 mr-1")} />
															{navItem?.name}
														</Badge>
													</div>
													<p className="text-[11.5px] text-muted">{item.description}</p>
												</div>
												<span className="icon-[lucide--chevron-right] size-4 text-faint shrink-0 mt-1" />
											</button>
										);
									})
								)}
							</div>
						) : (
							<>
								{/* ------------------------- 1. 外观与个性化 ------------------------- */}
								{section === "appearance" && (
									<div className="max-w-2xl space-y-6">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">外观与界面主题</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">切换后立即生效并写入本地配置文件。</p>

											<div className="mt-3 grid grid-cols-3 gap-2.5">
												{THEME_CARDS.map((t) => (
													<button
														key={t.id}
														type="button"
														onClick={() => setMode(t.id)}
														className={cn(
															"flex cursor-pointer flex-col rounded-control border p-3 text-left transition-colors",
															mode === t.id ? "border-accent/40 bg-accent/5 ring-1 ring-accent/25 shadow-xs" : "border-border bg-surface hover:border-muted/40",
														)}
													>
														<div className="flex items-center justify-between">
															<span className="text-[12px] font-medium text-surface-foreground">{t.label}</span>
															<span
																className={cn(
																	"size-3 rounded-full border",
																	mode === t.id ? "border-accent bg-accent" : "border-border",
																)}
															/>
														</div>
														{t.desc && <span className="mt-1 text-[11px] text-faint">{t.desc}</span>}
													</button>
												))}
											</div>

											<div className="mt-2 flex items-center gap-2 text-[10.5px] text-faint">
												<span className="icon-[lucide--info] size-3" />
												当前生效：
												<span className="font-mono text-muted">{resolved === "dark" ? "深色 (dark)" : "浅色 (light)"}</span>
												{mode === "system" && <span>· 由系统外观偏好实时决定</span>}
											</div>
										</div>

										<div className="border-t border-border pt-4">
											<h3 className="text-[12.5px] font-semibold text-surface-foreground">强调色 (Accent Color)</h3>
											<p className="mt-0.5 text-[11.5px] text-muted">统领全局主按钮、激活指示条、聚焦光晕与高亮元素。</p>
											<div className="mt-3 grid grid-cols-4 sm:grid-cols-7 gap-2">
												{ACCENTS.map((a) => (
													<button
														key={a.id}
														type="button"
														onClick={() => {
															setAccent(a.id);
															toast({ title: `强调色已切换为「${a.name}」`, tone: "default" });
														}}
														className={cn(
															"flex cursor-pointer flex-col items-center gap-1.5 rounded-control border p-2.5 transition-all duration-150",
															accent === a.id
																? "border-accent bg-accent/10 shadow-xs ring-1 ring-accent/30"
																: "border-border bg-surface hover:border-surface-foreground/20 hover:bg-surface-raised",
														)}
													>
														<span className={cn("size-5 rounded-full ring-2 ring-offset-2 ring-offset-surface transition-transform", a.dot, accent === a.id ? "ring-accent scale-110" : "ring-transparent")} />
														<span className={cn("w-full truncate text-center text-[10.5px]", accent === a.id ? "font-semibold text-surface-foreground" : "font-medium text-muted")}>{a.name}</span>
													</button>
												))}
											</div>
										</div>

										<div className="border-t border-border pt-4">
											<div className="flex items-center justify-between">
												<div>
													<h3 className="text-[12.5px] font-semibold text-surface-foreground">界面显示密度</h3>
													<p className="mt-0.5 text-[11.5px] text-muted">微调侧栏、工具栏和列表项的标准行距与高度。</p>
												</div>
												<div className="flex h-7 items-center rounded border border-border bg-surface-sunk p-0.5 text-[11.5px]">
													<button
														type="button"
														onClick={() => setDensity("compact")}
														className={cn(
															"h-full cursor-pointer rounded px-2.5 font-medium transition-colors",
															density === "compact" ? "border border-border bg-surface-raised text-surface-foreground" : "text-muted",
														)}
													>
														紧凑 · 26px
													</button>
													<button
														type="button"
														onClick={() => setDensity("standard")}
														className={cn(
															"h-full cursor-pointer rounded px-2.5 font-medium transition-colors",
															density === "standard" ? "border border-border bg-surface-raised text-surface-foreground" : "text-muted",
														)}
													>
														标准 · 32px
													</button>
												</div>
											</div>
										</div>

										<div className="border-t border-border pt-4">
											<h3 className="text-[12.5px] font-semibold text-surface-foreground">UI 界面主字体</h3>
											<p className="mt-0.5 text-[11.5px] text-muted">自定义整个应用外壳的主无衬线字体，实时作用于 --font-sans。</p>
											<div className="mt-2.5 flex items-center gap-2">
												<Select
													value={uiFontFamily}
													onChange={(e) => setTerminal({ uiFontFamily: e.target.value })}
													className="flex-1"
												>
													{COMMON_UI_FONTS.map((font) => (
														<option key={font.value} value={font.value}>
															{font.label}
														</option>
													))}
												</Select>
												{uiFontFamily && (
													<Button size="sm" variant="ghost" onClick={() => setTerminal({ uiFontFamily: "" })}>
														重置为默认
													</Button>
												)}
											</div>
										</div>

										{/* 自定义 CSS 注入编辑器 (Netcatty 标志性特色) */}
										<div className="border-t border-border pt-4">
											<div className="flex items-center justify-between">
												<div>
													<h3 className="text-[12.5px] font-semibold text-surface-foreground">自定义 CSS 注入 (Custom CSS)</h3>
													<p className="mt-0.5 text-[11.5px] text-muted">
														编写个性化样式规则，实时注入到页面。可按 <kbd className="rounded border px-1 font-mono text-[10px]">Ctrl+Shift+I</kbd> 审查元素。
													</p>
												</div>
												{customCss && (
													<Button
														size="sm"
														variant="ghost"
														onClick={() => {
															setTerminal({ customCss: "" });
															toast({ title: "已清空自定义 CSS", tone: "default" });
														}}
													>
														清空
													</Button>
												)}
											</div>

											{/* 快捷模板按钮 */}
											<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
												<span className="text-[10.5px] text-faint">常用模板：</span>
												{CSS_TEMPLATES.map((tmpl) => (
													<button
														key={tmpl.label}
														type="button"
														onClick={() => {
															const next = customCss ? `${customCss.trim()}\n${tmpl.css}` : tmpl.css;
															setTerminal({ customCss: next });
															toast({ title: `已追加模板「${tmpl.label}」`, tone: "success" });
														}}
														className="rounded border border-border bg-surface-raised px-2 py-0.5 text-[10.5px] text-muted transition-colors hover:border-accent hover:text-accent"
													>
														+ {tmpl.label}
													</button>
												))}
											</div>

											<div className="mt-2">
												<Textarea
													rows={6}
													value={customCss}
													onChange={(e) => setTerminal({ customCss: e.target.value })}
													placeholder="/* 示例：覆盖终端间距或窗口样式 */&#10;.xterm-rows { line-height: 1.2 !important; }"
													className="w-full font-mono text-[11px] leading-relaxed"
													spellCheck={false}
												/>
											</div>
										</div>
									</div>
								)}

								{/* ------------------------- 2. 终端排版与渲染 ------------------------- */}
								{section === "terminal" && (
									<div className="max-w-2xl space-y-5">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">终端排版与渲染引擎</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">
												所有改动实时更新已打开的终端画布，并在下方预览中直观呈现。
											</p>
										</div>

										{/* 实时终端预览卡片 */}
										<div
											className={cn(
												"rounded-card border border-border p-3.5 font-mono shadow-xs transition-all",
												!preview && "bg-term text-term-ink",
											)}
											style={{
												fontFamily: `${fontFamily}, monospace`,
												fontSize: `${fontSize}px`,
												lineHeight,
												fontWeight,
												...(preview ? { background: preview.background, color: preview.foreground } : {}),
											}}
										>
											<div className="flex items-center justify-between border-b border-border/40 pb-2 mb-2 text-[10.5px] opacity-75">
												<span>{fontFamily} · {fontSize}px · {lineHeight}x · W{fontWeight} / B{fontWeightBold}</span>
												<span>{scheme === "theme" ? "跟随界面主题" : (SCHEME_CARDS.find((s) => s.id === scheme)?.name ?? scheme)}</span>
											</div>
											<div>
												<span className={cn(!preview && "text-success")} style={preview ? { color: preview.green } : undefined}>
													deploy@prod-cluster-01
												</span>
												<span className={cn(!preview && "text-muted")} style={preview ? { color: preview.brightBlack } : undefined}>
													:
												</span>
												<span className={cn(!preview && "text-accent")} style={preview ? { color: preview.blue } : undefined}>
													~/apps/service
												</span>
												<span className={cn(!preview && "text-muted")} style={preview ? { color: preview.brightBlack } : undefined}>
													${" "}
												</span>
												<span>tail -n 2 logs/app.log</span>
											</div>
											<div style={{ color: preview?.brightBlack ?? undefined }} className={cn(!preview && "text-muted")}>
												[12:04:51]{" "}
												<span style={{ fontWeight: fontWeightBold, color: drawBoldInBrightColors && preview ? preview.brightGreen : undefined }}>
													INFO
												</span>{" "}
												order-service worker online, pid=24188
											</div>
											<div style={{ color: preview?.brightBlack ?? undefined }} className={cn(!preview && "text-muted")}>
												[12:04:53]{" "}
												<span style={{ fontWeight: fontWeightBold, color: drawBoldInBrightColors && preview ? preview.brightYellow : undefined }}>
													WARN
												</span>{" "}
												latency spike detected: 42ms
											</div>
											<div className="mt-1 flex items-center">
												<span className={cn(!preview && "text-muted")} style={preview ? { color: preview.brightBlack } : undefined}>
													${" "}
												</span>
												<span
													className={cn(cursorShape, cursorBlink && "animate-pulse")}
													style={preview ? { background: preview.cursor } : undefined}
												/>
											</div>
										</div>

										{/* 字体、字号、行高 */}
										<div className="grid grid-cols-3 gap-3">
											<Field label="默认等宽字体" hint="支持系统已安装的 Nerd Fonts">
												<Select value={fontFamily} onChange={(e) => setTerminal({ fontFamily: e.target.value })}>
													{FONT_FAMILIES.map((f) => (
														<option key={f} value={f}>
															{f}
														</option>
													))}
												</Select>
											</Field>
											<Field label="字号 (px)">
												<Select value={String(fontSize)} onChange={(e) => setTerminal({ fontSize: Number(e.target.value) })}>
													{FONT_SIZES.map((s) => (
														<option key={s} value={s}>
															{s} px
														</option>
													))}
												</Select>
											</Field>
											<Field label="行高 (倍)">
												<Select value={String(lineHeight)} onChange={(e) => setTerminal({ lineHeight: Number(e.target.value) })}>
													{LINE_HEIGHTS.map((s) => (
														<option key={s} value={s}>
															{s}
														</option>
													))}
												</Select>
											</Field>
										</div>

										{/* 字重、粗体、光标 */}
										<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
											<SettingRow title="常规字重 (Regular)" description="普通文本的粗细级别 (100~900)">
												<Select
													value={String(fontWeight)}
													onChange={(e) => setTerminal({ fontWeight: Number(e.target.value) })}
													className="w-24"
												>
													{FONT_WEIGHTS.map((w) => (
														<option key={w} value={w}>
															{w}
														</option>
													))}
												</Select>
											</SettingRow>
											<SettingRow title="粗体字重 (Bold)" description="强调及加粗文本的粗细级别 (100~900)">
												<Select
													value={String(fontWeightBold)}
													onChange={(e) => setTerminal({ fontWeightBold: Number(e.target.value) })}
													className="w-24"
												>
													{FONT_WEIGHTS.map((w) => (
														<option key={w} value={w}>
															{w}
														</option>
													))}
												</Select>
											</SettingRow>
											<SettingRow title="粗体使用亮色 (Bright Colors)" description="粗体文字自动使用对应 ANSI 高亮色渲染">
												<Switch
													checked={drawBoldInBrightColors}
													onChange={(value) => setTerminal({ drawBoldInBrightColors: value })}
													label="粗体使用亮色"
												/>
											</SettingRow>
											<SettingRow title="光标样式" description="选择终端光标的呈现形状">
												<Segmented
													value={cursorStyle}
													onChange={(value) => setTerminal({ cursorStyle: value })}
													options={CURSOR_STYLES.map((style) => ({ value: style, label: CURSOR_LABEL[style] }))}
												/>
											</SettingRow>
											<SettingRow title="光标呼吸闪烁 (Blink)" description="启用光标规律呼吸闪烁动画">
												<Switch
													checked={cursorBlink}
													onChange={(value) => setTerminal({ cursorBlink: value })}
													label="光标呼吸闪烁"
												/>
											</SettingRow>
											<SettingRow title="最小对比度比例 (Contrast Ratio)" description="1 = 原生渲染；数值越高越强制提高极端配色下的文字清晰度">
												<Select
													value={String(minimumContrastRatio)}
													onChange={(e) => setTerminal({ minimumContrastRatio: Number(e.target.value) })}
													className="w-24"
												>
													{CONTRAST_CHOICES.map((value) => (
														<option key={value} value={value}>
															{value} {value === 1 ? "(关闭)" : ""}
														</option>
													))}
												</Select>
											</SettingRow>
										</div>

										{/* 缓冲与滚动 */}
										<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
											<SettingRow title="回滚行数（滚动缓冲）" description="保留的历史输出行数；行数越多占用内存越大">
												<Select
													value={scrollback}
													onChange={(e) => setTerminal({ scrollback: e.target.value as ScrollbackChoice })}
													className="w-48"
												>
													{SCROLLBACK_CHOICES.map((s) => (
														<option key={s} value={s}>
															{SCROLLBACK_LABEL[s]}
														</option>
													))}
												</Select>
											</SettingRow>
											<SettingRow title="输入时自动滚动" description="终端键入字符时视口自动跳回最底部">
												<Switch
													checked={scrollOnInput}
													onChange={(value) => setTerminal({ scrollOnInput: value })}
													label="输入时自动滚动"
												/>
											</SettingRow>
											<SettingRow title="平滑滚动 (Smooth Scroll)" description="鼠标滚轮滑动时使用平滑动画过渡">
												<Switch
													checked={smoothScrolling}
													onChange={(value) => setTerminal({ smoothScrolling: value })}
													label="平滑滚动"
												/>
											</SettingRow>
										</div>

										{/* 终端配色方案 */}
										<div>
											<h3 className="text-[12.5px] font-semibold text-surface-foreground">终端配色方案</h3>
											<p className="mt-0.5 text-[11.5px] text-muted">选择终端字符的 ANSI 色板与背景调性。</p>
											<div className="mt-3 grid grid-cols-3 gap-2">
												{SCHEME_CARDS.map((s) => (
													<button
														key={s.id}
														type="button"
														onClick={() => setTerminal({ scheme: s.id })}
														className={cn(
															"flex cursor-pointer flex-col gap-1.5 rounded-control border p-2 text-left transition-colors",
															scheme === s.id ? "border-accent bg-accent/10 shadow-xs ring-1 ring-accent/30" : "border-border bg-surface hover:border-muted/40",
														)}
													>
														<span className="flex items-center gap-1">
															{s.tones
																? s.tones.map((color) => (
																		<span key={color} className="h-1.5 flex-1 rounded-full" style={{ background: color }} />
																	))
																: THEME_TONES.map((tone) => (
																		<span key={tone} className={cn("h-1.5 flex-1 rounded-full", tone)} />
																	))}
														</span>
														<span className="flex items-center justify-between">
															<span className="truncate text-[11px] text-surface-foreground">{s.name}</span>
															{scheme === s.id && <span className="icon-[lucide--check] size-3 text-accent" />}
														</span>
													</button>
												))}
											</div>
										</div>
									</div>
								)}

								{/* ------------------------- 3. 终端交互行为 ------------------------- */}
								{section === "behavior" && (
									<div className="max-w-2xl space-y-5">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">终端交互与微观行为</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">全面对齐 Netcatty 的微观鼠标、键盘按键与复制粘贴规则。</p>
										</div>

										<Panel title={<><span className="icon-[lucide--mouse-pointer] size-3.5 text-accent" />鼠标与选区行为</>}>
											<SettingRow title="鼠标右键行为" description="在终端区域点击鼠标右键时执行的操作">
												<Segmented
													value={rightClick}
													onChange={(value) => setTerminal({ rightClick: value })}
													options={RIGHT_CLICK_ACTIONS.map((action) => ({ value: action, label: RIGHT_CLICK_LABEL[action] }))}
												/>
											</SettingRow>
											<SettingRow title="鼠标中键行为" description="在终端中按下鼠标滚轮中键时执行的操作">
												<Segmented
													value={middleClick}
													onChange={(value) => setTerminal({ middleClick: value })}
													options={MIDDLE_CLICK_ACTIONS.map((action) => ({ value: action, label: MIDDLE_CLICK_LABEL[action] }))}
												/>
											</SettingRow>
											<SettingRow title="在全屏应用中也显示菜单" description="tmux / vim 等抓取鼠标时仍弹出右键菜单（Shift+右键始终弹出）">
												<Switch
													checked={showContextMenuOverFullscreenApps}
													onChange={(value) => setTerminal({ showContextMenuOverFullscreenApps: value })}
													label="在全屏应用中也显示菜单"
												/>
											</SettingRow>
											<SettingRow title="选择即复制 (Copy on Select)" description="用鼠标选中文本后自动将内容复制到剪贴板">
												<Switch
													checked={copyOnSelect}
													onChange={(value) => setTerminal({ copyOnSelect: value })}
													label="选择即复制"
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--keyboard] size-3.5 text-accent" />键盘输入与剪贴板</>}>
											<SettingRow title="复制时去除末尾换行" description="避免意外粘贴命令直接在远端触发执行危险脚本">
												<Switch
													checked={trimNewline}
													onChange={(value) => setTerminal({ trimNewline: value })}
													label="复制时去除末尾换行"
												/>
											</SettingRow>
											<SettingRow title="单词分隔符 (Word Separators)" description="双击选词时作为分界断词的标点符号">
												<div className="flex items-center gap-1.5">
													<Input
														value={wordSeparators}
														onChange={(e) => setTerminal({ wordSeparators: e.target.value })}
														className="w-40 font-mono text-[11px]"
													/>
													<Button size="sm" variant="ghost" onClick={() => setTerminal({ wordSeparators: DEFAULT_WORD_SEPARATORS })}>
														重置
													</Button>
												</div>
											</SettingRow>
											<SettingRow title="将 Option 作为 Meta 键" description="macOS 上将 Option 键识别为 Alt/Meta 发送 ESC 前缀">
												<Switch
													checked={altAsMeta}
													onChange={(value) => setTerminal({ altAsMeta: value })}
													label="将 Option 作为 Meta 键"
												/>
											</SettingRow>
											<SettingRow title="禁用括号粘贴模式 (Bracketed Paste)" description="关闭后多行粘贴不再包裹 \e[200~ … \e[201~ 防转义头尾">
												<Switch
													checked={disableBracketedPaste}
													onChange={(value) => setTerminal({ disableBracketedPaste: value })}
													label="禁用括号粘贴模式"
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--terminal] size-3.5 text-accent" />会话、命令与智能预测</>}>
											<SettingRow title="标签页双击行为" description="双击顶部会话标签时执行的快捷动作">
												<Segmented
													value={tabDoubleClick}
													onChange={(value) => setTerminal({ tabDoubleClick: value })}
													options={TAB_DOUBLE_CLICK_ACTIONS.map((action) => ({ value: action, label: TAB_DOUBLE_CLICK_LABEL[action] }))}
												/>
											</SettingRow>
											<SettingRow title="clear 同时清空回滚历史" description="关闭后执行 clear 仅清空当前视口，保留滚动条历史">
												<Switch
													checked={clearWipesScrollback}
													onChange={(value) => setTerminal({ clearWipesScrollback: value })}
													label="clear 同时清空回滚历史"
												/>
											</SettingRow>
											<SettingRow title="终端响铃提示音 (Bell)" description="远端输出 BEL 字符时播放系统提示声音">
												<Switch
													checked={bell}
													onChange={(value) => setTerminal({ bell: value })}
													label="终端响铃提示音"
												/>
											</SettingRow>
											<SettingRow
												title="粘贴时自动上传剪贴板图片"
												description="当剪贴板为图片时，通过 SFTP 自动上传到远端当前目录并插入路径"
											>
												<Switch
													checked={autoUploadClipboardImageOnPaste}
													onChange={(value) => setTerminal({ autoUploadClipboardImageOnPaste: value })}
													label="粘贴时自动上传剪贴板图片"
												/>
											</SettingRow>
											<SettingRow title="命令预测与智能补全 (Warp 风格)" description="根据历史执行频次与 Snippets 实时弹出推荐补全气泡">
												<Switch
													checked={commandSuggestions}
													onChange={(value) => setTerminal({ commandSuggestions: value })}
													label="命令预测与智能补全"
												/>
											</SettingRow>
											<SettingRow title="行内幽灵文本预测 (Ghost Text)" description="在光标后呈现半透明淡灰色预测文字，按 Tab 或 → 键一键采纳">
												<Switch
													checked={ghostText}
													onChange={(value) => setTerminal({ ghostText: value })}
													label="行内幽灵文本预测"
												/>
											</SettingRow>
										</Panel>
									</div>
								)}

								{/* ------------------------- 4. 关键字高亮引擎 ------------------------- */}
								{section === "highlight" && (
									<div className="max-w-3xl space-y-5">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">关键字高亮引擎</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">
												实时扫描并高亮终端日志中的 ERROR, WARN, SUCCESS, IPv4, MAC 地址以及自定义正则模式。
											</p>
										</div>
										<KeywordHighlightSettings />
									</div>
								)}

								{/* ------------------------- 5. SFTP 文件传输 ------------------------- */}
								{section === "sftp" && (
									<div className="max-w-2xl space-y-5">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">SFTP 与远程文件传输</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">管理与终端的目录联动、双击行为、外部编辑器映射与列显示偏好。</p>
										</div>

										<Panel title={<><span className="icon-[lucide--workflow] size-3.5 text-accent" />终端协同与目录跟踪</>}>
											<SettingRow title="SFTP 联动跟随活跃终端" description="切换终端标签时，底部 SFTP 面板自动切换为对应主机的远程目录">
												<Switch
													checked={sftpFollowActiveTab}
													onChange={(value) => setTerminal({ sftpFollowActiveTab: value })}
													label="SFTP 联动跟随活跃终端"
												/>
											</SettingRow>
											<SettingRow title="跟随终端工作目录 (OSC 7)" description="打开侧栏 SFTP 时启用追随模式，终端执行 cd 后文件浏览器会自动跳转">
												<Switch
													checked={sftpFollowTerminalCwd}
													onChange={(value) => setTerminal({ sftpFollowTerminalCwd: value })}
													label="跟随终端工作目录"
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--file-text] size-3.5 text-accent" />文件操作与外部编辑</>}>
											<SettingRow title="SFTP 双击文件行为" description="选择在 SFTP 视图中双击文件时的默认动作">
												<Segmented
													value={sftpDoubleClickBehavior}
													onChange={(value) => setTerminal({ sftpDoubleClickBehavior: value as SftpDoubleClickBehavior })}
													options={[
														{ value: "open", label: "内置/关联程序打开" },
														{ value: "transfer", label: "传输到另一侧" },
													]}
												/>
											</SettingRow>
											<SettingRow title="外部编辑自动同步到远程" description="使用外部应用程序打开文件时，保存后自动将变更同步回远程服务器">
												<Switch
													checked={sftpAutoSync}
													onChange={(value) => setTerminal({ sftpAutoSync: value })}
													label="外部编辑自动同步到远程"
												/>
											</SettingRow>
											<SettingRow title="显示隐藏文件 (点文件)" description="浏览本地和远程文件系统时显示以点开头的隐藏文件">
												<Switch
													checked={sftpShowHiddenFiles}
													onChange={(value) => setTerminal({ sftpShowHiddenFiles: value })}
													label="显示隐藏文件"
												/>
											</SettingRow>
											<SettingRow title="目录优先置顶显示" description="文件列表排序时始终将文件夹排列在普通文件前面">
												<Switch
													checked={sftpDirectoriesFirst}
													onChange={(value) => setTerminal({ sftpDirectoriesFirst: value })}
													label="目录优先置顶显示"
												/>
											</SettingRow>
										</Panel>

										{/* 可见列配置 */}
										<Panel title={<><span className="icon-[lucide--table] size-3.5 text-accent" />列表显示列 (Visible Columns)</>}>
											<div className="divide-y divide-border/40">
												<div className="flex items-center justify-between px-3 py-2 text-[11px] text-faint">
													<span>名称列恒定显示</span>
													<Badge>必需</Badge>
												</div>
												{SFTP_COLUMNS_INFO.map((col) => (
													<SettingRow key={col.key} title={col.label} description={col.desc}>
														<Switch
															checked={sftpVisibleColumns[col.key]}
															onChange={(val) =>
																setTerminal({
																	sftpVisibleColumns: { ...sftpVisibleColumns, name: true, [col.key]: val },
																})
															}
															label={col.label}
														/>
													</SettingRow>
												))}
											</div>
										</Panel>

										{/* 文件关联打开方式 */}
										<Panel title={<><span className="icon-[lucide--square-arrow-out-up-right] size-3.5 text-accent" />文件打开方式映射</>}>
											{Object.keys(sftpFileOpeners).length === 0 ? (
												<div className="p-3 text-[11.5px] text-faint">暂无记住的扩展名关联规则</div>
											) : (
												<div className="divide-y divide-border/40 p-2">
													{Object.entries(sftpFileOpeners).map(([ext, opener]) => (
														<div key={ext} className="flex items-center justify-between py-1.5 px-2 text-[11.5px]">
															<span className="font-mono text-surface-foreground">.{ext}</span>
															<div className="flex items-center gap-3">
																<span className="text-muted">
																	{opener.type === "builtin-editor" ? "内置编辑器" : (opener.app?.name ?? "外部程序")}
																</span>
																<button
																	type="button"
																	className="text-faint hover:text-danger"
																	title="移除关联"
																	onClick={() => {
																		const next = { ...sftpFileOpeners };
																		delete next[ext];
																		setTerminal({ sftpFileOpeners: next });
																	}}
																>
																	<span className="icon-[lucide--x] size-3.5" />
																</button>
															</div>
														</div>
													))}
												</div>
											)}
										</Panel>
									</div>
								)}

								{/* ------------------------- 6. 快捷键绑定 ------------------------- */}
								{section === "shortcuts" && <ShortcutsSettings />}

								{/* ------------------------- 7. 安全与凭据库 ------------------------- */}
								{section === "security" && (
									<div className="max-w-2xl space-y-5">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">安全与主密码</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">
												解锁密码仅保存加盐 PBKDF2 摘要，TermX 从不落盘明文。
											</p>
										</div>

										<Panel title={<><span className="icon-[lucide--key-round] size-3.5 text-accent" />应用主锁</>}>
											<SettingRow
												title="解锁密码"
												description={hasPassword ? "已设置 · 锁屏与启动时需要验证" : "未设置，锁屏与自动锁定都不可用"}
											>
												<div className="flex items-center gap-2">
													<Button
														size="sm"
														icon="icon-[lucide--pencil]"
														disabled={!cryptoOk}
														onClick={() => {
															setPwdError(null);
															setPwdCurrent("");
															setPwdNew("");
															setPwdConfirm("");
															setPwdOpen(true);
														}}
													>
														{hasPassword ? "修改" : "设置"}
													</Button>
													{hasPassword && (
														<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={clearPassword}>
															清除
														</Button>
													)}
												</div>
											</SettingRow>
											<SettingRow title="立即锁定" description="按 Ctrl+Shift+L 随时锁屏（需先设置解锁密码）">
												<Button
													size="sm"
													icon="icon-[lucide--lock]"
													disabled={!hasPassword}
													onClick={() => useLockStore.getState().lock()}
												>
													锁定
												</Button>
											</SettingRow>
											<SettingRow title="启动时锁定应用" description="每次启动打开 TermX 后先要求输入解锁密码">
												<Switch
													checked={startLocked && hasPassword}
													disabled={!hasPassword}
													onChange={(value) => setSecurity({ startLocked: value })}
													label="启动时锁定应用"
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--timer] size-3.5 text-accent" />自动锁定与剪贴板防护</>}>
											<SettingRow title="闲置自动锁定" description="无任何键盘 / 鼠标操作达到设定时长后自动锁屏">
												<Select
													className="w-40"
													value={autoLock}
													disabled={!hasPassword}
													onChange={(e) => setSecurity({ autoLock: e.target.value as AutoLockChoice })}
												>
													{AUTO_LOCK_CHOICES.map((choice) => (
														<option key={choice} value={choice}>
															{AUTO_LOCK_LABEL[choice]}
														</option>
													))}
												</Select>
											</SettingRow>
											<SettingRow title="复制密码后清空剪贴板" description="在连接与凭据页复制密码 30 秒后自动清空系统剪贴板">
												<Switch
													checked={clearClipboard}
													onChange={(value) => setSecurity({ clearClipboard: value })}
													label="复制密码后清空剪贴板"
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--shield-check] size-3.5 text-accent" />凭据存储后端</>}>
											<SettingRow
												title="凭据存系统钥匙串"
												description="密码与私钥口令交给系统凭据管理器加密保管"
											>
												<Switch checked={keychain} onChange={toggleKeychain} label="凭据存系统钥匙串" />
											</SettingRow>
											<SettingRow
												title="当前后端"
												description={keychain ? "由操作系统统一硬件加密，TermX 内存不持久化明文" : "已停用：密码仅保存在本次会话内存中"}
											>
												<ReadonlyValue>{keychain ? KEYCHAIN_LABEL : "不保存"}</ReadonlyValue>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--file-key] size-3.5 text-accent" />主机公钥指纹策略</>}>
											<SettingRow
												title="指纹变化时阻断连接"
												description="主机公钥与本地记录不一致时立即阻断连接防范中间人攻击，由原生底层强制执行"
											>
												<Switch checked onChange={() => toast({ title: "该安全策略由内核强制开启，不可关闭", tone: "warning" })} label="指纹变化时阻断连接" />
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--shield-check] size-3.5 text-accent" />已知主机列表 (Known Hosts)</>}>
											<KnownHostsList />
										</Panel>
									</div>
								)}

								{/* ------------------------- 8. 系统与数据管理 ------------------------- */}
								{section === "data" && (
									<div className="max-w-2xl space-y-5">
										<div>
											<h2 className="text-[14px] font-semibold text-surface-foreground">系统集成与配置数据管理</h2>
											<p className="mt-0.5 text-[11.5px] text-muted">
												管理主机与设置的导出备份、OpenSSH 迁移、会话恢复及操作系统集成。
											</p>
										</div>

										{/* 会话恢复 (Netcatty 核心特色) */}
										<Panel title={<><span className="icon-[lucide--history] size-3.5 text-accent" />会话恢复 (Session Restore)</>}>
											<SettingRow
												title="启动时自动恢复会话"
												description="每次启动 TermX 时自动恢复上次退出时未关闭的会话标签页与主机"
											>
												<Switch
													checked={sessionRestore}
													onChange={(val) => {
														setTerminal({ sessionRestore: val });
														toast({ title: val ? "已开启启动会话自动恢复" : "已关闭会话恢复", tone: "default" });
													}}
													label="启动时自动恢复会话"
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--arrow-down-up] size-3.5 text-accent" />配置备份与迁移</>}>
											<SettingRow title="导出全部配置" description="主机、分组、密钥引用、片段、转发与偏好导出为未加密 JSON">
												<Button
													size="sm"
													icon="icon-[lucide--download]"
													onClick={() => {
														exportConfig();
														toast({ title: "已导出配置文件", description: "已保存至系统下载目录", tone: "success" });
													}}
												>
													导出备份
												</Button>
											</SettingRow>
											<SettingRow title="导入配置文件" description="同地址主机更新，其余自动新增合并">
												<Button
													size="sm"
													icon="icon-[lucide--upload]"
													disabled={importing}
													onClick={() => fileRef.current?.click()}
												>
													{importing ? "导入中…" : "选择文件导入"}
												</Button>
												<input
													ref={fileRef}
													type="file"
													accept=".json,.termx,application/json"
													className="hidden"
													onChange={(event) => {
														const file = event.target.files?.[0];
														event.target.value = "";
														if (file) void runImport(file);
													}}
												/>
											</SettingRow>
										</Panel>

										<Panel title={<><span className="icon-[lucide--square-terminal] size-3.5 text-accent" />导入 ~/.ssh/config</>}>
											<div className="space-y-3 px-3 py-3">
												<div className="flex items-end gap-2">
													<Field label="配置文件路径" className="flex-1">
														<Input value={sshConfigPath} onChange={(e) => setSshConfigPath(e.target.value)} spellCheck={false} />
													</Field>
													<Button
														variant="primary"
														icon="icon-[lucide--file-input]"
														disabled={sshImporting}
														onClick={() => void importSshConfig()}
													>
														{sshImporting ? "导入中…" : "一键导入"}
													</Button>
												</div>
												<p className="text-[10.5px] leading-4 text-faint">
													自动解析 Host 块的 HostName、User、Port、IdentityFile 与 ProxyJump；通配符及未命名块自动跳过。
												</p>
											</div>
										</Panel>

										{/* Windows 资源管理器右键集成 */}
										{detectPlatform() === "windows" && (
											<Panel title={<><span className="icon-[lucide--folder-symlink] size-3.5 text-accent" />Windows 资源管理器集成</>}>
												<SettingRow
													title="在资源管理器右键添加「在 TermX 中打开」"
													description="在任意文件夹空白处右键快速拉起 TermX 打开本地或远程终端"
												>
													<Button
														size="sm"
														icon="icon-[lucide--copy]"
														onClick={() => {
															const script = `reg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\TermX" /ve /d "在 TermX 中打开终端" /f\nreg add "HKCU\\Software\\Classes\\Directory\\Background\\shell\\TermX\\command" /ve /d "\\"%LOCALAPPDATA%\\termx\\TermX.exe\\" \\"%V\\"" /f`;
															navigator.clipboard.writeText(script);
															toast({ title: "已复制注册表命令到剪贴板", description: "可在 PowerShell 管理员窗口直接运行", tone: "success" });
														}}
													>
														复制注册命令
													</Button>
												</SettingRow>
											</Panel>
										)}

										<Panel title={<><span className="icon-[lucide--sparkles] size-3.5 text-accent" />关于与软件更新</>}>
											<SettingRow title="当前客户端版本" description={`${PLATFORM_LABEL} 架构原生构建`}>
												<div className="flex items-center gap-2">
													<span className="font-mono text-[11.5px] text-surface-foreground">v{__APP_VERSION__}</span>
													<Link
														to="/updater"
														className="flex h-6 items-center gap-1 rounded-control bg-accent px-2 text-[11.5px] font-medium text-accent-foreground"
													>
														<span className="icon-[lucide--zap] size-3" />
														检查新版本
													</Link>
												</div>
											</SettingRow>
										</Panel>
									</div>
								)}
							</>
						)}
					</div>
				</div>
			</div>

			{/* 设置 / 修改解锁密码弹窗 */}
			<Modal
				open={pwdOpen}
				onClose={() => setPwdOpen(false)}
				title={hasPassword ? "修改解锁密码" : "设置解锁密码"}
				icon="icon-[lucide--key-round]"
				footer={
					<>
						<Button onClick={() => setPwdOpen(false)}>取消</Button>
						<Button variant="primary" icon="icon-[lucide--check]" disabled={pwdBusy} onClick={() => void submitPassword()}>
							{pwdBusy ? "保存中…" : "确认"}
						</Button>
					</>
				}
			>
				<div className="space-y-3">
					{hasPassword && (
						<Field label="当前密码" required>
							<Input
								type="password"
								autoFocus
								value={pwdCurrent}
								onChange={(e) => setPwdCurrent(e.target.value)}
								placeholder="输入当前解锁密码"
							/>
						</Field>
					)}
					<Field label="新密码" hint="至少 8 位" required>
						<Input
							type="password"
							autoFocus={!hasPassword}
							value={pwdNew}
							onChange={(e) => setPwdNew(e.target.value)}
							placeholder="输入新的解锁密码"
						/>
					</Field>
					<Field label="确认新密码" required>
						<Input
							type="password"
							value={pwdConfirm}
							onChange={(e) => setPwdConfirm(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === "Enter") void submitPassword();
							}}
							placeholder="再次输入新密码"
						/>
					</Field>
					{pwdError && (
						<div className="flex items-center gap-1.5 rounded border border-danger/40 bg-danger/10 px-2.5 py-2 text-[10.5px] text-danger">
							<span className="icon-[lucide--triangle-alert] size-3.5 shrink-0" />
							{pwdError}
						</div>
					)}
				</div>
			</Modal>
		</WindowChrome>
	);
}
