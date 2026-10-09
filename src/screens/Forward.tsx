import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, Segmented } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select } from "@/components/ui/Input";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import { FORWARD_LABEL, type ForwardRule, type ForwardState, type ForwardType } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { disposeForward, restartForward, startForward, stopForward, useForwardRuntime } from "@/lib/forwardManager";
import { LISTEN_PORTS_COMMAND, parseListeningPorts, type ListeningPort } from "@/lib/listenPorts";
import { sshExec, sshReplaceHostKey, sshTrustHost } from "@/lib/ssh";
import { sshSessionAlive } from "@/components/terminal/sshCache";
import { draftForwardRule, useForwardsStore } from "@/store/forwards";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { ContextMenu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

/* =============================================================================
 * 端口转发（路由 /forward）—— 规则来自 useForwardsStore()（自动落盘），主机来自 useHostsStore()。
 * 覆盖状态：规则列表（可空）/ 三种类型的抽屉表单（本地 -L、远程反向 -R、动态 SOCKS5 -D）/
 * 运行中 / 已停止 / 启动出错。
 *
 * 运行时（lib/forwardManager.ts）：
 * - 启动 / 停止真实调用 Rust 的 forward_start / forward_stop，每条规则一条独立 SSH 连接，
 *   走主机自己的跳板链与代理；
 * - 连接数与流量来自 forward://state 事件（每秒最多一次）；
 * - 主机指纹未知 / 变化时进入「启动出错」，并在这里提供核对指纹再启动；
 * - 远程监听端口发现在这台主机已有的终端会话上执行 ss / netstat，没有会话就如实说明。
 * ========================================================================== */

const STATE_TEXT: Record<ForwardState, string> = {
	starting: "启动中",
	running: "运行中",
	stopped: "已停止",
	error: "启动出错",
};

/** 后端没给原因时的兜底文案（不编造具体原因） */
const UNKNOWN_ERROR = "转发异常结束，没有收到具体失败原因";

function stateVisual(state: ForwardState) {
	if (state === "running") return { text: "text-success", dot: "bg-success" };
	if (state === "starting") return { text: "text-warning", dot: "bg-warning" };
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
	if (rule.state === "running") return `→ ${targetText(rule)} · ${rule.connections} 个连接`;
	if (rule.state === "starting") return `→ ${targetText(rule)} · 正在建立 SSH 连接…`;
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
	const toggleAutoStart = useForwardsStore((s) => s.toggleAutoStart);
	const hosts = useHostsStore((s) => s.hosts);

	const [selectedId, setSelectedId] = useState("");
	const [draft, setDraft] = useState<RuleDraft | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	/** 规则右键菜单（Netcatty RuleCard：编辑 / 复制 / 启动 / 停止 / 删除） */
	const [menu, setMenu] = useState<{ x: number; y: number; rule: ForwardRule } | null>(null);

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

	async function startRule(rule: ForwardRule) {
		const result = await startForward(rule.id);
		if (result.ok) {
			const bound = useForwardRuntime.getState().bound[rule.id];
			toast({
				title: `${rule.name} 已启动`,
				description: `${bound ?? bindText(rule)} → ${targetText(rule)}`,
				tone: "success",
			});
		} else if (result.error) {
			toast({ title: `${rule.name} 启动失败`, description: result.error, tone: "danger" });
		}
	}

	async function stopRule(rule: ForwardRule) {
		const wasRunning = rule.state === "running" || rule.state === "starting";
		await stopForward(rule.id);
		toast({ title: wasRunning ? `${rule.name} 已停止` : `${rule.name} 已切回「已停止」`, tone: "default" });
	}

	/* 指纹核对（与连接页同一套：信任写入 known_hosts，变更则替换旧记录） */
	const trustRequests = useForwardRuntime((s) => s.trust);
	const boundMap = useForwardRuntime((s) => s.bound);
	const totalMap = useForwardRuntime((s) => s.total);
	const [trustFor, setTrustFor] = useState<string | null>(null);
	const [trusting, setTrusting] = useState(false);
	const trustRequest = trustFor ? trustRequests[trustFor] : undefined;

	async function confirmTrust() {
		if (!trustFor || !trustRequest || trusting) return;
		setTrusting(true);
		try {
			const note =
				trustRequest.kind === "host_changed"
					? await sshReplaceHostKey(trustRequest.host, trustRequest.port, trustRequest.fingerprint)
					: await sshTrustHost(trustRequest.host, trustRequest.port, trustRequest.fingerprint);
			toast({ title: "已写入 known_hosts", description: note, tone: "success" });
			const rule = useForwardsStore.getState().rules.find((r) => r.id === trustFor);
			setTrustFor(null);
			if (rule) await startRule({ ...rule, state: "stopped" });
		} catch (error) {
			toast({ title: "没能写入 known_hosts", description: String(error), tone: "danger" });
		} finally {
			setTrusting(false);
		}
	}

	function submitDraft() {
		if (!draft) return;
		const next: Record<string, string> = {};
		if (!draft.name.trim()) next.name = "请填写规则名称";
		if (!draft.hostId) next.hostId = "请选择这条隧道跟随的 SSH 主机";
		const bindPort = Number(draft.bindPort);
		if (!draft.bindPort.trim() || !Number.isInteger(bindPort) || bindPort < 1 || bindPort > 65535) {
			next.bindPort = "端口需为 1-65535 的整数";
		} else if (
			rules.some(
				(r) =>
					r.id !== draft.id &&
					// 远程 -R 监听在服务器上，和本地监听不冲突；同一台服务器上的两条 -R 才冲突
					(r.type === "remote") === (draft.type === "remote") &&
					(draft.type !== "remote" || r.hostId === draft.hostId) &&
					r.bindAddress === draft.bindAddress &&
					r.bindPort === bindPort,
			)
		) {
			next.bindPort = `${draft.type === "remote" ? "远程" : "本地"}端口 ${bindPort} 已被其他规则占用`;
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
		// 在跑的规则改了参数：按新参数重启，避免界面和实际监听不一致
		if (existing && (existing.state === "running" || existing.state === "starting")) void restartForward(rule.id);
		toast({
			title: existing ? `已保存规则 ${rule.name}` : `已创建规则 ${rule.name}`,
			description: `${bindText(rule)} → ${targetText(rule)}`,
			tone: "success",
		});
	}

	/** Netcatty duplicateRule：整条复制、名称加后缀、状态归零（不自动启动） */
	function duplicateRule(rule: ForwardRule) {
		const copy: ForwardRule = {
			...rule,
			id: `fw-${crypto.randomUUID().slice(0, 12)}`,
			name: `${rule.name} (复制)`,
			state: "stopped",
			connections: 0,
			trafficIn: 0,
			trafficOut: 0,
			error: undefined,
		};
		upsert(copy);
		setSelectedId(copy.id);
		toast({ title: `已复制规则 ${rule.name}`, description: "副本与原规则端口相同，启动前请按需修改", tone: "success" });
	}

	function removeRule(rule: ForwardRule) {
		void disposeForward(rule.id);
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
										onContextMenu={(event) => {
											event.preventDefault();
											setSelectedId(rule.id);
											setMenu({ x: event.clientX, y: event.clientY, rule });
										}}
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
											{selected.error ?? UNKNOWN_ERROR}。
											{trustRequests[selected.id]
												? "核对指纹无误后可信任并重新启动。"
												: "可以改绑一个空闲端口，或先把状态切回「已停止」。"}
										</span>
										<div className="flex items-center gap-1.5">
											{trustRequests[selected.id] && (
												<Button
													size="sm"
													variant="primary"
													icon="icon-[lucide--fingerprint]"
													onClick={() => setTrustFor(selected.id)}
												>
													核对指纹
												</Button>
											)}
											<Button
												size="sm"
												variant={trustRequests[selected.id] ? "default" : "primary"}
												icon="icon-[lucide--pencil-line]"
												onClick={() => {
													setErrors({});
													setDraft(draftFrom(selected));
												}}
											>
												修改绑定端口
											</Button>
											<Button size="sm" onClick={() => void stopRule(selected)}>
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

								{/* 运行指标：来自 Rust 端的真实计数（每秒刷新一次） */}
								<div className="mt-4 grid grid-cols-3 gap-3">
									<MetricCell
										label="当前连接数"
										value={selected.state === "running" ? String(selected.connections) : "—"}
									/>
									<MetricCell
										label="入站流量"
										value={selected.state === "stopped" && !totalMap[selected.id] ? "—" : formatBytes(selected.trafficIn)}
									/>
									<MetricCell
										label="出站流量"
										value={selected.state === "stopped" && !totalMap[selected.id] ? "—" : formatBytes(selected.trafficOut)}
									/>
								</div>
								<p className="mt-1.5 flex items-center gap-1.5 text-[10.5px] text-faint">
									<span className="icon-[lucide--info] size-3" />
									{selected.state === "running"
										? `实际监听 ${boundMap[selected.id] ?? bindText(selected)} · 累计 ${totalMap[selected.id] ?? 0} 个连接 · 入站 = 从隧道流回本端的字节`
										: selected.state === "starting"
											? "正在建立 SSH 连接…"
											: totalMap[selected.id]
												? `本次运行累计 ${totalMap[selected.id]} 个连接（已停止）`
												: "启动后显示实时连接数与流量。"}
								</p>

								<div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
									<Checkbox
										checked={selected.autoStart}
										onChange={() => toggleAutoStart(selected.id)}
										label="主机连接建立后自动启动此转发规则"
										className="min-w-0"
									/>
									<div className="flex shrink-0 items-center gap-2">
										{selected.state === "running" || selected.state === "starting" ? (
											<Button size="sm" onClick={() => void stopRule(selected)}>
												{selected.state === "starting" ? "取消启动" : "停止转发"}
											</Button>
										) : (
											<Button size="sm" variant="primary" icon="icon-[lucide--play]" onClick={() => void startRule(selected)}>
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
									action={
										<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openNew}>
											新建规则
										</Button>
									}
								/>
							</div>
						)}

						{/* 远程自动端口发现：在这台主机已有的终端会话上跑 ss / netstat */}
						<PortDiscovery
							host={host}
							hasHosts={hosts.length > 0}
							onForward={(port) => {
								if (!host) return;
								setErrors({});
								const base = freshDraft(host.id);
								setDraft({
									...base,
									name: `${host.name} ${port.port}`,
									bindPort: String(port.port),
									targetHost: port.address === "0.0.0.0" || port.address === "::" ? "127.0.0.1" : port.address,
									targetPort: String(port.port),
								});
							}}
							onOpenSession={() => {
								useSessionsStore.getState().setActiveTab("vaults");
								navigate("/workspace");
							}}
							onNewHost={() => navigate("/hosts/new")}
						/>
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
							<div className="-mt-2 text-[11px] text-muted">
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

			{/* 指纹核对：与连接页一致，信任前展示真实指纹 */}
			<Modal
				open={trustRequest !== undefined}
				onClose={() => setTrustFor(null)}
				title={trustRequest?.kind === "host_changed" ? "主机指纹与记录不一致" : "首次连接，请核对主机指纹"}
				icon={trustRequest?.kind === "host_changed" ? "icon-[lucide--shield-alert]" : "icon-[lucide--fingerprint]"}
				width={460}
				footer={
					<>
						<Button size="sm" onClick={() => setTrustFor(null)}>
							取消
						</Button>
						<Button
							size="sm"
							variant={trustRequest?.kind === "host_changed" ? "danger" : "primary"}
							disabled={trusting}
							onClick={() => void confirmTrust()}
						>
							{trusting ? "正在写入…" : trustRequest?.kind === "host_changed" ? "确认已核对，替换旧记录并启动" : "信任并启动"}
						</Button>
					</>
				}
			>
				{trustRequest && (
					<>
						<p>{trustRequest.detail}</p>
						<div className="mt-2.5 space-y-1 rounded border border-border bg-surface-sunk p-2.5 font-mono text-[11.5px]">
							<div>
								<span className="text-faint">主机 </span>
								{trustRequest.host}:{trustRequest.port}
							</div>
							<div className="break-all">
								<span className="text-faint">指纹 </span>
								{trustRequest.fingerprint ?? "（后端没有给出指纹）"}
							</div>
						</div>
						<p className="mt-2 text-[10.5px] text-faint">请通过可信渠道（例如服务器控制台）核对后再确认。</p>
					</>
				)}
			</Modal>
			{menu && (
				<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="转发规则菜单">
					<MenuItem
						icon="icon-[lucide--pencil]"
						label="编辑"
						onClick={() => {
							setErrors({});
							setDraft(draftFrom(menu.rule));
							setMenu(null);
						}}
					/>
					<MenuItem icon="icon-[lucide--copy]" label="复制" onClick={() => (duplicateRule(menu.rule), setMenu(null))} />
					<MenuSeparator />
					<MenuItem
						icon="icon-[lucide--play]"
						label="启动"
						disabled={menu.rule.state === "running" || menu.rule.state === "starting"}
						onClick={() => {
							const rule = menu.rule;
							setMenu(null);
							void startRule(rule);
						}}
					/>
					<MenuItem
						icon="icon-[lucide--square]"
						label="停止"
						disabled={menu.rule.state === "stopped" || menu.rule.state === "error"}
						onClick={() => {
							const rule = menu.rule;
							setMenu(null);
							void stopRule(rule);
						}}
					/>
					<MenuSeparator />
					<MenuItem icon="icon-[lucide--trash-2]" label="删除" danger onClick={() => (removeRule(menu.rule), setMenu(null))} />
				</ContextMenu>
			)}
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

/** 远程监听端口发现：复用这台主机已经建立的终端会话（另开 exec 通道，不占用终端） */
function PortDiscovery({
	host,
	hasHosts,
	onForward,
	onOpenSession,
	onNewHost,
}: {
	host: { id: string; name: string } | null;
	hasHosts: boolean;
	onForward: (port: ListeningPort) => void;
	onOpenSession: () => void;
	onNewHost: () => void;
}) {
	const tabs = useSessionsStore((s) => s.tabs);
	const panes = useSessionsStore((s) => s.panes);
	const sessionKey = useMemo(() => {
		if (!host) return null;
		const keys = [
			...tabs.filter((t) => t.hostId === host.id).map((t) => t.sessionKey),
			...panes.filter((p) => p.hostId === host.id).map((p) => p.sessionKey),
		];
		return keys.find((k): k is string => !!k && sshSessionAlive(k)) ?? null;
	}, [host, tabs, panes]);

	const [ports, setPorts] = useState<ListeningPort[] | null>(null);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);

	async function scan(key: string) {
		setLoading(true);
		setError(null);
		try {
			const out = await sshExec(key, LISTEN_PORTS_COMMAND, 8000);
			const parsed = parseListeningPorts(out.stdout);
			if (parsed.length === 0 && out.code !== 0) {
				setError(out.stderr.trim() || "服务器上没有 ss / netstat 命令，无法列出监听端口");
				setPorts(null);
			} else {
				setPorts(parsed);
			}
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
			setPorts(null);
		} finally {
			setLoading(false);
		}
	}

	useEffect(() => {
		setPorts(null);
		setError(null);
		if (sessionKey) void scan(sessionKey);
	}, [sessionKey]);

	return (
		<div>
			<div className="mb-2 flex items-center justify-between">
				<div className="flex items-center gap-2">
					<span className="icon-[lucide--radio] size-3.5 text-primary" />
					<h3 className="text-[13px] font-semibold text-surface-foreground">远程自动端口发现</h3>
				</div>
				<div className="flex items-center gap-2">
					<span className="font-mono text-[11px] text-faint">监听端口 {ports ? ports.length : "—"}</span>
					{sessionKey && (
						<Button size="sm" variant="ghost" icon="icon-[lucide--refresh-cw]" disabled={loading} onClick={() => void scan(sessionKey)}>
							{loading ? "扫描中…" : "刷新"}
						</Button>
					)}
				</div>
			</div>

			<div className="overflow-hidden rounded-lg border border-border bg-surface">
				{sessionKey && ports && ports.length > 0 ? (
					<ul className="divide-y divide-border">
						{ports.map((port) => (
							<li key={`${port.address}|${port.port}`} className="flex items-center justify-between gap-3 px-3 py-2 text-[12px]">
								<span className="font-mono text-surface-foreground">
									{port.address.includes(":") ? `[${port.address}]` : port.address}:{port.port}
								</span>
								<span className="flex items-center gap-2">
									{port.loopback && <span className="text-[10.5px] text-faint">仅本机可访问</span>}
									<Button size="sm" icon="icon-[lucide--arrow-down-to-line]" onClick={() => onForward(port)}>
										转发到本地
									</Button>
								</span>
							</li>
						))}
					</ul>
				) : (
					<EmptyState
						icon="icon-[lucide--radio]"
						title={
							sessionKey
								? loading
									? "正在读取远程监听端口…"
									: error
										? "没能列出远程监听端口"
										: "没有可发现的远程监听端口"
								: "没有可发现的远程监听端口"
						}
						description={sessionKey ? (error ?? undefined) : `需要先建立 SSH 连接${host ? `（${host.name}）` : ""}。`}
						action={
							sessionKey ? undefined : !hasHosts ? (
								<Button size="sm" variant="primary" icon="icon-[lucide--server]" onClick={onNewHost}>
									新建主机
								</Button>
							) : (
								<Button size="sm" variant="primary" icon="icon-[lucide--terminal]" onClick={onOpenSession}>
									去打开会话
								</Button>
							)
						}
					/>
				)}
			</div>
		</div>
	);
}
