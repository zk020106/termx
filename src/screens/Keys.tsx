import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Textarea } from "@/components/ui/Input";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import type { KeyType, SshKey } from "@/data/types";
import { cn } from "@/lib/cn";
import { useHostsStore } from "@/store/hosts";
import { useKeysStore } from "@/store/keys";
import { toast } from "@/store/toast";
import { ContextMenu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { buildKeyExportCommand, validateKeyExportTarget } from "@/lib/keyExport";
import { sshExec } from "@/lib/ssh";
import { useSessionsStore } from "@/store/sessions";
import { GenerateKeyDrawer, IdentityDrawer, ImportKeyDrawer, identitySummary } from "@/components/keys/KeychainPanels";
import type { Identity } from "@/data/types";
import { keyVaultDelete, keyVaultStatus } from "@/lib/keyVault";
import { secretDelete } from "@/lib/secret";
import { identitySecretAccount, useIdentitiesStore } from "@/store/identities";
import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router";

/* =============================================================================
 * 密钥库 —— 设计帧 termx.vetd/frames/keys.tsx 的交互版，数据全部来自真实 store。
 * 覆盖状态（需求书 06-密钥库）：密钥列表（可空）/ 登记公钥 / 编辑密钥 / 删除密钥 /
 * 部署公钥（多选主机 + authorized_keys 预览 + 确认）。
 * 部署 = Netcatty「导出密钥」：在主机已连接的终端会话上执行导出脚本（lib/keyExport.ts），
 * 真正写入远端 ~/.ssh/authorized_keys；没有已连接会话的主机如实报「未连接」，不记录。
 *
 * 钥匙串（Netcatty KeychainManager）：生成密钥 / 导入密钥（私钥进 Rust 密钥库，信封加密，
 * 数据密钥在系统钥匙串）/ 登记外部公钥 / 身份（用户名 + 密码或密钥）。
 * 导出成功后与 Netcatty 一样把密钥绑定到主机（主机引用了身份时改身份）。
 * ========================================================================== */

const KEY_TYPE_LABEL: Record<KeyType, string> = {
	ed25519: "Ed25519",
	rsa: "RSA",
	ecdsa: "ECDSA",
};

/** 公钥算法 → 密钥类型；顺带记录能从算法名直接读出的位数（RSA 的位数不做猜测，显示 —） */
const ALGO_TABLE: { pattern: RegExp; type: KeyType; bits?: number }[] = [
	{ pattern: /^ssh-ed25519$/, type: "ed25519", bits: 256 },
	{ pattern: /^ssh-rsa$/, type: "rsa" },
	{ pattern: /^ecdsa-sha2-nistp256$/, type: "ecdsa", bits: 256 },
	{ pattern: /^ecdsa-sha2-nistp384$/, type: "ecdsa", bits: 384 },
	{ pattern: /^ecdsa-sha2-nistp521$/, type: "ecdsa", bits: 521 },
];

interface ParsedKey {
	algo: string;
	type: KeyType;
	bits?: number;
	comment: string;
	publicKey: string;
	fingerprint: string;
}

/**
 * 解析一行 OpenSSH 公钥：算法 + Base64 正文 + 注释。
 * 指纹是真实的 SHA-256（对 Base64 解码后的公钥 blob 求摘要），不是编造的字符串。
 */
async function parsePublicKey(text: string): Promise<{ key: ParsedKey } | { error: string }> {
	const line = text
		.split(/\r?\n/)
		.map((item) => item.trim())
		.find((item) => item !== "" && !item.startsWith("#"));
	if (!line) return { error: "还没有可解析的内容：粘贴一行公钥，或选择 .pub 文件。" };

	const parts = line.split(/\s+/);
	const algo = parts[0] ?? "";
	const row = ALGO_TABLE.find((entry) => entry.pattern.test(algo));
	if (!row) {
		return {
			error: `无法识别的公钥类型「${algo || "空"}」；支持 ssh-ed25519、ssh-rsa、ecdsa-sha2-nistp256/384/521。`,
		};
	}

	const body = parts[1] ?? "";
	if (!/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
		return { error: "公钥正文不是合法的 Base64 文本，请确认整行复制完整。" };
	}

	let bytes: Uint8Array<ArrayBuffer>;
	try {
		const binary = atob(body);
		const decoded = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i += 1) decoded[i] = binary.charCodeAt(i);
		bytes = decoded;
	} catch {
		return { error: "公钥正文无法 Base64 解码，请确认是否复制完整。" };
	}

	let digest: ArrayBuffer;
	try {
		digest = await crypto.subtle.digest("SHA-256", bytes);
	} catch {
		return { error: "当前环境没有可用的 WebCrypto，无法计算指纹（桌面端可正常使用）。" };
	}
	const digestBytes = new Uint8Array(digest);
	let binary = "";
	for (let i = 0; i < digestBytes.length; i += 1) binary += String.fromCharCode(digestBytes[i]);
	const fingerprint = `SHA256:${btoa(binary).replace(/=+$/, "")}`;

	const comment = parts.slice(2).join(" ");
	return {
		key: {
			algo,
			type: row.type,
			bits: row.bits,
			comment,
			publicKey: `${algo} ${body}${comment ? ` ${comment}` : ""}`,
			fingerprint,
		},
	};
}

