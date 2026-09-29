import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button, Kbd } from "@/components/ui/Button";
import { Badge, Panel, ProgressBar, Segmented } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select } from "@/components/ui/Input";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { Checkbox, SettingRow, Switch } from "@/components/ui/Toggle";
import type { ThemeMode } from "@/data/types";
import { cn } from "@/lib/cn";
import { detectPlatform } from "@/lib/platform";
import { useThemeStore } from "@/store/theme";
import { toast } from "@/store/toast";
import { useEffect, useMemo, useState } from "react";

/** 运行平台：真实探测，不再写死「Windows x64」 */
const PLATFORM_LABEL = { windows: "Windows", macos: "macOS", linux: "Linux" }[detectPlatform()];
import { Link } from "react-router";

/* =============================================================================
 * 设置 —— 设计帧 termx.vetd/frames/settings.tsx 的交互版。
 * 左侧分区导航（外观 / 终端 / 快捷键 / 安全 / 数据）+ 右侧内容区。
 * 主题与密度写回 useThemeStore（真的生效），其余偏好用界面内局部 state。
 * ========================================================================== */

type Section = "appearance" | "terminal" | "shortcuts" | "security" | "data";
type DemoState = Section | "conflict";

const NAV: { id: Section; name: string; icon: string }[] = [
	{ id: "appearance", name: "外观与界面主题", icon: "icon-[lucide--palette]" },
	{ id: "terminal", name: "终端环境偏好", icon: "icon-[lucide--terminal]" },
	{ id: "shortcuts", name: "快捷键绑定", icon: "icon-[lucide--keyboard]" },
	{ id: "security", name: "安全与主密码", icon: "icon-[lucide--shield-check]" },
	{ id: "data", name: "数据与备份", icon: "icon-[lucide--database-backup]" },
];

const SECTION_TITLE: Record<Section, string> = {
	appearance: "外观与界面主题",
	terminal: "终端环境偏好",
	shortcuts: "快捷键绑定",
	security: "安全与主密码",
	data: "数据与备份",
};

const DEMO_OPTIONS: { value: DemoState; label: string }[] = [
	{ value: "appearance", label: "外观" },
	{ value: "terminal", label: "终端" },
	{ value: "shortcuts", label: "快捷键" },
	{ value: "conflict", label: "冲突" },
	{ value: "security", label: "安全" },
	{ value: "data", label: "数据" },
];

/* ------------------------------- 外观 ------------------------------- */

const THEME_CARDS: { id: ThemeMode; label: string; desc?: string }[] = [
	{ id: "dark", label: "深色模式 (Linear Dark)" },
	{ id: "light", label: "浅色模式 (Linear Light)" },
	{ id: "system", label: "跟随系统 (Auto)", desc: "自动同步操作系统外观偏好" },
];

/** 强调色只取 token 色板，禁止写死十六进制 */
const ACCENTS: { id: string; name: string; dot: string }[] = [
	{ id: "indigo", name: "Linear 经典靛蓝", dot: "bg-primary" },
	{ id: "cyan", name: "电光青", dot: "bg-accent" },
	{ id: "emerald", name: "翡翠绿", dot: "bg-success" },
	{ id: "amber", name: "琥珀金", dot: "bg-warning" },
	{ id: "rose", name: "玫瑰粉", dot: "bg-danger" },
	{ id: "steel", name: "金属银灰", dot: "bg-muted" },
];

/* ------------------------------- 终端 ------------------------------- */

const FONTS = ["JetBrains Mono", "Fira Code", "Cascadia Code", "SF Mono", "Menlo", "Consolas", "Sarasa Mono SC"];
const FONT_SIZES = ["11", "12", "13", "14", "15", "16", "18"];
const LINE_HEIGHTS = ["1.0", "1.2", "1.4", "1.6"];
const SCROLLBACKS = [
	{ value: "1000", label: "1,000 行" },
	{ value: "5000", label: "5,000 行" },
	{ value: "10000", label: "10,000 行（推荐）" },
	{ value: "50000", label: "50,000 行" },
	{ value: "unlimited", label: "不限制（占用内存）" },
];

/** 配色方案：预览色条只用 token 类，避免硬编码十六进制 */
const SCHEMES: { id: string; name: string; tone: string[] }[] = [
	{ id: "one-dark", name: "One Dark", tone: ["bg-primary", "bg-accent", "bg-success", "bg-warning"] },
	{ id: "dracula", name: "Dracula", tone: ["bg-danger", "bg-accent", "bg-warning", "bg-primary"] },
	{ id: "solarized", name: "Solarized Dark", tone: ["bg-accent", "bg-success", "bg-warning", "bg-muted"] },
	{ id: "nord", name: "Nord", tone: ["bg-accent", "bg-primary", "bg-muted", "bg-success"] },
	{ id: "gruvbox", name: "Gruvbox Dark", tone: ["bg-warning", "bg-danger", "bg-success", "bg-muted"] },
	{ id: "tokyo-night", name: "Tokyo Night", tone: ["bg-primary", "bg-accent", "bg-danger", "bg-muted"] },
	{ id: "catppuccin", name: "Catppuccin Mocha", tone: ["bg-danger", "bg-accent", "bg-warning", "bg-primary"] },
	{ id: "github-dark", name: "GitHub Dark", tone: ["bg-primary", "bg-success", "bg-muted", "bg-accent"] },
	{ id: "monokai", name: "Monokai Pro", tone: ["bg-danger", "bg-warning", "bg-success", "bg-accent"] },
];

