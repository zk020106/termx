import { WindowChrome } from "@/components/chrome/WindowChrome";
import { TERMINAL_SCHEMES, schemeColors, schemeTones } from "@/components/terminal/terminalSchemes";
import { Button, Kbd } from "@/components/ui/Button";
import { Badge, Panel, Segmented } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { SettingRow, Switch } from "@/components/ui/Toggle";
import {
	AUTO_LOCK_CHOICES,
	CURSOR_STYLES,
	FONT_FAMILIES,
	FONT_SIZES,
	LINE_HEIGHTS,
	RIGHT_CLICK_ACTIONS,
	SCROLLBACK_CHOICES,
	type AutoLockChoice,
	type CursorStyle,
	type RightClickAction,
	type ScrollbackChoice,
	type TerminalSchemeId,
} from "@/data/preferences";
import type { Accent, ThemeMode } from "@/data/types";
import { cn } from "@/lib/cn";
import { exportConfig, mergeConfig, parseConfigFile } from "@/lib/configBackup";
import { createVerifier, lockCryptoAvailable, verifyPassword } from "@/lib/lock";
import { detectPlatform } from "@/lib/platform";
import { useLockStore } from "@/store/lock";
import { useSettingsStore } from "@/store/settings";
import { useThemeStore } from "@/store/theme";
import { toast } from "@/store/toast";
import { useRef, useState } from "react";
import { Link } from "react-router";

/** 运行平台：真实探测，不再写死「Windows x64」 */
const PLATFORM_LABEL = { windows: "Windows", macos: "macOS", linux: "Linux" }[detectPlatform()];

/** 系统钥匙串的落地名字，跟随平台 */
const KEYCHAIN_LABEL = {
	windows: "Windows 凭据管理器",
	macos: "macOS 钥匙串",
	linux: "Secret Service",
}[detectPlatform()];

/* =============================================================================
 * 设置 —— 设计帧 termx.vetd/frames/settings.tsx 的交互版。
 * 左侧分区导航（外观 / 终端 / 快捷键 / 安全 / 数据）+ 右侧内容区。
 *
 * 这一页不放假控件：能接真的就接到真实链路（主题/强调色/密度 → useThemeStore，
 * 终端偏好与安全/数据偏好 → useSettingsStore → 配置文件 + xterm 运行时选项），
 * 暂时没有落地路径的（读取 ~/.ssh/config、known_hosts 列表、定时加密备份）
 * 直接禁用并写明原因，绝不返回「看起来成功」的假提示。
 * ========================================================================== */

type Section = "appearance" | "terminal" | "shortcuts" | "security" | "data";

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

/* ------------------------------- 外观 ------------------------------- */

const THEME_CARDS: { id: ThemeMode; label: string; desc?: string }[] = [
	{ id: "dark", label: "深色模式 (Linear Dark)" },
	{ id: "light", label: "浅色模式 (Linear Light)" },
	{ id: "system", label: "跟随系统 (Auto)", desc: "自动同步操作系统外观偏好" },
];

/** 强调色只取 token 色板，禁止写死十六进制；
 *  dot 用各自的色板 token，六个点才各显本色，而不是当前选中色。 */
const ACCENTS: { id: Accent; name: string; dot: string }[] = [
	{ id: "indigo", name: "Linear 经典靛蓝", dot: "bg-swatch-indigo" },
	{ id: "cyan", name: "电光青", dot: "bg-swatch-cyan" },
	{ id: "emerald", name: "翡翠绿", dot: "bg-swatch-emerald" },
	{ id: "amber", name: "琥珀金", dot: "bg-swatch-amber" },
	{ id: "rose", name: "玫瑰粉", dot: "bg-swatch-rose" },
	{ id: "steel", name: "金属银灰", dot: "bg-swatch-steel" },
];

/* ------------------------------- 终端 ------------------------------- */

const SCROLLBACK_LABEL: Record<ScrollbackChoice, string> = {
	"1000": "1,000 行",
	"5000": "5,000 行",
	"10000": "10,000 行（推荐）",
	"50000": "50,000 行",
	unlimited: "不限制（占用内存）",
};

const CURSOR_LABEL: Record<CursorStyle, string> = { block: "块状", bar: "竖线", underline: "下划线" };
const RIGHT_CLICK_LABEL: Record<RightClickAction, string> = { paste: "粘贴", menu: "弹出菜单", select: "选中即复制" };
const AUTO_LOCK_LABEL: Record<AutoLockChoice, string> = {
	never: "永不锁定",
	"1": "1 分钟",
	"5": "5 分钟",
	"15": "15 分钟",
	"30": "30 分钟",
	"60": "1 小时",
};

