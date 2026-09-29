import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, Segmented } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import { FORWARD_LABEL, type ForwardRule, type ForwardState, type ForwardType } from "@/data/types";
import { cn } from "@/lib/cn";
import { draftForwardRule, useForwardsStore } from "@/store/forwards";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { useState } from "react";
import { useNavigate } from "react-router";

/* =============================================================================
 * 端口转发（路由 /forward）—— 规则来自 useForwardsStore()（自动落盘），主机来自 useHostsStore()。
 * 覆盖状态：规则列表（可空）/ 三种类型的抽屉表单（本地 -L、远程反向 -R、动态 SOCKS5 -D）/
 * 运行中 / 已停止 / 启动出错。
 *
 * 诚实边界：
 * - 规则本身能真实保存、编辑、删除、开关；
 * - 连接数与流量需要真实的转发隧道，SSH 层接入前没有数据源，一律显示 —；
 * - 远程监听端口发现必须先建立 SSH 连接，没有连接就没有任何端口列表。
 * ========================================================================== */

const STATE_TEXT: Record<ForwardState, string> = {
	running: "运行中",
	stopped: "已停止",
	error: "启动出错",
};

const SCOPE_OPTIONS: { value: ForwardState | "new"; label: string }[] = [
	{ value: "running", label: "运行中" },
	{ value: "stopped", label: "已停止" },
	{ value: "error", label: "出错" },
	{ value: "new", label: "新建" },
];

/** 没有 SSH 层就拿不到真实失败原因，不编造错误信息 */
const UNKNOWN_ERROR = "转发隧道尚未接入 SSH 层，未收到真实失败原因";

function stateVisual(state: ForwardState) {
	if (state === "running") return { text: "text-success", dot: "bg-success" };
	if (state === "error") return { text: "text-danger", dot: "bg-danger" };
	return { text: "text-faint", dot: "bg-border" };
}

/** 绑定 / 目标的可读写法 */
function bindText(rule: ForwardRule) {
	return `${rule.bindAddress}:${rule.bindPort}`;
}

function targetText(rule: ForwardRule) {
	if (rule.type === "dynamic") return "SOCKS5 动态出口";
	return `${rule.targetHost ?? "—"}:${rule.targetPort ?? "—"}`;
}

function ruleNote(rule: ForwardRule) {
	if (rule.state === "error") return rule.error ?? UNKNOWN_ERROR;
	if (rule.state === "running") return `→ ${targetText(rule)} · 隧道状态由 SSH 层维护`;
	if (rule.error) return `上次失败：${rule.error}`;
	return `已停止 · → ${targetText(rule)}`;
}

interface RuleDraft {
	id: string;
	name: string;
	type: ForwardType;
	hostId: string;
	bindAddress: string;
	bindPort: string;
	targetHost: string;
	targetPort: string;
	autoStart: boolean;
}

/** 新建骨架来自 store 的 draftForwardRule()，只补上表单需要的默认主机 */
function freshDraft(hostId: string): RuleDraft {
	const base = draftForwardRule();
	return {
		id: base.id,
		name: "",
		type: base.type,
		hostId,
		bindAddress: base.bindAddress,
		bindPort: "",
		targetHost: "",
		targetPort: "",
		autoStart: base.autoStart,
	};
}

function draftFrom(rule: ForwardRule): RuleDraft {
	return {
		id: rule.id,
		name: rule.name,
		type: rule.type,
		hostId: rule.hostId,
		bindAddress: rule.bindAddress,
		bindPort: String(rule.bindPort),
		targetHost: rule.targetHost ?? "",
		targetPort: rule.targetPort != null ? String(rule.targetPort) : "",
		autoStart: rule.autoStart,
	};
}

