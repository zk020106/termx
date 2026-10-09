import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState } from "@/components/ui/Display";
import { Field, Input, Select } from "@/components/ui/Input";
import { ContextMenu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { Drawer, Modal } from "@/components/ui/Overlay";
import type { ProxyProfile } from "@/data/types";
import { cn } from "@/lib/cn";
import { proxyProfileSecretAccount } from "@/lib/configSecrets";
import {
	PROXY_PROFILE_ERROR_TEXT,
	createDraftProfile,
	duplicateProxyProfile,
	formatProxyConfigEndpoint,
	formatProxyConfigType,
	getProfileUsageCount,
	prepareProxyProfileForSave,
	removeProxyProfileReferences,
} from "@/lib/proxyProfiles";
import { secretDelete, secretLoad, secretSave } from "@/lib/secret";
import { useHostsStore } from "@/store/hosts";
import { useProxyProfilesStore } from "@/store/proxyProfiles";
import { toast } from "@/store/toast";
import { useMemo, useState } from "react";

/* =============================================================================
 * 代理 —— 对应 Netcatty components/ProxyProfilesManager.tsx（Vault「代理」分区）。
 * 可复用的 HTTP / SOCKS5 代理配置，在主机设置的「网络」里选择「已保存代理」引用。
 * 右键菜单与 Netcatty 一致：编辑 / 复制 | 删除（删除时解除所有主机上的引用）。
 * 差异：ProxyCommand 与「钥匙串身份」凭据不移植——TermX 原生层没有 ProxyCommand 通道，
 * 也没有身份（identity）实体；口令存系统钥匙串，不进配置文件。
 * ========================================================================== */

const TYPE_ICON: Record<ProxyProfile["config"]["type"], string> = {
	http: "icon-[lucide--globe]",
	socks5: "icon-[lucide--route]",
};

export default function Proxies() {
	const profiles = useProxyProfilesStore((s) => s.profiles);
	const hosts = useHostsStore((s) => s.hosts);
	const [search, setSearch] = useState("");
	const [draft, setDraft] = useState<ProxyProfile | null>(null);
	const [draftPassword, setDraftPassword] = useState("");
	const [initialPassword, setInitialPassword] = useState("");
	const [deleteTarget, setDeleteTarget] = useState<ProxyProfile | null>(null);
	const [menu, setMenu] = useState<{ x: number; y: number; profile: ProxyProfile } | null>(null);

	const filtered = useMemo(() => {
		const q = search.trim().toLowerCase();
		if (!q) return profiles;
		return profiles.filter(
			(p) => p.label.toLowerCase().includes(q) || p.config.host.toLowerCase().includes(q) || p.config.type.toLowerCase().includes(q),
		);
	}, [profiles, search]);

	const isNew = draft ? !profiles.some((p) => p.id === draft.id) : false;

	const openCreate = () => {
		setDraft(createDraftProfile());
		setDraftPassword("");
		setInitialPassword("");
	};

	const openEdit = (profile: ProxyProfile) => {
		setDraft({ ...profile, config: { ...profile.config } });
		setDraftPassword("");
		setInitialPassword("");
		if (profile.config.username) {
			void secretLoad(proxyProfileSecretAccount(profile.id))
				.then((saved) => {
					if (saved) {
						setDraftPassword(saved);
						setInitialPassword(saved);
					}
				})
				.catch(() => undefined);
		}
	};

	const duplicate = async (profile: ProxyProfile) => {
		const copy = duplicateProxyProfile(profile);
		useProxyProfilesStore.getState().upsert(copy);
		// 复制整份配置（Netcatty 复制 config 含凭据）：口令也一并复制到新条目
		if (profile.config.username) {
			try {
				const saved = await secretLoad(proxyProfileSecretAccount(profile.id));
				if (saved) await secretSave(proxyProfileSecretAccount(copy.id), saved);
			} catch (error) {
				toast({ title: "代理口令未能复制", description: String(error), tone: "warning" });
			}
		}
	};

	const save = async () => {
		if (!draft) return;
		const result = prepareProxyProfileForSave(draft);
		if (!result.saved) {
			toast({ title: PROXY_PROFILE_ERROR_TEXT[result.error ?? "required"], tone: "danger" });
			return;
		}
		const saved = result.saved;
		useProxyProfilesStore.getState().upsert(saved);
		const account = proxyProfileSecretAccount(saved.id);
		if (!saved.config.username) {
			await secretDelete(account).catch(() => undefined);
		} else if (draftPassword !== initialPassword) {
			if (draftPassword) {
				await secretSave(account, draftPassword).catch((error: unknown) => {
					toast({ title: "代理口令未能存入钥匙串", description: String(error), tone: "warning" });
				});
			} else {
				await secretDelete(account).catch(() => undefined);
			}
		}
		setDraft(null);
	};

	const confirmDelete = () => {
		if (!deleteTarget) return;
		const hostStore = useHostsStore.getState();
		hostStore.setAll(removeProxyProfileReferences(deleteTarget.id, hostStore.hosts), hostStore.groups);
		useProxyProfilesStore.getState().remove(deleteTarget.id);
		void secretDelete(proxyProfileSecretAccount(deleteTarget.id)).catch(() => undefined);
		if (draft?.id === deleteTarget.id) setDraft(null);
		setDeleteTarget(null);
	};

	const updateConfig = <K extends keyof ProxyProfile["config"]>(key: K, value: ProxyProfile["config"][K]) =>
		setDraft((prev) => (prev ? { ...prev, config: { ...prev.config, [key]: value } } : prev));

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-surface">
				<div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-4">
					<span className="icon-[lucide--route] size-3.5 text-primary" />
					<h1 className="text-[12px] font-semibold text-surface-foreground">代理</h1>
					<Button size="sm" variant="primary" icon="icon-[lucide--plus]" className="ml-2 h-6 px-2 text-[11px]" onClick={openCreate}>
						添加代理
					</Button>
					<Input
						value={search}
						onChange={(e) => setSearch(e.target.value)}
						placeholder="搜索代理…"
						aria-label="搜索代理…"
						className="ml-auto w-56"
					/>
				</div>

				<div className="min-h-0 flex-1 overflow-y-auto p-4">
					{profiles.length === 0 ? (
						<EmptyState
							icon="icon-[lucide--route]"
							title="暂无代理"
							description="创建可复用的 HTTP 或 SOCKS5 代理，然后在主机设置里选择。"
							action={
								<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openCreate}>
									添加代理
								</Button>
							}
						/>
					) : (
						<>
							<div className="mb-2 flex items-center gap-2 text-[11px] text-muted">
								<span className="font-semibold text-surface-foreground">代理</span>
								<span>{filtered.length} 项</span>
							</div>
							<div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-2">
								{filtered.map((profile) => {
									const usage = getProfileUsageCount(profile.id, hosts);
									return (
										<button
											key={profile.id}
											type="button"
											onClick={() => openEdit(profile)}
											onContextMenu={(e) => {
												e.preventDefault();
												setMenu({ x: e.clientX, y: e.clientY, profile });
											}}
											className={cn(
												"flex h-[60px] items-center gap-3 rounded-lg border bg-surface-raised px-3 text-left transition-colors hover:border-primary/50",
												draft?.id === profile.id ? "border-primary" : "border-border",
											)}
										>
											<span className="grid size-8 shrink-0 place-items-center rounded-md bg-primary/10 text-primary">
												<span className={cn(TYPE_ICON[profile.config.type], "size-4")} />
											</span>
											<span className="min-w-0 flex-1">
												<span className="block truncate text-[12.5px] font-semibold text-surface-foreground">{profile.label}</span>
												<span className="block truncate font-mono text-[10.5px] text-muted">
													{formatProxyConfigType(profile.config)} · {formatProxyConfigEndpoint(profile.config)}
												</span>
											</span>
											<Badge>已关联 {usage} 处</Badge>
										</button>
									);
								})}
							</div>
						</>
					)}
				</div>

				<Drawer
					open={draft !== null}
					onClose={() => setDraft(null)}
					title={draft?.label.trim() || (isNew ? "新建代理" : "编辑代理")}
					subtitle="口令存系统钥匙串，不写进配置文件"
					width={380}
					footer={
						<>
							<Button onClick={() => setDraft(null)}>取消</Button>
							<Button variant="primary" icon="icon-[lucide--check]" onClick={() => void save()}>
								保存
							</Button>
						</>
					}
				>
					{draft && (
						<div className="space-y-3 p-3">
							<Field label="代理名称" required>
								<Input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="代理名称" />
							</Field>
							<Field label="类型">
								<Select
									value={draft.config.type}
									onChange={(e) => updateConfig("type", e.target.value as ProxyProfile["config"]["type"])}
								>
									<option value="http">HTTP</option>
									<option value="socks5">SOCKS5</option>
								</Select>
							</Field>
							<div className="grid grid-cols-[1fr_96px] gap-2">
								<Field label="代理主机" required>
									<Input
										value={draft.config.host}
										onChange={(e) => updateConfig("host", e.target.value)}
										placeholder="代理主机"
										className="font-mono"
									/>
								</Field>
								<Field label="端口" required>
									<Input
										value={String(draft.config.port || "")}
										onChange={(e) => updateConfig("port", Number(e.target.value.replace(/\D/g, "")) || 0)}
										inputMode="numeric"
										className="font-mono"
									/>
								</Field>
							</div>
							<div className="space-y-2 rounded-control border border-border p-2.5">
								<div className="flex items-center gap-2 text-[11.5px] font-semibold text-surface-foreground">
									凭据 <Badge>可选</Badge>
								</div>
								<Field label="用户名">
									<Input
										value={draft.config.username ?? ""}
										onChange={(e) => updateConfig("username", e.target.value)}
										placeholder="用户名"
										autoComplete="off"
										className="font-mono"
									/>
								</Field>
								<Field label="密码">
									<Input
										type="password"
										value={draftPassword}
										onChange={(e) => setDraftPassword(e.target.value)}
										disabled={!draft.config.username?.trim()}
										placeholder="密码"
										autoComplete="new-password"
										className="font-mono"
									/>
								</Field>
							</div>
						</div>
					)}
				</Drawer>

				<Modal
					open={deleteTarget !== null}
					onClose={() => setDeleteTarget(null)}
					title="删除代理？"
					icon="icon-[lucide--trash-2]"
					footer={
						<>
							<Button onClick={() => setDeleteTarget(null)}>取消</Button>
							<Button variant="danger" icon="icon-[lucide--trash-2]" onClick={confirmDelete}>
								删除
							</Button>
						</>
					}
				>
					{deleteTarget && (
						<p className="text-[12px] text-muted">
							删除 "{deleteTarget.label}" 会同时从 {getProfileUsageCount(deleteTarget.id, hosts)} 个主机设置中解除关联。
						</p>
					)}
				</Modal>

				{menu && (
					<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="代理菜单">
						<MenuItem
							icon="icon-[lucide--pencil]"
							label="编辑"
							onClick={() => {
								openEdit(menu.profile);
								setMenu(null);
							}}
						/>
						<MenuItem
							icon="icon-[lucide--copy]"
							label="复制"
							onClick={() => {
								void duplicate(menu.profile);
								setMenu(null);
							}}
						/>
						<MenuSeparator />
						<MenuItem
							icon="icon-[lucide--trash-2]"
							label="删除"
							danger
							onClick={() => {
								setDeleteTarget(menu.profile);
								setMenu(null);
							}}
						/>
					</ContextMenu>
				)}
			</div>
		</WindowChrome>
	);
}
