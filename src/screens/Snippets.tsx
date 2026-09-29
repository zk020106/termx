import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, EnvStripe, SectionLabel } from "@/components/ui/Display";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import { SNIPPET_TARGET_LABEL, type Env, type Host, type Snippet, type SnippetTarget } from "@/data/types";
import { cn } from "@/lib/cn";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { draftSnippet, extractVariables, useSnippetsStore } from "@/store/snippets";
import { toast } from "@/store/toast";
import { useEffect, useMemo, useState } from "react";

/* =============================================================================
 * 命令片段（需求书 06-Snippets）
 * 数据来源：片段来自 useSnippetsStore()（落盘），主机来自 useHostsStore()，
 *          发送目标来自 useSessionsStore()（真实打开的标签与分屏格，首次启动为空）。
 * 覆盖状态：列表（按分组）/ 分组筛选 / 编辑抽屉 / 发送前填变量 + 实时预览 /
 *          发送目标选择 / 生产环境二次确认 / 空状态 / 搜索无结果。
 *
 * 诚实边界：终端注入要等 SSH 会话层接入，目前「发送」会把最终命令复制到剪贴板并如实说明。
 * ========================================================================== */

const ALL_GROUPS = "全部分组";
const ENV_ORDER: Env[] = ["prod", "stage", "test", "dev"];
const TARGETS: SnippetTarget[] = ["current", "selected", "all"];

const VAR_GLOBAL = /\$\{[A-Za-z0-9_-]+\}/g;
const VAR_TOKEN = /^\$\{[A-Za-z0-9_-]+\}$/;

/** 评审用状态切换器：一次点选切到某个必查状态 */
type ReviewState = "list" | "new" | "edit" | "noresult";

const REVIEW_STATES: { value: ReviewState; label: string }[] = [
	{ value: "list", label: "列表" },
	{ value: "new", label: "新建" },
	{ value: "edit", label: "编辑" },
	{ value: "noresult", label: "无结果" },
];

/** 深链 `#/snippets?state=new`：让截图工具能直接打开某个评审状态 */
function readReviewState(): ReviewState | null {
	const value = new URLSearchParams(window.location.hash.split("?")[1] ?? "").get("state");
	return REVIEW_STATES.some((item) => item.value === value) ? (value as ReviewState) : null;
}

/** 把命令切成「普通文本 / 变量占位」两类片段，用于模板与预览高亮 */
function tokenize(command: string): { text: string; isVar: boolean }[] {
	return command
		.split(/(\$\{[A-Za-z0-9_-]+\})/g)
		.filter((part) => part !== "")
		.map((part) => ({ text: part, isVar: VAR_TOKEN.test(part) }));
}