export default function Forward() {
	const navigate = useNavigate();
	const rules = useForwardsStore((s) => s.rules);
	const upsert = useForwardsStore((s) => s.upsert);
	const remove = useForwardsStore((s) => s.remove);
	const setRuleState = useForwardsStore((s) => s.setRuleState);
	const toggleAutoStart = useForwardsStore((s) => s.toggleAutoStart);
	const hosts = useHostsStore((s) => s.hosts);

	const [selectedId, setSelectedId] = useState("");
	const [draft, setDraft] = useState<RuleDraft | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});

	const selected = rules.find((rule) => rule.id === selectedId) ?? rules[0] ?? null;
	const host = hosts.find((h) => h.id === selected?.hostId) ?? null;
	const sshHost = hosts.find((h) => h.id === draft?.hostId) ?? null;

	function openNew() {
		setErrors({});
		if (hosts.length === 0) {
			toast({ title: "还没有主机", description: "转发隧道跟随 SSH 主机，先去主机库添加一台。", tone: "warning" });
			navigate("/hosts/new");
			return;
		}
		setDraft(freshDraft(hosts[0].id));
	}

	/** 状态切换器：直接改写当前选中规则的启停状态，评审时逐个查看 */
	function applyScope(next: ForwardState | "new") {
		if (next === "new") {
			openNew();
			return;
		}
		if (!selected) return;
		setRuleState(selected.id, next, next === "error" ? UNKNOWN_ERROR : undefined);
		if (next === "running") {
			toast({
				title: `${selected.name} 已标记为运行中`,
				description: `${bindText(selected)} → ${targetText(selected)} · 隧道由 SSH 层启动，当前版本只保存规则状态`,
				tone: "success",
			});
		} else if (next === "stopped") {
			toast({ title: `${selected.name} 已停止`, tone: "default" });
		}
	}

	function stopRule(rule: ForwardRule) {
		setRuleState(rule.id, "stopped", undefined);
		toast({ title: `${rule.name} 已停止`, tone: "default" });
	}

	function submitDraft() {
		if (!draft) return;
		const next: Record<string, string> = {};
		if (!draft.name.trim()) next.name = "请填写规则名称";
		if (!draft.hostId) next.hostId = "请选择这条隧道跟随的 SSH 主机";
		const bindPort = Number(draft.bindPort);
		if (!draft.bindPort.trim() || !Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) {
			next.bindPort = "端口需为 1-65535 的整数";
		} else if (rules.some((r) => r.id !== draft.id && r.bindAddress === draft.bindAddress && r.bindPort === bindPort)) {
			next.bindPort = `本地端口 ${bindPort} 已被占用`;
		}
		if (draft.type !== "dynamic") {
			if (!draft.targetHost.trim()) next.targetHost = "请填写目标主机";
			const targetPort = Number(draft.targetPort);
			if (!draft.targetPort.trim() || !Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) {
				next.targetPort = "端口需为 1-65535 的整数";
			}
		}
		setErrors(next);
		if (Object.keys(next).length > 0) return;

		const existing = rules.find((rule) => rule.id === draft.id);
		const rule: ForwardRule = {
			id: draft.id,
			name: draft.name.trim(),
			hostId: draft.hostId,
			type: draft.type,
			bindAddress: draft.bindAddress.trim() || "127.0.0.1",
			bindPort,
			targetHost: draft.type === "dynamic" ? null : draft.targetHost.trim(),
			targetPort: draft.type === "dynamic" ? null : Number(draft.targetPort),
			autoStart: draft.autoStart,
			state: existing?.state ?? "stopped",
			connections: existing?.connections ?? 0,
			trafficIn: existing?.trafficIn ?? 0,
			trafficOut: existing?.trafficOut ?? 0,
			error: existing?.error,
		};
		upsert(rule);
		setSelectedId(rule.id);
		setDraft(null);
		toast({
			title: existing ? `已保存规则 ${rule.name}` : `已创建规则 ${rule.name}`,
			description: `${bindText(rule)} → ${targetText(rule)}`,
			tone: "success",
		});
	}

	function removeRule(rule: ForwardRule) {
		remove(rule.id);
		setSelectedId((id) => (id === rule.id ? "" : id));
		toast({ title: `已删除规则 ${rule.name}`, tone: "default" });
	}

	const visual = stateVisual(selected?.state ?? "stopped");

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧规则列表 */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--waypoints] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">端口转发规则</h1>
						</div>
						<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openNew}>
							新建
						</Button>
					</div>

					<div className="border-b border-border/40 px-3 py-1.5 text-[10.5px] font-medium tracking-wider text-faint uppercase">
						{host?.name ?? "未关联主机"} · 共 {rules.length} 条规则
					</div>

					<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
						{rules.length === 0 ? (
							<EmptyState
								icon="icon-[lucide--waypoints]"
								title="还没有转发规则"
								description={
									hosts.length === 0
										? "转发隧道跟随 SSH 主机：先去主机库添加一台主机，再回来新建规则。"
										: "新建一条规则，把远程端口映射到本地；规则会保存在本机。"
								}
								action={
									hosts.length === 0 ? (
										<Button size="sm" variant="primary" icon="icon-[lucide--server]" onClick={() => navigate("/hosts/new")}>
											新建主机
										</Button>
									) : (
										<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openNew}>
											新建规则
										</Button>
									)
								}
							/>
						) : (
							rules.map((rule) => {
								const tone = stateVisual(rule.state);
								const active = rule.id === selected?.id;
								return (
									<button
										key={rule.id}
										type="button"
										onClick={() => setSelectedId(rule.id)}
										className={cn(
											"w-full rounded border p-2.5 text-left transition-colors",
											active && rule.state === "error"
												? "border-danger/40 bg-surface-raised shadow-sm"
												: active
													? "border-border bg-surface-raised shadow-sm"
													: "border-border bg-surface hover:border-primary/40",
										)}
									>
										<div className="flex items-center justify-between gap-2 text-[12px]">
											<span className="truncate font-medium text-surface-foreground">{rule.name}</span>
											<span className={cn("flex shrink-0 items-center gap-1 font-mono text-[10.5px]", tone.text)}>
												<span className={cn("size-1.5 rounded-full", tone.dot)} />
												{STATE_TEXT[rule.state]}
											</span>
										</div>

										<div className="mt-1 flex items-center justify-between gap-2 font-mono text-[11px]">
											<span className="truncate text-muted">{bindText(rule)}</span>
											<span className="shrink-0 rounded border border-border bg-surface px-1 text-[9.5px] text-faint">
												{FORWARD_LABEL[rule.type]}
											</span>
										</div>

										<div
											className={cn(
												"mt-1 truncate text-[10.5px]",
												rule.state === "error" ? "text-danger" : rule.error ? "text-warning" : "text-faint",
											)}
										>
											{ruleNote(rule)}
										</div>
									</button>
								);
							})
						)}
					</div>

					{/* 状态切换器（骨架期评审工具） */}
					<div className="flex items-center justify-between gap-2 border-t border-border px-3 py-2">
						<span className="font-mono text-[10.5px] text-faint">状态</span>
						<Segmented
							value={(selected?.state ?? "stopped") as ForwardState}
							onChange={applyScope}
							options={SCOPE_OPTIONS}
						/>
					</div>
				</aside>

				{/* 右侧：规则详情 + 远程端口发现 */}
				<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto p-6">
					<div className="max-w-2xl space-y-6">
						{selected ? (
							<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
								<div className="flex items-start justify-between gap-3 border-b border-border pb-3">
									<div className="min-w-0">
										<div className="flex items-center gap-2">
											<h2 className="truncate text-[14px] font-semibold tracking-tight text-surface-foreground">
												{selected.name}
											</h2>
											<Badge>{FORWARD_LABEL[selected.type]}</Badge>
											{host && <EnvPill env={host.env} size="xs" />}
										</div>
										<div className="mt-1 flex items-center gap-2 font-mono text-[11px] text-muted">
											<span className={cn("size-1.5 rounded-full", visual.dot)} />
											<span className={visual.text}>{STATE_TEXT[selected.state]}</span>
											<span className="text-faint">·</span>
											<span className="truncate">{host ? `${host.username}@${host.hostname}` : "未关联主机"}</span>
											{selected.autoStart && <span className="text-faint">· 连接后自动启动</span>}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1.5">
										<Button
											size="sm"
											icon="icon-[lucide--edit-3]"
											onClick={() => {
												setErrors({});
												setDraft(draftFrom(selected));
											}}
										>
											编辑
										</Button>
										<Button size="sm" variant="ghost" icon="icon-[lucide--trash-2]" onClick={() => removeRule(selected)}>
											删除
										</Button>
									</div>
								</div>

								{/* 出错原因（没有 SSH 层时如实说明） */}
								{selected.state === "error" ? (
									<div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2.5 text-[11.5px] text-danger">
										<span className="icon-[lucide--alert-circle] size-4 shrink-0" />
										<span className="min-w-0 flex-1">
											{selected.error ?? UNKNOWN_ERROR}。可以改绑一个空闲端口，或先把状态切回「已停止」。
										</span>
										<div className="flex items-center gap-1.5">
											<Button
												size="sm"
												variant="primary"
												icon="icon-[lucide--pencil-line]"
												onClick={() => {
													setErrors({});
													setDraft(draftFrom(selected));
												}}
											>
												修改绑定端口
											</Button>
											<Button size="sm" onClick={() => stopRule(selected)}>
												停止规则
											</Button>
										</div>
									</div>
								) : selected.error ? (
									<div className="mt-3 flex items-center gap-2 rounded border border-warning/30 bg-warning/10 p-2.5 text-[11.5px] text-warning">
										<span className="icon-[lucide--history] size-4 shrink-0" />
										<span>上次启动失败：{selected.error}。可修改端口后重新启动。</span>
										<Button
											size="sm"
											variant="ghost"
											icon="icon-[lucide--pencil-line]"
											onClick={() => {
												setErrors({});
												setDraft(draftFrom(selected));
											}}
										>
											编辑规则
										</Button>
									</div>
								) : null}

								{/* 绑定与目标 */}
								<div className="mt-4 grid grid-cols-2 gap-3">
									<div className="flex flex-col">
										<label className="mb-1 text-[11px] text-muted">
											{selected.type === "remote" ? "远程监听地址" : "本地监听地址"}
										</label>
										<div
											className={cn(
												"flex h-7.5 items-center rounded border bg-surface px-2.5 font-mono text-[12px] text-surface-foreground",
												selected.state === "error" ? "border-danger/60" : "border-border",
											)}
										>
											{bindText(selected)}
										</div>
									</div>
									<div className="flex flex-col">
										<label className="mb-1 text-[11px] text-muted">目标出口</label>
										<div className="flex h-7.5 items-center rounded border border-border bg-surface px-2.5 font-mono text-[12px] text-muted">
											{selected.type === "dynamic" ? "跟随当前 SSH 主机动态代理" : targetText(selected)}
										</div>
									</div>
								</div>

								{/* 运行指标：没有真实隧道就没有数据源 */}
								<div className="mt-4 grid grid-cols-3 gap-3">
									<MetricCell label="当前连接数" value="—" />
									<MetricCell label="入站流量" value="—" />
									<MetricCell label="出站流量" value="—" />
								</div>
								<p className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-faint">
									<span className="icon-[lucide--info] size-3" />
									连接数与流量需要真实的转发隧道；SSH 层接入前没有数据源，因此显示 —。
								</p>

								<div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
									<Checkbox
										checked={selected.autoStart}
										onChange={() => toggleAutoStart(selected.id)}
										label="主机连接建立后自动启动此转发规则"
										className="min-w-0"
									/>
									<div className="flex shrink-0 items-center gap-2">
										{selected.state === "running" ? (
											<Button size="sm" onClick={() => stopRule(selected)}>
												停止转发
											</Button>
										) : (
											<Button size="sm" variant="primary" icon="icon-[lucide--play]" onClick={() => applyScope("running")}>
												启动转发
											</Button>
										)}
									</div>
								</div>
							</div>
						) : (
							<div className="rounded-lg border border-border bg-surface-raised">
								<EmptyState
									icon="icon-[lucide--waypoints]"
									title="还没有转发规则"
									description="新建一条规则，把远程端口映射到本地；规则会保存到本机，随时可以编辑或删除。"
									action={
										<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openNew}>
											新建规则
										</Button>
									}
								/>
							</div>
						)}

						{/* 远程自动端口发现：必须先有 SSH 连接 */}
						<div>
							<div className="mb-2 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--radio] size-3.5 text-primary" />
									<h3 className="text-[13px] font-semibold text-surface-foreground">远程自动端口发现</h3>
								</div>
								<span className="font-mono text-[11px] text-faint">监听端口 —</span>
							</div>

							<div className="overflow-hidden rounded-lg border border-border bg-surface">
								<EmptyState
									icon="icon-[lucide--radio]"
									title="没有可发现的远程监听端口"
									description="需要先建立 SSH 连接，TermX 才能读取远程主机上的监听端口。当前没有已连接的会话，所以这里不显示任何端口。"
									action={
										hosts.length === 0 ? (
											<Button size="sm" variant="primary" icon="icon-[lucide--server]" onClick={() => navigate("/hosts/new")}>
												新建主机
											</Button>
										) : (
											<Button size="sm" variant="primary" icon="icon-[lucide--terminal]" onClick={() => navigate("/hosts")}>
												去打开会话
											</Button>
										)
									}
								/>
							</div>

							<p className="mt-2 text-[10.5px] text-faint">
								连接建立后，这里会列出远程实际监听的端口，并支持一键转发到本地空闲端口。
							</p>
						</div>
					</div>
				</div>
			</div>

			{/* 新建 / 编辑规则抽屉：三种类型的字段不同 */}
			<Drawer
				open={draft !== null}
				onClose={() => setDraft(null)}
				width={480}
				title={rules.some((rule) => rule.id === draft?.id) ? "编辑转发规则" : "新建转发规则"}
				subtitle={
					draft
						? draft.type === "dynamic"
							? "动态 SOCKS5 (-D) · 无固定目标出口"
							: `${FORWARD_LABEL[draft.type]} · ${draft.bindAddress || "—"}:${draft.bindPort || "—"} → ${
									draft.targetHost || "—"
								}:${draft.targetPort || "—"}`
						: undefined
				}
				footer={
					<>
						<Button size="sm" onClick={() => setDraft(null)}>
							取消
						</Button>
						<Button size="sm" variant="primary" icon="icon-[lucide--check]" onClick={submitDraft}>
							{rules.some((rule) => rule.id === draft?.id) ? "保存规则" : "创建规则"}
						</Button>
					</>
				}
			>
				{draft && (
					<div className="space-y-4 p-4">
						<Field label="规则名称" required error={errors.name}>
							<Input
								value={draft.name}
								placeholder="例如：Postgres 主库"
								onChange={(e) => setDraft({ ...draft, name: e.target.value })}
							/>
						</Field>

						<Field label="转发模式" hint="三种类型的参数不同">
							<Segmented
								value={draft.type}
								onChange={(type) => setDraft({ ...draft, type })}
								options={[
									{ value: "local", label: "本地 -L" },
									{ value: "remote", label: "远程 -R" },
									{ value: "dynamic", label: "动态 -D" },
								]}
								className="w-full"
							/>
						</Field>

						<Field label="所属主机" required error={errors.hostId} hint="转发隧道跟随该 SSH 连接">
							<Select value={draft.hostId} onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}>
								<option value="">选择一台主机…</option>
								{hosts.map((h) => (
									<option key={h.id} value={h.id}>
										{h.name} · {h.username}@{h.hostname}
									</option>
								))}
							</Select>
						</Field>
						{sshHost && (
							<div className="-mt-2 flex items-center gap-2 text-[11px] text-muted">
								<EnvPill env={sshHost.env} size="xs" />
								<span className="font-mono">
									{sshHost.username}@{sshHost.hostname}:{sshHost.port}
								</span>
							</div>
						)}

						<div className="grid grid-cols-2 gap-3">
							<Field label={draft.type === "remote" ? "远程监听地址" : "本地监听地址"}>
								<Input
									value={draft.bindAddress}
									placeholder="127.0.0.1"
									onChange={(e) => setDraft({ ...draft, bindAddress: e.target.value })}
								/>
							</Field>
							<Field
								label={draft.type === "remote" ? "远程监听端口" : "本地监听端口"}
								required
								error={errors.bindPort}
							>
								<Input
									value={draft.bindPort}
									inputMode="numeric"
									placeholder="18080"
									onChange={(e) => setDraft({ ...draft, bindPort: e.target.value })}
								/>
							</Field>
						</div>

						{draft.type === "dynamic" ? (
							<Field label="目标出口" hint="动态转发不需要指定目标">
								<ReadonlyValue>跟随当前 SSH 主机动态代理（SOCKS5）</ReadonlyValue>
							</Field>
						) : (
							<div className="grid grid-cols-2 gap-3">
								<Field
									label={draft.type === "remote" ? "本地目标主机" : "目标主机"}
									required
									error={errors.targetHost}
								>
									<Input
										value={draft.targetHost}
										placeholder="10.2.0.11"
										onChange={(e) => setDraft({ ...draft, targetHost: e.target.value })}
									/>
								</Field>
								<Field
									label={draft.type === "remote" ? "本地目标端口" : "目标端口"}
									required
									error={errors.targetPort}
								>
									<Input
										value={draft.targetPort}
										inputMode="numeric"
										placeholder="5432"
										onChange={(e) => setDraft({ ...draft, targetPort: e.target.value })}
									/>
								</Field>
							</div>
						)}

						<Field label="等价命令行" hint="仅在本地生效，不会写入远程配置">
							<div className="rounded border border-border bg-term p-3 font-mono text-[12px] break-all text-term-ink">
								{sshHost
									? `ssh -N ${
											draft.type === "local"
												? `-L ${draft.bindAddress || "127.0.0.1"}:${draft.bindPort || "?"}:${
														draft.targetHost || "?"
													}:${draft.targetPort || "?"}`
												: draft.type === "remote"
													? `-R ${draft.bindAddress || "0.0.0.0"}:${draft.bindPort || "?"}:${
															draft.targetHost || "?"
														}:${draft.targetPort || "?"}`
													: `-D ${draft.bindAddress || "127.0.0.1"}:${draft.bindPort || "?"}`
										} ${sshHost.username}@${sshHost.hostname} -p ${sshHost.port}`
									: "选择所属主机后显示等价命令"}
							</div>
						</Field>

						<Checkbox
							checked={draft.autoStart}
							onChange={(checked) => setDraft({ ...draft, autoStart: checked })}
							label="主机连接建立后自动启动此转发规则"
							description="关闭时创建后保持停止，需手动启动。"
						/>
					</div>
				)}
			</Drawer>
		</WindowChrome>
	);
}

function MetricCell({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded border border-border bg-surface px-2.5 py-2">
			<div className="text-[10.5px] text-faint">{label}</div>
			<div className="mt-0.5 font-mono text-[12.5px] tabular-nums text-surface-foreground">{value}</div>
		</div>
	);
}
