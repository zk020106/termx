import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Overlay";
import type { GroupConfig, ProxyConfig } from "@/data/types";
import { resolveGroupDefaults } from "@/lib/groupConfig";
import { formatProxyConfigEndpoint, formatProxyConfigType, isValidProxyPort } from "@/lib/proxyProfiles";
import { secretDelete, secretLoad, secretSave } from "@/lib/secret";
import { groupSecretAccount, useGroupConfigsStore } from "@/store/groupConfigs";
import { useHostsStore } from "@/store/hosts";
import { useIdentitiesStore } from "@/store/identities";
import { useKeysStore } from "@/store/keys";
import { useProxyProfilesStore } from "@/store/proxyProfiles";
import { toast } from "@/store/toast";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { COLOR_SCHEMES } from "./HostEditModal";

/* =============================================================================
 * 分组设置 —— 移植 Netcatty GroupDetailsPanel + GroupSshSettingsSection：
 *  常规（分组名称 / 父分组）· SSH（端口、钥匙串身份或用户名 / 密码 / 密钥、启动命令、代理、跳板链、环境变量）
 *  · 高级（字符编码）· 外观（配色 / 字体 / 字号，「使用全局」= 清除覆盖）。
 * 字段留空 = 不设置（继续继承父分组；都没有时用全局默认）。分组下主机自己没设置的字段从这里继承。
 * 分组密码在系统钥匙串 group:<groupId>，代理口令在 group-proxy:<groupId>，配置里只有 hasPassword 标记。
 * ========================================================================== */

export const groupProxySecretAccount = (groupId: string) => `group-proxy:${groupId}`;

const FONTS = ["JetBrains Mono", "Cascadia Code", "Consolas", "Fira Code", "系统等宽字体"];
const ENCODINGS = ["UTF-8", "GBK", "GB18030", "GB2312", "ISO-8859-1", "Big5"];

interface Form {
	name: string;
	parentId: string;
	port: string;
	identityId: string;
	username: string;
	password: string;
	authMethod: "" | "password" | "key";
	keyId: string;
	keyPath: string;
	startupCommand: string;
	proxyMode: "" | "profile" | "manual";
	proxyProfileId: string;
	proxyType: "socks5" | "http" | "command";
	proxyHost: string;
	proxyPort: string;
	proxyCommand: string;
	proxyIdentityId: string;
	proxyUsername: string;
	proxyPassword: string;
	jumpHostIds: string[];
	envVars: { key: string; value: string }[];
	charset: string;
	theme: string;
	fontFamily: string;
	fontSize: string;
}

function toForm(config: GroupConfig | undefined, name: string, parentId: string | null): Form {
	const p = config?.proxyConfig;
	return {
		name,
		parentId: parentId ?? "",
		port: config?.port ? String(config.port) : "",
		identityId: config?.identityId ?? "",
		username: config?.username ?? "",
		password: "",
		authMethod: config?.authMethod === "key" || config?.authMethod === "password" ? config.authMethod : config?.keyId || config?.keyPath ? "key" : "",
		keyId: config?.keyId ?? "",
		keyPath: config?.keyPath ?? "",
		startupCommand: config?.startupCommand ?? "",
		proxyMode: config?.proxyProfileId ? "profile" : p ? "manual" : "",
		proxyProfileId: config?.proxyProfileId ?? "",
		proxyType: p?.type ?? "socks5",
		proxyHost: p?.host ?? "",
		proxyPort: p?.port ? String(p.port) : "",
		proxyCommand: p?.command ?? "",
		proxyIdentityId: p?.identityId ?? "",
		proxyUsername: p?.username ?? "",
		proxyPassword: "",
		jumpHostIds: config?.jumpHostIds ?? [],
		envVars: config?.environmentVariables ?? [],
		charset: config?.charset ?? "",
		theme: config?.themeOverride !== false ? (config?.theme ?? "") : "",
		fontFamily: config?.fontFamilyOverride !== false ? (config?.fontFamily ?? "") : "",
		fontSize: config?.fontSizeOverride !== false && config?.fontSize ? String(config.fontSize) : "",
	};
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
	return (
		<section className="space-y-2 rounded-lg border border-border/80 bg-surface-raised/40 p-3">
			<div className="flex items-center gap-1.5 text-[11.5px] font-semibold text-surface-foreground">
				<span className={`${icon} size-3.5 text-muted`} />
				{title}
			</div>
			{children}
		</section>
	);
}