export default function Snippets() {
	const library = useSnippetsStore((s) => s.snippets);
	const upsert = useSnippetsStore((s) => s.upsert);
	const removeSnippet = useSnippetsStore((s) => s.remove);
	const hostById = useHostsStore((s) => s.hostById);
	const hosts = useHostsStore((s) => s.hosts);
	const tabs = useSessionsStore((s) => s.tabs);
	const panes = useSessionsStore((s) => s.panes);
	const focusedPaneId = useSessionsStore((s) => s.focusedPaneId);

	const [query, setQuery] = useState("");
	const [group, setGroup] = useState<string>(ALL_GROUPS);
	const [selectedId, setSelectedId] = useState<string>("");
	const [values, setValues] = useState<Record<string, string>>({});
	const [target, setTarget] = useState<SnippetTarget>("current");
	const [pickedPanes, setPickedPanes] = useState<string[]>([]);
	const [prodChecked, setProdChecked] = useState(false);
	const [draft, setDraft] = useState<Snippet | null>(null);
	const [draftTouched, setDraftTouched] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	const [review, setReview] = useState<ReviewState>("list");

	/* ------------------------------ 派生数据 ------------------------------ */

	const groups = useMemo(() => [...new Set(library.map((item) => item.group))], [library]);

	const filtered = useMemo(() => {
		const keyword = query.trim().toLowerCase();
		return library.filter((item) => {
			if (group !== ALL_GROUPS && item.group !== group) return false;
			if (!keyword) return true;
			return (
				item.name.toLowerCase().includes(keyword) ||
				item.command.toLowerCase().includes(keyword) ||
				item.group.toLowerCase().includes(keyword)
			);
		});
	}, [library, group, query]);

	const grouped = useMemo(() => {
		const buckets = new Map<string, Snippet[]>();
		for (const item of filtered) {
			const bucket = buckets.get(item.group);
			if (bucket) bucket.push(item);
			else buckets.set(item.group, [item]);
		}
		return [...buckets.entries()];
	}, [filtered]);

	const selected = library.find((item) => item.id === selectedId) ?? null;
	const currentPane = panes.find((pane) => pane.id === focusedPaneId) ?? panes[0] ?? null;
	const currentHost = currentPane?.hostId ? hostById(currentPane.hostId) : undefined;
	const hasSessions = panes.length > 0;

	/** 本次发送会触及的主机（按发送目标解析，来自真实会话） */
	const affectedHosts = useMemo(() => {
		const ids =
			target === "all"
				? tabs.map((tab) => tab.hostId)
				: (target === "current" ? (currentPane ? [currentPane] : []) : panes.filter((pane) => pickedPanes.includes(pane.id))).map(
						(pane) => pane.hostId,
					);
		return ids.map((id) => (id ? hostById(id) : undefined)).filter((host): host is Host => host !== undefined);
	}, [target, pickedPanes, tabs, panes, currentPane, hostById]);

	const prodHosts = affectedHosts.filter((host) => host.env === "prod");
	const affectedEnvs = ENV_ORDER.filter((env) => affectedHosts.some((host) => host.env === env));

	const unresolved = selected ? selected.variables.filter((name) => (values[name] ?? "").trim() === "") : [];
	const resolvedCommand = useMemo(() => {
		if (!selected) return "";
		return selected.command.replace(VAR_GLOBAL, (token) => {
			const value = (values[token.slice(2, -1)] ?? "").trim();
			return value || token;
		});
	}, [selected, values]);

	const needProdConfirm = (target === "all" && tabs.length > 0) || prodHosts.length > 0;
	const prodBlocked = needProdConfirm && !prodChecked;
	const blockedReason = !hasSessions
		? "还没有已连接的终端：先在主机库打开一个会话"
		: target === "selected" && pickedPanes.length === 0
			? "请至少选择一个分屏格"
			: unresolved.length > 0
				? `还有 ${unresolved.length} 个变量未填写`
				: prodBlocked
					? "请先勾选生产环境确认"
					: null;
	const canSend = selected !== null && blockedReason === null;

	const targetHint: Record<SnippetTarget, string> = {
		current: hasSessions ? `焦点格 ${currentHost?.name ?? "本地终端"}` : "无会话",
		selected: `已选 ${pickedPanes.length} 个分屏格`,
		all: `已连接 ${tabs.length} 个`,
	};

	const targetInfo = useMemo(() => {
		if (!hasSessions) {
			return {
				label: "还没有可发送的终端",
				detail: "命令片段会注入到已连接的 PTY；先在主机库打开一个会话，这里才能选发送目标。",
			};
		}
		if (target === "current") {
			return {
				label: currentHost?.name ?? "本地终端",
				detail: "命令将注入当前焦点分屏格的 PTY（终端注入通道接入后生效）。",
			};
		}
		if (target === "selected") {
			const names = panes
				.filter((pane) => pickedPanes.includes(pane.id))
				.map((pane) => (pane.hostId ? (hostById(pane.hostId)?.name ?? "本地终端") : "本地终端"));
			return {
				label: names.length > 0 ? `${names.length} 个分屏格 · ${[...new Set(names)].join("、")}` : "尚未选择分屏格",
				detail: "命令将逐个注入所选分屏格的 PTY，注入顺序与分屏排列一致。",
			};
		}
		return {
			label: `全部已连接终端（${tabs.length} 个）`,
			detail: `广播注入：${tabs.map((tab) => tab.title).join("、") || "—"}。广播期间各标签的输入会互相同步。`,
		};
	}, [target, pickedPanes, currentHost, tabs, panes, hasSessions, hostById]);

	/* -------------------------------- 交互 -------------------------------- */

	/** 分屏格变化时，保持已选集合有效（默认选中焦点格） */
	useEffect(() => {
		const focused = focusedPaneId || panes[0]?.id;
		if (!focused) {
			setPickedPanes([]);
			return;
		}
		setPickedPanes((prev) => {
			const alive = prev.filter((id) => panes.some((pane) => pane.id === id));
			return alive.length > 0 ? alive : [focused];
		});
	}, [panes, focusedPaneId]);

	const selectSnippet = (id: string) => {
		setSelectedId(id);
		setValues({});
		setProdChecked(false);
	};

	const togglePane = (id: string) => {
		setPickedPanes((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
		setProdChecked(false);
	};

	const openNew = () => {
		const base = draftSnippet();
		setDraftTouched(false);
		setDraft({ ...base, group: group === ALL_GROUPS ? (groups[0] ?? base.group) : group });
	};

	const openEdit = (item: Snippet) => {
		setDraftTouched(false);
		setDraft({ ...item });
	};

	const saveDraft = () => {
		if (!draft) return;
		const name = draft.name.trim();
		const command = draft.command.trim();
		if (!name || !command) return;
		const variables = extractVariables(command);
		const groupName = draft.group.trim() || "默认";
		const description = draft.description?.trim() ?? "";
		const next: Snippet = { id: draft.id, name, group: groupName, command, variables };
		if (description) next.description = description;

		const isNew = !library.some((item) => item.id === next.id);
		upsert(next);
		setSelectedId(next.id);
		setValues({});
		setProdChecked(false);
		setDraft(null);
		setQuery("");
		setGroup(ALL_GROUPS);
		toast({
			title: isNew ? "片段已创建" : "片段已保存",
			description: `${next.group} · ${next.name}${next.variables.length > 0 ? ` · ${next.variables.length} 个变量` : ""}`,
			tone: "success",
		});
	};

	const confirmDelete = () => {
		if (!selected) return;
		const victim = selected;
		removeSnippet(victim.id);
		setDeleteOpen(false);
		setSelectedId((id) => (id === victim.id ? "" : id));
		toast({ title: `已删除片段 ${victim.name}`, tone: "default" });
	};

	const handleSend = () => {
		if (!selected || !canSend) return;
		void navigator.clipboard?.writeText(resolvedCommand).catch(() => undefined);
		toast({
			title: "命令已复制，终端注入尚未接入",
			description: `目标：${targetInfo.label} · PTY 注入要等 SSH 会话层接入，请先手动粘贴执行。`,
			tone: "warning",
		});
	};

	const handleCopy = () => {
		if (!selected) return;
		void navigator.clipboard?.writeText(resolvedCommand).catch(() => undefined);
		toast({ title: "命令已复制", description: resolvedCommand });
	};

	/* Ctrl + Enter 发送（每次渲染重挂载，始终拿到最新的变量与确认状态；抽屉打开时不触发） */
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (draft) return;
			if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
				event.preventDefault();
				handleSend();
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	});

	/** 状态切换器：一键进入某个必查状态 */
	const applyReview = (next: ReviewState) => {
		setReview(next);
		setProdChecked(false);
		setDraft(null);
		setQuery("");
		setGroup(ALL_GROUPS);
		setTarget("current");
		switch (next) {
			case "list":
				break;
			case "new":
				openNew();
				break;
			case "edit": {
				const editing = library.find((item) => item.id === selectedId) ?? library[0];
				if (!editing) {
					toast({ title: "还没有片段可编辑", description: "先新建一个命令片段。", tone: "warning" });
					break;
				}
				setSelectedId(editing.id);
				openEdit(editing);
				break;
			}
			case "noresult":
				setQuery("内网穿透");
				break;
		}
	};

	/* 深链预置状态（`#/snippets?state=new` 等），首帧后套用一次 */
	useEffect(() => {
		const preset = readReviewState();
		if (preset) applyReview(preset);
	}, []);

	/* -------------------------------- 渲染 -------------------------------- */

	const draftVars = draft ? extractVariables(draft.command) : [];
	const draftNameError = draft && draft.name.trim() === "" ? "名称不能为空" : undefined;
	const draftCommandError = draft && draft.command.trim() === "" ? "命令不能为空" : undefined;
	const draftValid = draft !== null && !draftNameError && !draftCommandError;

	const body =
		library.length === 0 ? (
			<EmptyState
				icon="icon-[lucide--terminal-square]"
				title="还没有命令片段"
				description="把常用的运维命令保存成片段：用 ${变量} 声明参数，发送前填写即可一键复用。片段只存在你自己的机器上。"
				action={
					<Button variant="primary" icon="icon-[lucide--plus]" onClick={openNew}>
						新建片段
					</Button>
				}
			/>
		) : filtered.length === 0 ? (
			<EmptyState
				icon="icon-[lucide--search-x]"
				title="没有匹配的片段"
				description={
					query.trim()
						? `没有找到与「${query.trim()}」匹配的片段，换个关键字，或把分组切回「${ALL_GROUPS}」。`
						: `「${group}」分组下暂无片段，试试切换分组。`
				}
				action={
					<Button
						size="sm"
						icon="icon-[lucide--undo-2]"
						onClick={() => {
							setQuery("");
							setGroup(ALL_GROUPS);
						}}
					>
						清空筛选
					</Button>
				}
			/>
		) : !selected ? (
			<EmptyState
				icon="icon-[lucide--mouse-pointer-click]"
				title="选择一个命令片段"
				description="从左侧片段库中选择片段，即可填写变量并发送到终端。"
			/>
		) : (
			<div className="min-h-0 flex-1 overflow-y-auto p-6">
				<div className="max-w-2xl space-y-5">
					{/* 片段卡片 */}
					<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
						<div className="flex items-start justify-between gap-3 border-b border-border pb-3">
							<div className="min-w-0">
								<div className="flex items-center gap-2">
									<h2 className="truncate text-[14px] font-semibold text-surface-foreground">{selected.name}</h2>
									<Badge>{selected.group}</Badge>
								</div>
								<p className={cn("mt-1 text-[11.5px]", selected.description ? "text-muted" : "text-faint")}>
									{selected.description ?? "未填写说明"}
								</p>
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								<Button size="sm" icon="icon-[lucide--edit-3]" onClick={() => openEdit(selected)}>
									编辑
								</Button>
								<Button size="sm" variant="ghost" icon="icon-[lucide--trash-2]" onClick={() => setDeleteOpen(true)}>
									删除
								</Button>
							</div>
						</div>

						<div className="mt-4">
							<div className="mb-1 flex items-center justify-between font-mono text-[11px] text-faint">
								<span>SCRIPT TEMPLATE</span>
								<span>
									{selected.variables.length > 0 ? `包含 ${selected.variables.length} 个动态变量` : "无动态变量，可原样发送"}
								</span>
							</div>
							<div className="rounded border border-border bg-term p-3 font-mono text-[12.5px] text-term-ink">
								{tokenize(selected.command).map((piece, index) =>
									piece.isVar ? (
										<span
											key={index}
											className="rounded bg-primary/20 px-1 py-0.5 font-semibold text-primary ring-1 ring-primary/40"
										>
											{piece.text}
										</span>
									) : (
										<span key={index}>{piece.text}</span>
									),
								)}
							</div>
						</div>
					</div>

					{/* 执行面板：变量替换 + 发送目标 + 生产确认 */}
					<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-md">
						<div className="flex items-center justify-between gap-2 border-b border-border pb-3">
							<div className="flex items-center gap-2">
								<span className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
									<span className="icon-[lucide--play] size-3" />
								</span>
								<h3 className="text-[13px] font-semibold text-surface-foreground">执行前变量替换</h3>
							</div>
							<div className="flex items-center gap-1.5">
								{affectedEnvs.map((env) => (
									<EnvPill key={env} env={env} size="xs" />
								))}
								<span className="font-mono text-[10px] text-faint">
									{affectedHosts.length > 0 ? `${affectedHosts.length} 台目标主机` : "目标主机 —"}
								</span>
							</div>
						</div>

						<div className="mt-4 space-y-3">
							{selected.variables.length === 0 ? (
								<div className="flex items-center gap-1.5 rounded border border-border bg-surface px-2.5 py-2 text-[11px] text-muted">
									<span className="icon-[lucide--info] size-3.5 text-primary" />
									该片段没有动态变量，将按模板原样发送。
								</div>
							) : (
								selected.variables.map((name) => (
									<div key={name} className="flex flex-col">
										<div className="mb-1 flex items-center justify-between">
											<label htmlFor={`snippet-var-${name}`} className="font-mono text-[11.5px] font-medium text-primary">
												{`\${${name}}`}
											</label>
											<span className="text-[11px] text-faint">必填参数</span>
										</div>
										<Input
											id={`snippet-var-${name}`}
											value={values[name] ?? ""}
											onChange={(event) => setValues((prev) => ({ ...prev, [name]: event.target.value }))}
											placeholder={`填写 ${name} 的值`}
											className="h-7.5 font-mono text-[12px]"
										/>
									</div>
								))
							)}

							{/* 实时预览：替换后的完整命令 */}
							{selected.variables.length > 0 && (
								<div className="flex flex-col">
									<div className="mb-1 flex items-center justify-between font-mono text-[11px] text-faint">
										<span>PREVIEW · 将发送的命令</span>
										<span>{unresolved.length === 0 ? "变量已全部替换" : `${unresolved.length} 个变量待填写`}</span>
									</div>
									<div className="rounded border border-border bg-term p-3 font-mono text-[12.5px] text-term-ink">
										{tokenize(selected.command).map((piece, index) => {
											if (!piece.isVar) return <span key={index}>{piece.text}</span>;
											const filled = (values[piece.text.slice(2, -1)] ?? "").trim();
											return filled ? (
												<span
													key={index}
													className="rounded bg-primary/20 px-1 py-0.5 font-semibold text-primary ring-1 ring-primary/40"
												>
													{filled}
												</span>
											) : (
												<span
													key={index}
													className="rounded bg-danger/15 px-1 py-0.5 font-semibold text-danger ring-1 ring-danger/40"
												>
													{piece.text}
												</span>
											);
										})}
									</div>
								</div>
							)}

							{/* 发送目标：来自真实打开的会话 */}
							<div className="flex flex-col">
								<label className="mb-1 text-[11.5px] text-muted">发送目标会话</label>
								{!hasSessions ? (
									<div className="flex items-start gap-2 rounded border border-border bg-surface p-2.5 text-[11px] leading-relaxed text-muted">
										<span className="icon-[lucide--terminal-off] mt-px size-3.5 shrink-0 text-faint" />
										<span>
											还没有已连接的终端。命令片段会注入到 PTY，先在主机库（{hosts.length} 台主机）打开一个会话，
											这里就会出现「当前终端 / 选中的终端 / 全部终端」。
										</span>
									</div>
								) : (
									<>
										<div className="grid grid-cols-3 rounded border border-border bg-surface p-0.5 text-[11.5px]">
											{TARGETS.map((option) => (
												<button
													key={option}
													type="button"
													onClick={() => {
														setTarget(option);
														setProdChecked(false);
													}}
													className={cn(
														"truncate rounded py-1 text-center font-medium transition-colors",
														option === target
															? "border border-border bg-surface-raised text-surface-foreground shadow-sm"
															: "text-muted hover:text-surface-foreground",
													)}
												>
													{SNIPPET_TARGET_LABEL[option]}（{targetHint[option]}）
												</button>
											))}
										</div>

										{target === "selected" && (
											<div className="mt-1.5 space-y-1 rounded border border-border bg-surface p-1.5">
												{panes.map((pane) => {
													const host = pane.hostId ? hostById(pane.hostId) : undefined;
													const picked = pickedPanes.includes(pane.id);
													return (
														<button
															key={pane.id}
															type="button"
															onClick={() => togglePane(pane.id)}
															className={cn(
																"flex w-full items-center gap-2 rounded px-1.5 py-1 text-left transition-colors",
																picked ? "bg-surface-raised" : "hover:bg-surface-raised",
															)}
														>
															<span
																className={cn(
																	"flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
																	picked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface",
																)}
															>
																{picked && <span className="icon-[lucide--check] size-2.5" />}
															</span>
															<EnvStripe env={host?.env ?? "dev"} />
															<span className="truncate text-[11.5px] text-surface-foreground">
																{host?.name ?? "本地终端"}
															</span>
															<span className="ml-auto shrink-0 font-mono text-[10px] text-faint">
																{host?.hostname ?? pane.title}
															</span>
														</button>
													);
												})}
												<div className="px-1.5 pt-0.5 text-[10.5px] text-faint">勾选接收命令的分屏格</div>
											</div>
										)}
									</>
								)}
							</div>

							{/* 目标确认信息 */}
							<div className="rounded border border-border bg-surface p-2.5 text-[11.5px] leading-relaxed text-muted">
								<div className="flex items-center gap-1.5 font-medium text-surface-foreground">
									<span className="icon-[lucide--info] size-3.5 text-primary" />
									<span>目标会话：{targetInfo.label}</span>
								</div>
								<p className="mt-0.5 text-[11px] text-faint">{targetInfo.detail}</p>
							</div>

							{/* 生产环境二次确认 */}
							{needProdConfirm && (
								<div className="rounded border border-danger/40 bg-danger/10 p-2.5">
									<div className="flex flex-wrap items-center gap-1.5 text-[11.5px] font-medium text-danger">
										<span className="icon-[lucide--triangle-alert] size-3.5" />
										生产环境二次确认
										<EnvPill env="prod" size="xs" />
									</div>
									<p className="mt-1 text-[11px] leading-relaxed text-muted">
										{target === "all"
											? "「全部终端」会把命令广播到所有已连接终端，其中包含生产主机；"
											: "当前发送目标包含生产主机；"}
										命令将在远端 PTY 立即执行且无法撤销，请确认无误后再发送。
									</p>
									{prodHosts.length > 0 && (
										<div className="mt-1.5 flex flex-wrap items-center gap-1.5">
											{prodHosts.map((host) => (
												<span
													key={host.id}
													className="flex items-center gap-1 rounded border border-border bg-surface px-1.5 py-0.5 text-[10.5px] text-muted"
												>
													<EnvStripe env={host.env} />
													<span className="font-mono">{host.name}</span>
												</span>
											))}
										</div>
									)}
									<Checkbox
										className="mt-2"
										checked={prodChecked}
										onChange={setProdChecked}
										label="我已知晓命令将在生产环境执行"
										description="未勾选前「发送到终端」不可用"
									/>
								</div>
							)}
						</div>

						{/* 底部动作栏 */}
						<div className="mt-5 flex items-center justify-between gap-3 border-t border-border pt-3">
							{blockedReason ? (
								<span className="flex items-center gap-1.5 text-[10.5px] text-warning">
									<span className="icon-[lucide--circle-alert] size-3" />
									{blockedReason}
								</span>
							) : (
								<span className="font-mono text-[10.5px] text-faint">快捷键: Ctrl + Enter</span>
							)}
							<div className="flex shrink-0 items-center gap-2">
								<Button size="sm" className="h-7" onClick={handleCopy}>
									仅复制命令
								</Button>
								<Button size="sm" className="h-7" variant="primary" icon="icon-[lucide--send]" disabled={!canSend} onClick={handleSend}>
									发送到终端
								</Button>
							</div>
						</div>
						<p className="mt-2 flex items-center gap-1.5 text-[10.5px] text-faint">
							<span className="icon-[lucide--info] size-3" />
							终端注入通道尚未接入 SSH 会话层：现在点「发送到终端」只会把最终命令复制到剪贴板。
						</p>
					</div>
				</div>
			</div>
		);

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧：片段库（搜索 + 分组筛选 + 分组列表） */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--terminal-square] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">命令片段库</h1>
						</div>
						<Button size="sm" variant="primary" icon="icon-[lucide--plus]" onClick={openNew}>
							新建
						</Button>
					</div>

					<div className="px-2 pt-2">
						<div className="relative">
							<span className="icon-[lucide--search] pointer-events-none absolute top-1/2 left-2 size-3 -translate-y-1/2 text-muted" />
							<Input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="搜索片段名称或脚本…"
								className="h-7 pl-6 text-[11px]"
							/>
						</div>
					</div>

					{/* 分组筛选 */}
					<div className="flex flex-wrap gap-1 px-2 py-2">
						{[ALL_GROUPS, ...groups].map((name) => {
							const count = name === ALL_GROUPS ? library.length : library.filter((item) => item.group === name).length;
							return (
								<button
									key={name}
									type="button"
									onClick={() => setGroup(name)}
									className={cn(
										"flex h-5 items-center gap-1 rounded border px-1.5 text-[10px] transition-colors",
										name === group
											? "border-primary/40 bg-primary/15 font-medium text-primary"
											: "border-border bg-surface text-muted hover:bg-surface-raised hover:text-surface-foreground",
									)}
								>
									{name}
									<span className="font-mono text-[9px] text-faint">{count}</span>
								</button>
							);
						})}
					</div>

					<div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-2 pb-2">
						{library.length === 0 ? (
							<div className="px-2 py-4 text-center text-[10.5px] text-faint">还没有命令片段</div>
						) : grouped.length === 0 ? (
							<div className="px-2 py-4 text-center text-[10.5px] text-faint">没有匹配的片段</div>
						) : (
							grouped.map(([groupName, items]) => (
								<div key={groupName}>
									<SectionLabel>{groupName}</SectionLabel>
									<div className="space-y-1">
										{items.map((item) => (
											<SnippetRow
												key={item.id}
												item={item}
												active={item.id === selectedId}
												onSelect={() => selectSnippet(item.id)}
											/>
										))}
									</div>
								</div>
							))
						)}
					</div>

					{/* 评审用状态切换器（骨架期工具，永远浮在抽屉之上） */}
					<div className="relative z-50 shrink-0 border-t border-border px-2 py-1.5">
						<div className="mb-1 flex items-center gap-1 text-[10px] font-medium tracking-wider text-faint uppercase">
							<span className="icon-[lucide--layers] size-3" />
							状态（评审）
						</div>
						<div className="grid grid-cols-4 gap-1">
							{REVIEW_STATES.map((item) => (
								<button
									key={item.value}
									type="button"
									onClick={() => applyReview(item.value)}
									className={cn(
										"h-5 truncate rounded border text-[10px] transition-colors",
										review === item.value
											? "border-primary/40 bg-primary/15 font-medium text-primary"
											: "border-border bg-surface text-muted hover:bg-surface-raised hover:text-surface-foreground",
									)}
								>
									{item.label}
								</button>
							))}
						</div>
					</div>
				</aside>

				{/* 右侧：片段详情 + 参数化执行 */}
				<div className="flex min-w-0 flex-1 flex-col">{body}</div>
			</div>

			{/* 编辑 / 新建抽屉 */}
			<Drawer
				open={draft !== null}
				onClose={() => setDraft(null)}
				title={draft && library.some((item) => item.id === draft.id) ? "编辑命令片段" : "新建命令片段"}
				subtitle={draft ? `${draft.group || "默认"} · ${draftVars.length} 个变量` : undefined}
				width={460}
				footer={
					<>
						<Button size="sm" onClick={() => setDraft(null)}>
							取消
						</Button>
						<Button size="sm" variant="primary" icon="icon-[lucide--check]" disabled={!draftValid} onClick={saveDraft}>
							保存片段
						</Button>
					</>
				}
			>
				{draft && (
					<div className="space-y-4 p-3">
						<Field label="名称" required error={draftTouched ? draftNameError : undefined} hint="显示在片段库与命令面板中">
							<Input
								value={draft.name}
								onChange={(event) => {
									setDraftTouched(true);
									setDraft((prev) => (prev ? { ...prev, name: event.target.value } : prev));
								}}
								placeholder="例如：重启指定微服务"
							/>
						</Field>

						<Field label="分组" hint="用于左侧分组与筛选">
							<Input
								value={draft.group}
								onChange={(event) => setDraft((prev) => (prev ? { ...prev, group: event.target.value } : prev))}
								placeholder="例如：日常发布"
								list="snippet-group-options"
							/>
							<datalist id="snippet-group-options">
								{groups.map((name) => (
									<option key={name} value={name} />
								))}
							</datalist>
						</Field>

						<Field
							label="命令"
							required
							error={draftTouched ? draftCommandError : undefined}
							hint="用 ${变量名} 声明动态参数"
						>
							<Textarea
								rows={4}
								value={draft.command}
								onChange={(event) => {
									setDraftTouched(true);
									setDraft((prev) => (prev ? { ...prev, command: event.target.value } : prev));
								}}
								placeholder="sudo systemctl restart ${service}"
							/>
						</Field>

						<div className="flex flex-wrap items-center gap-1.5 rounded border border-border bg-surface px-2 py-1.5 text-[10.5px] text-faint">
							<span className="icon-[lucide--braces] size-3 text-muted" />
							{draftVars.length === 0 ? (
								<span>未识别到变量，命令将原样发送</span>
							) : (
								<>
									<span>识别到 {draftVars.length} 个变量：</span>
									{draftVars.map((name) => (
										<span key={name} className="rounded bg-primary/15 px-1 py-px font-mono text-primary">
											{`\${${name}}`}
										</span>
									))}
								</>
							)}
						</div>

						<Field label="说明" hint="可选">
							<Textarea
								rows={2}
								value={draft.description ?? ""}
								onChange={(event) => setDraft((prev) => (prev ? { ...prev, description: event.target.value } : prev))}
								placeholder="补充用途、适用环境、注意事项…"
								className="font-sans"
							/>
						</Field>

						<div className="rounded border border-border bg-surface-sunk p-2.5 text-[10.5px] leading-relaxed text-muted">
							<div className="flex items-center gap-1.5 font-medium text-surface-foreground">
								<span className="icon-[lucide--shield-alert] size-3.5 text-warning" />
								<span>发送时会自动做这些检查</span>
							</div>
							<ul className="mt-1 list-disc space-y-0.5 pl-4">
								<li>变量未填写完不允许发送</li>
								<li>目标含生产主机时需要勾选二次确认</li>
								<li>命令注入前会在预览框里逐字展示最终内容</li>
							</ul>
						</div>
					</div>
				)}
			</Drawer>

			{/* 删除确认 */}
			<Modal
				open={deleteOpen}
				onClose={() => setDeleteOpen(false)}
				title="删除命令片段"
				icon="icon-[lucide--trash-2]"
				width={420}
				footer={
					<>
						<Button size="sm" onClick={() => setDeleteOpen(false)}>
							取消
						</Button>
						<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={confirmDelete}>
							删除
						</Button>
					</>
				}
			>
				<p>
					将删除片段 <span className="font-mono text-surface-foreground">{selected?.name ?? "—"}</span>
					，删除后无法恢复。
				</p>
			</Modal>
		</WindowChrome>
	);
}

/** 左侧片段行：名称 + 命令预览 + 变量个数 */
function SnippetRow({ item, active, onSelect }: { item: Snippet; active: boolean; onSelect: () => void }) {
	return (
		<button
			type="button"
			onClick={onSelect}
			className={cn(
				"w-full rounded border p-2 text-left transition-colors",
				active ? "border-border bg-surface-raised shadow-sm" : "border-transparent hover:border-border hover:bg-surface",
			)}
		>
			<div className="flex items-center gap-2">
				<span className="min-w-0 flex-1 truncate text-[12px] font-medium text-surface-foreground">{item.name}</span>
				<span
					className={cn("shrink-0 font-mono text-[9.5px]", item.variables.length > 0 ? "text-primary" : "text-faint")}
				>
					{item.variables.length > 0 ? `变量 ${item.variables.length}` : "无变量"}
				</span>
			</div>
			<div className="mt-0.5 truncate font-mono text-[10.5px] text-muted">{item.command}</div>
		</button>
	);
}
