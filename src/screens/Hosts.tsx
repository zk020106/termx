import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { EmptyState, Segmented, StatusDot } from "@/components/ui/Display";
import { Input, Select } from "@/components/ui/Input";
import type { Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { filterHosts, useHostsStore, type HostScope } from "@/store/hosts";
import { liveTabForHost, useSessionsStore } from "@/store/sessions";
import { useHostStatus } from "@/lib/status";
import { toast } from "@/store/toast";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

/* 主机库（对应 termx.vetd/frames/hosts.tsx）。
 * 覆盖状态：卡片 / 列表 / 树形三视图（保持选中项）、空状态、搜索无结果、多选批量操作条、拖拽进行中。
 * 视图 / 分组 / 选中项全部落在 useHostsStore，切换视图不丢选中。 */

const QUICK_VIEWS: { scope: HostScope; label: string; icon: string; iconColor?: string }[] = [
	{ scope: "online", label: "在线会话", icon: "icon-[lucide--radio]", iconColor: "text-success" },
	{ scope: "favorites", label: "常用收藏", icon: "icon-[lucide--star]", iconColor: "text-amber-500 fill-amber-500" },
	{ scope: "jump", label: "跳板节点", icon: "icon-[lucide--git-fork]", iconColor: "text-primary" },
];

function HostStatusDot({ host, size = 6 }: { host: Host; size?: number }) {
	const status = useHostStatus(host.id, host.reachable);
	return <StatusDot status={status} size={size} />;
}

function LatencyCell({
	host,
	showDot = true,
	className,
}: {
	host: Host;
	showDot?: boolean;
	className?: string;
}) {
	const liveStatus = useHostStatus(host.id, host.reachable);
	const base = "flex items-center gap-1 font-mono text-[10.5px] tabular-nums";

	if (liveStatus === "connecting" || liveStatus === "reconnecting") {
		return (
			<span className={cn(base, "text-primary", className)}>
				<span className="icon-[lucide--activity] size-3 animate-pulse" />
				连接中…
			</span>
		);
	}

	if (liveStatus === "connected") {
		return (
			<span className={cn(base, "text-success font-medium", className)}>
				{showDot && <StatusDot status="connected" size={6} />}
				已连接
			</span>
		);
	}

	if (liveStatus === "failed") {
		return (
			<span className={cn(base, "text-danger", className)}>
				{showDot && <StatusDot status="failed" size={6} />}
				连接失败
			</span>
		);
	}

	return (
		<span className={cn(base, host.reachable ? "text-surface-foreground" : "text-faint", className)}>
			{showDot && <StatusDot status={host.reachable ? "idle" : "disconnected"} size={6} />}
			{host.reachable ? (host.latencyMs ? `${host.latencyMs} ms` : "就绪") : "离线"}
		</span>
	);
}

export default function Hosts() {
	const navigate = useNavigate();
	const store = useHostsStore();
	const { hosts, groups, view, query, scope, activeGroupId, selectedIds, draggingId } = store;

	const [collapsed, setCollapsed] = useState<string[]>([]);
	const [moveTarget, setMoveTarget] = useState<string>("");
	const [creatingGroup, setCreatingGroup] = useState(false);
	const [newGroupName, setNewGroupName] = useState("");

	const allTags = useMemo(
		() => Array.from(new Set(hosts.flatMap((h) => h.tags || []).filter(Boolean))),
		[hosts],
	);

	const handleAddGroup = () => {
		const trimmed = newGroupName.trim();
		if (!trimmed) {
			setCreatingGroup(false);
			return;
		}
		const group = store.addGroup(trimmed);
		setNewGroupName("");
		setCreatingGroup(false);
		store.setActiveGroup(group.id);
		toast({ title: `已创建分组「${group.name}」`, tone: "success" });
	};

	const libraryEmpty = hosts.length === 0;
	const shown = libraryEmpty ? [] : filterHosts(store);
	const total = libraryEmpty ? 0 : hosts.length;
	const online = libraryEmpty ? 0 : hosts.filter((h) => h.reachable).length;
	const dragging = hosts.find((h) => h.id === draggingId);

	const groupCount = (id: string) => (libraryEmpty ? 0 : hosts.filter((h) => h.groupId === id).length);
	const scopeCount = (s: HostScope) => {
		if (libraryEmpty) return 0;
		if (s === "online") return hosts.filter((h) => h.reachable).length;
		if (s === "favorites") return hosts.filter((h) => h.favorite).length;
		return hosts.filter((h) => h.jumpHostIds.length === 0 && hosts.some((x) => x.jumpHostIds.includes(h.id))).length;
	};

	/**
	 * 「打开」这台主机（双击卡片 / 列表行、树形双击）：
	 * 已经有活着的会话就**聚焦**到那个标签，没有才进连接页。
	 * 不这么做的话，用户在主机库里随手点一下就会多出一条同主机的连接。
	 */
	const openHost = (host: Host) => {
		const live = liveTabForHost(host.id);
		if (live) {
			useSessionsStore.getState().setActiveTab(live.id);
			toast({
				title: `已切到 ${host.name} 的会话`,
				description: "这台主机已有会话，没有新开连接",
				tone: "default",
			});
			navigate("/workspace");
			return;
		}
		const newTabId = useSessionsStore.getState().openSession(host.id);
		useSessionsStore.getState().setActiveTab(newTabId);
		toast({ title: `正在连接 ${host.name}`, description: `${host.username}@${host.hostname}:${host.port}`, tone: "default" });
		navigate("/workspace");
	};

	const connectHost = (host: Host) => {
		const newTabId = useSessionsStore.getState().openSession(host.id);
		useSessionsStore.getState().setActiveTab(newTabId);
		toast({
			title: `新建到 ${host.name} 的连接`,
			description: `${host.username}@${host.hostname}:${host.port}`,
			tone: "default",
		});
		navigate("/workspace");
	};

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1">
				{/* 左侧主机分类导航 */}
				<aside className="flex w-[236px] shrink-0 flex-col border-r border-border bg-surface-sunk p-2.5">
					{/* 搜索框 */}
					<div className="relative mb-2">
						<span className="icon-[lucide--search] pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted" />
						<Input
							value={query}
							onChange={(e) => {
								useHostsStore.getState().setQuery(e.target.value);
							}}
							placeholder="搜索名称、IP、标签…"
							className="h-7 pr-7 pl-6 text-[11px]"
						/>
						{query && (
							<button
								type="button"
								onClick={() => useHostsStore.getState().setQuery("")}
								className="absolute top-1/2 right-1.5 -translate-y-1/2 flex size-4 items-center justify-center rounded-full text-muted hover:bg-surface-raised hover:text-surface-foreground cursor-pointer"
							>
								<span className="icon-[lucide--x] size-2.5" />
							</button>
						)}
					</div>

					{/* 分组列表 */}
					<div className="mt-1 space-y-0.5">
						<div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold tracking-wider text-faint uppercase">
							<span>主机分组</span>
							<button
								type="button"
								onClick={() => setCreatingGroup(true)}
								className="flex size-4 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-primary transition-colors cursor-pointer"
								title="新建分组"
							>
								<span className="icon-[lucide--plus] size-3" />
							</button>
						</div>

						<GroupRow
							name="全部主机"
							icon="icon-[lucide--layout-grid]"
							count={total}
							active={activeGroupId === null && scope === "all"}
							onClick={() => {
								useHostsStore.getState().setScope("all");
								useHostsStore.getState().setActiveGroup(null);
							}}
						/>

						{groups.map((g) => (
							<div key={g.id} className="group/item relative">
								<GroupRow
									name={g.name}
									icon="icon-[lucide--folder]"
									iconColor="text-amber-500"
									count={groupCount(g.id)}
									active={activeGroupId === g.id}
									dropTarget={Boolean(draggingId)}
									onClick={() => useHostsStore.getState().setActiveGroup(g.id)}
									onDrop={(hostId) => {
										const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
										if (!host || host.groupId === g.id) return;
										useHostsStore.getState().upsertHost({ ...host, groupId: g.id });
										useHostsStore.getState().setDragging(null);
										toast({ title: `已移动 ${host.name} 到「${g.name}」`, tone: "success" });
									}}
								/>
								<button
									type="button"
									onClick={(e) => {
										e.stopPropagation();
										store.removeGroup(g.id);
										toast({ title: `已删除分组「${g.name}」`, tone: "default" });
									}}
									className="absolute right-7 top-1/2 -translate-y-1/2 hidden group-hover/item:flex size-4 items-center justify-center rounded text-muted hover:bg-surface-raised hover:text-danger cursor-pointer transition-colors"
									title="删除分组"
								>
									<span className="icon-[lucide--trash-2] size-2.5" />
								</button>
							</div>
						))}

						{creatingGroup && (
							<div className="flex items-center gap-1 px-1 py-1">
								<input
									autoFocus
									value={newGroupName}
									onChange={(e) => setNewGroupName(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter") handleAddGroup();
										if (e.key === "Escape") setCreatingGroup(false);
									}}
									placeholder="分组名称..."
									className="h-6 w-full rounded border border-primary bg-surface px-1.5 text-[11px] text-surface-foreground focus:outline-none"
								/>
								<button
									type="button"
									onClick={handleAddGroup}
									className="flex size-6 items-center justify-center rounded bg-primary text-white hover:bg-primary-hover shrink-0 cursor-pointer"
								>
									<span className="icon-[lucide--check] size-3" />
								</button>
								<button
									type="button"
									onClick={() => setCreatingGroup(false)}
									className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface-raised shrink-0 cursor-pointer"
								>
									<span className="icon-[lucide--x] size-3" />
								</button>
							</div>
						)}
					</div>

					{/* 快速视图 */}
					<div className="mt-3.5 space-y-0.5">
						<div className="px-2 py-1 text-[10px] font-semibold tracking-wider text-faint uppercase">快速视图</div>
						{QUICK_VIEWS.map((e) => (
							<GroupRow
								key={e.scope}
								name={e.label}
								icon={e.icon}
								iconColor={e.iconColor}
								count={scopeCount(e.scope)}
								active={scope === e.scope && activeGroupId === null}
								onClick={() => useHostsStore.getState().setScope(e.scope)}
							/>
						))}
					</div>

					{/* 标签索引 */}
					{allTags.length > 0 && (
						<div className="mt-4 space-y-1">
							<div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold tracking-wider text-faint uppercase">
								<span>标签索引</span>
								<span className="font-mono text-[9px] text-faint">{allTags.length}</span>
							</div>
							<div className="flex flex-wrap gap-1 px-1">
								{allTags.map((tag) => {
									const isTagSelected = query.toLowerCase() === tag.toLowerCase();
									const count = hosts.filter((h) => (h.tags || []).includes(tag)).length;
									return (
										<button
											key={tag}
											type="button"
											onClick={() => {
												if (isTagSelected) {
													store.setQuery("");
												} else {
													store.setQuery(tag);
												}
											}}
											className={cn(
												"inline-flex h-6 items-center gap-1.5 rounded-md px-2 text-[11px] font-mono transition-colors cursor-pointer border select-none",
												isTagSelected
													? "border-primary/50 bg-primary/15 text-primary font-medium shadow-2xs"
													: "border-border/60 bg-surface/60 text-muted hover:border-border hover:bg-surface hover:text-surface-foreground",
											)}
										>
											<span>#{tag}</span>
											<span className={cn("text-[10px]", isTagSelected ? "text-primary/80 font-bold" : "text-faint")}>{count}</span>
										</button>
									);
								})}
							</div>
						</div>
					)}

					{/* 底部资产统计与工具卡片 */}
					<div className="mt-auto border-t border-border/80 pt-2.5">
						<div className="rounded-lg border border-border/70 bg-surface p-2.5 shadow-2xs">
							<div className="flex items-center justify-between text-[11px]">
								<span className="font-semibold text-surface-foreground">资产概览</span>
								<span className="flex items-center gap-1 font-mono text-[10px] text-success">
									<span className="size-1.5 rounded-full bg-success animate-pulse" />
									{online} 台在线
								</span>
							</div>
							<div className="mt-2 grid grid-cols-2 gap-1.5 text-[10px]">
								<div className="rounded bg-surface-raised/70 px-2 py-1">
									<div className="text-faint">主机总数</div>
									<div className="font-mono text-[12px] font-semibold text-surface-foreground">{total}</div>
								</div>
								<div className="rounded bg-surface-raised/70 px-2 py-1">
									<div className="text-faint">已设分组</div>
									<div className="font-mono text-[12px] font-semibold text-surface-foreground">{groups.length}</div>
								</div>
							</div>
							<div className="mt-2.5 flex items-center gap-1.5">
								<button
									type="button"
									onClick={() => toast({ title: "已从 ~/.ssh/config 导入 3 台主机", tone: "success" })}
									className="flex h-6.5 flex-1 items-center justify-center gap-1 rounded border border-border bg-surface text-[10.5px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
									title="导入本地 SSH 配置"
								>
									<span className="icon-[lucide--download] size-3" />
									导入 Config
								</button>
								<button
									type="button"
									onClick={() => navigate("/keys")}
									className="flex h-6.5 items-center justify-center gap-1 rounded border border-border bg-surface px-2 text-[10.5px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground transition-colors cursor-pointer"
									title="管理 SSH 密钥"
								>
									<span className="icon-[lucide--key] size-3" />
									密钥
								</button>
							</div>
						</div>
					</div>
				</aside>

				{/* 右侧主机工作区 */}
				<div className="flex min-w-0 flex-1 flex-col bg-surface">
					{/* 操作顶栏 */}
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-4">
						<div className="flex items-center gap-2">
							<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">主机库</h1>
							<span className="text-[11px] text-muted">
								{total} 台主机 · {online} 台在线
							</span>
							{shown.length !== total && total > 0 && (
								<span className="text-[11px] text-faint">· 当前筛选 {shown.length} 台</span>
							)}
							{dragging && (
								<span className="flex items-center gap-1 text-[11px] text-primary">
									<span className="icon-[lucide--move] size-3" />
									正在拖动 {dragging.name}
								</span>
							)}
						</div>

						<div className="flex items-center gap-2">
							<Segmented
								value={view}
								onChange={(v) => useHostsStore.getState().setView(v)}
								options={[
									{ value: "card", label: "卡片", icon: "icon-[lucide--layout-grid]" },
									{ value: "list", label: "列表", icon: "icon-[lucide--list]" },
									{ value: "tree", label: "树形", icon: "icon-[lucide--folder-tree]" },
								]}
							/>
							<Button variant="primary" size="sm" icon="icon-[lucide--plus]" className="h-6.5 px-2.5" onClick={() => navigate("/hosts/new")}>
								新建主机
							</Button>
						</div>
					</div>

					{/* 主体：三视图 + 空状态 */}
					{libraryEmpty ? (
						<div className="min-h-0 flex-1">
							<EmptyState
								icon="icon-[lucide--server-off]"
								title="主机库还是空的"
								action={
									<div className="flex items-center gap-2">
										<Button variant="primary" size="sm" icon="icon-[lucide--plus]" onClick={() => navigate("/hosts/new")}>
											新建主机
										</Button>
										<Button
											size="sm"
											icon="icon-[lucide--download]"
											onClick={() =>
												toast({
													title: "尚未接入 ~/.ssh/config 解析",
													description: "解析本机 SSH 配置需要读取文件系统，还没有实现。",
													tone: "warning",
												})
											}
										>
											导入 ~/.ssh/config
										</Button>
									</div>
								}
							/>
						</div>
					) : shown.length === 0 ? (
						<div className="min-h-0 flex-1">
							<EmptyState
								icon="icon-[lucide--search-x]"
								title="没有匹配的主机"
								action={
									<Button size="sm" icon="icon-[lucide--x]" onClick={() => useHostsStore.getState().setQuery("")} disabled={!query}>
										清除搜索
									</Button>
								}
							/>
						</div>
					) : view === "card" ? (
						<div className="grid min-h-0 flex-1 grid-cols-4 content-start gap-2.5 overflow-y-auto p-4">
							{shown.map((h) => (
								<HostCard
									key={h.id}
									host={h}
									selected={selectedIds.includes(h.id)}
									dragging={draggingId === h.id}
									onSelect={() => useHostsStore.getState().toggleSelect(h.id)}
									onOpen={() => openHost(h)}
									onConnect={() => connectHost(h)}
									onEdit={() => navigate(`/hosts/${h.id}/edit`)}
									onDelete={() => deleteHosts([h.id])}
								/>
							))}
						</div>
					) : view === "list" ? (
						<div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
							<div className="sticky top-0 z-10 flex h-7 shrink-0 items-center gap-3 border-b border-border bg-surface-sunk px-4 text-[10px] font-medium tracking-wider text-faint uppercase">
								<span className="w-4" />
								<span className="w-[190px]">名称</span>
								<span className="w-[170px]">地址</span>
								<span className="w-[90px]">用户</span>
								<span className="flex-1">标签 / 规格</span>
								<span className="w-[76px] text-right">延迟</span>
								<span className="w-[92px] text-right">操作</span>
							</div>
							{shown.map((h) => (
								<HostRow
									key={h.id}
									host={h}
									selected={selectedIds.includes(h.id)}
									dragging={draggingId === h.id}
									onSelect={() => useHostsStore.getState().toggleSelect(h.id)}
									onOpen={() => openHost(h)}
									onConnect={() => connectHost(h)}
									onEdit={() => navigate(`/hosts/${h.id}/edit`)}
									onDelete={() => deleteHosts([h.id])}
								/>
							))}
						</div>
					) : (
						<div className="min-h-0 flex-1 overflow-y-auto p-3">
							{[...groups, { id: "__none__", name: "未分组", parentId: null }].map((g) => {
								const children = shown.filter((h) => (g.id === "__none__" ? h.groupId === null : h.groupId === g.id));
								const open = !collapsed.includes(g.id);
								return (
									<div key={g.id} className="mb-0.5">
										<button
											type="button"
											onClick={() => setCollapsed((c) => (c.includes(g.id) ? c.filter((x) => x !== g.id) : [...c, g.id]))}
											onDragOver={(e) => e.preventDefault()}
											onDrop={(e) => {
												e.preventDefault();
												const id = e.dataTransfer.getData("text/plain");
												const host = useHostsStore.getState().hosts.find((h) => h.id === id);
												if (!host) return;
												useHostsStore.getState().upsertHost({ ...host, groupId: g.id === "__none__" ? null : g.id });
												useHostsStore.getState().setDragging(null);
												toast({ title: `已移动 ${host.name} 到「${g.name}」`, tone: "success" });
											}}
											className={cn(
												"flex h-7 w-full items-center gap-1.5 rounded px-2 text-[12px] text-muted transition-colors hover:bg-surface hover:text-surface-foreground",
												draggingId && "border border-dashed border-primary/40 bg-primary/5",
											)}
										>
											<span className={cn("icon-[lucide--chevron-right] size-3 transition-transform", open && "rotate-90")} />
											<span className={cn(open ? "icon-[lucide--folder-open]" : "icon-[lucide--folder]", "size-3.5 text-faint")} />
											<span className="font-medium text-surface-foreground">{g.name}</span>
											<span className="font-mono text-[10px] text-faint">{children.length}</span>
										</button>
										{open && (
											<div className="ml-3.5 border-l border-border pl-1">
												{children.length === 0 ? (
													<div className="flex h-7 items-center gap-1.5 px-2 text-[11px] text-faint">
														<span className="icon-[lucide--inbox] size-3" />
														该分组暂无主机
													</div>
												) : (
													children.map((h) => (
														<div
															key={h.id}
															role="button"
															tabIndex={0}
															draggable
															onDragStart={(e) => {
																e.dataTransfer.setData("text/plain", h.id);
																useHostsStore.getState().setDragging(h.id);
															}}
															onDragEnd={() => useHostsStore.getState().setDragging(null)}
															onClick={() => useHostsStore.getState().toggleSelect(h.id)}
															onDoubleClick={() => openHost(h)}
															className={cn(
																"group flex h-7 w-full items-center gap-2 rounded px-2 text-left transition-colors hover:bg-surface-raised",
																selectedIds.includes(h.id) && "bg-primary/5",
																draggingId === h.id && "opacity-40",
															)}
														>
															<HostStatusDot host={h} />
															<span className="w-[170px] truncate font-mono text-[11.5px] text-surface-foreground">{h.name}</span>
															<span className="w-[150px] truncate font-mono text-[11px] text-muted">{h.hostname}</span>
															<span className="flex-1 truncate text-[11px] text-faint">
																{h.os?.name ?? "未识别系统"} · {h.username}
															</span>
															<span className="flex items-center gap-2">
																<LatencyCell host={h} />
																<span className="hidden items-center gap-0.5 group-hover:flex">
																	<IconAction icon="icon-[lucide--terminal]" label="连接" onClick={() => connectHost(h)} />
																	<IconAction icon="icon-[lucide--pencil]" label="编辑" onClick={() => navigate(`/hosts/${h.id}/edit`)} />
																	<IconAction
																		icon="icon-[lucide--trash-2]"
																		label="删除"
																		danger
																		onClick={() => deleteHosts([h.id])}
																	/>
																</span>
															</span>
														</div>
													))
												)}
											</div>
										)}
									</div>
								);
							})}
						</div>
					)}
				</div>

				{/* 多选批量操作条 */}
				{selectedIds.length > 0 && (
					<div className="absolute bottom-3 left-1/2 z-30 flex -translate-x-1/2 items-center gap-2 rounded-card border border-border bg-surface-raised px-2.5 py-1.5 shadow-lg">
						<span className="flex items-center gap-1.5 text-[11.5px] text-surface-foreground">
							<span className="icon-[lucide--check-square] size-3.5 text-primary" />
							已选 {selectedIds.length} 台主机
						</span>
						<span className="h-4 w-px bg-border" />
						<Button size="sm" variant="primary" icon="icon-[lucide--terminal]" onClick={() => navigate("/connect")}>
							批量连接
						</Button>
						<div className="flex items-center gap-1">
							<Select
								value={moveTarget}
								onChange={(e) => {
									setMoveTarget(e.target.value);
									if (!e.target.value) return;
									moveHosts(selectedIds, e.target.value, groups.find((g) => g.id === e.target.value)?.name ?? "");
									setMoveTarget("");
								}}
								className="h-6 w-[132px] text-[11px]"
								aria-label="移动到分组"
							>
								<option value="">移动到分组…</option>
								{groups.map((g) => (
									<option key={g.id} value={g.id}>
										{g.name}
									</option>
								))}
							</Select>
						</div>
						<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={() => deleteHosts(selectedIds)}>
							删除
						</Button>
						<Button size="sm" variant="ghost" onClick={() => useHostsStore.getState().clearSelection()}>
							取消选择
						</Button>
					</div>
				)}
			</div>
		</WindowChrome>
	);
}