type CursorStyle = "block" | "bar" | "underline";
type RightClick = "paste" | "menu" | "select";

/* ------------------------------ 快捷键 ------------------------------ */

interface Binding {
	id: string;
	group: string;
	name: string;
	desc: string;
	keys: string[];
}

const SHORTCUTS: Binding[] = [
	{ id: "palette", group: "通用", name: "命令面板", desc: "搜索主机、命令与设置", keys: ["Ctrl+K"] },
	{ id: "quick-connect", group: "通用", name: "快速连接", desc: "输入 user@host 直接连", keys: ["Ctrl+Shift+O"] },
	{ id: "settings", group: "通用", name: "设置", desc: "打开本页", keys: ["Ctrl+,"] },
	{ id: "new-tab", group: "标签与分屏", name: "新建标签", desc: "在当前窗口开新会话", keys: ["Ctrl+Shift+T"] },
	{ id: "close-tab", group: "标签与分屏", name: "关闭标签", desc: "关闭当前标签", keys: ["Ctrl+Shift+W"] },
	{ id: "switch-tab", group: "标签与分屏", name: "切换标签", desc: "循环 / 按序号跳转", keys: ["Ctrl+Tab", "Alt+1-9"] },
	{ id: "split-right", group: "标签与分屏", name: "向右分屏", desc: "垂直切分当前标签", keys: ["Ctrl+Shift+D"] },
	{ id: "split-down", group: "标签与分屏", name: "向下分屏", desc: "水平切分当前标签", keys: ["Ctrl+Shift+E"] },
	{ id: "focus-pane", group: "标签与分屏", name: "切换焦点格", desc: "在分屏之间移动焦点", keys: ["Alt+方向键"] },
	{ id: "copy-paste", group: "终端", name: "复制 / 粘贴", desc: "终端内复制与粘贴", keys: ["Ctrl+Shift+C", "Ctrl+Shift+V"] },
	{ id: "search", group: "终端", name: "终端内搜索", desc: "在回滚缓冲区里查找", keys: ["Ctrl+Shift+F"] },
	{ id: "broadcast", group: "终端", name: "广播输入", desc: "同屏所有格同步输入", keys: ["Ctrl+Shift+I"] },
	{ id: "font-size", group: "终端", name: "调整字号", desc: "放大 / 缩小 / 复位", keys: ["Ctrl+=", "Ctrl+-", "Ctrl+0"] },
	{ id: "toggle-sftp", group: "终端", name: "显示 / 隐藏 SFTP", desc: "底部文件面板", keys: ["Ctrl+Shift+S"] },
	{ id: "toggle-sidebar", group: "应用", name: "显示 / 隐藏侧栏", desc: "收起主机侧栏", keys: ["Ctrl+B"] },
	{ id: "lock", group: "应用", name: "锁定应用", desc: "立即锁屏", keys: ["Ctrl+Shift+L"] },
];

const GROUPS = [...new Set(SHORTCUTS.map((s) => s.group))];
const NAME_BY_ID = Object.fromEntries(SHORTCUTS.map((s) => [s.id, s.name]));

/** 归一化按键组合：修饰键排序，便于比较冲突 */
function normalizeKeys(combo: string) {
	const parts = combo
		.split("+")
		.map((p) => p.trim().toLowerCase())
		.filter(Boolean);
	const mods = parts.filter((p) => ["ctrl", "shift", "alt", "meta", "cmd"].includes(p)).sort();
	const rests = parts.filter((p) => !["ctrl", "shift", "alt", "meta", "cmd"].includes(p));
	return [...mods, ...rests].join("+");
}

function formatCombo(e: KeyboardEvent) {
	const mods: string[] = [];
	if (e.ctrlKey || e.metaKey) mods.push("Ctrl");
	if (e.shiftKey) mods.push("Shift");
	if (e.altKey) mods.push("Alt");
	if (mods.length === 0) return null;
	let key = e.key;
	if (key === " ") key = "Space";
	else if (key.length === 1) key = key.toUpperCase();
	else if (key === "Escape" || key === "Tab" || key === "Enter" || key === "Backspace") return null;
	return [...mods, key].join("+");
}

/* ------------------------------- 安全 ------------------------------- */

const KNOWN_HOSTS_SEED = [
	{ host: "order-api-01", addr: "10.0.3.21", algo: "ssh-ed25519", fp: "SHA256:9xQ2vB7kLm4pR1sT8uW3yA6cD0eF5gH2jK7nM" },
	{ host: "order-api-02", addr: "10.0.3.22", algo: "ssh-ed25519", fp: "SHA256:3tR8wE1yU6iO9pA4sD7fG2hJ5kL0zX3cV6bN" },
	{ host: "bastion-sh", addr: "203.0.113.9", algo: "ssh-rsa", fp: "SHA256:7hJ4kL1zX8cV5bN2mQ9wE6rT3yU0iO7pA4sD" },
	{ host: "pg-primary-01", addr: "10.0.3.40", algo: "ecdsa-sha2-nistp256", fp: "SHA256:1zX8cV5bN2mQ9wE6rT3yU0iO7pA4sD1fG8hJ" },
];