function bitsText(bits?: number): string {
	return bits ? `${bits} 位` : "位数 —";
}

/** 评审态：列表 / 登记公钥 / 部署确认 */
type KeysPanel = "list" | "add" | "deploy";

const PANEL_OPTIONS: { value: KeysPanel; label: string }[] = [
	{ value: "list", label: "列表" },
	{ value: "add", label: "登记公钥" },
	{ value: "deploy", label: "部署" },
];

/** 深链 `#/keys?panel=add`：让截图工具能直接打开登记公钥抽屉 */
function readPanel(): KeysPanel | null {
	const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("panel");
	return PANEL_OPTIONS.some((option) => option.value === value) ? (value as KeysPanel) : null;
}

export default function Keys() {
	const navigate = useNavigate();
	const keys = useKeysStore((s) => s.keys);
	const upsert = useKeysStore((s) => s.upsert);
	const remove = useKeysStore((s) => s.remove);
	const markDeployed = useKeysStore((s) => s.markDeployed);
	const hosts = useHostsStore((s) => s.hosts);
	const hostById = useHostsStore((s) => s.hostById);
	const identities = useIdentitiesStore((s) => s.identities);
	const [generateOpen, setGenerateOpen] = useState(false);
	const [importOpen, setImportOpen] = useState(false);
	const [identityDraft, setIdentityDraft] = useState<{ identity: Identity | null } | null>(null);
	const [identityMenu, setIdentityMenu] = useState<{ x: number; y: number; identity: Identity } | null>(null);
	const [identityDelete, setIdentityDelete] = useState<Identity | null>(null);
	/** 本机密钥库里真的有没有私钥（配置可能来自别的机器） */
	const [vaultHas, setVaultHas] = useState<Record<string, boolean>>({});
	useEffect(() => {
		const ids = keys.filter((k) => k.hasPrivateKey).map((k) => k.id);
		if (ids.length === 0) return;
		void keyVaultStatus(ids)
			.then((flags) => setVaultHas(Object.fromEntries(ids.map((id, i) => [id, flags[i]]))))
			.catch(() => undefined);
	}, [keys]);
	const hasPrivate = (key: SshKey) => Boolean(key.hasPrivateKey) && vaultHas[key.id] !== false;

	const [selectedId, setSelectedId] = useState("");
	const [panel, setPanel] = useState<KeysPanel>("list");

	/* 登记 / 编辑公钥抽屉 */
	const [editingId, setEditingId] = useState<string | null>(null);
	const [name, setName] = useState("");
	const [keyText, setKeyText] = useState("");
	const [parsed, setParsed] = useState<ParsedKey | null>(null);
	const [parseError, setParseError] = useState<string | null>(null);
	const fileRef = useRef<HTMLInputElement>(null);

	/* 部署 */
	const [targets, setTargets] = useState<string[]>([]);
	/** Netcatty 导出面板：位置 ~ $1、文件名 ~ $2 */
	const [exportLocation, setExportLocation] = useState(".ssh");
	const [exportFilename, setExportFilename] = useState("authorized_keys");
	const [exporting, setExporting] = useState(false);
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [menu, setMenu] = useState<{ x: number; y: number; key: SshKey } | null>(null);
	const deployCardRef = useRef<HTMLDivElement>(null);
	const tabs = useSessionsStore((s) => s.tabs);
	/** 每台主机一个已连接的会话（导出脚本在它上面执行） */
	const liveSessionFor = (hostId: string) =>
		tabs.find((t) => t.hostId === hostId && t.status === "connected" && t.sessionKey)?.sessionKey ?? null;
	const exportTargetError = validateKeyExportTarget(exportLocation, exportFilename);
	const [deleteOpen, setDeleteOpen] = useState(false);

	const selected = keys.find((key) => key.id === selectedId) ?? keys[0] ?? null;
	const deployed = selected ? selected.deployedTo : [];
	const selectedHosts = hosts.filter((host) => targets.includes(host.id));
	const jumpHost = selectedHosts
		.map((host) => host.jumpHostIds[0])
		.map((id) => (id ? hostById(id) : undefined))
		.find(Boolean);

	/** 公钥文本变化时重新解析（指纹是异步计算的，用 alive 标志避免竞态） */
	useEffect(() => {
		if (!keyText.trim()) {
			setParsed(null);
			setParseError(null);
			return;
		}
		let alive = true;
		void parsePublicKey(keyText).then((result) => {
			if (!alive) return;
			if ("error" in result) {
				setParsed(null);
				setParseError(result.error);
			} else {
				setParsed(result.key);
				setParseError(null);
			}
		});
		return () => {
			alive = false;
		};
	}, [keyText]);

	function copyText(text: string, label: string) {
		if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined);
		toast({
			title: `${label}已复制到剪贴板`,
			description: label === "公钥" ? "可直接粘贴到服务器的 authorized_keys" : undefined,
			tone: "success",
		});
	}

	function openAdd() {
		setEditingId(null);
		setName("");
		setKeyText("");
		setParsed(null);
		setParseError(null);
		setPanel("add");
	}

	function openEdit(key: SshKey) {
		setEditingId(key.id);
		setName(key.name);
		setKeyText(key.publicKey);
		setPanel("add");
	}

	function closePanel() {
		setPanel("list");
	}

	/* 深链预置状态（`#/keys?panel=add`），首帧后套用一次 */
	useEffect(() => {
		if (readPanel() === "add") openAdd();
	}, []);

	function toggleTarget(hostId: string) {
		setTargets((prev) => (prev.includes(hostId) ? prev.filter((id) => id !== hostId) : [...prev, hostId]));
	}

	async function handleFile(file: File | undefined) {
		if (!file) return;
		const text = await file.text();
		setKeyText(text);
		setName((prev) => prev.trim() || file.name.replace(/\.pub$/i, ""));
		toast({ title: `已读取 ${file.name}`, description: "解析结果见下方预览", tone: "default" });
	}

	function save() {
		if (!parsed) return;
		const existing = editingId ? keys.find((key) => key.id === editingId) : undefined;
		const key: SshKey = {
			id: existing?.id ?? `key-${Date.now().toString(36)}`,
			name: name.trim() || parsed.comment || `${KEY_TYPE_LABEL[parsed.type]} 密钥`,
			type: parsed.type,
			bits: parsed.bits,
			fingerprint: parsed.fingerprint,
			publicKey: parsed.publicKey,
			comment: parsed.comment || undefined,
			createdAt: existing?.createdAt ?? new Date().toISOString(),
			deployedTo: existing?.deployedTo ?? [],
			hasPassphrase: existing?.hasPassphrase ?? false,
		};
		upsert(key);
		setSelectedId(key.id);
		setPanel("list");
		toast({
			title: existing ? `已保存 ${key.name}` : `已登记 ${key.name}`,
			description: `${KEY_TYPE_LABEL[key.type]} · ${bitsText(key.bits)} · ${key.fingerprint}`,
			tone: "success",
		});
	}

	function handleDelete() {
		if (!selected) return;
		const victim = selected;
		remove(victim.id);
		// 私钥一并从密钥库删除（密钥库文件 + 钥匙串里的数据密钥与口令）
		if (victim.hasPrivateKey) void keyVaultDelete(victim.id).catch(() => undefined);
		setDeleteOpen(false);
		setSelectedId((id) => (id === victim.id ? "" : id));
		toast({ title: `已删除密钥 ${victim.name}`, tone: "default" });
	}

	async function handleDeploy() {
		if (!selected || exporting) return;
		setExporting(true);
		const ok: string[] = [];
		const failed: string[] = [];
		try {
			const command = buildKeyExportCommand(exportLocation, exportFilename, selected.publicKey);
			for (const host of selectedHosts) {
				const key = liveSessionFor(host.id);
				if (!key) {
					failed.push(`${host.name}：未连接（请先打开该主机的终端）`);
					continue;
				}
				try {
					const out = await sshExec(key, command, 30000);
					const err = out.stderr?.trim();
					if (out.code === 0 || (out.code == null && !err)) {
						markDeployed(selected.id, host.id);
						ok.push(host.name);
						// Netcatty「导出并绑定」：主机引用了身份就把密钥绑到身份上，否则绑到主机（认证方式改为密钥）
						if (hasPrivate(selected)) attachKey(host.id, selected.id);
					} else {
						failed.push(`${host.name}：${err || out.stdout?.trim() || `命令退出码 ${out.code}`}`);
					}
				} catch (error) {
					failed.push(`${host.name}：${String(error)}`);
				}
			}
		} catch (error) {
			failed.push(String(error));
		} finally {
			setExporting(false);
		}
		setConfirmOpen(false);
		setPanel("list");
		if (ok.length > 0) {
			toast({
				title: "导出成功",
				description: `已导出公钥到 ${ok.join("、")} 的 ~/${exportLocation}/${exportFilename}`,
				tone: "success",
			});
		}
		if (failed.length > 0) {
			toast({ title: "导出失败", description: failed.join("\n"), tone: "danger" });
		}
	}

	/** 把密钥绑定到主机（Netcatty KeychainExportPanel：identity 优先，否则 host.identityFileId + authMethod key） */
	function attachKey(hostId: string, keyId: string) {
		const hostStore = useHostsStore.getState();
		const raw = hostStore.rawHostById(hostId);
		if (!raw) return;
		const identity = raw.auth.identityId ? useIdentitiesStore.getState().identities.find((i) => i.id === raw.auth.identityId) : undefined;
		if (identity) {
			useIdentitiesStore.getState().upsert({ ...identity, authMethod: "key", keyId });
			return;
		}
		hostStore.upsertRawHost({ ...raw, auth: { ...raw.auth, method: "key", keyId, keyPath: undefined } });
	}

	function confirmDeleteIdentity() {
		if (!identityDelete) return;
		useIdentitiesStore.getState().remove(identityDelete.id);
		void secretDelete(identitySecretAccount(identityDelete.id)).catch(() => undefined);
		setIdentityDelete(null);
	}

	/** 右键「导出密钥」：选中并定位到导出卡片 */
	function openExport(key: SshKey) {
		setSelectedId(key.id);
		requestAnimationFrame(() => deployCardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }));
	}

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 bg-surface">
				{/* 左侧密钥列表 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--key-round] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">SSH 密钥管理</h1>
						</div>
						<div className="flex items-center gap-1">
							<Button size="sm" variant="primary" icon="icon-[lucide--key-round]" className="h-6 px-2 text-[11px]" onClick={() => setGenerateOpen(true)}>
								生成密钥
							</Button>
							<Button size="sm" icon="icon-[lucide--file-key]" className="h-6 px-2 text-[11px]" onClick={() => setImportOpen(true)}>
								导入密钥
							</Button>
						</div>
					</div>

					{keys.length === 0 ? (
						<div className="flex-1">
							<EmptyState
								icon="icon-[lucide--key-round]"
								title="还没有密钥"
								action={
									<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openAdd}>
										登记公钥
									</Button>
								}
								className="px-4 py-6"
							/>
						</div>
					) : (
						<div className="flex-1 space-y-1.5 overflow-y-auto p-2">
							{keys.map((key) => {
								const deployedTo = key.deployedTo;
								const active = key.id === selected?.id;
								return (
									<button
										key={key.id}
										type="button"
										onClick={() => setSelectedId(key.id)}
										onContextMenu={(event) => {
											event.preventDefault();
											setSelectedId(key.id);
											setMenu({ x: event.clientX, y: event.clientY, key });
										}}
										className={cn(
											"w-full cursor-pointer rounded border p-2.5 text-left transition-colors",
											active ? "border-border bg-surface-raised shadow-sm" : "border-transparent bg-surface hover:border-border",
										)}
									>
										<div className="flex items-center justify-between gap-2 text-[12px]">
											<span className="truncate font-medium text-surface-foreground">{key.name}</span>
											<span className="shrink-0 rounded border border-border bg-surface px-1 py-0.5 font-mono text-[9.5px] text-primary">
												{KEY_TYPE_LABEL[key.type]}
												{key.bits ? ` ${key.bits}` : " —"}
											</span>
										</div>

										<div className="mt-1 truncate font-mono text-[10.5px] text-faint">{key.fingerprint}</div>

										<div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-muted">
											<span className="flex min-w-0 items-center gap-1.5">
												<span className="truncate">
													{deployedTo.length > 0 ? `已记录 ${deployedTo.length} 台主机` : "未部署到主机"}
												</span>
											</span>
											<span className="shrink-0 font-mono text-faint">{key.createdAt.slice(0, 10)}</span>
										</div>
										<div className="mt-1 text-[10px] text-faint">{hasPrivate(key) ? "私钥在本机密钥库" : "仅公钥"}</div>
									</button>
								);
							})}
						</div>
					)}

					{/* 身份（Netcatty keychain.section.identities） */}
					<div className="border-t border-border">
						<div className="flex h-8 items-center justify-between px-3">
							<span className="text-[11px] font-semibold text-surface-foreground">
								身份 <span className="font-mono text-faint">{identities.length}</span>
							</span>
							<Button size="sm" variant="ghost" icon="icon-[lucide--user-plus]" className="h-6 px-1.5 text-[11px]" onClick={() => setIdentityDraft({ identity: null })}>
								新建身份
							</Button>
						</div>
						<div className="max-h-[180px] space-y-1 overflow-y-auto px-2 pb-2">
							{identities.map((identity) => (
								<button
									key={identity.id}
									type="button"
									onClick={() => setIdentityDraft({ identity })}
									onContextMenu={(event) => {
										event.preventDefault();
										setIdentityMenu({ x: event.clientX, y: event.clientY, identity });
									}}
									className="flex w-full items-center gap-2 rounded border border-transparent bg-surface p-2 text-left hover:border-border"
								>
									<span className="icon-[lucide--user] size-3.5 shrink-0 text-success" />
									<span className="min-w-0 flex-1">
										<span className="block truncate text-[11.5px] font-medium text-surface-foreground">{identity.label}</span>
										<span className="block truncate font-mono text-[10px] text-faint">
											{identity.username} · {identitySummary(identity)}
										</span>
									</span>
								</button>
							))}
						</div>
					</div>

					<div className="border-t border-border p-2">
						<button
							type="button"
							onClick={openAdd}
							className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-border bg-surface text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--file-key] size-3" />
							<span>登记外部公钥（.pub / 粘贴）</span>
						</button>
					</div>
				</aside>

				{/* 右侧密钥详情与部署操作 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
					{selected ? (
						<div className="max-w-2xl space-y-5">
							{/* 密钥详情卡片 */}
							<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
								<div className="flex items-start justify-between gap-3 border-b border-border pb-3">
									<div className="min-w-0">
										<div className="flex flex-wrap items-center gap-2">
											<h2 className="truncate text-[14px] font-semibold text-surface-foreground">{selected.name}</h2>
											<span className="rounded border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary">
												{KEY_TYPE_LABEL[selected.type].toUpperCase()}
											</span>
											<Badge>{bitsText(selected.bits)}</Badge>
											{selected.comment && <Badge className="font-mono">{selected.comment}</Badge>}
										</div>
										<p className="mt-1 text-[11.5px] text-muted">
											登记于 {selected.createdAt.slice(0, 10)} ·{" "}
											{deployed.length > 0 ? `已记录部署到 ${deployed.length} 台主机` : "尚未部署到任何主机"} ·
											{hasPrivate(selected)
												? `私钥在本机密钥库（系统钥匙串加密）${selected.hasPassphrase ? (selected.savePassphrase ? " · 口令已保存" : " · 有口令，连接时询问") : ""}`
												: "只登记了公钥，私钥留在你自己的机器上"}
										</p>
									</div>

									<div className="flex shrink-0 items-center gap-2">
										<Button size="sm" icon="icon-[lucide--copy]" onClick={() => copyText(selected.publicKey, "公钥")}>
											复制公钥
										</Button>
										<Button size="sm" icon="icon-[lucide--edit-3]" onClick={() => openEdit(selected)}>
											编辑
										</Button>
										<Button size="sm" variant="ghost" icon="icon-[lucide--trash-2]" onClick={() => setDeleteOpen(true)}>
											删除
										</Button>
									</div>
								</div>

								{/* 指纹信息 */}
								<div className="mt-3.5 space-y-1">
									<span className="font-mono text-[11px] tracking-wider text-faint uppercase">SHA256 Fingerprint</span>
									<div className="flex h-7 items-center rounded border border-border bg-surface px-2.5 font-mono text-[11.5px] text-surface-foreground">
										<span className="truncate">{selected.fingerprint}</span>
									</div>
								</div>

								{/* 公钥预览 */}
								<div className="mt-3.5 space-y-1">
									<span className="font-mono text-[11px] tracking-wider text-faint uppercase">Public Key</span>
									<div className="rounded border border-border bg-term p-2.5 font-mono text-[11px] leading-relaxed break-all text-term-ink">
										{selected.publicKey}
									</div>
								</div>

								{/* 已部署主机 */}
								<div className="mt-3.5 space-y-1">
									<span className="font-mono text-[11px] tracking-wider text-faint uppercase">Deployed To</span>
									{deployed.length > 0 ? (
										<div className="flex flex-wrap items-center gap-1.5">
											{deployed.map((hostId) => {
												const host = hostById(hostId);
												return (
													<span
														key={hostId}
														className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[10.5px] text-muted"
													>
														{host?.name ?? `${hostId}（主机已删除）`}
													</span>
												);
											})}
										</div>
									) : (
										<span className="text-[11px] text-faint">尚未部署到任何主机</span>
									)}
								</div>
							</div>

							{/* 部署公钥到远程主机卡片（Netcatty「导出密钥」） */}
							<div ref={deployCardRef} className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
								<div className="flex items-center gap-2 border-b border-border pb-3">
									<span className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
										<span className="icon-[lucide--shield-plus] size-3" />
									</span>
									<div>
										<h3 className="text-[13px] font-semibold text-surface-foreground">部署公钥到远程主机</h3>
										<p className="text-[11px] text-muted">
											在主机已连接的终端会话上执行导出脚本，追加到登录用户的 ~/{exportLocation || ".ssh"}/{exportFilename || "authorized_keys"}
										</p>
									</div>
									<span className="ml-auto font-mono text-[10.5px] text-faint">已选 {selectedHosts.length} 台</span>
								</div>

								{hosts.length === 0 ? (
									<EmptyState
										icon="icon-[lucide--server-off]"
										title="还没有主机"
										action={
											<Button size="sm" variant="primary" icon="icon-[lucide--server]" onClick={() => navigate("/hosts/new")}>
												新建主机
											</Button>
										}
										className="py-6"
									/>
								) : (
									<>
										<div className="mt-4 grid grid-cols-[1.15fr_1fr] gap-3">
											<div className="flex flex-col">
												<label className="mb-1 text-[11.5px] text-muted">目标主机（多选）</label>
												<div className="max-h-[172px] space-y-0.5 overflow-y-auto rounded border border-border bg-surface p-1">
													{hosts.map((host) => {
														const checked = targets.includes(host.id);
														const already = deployed.includes(host.id);
														return (
															<div
																key={host.id}
																role="button"
																tabIndex={0}
																onClick={() => toggleTarget(host.id)}
																onKeyDown={(e) => {
																	if (e.key === "Enter" || e.key === " ") {
																		e.preventDefault();
																		toggleTarget(host.id);
																	}
																}}
																className={cn(
																	"flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 transition-colors",
																	checked ? "bg-primary/10" : "hover:bg-surface-raised",
																)}
															>
																<span onClick={(e) => e.stopPropagation()}>
																	<Checkbox checked={checked} onChange={() => toggleTarget(host.id)} />
																</span>
																<span className="truncate text-[11.5px] text-surface-foreground">{host.name}</span>
																{already && <span className="icon-[lucide--check] size-3 shrink-0 text-success" />}
																<span className="flex-1" />
																<span className="shrink-0 font-mono text-[10.5px] text-faint">{host.hostname}</span>
															</div>
														);
													})}
												</div>
											</div>

											<div className="space-y-3">
												<Field label="位置 ~ $1" required error={exportLocation.trim() ? undefined : "位置不能为空"}>
													<Input value={exportLocation} onChange={(e) => setExportLocation(e.target.value)} className="h-7.5 font-mono" />
												</Field>
												<Field label="文件名 ~ $2" required error={exportTargetError && exportLocation.trim() ? exportTargetError : undefined}>
													<Input value={exportFilename} onChange={(e) => setExportFilename(e.target.value)} className="h-7.5 font-mono" />
												</Field>
												<div className="space-y-1">
													<span className="font-mono text-[10px] tracking-wider text-faint uppercase">目标路径</span>
													<ReadonlyValue>
														~/{exportLocation || "—"}/{exportFilename || "—"}
													</ReadonlyValue>
												</div>
												<div className="flex items-start gap-1.5 rounded border border-border bg-surface p-2 text-[10.5px] leading-4 text-faint">
													<span className="icon-[lucide--info] mt-px size-3 shrink-0" />
													<span>写入前会先备份原文件为 {exportFilename || "authorized_keys"}.bak，已存在的相同公钥自动跳过。</span>
												</div>
											</div>
										</div>

										{/* authorized_keys 内容预览 */}
										<div className="mt-4 space-y-1">
											<span className="font-mono text-[10px] tracking-wider text-faint uppercase">
												将追加到 authorized_keys 的内容
											</span>
											<div className="rounded border border-border bg-term p-2.5 font-mono text-[11px] leading-relaxed break-all text-term-ink">
												<div className="text-faint">
													# {selectedHosts.length} 台主机 · 登录用户的 ~/{exportLocation}/{exportFilename} · 追加模式（&gt;&gt;）
												</div>
												<div>{selected.publicKey}</div>
											</div>
										</div>

										<div className="mt-4 flex items-center justify-between border-t border-border pt-3">
											<span className="flex items-center gap-1.5 text-[11px] text-faint">
												<span className="icon-[lucide--route] size-3" />
												{jumpHost ? `经由跳板链路: ${jumpHost.name} (${jumpHost.hostname}:${jumpHost.port})` : "直连，无跳板链路"}
											</span>
											<Button
												variant="primary"
												icon="icon-[lucide--send]"
												disabled={selectedHosts.length === 0 || exportTargetError !== null}
												onClick={() => setConfirmOpen(true)}
											>
												{hasPrivate(selected) ? "导出并绑定" : "导出到所选主机"}
											</Button>
										</div>
									</>
								)}
							</div>
						</div>
					) : (
						<div className="flex min-h-0 flex-1 items-center justify-center rounded-lg border border-border bg-surface-raised">
							<EmptyState
								icon="icon-[lucide--key-round]"
								title="还没有密钥详情"
								action={
									<Button variant="primary" icon="icon-[lucide--plus]" onClick={openAdd}>
										登记公钥
									</Button>
								}
							/>
						</div>
					)}
				</div>

				{/* 登记 / 编辑公钥抽屉 */}
				<Drawer
					open={panel === "add"}
					onClose={closePanel}
					title={editingId ? "编辑密钥信息" : "登记 SSH 公钥"}
					subtitle="只登记公钥；指纹在本机用 SHA-256 真实计算"
					width={520}
					footer={
						<>
							<Button onClick={closePanel}>取消</Button>
							<Button variant="primary" icon="icon-[lucide--check]" disabled={!parsed} onClick={save}>
								{editingId ? "保存修改" : "登记公钥"}
							</Button>
						</>
					}
				>
					<div className="space-y-4 p-3">
						<div className="flex items-start gap-2 rounded-control border border-border bg-surface p-2.5 text-[10.5px] leading-4 text-muted">
							<span className="icon-[lucide--info] mt-px size-3.5 shrink-0 text-primary" />
							<span>
								应用内生成密钥尚未接入。请先用{" "}
								<span className="font-mono text-surface-foreground">ssh-keygen -t ed25519</span> 生成，再把 .pub 内容登记进来。
							</span>
						</div>

						<Field label="名称" required hint="显示在密钥列表里">
							<Input
								value={name}
								onChange={(e) => setName(e.target.value)}
								placeholder="例如：工作机 ed25519"
								className="font-mono"
							/>
						</Field>

						<Field
							label="公钥内容"
							required
							error={parseError ?? undefined}
							hint="一行：算法 + Base64 正文 + 可选注释"
						>
							<Textarea
								rows={5}
								value={keyText}
								onChange={(e) => setKeyText(e.target.value)}
								placeholder="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI... deploy@workstation"
								className="text-[10.5px]"
							/>
						</Field>

						<div className="flex items-center gap-2">
							<Button size="sm" icon="icon-[lucide--file-key]" onClick={() => fileRef.current?.click()}>
								选择 .pub 文件…
							</Button>
							<Button size="sm" variant="ghost" icon="icon-[lucide--eraser]" onClick={() => setKeyText("")}>
								清空
							</Button>
							<span className="ml-auto font-mono text-[10.5px] text-faint">{keyText.trim().length} 字符</span>
							<input ref={fileRef} type="file" accept=".pub,text/plain" className="hidden" onChange={(e) => void handleFile(e.target.files?.[0])} />
						</div>

						{parsed ? (
							<div className="space-y-2 rounded-control border border-border bg-surface p-3">
								<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-surface-foreground">
									<span className="icon-[lucide--file-search] size-3.5 text-primary" />
									解析结果
								</div>
								<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
									<span className="text-faint">算法</span>
									<span className="font-mono text-surface-foreground">{parsed.algo}</span>
									<span className="text-faint">类型 / 位数</span>
									<span className="font-mono text-surface-foreground">
										{KEY_TYPE_LABEL[parsed.type]} · {bitsText(parsed.bits)}
									</span>
									<span className="text-faint">指纹</span>
									<span className="font-mono break-all text-surface-foreground">{parsed.fingerprint}</span>
									<span className="text-faint">注释</span>
									<span className="font-mono text-surface-foreground">{parsed.comment || "（无）"}</span>
								</div>
							</div>
						) : (
							<EmptyState
								icon="icon-[lucide--file-key]"
								title="尚未解析出公钥"
								className="rounded-control border border-dashed border-border py-6"
							/>
						)}
					</div>
				</Drawer>

				{/* 部署确认 */}
				<Modal
					open={confirmOpen}
					onClose={() => {
						setConfirmOpen(false);
						if (panel === "deploy") setPanel("list");
					}}
					title="密钥导出"
					icon="icon-[lucide--shield-plus]"
					width={480}
					footer={
						<>
							<Button
								onClick={() => {
									setConfirmOpen(false);
									if (panel === "deploy") setPanel("list");
								}}
							>
								取消
							</Button>
							<Button variant="primary" icon="icon-[lucide--send]" disabled={exporting} onClick={() => void handleDeploy()}>
								{exporting ? "导出中..." : "导出"}
							</Button>
						</>
					}
				>
					<p className="mb-2">
						将把 <span className="font-mono text-surface-foreground">{selected?.name ?? "—"}</span> 追加到下列{" "}
						{selectedHosts.length} 台主机登录用户的{" "}
						<span className="font-mono">
							~/{exportLocation}/{exportFilename}
						</span>
						。
					</p>
					<div className="mb-2 space-y-1">
						{selectedHosts.map((host) => (
							<div key={host.id} className="flex items-center gap-2">
								<span className="font-mono text-[11px] text-surface-foreground">{host.name}</span>
								<span className="font-mono text-[10.5px] text-faint">
									{host.username}@{host.hostname}:{host.port}
								</span>
								{deployed.includes(host.id) && <Badge className="border-success/40 text-success">已在记录中</Badge>}
								{!liveSessionFor(host.id) && <Badge className="border-warning/40 text-warning">未连接，将跳过</Badge>}
							</div>
						))}
					</div>
					<div className="rounded border border-border bg-term p-2 font-mono text-[10.5px] leading-relaxed break-all text-term-ink">
						{selected?.publicKey}
					</div>
					<p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-faint">
						<span className="icon-[lucide--info] size-3" />
						通过该主机已连接的终端会话执行；已存在相同公钥会跳过，追加前原文件备份为 .bak。
					</p>
				</Modal>

				{menu && (
					<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="密钥菜单">
						<MenuItem
							icon="icon-[lucide--copy]"
							label="复制公钥"
							disabled={!menu.key.publicKey}
							onClick={() => (copyText(menu.key.publicKey, "公钥"), setMenu(null))}
						/>
						<MenuItem icon="icon-[lucide--upload]" label="导出密钥" onClick={() => (openExport(menu.key), setMenu(null))} />
						<MenuItem icon="icon-[lucide--edit-3]" label="编辑" onClick={() => (openEdit(menu.key), setMenu(null))} />
						<MenuSeparator />
						<MenuItem
							icon="icon-[lucide--trash-2]"
							label="删除"
							danger
							onClick={() => {
								setSelectedId(menu.key.id);
								setDeleteOpen(true);
								setMenu(null);
							}}
						/>
					</ContextMenu>
				)}

				<GenerateKeyDrawer
					open={generateOpen}
					onClose={() => setGenerateOpen(false)}
					onSaved={(key) => {
						setSelectedId(key.id);
						toast({ title: `已生成 ${key.name}`, description: key.fingerprint, tone: "success" });
					}}
				/>
				<ImportKeyDrawer
					open={importOpen}
					onClose={() => setImportOpen(false)}
					onSaved={(key) => {
						setSelectedId(key.id);
						toast({ title: `已导入 ${key.name}`, description: key.fingerprint, tone: "success" });
					}}
				/>
				<IdentityDrawer open={identityDraft !== null} identity={identityDraft?.identity ?? null} onClose={() => setIdentityDraft(null)} />
				{identityMenu && (
					<ContextMenu x={identityMenu.x} y={identityMenu.y} onClose={() => setIdentityMenu(null)} label="身份菜单">
						<MenuItem icon="icon-[lucide--edit-3]" label="编辑" onClick={() => (setIdentityDraft({ identity: identityMenu.identity }), setIdentityMenu(null))} />
						<MenuSeparator />
						<MenuItem
							icon="icon-[lucide--trash-2]"
							label="删除"
							danger
							onClick={() => (setIdentityDelete(identityMenu.identity), setIdentityMenu(null))}
						/>
					</ContextMenu>
				)}
				<Modal
					open={identityDelete !== null}
					onClose={() => setIdentityDelete(null)}
					title="删除身份"
					icon="icon-[lucide--trash-2]"
					width={420}
					footer={
						<>
							<Button size="sm" onClick={() => setIdentityDelete(null)}>
								取消
							</Button>
							<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={confirmDeleteIdentity}>
								删除
							</Button>
						</>
					}
				>
					<p>
						将删除身份 <span className="font-mono text-surface-foreground">{identityDelete?.label ?? "—"}</span>
						以及它在系统钥匙串里的密码。引用它的主机会提示「钥匙串身份不存在」。
					</p>
				</Modal>

				{/* 删除确认 */}
				<Modal
					open={deleteOpen}
					onClose={() => setDeleteOpen(false)}
					title="删除密钥记录"
					icon="icon-[lucide--trash-2]"
					width={420}
					footer={
						<>
							<Button size="sm" onClick={() => setDeleteOpen(false)}>
								取消
							</Button>
							<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={handleDelete}>
								删除
							</Button>
						</>
					}
				>
					<p>
						将从密钥库移除 <span className="font-mono text-surface-foreground">{selected?.name ?? "—"}</span>
						，同时清除它的部署记录{selected?.hasPrivateKey ? "，并删除本机密钥库里的私钥" : ""}。你自己机器上的私钥文件不受影响。
					</p>
				</Modal>
			</div>
		</WindowChrome>
	);
}
