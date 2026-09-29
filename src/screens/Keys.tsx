import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, EnvStripe } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select, Textarea } from "@/components/ui/Input";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { Checkbox, Switch } from "@/components/ui/Toggle";
import { hosts, sshKeys } from "@/data/mock";
import type { Env, KeyType, SshKey } from "@/data/types";
import { cn } from "@/lib/cn";
import { toast } from "@/store/toast";
import { useRef, useState } from "react";

/* =============================================================================
 * 密钥库 —— 设计帧 termx.vetd/frames/keys.tsx 的交互版。
 * 覆盖状态（需求书 06-密钥库）：密钥列表 / 生成密钥（生成后复制公钥）/
 * 导入私钥（粘贴 + 选择文件 + 解析预览）/ 部署公钥（多选主机 + authorized_keys 预览 + 确认）。
 * 列表数据来自 @/data/mock 的 sshKeys，本界面新增的密钥只存在于局部 state。
 * ========================================================================== */

const KEY_TYPE_LABEL: Record<KeyType, string> = {
	ed25519: "Ed25519",
	rsa: "RSA",
	ecdsa: "ECDSA",
};

const KEY_ALGO: Record<KeyType, string> = {
	ed25519: "ssh-ed25519",
	rsa: "ssh-rsa",
	ecdsa: "ecdsa-sha2-nistp521",
};

/** Ed25519 固定 256 位；RSA / ECDSA 取常见强度 */
const KEY_TYPE_BITS: Record<KeyType, number> = {
	ed25519: 256,
	rsa: 4096,
	ecdsa: 521,
};

const KEY_TYPE_HINT: Record<KeyType, string> = {
	ed25519: "现代发行版默认，密钥短、握手快，优先选它",
	rsa: "兼容老系统（RHEL 6 等只认 RSA）",
	ecdsa: "密钥更短，但部分老旧 SSH 实现不支持",
};

const KEY_BODY: Record<KeyType, string> = {
	ed25519: "AAAAC3NzaC1lZDI1NTE5AAAAIBk7M8pQ2vR1tX9Qm3pL8nR2vXc4e2J5hW1yZ8mPqRtU",
	rsa: "AAAAB3NzaC1yc2EAAAADAQABAAACAQDk7M8pQ2vR1tX9Qm3pL8nR2vXc4e2J5hW1yZ8mPqRtU",
	ecdsa: "AAAAE2VjZHNhLXNoYTItbmlzdHA1MjEAAAAIbmlzdHA1MjEAAACFBADk7M8pQ2vR1tX9Qm3pL8n",
};

const SAMPLE_PRIVATE_KEY = `-----BEGIN OPENSSH PRIVATE KEY-----
b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW
QyNTUxOQAAACCk7M8pQ2vR1tX9Qm3pL8nR2vXc4e2J5hW1yZ8mPqRtUAAAAJGNvcmUt
b3BzLWxlZ2FjeS1rZXkAAAA=
-----END OPENSSH PRIVATE KEY-----`;

/** 评审态：列表 / 生成表单 / 生成结果 / 导入解析 / 部署确认 */
type KeysPanel = "list" | "generate" | "generated" | "import" | "deploy";

const PANEL_OPTIONS: { value: KeysPanel; label: string }[] = [
	{ value: "list", label: "列表" },
	{ value: "generate", label: "生成" },
	{ value: "generated", label: "已生成" },
	{ value: "import", label: "导入" },
	{ value: "deploy", label: "部署" },
];

interface ParsedKey {
	format: string;
	type: KeyType;
	bits: number;
	fingerprint: string;
	comment: string;
	encrypted: boolean;
	publicKey: string;
}