/* ============================================================================= */

export default function Settings() {
	const [section, setSection] = useState<Section>("shortcuts");
	const [demo, setDemo] = useState<DemoState>("conflict");

	/* 外观：主题与密度走 store，切换后立即生效 */
	const mode = useThemeStore((s) => s.mode);
	const resolved = useThemeStore((s) => s.resolved);
	const setMode = useThemeStore((s) => s.setMode);
	const density = useThemeStore((s) => s.density);
	const setDensity = useThemeStore((s) => s.setDensity);
	const [accent, setAccent] = useState("indigo");

	/* 终端 */
	const [font, setFont] = useState(FONTS[0]);
	const [fontSize, setFontSize] = useState("13");
	const [lineHeight, setLineHeight] = useState("1.4");
	const [scrollback, setScrollback] = useState("10000");
	const [cursor, setCursor] = useState<CursorStyle>("block");
	const [bell, setBell] = useState(true);
	const [trimNewline, setTrimNewline] = useState(true);
	const [rightClick, setRightClick] = useState<RightClick>("paste");
	const [scheme, setScheme] = useState("one-dark");

	/* 快捷键 */
	const [overrides, setOverrides] = useState<Record<string, string[]>>({});
	const [checked, setChecked] = useState(false);
	const [captureId, setCaptureId] = useState<string | null>(null);

	/* 安全 */
	const [masterPassword, setMasterPassword] = useState(true);
	const [autoLock, setAutoLock] = useState("15");
	const [keychain, setKeychain] = useState(true);
	const [startLocked, setStartLocked] = useState(false);
	const [clearClipboard, setClearClipboard] = useState(true);
	const [knownHosts, setKnownHosts] = useState(KNOWN_HOSTS_SEED);
	const [knownOpen, setKnownOpen] = useState(false);
	const [pwdOpen, setPwdOpen] = useState(false);

	/* 数据 */
	const [encryptedBackup, setEncryptedBackup] = useState(true);
	const [backupFreq, setBackupFreq] = useState("daily");
	const [sshConfig, setSshConfig] = useState("~/.ssh/config");
	const [dedupe, setDedupe] = useState(true);
	const [importing, setImporting] = useState(false);

	const keysOf = (row: Binding) => overrides[row.id] ?? row.keys;

	const conflicts = useMemo(() => {
		const map = new Map<string, string[]>();
		for (const row of SHORTCUTS) {
			for (const combo of keysOf(row)) {
				const norm = normalizeKeys(combo);
				map.set(norm, [...(map.get(norm) ?? []), row.id]);
			}
		}
		return new Map([...map].filter(([, ids]) => ids.length > 1));
	}, [overrides]);

	const conflictIds = useMemo(() => new Set([...conflicts.values()].flat()), [conflicts]);
	const conflictCount = conflicts.size;

	/** 状态切换器：跳到分区，或直接演示「快捷键冲突」态 */
	const applyDemo = (next: DemoState) => {
		setDemo(next);
		if (next === "conflict") {
			setSection("shortcuts");
			setOverrides({ search: ["Ctrl+Shift+O"] });
			setChecked(true);
			return;
		}
		setSection(next);
	};

	const detect = () => {
		setChecked(true);
		toast(
			conflictCount > 0
				? { title: `检测到 ${conflictCount} 组快捷键冲突`, description: "冲突项已在列表中高亮，请重新分配按键。", tone: "danger" }
				: { title: "未发现快捷键冲突", description: "全部绑定均可正常触发。", tone: "success" },
		);
	};

	/* 快捷键捕获：捕获阶段拦截，避免触发全局快捷键（Ctrl+K / Ctrl+B 等） */
	useEffect(() => {
		if (!captureId) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setCaptureId(null);
				return;
			}
			const combo = formatCombo(e);
			if (!combo) return;
			const id = captureId;
			setOverrides((prev) => ({ ...prev, [id]: [combo] }));
			setCaptureId(null);
			setChecked(false);
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [captureId]);

	const runImport = () => {
		setImporting(true);
		window.setTimeout(() => {
			setImporting(false);
			// 如实说明：读本机 ~/.ssh/config 需要文件系统访问，这一步还没接入
			toast({
				title: "尚未接入 ~/.ssh/config 解析",
				description: "解析本机 SSH 配置需要读取文件系统，还没有实现。",
				tone: "warning",
			});
		}, 600);
	};

	const cursorClass =
		cursor === "block"
			? "inline-block h-3.5 w-2 animate-pulse bg-term-ink align-middle"
			: cursor === "bar"
				? "inline-block h-3.5 w-0.5 animate-pulse bg-term-ink align-middle"
				: "inline-block h-0.5 w-2.5 animate-pulse bg-term-ink align-middle";

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧设置导航 (220px) */}
				<aside className="flex w-[220px] shrink-0 flex-col border-r border-border bg-surface-sunk p-2.5">
					<div className="px-2 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">系统偏好设置</div>
					<div className="mt-1 space-y-0.5">
						{NAV.map((n) => (
							<button
								key={n.id}
								type="button"
								onClick={() => applyDemo(n.id)}
								className={cn(
									"flex h-7.5 w-full cursor-pointer items-center gap-2 rounded border px-2.5 text-left text-[12px] transition-colors",
									section === n.id
										? "border-border bg-surface-raised font-medium text-surface-foreground shadow-sm"
										: "border-transparent text-muted hover:bg-surface hover:text-surface-foreground",
								)}
							>
								<span className={cn(n.icon, "size-3.5", section === n.id ? "text-primary" : "text-muted")} />
								<span className="truncate">{n.name}</span>
							</button>
						))}
					</div>

					{/* 版本入口：与设计帧的「关于与版本更新」呼应 */}
					<div className="mt-auto rounded border border-border bg-surface p-2.5">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--terminal] size-3.5 text-primary" />
							<span className="text-[11.5px] font-medium text-surface-foreground">TermX Desktop</span>
							<Badge>v{__APP_VERSION__}</Badge>
						</div>
						<div className="mt-1 font-mono text-[10px] text-faint">{PLATFORM_LABEL} · 本地配置</div>
						<Link
							to="/updater"
							className="mt-2 flex h-6 items-center justify-center gap-1 rounded-control border border-border bg-surface-raised text-[11px] font-medium text-muted transition-colors hover:text-surface-foreground"
						>
							<span className="icon-[lucide--sparkles] size-3" />
							查看版本更新
						</Link>
					</div>
				</aside>

				{/* 右侧设置内容区 */}
				<div className="flex min-w-0 flex-1 flex-col">
					{/* 右上角：分区标题 + 评审用状态切换器 */}
					<div className="flex h-9 shrink-0 items-center justify-between gap-3 px-6 pt-2">
						<span className="text-[10px] font-medium tracking-wider text-faint uppercase">{SECTION_TITLE[section]}</span>
						<div className="flex items-center gap-2">
							<span className="font-mono text-[10.5px] text-faint">状态</span>
							<Segmented value={demo} onChange={applyDemo} options={DEMO_OPTIONS} />
						</div>
					</div>

					<div className="min-h-0 flex-1 overflow-y-auto px-6 pt-2 pb-6">
						{/* ------------------------- 外观 ------------------------- */}
						{section === "appearance" && (
							<div className="max-w-2xl space-y-6">
								<div>
									<h2 className="text-[14px] font-semibold text-surface-foreground">外观与界面主题</h2>
									<p className="mt-0.5 text-[11.5px] text-muted">切换后立即生效并写入本地配置。</p>

									<div className="mt-3 grid grid-cols-3 gap-2.5">
										{THEME_CARDS.map((t) => (
											<button
												key={t.id}
												type="button"
												onClick={() => setMode(t.id)}
												className={cn(
													"flex cursor-pointer flex-col rounded-md border p-3 text-left transition-colors",
													mode === t.id ? "border-primary bg-surface-raised shadow-sm" : "border-border bg-surface hover:border-muted/40",
												)}
											>
												<div className="flex items-center justify-between">
													<span className="text-[12px] font-medium text-surface-foreground">{t.label}</span>
													<span
														className={cn(
															"size-3 rounded-full border",
															mode === t.id ? "border-primary bg-primary" : "border-border",
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
										{mode === "system" && <span>· 由系统外观偏好决定</span>}
									</div>
								</div>

								<div className="border-t border-border pt-4">
									<h3 className="text-[12.5px] font-semibold text-surface-foreground">系统强调色 (Accent Color)</h3>
									<div className="mt-3 grid grid-cols-6 gap-2">
										{ACCENTS.map((a) => (
											<button
												key={a.id}
												type="button"
												onClick={() => {
													setAccent(a.id);
													toast({ title: `强调色已切换为「${a.name}」`, description: "语法高亮与图标着色会在下次启动时完全生效。", tone: "default" });
												}}
												className={cn(
													"flex cursor-pointer flex-col items-center gap-1.5 rounded border p-2 transition-colors",
													accent === a.id ? "border-primary bg-surface-raised shadow-sm" : "border-border bg-surface hover:border-muted/40",
												)}
											>
												<span className={cn("size-5 rounded-full", a.dot)} />
												<span className="w-full truncate text-center text-[10.5px] font-medium text-muted">{a.name}</span>
											</button>
										))}
									</div>
								</div>

								<div className="border-t border-border pt-4">
									<div className="flex items-center justify-between">
										<div>
											<h3 className="text-[12.5px] font-semibold text-surface-foreground">界面显示密度</h3>
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
							</div>
						)}

						{/* ------------------------- 终端 ------------------------- */}
						{section === "terminal" && (
							<div className="max-w-2xl space-y-5">
								<div>
									<h2 className="text-[14px] font-semibold text-surface-foreground">终端环境偏好</h2>
									<p className="mt-0.5 text-[11.5px] text-muted">字体、配色与输入行为，对所有新建会话与分屏格生效。</p>
								</div>

								<div className="grid grid-cols-3 gap-3">
									<Field label="默认字体">
										<Select value={font} onChange={(e) => setFont(e.target.value)}>
											{FONTS.map((f) => (
												<option key={f} value={f}>
													{f}
												</option>
											))}
										</Select>
									</Field>
									<Field label="字号 (px)">
										<Select value={fontSize} onChange={(e) => setFontSize(e.target.value)}>
											{FONT_SIZES.map((s) => (
												<option key={s} value={s}>
													{s} px
												</option>
											))}
										</Select>
									</Field>
									<Field label="行高 (倍)">
										<Select value={lineHeight} onChange={(e) => setLineHeight(e.target.value)}>
											{LINE_HEIGHTS.map((s) => (
												<option key={s} value={s}>
													{s}
												</option>
											))}
										</Select>
									</Field>
								</div>

								{/* 实时预览：字体大小 / 行高 / 光标样式 / 配色方案一起体现 */}
								<div
									className="rounded-lg border border-border bg-term p-3 font-mono text-term-ink"
									style={{ fontSize: `${fontSize}px`, lineHeight }}
								>
									<div>
										<span className="text-success">deploy@order-api-01</span>
										<span className="text-muted">:</span>
										<span className="text-accent">~/apps/order-api</span>
										<span className="text-muted">$ </span>
										tail -f logs/app.log
									</div>
									<div className="text-muted">[12:04:51] INFO order-service started, pid=24188</div>
									<div className="text-muted">[12:04:53] INFO listening on 0.0.0.0:8080</div>
									<div>
										<span className="text-muted">$ </span>
										<span className={cursorClass} />
									</div>
								</div>

								<div className="grid grid-cols-2 gap-3">
									<Field label="回滚行数（滚动缓冲）" hint="越大越占内存">
										<Select value={scrollback} onChange={(e) => setScrollback(e.target.value)}>
											{SCROLLBACKS.map((s) => (
												<option key={s.value} value={s.value}>
													{s.label}
												</option>
											))}
										</Select>
									</Field>
									<Field label="光标样式">
										<Segmented
											className="h-7 w-full"
											value={cursor}
											onChange={setCursor}
											options={[
												{ value: "block", label: "块状" },
												{ value: "bar", label: "竖线" },
												{ value: "underline", label: "下划线" },
											]}
										/>
									</Field>
								</div>

								<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
									<SettingRow title="终端响铃" description="输出 BEL 字符时播放系统提示音">
										<Switch checked={bell} onChange={setBell} label="终端响铃" />
									</SettingRow>
									<SettingRow title="右键行为" description="在终端区域点击鼠标右键时执行的动作">
										<Segmented
											value={rightClick}
											onChange={setRightClick}
											options={[
												{ value: "paste", label: "粘贴" },
												{ value: "menu", label: "弹出菜单" },
												{ value: "select", label: "选中即复制" },
											]}
										/>
									</SettingRow>
									<SettingRow title="复制时去除末尾换行" description="避免粘贴到远端时直接执行命令">
										<Switch checked={trimNewline} onChange={setTrimNewline} label="复制时去除末尾换行" />
									</SettingRow>
								</div>

								<div>
									<h3 className="text-[12.5px] font-semibold text-surface-foreground">终端配色方案</h3>
									<div className="mt-2.5 grid grid-cols-3 gap-2">
										{SCHEMES.map((s) => (
											<button
												key={s.id}
												type="button"
												onClick={() => setScheme(s.id)}
												className={cn(
													"flex cursor-pointer flex-col gap-1.5 rounded border p-2 text-left transition-colors",
													scheme === s.id ? "border-primary bg-surface-raised shadow-sm" : "border-border bg-surface hover:border-muted/40",
												)}
											>
												<span className="flex items-center gap-1">
													{s.tone.map((t, i) => (
														<span key={`${s.id}-${i}`} className={cn("h-1.5 flex-1 rounded-full", t)} />
													))}
												</span>
												<span className="flex items-center justify-between">
													<span className="truncate text-[11px] text-surface-foreground">{s.name}</span>
													{scheme === s.id && <span className="icon-[lucide--check] size-3 text-primary" />}
												</span>
											</button>
										))}
									</div>
								</div>
							</div>
						)}

						{/* ------------------------ 快捷键 ------------------------ */}
						{section === "shortcuts" && (
							<div className="max-w-3xl space-y-4">
								<div className="flex items-start justify-between gap-4">
									<div>
										<h2 className="text-[14px] font-semibold text-surface-foreground">快捷键绑定</h2>
										<p className="mt-0.5 text-[11.5px] text-muted">
											点击按键可重新录制组合键（需带 Ctrl / Alt / Shift）。
										</p>
									</div>
									<div className="flex shrink-0 items-center gap-2">
										<Button icon="icon-[lucide--rotate-ccw]" onClick={() => { setOverrides({}); setChecked(false); toast({ title: "已恢复默认快捷键", tone: "default" }); }}>
											恢复默认
										</Button>
										<Button variant="primary" icon="icon-[lucide--search-check]" onClick={detect}>
											检测冲突
										</Button>
									</div>
								</div>

								{checked &&
									(conflictCount > 0 ? (
										<div className="flex items-start gap-2 rounded border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
											<span className="icon-[lucide--triangle-alert] mt-px size-3.5 shrink-0" />
											<div>
												<div className="font-medium">检测到 {conflictCount} 组快捷键冲突</div>
												<div className="mt-0.5 text-[10.5px]">
													{[...conflicts.values()]
														.map((ids) => ids.map((id) => NAME_BY_ID[id] ?? id).join(" 与 "))
														.join("；")}
													　绑定了相同的按键组合，后触发的命令会覆盖前者。
												</div>
											</div>
										</div>
									) : (
										<div className="flex items-center gap-2 rounded border border-success/40 bg-success/10 px-3 py-2 text-[11px] text-success">
											<span className="icon-[lucide--check] size-3.5" />
											未发现快捷键冲突，全部 {SHORTCUTS.length} 条绑定均可正常触发。
										</div>
									))}

								<div className="overflow-hidden rounded-lg border border-border bg-surface-raised shadow-sm">
									{GROUPS.map((group, gi) => (
										<div key={group}>
											<div
												className={cn(
													"flex items-center gap-1.5 px-3 py-1.5 font-mono text-[10px] font-medium tracking-wider text-faint uppercase",
													gi > 0 && "border-t border-border",
												)}
											>
												<span className="size-1 rounded-full bg-faint" />
												{group}
											</div>
											{SHORTCUTS.filter((s) => s.group === group).map((row) => {
												const overridden = Boolean(overrides[row.id]);
												const isConflict = checked && conflictIds.has(row.id);
												const keys = keysOf(row);
												return (
													<div
														key={row.id}
														className={cn(
															"flex items-center justify-between gap-3 border-t border-border px-3 py-1.5 transition-colors",
															isConflict && "bg-danger-soft",
														)}
													>
														<div className="flex min-w-0 items-baseline gap-2">
															<span
																className={cn(
																	"shrink-0 text-[11.5px]",
																	isConflict ? "font-medium text-danger" : "text-surface-foreground",
																)}
															>
																{row.name}
															</span>
															<span className="truncate text-[10.5px] text-faint">{row.desc}</span>
															{isConflict && <span className="shrink-0 font-mono text-[10px] text-danger">冲突</span>}
														</div>
														<div className="flex shrink-0 items-center gap-1.5">
															{captureId === row.id ? (
																<span className="animate-pulse rounded border border-primary/50 bg-primary/10 px-1.5 py-px font-mono text-[10px] text-primary">
																	按下组合键…（Esc 取消）
																</span>
															) : (
																keys.map((k) => (
																	<button
																		key={k}
																		type="button"
																		onClick={() => setCaptureId(row.id)}
																		title="点击重新绑定"
																		className="cursor-pointer"
																	>
																		<Kbd className={cn(isConflict && "border-danger/50 text-danger")}>{k}</Kbd>
																	</button>
																))
															)}
															{overridden && (
																<button
																	type="button"
																	title="恢复该项默认"
																	aria-label="恢复该项默认"
																	onClick={() => {
																		setOverrides((prev) => {
																			const next = { ...prev };
																			delete next[row.id];
																			return next;
																		});
																		setChecked(false);
																	}}
																	className="flex size-5 cursor-pointer items-center justify-center rounded text-faint transition-colors hover:bg-surface hover:text-surface-foreground"
																>
																	<span className="icon-[lucide--rotate-ccw] size-3" />
																</button>
															)}
														</div>
													</div>
												);
											})}
										</div>
									))}
								</div>
							</div>
						)}

						{/* ------------------------- 安全 ------------------------- */}
						{section === "security" && (
							<div className="max-w-2xl space-y-5">
								<div>
									<h2 className="text-[14px] font-semibold text-surface-foreground">安全与主密码</h2>
									<p className="mt-0.5 text-[11.5px] text-muted">
										忘记主密码只能重置并重新录入凭据。
									</p>
								</div>

								<Panel title={<><span className="icon-[lucide--key-round] size-3.5 text-primary" />主密码</>}>
									<SettingRow title="启用主密码" description={masterPassword ? "已启用 · 上次修改 2026-09-18" : "未启用，启动时直接进入工作台"}>
										<Switch checked={masterPassword} onChange={setMasterPassword} label="启用主密码" />
									</SettingRow>
									<SettingRow title="主密码强度" description="12 位，含大小写字母、数字与符号">
										<div className="flex items-center gap-2">
											<span className="flex h-1.5 w-24 items-center gap-0.5">
												<span className="h-full flex-1 rounded-full bg-success" />
												<span className="h-full flex-1 rounded-full bg-success" />
												<span className="h-full flex-1 rounded-full bg-success" />
												<span className="h-full flex-1 rounded-full bg-success" />
												<span className="h-full flex-1 rounded-full bg-border" />
											</span>
											<Button
												size="sm"
												icon="icon-[lucide--pencil]"
												disabled={!masterPassword}
												onClick={() => setPwdOpen(true)}
											>
												修改主密码
											</Button>
										</div>
									</SettingRow>
									<SettingRow title="启动时锁定应用" description="打开 TermX 后先要求输入主密码（Ctrl+Shift+L 可随时锁定）">
										<Switch checked={startLocked} onChange={setStartLocked} label="启动时锁定应用" />
									</SettingRow>
								</Panel>

								<Panel title={<><span className="icon-[lucide--timer] size-3.5 text-primary" />自动锁定</>}>
									<SettingRow title="闲置自动锁定" description="无键盘 / 鼠标操作达到设定时长后自动锁屏">
										<Select className="w-40" value={autoLock} onChange={(e) => setAutoLock(e.target.value)}>
											<option value="1">1 分钟</option>
											<option value="5">5 分钟</option>
											<option value="15">15 分钟</option>
											<option value="30">30 分钟</option>
											<option value="60">1 小时</option>
											<option value="never">永不锁定</option>
										</Select>
									</SettingRow>
									<SettingRow title="复制密码后清空剪贴板" description="敏感字段复制 30 秒后自动清除系统剪贴板">
										<Switch checked={clearClipboard} onChange={setClearClipboard} label="复制密码后清空剪贴板" />
									</SettingRow>
								</Panel>

								<Panel title={<><span className="icon-[lucide--shield-check] size-3.5 text-primary" />凭据存储</>}>
									<SettingRow title="凭据存系统钥匙串" description="密码与私钥口令交给 Windows 凭据管理器 / macOS Keychain 保管">
										<Switch checked={keychain} onChange={setKeychain} label="凭据存系统钥匙串" />
									</SettingRow>
									<SettingRow title="存储后端" description={keychain ? "由操作系统统一加密，TermX 不落盘明文" : "退化为本地加密文件（主密码派生密钥）"}>
										<ReadonlyValue>{keychain ? "Windows Credential Manager" : "~/.termx/vault.enc"}</ReadonlyValue>
									</SettingRow>
								</Panel>

								<Panel
									title={<><span className="icon-[lucide--file-key] size-3.5 text-primary" />known_hosts 管理</>}
									actions={
										<Button size="sm" icon="icon-[lucide--external-link]" onClick={() => setKnownOpen(true)}>
											打开管理
										</Button>
									}
								>
									<SettingRow
										title="已信任的主机指纹"
										description={`${knownHosts.length} 条记录 · 首次连接确认后的指纹会写入此处`}
									>
										<span className="font-mono text-[11px] text-muted">~/.ssh/known_hosts</span>
									</SettingRow>
									<SettingRow title="指纹变化时阻断连接" description="检测到主机公钥变化时拒绝连接并提示风险">
										<Switch checked onChange={() => toast({ title: "该安全策略不可关闭", tone: "warning" })} label="指纹变化时阻断连接" />
									</SettingRow>
								</Panel>
							</div>
						)}

						{/* ------------------------- 数据 ------------------------- */}
						{section === "data" && (
							<div className="max-w-2xl space-y-5">
								<div>
									<h2 className="text-[14px] font-semibold text-surface-foreground">数据与备份</h2>
									<p className="mt-0.5 text-[11.5px] text-muted">
										导出文件默认使用主密码派生的密钥加密。
									</p>
								</div>

								<Panel title={<><span className="icon-[lucide--arrow-down-up] size-3.5 text-primary" />配置导入与导出</>}>
									<SettingRow title="导出全部配置" description="主机、分组、片段、密钥引用与界面偏好（.termx 包）">
										<Button
											size="sm"
											icon="icon-[lucide--download]"
											onClick={() => toast({ title: "已导出 termx-backup-20260929.termx", description: "共 18 台主机 · 24 条片段（已加密）。", tone: "success" })}
										>
											导出
										</Button>
									</SettingRow>
									<SettingRow title="导入配置" description="支持 .termx 包与旧版 JSON，冲突时按主机地址合并">
										<Button
											size="sm"
											icon="icon-[lucide--upload]"
											onClick={() => toast({ title: "已选择 termx-backup-20260924.termx", description: "解析完成，等待确认合并策略。", tone: "default" })}
										>
											选择文件
										</Button>
									</SettingRow>
								</Panel>

								<Panel title={<><span className="icon-[lucide--lock] size-3.5 text-primary" />加密备份</>}>
									<SettingRow title="启用加密备份" description="AES-256-GCM，密钥由主密码派生（Argon2id）">
										<Switch checked={encryptedBackup} onChange={setEncryptedBackup} label="启用加密备份" />
									</SettingRow>
									<SettingRow title="备份频率" description="备份文件保留最近 7 份，超出后滚动删除">
										<Select
											className="w-40"
											value={backupFreq}
											disabled={!encryptedBackup}
											onChange={(e) => setBackupFreq(e.target.value)}
										>
											<option value="exit">每次退出时</option>
											<option value="daily">每天</option>
											<option value="weekly">每周</option>
											<option value="manual">仅手动</option>
										</Select>
									</SettingRow>
									<SettingRow title="最近一次备份" description="~/TermX/backups/termx-20260929-0200.bak">
										<div className="flex items-center gap-2">
											<span className="flex items-center gap-1.5 font-mono text-[11px] text-success">
												<span className="size-1.5 rounded-full bg-success" />
												今天 02:00 · 8.4 MB
											</span>
											<Button
												size="sm"
												icon="icon-[lucide--database-backup]"
												disabled={!encryptedBackup}
												onClick={() => toast({ title: "已开始加密备份", tone: "success" })}
											>
												立即备份
											</Button>
										</div>
									</SettingRow>
								</Panel>

								<Panel title={<><span className="icon-[lucide--square-terminal] size-3.5 text-primary" />导入 ~/.ssh/config</>}>
									<div className="space-y-3 px-3 py-3">
										<div className="flex items-end gap-2">
											<Field label="配置文件路径" hint="支持通配与 Include 指令" className="flex-1">
												<Input value={sshConfig} onChange={(e) => setSshConfig(e.target.value)} spellCheck={false} />
											</Field>
											<Button variant="primary" icon="icon-[lucide--file-input]" disabled={importing} onClick={runImport}>
												{importing ? "解析中…" : "导入"}
											</Button>
										</div>

										<Checkbox
											checked={dedupe}
											onChange={setDedupe}
											label="按 Host 别名去重，已存在的主机只更新地址与端口"
										/>

										{importing && <ProgressBar value={70} />}
									</div>
								</Panel>

								<Panel title={<><span className="icon-[lucide--sparkles] size-3.5 text-primary" />关于与版本更新</>}>
									<SettingRow title="当前版本" description={`${PLATFORM_LABEL} · 更新服务尚未接入`}>
										<div className="flex items-center gap-2">
											<span className="font-mono text-[11.5px] text-surface-foreground">v{__APP_VERSION__}</span>
											<Link
												to="/updater"
												className="flex h-6 items-center gap-1 rounded-control bg-primary px-2 text-[11.5px] font-medium text-primary-foreground"
											>
												<span className="icon-[lucide--zap] size-3" />
												检查更新
											</Link>
										</div>
									</SettingRow>
								</Panel>
							</div>
						)}
					</div>
				</div>
			</div>

			{/* 修改主密码 */}
			<Modal
				open={pwdOpen}
				onClose={() => setPwdOpen(false)}
				title="修改主密码"
				icon="icon-[lucide--key-round]"
				footer={
					<>
						<Button onClick={() => setPwdOpen(false)}>取消</Button>
						<Button
							variant="primary"
							icon="icon-[lucide--check]"
							onClick={() => {
								setPwdOpen(false);
								toast({ title: "主密码已更新", description: "凭据库已用新密钥重新加密。", tone: "success" });
							}}
						>
							确认修改
						</Button>
					</>
				}
			>
				<div className="space-y-3">
					<Field label="当前主密码" required>
						<Input type="password" defaultValue="••••••••••••" />
					</Field>
					<Field label="新主密码" hint="至少 12 位" required>
						<Input type="password" placeholder="输入新的主密码" />
					</Field>
					<Field label="确认新主密码" required>
						<Input type="password" placeholder="再次输入" />
					</Field>
					<div className="flex items-center gap-1.5 rounded border border-warning/40 bg-warning/10 px-2.5 py-2 text-[10.5px] text-warning">
						<span className="icon-[lucide--triangle-alert] size-3.5 shrink-0" />
						修改主密码会重新加密本地凭据库，已同步的备份需要用新密码才能打开。
					</div>
				</div>
			</Modal>

			{/* known_hosts 管理 */}
			<Drawer
				open={knownOpen}
				onClose={() => setKnownOpen(false)}
				title="known_hosts 管理"
				subtitle="~/.ssh/known_hosts · 首次连接确认后的指纹"
				width={520}
				footer={
					<>
						<Button onClick={() => setKnownOpen(false)}>关闭</Button>
						<Button
							variant="danger"
							icon="icon-[lucide--trash-2]"
							onClick={() => {
								setKnownHosts([]);
								toast({ title: "已清空全部指纹记录", description: "下次连接所有主机都会重新确认指纹。", tone: "warning" });
							}}
						>
							清空全部
						</Button>
					</>
				}
			>
				<div className="divide-y divide-border">
					{knownHosts.length === 0 ? (
						<div className="flex flex-col items-center gap-1.5 px-4 py-10 text-center">
							<span className="icon-[lucide--shield-off] size-5 text-faint" />
							<span className="text-[12px] text-surface-foreground">没有已信任的指纹</span>
							<span className="text-[11px] text-muted">下次连接任意主机时都会弹出指纹确认。</span>
						</div>
					) : (
						knownHosts.map((k) => (
							<div key={k.host} className="flex items-center justify-between gap-3 px-4 py-2.5">
								<div className="min-w-0">
									<div className="flex items-center gap-2">
										<span className="text-[12px] font-medium text-surface-foreground">{k.host}</span>
										<Badge>{k.algo}</Badge>
									</div>
									<div className="mt-0.5 truncate font-mono text-[10.5px] text-faint">
										{k.addr} · {k.fp}
									</div>
								</div>
								<button
									type="button"
									title="删除该指纹"
									aria-label="删除该指纹"
									onClick={() => {
										setKnownHosts((prev) => prev.filter((x) => x.host !== k.host));
										toast({ title: `已移除 ${k.host} 的指纹记录`, tone: "warning" });
									}}
									className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-danger"
								>
									<span className="icon-[lucide--trash-2] size-3.5" />
								</button>
							</div>
						))
					)}
				</div>
			</Drawer>
		</WindowChrome>
	);
}
