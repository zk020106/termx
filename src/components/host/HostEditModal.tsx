import { Button } from "@/components/ui/Button";
import { Checkbox, Switch } from "@/components/ui/Toggle";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { type AuthMethod, type Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { getHostVisual } from "@/lib/hostVisual";
import { secretDelete, secretLoad, secretSave } from "@/lib/secret";
import { useHostsStore } from "@/store/hosts";
import { useKeysStore } from "@/store/keys";
import { toast } from "@/store/toast";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

export interface HostEditModalProps {
	open: boolean;
	hostId?: string | null;
	initialGroupId?: string | null;
	onClose: () => void;
	onSaved?: (host: Host, andConnect?: boolean) => void;
}

type TabKey = "basic" | "auth" | "network" | "advanced" | "appearance";

interface TabItemDef {
	id: TabKey;
	label: string;
	icon: string;
	desc: string;
}

const TABS: TabItemDef[] = [
	{ id: "basic", label: "基本连接", icon: "icon-[lucide--server]", desc: "主机、地址与分组" },
	{ id: "auth", label: "身份凭据", icon: "icon-[lucide--key-round]", desc: "密码、私钥与验证" },
	{ id: "network", label: "跳板与代理", icon: "icon-[lucide--waypoints]", desc: "ProxyJump 与网络隧道" },
	{ id: "advanced", label: "高级选项", icon: "icon-[lucide--sliders]", desc: "编码、保活与脚本" },
	{ id: "appearance", label: "终端外观", icon: "icon-[lucide--palette]", desc: "主题、字体与光标" },
];

const AUTH_OPTIONS: { value: AuthMethod; label: string; icon: string }[] = [
	{ value: "password", label: "密码认证", icon: "icon-[lucide--lock]" },
	{ value: "key", label: "公私钥", icon: "icon-[lucide--key]" },
	{ value: "key-passphrase", label: "私钥+口令", icon: "icon-[lucide--shield-alert]" },
	{ value: "agent", label: "SSH Agent", icon: "icon-[lucide--bot]" },
	{ value: "keyboard-interactive", label: "键盘交互", icon: "icon-[lucide--keyboard]" },
];

const OS_PRESETS: { value: string; label: string; icon: string; color: string }[] = [
	{ value: "auto", label: "自动识别", icon: "icon-[lucide--cpu]", color: "text-muted" },
	{ value: "ubuntu", label: "Ubuntu", icon: "icon-[simple-icons--ubuntu]", color: "text-[#E95420]" },
	{ value: "debian", label: "Debian", icon: "icon-[simple-icons--debian]", color: "text-[#D70A53]" },
	{ value: "centos", label: "CentOS", icon: "icon-[simple-icons--centos]", color: "text-[#9391FF]" },
	{ value: "redhat", label: "Red Hat", icon: "icon-[simple-icons--redhat]", color: "text-[#EE0000]" },
	{ value: "alpine", label: "Alpine", icon: "icon-[simple-icons--alpinelinux]", color: "text-[#00D1FF]" },
	{ value: "arch", label: "Arch Linux", icon: "icon-[simple-icons--archlinux]", color: "text-[#1793D1]" },
	{ value: "aws", label: "AWS EC2", icon: "icon-[simple-icons--amazonec2]", color: "text-[#FF9900]" },
	{ value: "aliyun", label: "阿里云", icon: "icon-[lucide--cloud]", color: "text-[#FF6A00]" },
	{ value: "tencent", label: "腾讯云", icon: "icon-[lucide--cloud]", color: "text-primary" },
	{ value: "docker", label: "Docker", icon: "icon-[simple-icons--docker]", color: "text-[#2496ED]" },
	{ value: "windows", label: "Windows", icon: "icon-[simple-icons--windows]", color: "text-[#0078D4]" },
	{ value: "macos", label: "macOS", icon: "icon-[simple-icons--apple]", color: "text-muted" },
	{ value: "linux", label: "通用 Linux", icon: "icon-[simple-icons--linux]", color: "text-amber-500" },
];

const COLOR_SCHEMES = [
	{ id: "One Dark", bg: "#282c34", fg: "#abb2bf" },
	{ id: "Dracula", bg: "#282a36", fg: "#f8f8f2" },
	{ id: "Nord", bg: "#2e3440", fg: "#d8dee9" },
	{ id: "Solarized Dark", bg: "#002b36", fg: "#839496" },
	{ id: "Gruvbox Dark", bg: "#282828", fg: "#ebdbb2" },
	{ id: "Monokai", bg: "#272822", fg: "#f8f8f2" },
];

const CURSOR_OPTIONS: { value: "block" | "bar" | "underline"; label: string }[] = [
	{ value: "block", label: "方块 █" },
	{ value: "bar", label: "竖线 ｜" },
	{ value: "underline", label: "下划线  " },
];

interface FormState {
	name: string;
	hostname: string;
	port: string;
	username: string;
	groupId: string;
	tags: string;
	favorite: boolean;
	osPreset: string;
	authMethod: AuthMethod;
	password: string;
	rememberPassword: boolean;
	keyId: string;
	keyPath: string;
	passphrase: string;
	jumpHostIds: string[];
	encoding: string;
	termType: string;
	proxyEnabled: boolean;
	proxyType: "socks5" | "http";
	proxyHost: string;
	proxyPort: string;
	envVars: { key: string; value: string }[];
	loginScript: string;
	colorScheme: string;
	fontFamily: string;
	fontSize: string;
	lineHeight: string;
	cursorStyle: "block" | "bar" | "underline";
}

export function HostEditModal({ open, hostId, initialGroupId, onClose, onSaved }: HostEditModalProps) {
	const navigate = useNavigate();
	const hosts = useHostsStore((s) => s.hosts);
	const groups = useHostsStore((s) => s.groups);
	const addGroup = useHostsStore((s) => s.addGroup);
	const upsertHost = useHostsStore((s) => s.upsertHost);
	const removeHost = useHostsStore((s) => s.removeHost);
	const keys = useKeysStore((s) => s.keys);

	const isEditing = Boolean(hostId && hostId !== "new");
	const targetHost = useMemo(() => {
		if (!isEditing || !hostId) return null;
		return hosts.find((h) => h.id === hostId) ?? null;
	}, [isEditing, hostId, hosts]);

	const [tab, setTab] = useState<TabKey>("basic");
	const [form, setForm] = useState<FormState>(() => toForm(targetHost, keys[0]?.id, initialGroupId));
	const [initial, setInitial] = useState<FormState>(() => toForm(targetHost, keys[0]?.id, initialGroupId));
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [showPassword, setShowPassword] = useState(false);
	const [showPassphrase, setShowPassphrase] = useState(false);
	const [creatingGroup, setCreatingGroup] = useState(false);
	const [newGroupName, setNewGroupName] = useState("");
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [discardConfirm, setDiscardConfirm] = useState(false);

	const isDirty = useMemo(() => JSON.stringify(form) !== JSON.stringify(initial), [form, initial]);

	// 重置与初始化表单
	useEffect(() => {
		if (!open) {
			setConfirmDelete(false);
			setDiscardConfirm(false);
			setCreatingGroup(false);
			return;
		}
		const initialValues = toForm(targetHost, keys[0]?.id, initialGroupId);
		setForm(initialValues);
		setInitial(initialValues);
		setErrors({});
		setTab("basic");
		setShowPassword(false);
		setShowPassphrase(false);

		if (targetHost && targetHost.auth.rememberPassword) {
			void secretLoad(targetHost.id).then((saved) => {
				if (saved) {
					setForm((f) => ({ ...f, password: saved }));
					setInitial((f) => ({ ...f, password: saved }));
				}
			});
		}
	}, [open, targetHost, keys]);

	// 键盘快捷键监听 (Esc / Ctrl+Enter)
	useEffect(() => {
		if (!open) return;
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				e.preventDefault();
				if (isDirty) {
					setDiscardConfirm(true);
				} else {
					onClose();
				}
			} else if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
				e.preventDefault();
				handleSave(false);
			}
		};
		window.addEventListener("keydown", handleKeyDown);
		return () => window.removeEventListener("keydown", handleKeyDown);
	}, [open, isDirty, form]);

	const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
		setForm((prev) => ({ ...prev, [key]: value }));
		if (errors[key]) {
			setErrors((prev) => {
				const next = { ...prev };
				delete next[key];
				return next;
			});
		}
	};

	const handleCreateGroup = () => {
		const trimmed = newGroupName.trim();
		if (!trimmed) {
			setCreatingGroup(false);
			return;
		}
		const group = addGroup(trimmed);
		setNewGroupName("");
		setCreatingGroup(false);
		update("groupId", group.id);
		toast({ title: `已创建分组「${group.name}」`, tone: "success" });
	};

	// 智能实时预览视觉图标
	const currentVisual = useMemo(() => {
		const tempHost: Host = {
			id: targetHost?.id ?? "preview",
			name: form.name || form.hostname || "Server",
			groupId: null,
			hostname: form.hostname,
			port: Number(form.port) || 22,
			username: form.username || "root",
			tags: form.tags.split(/[,，\s]+/).filter(Boolean),
			favorite: form.favorite,
			os: form.osPreset !== "auto" ? { name: form.osPreset, icon: "" } : targetHost?.os,
			auth: { method: form.authMethod },
			jumpHostIds: form.jumpHostIds,
			reachable: true,
		};
		return getHostVisual(tempHost);
	}, [form, targetHost]);

	// 校验表单
	const validateForm = (): boolean => {
		const newErrors: Record<string, string> = {};
		if (!form.name.trim()) newErrors.name = "主机名称不能为空";
		if (!form.hostname.trim()) newErrors.hostname = "连接地址不能为空";
		const p = Number(form.port);
		if (!/^\d+$/.test(form.port.trim()) || !Number.isInteger(p) || p < 1 || p > 65535) {
			newErrors.port = "端口需在 1~65535 范围内";
		}
		setErrors(newErrors);
		if (Object.keys(newErrors).length > 0) {
			setTab("basic");
			return false;
		}
		return true;
	};

	// 保存配置
	const handleSave = async (andConnect: boolean = false) => {
		if (!validateForm()) return;

		const tagsList = form.tags
			.split(/[,，\s]+/)
			.map((t) => t.trim())
			.filter(Boolean);

		const record: Host = {
			id: targetHost?.id ?? `host-${Date.now().toString(36)}`,
			name: form.name.trim(),
			groupId: form.groupId || null,
			hostname: form.hostname.trim(),
			port: Number(form.port) || 22,
			username: form.username.trim() || "root",
			tags: tagsList,
			favorite: form.favorite,
			os: form.osPreset !== "auto" ? { name: form.osPreset, icon: "" } : targetHost?.os,
			spec: targetHost?.spec,
			auth: {
				method: form.authMethod,
				keyId:
					form.authMethod === "key" || form.authMethod === "key-passphrase"
						? form.keyId || keys[0]?.id
						: undefined,
				keyPath:
					form.authMethod === "key" || form.authMethod === "key-passphrase"
						? form.keyPath.trim() || undefined
						: undefined,
				rememberPassword: form.authMethod === "password" ? form.rememberPassword : targetHost?.auth.rememberPassword,
				password:
					form.authMethod === "password"
						? form.rememberPassword && form.password
							? form.password
							: undefined
						: targetHost?.auth.password,
			},
			jumpHostIds: form.jumpHostIds,
			proxy: form.proxyEnabled
				? {
						type: form.proxyType,
						host: form.proxyHost.trim() || "127.0.0.1",
						port: Number(form.proxyPort) || 1080,
				  }
				: null,
			encoding: form.encoding,
			termType: form.termType,
			envVars: form.envVars.filter((v) => v.key.trim() !== ""),
			loginScript: form.loginScript,
			terminal: {
				colorScheme: form.colorScheme,
				fontFamily: form.fontFamily,
				fontSize: Number(form.fontSize) || 13,
				lineHeight: Number(form.lineHeight) || 1.5,
				cursorStyle: form.cursorStyle,
			},
			lastConnectedAt: targetHost?.lastConnectedAt,
			latencyMs: targetHost?.latencyMs,
			reachable: targetHost?.reachable ?? false,
		};

		upsertHost(record);

		// 密码安全凭据存储
		if (form.authMethod === "password") {
			if (form.rememberPassword && form.password) {
				await secretSave(record.id, form.password).catch(() => undefined);
			} else if (!form.rememberPassword) {
				await secretDelete(record.id).catch(() => undefined);
			}
		}

		toast({
			title: isEditing ? `已保存主机「${record.name}」` : `已创建主机「${record.name}」`,
			description: `${record.username}@${record.hostname}:${record.port}`,
			tone: "success",
		});

		onSaved?.(record, andConnect);
		onClose();
	};

	// 删除主机
	const handleDelete = () => {
		if (!targetHost) return;
		removeHost(targetHost.id);
		void secretDelete(targetHost.id).catch(() => undefined);
		toast({ title: `已删除主机「${targetHost.name}」`, tone: "default" });
		setConfirmDelete(false);
		onClose();
	};

	if (!open) return null;

	const jumpCandidates = hosts.filter((h) => h.id !== targetHost?.id && !form.jumpHostIds.includes(h.id));

	return (
		<div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 animate-in fade-in duration-150 select-none">
			{/* 遮罩背景点击 */}
			<div
				className="absolute inset-0 -z-10"
				onClick={() => {
					if (isDirty) setDiscardConfirm(true);
					else onClose();
				}}
			/>

			{/* 模态主窗体 (规范标准尺寸 760px x 600px) */}
			<div
				role="dialog"
				aria-modal="true"
				className="relative flex h-[620px] max-h-[92vh] w-[780px] max-w-[95vw] flex-col overflow-hidden rounded-2xl border border-border/80 bg-surface shadow-2xl transition-all"
			>
				{/* 顶栏 Header */}
				<header className="flex h-14 shrink-0 items-center justify-between border-b border-border bg-surface-sunk/60 px-5">
					<div className="flex items-center gap-3">
						<div className="flex size-9 items-center justify-center rounded-xl border border-border/70 bg-surface shadow-2xs">
							<span className={cn(currentVisual.icon, currentVisual.color, "size-5")} />
						</div>
						<div>
							<div className="flex items-center gap-2">
								<h2 className="text-[14px] font-bold tracking-tight text-surface-foreground">
									{isEditing ? "编辑主机配置" : "新建主机节点"}
								</h2>
								{isDirty && (
									<span className="flex items-center gap-1 rounded-full bg-warning/15 px-2 py-0.5 text-[9.5px] font-medium text-warning">
										<span className="size-1.5 rounded-full bg-warning animate-pulse" />
										未保存修改
									</span>
								)}
							</div>
							<p className="font-mono text-[11px] text-muted">
								{form.hostname
									? `${form.username || "root"}@${form.hostname}:${form.port}`
									: "配置 SSH 凭据、网络跳板及终端运行偏好"}
							</p>
						</div>
					</div>

					<button
						type="button"
						onClick={() => {
							if (isDirty) setDiscardConfirm(true);
							else onClose();
						}}
						className="flex size-7 items-center justify-center rounded-full text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground cursor-pointer"
						title="关闭 (Esc)"
					>
						<span className="icon-[lucide--x] size-4" />
					</button>
				</header>

				{/* 中间双栏主体：左侧分类导航 + 右侧独立表单 */}
				<div className="flex min-h-0 flex-1">
					{/* 左侧垂直导航 */}
					<aside className="flex w-[190px] shrink-0 flex-col border-r border-border bg-surface-sunk/40 p-2.5">
						<div className="space-y-1">
							{TABS.map((item) => {
								const active = tab === item.id;
								const hasErr =
									item.id === "basic" &&
									Boolean(errors.name || errors.hostname || errors.port);

								return (
									<button
										key={item.id}
										type="button"
										onClick={() => setTab(item.id)}
										className={cn(
											"group relative flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left transition-all cursor-pointer select-none",
											active
												? "border border-border/70 bg-surface font-semibold text-primary shadow-2xs"
												: "text-muted hover:bg-surface/50 hover:text-surface-foreground",
										)}
									>
										<span
											className={cn(
												item.icon,
												"size-4 shrink-0 transition-colors",
												active ? "text-primary" : "text-muted group-hover:text-surface-foreground",
											)}
										/>
										<div className="min-w-0 flex-1">
											<div className="truncate text-[12px]">{item.label}</div>
											<div className="truncate text-[10px] text-faint">{item.desc}</div>
										</div>
										{hasErr && (
											<span className="size-2 rounded-full bg-danger shrink-0 animate-ping" />
										)}
									</button>
								);
							})}
						</div>

						{/* 底部快捷信息卡 */}
						<div className="mt-auto rounded-xl border border-border/60 bg-surface/40 p-2.5 text-[10.5px] text-muted">
							<div className="flex items-center gap-1.5 font-medium text-surface-foreground">
								<span className="icon-[lucide--keyboard] size-3.5 text-primary" />
								<span>快捷键提示</span>
							</div>
							<div className="mt-1 flex items-center justify-between text-faint">
								<span>快速保存</span>
								<kbd className="font-mono text-[9px]">Ctrl Enter</kbd>
							</div>
							<div className="mt-0.5 flex items-center justify-between text-faint">
								<span>退出对话框</span>
								<kbd className="font-mono text-[9px]">Esc</kbd>
							</div>
						</div>
					</aside>

					{/* 右侧表单内容区 */}
					<main className="min-h-0 flex-1 overflow-y-auto p-6 space-y-5 bg-surface">
						{/* 错误提示栏 */}
						{Object.keys(errors).length > 0 && (
							<div className="flex items-center gap-2 rounded-xl border border-danger/40 bg-danger/10 px-3.5 py-2.5 text-[11.5px] text-danger">
								<span className="icon-[lucide--alert-triangle] size-4 shrink-0" />
								<span>请修正标红的字段后再保存（{Object.values(errors).join("、")}）</span>
							</div>
						)}

						{/* -------------------- 标签 1: 基本连接 -------------------- */}
						{tab === "basic" && (
							<div className="space-y-4">
								<div className="grid grid-cols-[1fr_auto] items-end gap-3">
									<Field label="主机显示名称" required error={errors.name} hint="用于标签页与资产检索">
										<Input
											value={form.name}
											onChange={(e) => update("name", e.target.value)}
											placeholder="例如：生产-订单网关集群"
											className="h-8 text-[12.5px] font-medium"
										/>
									</Field>

									<button
										type="button"
										onClick={() => update("favorite", !form.favorite)}
										className={cn(
											"flex h-8 items-center gap-1.5 rounded-lg border px-3 text-[11.5px] transition-colors cursor-pointer",
											form.favorite
												? "border-amber-500/40 bg-amber-500/10 text-amber-500 font-semibold"
												: "border-border bg-surface text-muted hover:text-surface-foreground",
										)}
										title="加入常用收藏"
									>
										<span className={cn("size-3.5", form.favorite ? "icon-[lucide--star] fill-amber-500" : "icon-[lucide--star]")} />
										<span>{form.favorite ? "已收藏" : "设为常用"}</span>
									</button>
								</div>

								{/* 操作系统与平台图标识别 */}
								<div>
									<span className="block mb-1.5 text-[11.5px] font-medium text-surface-foreground">
										系统与平台标识
									</span>
									<div className="flex flex-wrap items-center gap-1.5">
										{OS_PRESETS.map((p) => {
											const selected = form.osPreset === p.value;
											return (
												<button
													key={p.value}
													type="button"
													onClick={() => update("osPreset", p.value)}
													className={cn(
														"flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] transition-all cursor-pointer border select-none",
														selected
															? "border-primary/50 bg-primary/10 text-primary font-semibold shadow-2xs"
															: "border-border/70 bg-surface-raised/40 text-muted hover:border-border hover:bg-surface-raised hover:text-surface-foreground",
													)}
												>
													<span className={cn(p.icon, p.color, "size-3.5")} />
													<span>{p.label}</span>
												</button>
											);
										})}
									</div>
								</div>

								{/* 连接地址与端口 */}
								<div className="grid grid-cols-[1fr_110px] gap-3">
									<Field label="主机连接地址 (IP / 域名)" required error={errors.hostname}>
										<div className="relative">
											<span className="icon-[lucide--globe] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
											<Input
												value={form.hostname}
												onChange={(e) => update("hostname", e.target.value)}
												placeholder="例如：192.168.1.100 或 server.corp.com"
												className="h-8 pl-8 font-mono text-[12px]"
											/>
										</div>
									</Field>

									<Field label="SSH 端口" required error={errors.port}>
										<Input
											value={form.port}
											onChange={(e) => update("port", e.target.value)}
											placeholder="22"
											inputMode="numeric"
											className="h-8 font-mono text-[12px] text-center"
										/>
									</Field>
								</div>

								{/* 用户名 */}
								<Field label="登录用户名" hint="默认 root">
									<div className="relative">
										<span className="icon-[lucide--user] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
										<Input
											value={form.username}
											onChange={(e) => update("username", e.target.value)}
											placeholder="root"
											className="h-8 pl-8 font-mono text-[12px]"
										/>
									</div>
								</Field>

								{/* 分组与标签 */}
								<div className="grid grid-cols-2 gap-3">
									<div>
										<div className="flex items-center justify-between mb-1.5">
											<span className="text-[11.5px] font-medium text-surface-foreground">所属资产分组</span>
											<button
												type="button"
												onClick={() => setCreatingGroup(true)}
												className="flex items-center gap-0.5 text-[10.5px] text-primary hover:underline cursor-pointer"
											>
												<span className="icon-[lucide--plus] size-3" />
												新建分组
											</button>
										</div>

										{creatingGroup ? (
											<div className="flex items-center gap-1.5">
												<Input
													autoFocus
													value={newGroupName}
													onChange={(e) => setNewGroupName(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter") handleCreateGroup();
														if (e.key === "Escape") setCreatingGroup(false);
													}}
													placeholder="分组名称…"
													className="h-8 text-xs"
												/>
												<Button size="sm" variant="primary" className="h-8 px-2.5" onClick={handleCreateGroup}>
													确定
												</Button>
												<Button size="sm" variant="ghost" className="h-8 px-2" onClick={() => setCreatingGroup(false)}>
													取消
												</Button>
											</div>
										) : (
											<Select
												value={form.groupId}
												onChange={(e) => update("groupId", e.target.value)}
												className="h-8 text-xs"
											>
												<option value="">(未分组)</option>
												{groups.map((g) => (
													<option key={g.id} value={g.id}>
														📁 {g.name}
													</option>
												))}
											</Select>
										)}
									</div>

									<Field label="自定义分类标签" hint="逗号或空格分隔">
										<Input
											value={form.tags}
											onChange={(e) => update("tags", e.target.value)}
											placeholder="生产, 核心, 华东"
											className="h-8 text-xs"
										/>
									</Field>
								</div>
							</div>
						)}

						{/* -------------------- 标签 2: 身份凭据 -------------------- */}
						{tab === "auth" && (
							<div className="space-y-4.5">
								<div>
									<span className="block mb-2 text-[11.5px] font-medium text-surface-foreground">
										认证方式 (Authentication Method)
									</span>
									<div className="grid grid-cols-3 gap-1.5 sm:grid-cols-5">
										{AUTH_OPTIONS.map((item) => {
											const active = form.authMethod === item.value;
											return (
												<button
													key={item.value}
													type="button"
													onClick={() => update("authMethod", item.value)}
													className={cn(
														"flex flex-col items-center justify-center gap-1.5 rounded-xl border p-2.5 text-center transition-all cursor-pointer",
														active
															? "border-primary/50 bg-primary/10 text-primary font-semibold shadow-xs"
															: "border-border/80 bg-surface-sunk/30 text-muted hover:border-border hover:bg-surface-raised hover:text-surface-foreground",
													)}
												>
													<span className={cn(item.icon, "size-4.5")} />
													<span className="text-[11px] leading-tight">{item.label}</span>
												</button>
											);
										})}
									</div>
								</div>

								{/* 密码模式 */}
								{form.authMethod === "password" && (
									<div className="rounded-xl border border-border/80 bg-surface-raised/40 p-4 space-y-3.5">
										<Field label="SSH 登录密码">
											<div className="relative">
												<Input
													type={showPassword ? "text" : "password"}
													value={form.password}
													onChange={(e) => update("password", e.target.value)}
													placeholder="请输入服务器远程密码…"
													className="h-8 pr-9 font-mono text-xs"
												/>
												<button
													type="button"
													onClick={() => setShowPassword(!showPassword)}
													className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-surface-foreground cursor-pointer"
													title={showPassword ? "隐藏密码" : "显示密码"}
												>
													<span className={cn("size-4", showPassword ? "icon-[lucide--eye-off]" : "icon-[lucide--eye]")} />
												</button>
											</div>
										</Field>

										<Checkbox
											checked={form.rememberPassword}
											onChange={(v) => update("rememberPassword", v)}
											label="记住密码"
										/>
									</div>
								)}

								{/* 私钥模式 */}
								{(form.authMethod === "key" || form.authMethod === "key-passphrase") && (
									<div className="rounded-xl border border-border/80 bg-surface-raised/40 p-4 space-y-3.5">
										<div className="flex items-center justify-between">
											<span className="text-[11.5px] font-medium text-surface-foreground">指定私钥身份</span>
											<button
												type="button"
												onClick={() => navigate("/keys")}
												className="flex items-center gap-1 text-[11px] text-primary hover:underline cursor-pointer"
											>
												<span className="icon-[lucide--key-round] size-3.5" />
												管理密钥库
											</button>
										</div>

										{keys.length > 0 && (
											<Select
												value={form.keyId || keys[0]?.id}
												onChange={(e) => update("keyId", e.target.value)}
												className="h-8.5 font-mono text-xs"
											>
												{keys.map((k) => (
													<option key={k.id} value={k.id}>
														🔑 {k.name} ({k.type.toUpperCase()}{k.bits ? ` ${k.bits}` : ""}) · {k.fingerprint.slice(0, 24)}…
													</option>
												))}
											</Select>
										)}

										<Field label="私钥文件路径">
											<div className="flex gap-1.5">
												<Input
													type="text"
													placeholder="例如 ~/.ssh/id_rsa 或选择本地文件"
													value={form.keyPath}
													onChange={(e) => update("keyPath", e.target.value)}
													className="h-8 font-mono text-xs"
												/>
												<Button
													type="button"
													size="sm"
													variant="default"
													onClick={async () => {
														try {
															const picked = await openFileDialog({
																multiple: false,
																directory: false,
																title: "选择私钥文件",
															});
															if (picked) update("keyPath", picked);
														} catch {
															// ignore
														}
													}}
												>
													浏览
												</Button>
											</div>
										</Field>

										{form.authMethod === "key-passphrase" && (
											<Field label="私钥解密口令 (Passphrase)" hint="仅当私钥自身设置了加密保护时填写">
												<div className="relative">
													<Input
														type={showPassphrase ? "text" : "password"}
														value={form.passphrase}
														onChange={(e) => update("passphrase", e.target.value)}
														placeholder="私钥口令…"
														className="h-8 pr-9 font-mono text-xs"
													/>
													<button
														type="button"
														onClick={() => setShowPassphrase(!showPassphrase)}
														className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-surface-foreground cursor-pointer"
														title={showPassphrase ? "隐藏口令" : "显示口令"}
													>
														<span className={cn("size-4", showPassphrase ? "icon-[lucide--eye-off]" : "icon-[lucide--eye]")} />
													</button>
												</div>
											</Field>
										)}
									</div>
								)}

								{/* Agent 模式 */}
								{form.authMethod === "agent" && (
									<div className="rounded-xl border border-border/80 bg-surface-raised/40 p-4">
										<div className="flex items-start gap-3">
											<span className="icon-[lucide--bot] size-5 text-primary shrink-0 mt-0.5" />
											<div className="text-[12px] space-y-1">
												<p className="font-semibold text-surface-foreground">使用本地 SSH Agent 认证</p>
												<p className="text-muted leading-relaxed">
													连接时自动使用本地运行的 SSH Agent（如 Pageant, OpenSSH Agent 等）进行免密认证。
												</p>
											</div>
										</div>
									</div>
								)}

								{/* 键盘交互模式 */}
								{form.authMethod === "keyboard-interactive" && (
									<div className="rounded-xl border border-border/80 bg-surface-raised/40 p-4">
										<div className="flex items-start gap-3">
											<span className="icon-[lucide--keyboard] size-5 text-primary shrink-0 mt-0.5" />
											<div className="text-[12px] space-y-1">
												<p className="font-semibold text-surface-foreground">键盘交互认证 (2FA / PAM)</p>
												<p className="text-muted leading-relaxed">
													连接时服务端推送交互式提问（如 2FA / OTP 动态口令），并在连接窗口即时答复。
												</p>
											</div>
										</div>
									</div>
								)}
							</div>
						)}

						{/* -------------------- 标签 3: 跳板与代理 -------------------- */}
						{tab === "network" && (
							<div className="space-y-5">
								{/* 跳板机链 */}
								<div className="space-y-3">
									<div className="flex items-center justify-between">
										<div>
											<span className="text-[12px] font-semibold text-surface-foreground">
												ProxyJump 跳板机链路
											</span>
											<p className="text-[10.5px] text-muted">
												经由跳板机逐跳建立加密隧道，穿透私有内网或堡垒机网络
											</p>
										</div>
									</div>

									{/* 可视化流程图卡片 */}
									<div className="rounded-xl border border-border/80 bg-surface-raised/40 p-3.5 space-y-2">
										<div className="flex flex-wrap items-center gap-2">
											<div className="flex items-center gap-1.5 rounded-lg border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-surface-foreground">
												<span className="icon-[lucide--laptop] size-3.5 text-muted" />
												<span>本地客户端</span>
											</div>

											{form.jumpHostIds.map((hopId, idx) => {
												const hop = hosts.find((h) => h.id === hopId);
												return (
													<div key={hopId} className="flex items-center gap-2">
														<span className="icon-[lucide--arrow-right] size-3 text-muted" />
														<div className="flex items-center gap-1.5 rounded-lg border border-primary/40 bg-primary/10 px-2.5 py-1 text-[11px] text-primary font-medium">
															<span className="font-mono text-[9.5px] text-primary/70">跳板 {idx + 1}</span>
															<span>{hop?.name ?? hopId}</span>
															<button
																type="button"
																onClick={() => update("jumpHostIds", form.jumpHostIds.filter((x) => x !== hopId))}
																className="ml-1 text-primary/60 hover:text-danger cursor-pointer"
																title="移除跳板"
															>
																<span className="icon-[lucide--x] size-3" />
															</button>
														</div>
													</div>
												);
											})}

											<span className="icon-[lucide--arrow-right] size-3 text-muted" />

											<div className="flex items-center gap-1.5 rounded-lg border border-success/40 bg-success/10 px-2.5 py-1 text-[11px] font-semibold text-success">
												<span className="icon-[lucide--target] size-3.5" />
												<span>{form.name || "当前目标主机"}</span>
											</div>
										</div>

										{/* 添加跳板机下拉 */}
										<div className="pt-2 border-t border-border/40 flex items-center gap-2">
											<Select
												value=""
												onChange={(e) => {
													if (e.target.value) {
														update("jumpHostIds", [...form.jumpHostIds, e.target.value]);
													}
												}}
												className="h-8 text-xs max-w-[280px]"
											>
												<option value="">+ 选择主机添加为下一跳…</option>
												{jumpCandidates.map((h) => (
													<option key={h.id} value={h.id}>
														{h.name} ({h.username}@{h.hostname}:{h.port})
													</option>
												))}
											</Select>
											{jumpCandidates.length === 0 && (
												<span className="text-[10.5px] text-faint">暂无更多可选的跳板节点</span>
											)}
										</div>
									</div>
								</div>

								{/* 网络代理隧道 */}
								<div className="rounded-xl border border-border/80 bg-surface-raised/40 p-4 space-y-3">
									<div className="flex items-center justify-between">
										<div>
											<span className="text-[12px] font-semibold text-surface-foreground">
												网络代理通道 (SOCKS5 / HTTP Proxy)
											</span>
											<p className="text-[10.5px] text-muted">
												经由指定的本地或局域网代理服务器建立 TCP 握手
											</p>
										</div>
										<Switch
											checked={form.proxyEnabled}
											onChange={(v) => update("proxyEnabled", v)}
											label=""
										/>
									</div>

									{form.proxyEnabled && (
										<div className="grid grid-cols-[100px_1fr_100px] gap-2 pt-2 border-t border-border/40">
											<Field label="协议类型">
												<Select
													value={form.proxyType}
													onChange={(e) => update("proxyType", e.target.value as "socks5" | "http")}
													className="h-8 text-xs"
												>
													<option value="socks5">SOCKS5</option>
													<option value="http">HTTP</option>
												</Select>
											</Field>

											<Field label="代理服务器地址">
												<Input
													value={form.proxyHost}
													onChange={(e) => update("proxyHost", e.target.value)}
													placeholder="127.0.0.1"
													className="h-8 font-mono text-xs"
												/>
											</Field>

											<Field label="代理端口">
												<Input
													value={form.proxyPort}
													onChange={(e) => update("proxyPort", e.target.value)}
													placeholder="1080"
													inputMode="numeric"
													className="h-8 font-mono text-xs text-center"
												/>
											</Field>
										</div>
									)}
								</div>
							</div>
						)}

						{/* -------------------- 标签 4: 高级选项 -------------------- */}
						{tab === "advanced" && (
							<div className="space-y-4">
								<div className="grid grid-cols-2 gap-3">
									<Field label="字符编码 (Encoding)">
										<Select
											value={form.encoding}
											onChange={(e) => update("encoding", e.target.value)}
											className="h-8 font-mono text-xs"
										>
											{["UTF-8", "GBK", "GB18030", "GB2312", "ISO-8859-1", "Big5"].map((enc) => (
												<option key={enc} value={enc}>
													{enc}
												</option>
											))}
										</Select>
									</Field>

									<Field label="终端模拟类型 (TERM)">
										<Select
											value={form.termType}
											onChange={(e) => update("termType", e.target.value)}
											className="h-8 font-mono text-xs"
										>
											{["xterm-256color", "xterm", "vt100", "screen-256color", "tmux-256color"].map((t) => (
												<option key={t} value={t}>
													{t}
												</option>
											))}
										</Select>
									</Field>
								</div>

								{/* 环境变量列表 */}
								<div>
									<div className="flex items-center justify-between mb-1.5">
										<span className="text-[11.5px] font-medium text-surface-foreground">
											登录环境变量注入 (Environment Variables)
										</span>
										<button
											type="button"
											onClick={() => update("envVars", [...form.envVars, { key: "", value: "" }])}
											className="flex items-center gap-1 text-[11px] text-primary hover:underline cursor-pointer"
										>
											<span className="icon-[lucide--plus] size-3" />
											添加变量
										</button>
									</div>

									{form.envVars.length === 0 ? (
										<div className="rounded-lg border border-dashed border-border py-3 text-center text-[11px] text-faint">
											暂无附加环境变量
										</div>
									) : (
										<div className="space-y-1.5">
											{form.envVars.map((v, i) => (
												<div key={i} className="flex items-center gap-2">
													<Input
														value={v.key}
														onChange={(e) =>
															update(
																"envVars",
																form.envVars.map((x, idx) => (idx === i ? { ...x, key: e.target.value } : x)),
															)
														}
														placeholder="变量名 (如 LANG)"
														className="h-7.5 font-mono text-xs"
													/>
													<span className="text-muted font-mono">=</span>
													<Input
														value={v.value}
														onChange={(e) =>
															update(
																"envVars",
																form.envVars.map((x, idx) => (idx === i ? { ...x, value: e.target.value } : x)),
															)
														}
														placeholder="变量值 (如 en_US.UTF-8)"
														className="h-7.5 font-mono text-xs"
													/>
													<button
														type="button"
														onClick={() => update("envVars", form.envVars.filter((_, idx) => idx !== i))}
														className="text-muted hover:text-danger cursor-pointer"
														title="删除变量"
													>
														<span className="icon-[lucide--trash-2] size-3.5" />
													</button>
												</div>
											))}
										</div>
									)}
								</div>

								{/* 自动执行脚本 */}
								<Field label="登录后自动执行命令 (Startup Script)" hint="每行一条，连接成功后自动键入">
									<Textarea
										rows={3}
										value={form.loginScript}
										onChange={(e) => update("loginScript", e.target.value)}
										placeholder={"cd /var/log\ntail -f sys.log"}
										className="text-xs"
									/>
								</Field>
							</div>
						)}

						{/* -------------------- 标签 5: 终端外观 -------------------- */}
						{tab === "appearance" && (
							<div className="space-y-4">
								<div className="grid grid-cols-2 gap-3">
									<Field label="终端配色方案">
										<Select
											value={form.colorScheme}
											onChange={(e) => update("colorScheme", e.target.value)}
											className="h-8 text-xs"
										>
											{COLOR_SCHEMES.map((cs) => (
												<option key={cs.id} value={cs.id}>
													{cs.id}
												</option>
											))}
										</Select>
									</Field>

									<Field label="终端字体族">
										<Select
											value={form.fontFamily}
											onChange={(e) => update("fontFamily", e.target.value)}
											className="h-8 font-mono text-xs"
										>
											{["JetBrains Mono", "Cascadia Code", "Consolas", "Fira Code", "系统等宽字体"].map((f) => (
												<option key={f} value={f}>
													{f}
												</option>
											))}
										</Select>
									</Field>
								</div>

								<div className="grid grid-cols-3 gap-3">
									<Field label="字号 (px)">
										<Input
											value={form.fontSize}
											onChange={(e) => update("fontSize", e.target.value)}
											placeholder="13"
											inputMode="numeric"
											className="h-8 font-mono text-xs text-center"
										/>
									</Field>

									<Field label="行高比率">
										<Input
											value={form.lineHeight}
											onChange={(e) => update("lineHeight", e.target.value)}
											placeholder="1.5"
											inputMode="decimal"
											className="h-8 font-mono text-xs text-center"
										/>
									</Field>

									<Field label="光标样式">
										<Select
											value={form.cursorStyle}
											onChange={(e) => update("cursorStyle", e.target.value as "block" | "bar" | "underline")}
											className="h-8 text-xs"
										>
											{CURSOR_OPTIONS.map((c) => (
												<option key={c.value} value={c.value}>
													{c.label}
												</option>
											))}
										</Select>
									</Field>
								</div>

								{/* 高保真仿真终端预览区 */}
								<div>
									<span className="block mb-1.5 text-[11.5px] font-medium text-surface-foreground">
										终端渲染实时预览
									</span>
									<div
										className="rounded-xl border border-border/80 p-3.5 shadow-inner"
										style={{
											backgroundColor:
												COLOR_SCHEMES.find((s) => s.id === form.colorScheme)?.bg ?? "#1e1e1e",
											color:
												COLOR_SCHEMES.find((s) => s.id === form.colorScheme)?.fg ?? "#d4d4d4",
											fontFamily: form.fontFamily,
											fontSize: `${Number(form.fontSize) || 13}px`,
											lineHeight: Number(form.lineHeight) || 1.5,
										}}
									>
										<div className="flex items-center gap-1.5 pb-2 mb-2 border-b border-white/10 opacity-70">
											<span className="size-2.5 rounded-full bg-red-500/80" />
											<span className="size-2.5 rounded-full bg-yellow-500/80" />
											<span className="size-2.5 rounded-full bg-green-500/80" />
											<span className="ml-2 font-mono text-[10px] text-white/50">
												{form.username || "root"}@{form.hostname || "localhost"} ~ ({form.colorScheme})
											</span>
										</div>
										<p className="font-mono">
											<span className="text-emerald-400 font-semibold">{form.username || "root"}@{form.hostname || "server"}</span>
											<span className="text-white/40">:</span>
											<span className="text-sky-400 font-semibold">~</span>
											<span className="text-white/60">$ </span>
											<span>uname -a</span>
										</p>
										<p className="font-mono text-white/70">
											Linux {form.hostname || "node"} 6.5.0-generic #1 SMP x86_64 GNU/Linux
										</p>
										<p className="font-mono flex items-center">
											<span className="text-emerald-400">{form.username || "root"}@{form.hostname || "server"}</span>
											<span className="text-white/60">$ </span>
											<span className="inline-block bg-primary/70 text-black px-0.5 ml-1">
												{form.cursorStyle === "block" ? "█" : form.cursorStyle === "underline" ? "_" : "|"}
											</span>
										</p>
									</div>
								</div>
							</div>
						)}
					</main>
				</div>

				{/* 底栏 Footer 操作条 */}
				<footer className="flex h-13 shrink-0 items-center justify-between border-t border-border bg-surface-sunk/80 px-5">
					<div className="flex items-center gap-2">
						{isEditing && (
							confirmDelete ? (
								<div className="flex items-center gap-1.5">
									<span className="text-[11px] font-medium text-danger">确定彻底删除此主机？</span>
									<Button size="sm" variant="danger" className="h-7 text-xs" onClick={handleDelete}>
										确定删除
									</Button>
									<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setConfirmDelete(false)}>
										取消
									</Button>
								</div>
							) : (
								<Button
									size="sm"
									variant="ghost"
									icon="icon-[lucide--trash-2]"
									className="h-7 text-xs text-muted hover:text-danger hover:bg-danger/10"
									onClick={() => setConfirmDelete(true)}
								>
									删除主机
								</Button>
							)
						)}
					</div>

					<div className="flex items-center gap-2">
						<Button
							size="sm"
							variant="default"
							className="h-8 text-xs"
							onClick={() => {
								if (isDirty) setDiscardConfirm(true);
								else onClose();
							}}
						>
							取消
						</Button>

						<Button
							size="sm"
							variant="default"
							icon="icon-[lucide--play]"
							className="h-8 text-xs border-primary/40 bg-primary/10 text-primary hover:bg-primary/20"
							onClick={() => handleSave(true)}
							title="保存更改并立即在工作区打开终端会话"
						>
							保存并连接
						</Button>

						<Button
							size="sm"
							variant="primary"
							icon="icon-[lucide--check]"
							className="h-8 text-xs font-semibold shadow-xs"
							onClick={() => handleSave(false)}
						>
							保存配置
						</Button>
					</div>
				</footer>
			</div>

			{/* 未保存修改放弃确认弹窗 */}
			{discardConfirm && (
				<div className="fixed inset-0 z-60 flex items-center justify-center bg-black/50 p-4">
					<div className="w-[360px] rounded-2xl border border-border bg-surface-raised p-5 shadow-xl space-y-3">
						<div className="flex items-center gap-2.5 text-warning">
							<span className="icon-[lucide--alert-triangle] size-5" />
							<h3 className="font-bold text-[13px] text-surface-foreground">放弃未保存的更改？</h3>
						</div>
						<p className="text-[11.5px] text-muted leading-relaxed">
							您在此主机配置中所做的修改尚未保存，确认退出将丢失所修改的内容。
						</p>
						<div className="flex items-center justify-end gap-2 pt-2 border-t border-border/50">
							<Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setDiscardConfirm(false)}>
								继续编辑
							</Button>
							<Button
								size="sm"
								variant="danger"
								className="h-7 text-xs"
								onClick={() => {
									setDiscardConfirm(false);
									onClose();
								}}
							>
								放弃修改
							</Button>
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function toForm(host?: Host | null, defaultKeyId?: string, fallbackGroupId?: string | null): FormState {
	return {
		name: host?.name ?? "",
		hostname: host?.hostname ?? "",
		port: String(host?.port ?? 22),
		username: host?.username ?? "root",
		groupId: host?.groupId ?? fallbackGroupId ?? "",
		tags: host?.tags?.join(", ") ?? "",
		favorite: host?.favorite ?? false,
		osPreset: host?.os?.name ?? "auto",
		authMethod: host?.auth?.method ?? "password",
		password: host?.auth?.password ?? "",
		rememberPassword: host?.auth?.rememberPassword ?? Boolean(host?.auth?.password),
		keyId: host?.auth?.keyId ?? defaultKeyId ?? "",
		keyPath: host?.auth?.keyPath ?? "",
		passphrase: "",
		jumpHostIds: host?.jumpHostIds ?? [],
		encoding: host?.encoding ?? "UTF-8",
		termType: host?.termType ?? "xterm-256color",
		proxyEnabled: Boolean(host?.proxy),
		proxyType: host?.proxy?.type ?? "socks5",
		proxyHost: host?.proxy?.host ?? "127.0.0.1",
		proxyPort: String(host?.proxy?.port ?? 1080),
		envVars: host?.envVars ?? [],
		loginScript: host?.loginScript ?? "",
		colorScheme: host?.terminal?.colorScheme ?? "One Dark",
		fontFamily: host?.terminal?.fontFamily ?? "JetBrains Mono",
		fontSize: String(host?.terminal?.fontSize ?? 13),
		lineHeight: String(host?.terminal?.lineHeight ?? 1.5),
		cursorStyle: host?.terminal?.cursorStyle ?? "bar",
	};
}