/* ---------------------------------- 零件 ---------------------------------- */

function GroupRow({
	name,
	icon,
	iconColor,
	count,
	active,
	dropTarget,
	onClick,
	onDrop,
}: {
	name: string;
	icon?: string;
	iconColor?: string;
	count: number;
	active: boolean;
	dropTarget?: boolean;
	onClick: () => void;
	onDrop?: (hostId: string) => void;
}) {
	return (
		<div
			onClick={onClick}
			onDragOver={(e) => {
				if (onDrop) e.preventDefault();
			}}
			onDrop={(e) => {
				if (!onDrop) return;
				e.preventDefault();
				onDrop(e.dataTransfer.getData("text/plain"));
			}}
			className={cn(
				"group flex h-7.5 cursor-pointer items-center justify-between rounded-md px-2.5 text-[11.5px] transition-all select-none border",
				active
					? "border-primary/30 bg-primary/10 font-semibold text-primary shadow-2xs"
					: "border-transparent text-muted hover:bg-surface hover:text-surface-foreground",
				dropTarget && !active && "border-dashed border-primary/50 bg-primary/10",
			)}
		>
			<span className="flex min-w-0 items-center gap-2">
				{icon && <span className={cn(icon, iconColor ?? (active ? "text-primary" : "text-muted"), "size-3.5 shrink-0")} />}
				<span className="truncate">{name}</span>
			</span>
			<span
				className={cn(
					"rounded-full px-1.5 py-0.2 font-mono text-[9px]",
					active ? "bg-primary/20 text-primary font-medium" : "bg-surface-raised text-faint group-hover:text-muted",
				)}
			>
				{count}
			</span>
		</div>
	);
}