/** 配色方案卡片：第一项跟随界面主题（token 派生），其余用各自真实色板 */
const SCHEME_CARDS: { id: TerminalSchemeId; name: string; tones: string[] | null }[] = [
	{ id: "theme", name: "跟随界面主题", tones: null },
	...TERMINAL_SCHEMES.map((scheme) => ({ id: scheme.id, name: scheme.name, tones: schemeTones(scheme.colors) })),
];

/** 「跟随界面主题」时预览用的 token 类 */
const THEME_TONES = ["bg-primary", "bg-accent", "bg-success", "bg-warning", "bg-muted"];

/* ------------------------------ 快捷键 ------------------------------ */

interface Binding {
	id: string;
	group: string;
	name: string;
	desc: string;
	keys: string[];
}

/** 快捷键总表（只读参考）：实际响应在各界面里，改绑尚未接线 */
const SHORTCUTS: Binding[] = [
	{ id: "palette", group: "通用", name: "命令面板", desc: "搜索主机、命令与设置", keys: ["Ctrl+K"] },
	{ id: "quick-connect", group: "通用", name: "快速连接", desc: "输入 user@host 直接连", keys: ["Ctrl+Shift+O"] },
	{ id: "settings", group: "通用", name: "设置", desc: "打开本页", keys: ["Ctrl+,"] },
	{ id: "new-tab", group: "标签与分屏", name: "新建标签", desc: "在当前窗口开新会话", keys: ["Ctrl+Shift+T"] },
	{ id: "close-tab", group: "标签与分屏", name: "关闭标签", desc: "关闭当前标签", keys: ["Ctrl+Shift+W"] },
	{ id: "switch-tab", group: "标签与分屏", name: "切换标签", desc: "循环 / 按序号跳转", keys: ["Ctrl+Tab", "Alt+1-9"] },
	{ id: "split-right", group: "标签与分屏", name: "向右分屏", desc: "垂直切分当前标签", keys: ["Ctrl+Shift+D"] },
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

/* ============================================================================= */

export default function Settings() {
	const [section, setSection] = useState<Section>("shortcuts");

	/* 外观：主题、强调色与密度都走 store，切换后立即生效并写入配置文件 */
	const mode = useThemeStore((s) => s.mode);
	const resolved = useThemeStore((s) => s.resolved);
	const setMode = useThemeStore((s) => s.setMode);
	const density = useThemeStore((s) => s.density);
	const setDensity = useThemeStore((s) => s.setDensity);
	const accent = useThemeStore((s) => s.accent);
	const setAccent = useThemeStore((s) => s.setAccent);

	/* 终端 / 安全 / 数据偏好：全部来自 settings store（改动立即生效 + 写盘） */
	const fontFamily = useSettingsStore((s) => s.fontFamily);
	const fontSize = useSettingsStore((s) => s.fontSize);
	const lineHeight = useSettingsStore((s) => s.lineHeight);
	const scrollback = useSettingsStore((s) => s.scrollback);
	const cursorStyle = useSettingsStore((s) => s.cursorStyle);
	const bell = useSettingsStore((s) => s.bell);
	const rightClick = useSettingsStore((s) => s.rightClick);
	const trimNewline = useSettingsStore((s) => s.trimNewline);
	const scheme = useSettingsStore((s) => s.scheme);
	const sftpFollowActiveTab = useSettingsStore((s) => s.sftpFollowActiveTab);
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

	/* 修改解锁密码的弹窗 */
	const [pwdOpen, setPwdOpen] = useState(false);
	const [pwdCurrent, setPwdCurrent] = useState("");
	const [pwdNew, setPwdNew] = useState("");
	const [pwdConfirm, setPwdConfirm] = useState("");
	const [pwdError, setPwdError] = useState<string | null>(null);
	const [pwdBusy, setPwdBusy] = useState(false);

	/* 导入配置文件 */
	const fileRef = useRef<HTMLInputElement | null>(null);
	const [importing, setImporting] = useState(false);

	const preview = schemeColors(scheme);

	const cursorShape =
		cursorStyle === "block"
			? "inline-block h-3.5 w-2 animate-pulse align-middle"
			: cursorStyle === "bar"
				? "inline-block h-3.5 w-0.5 animate-pulse align-middle"
				: "inline-block h-0.5 w-2.5 animate-pulse align-middle";

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
			// 只保存加盐摘要，密码本身不落盘
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
		// 密码没了就锁不上，相关的锁定设置一起收回，避免留下开不了的开关
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
		} catch (error) {
			toast({ title: "导入失败", description: error instanceof Error ? error.message : "文件读不动", tone: "danger" });
		} finally {
			setImporting(false);
		}
	};

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
								onClick={() => setSection(n.id)}
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
					<div className="flex h-9 shrink-0 items-center gap-3 px-6 pt-2">
						<span className="text-[10px] font-medium tracking-wider text-faint uppercase">{SECTION_TITLE[section]}</span>
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
									<h3 className="text-[12.5px] font-semibold text-surface-foreground">强调色</h3>
									<div className="mt-3 grid grid-cols-6 gap-2">
										{ACCENTS.map((a) => (
											<button
												key={a.id}
												type="button"
												onClick={() => {
													setAccent(a.id);
													toast({ title: `强调色已切换为「${a.name}」`, tone: "default" });
												}}
												className={cn(
													"flex cursor-pointer flex-col items-center gap-1.5 rounded border p-2 transition-colors",
													accent === a.id ? "border-accent bg-surface-raised shadow-sm" : "border-border bg-surface hover:border-muted/40",
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
									<p className="mt-0.5 text-[11.5px] text-muted">改动立即作用到已打开的终端，并写入本地配置。</p>
								</div>

								<div className="grid grid-cols-3 gap-3">
									<Field label="默认字体">
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

								{/* 实时预览：字体大小 / 行高 / 光标样式 / 配色方案一起体现 */}
								<div
									className={cn("rounded-lg border border-border p-3 font-mono", !preview && "bg-term text-term-ink")}
									style={{
										fontSize: `${fontSize}px`,
										lineHeight,
										...(preview ? { background: preview.background, color: preview.foreground } : {}),
									}}
								>
									<div>
										<span className={cn(!preview && "text-success")} style={preview ? { color: preview.green } : undefined}>
											deploy@order-api-01
										</span>
										<span className={cn(!preview && "text-muted")} style={preview ? { color: preview.brightBlack } : undefined}>
											:
										</span>
										<span className={cn(!preview && "text-accent")} style={preview ? { color: preview.blue } : undefined}>
											~/apps/order-api
										</span>
										<span className={cn(!preview && "text-muted")} style={preview ? { color: preview.brightBlack } : undefined}>
											${" "}
										</span>
										tail -f logs/app.log
									</div>
									<div style={preview ? { color: preview.brightBlack } : undefined} className={cn(!preview && "text-muted")}>
										[12:04:51] INFO order-service started, pid=24188
									</div>
									<div style={preview ? { color: preview.brightBlack } : undefined} className={cn(!preview && "text-muted")}>
										[12:04:53] INFO listening on 0.0.0.0:8080
									</div>
									<div>
										<span className={cn(!preview && "text-muted")} style={preview ? { color: preview.brightBlack } : undefined}>
											${" "}
										</span>
										<span
											className={cn(cursorShape, !preview && "bg-term-ink")}
											style={preview ? { background: preview.cursor } : undefined}
										/>
									</div>
								</div>

								<div className="grid grid-cols-2 gap-3">
									<Field label="回滚行数（滚动缓冲）" hint="越大越占内存">
										<Select value={scrollback} onChange={(e) => setTerminal({ scrollback: e.target.value as ScrollbackChoice })}>
											{SCROLLBACK_CHOICES.map((s) => (
												<option key={s} value={s}>
													{SCROLLBACK_LABEL[s]}
												</option>
											))}
										</Select>
									</Field>
									<Field label="光标样式">
										<Segmented
											className="h-7 w-full"
											value={cursorStyle}
											onChange={(value) => setTerminal({ cursorStyle: value })}
											options={CURSOR_STYLES.map((style) => ({ value: style, label: CURSOR_LABEL[style] }))}
										/>
									</Field>
								</div>

								<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
									<SettingRow title="终端响铃" description="输出 BEL 字符时播放提示音">
										<Switch checked={bell} onChange={(value) => setTerminal({ bell: value })} label="终端响铃" />
									</SettingRow>
									<SettingRow title="右键行为" description="在终端区域点击鼠标右键时执行的动作">
										<Segmented
											value={rightClick}
											onChange={(value) => setTerminal({ rightClick: value })}
											options={RIGHT_CLICK_ACTIONS.map((action) => ({ value: action, label: RIGHT_CLICK_LABEL[action] }))}
										/>
									</SettingRow>
									<SettingRow title="复制时去除末尾换行" description="避免粘贴到远端时直接执行命令">
										<Switch
											checked={trimNewline}
											onChange={(value) => setTerminal({ trimNewline: value })}
											label="复制时去除末尾换行"
										/>
									</SettingRow>
									<SettingRow title="SFTP 联动跟随活跃终端" description="切换终端标签时，底部 SFTP 面板自动切换为对应主机的远程目录">
										<Switch
											checked={sftpFollowActiveTab}
											onChange={(value) => setTerminal({ sftpFollowActiveTab: value })}
											label="SFTP 联动跟随活跃终端"
										/>
									</SettingRow>
								</div>

								<div>
									<h3 className="text-[12.5px] font-semibold text-surface-foreground">终端配色方案</h3>
									<div className="mt-2.5 grid grid-cols-3 gap-2">
										{SCHEME_CARDS.map((s) => (
											<button
												key={s.id}
												type="button"
												onClick={() => setTerminal({ scheme: s.id })}
												className={cn(
													"flex cursor-pointer flex-col gap-1.5 rounded border p-2 text-left transition-colors",
													scheme === s.id ? "border-primary bg-surface-raised shadow-sm" : "border-border bg-surface hover:border-muted/40",
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
								<div>
									<h2 className="text-[14px] font-semibold text-surface-foreground">快捷键绑定</h2>
									<p className="mt-0.5 text-[11.5px] text-muted">由各界面固定响应，改绑尚未接线。</p>
								</div>

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
											{SHORTCUTS.filter((s) => s.group === group).map((row) => (
												<div
													key={row.id}
													className="flex items-center justify-between gap-3 border-t border-border px-3 py-1.5"
												>
													<div className="flex min-w-0 items-baseline gap-2">
														<span className="shrink-0 text-[11.5px] text-surface-foreground">{row.name}</span>
														<span className="truncate text-[10.5px] text-faint">{row.desc}</span>
													</div>
													<div className="flex shrink-0 items-center gap-1.5">
														{row.keys.map((k) => (
															<Kbd key={k}>{k}</Kbd>
														))}
													</div>
												</div>
											))}
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
									<p className="mt-0.5 text-[11.5px] text-muted">解锁密码只保存加盐摘要，忘记只能在下方重设。</p>
								</div>

								<Panel
									title={
										<>
											<span className="icon-[lucide--key-round] size-3.5 text-primary" />
											应用锁
										</>
									}
								>
									<SettingRow
										title="解锁密码"
										description={hasPassword ? "已设置 · 锁屏时需要输入" : "未设置，锁屏与自动锁定都不可用"}
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
									<SettingRow title="立即锁定" description="Ctrl+Shift+L 随时可用（需先设置解锁密码）">
										<Button
											size="sm"
											icon="icon-[lucide--lock]"
											disabled={!hasPassword}
											onClick={() => useLockStore.getState().lock()}
										>
											锁定
										</Button>
									</SettingRow>
									<SettingRow title="启动时锁定应用" description="打开 TermX 后先要求输入解锁密码">
										<Switch
											checked={startLocked && hasPassword}
											disabled={!hasPassword}
											onChange={(value) => setSecurity({ startLocked: value })}
											label="启动时锁定应用"
										/>
									</SettingRow>
								</Panel>

								<Panel
									title={
										<>
											<span className="icon-[lucide--timer] size-3.5 text-primary" />
											自动锁定
										</>
									}
								>
									<SettingRow title="闲置自动锁定" description="无键盘 / 鼠标操作达到设定时长后自动锁屏">
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
									<SettingRow title="复制密码后清空剪贴板" description="连接页复制密码 30 秒后自动清空系统剪贴板">
										<Switch
											checked={clearClipboard}
											onChange={(value) => setSecurity({ clearClipboard: value })}
											label="复制密码后清空剪贴板"
										/>
									</SettingRow>
								</Panel>

								<Panel
									title={
										<>
											<span className="icon-[lucide--shield-check] size-3.5 text-primary" />
											凭据存储
										</>
									}
								>
									<SettingRow
										title="凭据存系统钥匙串"
										description="密码与私钥口令交给系统凭据管理器保管"
									>
										<Switch checked={keychain} onChange={toggleKeychain} label="凭据存系统钥匙串" />
									</SettingRow>
									<SettingRow
										title="存储后端"
										description={keychain ? "由操作系统统一加密，TermX 不落盘明文" : "已停用：密码只留在当前会话内存里"}
									>
										<ReadonlyValue>{keychain ? KEYCHAIN_LABEL : "不保存"}</ReadonlyValue>
									</SettingRow>
								</Panel>

								<Panel
									title={
										<>
											<span className="icon-[lucide--file-key] size-3.5 text-primary" />
											主机指纹
										</>
									}
								>
									<SettingRow
										title="指纹变化时阻断连接"
										description="主机公钥与记录不一致时拒绝连接并提示风险，由原生层强制执行"
									>
										<Switch checked onChange={() => toast({ title: "该安全策略不可关闭", tone: "warning" })} label="指纹变化时阻断连接" />
									</SettingRow>
									<SettingRow title="已信任的主机指纹" description="首次连接确认后写入原生 known_hosts；列表与删除需要新增原生命令，尚未接线">
										<span className="font-mono text-[11px] text-muted">不可列出</span>
									</SettingRow>
								</Panel>
							</div>
						)}

						{/* ------------------------- 数据 ------------------------- */}
						{section === "data" && (
							<div className="max-w-2xl space-y-5">
								<div>
									<h2 className="text-[14px] font-semibold text-surface-foreground">数据与备份</h2>
									<p className="mt-0.5 text-[11.5px] text-muted">导出为未加密 JSON；导入按主机地址合并。</p>
								</div>

								<Panel
									title={
										<>
											<span className="icon-[lucide--arrow-down-up] size-3.5 text-primary" />
											配置导入与导出
										</>
									}
								>
									<SettingRow title="导出全部配置" description="主机、分组、密钥引用、片段、转发与偏好（未加密，含主机地址与用户名）">
										<Button
											size="sm"
											icon="icon-[lucide--download]"
											onClick={() => {
												exportConfig();
												toast({ title: "已导出配置文件", description: "保存到系统下载目录", tone: "success" });
											}}
										>
											导出
										</Button>
									</SettingRow>
									<SettingRow title="导入配置" description="同地址的主机更新，其余新增；本机偏好不导入">
										<Button
											size="sm"
											icon="icon-[lucide--upload]"
											disabled={importing}
											onClick={() => fileRef.current?.click()}
										>
											{importing ? "导入中…" : "选择文件"}
										</Button>
										<input
											ref={fileRef}
											type="file"
											accept=".json,.termx,application/json"
											className="hidden"
											onChange={(event) => {
												const file = event.target.files?.[0];
												// 清空 value：连续选同一个文件也能再次触发
												event.target.value = "";
												if (file) void runImport(file);
											}}
										/>
									</SettingRow>
								</Panel>

								<Panel
									title={
										<>
											<span className="icon-[lucide--lock] size-3.5 text-primary" />
											定时加密备份
										</>
									}
								>
									<SettingRow
										title="备份服务"
										description="定时导出并加密存放需要一个备份服务进程（含调度、保留策略与主密码派生密钥），尚未实现"
									>
										<ReadonlyValue>未接入</ReadonlyValue>
									</SettingRow>
								</Panel>

								<Panel
									title={
										<>
											<span className="icon-[lucide--square-terminal] size-3.5 text-primary" />
											导入 ~/.ssh/config
										</>
									}
								>
									<div className="space-y-3 px-3 py-3">
										<div className="flex items-end gap-2">
											<Field label="配置文件路径" className="flex-1">
												<Input value={sshConfigPath} onChange={(e) => setSshConfigPath(e.target.value)} spellCheck={false} />
											</Field>
											<Button variant="primary" icon="icon-[lucide--file-input]" disabled>
												导入
											</Button>
										</div>
										<p className="text-[10.5px] leading-4 text-faint">
											读取本机文件需要新增原生命令（Rust 端 fs 读取），本轮未接线，按钮已禁用。
										</p>
									</div>
								</Panel>

								<Panel
									title={
										<>
											<span className="icon-[lucide--sparkles] size-3.5 text-primary" />
											关于与版本更新
										</>
									}
								>
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

			{/* 设置 / 修改解锁密码 */}
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
							placeholder="再次输入"
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
