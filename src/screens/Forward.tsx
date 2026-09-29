import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, Segmented } from "@/components/ui/Display";
import { Field, Input, ReadonlyValue, Select } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import { FORWARD_LABEL, type ForwardRule, type ForwardState, type ForwardType } from "@/data/types";
import { discoveredPorts, forwardRules, hosts } from "@/data/mock";
import { formatBytes } from "@/lib/format";
import { toast } from "@/store/toast";
import { useState } from "react";

/* =============================================================================
 * 端口转发（路由 /forward）
 * 覆盖状态：规则列表（名称 / 类型 / 绑定 / 目标 / 状态 / 连接数 / 流量）；
 * 三种类型的抽屉表单（本地 -L、远程反向 -R、动态 SOCKS5 -D）；
 * 运行中 / 已停止 / 启动出错（出错显示原因，可换端口重试或停止）；
 * 远程自动端口发现（一键转发到本地并在浏览器打开）。
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
	const traffic = formatBytes(rule.trafficIn + rule.trafficOut);
	if (rule.state === "error") return rule.error ?? `本地端口 ${rule.bindPort} 已被占用`;
	if (rule.state === "running") return `→ ${targetText(rule)} · ${rule.connections} 个连接 · ${traffic}`;
	if (rule.error) return `上次失败：${rule.error}`;
	return `手动启动 · → ${targetText(rule)}`;
}

interface RuleDraft {
	id: string | null;
	name: string;
	type: ForwardType;
	hostId: string;
	bindAddress: string;
	bindPort: string;
	targetHost: string;
	targetPort: string;
	autoStart: boolean;
}

function emptyDraft(): RuleDraft {
	return {
		id: null,
		name: "",
		type: "local",
		hostId: hosts[0]?.id ?? "",
		bindAddress: "127.0.0.1",
		bindPort: "",
		targetHost: "",
		targetPort: "",
		autoStart: false,
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
	const [rules, setRules] = useState<ForwardRule[]>(() => forwardRules.map((r) => ({ ...r })));
	const [selectedId, setSelectedId] = useState<string>(forwardRules[0]?.id ?? "");
	const [draft, setDraft] = useState<RuleDraft | null>(null);
	const [errors, setErrors] = useState<Record<string, string>>({});
	const [forwarded, setForwarded] = useState<number[]>([]);

	const selected = rules.find((r) => r.id === selectedId) ?? rules[0] ?? null;
	const host = hosts.find((h) => h.id === selected?.hostId) ?? null;

	function patchRule(id: string, patch: Partial<ForwardRule>) {
		setRules((list) => list.map((r) => (r.id === id ? { ...r, ...patch } : r)));
	}

	/** 状态切换器：直接改写当前选中规则的状态，评审时逐个查看 */
	function applyScope(next: ForwardState | "new") {
		if (!selected) return;
		if (next === "new") {
			setErrors({});
			setDraft(emptyDraft());
			return;
		}
		if (next === "running") {
			patchRule(selected.id, {
				state: "running",
				error: undefined,
				connections: selected.connections || 2,
				trafficIn: selected.trafficIn || 1_284_000,
				trafficOut: selected.trafficOut || 386_000,
			});
			toast({ title: `${selected.name} 已启动`, description: `${bindText(selected)} → ${targetText(selected)}`, tone: "success" });
			return;
		}
		if (next === "stopped") {
			patchRule(selected.id, { state: "stopped", connections: 0 });
			toast({ title: `${selected.name} 已停止`, tone: "default" });
			return;
		}
		patchRule(selected.id, {
			state: "error",
			error: `本地端口 ${selected.bindPort} 已被占用`,
			connections: 0,
		});
	}

	/** 找一个没被其它规则占用的本地端口 */
	function nextFreePort(preferred: number) {
		const used = new Set(rules.filter((r) => r.bindAddress === "127.0.0.1").map((r) => r.bindPort));
		let port = preferred + 1;
		while (used.has(port) && port < 65535) port += 1;
		return port;
	}

	function retryWithFreePort(rule: ForwardRule) {
		const port = nextFreePort(rule.bindPort);
		patchRule(rule.id, {
			state: "running",
			error: undefined,
			bindPort: port,
			connections: 1,
			trafficIn: rule.trafficIn || 64_000,
			trafficOut: rule.trafficOut || 12_000,
		});
		toast({ title: `已换用端口 ${port} 并重新启动`, description: `${rule.name} · ${rule.bindAddress}:${port}`, tone: "success" });
	}

	function openInBrowser(port: number) {
		const url = `http://127.0.0.1:${port}`;
		try {
			window.open(url, "_blank", "noopener");
		} catch {
			/* 浏览器或 WebView 拦截时忽略，地址仍展示在界面上 */
		}
		toast({ title: `已在浏览器打开 ${url}`, tone: "default" });
	}

	function forwardPort(entry: (typeof discoveredPorts)[number]) {
		const localPort = nextFreePort(entry.port);
		const rule: ForwardRule = {
			id: `fw-${entry.port}-${rules.length + 1}`,
			name: `${entry.proc} :${entry.port}`,
			hostId: selected?.hostId ?? hosts[0]?.id ?? "",
			type: "local",
			bindAddress: "127.0.0.1",
			bindPort: localPort,
			targetHost: entry.bind,
			targetPort: entry.port,
			autoStart: false,
			state: "running",
			connections: 1,
			trafficIn: 0,
			trafficOut: 0,
		};
		setRules((list) => [rule, ...list]);
		setSelectedId(rule.id);
		setForwarded((list) => (list.includes(entry.port) ? list : [...list, entry.port]));
		toast({
			title: `已转发 ${entry.proc} :${entry.port}`,
			description: `本地监听 127.0.0.1:${localPort}，可直接在浏览器打开。`,
			tone: "success",
			action: { label: "在浏览器打开", run: () => openInBrowser(localPort) },
		});
	}

	function submitDraft() {
		if (!draft) return;
		const next: Record<string, string> = {};
		if (!draft.name.trim()) next.name = "请填写规则名称";
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

		const targetPort = draft.type === "dynamic" ? null : Number(draft.targetPort);
		if (draft.id) {
			patchRule(draft.id, {
				name: draft.name.trim(),
				type: draft.type,
				hostId: draft.hostId,
				bindAddress: draft.bindAddress.trim(),
				bindPort,
				targetHost: draft.type === "dynamic" ? null : draft.targetHost.trim(),
				targetPort,
				autoStart: draft.autoStart,
				error: undefined,
			});
			toast({ title: `已保存规则 ${draft.name.trim()}`, tone: "success" });
		} else {
			const rule: ForwardRule = {
				id: `fw-new-${rules.length + 1}`,
				name: draft.name.trim(),
				hostId: draft.hostId,
				type: draft.type,
				bindAddress: draft.bindAddress.trim(),
				bindPort,
				targetHost: draft.type === "dynamic" ? null : draft.targetHost.trim(),
				targetPort,
				autoStart: draft.autoStart,
				state: draft.autoStart ? "running" : "stopped",
				connections: draft.autoStart ? 1 : 0,
				trafficIn: 0,
				trafficOut: 0,
			};
			setRules((list) => [rule, ...list]);
			setSelectedId(rule.id);
			toast({ title: `已创建规则 ${rule.name}`, description: `${bindText(rule)} → ${targetText(rule)}`, tone: "success" });
		}
		setDraft(null);
	}

	function removeRule(rule: ForwardRule) {
		setRules((list) => list.filter((r) => r.id !== rule.id));
		setSelectedId((id) => (id === rule.id ? "" : id));
		toast({ title: `已删除规则 ${rule.name}`, tone: "default" });
	}

	const visual = selected ? stateVisual(selected.state) : stateVisual("stopped");
	const sshHost = hosts.find((h) => h.id === draft?.hostId) ?? null;

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
						<Button
							size="sm"
							variant="primary"
							icon="icon-[lucide--plus]"
							onClick={() => {
								setErrors({});
								setDraft(emptyDraft());
							}}
						>
							新建
						</Button>
					</div>

					<div className="border-b border-border/40 px-3 py-1.5 text-[10.5px] font-medium tracking-wider text-faint uppercase">
						{host?.name ?? "未关联主机"} · 自动探测 {discoveredPorts.length} 条端口
					</div>

					<div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-2">
						{rules.length === 0 ? (
							<EmptyState
								icon="icon-[lucide--waypoints]"
								title="还没有转发规则"
								description="新建一条规则，把远程端口映射到本地。"
								action={
									<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={() => setDraft(emptyDraft())}>
										新建规则
									</Button>
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
										className={`w-full rounded border p-2.5 text-left transition-colors ${
											active && rule.state === "error"
												? "border-danger/40 bg-surface-raised shadow-sm"
												: active
													? "border-border bg-surface-raised shadow-sm"
													: "border-border bg-surface hover:border-primary/40"
										}`}
									>
										<div className="flex items-center justify-between gap-2 text-[12px]">
											<span className="truncate font-medium text-surface-foreground">{rule.name}</span>
											<span className={`flex shrink-0 items-center gap-1 font-mono text-[10.5px] ${tone.text}`}>
												<span className={`size-1.5 rounded-full ${tone.dot}`} />
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
											className={`mt-1 truncate text-[10.5px] ${
												rule.state === "error" ? "text-danger" : rule.error ? "text-warning" : "text-faint"
											}`}
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
											<span className={`size-1.5 rounded-full ${visual.dot}`} />
											<span className={visual.text}>{STATE_TEXT[selected.state]}</span>
											<span className="text-faint">·</span>
											<span className="truncate">
												{host ? `${host.username}@${host.hostname}` : "未关联主机"}
											</span>
											{selected.autoStart && <span className="text-faint">· 连接后自动启动</span>}
										</div>
									</div>
									<div className="flex shrink-0 items-center gap-1.5">
										<Button size="sm" icon="icon-[lucide--edit-3]" onClick={() => setDraft(draftFrom(selected))}>
											编辑
										</Button>
										<Button
											size="sm"
											variant="ghost"
											icon="icon-[lucide--trash-2]"
											onClick={() => removeRule(selected)}
										>
											删除
										</Button>
									</div>
								</div>

								{/* 出错原因 + 换端口 / 停止 */}
								{selected.state === "error" ? (
									<div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-danger/30 bg-danger/10 p-2.5 text-[11.5px] text-danger">
										<span className="icon-[lucide--alert-circle] size-4 shrink-0" />
										<span className="min-w-0 flex-1">
											{selected.error ?? `本地端口 ${selected.bindPort} 已被占用`}。建议换用端口{" "}
											{nextFreePort(selected.bindPort)} 或终止占用进程。
										</span>
										<div className="flex items-center gap-1.5">
											<Button size="sm" variant="primary" icon="icon-[lucide--zap]" onClick={() => retryWithFreePort(selected)}>
												改用 {nextFreePort(selected.bindPort)} 并重试启动
											</Button>
											<Button
												size="sm"
												onClick={() => {
													patchRule(selected.id, { state: "stopped", connections: 0 });
													toast({ title: `${selected.name} 已停止`, tone: "default" });
												}}
											>
												停止规则
											</Button>
										</div>
									</div>
								) : selected.error ? (
									<div className="mt-3 flex items-center gap-2 rounded border border-warning/30 bg-warning/10 p-2.5 text-[11.5px] text-warning">
										<span className="icon-[lucide--history] size-4 shrink-0" />
										<span>上次启动失败：{selected.error}。可换端口后重新启动。</span>
										<Button size="sm" variant="ghost" icon="icon-[lucide--zap]" onClick={() => retryWithFreePort(selected)}>
											换端口重试
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
											className={`flex h-7.5 items-center rounded border bg-surface px-2.5 font-mono text-[12px] text-surface-foreground ${
												selected.state === "error" ? "border-danger/60" : "border-border"
											}`}
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

								{/* 运行指标 */}
								<div className="mt-4 grid grid-cols-3 gap-3">
									<MetricCell label="当前连接数" value={String(selected.connections)} />
									<MetricCell label="入站流量" value={formatBytes(selected.trafficIn)} />
									<MetricCell label="出站流量" value={formatBytes(selected.trafficOut)} />
								</div>

								<div className="mt-4 flex items-center justify-between gap-3 border-t border-border pt-3">
									<Checkbox
										checked={selected.autoStart}
										onChange={(checked) => patchRule(selected.id, { autoStart: checked })}
										label="主机连接建立后自动启动此转发规则"
										className="min-w-0"
									/>
									<div className="flex shrink-0 items-center gap-2">
										{selected.state === "running" ? (
											<Button
												size="sm"
												onClick={() => {
													patchRule(selected.id, { state: "stopped", connections: 0 });
													toast({ title: `${selected.name} 已停止`, tone: "default" });
												}}
											>
												停止转发
											</Button>
										) : (
											<Button
												size="sm"
												variant="primary"
												icon="icon-[lucide--play]"
												onClick={() => applyScope("running")}
											>
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
									title="未选择转发规则"
									description="从左侧选择一条规则查看详情，或新建一条本地 / 远程 / 动态转发。"
									action={
										<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={() => setDraft(emptyDraft())}>
											新建规则
										</Button>
									}
								/>
							</div>
						)}

						{/* 远程自动端口发现 */}
						<div>
							<div className="mb-2 flex items-center justify-between">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--radio] size-3.5 text-primary" />
									<h3 className="text-[13px] font-semibold text-surface-foreground">远程自动端口发现</h3>
								</div>
								<span className="font-mono text-[11px] text-faint">检测到 {discoveredPorts.length} 个监听端口</span>
							</div>

							<div className="overflow-hidden rounded-lg border border-border bg-surface">
								<div className="grid grid-cols-[72px_120px_1fr_72px_150px] border-b border-border bg-surface-sunk/60 px-3 py-1.5 font-mono text-[10.5px] text-faint uppercase">
									<span>端口</span>
									<span>绑定地址</span>
									<span>进程名称</span>
									<span>PID</span>
									<span className="text-right">操作</span>
								</div>

								<div className="divide-y divide-border/30 font-mono text-[11.5px]">
									{discoveredPorts.map((entry) => {
										const done = forwarded.includes(entry.port);
										const localRule = rules.find((r) => r.type === "local" && r.targetPort === entry.port);
										return (
											<div
												key={entry.port}
												className="grid grid-cols-[72px_120px_1fr_72px_150px] items-center px-3 py-1.5 transition-colors hover:bg-surface-raised"
											>
												<span className="flex items-center gap-1 font-medium text-primary">
													{entry.suggested && (
														<span className="icon-[lucide--sparkles] size-3 text-warning" title="建议转发" />
													)}
													{entry.port}
												</span>
												<span className="truncate text-muted">{entry.bind}</span>
												<span className="truncate font-sans text-surface-foreground">{entry.proc}</span>
												<span className="text-faint">{entry.pid}</span>
												<div className="flex items-center justify-end gap-1.5">
													{done ? (
														<>
															<span className="font-sans text-[10.5px] text-success">已转发</span>
															<Button
																size="sm"
																variant="ghost"
																icon="icon-[lucide--external-link]"
																onClick={() => openInBrowser(localRule?.bindPort ?? entry.port)}
															>
																浏览器打开
															</Button>
														</>
													) : (
														<Button
															size="sm"
															icon="icon-[lucide--waypoints]"
															onClick={() => forwardPort(entry)}
															className="font-sans"
														>
															一键转发
														</Button>
													)}
												</div>
											</div>
										);
									})}
								</div>
							</div>

							<p className="mt-2 text-[10.5px] text-faint">
								转发后本地监听 127.0.0.1 上的空闲端口，点「浏览器打开」即可访问该服务。
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
				title={draft?.id ? "编辑转发规则" : "新建转发规则"}
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
							{draft?.id ? "保存规则" : "创建规则"}
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

						<Field label="所属主机" hint="转发隧道跟随该 SSH 连接">
							<Select value={draft.hostId} onChange={(e) => setDraft({ ...draft, hostId: e.target.value })}>
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
									: "ssh -N ..."}
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