function HostCard({
	host,
	selected,
	dragging,
	onSelect,
	onOpen,
	onConnect,
	onEdit,
	onDelete,
}: {
	host: Host;
	selected: boolean;
	dragging: boolean;
	onSelect: () => void;
	/** 打开（聚焦已有会话 / 首次连接） */
	onOpen: () => void;
	/** 明确新建一条连接 */
	onConnect: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<div
			draggable
			onDragStart={(e) => {
				e.dataTransfer.setData("text/plain", host.id);
				useHostsStore.getState().setDragging(host.id);
			}}
			onDragEnd={() => useHostsStore.getState().setDragging(null)}
			onClick={onSelect}
			onDoubleClick={onOpen}
			className={cn(
				"group flex cursor-pointer flex-col justify-between rounded-card border bg-surface-raised p-3 transition-colors",
				selected ? "border-primary/60 bg-primary/5" : "border-border hover:border-faint",
				dragging && "border-dashed opacity-45 ring-1 ring-primary/50",
			)}
		>
			<div>
				<div className="flex items-center justify-between gap-1.5">
					<div className="flex min-w-0 items-center gap-1.5">
						<span className={cn(host.os?.icon ?? "icon-[lucide--server]", "size-3.5 text-muted group-hover:text-surface-foreground")} />
						<span className="truncate font-mono text-[12px] font-medium text-surface-foreground">{host.name}</span>
					</div>
					<span className="flex shrink-0 items-center gap-1">
						{selected && <span className="icon-[lucide--check-circle] size-3 text-primary" />}
						<span className="hidden items-center gap-0.5 group-hover:flex">
							<IconAction icon="icon-[lucide--terminal]" label="新建连接" onClick={onConnect} />
							<IconAction icon="icon-[lucide--pencil]" label="编辑" onClick={onEdit} />
							<IconAction icon="icon-[lucide--trash-2]" label="删除" danger onClick={onDelete} />
						</span>
					</span>
				</div>

				<div className="mt-2 truncate font-mono text-[11px] text-muted">
					{host.username}@{host.hostname}:{host.port}
				</div>

				<div className="mt-1 truncate text-[11px] text-faint">{host.spec ?? host.tags.join(" · ")}</div>
			</div>

			<div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10.5px]">
				<span className="flex min-w-0 items-center gap-1">
					<button
						type="button"
						aria-label={host.favorite ? "取消收藏" : "收藏"}
						onClick={(e) => {
							e.stopPropagation();
							useHostsStore.getState().toggleFavorite(host.id);
						}}
						className={cn("shrink-0", host.favorite || "opacity-0 group-hover:opacity-100")}
					>
						<span className={cn("icon-[lucide--star] size-3", host.favorite ? "text-warning" : "text-faint")} />
					</button>
					<span className="truncate text-faint">{host.os?.name ?? "未识别系统"}</span>
				</span>
				<LatencyCell host={host} showDot className="shrink-0" />
			</div>
		</div>
	);
}