/** 演示用的确定性指纹：同样的输入永远得到同样的串 */
function pseudoFingerprint(seed: string): string {
	let h = 2166136261;
	for (let i = 0; i < seed.length; i += 1) {
		h ^= seed.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	const head = (h >>> 0).toString(36).padStart(9, "0").slice(0, 9);
	const tail = (Math.imul(h ^ 0x9e3779b9, 2654435761) >>> 0).toString(36).padStart(9, "0").slice(0, 9);
	return `SHA256:${head}…${tail}`;
}

function buildPublicKey(type: KeyType, comment: string): string {
	return `${KEY_ALGO[type]} ${KEY_BODY[type]} ${comment}`;
}

function makeKey(type: KeyType, comment: string, withPassphrase: boolean): SshKey {
	const id = `key-${type}-${Date.now().toString(36)}`;
	return {
		id,
		name: comment,
		type,
		bits: KEY_TYPE_BITS[type],
		fingerprint: pseudoFingerprint(id + comment),
		publicKey: buildPublicKey(type, comment),
		comment,
		createdAt: new Date().toISOString(),
		deployedTo: [],
		hasPassphrase: withPassphrase,
	};
}

/** 解析粘贴 / 导入的私钥文本，识别格式、类型与是否加密 */
function parsePrivateKey(text: string): ParsedKey | null {
	const value = text.trim();
	if (!value) return null;
	const header = /-----BEGIN ([A-Z0-9 ]+)-----/.exec(value)?.[1];
	if (!header || !header.includes("PRIVATE KEY")) return null;

	const encrypted = /ENCRYPTED|bcrypt/i.test(value);
	const type: KeyType = /RSA/.test(header) || /ssh-rsa/.test(value) ? "rsa" : /EC|ECDSA/.test(header) ? "ecdsa" : "ed25519";
	const comment = /^#?\s*Comment:\s*(.+)$/m.exec(value)?.[1]?.trim() ?? "imported@local";

	return {
		format: header.includes("OPENSSH") ? `OpenSSH 私钥（${header}）` : `PEM / PKCS（${header}）`,
		type,
		bits: KEY_TYPE_BITS[type],
		fingerprint: pseudoFingerprint(value.slice(0, 512)),
		comment,
		encrypted,
		publicKey: buildPublicKey(type, comment),
	};
}

function envOfHost(hostId: string | undefined): Env {
	return hosts.find((h) => h.id === hostId)?.env ?? "dev";
}

export default function Keys() {
	const [keys, setKeys] = useState<SshKey[]>(sshKeys);
	const [selectedId, setSelectedId] = useState(sshKeys[0].id);

	/* 评审用状态 + 各流程的局部状态 */
	const [panel, setPanel] = useState<KeysPanel>("list");
	const [genType, setGenType] = useState<KeyType>("ed25519");
	const [genComment, setGenComment] = useState("deploy@workstation");
	const [genPassphrase, setGenPassphrase] = useState("");
	const [genUsePassphrase, setGenUsePassphrase] = useState(true);
	const [generated, setGenerated] = useState<SshKey | null>(null);

	const [importText, setImportText] = useState("");
	const [importName, setImportName] = useState("imported-key");
	const fileRef = useRef<HTMLInputElement>(null);

	const [targets, setTargets] = useState<string[]>(["order-api-01"]);
	const [deployUser, setDeployUser] = useState("deploy");
	const [confirmOpen, setConfirmOpen] = useState(false);
	const [deployedExtra, setDeployedExtra] = useState<Record<string, string[]>>({});

	const selected = keys.find((k) => k.id === selectedId) ?? keys[0];
	const deployed = Array.from(new Set([...selected.deployedTo, ...(deployedExtra[selected.id] ?? [])]));
	const selectedHosts = hosts.filter((h) => targets.includes(h.id));
	const jumpHost = selectedHosts.map((h) => h.jumpHostIds[0]).map((id) => hosts.find((h) => h.id === id)).find(Boolean);
	const parsed = parsePrivateKey(importText);
	const genOpen = panel === "generate" || panel === "generated";

	function copyText(text: string, label: string) {
		if (navigator.clipboard) void navigator.clipboard.writeText(text).catch(() => undefined);
		toast({ title: `${label}已复制到剪贴板`, description: label === "公钥" ? "可直接粘贴到服务器的 authorized_keys" : undefined, tone: "success" });
	}

	function toggleTarget(hostId: string) {
		setTargets((prev) => (prev.includes(hostId) ? prev.filter((id) => id !== hostId) : [...prev, hostId]));
	}

	/** 状态切换器：直接进入对应的评审态 */
	function choosePanel(next: KeysPanel) {
		setPanel(next);
		if (next === "generate") {
			setGenerated(null);
		} else if (next === "generated") {
			setGenerated(makeKey(genType, genComment.trim() || "deploy@workstation", genUsePassphrase));
		} else if (next === "import") {
			setImportText(SAMPLE_PRIVATE_KEY);
			setImportName("core-ops-legacy");
		} else if (next === "deploy") {
			setTargets(["order-api-01", "order-api-02"]);
			setConfirmOpen(true);
		}
	}

	function closePanel() {
		setPanel("list");
	}

	function handleGenerate() {
		const comment = genComment.trim() || "termx";
		const key = makeKey(genType, comment, genUsePassphrase && genPassphrase.length > 0);
		setGenerated(key);
		setKeys((prev) => [key, ...prev]);
		setSelectedId(key.id);
		toast({ title: "私钥已生成", description: `${KEY_TYPE_LABEL[key.type]} · 已保存到 ~/.ssh/`, tone: "success" });
	}

	function pickFile() {
		fileRef.current?.click();
	}

	async function handleFile(file: File | undefined) {
		if (!file) return;
		const text = await file.text();
		setImportText(text);
		setImportName(file.name.replace(/\.(pem|key|txt)$/i, ""));
		toast({ title: `已读取 ${file.name}`, description: "解析结果见右侧预览", tone: "default" });
	}

	function handleImport() {
		if (!parsed) return;
		const key: SshKey = {
			id: `key-imported-${Date.now().toString(36)}`,
			name: importName.trim() || parsed.comment,
			type: parsed.type,
			bits: parsed.bits,
			fingerprint: parsed.fingerprint,
			publicKey: parsed.publicKey,
			comment: parsed.comment,
			createdAt: new Date().toISOString(),
			deployedTo: [],
			hasPassphrase: parsed.encrypted,
		};
		setKeys((prev) => [key, ...prev]);
		setSelectedId(key.id);
		setPanel("list");
		setImportText("");
		toast({ title: "私钥已导入", description: `${key.name} · ${KEY_TYPE_LABEL[key.type]} ${key.bits} 位`, tone: "success" });
	}

	function handleDeploy() {
		const ids = selectedHosts.map((h) => h.id);
		setDeployedExtra((prev) => ({ ...prev, [selected.id]: Array.from(new Set([...(prev[selected.id] ?? []), ...ids])) }));
		setConfirmOpen(false);
		setPanel("list");
		toast({
			title: `公钥已写入 ${ids.length} 台主机`,
			description: `用户 ${deployUser} · ~/.ssh/authorized_keys（原文件已备份）`,
			tone: "success",
		});
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
						<Button
							size="sm"
							variant="primary"
							icon="icon-[lucide--plus]"
							className="h-6 px-2 text-[11px]"
							onClick={() => choosePanel("generate")}
						>
							生成密钥
						</Button>
					</div>

					<div className="flex-1 space-y-1.5 overflow-y-auto p-2">
						{keys.map((key) => {
							const bits = key.bits ?? KEY_TYPE_BITS[key.type];
							const hostIds = Array.from(new Set([...key.deployedTo, ...(deployedExtra[key.id] ?? [])]));
							const active = key.id === selected.id;
							return (
								<button
									key={key.id}
									type="button"
									onClick={() => setSelectedId(key.id)}
									className={cn(
										"w-full cursor-pointer rounded border p-2.5 text-left transition-colors",
										active ? "border-border bg-surface-raised shadow-sm" : "border-transparent bg-surface hover:border-border",
									)}
								>
									<div className="flex items-center justify-between gap-2 text-[12px]">
										<span className="truncate font-medium text-surface-foreground">{key.name}</span>
										<span className="shrink-0 rounded border border-border bg-surface px-1 py-0.5 font-mono text-[9.5px] text-primary">
											{KEY_TYPE_LABEL[key.type]} {bits}
										</span>
									</div>

									<div className="mt-1 truncate font-mono text-[10.5px] text-faint">{key.fingerprint}</div>

									<div className="mt-1 flex items-center justify-between gap-2 text-[10.5px] text-muted">
										<span className="flex min-w-0 items-center gap-1.5">
											{hostIds.length > 0 && <EnvStripe env={envOfHost(hostIds[0])} />}
											<span className="truncate">{hostIds.length > 0 ? `已部署 ${hostIds.length} 台主机` : "未部署到主机"}</span>
										</span>
										<span className="shrink-0 font-mono text-faint">{key.createdAt.slice(0, 10)}</span>
									</div>

									<div className="mt-1 flex items-center gap-2 text-[10px]">
										{key.hasPassphrase ? (
											<span className="flex items-center gap-1 text-warning">
												<span className="icon-[lucide--lock] size-2.5" />
												带口令短语
											</span>
										) : (
											<span className="flex items-center gap-1 text-faint">
												<span className="icon-[lucide--lock-open] size-2.5" />
												无口令
											</span>
										)}
									</div>
								</button>
							);
						})}
					</div>

					<div className="border-t border-border p-2">
						<button
							type="button"
							onClick={() => choosePanel("import")}
							className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-border bg-surface text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--upload] size-3" />
							<span>导入外部私钥文件 (PEM / OpenSSH)</span>
						</button>
					</div>
				</aside>

				{/* 右侧密钥详情与部署操作 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
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
										<Badge>{selected.bits ?? KEY_TYPE_BITS[selected.type]} 位</Badge>
										{selected.hasPassphrase ? (
											<Badge className="border-warning/40 text-warning">带口令</Badge>
										) : (
											<Badge>无口令</Badge>
										)}
									</div>
									<p className="mt-1 text-[11.5px] text-muted">
										创建于 {selected.createdAt.slice(0, 10)} ·{" "}
										{deployed.length > 0 ? `已部署到 ${deployed.length} 台主机` : "尚未部署到任何主机"} · 已受系统钥匙串与主密码保护
									</p>
								</div>

								<div className="flex shrink-0 items-center gap-2">
									<Button size="sm" icon="icon-[lucide--copy]" onClick={() => copyText(selected.publicKey, "公钥")}>
										复制公钥
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
								<span className="font-mono text-[11px] tracking-wider text-faint uppercase">
									Public Key (~/.ssh/id_{selected.type === "rsa" ? "rsa" : selected.type === "ecdsa" ? "ecdsa" : "ed25519"}.pub)
								</span>
								<div className="rounded border border-border bg-term p-2.5 font-mono text-[11px] leading-relaxed break-all text-term-ink">
									{selected.publicKey}
								</div>
							</div>

							{/* 已部署主机 */}
							<div className="mt-3.5 space-y-1">
								<span className="font-mono text-[11px] tracking-wider text-faint uppercase">Deployed To</span>
								{deployed.length > 0 ? (
									<div className="flex flex-wrap items-center gap-1.5">
										{deployed.map((hostId) => (
											<span
												key={hostId}
												className="inline-flex items-center gap-1.5 rounded border border-border bg-surface px-1.5 py-1 font-mono text-[10.5px] text-muted"
											>
												<EnvPill env={envOfHost(hostId)} size="xs" />
												{hostId}
											</span>
										))}
									</div>
								) : (
									<span className="text-[11px] text-faint">这个密钥还没部署到任何主机，可在下方多选目标主机写入。</span>
								)}
							</div>
						</div>

						{/* 部署公钥到远程主机卡片 */}
						<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
							<div className="flex items-center gap-2 border-b border-border pb-3">
								<span className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
									<span className="icon-[lucide--shield-plus] size-3" />
								</span>
								<div>
									<h3 className="text-[13px] font-semibold text-surface-foreground">部署公钥到远程主机</h3>
									<p className="text-[11px] text-muted">自动将此公钥追加写入目标主机的 ~/.ssh/authorized_keys（可多选）</p>
								</div>
								<span className="ml-auto font-mono text-[10.5px] text-faint">已选 {selectedHosts.length} 台</span>
							</div>

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
													<EnvStripe env={host.env} />
													<EnvPill env={host.env} size="xs" />
													<span className="shrink-0 font-mono text-[10.5px] text-faint">{host.hostname}</span>
												</div>
											);
										})}
									</div>
								</div>

								<div className="space-y-3">
									<Field label="登录用户名" hint="写入哪个用户的 authorized_keys">
										<Input value={deployUser} onChange={(e) => setDeployUser(e.target.value)} className="h-7.5 font-mono" />
									</Field>
									<div className="space-y-1">
										<span className="font-mono text-[10px] tracking-wider text-faint uppercase">目标路径</span>
										<ReadonlyValue>/home/{deployUser || "deploy"}/.ssh/authorized_keys</ReadonlyValue>
									</div>
									<div className="flex items-start gap-1.5 rounded border border-border bg-surface p-2 text-[10.5px] leading-4 text-faint">
										<span className="icon-[lucide--info] mt-px size-3 shrink-0" />
										<span>写入前会备份原文件为 authorized_keys.bak，已存在的相同公钥会自动跳过。</span>
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
										# {selectedHosts.length} 台主机 · 用户 {deployUser || "deploy"} · 追加模式（&gt;&gt;）
									</div>
									<div>{selected.publicKey}</div>
								</div>
							</div>

							<div className="mt-4 flex items-center justify-between border-t border-border pt-3">
								<span className="flex items-center gap-1.5 text-[11px] text-faint">
									<span className="icon-[lucide--route] size-3" />
									{jumpHost ? `经由跳板链路: ${jumpHost.name} (${jumpHost.hostname}:22)` : "直连，无跳板链路"}
								</span>
								<Button
									variant="primary"
									icon="icon-[lucide--send]"
									disabled={selectedHosts.length === 0}
									onClick={() => setConfirmOpen(true)}
								>
									开始写入公钥
								</Button>
							</div>
						</div>
					</div>
				</div>

				{/* 生成密钥抽屉 */}
				<Drawer
					open={genOpen}
					onClose={closePanel}
					title="生成 SSH 密钥"
					subtitle={generated ? "密钥已生成，复制公钥即可部署" : "私钥只保存在本机，不会上传"}
					width={470}
					footer={
						generated ? (
							<>
								<Button icon="icon-[lucide--copy]" onClick={() => copyText(generated.publicKey, "公钥")}>
									复制公钥
								</Button>
								<Button variant="primary" onClick={closePanel}>
									完成
								</Button>
							</>
						) : (
							<>
								<Button onClick={closePanel}>取消</Button>
								<Button variant="primary" icon="icon-[lucide--sparkles]" onClick={handleGenerate}>
									生成密钥
								</Button>
							</>
						)
					}
				>
					<div className="space-y-4 p-3">
						<Field label="密钥类型" hint={KEY_TYPE_HINT[genType]} required>
							<Select value={genType} onChange={(e) => setGenType(e.target.value as KeyType)}>
								<option value="ed25519">Ed25519（推荐）</option>
								<option value="rsa">RSA 4096</option>
								<option value="ecdsa">ECDSA P-521</option>
							</Select>
						</Field>

						<Field label="备注 / 注释" hint="写进公钥末尾，方便在服务器上辨认来源">
							<Input
								value={genComment}
								onChange={(e) => setGenComment(e.target.value)}
								placeholder="deploy@workstation"
								className="font-mono"
							/>
						</Field>

						<div className="space-y-2 rounded-control border border-border bg-surface p-2.5">
							<div className="flex items-center justify-between gap-3">
								<div>
									<div className="text-[11.5px] text-surface-foreground">使用口令短语保护</div>
									<div className="mt-0.5 text-[10.5px] text-faint">可选：留空则生成无口令私钥</div>
								</div>
								<Switch checked={genUsePassphrase} onChange={setGenUsePassphrase} label="使用口令短语保护" />
							</div>
							<Input
								type="password"
								value={genPassphrase}
								disabled={!genUsePassphrase}
								onChange={(e) => setGenPassphrase(e.target.value)}
								placeholder={genUsePassphrase ? "输入口令短语（可留空）" : "未启用口令保护"}
								className="font-mono"
							/>
						</div>

						<div className="space-y-1">
							<span className="font-mono text-[10px] tracking-wider text-faint uppercase">保存位置</span>
							<ReadonlyValue>
								~/.ssh/id_{genType === "rsa" ? "rsa" : genType === "ecdsa" ? "ecdsa" : "ed25519"}
								{" · "}
								{KEY_TYPE_BITS[genType]} 位
							</ReadonlyValue>
						</div>

						{generated && (
							<div className="space-y-3 rounded-control border border-success/40 bg-success/10 p-2.5">
								<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-success">
									<span className="icon-[lucide--circle-check] size-3.5" />
									已生成 {KEY_TYPE_LABEL[generated.type]} {generated.bits} 位密钥
									{generated.hasPassphrase ? "（带口令）" : "（无口令）"}
								</div>
								<div className="space-y-1">
									<span className="font-mono text-[10px] tracking-wider text-faint uppercase">Fingerprint</span>
									<div className="font-mono text-[11px] break-all text-surface-foreground">{generated.fingerprint}</div>
								</div>
								<div className="space-y-1">
									<span className="font-mono text-[10px] tracking-wider text-faint uppercase">Public Key</span>
									<div className="rounded border border-border bg-term p-2 font-mono text-[11px] leading-relaxed break-all text-term-ink">
										{generated.publicKey}
									</div>
								</div>
								<p className="text-[10.5px] leading-4 text-faint">私钥已保存到本机钥匙串；请把上面的公钥部署到目标主机。</p>
							</div>
						)}
					</div>
				</Drawer>

				{/* 导入私钥抽屉 */}
				<Drawer
					open={panel === "import"}
					onClose={closePanel}
					title="导入外部私钥"
					subtitle="支持 OpenSSH / PEM（PKCS#1、PKCS#8），内容只在本机解析"
					width={540}
					footer={
						<>
							<Button onClick={closePanel}>取消</Button>
							<Button variant="primary" icon="icon-[lucide--import]" disabled={!parsed} onClick={handleImport}>
								导入密钥
							</Button>
						</>
					}
				>
					<div className="space-y-4 p-3">
						<Field label="私钥名称" required>
							<Input value={importName} onChange={(e) => setImportName(e.target.value)} className="font-mono" />
						</Field>

						<Field label="粘贴私钥内容" hint="不会上传，仅在本地解析">
							<Textarea
								rows={7}
								value={importText}
								onChange={(e) => setImportText(e.target.value)}
								placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
								className="text-[10.5px]"
							/>
						</Field>

						<div className="flex items-center gap-2">
							<Button size="sm" icon="icon-[lucide--file-key]" onClick={pickFile}>
								选择文件…
							</Button>
							<Button size="sm" variant="ghost" icon="icon-[lucide--clipboard-paste]" onClick={() => setImportText(SAMPLE_PRIVATE_KEY)}>
								粘贴示例
							</Button>
							<Button size="sm" variant="ghost" icon="icon-[lucide--eraser]" onClick={() => setImportText("")}>
								清空
							</Button>
							<span className="ml-auto font-mono text-[10.5px] text-faint">{importText.trim().length} 字符</span>
							<input
								ref={fileRef}
								type="file"
								accept=".pem,.key,.txt,id_rsa,id_ed25519"
								className="hidden"
								onChange={(e) => void handleFile(e.target.files?.[0])}
							/>
						</div>

						{parsed ? (
							<div className="space-y-2 rounded-control border border-border bg-surface p-3">
								<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-surface-foreground">
									<span className="icon-[lucide--file-search] size-3.5 text-primary" />
									解析结果预览
								</div>
								<div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-[11px]">
									<span className="text-faint">格式</span>
									<span className="font-mono text-surface-foreground">{parsed.format}</span>
									<span className="text-faint">类型 / 位数</span>
									<span className="font-mono text-surface-foreground">
										{KEY_TYPE_LABEL[parsed.type]} · {parsed.bits} 位
									</span>
									<span className="text-faint">指纹</span>
									<span className="font-mono break-all text-surface-foreground">{parsed.fingerprint}</span>
									<span className="text-faint">备注</span>
									<span className="font-mono text-surface-foreground">{parsed.comment}</span>
									<span className="text-faint">口令保护</span>
									<span className={cn("font-mono", parsed.encrypted ? "text-warning" : "text-muted")}>
										{parsed.encrypted ? "已加密（导入后需输入口令）" : "未加密"}
									</span>
								</div>
								<div className="space-y-1">
									<span className="font-mono text-[10px] tracking-wider text-faint uppercase">推导出的公钥</span>
									<div className="rounded border border-border bg-term p-2 font-mono text-[10.5px] leading-relaxed break-all text-term-ink">
										{parsed.publicKey}
									</div>
								</div>
							</div>
						) : (
							<EmptyState
								icon="icon-[lucide--file-key]"
								title="尚未解析出密钥"
								description="粘贴私钥内容或点击「选择文件」，格式、位数、指纹与公钥会实时显示在这里。"
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
					title="确认写入公钥"
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
							<Button variant="primary" icon="icon-[lucide--send]" onClick={handleDeploy}>
								确认写入
							</Button>
						</>
					}
				>
					<p className="mb-2">
						将把 <span className="font-mono text-surface-foreground">{selected.name}</span> 的公钥追加到下列{" "}
						{selectedHosts.length} 台主机的{" "}
						<span className="font-mono">/home/{deployUser || "deploy"}/.ssh/authorized_keys</span>，写入前会先备份原文件。
					</p>
					<div className="mb-2 space-y-1">
						{selectedHosts.map((host) => (
							<div key={host.id} className="flex items-center gap-2">
								<EnvPill env={host.env} size="xs" />
								<span className="font-mono text-[11px] text-surface-foreground">{host.name}</span>
								<span className="font-mono text-[10.5px] text-faint">
									{deployUser || "deploy"}@{host.hostname}:{host.port}
								</span>
								{deployed.includes(host.id) && <Badge className="border-success/40 text-success">已存在</Badge>}
							</div>
						))}
					</div>
					<div className="rounded border border-border bg-term p-2 font-mono text-[10.5px] leading-relaxed break-all text-term-ink">
						{selected.publicKey}
					</div>
					<p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-faint">
						<span className="icon-[lucide--fingerprint] size-3" />
						首次连接的主机会先弹出指纹确认，确认后才写入。
					</p>
				</Modal>

				{/* 状态切换器（骨架期评审工具） */}
				<div className="absolute right-3 bottom-3 z-30 flex items-center gap-2 rounded-card border border-border bg-surface-raised px-2 py-1.5 shadow-lg">
					<span className="text-[10px] font-medium tracking-wider text-faint uppercase">状态</span>
					<div className="flex items-center gap-0.5">
						{PANEL_OPTIONS.map((option) => (
							<button
								key={option.value}
								type="button"
								onClick={() => choosePanel(option.value)}
								className={cn(
									"rounded px-1.5 py-0.5 text-[11px] transition-colors",
									panel === option.value ? "bg-primary/15 font-medium text-primary" : "text-muted hover:text-surface-foreground",
								)}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