/** 「使用全局」（Netcatty HostDetailsOverrideReset） */
function UseGlobal({ onClick }: { onClick: () => void }) {
	return (
		<button type="button" className="shrink-0 text-[10.5px] text-primary hover:underline" onClick={onClick}>
			使用全局
		</button>
	);
}

export function GroupSettingsDrawer({ groupId, onClose }: { groupId: string | null; onClose: () => void }) {
	const groups = useHostsStore((s) => s.groups);
	const hosts = useHostsStore((s) => s.hosts);
	const configs = useGroupConfigsStore((s) => s.configs);
	const identities = useIdentitiesStore((s) => s.identities);
	const keys = useKeysStore((s) => s.keys);
	const proxyProfiles = useProxyProfilesStore((s) => s.profiles);
	const group = groups.find((g) => g.id === groupId);
	const config = configs.find((c) => c.groupId === groupId);
	const [form, setForm] = useState<Form>(() => toForm(config, group?.name ?? "", group?.parentId ?? null));
	const [initialPassword, setInitialPassword] = useState("");
	const [initialProxyPassword, setInitialProxyPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [nameError, setNameError] = useState<string | null>(null);

	useEffect(() => {
		if (!groupId) return;
		const g = useHostsStore.getState().groups.find((x) => x.id === groupId);
		const c = useGroupConfigsStore.getState().configs.find((x) => x.groupId === groupId);
		setForm(toForm(c, g?.name ?? "", g?.parentId ?? null));
		setInitialPassword("");
		setInitialProxyPassword("");
		setShowPassword(false);
		setNameError(null);
		if (c?.hasPassword) {
			void secretLoad(groupSecretAccount(groupId))
				.then((v) => {
					if (v) {
						setForm((f) => ({ ...f, password: v }));
						setInitialPassword(v);
					}
				})
				.catch(() => undefined);
		}
		if (c?.proxyConfig?.username && !c.proxyConfig.identityId) {
			void secretLoad(groupProxySecretAccount(groupId))
				.then((v) => {
					if (v) {
						setForm((f) => ({ ...f, proxyPassword: v }));
						setInitialProxyPassword(v);
					}
				})
				.catch(() => undefined);
		}
	}, [groupId]);

	/** 父分组提供的值（Netcatty inheritedConnectionDefaults），用作占位提示 */
	const inherited = useMemo(
		() => (form.parentId ? resolveGroupDefaults(form.parentId, groups, configs) : {}),
		[form.parentId, groups, configs],
	);
	/** 不能把分组移到自己或自己的子孙下面 */
	const descendantIds = useMemo(() => {
		const out = new Set<string>(groupId ? [groupId] : []);
		let grew = true;
		while (grew) {
			grew = false;
			for (const g of groups) if (g.parentId && out.has(g.parentId) && !out.has(g.id)) (out.add(g.id), (grew = true));
		}
		return out;
	}, [groups, groupId]);

	if (!groupId || !group) return null;
	const update = <K extends keyof Form>(key: K, value: Form[K]) => setForm((f) => ({ ...f, [key]: value }));
	const privateKeys = keys.filter((k) => k.hasPrivateKey);
	const jumpCandidates = hosts.filter((h) => !form.jumpHostIds.includes(h.id));

	const save = async () => {
		const name = form.name.trim();
		if (!name) return setNameError("分组名称不能为空。");
		if (/[/\\]/.test(name)) return setNameError("分组名称不能包含 '/' 或 '\\'.");
		if (groups.some((g) => g.id !== groupId && (g.parentId ?? "") === form.parentId && g.name === name)) {
			return setNameError("该位置已存在同名分组。");
		}
		if (form.proxyMode === "manual" && form.proxyType === "command" && !form.proxyCommand.trim()) {
			toast({ title: "请输入 ProxyCommand", tone: "danger" });
			return;
		}
		if (form.proxyMode === "manual" && form.proxyType !== "command" && (!form.proxyHost.trim() || !isValidProxyPort(form.proxyPort.trim() || "1080"))) {
			toast({ title: "代理地址或端口无效", tone: "danger" });
			return;
		}
		const port = Number(form.port);
		if (form.port.trim() && !(Number.isInteger(port) && port > 0 && port < 65536)) {
			toast({ title: "端口无效", tone: "danger" });
			return;
		}

		const useIdentity = Boolean(form.identityId);
		let hasPassword: boolean | undefined = config?.hasPassword;
		if (useIdentity) {
			if (config?.hasPassword) void secretDelete(groupSecretAccount(groupId)).catch(() => undefined);
			hasPassword = undefined;
		} else if (form.password !== initialPassword) {
			try {
				if (form.password) await secretSave(groupSecretAccount(groupId), form.password);
				else await secretDelete(groupSecretAccount(groupId));
				hasPassword = form.password ? true : undefined;
			} catch (error) {
				toast({ title: "分组密码未能存入系统钥匙串", description: String(error), tone: "warning" });
				hasPassword = undefined;
			}
		}

		let proxyConfig: ProxyConfig | undefined;
		if (form.proxyMode === "manual") {
			proxyConfig =
				form.proxyType === "command"
					? { type: "command", host: "", port: 0, command: form.proxyCommand.trim() }
					: {
							type: form.proxyType,
							host: form.proxyHost.trim(),
							port: Number(form.proxyPort) || 1080,
							...(form.proxyIdentityId
								? { identityId: form.proxyIdentityId }
								: form.proxyUsername.trim()
									? { username: form.proxyUsername.trim() }
									: {}),
						};
		}
		const keepsProxyPassword = proxyConfig?.username && !proxyConfig.identityId;
		if (!keepsProxyPassword) {
			if (initialProxyPassword) void secretDelete(groupProxySecretAccount(groupId)).catch(() => undefined);
		} else if (form.proxyPassword !== initialProxyPassword) {
			try {
				if (form.proxyPassword) await secretSave(groupProxySecretAccount(groupId), form.proxyPassword);
				else await secretDelete(groupProxySecretAccount(groupId));
			} catch (error) {
				toast({ title: "代理口令未能存入系统钥匙串", description: String(error), tone: "warning" });
			}
		}

		const fontSize = Number(form.fontSize);
		const next: GroupConfig = {
			groupId,
			...(useIdentity
				? { identityId: form.identityId }
				: {
						username: form.username.trim() || undefined,
						hasPassword,
						authMethod: form.authMethod || undefined,
						keyId: form.authMethod === "key" ? form.keyId || undefined : undefined,
						keyPath: form.authMethod === "key" && !form.keyId ? form.keyPath.trim() || undefined : undefined,
					}),
			port: form.port.trim() ? port : undefined,
			proxyProfileId: form.proxyMode === "profile" && form.proxyProfileId ? form.proxyProfileId : undefined,
			proxyConfig,
			jumpHostIds: form.jumpHostIds.length ? form.jumpHostIds : undefined,
			startupCommand: form.startupCommand.trim() || undefined,
			environmentVariables: form.envVars.filter((v) => v.key.trim()).length ? form.envVars.filter((v) => v.key.trim()) : undefined,
			charset: form.charset || undefined,
			termType: config?.termType,
			theme: form.theme || undefined,
			themeOverride: form.theme ? true : undefined,
			fontFamily: form.fontFamily || undefined,
			fontFamilyOverride: form.fontFamily ? true : undefined,
			fontSize: form.fontSize.trim() && fontSize > 0 ? fontSize : undefined,
			fontSizeOverride: form.fontSize.trim() && fontSize > 0 ? true : undefined,
		};
		const store = useHostsStore.getState();
		if (name !== group.name) store.renameGroup(groupId, name);
		if ((group.parentId ?? "") !== form.parentId) store.moveGroup(groupId, form.parentId || null);
		useGroupConfigsStore.getState().save(next);
		toast({ title: `已保存分组「${name}」的设置`, tone: "success" });
		onClose();
	};

	return (
		<Drawer
			open
			onClose={onClose}
			title="分组详情"
			subtitle="分组下的主机没设置的字段会继承这里；子分组覆盖父分组"
			width={460}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" icon="icon-[lucide--check]" disabled={!form.name.trim()} onClick={() => void save()}>
						保存
					</Button>
				</>
			}
		>
			<div className="space-y-3 p-3">
				<Section icon="icon-[lucide--settings-2]" title="常规">
					<Input
						value={form.name}
						onChange={(e) => {
							update("name", e.target.value);
							setNameError(null);
						}}
						placeholder="分组名称"
					/>
					{nameError && <p className="text-[10.5px] text-danger">{nameError}</p>}
					<Field label="父分组">
						<Select value={form.parentId} onChange={(e) => update("parentId", e.target.value)}>
							<option value="">无</option>
							{groups
								.filter((g) => !descendantIds.has(g.id))
								.map((g) => (
									<option key={g.id} value={g.id}>
										{g.name}
									</option>
								))}
						</Select>
					</Field>
				</Section>

				<Section icon="icon-[lucide--square-terminal]" title="SSH">
					<div className="flex h-8 items-center gap-2 rounded-md border border-border/70 bg-surface px-2">
						<span className="text-[11px] text-muted">SSH on</span>
						<Input
							value={form.port}
							onChange={(e) => update("port", e.target.value.replace(/[^\d]/g, ""))}
							placeholder={String(inherited.port ?? 22)}
							inputMode="numeric"
							className="ml-auto h-6 w-20 text-center font-mono text-xs"
						/>
						<span className="text-[11px] text-muted">端口</span>
					</div>
					{(identities.length > 0 || form.identityId) && (
						<Select value={form.identityId} onChange={(e) => update("identityId", e.target.value)}>
							<option value="">钥匙串身份（不使用）</option>
							{identities.map((i) => (
								<option key={i.id} value={i.id}>
									{i.label} - {i.username}
								</option>
							))}
							{form.identityId && !identities.some((i) => i.id === form.identityId) && <option value={form.identityId}>钥匙串身份不存在</option>}
						</Select>
					)}
					{!form.identityId && (
						<>
							<Input value={form.username} onChange={(e) => update("username", e.target.value)} placeholder={inherited.username ?? "用户名"} className="font-mono" />
							<div className="relative">
								<Input
									type={showPassword ? "text" : "password"}
									value={form.password}
									onChange={(e) => update("password", e.target.value)}
									placeholder="密码"
									autoComplete="new-password"
									className="pr-8 font-mono"
								/>
								<button
									type="button"
									className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-surface-foreground"
									onClick={() => setShowPassword(!showPassword)}
								>
									<span className={showPassword ? "icon-[lucide--eye-off] size-3.5" : "icon-[lucide--eye] size-3.5"} />
								</button>
							</div>
							<Field label="认证方式">
								<Select value={form.authMethod} onChange={(e) => update("authMethod", e.target.value as Form["authMethod"])}>
									<option value="">不设置（继承）</option>
									<option value="password">密码</option>
									<option value="key">密钥</option>
								</Select>
							</Field>
							{form.authMethod === "key" && (
								<>
									<Select value={form.keyId} onChange={(e) => update("keyId", e.target.value)}>
										<option value="">本地私钥文件（下方路径）</option>
										{privateKeys.map((k) => (
											<option key={k.id} value={k.id}>
												{k.name} · {k.type.toUpperCase()}
											</option>
										))}
									</Select>
									{!form.keyId && (
										<div className="flex gap-1">
											<Input value={form.keyPath} onChange={(e) => update("keyPath", e.target.value)} placeholder="~/.ssh/id_ed25519" className="font-mono text-xs" />
											<Button
												size="sm"
												icon="icon-[lucide--folder-open]"
												onClick={async () => {
													const picked = await openFileDialog({ multiple: false, directory: false }).catch(() => null);
													if (typeof picked === "string") update("keyPath", picked);
												}}
											/>
										</div>
									)}
								</>
							)}
						</>
					)}
					<Field label="启动命令">
						<Textarea rows={2} value={form.startupCommand} onChange={(e) => update("startupCommand", e.target.value)} placeholder={inherited.startupCommand ?? "连接后自动执行的命令"} />
					</Field>

					<Field label="代理">
						<Select value={form.proxyMode} onChange={(e) => update("proxyMode", e.target.value as Form["proxyMode"])}>
							<option value="">不设置（继承）</option>
							<option value="profile">已保存代理</option>
							<option value="manual">自定义代理</option>
						</Select>
					</Field>
					{form.proxyMode === "profile" && (
						<Select value={form.proxyProfileId} onChange={(e) => update("proxyProfileId", e.target.value)}>
							<option value="">选择已保存代理</option>
							{proxyProfiles.map((p) => (
								<option key={p.id} value={p.id}>
									{p.label} · {formatProxyConfigType(p.config)} {formatProxyConfigEndpoint(p.config)}
								</option>
							))}
							{form.proxyProfileId && !proxyProfiles.some((p) => p.id === form.proxyProfileId) && (
								<option value={form.proxyProfileId}>缺失 · 保存的代理不存在</option>
							)}
						</Select>
					)}
					{form.proxyMode === "manual" && (
						<div className="space-y-2 rounded-md border border-border/60 p-2">
							<Select value={form.proxyType} onChange={(e) => update("proxyType", e.target.value as Form["proxyType"])}>
								<option value="socks5">SOCKS5</option>
								<option value="http">HTTP</option>
								<option value="command">ProxyCommand</option>
							</Select>
							{form.proxyType === "command" ? (
								<Field label="ProxyCommand" hint="使用 %h 表示目标主机，%p 表示目标端口，%% 表示字面百分号。">
									<Input value={form.proxyCommand} onChange={(e) => update("proxyCommand", e.target.value)} placeholder="cloudflared access ssh --hostname %h" className="font-mono text-xs" />
								</Field>
							) : (
								<>
									<div className="grid grid-cols-[1fr_80px] gap-2">
										<Input value={form.proxyHost} onChange={(e) => update("proxyHost", e.target.value)} placeholder="127.0.0.1" className="font-mono text-xs" />
										<Input value={form.proxyPort} onChange={(e) => update("proxyPort", e.target.value)} placeholder="1080" inputMode="numeric" className="text-center font-mono text-xs" />
									</div>
									{identities.length > 0 && (
										<Select value={form.proxyIdentityId} onChange={(e) => update("proxyIdentityId", e.target.value)}>
											<option value="">手动凭据</option>
											{identities.map((i) => (
												<option key={i.id} value={i.id}>
													{i.label} - {i.username}
												</option>
											))}
										</Select>
									)}
									{!form.proxyIdentityId && (
										<div className="grid grid-cols-2 gap-2">
											<Input value={form.proxyUsername} onChange={(e) => update("proxyUsername", e.target.value)} placeholder="代理用户名（可选）" className="font-mono text-xs" />
											<Input
												type="password"
												value={form.proxyPassword}
												onChange={(e) => update("proxyPassword", e.target.value)}
												placeholder="代理口令（可选）"
												disabled={!form.proxyUsername.trim()}
												autoComplete="new-password"
												className="font-mono text-xs"
											/>
										</div>
									)}
								</>
							)}
						</div>
					)}

					<Field label="跳板链">
						<div className="space-y-1">
							{form.jumpHostIds.map((id, idx) => (
								<div key={id} className="flex items-center gap-2 rounded border border-border/60 px-2 py-1 text-[11px]">
									<span className="font-mono text-faint">{idx + 1}</span>
									<span className="flex-1 truncate">{hosts.find((h) => h.id === id)?.name ?? "主机不存在"}</span>
									<button type="button" className="text-muted hover:text-danger" onClick={() => update("jumpHostIds", form.jumpHostIds.filter((x) => x !== id))}>
										<span className="icon-[lucide--x] size-3" />
									</button>
								</div>
							))}
							<Select
								value=""
								onChange={(e) => {
									if (e.target.value) update("jumpHostIds", [...form.jumpHostIds, e.target.value]);
								}}
							>
								<option value="">{form.jumpHostIds.length ? "添加下一跳…" : inherited.jumpHostIds?.length ? `继承父分组（${inherited.jumpHostIds.length} 跳）` : "添加跳板机…"}</option>
								{jumpCandidates.map((h) => (
									<option key={h.id} value={h.id}>
										{h.name}
									</option>
								))}
							</Select>
						</div>
					</Field>

					<Field label="环境变量">
						<div className="space-y-1">
							{form.envVars.map((v, i) => (
								<div key={i} className="flex gap-1">
									<Input
										value={v.key}
										onChange={(e) => update("envVars", form.envVars.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)))}
										placeholder="KEY"
										className="font-mono text-xs"
									/>
									<Input
										value={v.value}
										onChange={(e) => update("envVars", form.envVars.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))}
										placeholder="value"
										className="font-mono text-xs"
									/>
									<Button size="sm" variant="ghost" icon="icon-[lucide--x]" onClick={() => update("envVars", form.envVars.filter((_, j) => j !== i))} />
								</div>
							))}
							<Button size="sm" icon="icon-[lucide--plus]" onClick={() => update("envVars", [...form.envVars, { key: "", value: "" }])}>
								添加变量
							</Button>
						</div>
					</Field>
				</Section>

				<Section icon="icon-[lucide--globe]" title="高级">
					<Field label="字符编码">
						<Select value={form.charset} onChange={(e) => update("charset", e.target.value)} className="font-mono text-xs">
							<option value="">{inherited.charset ? `继承（${inherited.charset}）` : "默认（UTF-8）"}</option>
							{ENCODINGS.map((enc) => (
								<option key={enc} value={enc}>
									{enc}
								</option>
							))}
						</Select>
					</Field>
				</Section>

				<Section icon="icon-[lucide--palette]" title="外观">
					<div className="flex items-center gap-2">
						<Select value={form.theme} onChange={(e) => update("theme", e.target.value)} className="flex-1 text-xs">
							<option value="">{inherited.theme ? `继承（${inherited.theme}）` : "全局配色"}</option>
							{COLOR_SCHEMES.map((cs) => (
								<option key={cs.id} value={cs.id}>
									{cs.id}
								</option>
							))}
						</Select>
						{form.theme && <UseGlobal onClick={() => update("theme", "")} />}
					</div>
					<div className="flex items-center gap-2">
						<Select value={form.fontFamily} onChange={(e) => update("fontFamily", e.target.value)} className="flex-1 font-mono text-xs">
							<option value="">{inherited.fontFamily ? `继承（${inherited.fontFamily}）` : "全局字体"}</option>
							{FONTS.map((f) => (
								<option key={f} value={f}>
									{f}
								</option>
							))}
						</Select>
						{form.fontFamily && <UseGlobal onClick={() => update("fontFamily", "")} />}
					</div>
					<div className="flex items-center gap-2">
						<span className="flex-1 text-[11px] text-muted">Font Size</span>
						<Input
							value={form.fontSize}
							onChange={(e) => update("fontSize", e.target.value.replace(/[^\d]/g, ""))}
							placeholder={String(inherited.fontSize ?? 13)}
							inputMode="numeric"
							className="h-7 w-20 text-center font-mono text-xs"
						/>
					</div>
				</Section>
			</div>
		</Drawer>
	);
}