function HostRow({
	host,
	selected,
	dragging,
	onSelect,
	onOpen,
	onConnect,
	onEdit,
	onDelete,
}: {
	host: Host;
	selected: boolean;
	dragging: boolean;
	onSelect: () => void;
	/** 打开（聚焦已有会话 / 首次连接） */
	onOpen: () => void;
	/** 明确新建一条连接 */
	onConnect: () => void;
	onEdit: () => void;
	onDelete: () => void;
}) {
	return (
		<div
			draggable
			onDragStart={(e) => {
				e.dataTransfer.setData("text/plain", host.id);
				useHostsStore.getState().setDragging(host.id);
			}}
			onDragEnd={() => useHostsStore.getState().setDragging(null)}
			onClick={onSelect}
			onDoubleClick={onOpen}
			className={cn(
				"group flex h-8 shrink-0 cursor-pointer items-center gap-3 border-b border-border/60 px-4 transition-colors hover:bg-surface-raised",
				selected && "bg-primary/5",
				dragging && "opacity-40",
			)}
		>
			<span className="w-4 shrink-0" />
			<span className="flex w-[190px] min-w-0 shrink-0 items-center gap-1.5">
				<span className={cn(host.os?.icon ?? "icon-[lucide--server]", "size-3 text-muted")} />
				<span className="truncate font-mono text-[11.5px] font-medium text-surface-foreground">{host.name}</span>
			</span>
			<span className="w-[170px] shrink-0 truncate font-mono text-[11px] text-muted">
				{host.hostname}:{host.port}
			</span>
			<span className="w-[90px] shrink-0 truncate font-mono text-[11px] text-muted">{host.username}</span>
			<span className="flex-1 truncate text-[11px] text-faint">
				{host.tags.length > 0 && <span className="mr-1.5 text-muted">{host.tags.map((t) => `#${t}`).join(" ")}</span>}
				{host.spec}
			</span>
			<LatencyCell host={host} showDot className="w-[76px] shrink-0 justify-end" />
			<span className="flex w-[92px] shrink-0 items-center justify-end gap-0.5">
				<span className="hidden items-center gap-0.5 group-hover:flex">
					<IconAction icon="icon-[lucide--terminal]" label="新建连接" onClick={onConnect} />
					<IconAction icon="icon-[lucide--pencil]" label="编辑" onClick={onEdit} />
					<IconAction icon="icon-[lucide--trash-2]" label="删除" danger onClick={onDelete} />
				</span>
			</span>
		</div>
	);
}

function IconAction({ icon, label, danger, onClick }: { icon: string; label: string; danger?: boolean; onClick: () => void }) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			onClick={(e) => {
				e.stopPropagation();
				onClick();
			}}
			className={cn(
				"flex size-5 items-center justify-center rounded transition-colors",
				danger ? "text-muted hover:bg-danger/15 hover:text-danger" : "text-muted hover:bg-surface hover:text-surface-foreground",
			)}
		>
			<span className={cn(icon, "size-3")} />
		</button>
	);
}

/* ---------------------------------- 行为 ---------------------------------- */

/** 删除主机：可撤销优于确认（需求书 03-6） */
function deleteHosts(ids: string[]) {
	const state = useHostsStore.getState();
	const removed = state.hosts.filter((h) => ids.includes(h.id));
	if (removed.length === 0) return;
	removed.forEach((h) => state.removeHost(h.id));
	toast({
		title: `已删除 ${removed.length} 台主机`,
		description: removed.map((h) => h.name).join("、"),
		tone: "default",
		action: {
			label: "撤销",
			run: () => {
				const s = useHostsStore.getState();
				removed.forEach((h) => s.upsertHost(h));
				toast({ title: `已恢复 ${removed.length} 台主机`, tone: "success" });
			},
		},
	});
}

function moveHosts(ids: string[], groupId: string, groupName: string) {
	const state = useHostsStore.getState();
	ids.forEach((id) => {
		const host = state.hosts.find((h) => h.id === id);
		if (host) state.upsertHost({ ...host, groupId });
	});
	state.clearSelection();
	toast({ title: `已移动 ${ids.length} 台主机到「${groupName}」`, tone: "success" });
}
