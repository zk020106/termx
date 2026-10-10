import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, SectionLabel } from "@/components/ui/Display";
import { Field, Input, Textarea } from "@/components/ui/Input";
import { Drawer, Modal } from "@/components/ui/Overlay";
import { SNIPPET_TARGET_LABEL, type Host, type Snippet, type SnippetTarget } from "@/data/types";
import { cn } from "@/lib/cn";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore, writeToPane } from "@/store/sessions";
import { draftSnippet, extractVariables, useSnippetsStore } from "@/store/snippets";
import { toast } from "@/store/toast";
import { ContextMenu, MenuItem, MenuSeparator } from "@/components/ui/Menu";
import { PromptModal } from "@/components/ui/PromptModal";
import { fsLocalReadFile, fsLocalWriteFile } from "@/lib/sftp";
import {
	buildSnippetExportPayload,
	countImportConflicts,
	mergeSnippetImportPayload,
	parseSnippetImportPayload,
	snippetExportFileName,
	type SnippetExportPayload,
	type SnippetImportConflictAction,
} from "@/lib/snippetTransfer";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { ShellHistoryDrawer, ShortkeyField } from "@/components/snippets/SnippetsExtras";
import { useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useSearchParams } from "react-router";

/* =============================================================================
 * 命令片段（需求书 06-Snippets）
 * 数据来源：片段来自 useSnippetsStore()（落盘），主机来自 useHostsStore()，
 *          发送目标来自 useSessionsStore()（真实打开的标签与分屏格，首次启动为空）。
 * 覆盖状态：列表（按分组）/ 分组筛选 / 编辑抽屉 / 发送前填变量 + 实时预览 /
 *          发送目标选择 / 空状态 / 搜索无结果。
 *
 * 发送：按发送目标（焦点格 / 选中的分屏格 / 全部终端）逐格写入真实会话（SSH 或本地 PTY），
 * 末尾补回车执行；写不进去的格子（会话已断开）如实报出，不会假装成功。
 * ========================================================================== */

const ALL_GROUPS = "全部分组";
const TARGETS: SnippetTarget[] = ["current", "selected", "all"];

const VAR_GLOBAL = /\$\{[A-Za-z0-9_-]+\}/g;
const VAR_TOKEN = /^\$\{[A-Za-z0-9_-]+\}$/;

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
	const setAllSnippets = useSnippetsStore((s) => s.setAll);
	const hostById = useHostsStore((s) => s.hostById);
	const tabs = useSessionsStore((s) => s.tabs);
	const panes = useSessionsStore((s) => s.panes);
	const focusedPaneId = useSessionsStore((s) => s.focusedPaneId);

	const [query, setQuery] = useState("");
	const [group, setGroup] = useState<string>(ALL_GROUPS);
	const [selectedId, setSelectedId] = useState<string>("");
	const [values, setValues] = useState<Record<string, string>>({});
	const [target, setTarget] = useState<SnippetTarget>("current");
	const [pickedPanes, setPickedPanes] = useState<string[]>([]);
	const [draft, setDraft] = useState<Snippet | null>(null);
	const [draftTouched, setDraftTouched] = useState(false);
	const [deleteOpen, setDeleteOpen] = useState(false);
	/** 右键菜单（Netcatty SnippetsManager：脚本包菜单 / 片段菜单） */
	const [menu, setMenu] = useState<{ x: number; y: number; kind: "group"; group: string } | { x: number; y: number; kind: "snippet"; item: Snippet } | null>(null);
	const [renameGroup, setRenameGroup] = useState<string | null>(null);
	const [deleteGroup, setDeleteGroup] = useState<string | null>(null);
	const [deleteSnippet, setDeleteSnippet] = useState<Snippet | null>(null);
	const [pendingImport, setPendingImport] = useState<{ payload: SnippetExportPayload; conflicts: number } | null>(null);
	/* Netcatty 多选（snippets.selection.*）与 Shell 历史面板 */
	const [multiSelect, setMultiSelect] = useState(false);
	const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
	const [bulkDelete, setBulkDelete] = useState<string[] | null>(null);
	const [historyOpen, setHistoryOpen] = useState(false);

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
				? panes.map((pane) => pane.hostId)
				: (target === "current" ? (currentPane ? [currentPane] : []) : panes.filter((pane) => pickedPanes.includes(pane.id))).map(
						(pane) => pane.hostId,
					);
		return ids.map((id) => (id ? hostById(id) : undefined)).filter((host): host is Host => host !== undefined);
	}, [target, pickedPanes, tabs, panes, currentPane, hostById]);

	const unresolved = selected ? selected.variables.filter((name) => (values[name] ?? "").trim() === "") : [];
	const resolvedCommand = useMemo(() => {
		if (!selected) return "";
		return selected.command.replace(VAR_GLOBAL, (token) => {
			const value = (values[token.slice(2, -1)] ?? "").trim();
			return value || token;
		});
	}, [selected, values]);

	const blockedReason = !hasSessions
		? "还没有已连接的终端：先在主机库打开一个会话"
		: target === "selected" && pickedPanes.length === 0
			? "请至少选择一个分屏格"
			: unresolved.length > 0
				? `还有 ${unresolved.length} 个变量未填写`
				: null;
	const canSend = selected !== null && blockedReason === null;

	const targetHint: Record<SnippetTarget, string> = {
		current: hasSessions ? `焦点格 ${currentHost?.name ?? "本地终端"}` : "无会话",
		selected: `已选 ${pickedPanes.length} 个分屏格`,
		all: `已连接 ${panes.length} 个`,
	};

	const targetInfo = useMemo(() => {
		if (!hasSessions) {
			return {
				label: "还没有可发送的终端",
				detail: "先在主机库打开一个会话。",
			};
		}
		if (target === "current") {
			return {
				label: currentHost?.name ?? "本地终端",
				detail: undefined,
			};
		}
		if (target === "selected") {
			const names = panes
				.filter((pane) => pickedPanes.includes(pane.id))
				.map((pane) => (pane.hostId ? (hostById(pane.hostId)?.name ?? "本地终端") : "本地终端"));
			return {
				label: names.length > 0 ? `${names.length} 个分屏格 · ${[...new Set(names)].join("、")}` : "尚未选择分屏格",
				detail: undefined,
			};
		}
		return {
			label: `全部已连接终端（${panes.length} 个）`,
			detail: undefined,
		};
	}, [target, pickedPanes, currentHost, tabs, panes, hasSessions, hostById]);

	/* -------------------------------- 交互 -------------------------------- */

	// 从工作区片段面板跳过来：?id= 选中，?edit= 打开编辑抽屉
	const [searchParams, setSearchParams] = useSearchParams();
	useEffect(() => {
		const id = searchParams.get("id") ?? searchParams.get("edit");
		if (!id) return;
		const item = library.find((x) => x.id === id);
		if (item) {
			selectSnippet(item.id);
			if (searchParams.get("edit")) openEdit(item);
		}
		setSearchParams({}, { replace: true });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [searchParams, library]);

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
	};

	const togglePane = (id: string) => {
		setPickedPanes((prev) => (prev.includes(id) ? prev.filter((item) => item !== id) : [...prev, id]));
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
		const targets =
			target === "all"
				? panes
				: target === "current"
					? currentPane
						? [currentPane]
						: []
					: panes.filter((pane) => pickedPanes.includes(pane.id));
		// 与键盘一致用回车（\r）提交；多行片段逐行回车
		const payload = `${resolvedCommand.replace(/\r?\n/g, "\r")}\r`;
		let sent = 0;
		const failed: string[] = [];
		for (const pane of targets) {
			if (writeToPane(pane, payload)) sent += 1;
			else failed.push(pane.hostId ? (hostById(pane.hostId)?.name ?? "未知主机") : "本地终端");
		}
		if (sent > 0 && failed.length === 0) {
			toast({
				title: sent > 1 ? `已发送到 ${sent} 个终端：${selected.name}` : `已注入终端执行：${selected.name}`,
				description: resolvedCommand,
				tone: "success",
			});
		} else if (sent > 0) {
			toast({
				title: `已发送到 ${sent} 个终端，${failed.length} 个未送达`,
				description: `未送达（会话未连接）：${[...new Set(failed)].join("、")}`,
				tone: "warning",
			});
		} else {
			void navigator.clipboard?.writeText(resolvedCommand).catch(() => undefined);
			toast({
				title: "终端未就绪，命令已复制到剪贴板",
				description: "目标终端的会话还没连上或已断开，请先切换到工作区确认。",
				tone: "warning",
			});
		}
	};

	const handleCopy = () => {
		if (!selected) return;
		void navigator.clipboard?.writeText(resolvedCommand).catch(() => undefined);
		toast({ title: "命令已复制", description: resolvedCommand });
	};

	/* ------------------------------ 右键菜单动作（对齐 Netcatty） ------------------------------ */

	const openMenu = (event: ReactMouseEvent, next: { kind: "group"; group: string } | { kind: "snippet"; item: Snippet }) => {
		event.preventDefault();
		event.stopPropagation();
		setMenu({ x: event.clientX, y: event.clientY, ...next });
	};

	/** 运行：Netcatty 在片段绑定的主机上执行；termx 片段不绑主机，发到焦点终端（有变量时先选中让用户填） */
	const runSnippet = (item: Snippet) => {
		if (item.variables.length > 0) {
			selectSnippet(item.id);
			toast({ title: `「${item.name}」有 ${item.variables.length} 个变量，请先填写再发送`, tone: "default" });
			return;
		}
		if (!currentPane) {
			toast({ title: "没有可运行的终端", description: "先在主机库打开一个会话。", tone: "warning" });
			return;
		}
		const payload = `${item.command.replace(/\r?\n/g, "\r")}\r`;
		if (writeToPane(currentPane, payload)) {
			toast({ title: `已注入终端执行：${item.name}`, description: item.command, tone: "success" });
		} else {
			void navigator.clipboard?.writeText(item.command).catch(() => undefined);
			toast({ title: "终端未就绪，命令已复制到剪贴板", tone: "warning" });
		}
	};

	const copySnippet = (item: Snippet) => {
		void navigator.clipboard?.writeText(item.command).catch(() => undefined);
		toast({ title: "命令已复制", description: item.command });
	};

	const clearSelection = () => {
		setSelectedIds(new Set());
		setMultiSelect(false);
	};
	const toggleSelected = (id: string) =>
		setSelectedIds((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	const confirmBulkDelete = () => {
		if (!bulkDelete) return;
		const doomed = new Set(bulkDelete.filter((id) => library.some((item) => item.id === id)));
		setBulkDelete(null);
		if (doomed.size === 0) {
			clearSelection();
			return;
		}
		setAllSnippets(library.filter((item) => !doomed.has(item.id)));
		if (doomed.has(selectedId)) setSelectedId("");
		toast({ title: `已删除 ${doomed.size} 个所选项目。`, tone: "success" });
		clearSelection();
	};
	/** Netcatty saveHistoryAsSnippet：放进当前分组 */
	const saveHistoryAsSnippet = (command: string, label: string) => {
		const next: Snippet = {
			...draftSnippet(),
			id: `sn-${crypto.randomUUID().slice(0, 12)}`,
			name: label,
			command,
			group: group !== ALL_GROUPS ? group : "默认",
			variables: extractVariables(command),
		};
		useSnippetsStore.getState().upsert(next);
		toast({ title: "已保存为代码片段", description: label, tone: "success" });
	};

	/** 导出（Netcatty exportSnippetList：netcatty.snippets v2 JSON） */
	const exportSnippets = async (items: Snippet[], part: string) => {
		if (items.length === 0) {
			toast({ title: "没有可导出的代码片段。", tone: "warning" });
			return;
		}
		try {
			const dest = await saveDialog({ defaultPath: snippetExportFileName(part), filters: [{ name: "JSON", extensions: ["json"] }] });
			if (!dest) return;
			await fsLocalWriteFile(dest, JSON.stringify(buildSnippetExportPayload(items), null, 2));
			toast({ title: "导出已准备好", description: `已导出 ${items.length} 个代码片段。`, tone: "success" });
		} catch (error) {
			toast({ title: "导出失败", description: String(error), tone: "danger" });
		}
	};

	const importSnippets = async () => {
		try {
			const picked = await openDialog({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
			if (!picked || Array.isArray(picked)) return;
			const payload = parseSnippetImportPayload(await fsLocalReadFile(picked));
			if (payload.snippets.length === 0) {
				toast({ title: "导入文件里没有片段", tone: "warning" });
				return;
			}
			const conflicts = countImportConflicts(library, payload);
			if (conflicts > 0) setPendingImport({ payload, conflicts });
			else applyImport(payload, "skip");
		} catch (error) {
			toast({ title: "导入失败", description: String(error), tone: "danger" });
		}
	};

	const applyImport = (payload: SnippetExportPayload, conflictAction: SnippetImportConflictAction) => {
		const { snippets, stats } = mergeSnippetImportPayload({
			existing: useSnippetsStore.getState().snippets,
			payload,
			conflictAction,
			createId: () => `sn-${crypto.randomUUID().slice(0, 12)}`,
			extractVariables,
		});
		setAllSnippets(snippets);
		setPendingImport(null);
		toast({
			title: "导入完成",
			description: `新增 ${stats.imported} 个，覆盖 ${stats.overwritten} 个，跳过 ${stats.skipped} 个`,
			tone: "success",
		});
	};

	const doRenameGroup = (from: string, to: string) => {
		setAllSnippets(library.map((item) => (item.group === from ? { ...item, group: to } : item)));
		if (group === from) setGroup(to);
		setRenameGroup(null);
	};

	/** 删除分组：与 Netcatty 删除脚本包一致，片段保留，移出该分组（回到「默认」） */
	const doDeleteGroup = (name: string) => {
		setAllSnippets(library.map((item) => (item.group === name ? { ...item, group: "默认" } : item)));
		if (group === name) setGroup(ALL_GROUPS);
		setDeleteGroup(null);
	};

	/* Ctrl + Enter 发送（每次渲染重挂载，始终拿到最新的变量状态；抽屉打开时不触发） */
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
			/>
		) : (
			<div className="min-h-0 flex-1 overflow-y-auto p-6">
				<div className="max-w-2xl space-y-5">
					{/* 片段卡片 */}
					<div className="rounded-card border border-border bg-surface-raised/60 p-5 shadow-sm">
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
											className="rounded-[4px] bg-emerald-500/20 px-1 py-0.5 font-semibold text-emerald-400 ring-1 ring-emerald-500/40"
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

					{/* 执行面板：变量替换 + 发送目标 */}
					<div className="rounded-card border border-border bg-surface-raised/60 p-5 shadow-sm">
						<div className="flex items-center justify-between gap-2 border-b border-border pb-3">
							<div className="flex items-center gap-2">
								<span className="flex size-5 items-center justify-center rounded-control bg-surface-foreground/10 text-surface-foreground">
									<span className="icon-[lucide--play] size-3" />
								</span>
								<h3 className="text-[13px] font-semibold text-surface-foreground">执行前变量替换</h3>
							</div>
							<div className="flex items-center gap-1.5">
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
										<span className="icon-[lucide--square-terminal] mt-px size-3.5 shrink-0 text-faint" />
										<span>还没有已连接的终端：先在主机库打开一个会话。</span>
									</div>
								) : (
									<>
										<div className="grid grid-cols-3 rounded border border-border bg-surface p-0.5 text-[11.5px]">
											{TARGETS.map((option) => (
												<button
													key={option}
													type="button"
													onClick={() => setTarget(option)}
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
								{targetInfo.detail && <p className="mt-0.5 text-[11px] text-faint">{targetInfo.detail}</p>}
							</div>
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
							「发送到终端」会把最终命令写入所选终端并回车执行；会话未连接的终端不会收到。
						</p>
					</div>
				</div>
			</div>
		);

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧：片段库（搜索 + 分组筛选 + 分组列表） */}
				<aside className="flex w-[300px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 shrink-0 items-center justify-between border-b border-border px-3">
						<div className="flex shrink-0 items-center gap-1.5 min-w-0">
							<span className="icon-[lucide--terminal-square] size-3.5 shrink-0 text-primary" />
							<h1 className="whitespace-nowrap text-[12px] font-semibold text-surface-foreground">命令片段库</h1>
						</div>
						<div className="flex shrink-0 items-center gap-1">
							<Button
								size="sm"
								variant="ghost"
								icon="icon-[lucide--upload]"
								onClick={() => void importSnippets()}
								title="导入片段（Netcatty JSON）"
								className="h-6.5 px-2 text-[11px]"
							>
								导入
							</Button>
							<Button
								size="sm"
								variant="ghost"
								icon="icon-[lucide--download]"
								onClick={() => void exportSnippets(library, "all")}
								disabled={library.length === 0}
								title="导出全部片段（Netcatty JSON）"
								className="h-6.5 px-2 text-[11px]"
							>
								导出
							</Button>
							<Button
								size="sm"
								variant="primary"
								icon="icon-[lucide--plus]"
								onClick={openNew}
								className="h-6.5 px-2.5 text-[11px]"
							>
								新建
							</Button>
						</div>
					</div>
					<div className="flex items-center gap-1 border-b border-border px-2.5 py-1">
						<Button
							size="sm"
							variant={historyOpen ? "primary" : "ghost"}
							icon="icon-[lucide--clock]"
							onClick={() => setHistoryOpen(!historyOpen)}
							className="h-6.5 px-2 text-[11px]"
						>
							Shell 历史
						</Button>
						<div className="flex-1" />
						<Button
							size="sm"
							variant={multiSelect ? "primary" : "ghost"}
							icon="icon-[lucide--square-check]"
							title="选择代码片段"
							aria-label="选择代码片段"
							onClick={() => (multiSelect ? clearSelection() : setMultiSelect(true))}
							className="h-6.5 w-6.5 p-0"
						/>
					</div>
					{multiSelect && (
						<div className="flex flex-wrap items-center gap-1 border-b border-border px-2 py-1.5">
							<span className="text-[11px] text-muted">已选择 {selectedIds.size} 个</span>
							<div className="flex-1" />
							<Button size="sm" variant="ghost" onClick={() => setSelectedIds(new Set(filtered.map((item) => item.id)))}>
								选择当前显示
							</Button>
							<Button size="sm" variant="ghost" onClick={clearSelection}>
								取消选择
							</Button>
							<Button
								size="sm"
								variant="primary"
								icon="icon-[lucide--download]"
								disabled={selectedIds.size === 0}
								onClick={() => void exportSnippets(library.filter((item) => selectedIds.has(item.id)), "selected")}
							>
								导出选中（{selectedIds.size}）
							</Button>
							<Button
								size="sm"
								variant="danger"
								icon="icon-[lucide--trash-2]"
								disabled={selectedIds.size === 0}
								onClick={() => setBulkDelete(library.filter((item) => selectedIds.has(item.id)).map((item) => item.id))}
							>
								删除（{selectedIds.size}）
							</Button>
						</div>
					)}

					<div className="px-2 pt-2">
						<div className="relative">
							<span className="icon-[lucide--search] pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-muted" />
							<Input
								value={query}
								onChange={(event) => setQuery(event.target.value)}
								placeholder="搜索片段名称或脚本…"
								className="h-7.5 pl-8 text-[11.5px]"
							/>
						</div>
					</div>

					{/* 分组筛选 */}
					<div className="flex flex-wrap gap-1.5 px-2 py-2">
						{[ALL_GROUPS, ...groups].map((name) => {
							const count = name === ALL_GROUPS ? library.length : library.filter((item) => item.group === name).length;
							return (
								<button
									key={name}
									type="button"
									onClick={() => setGroup(name)}
									onContextMenu={(event) => {
										if (name !== ALL_GROUPS) openMenu(event, { kind: "group", group: name });
									}}
									className={cn(
										"inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-[11px] font-medium transition-colors cursor-pointer select-none",
										name === group
											? "border-primary/50 bg-primary/15 text-primary font-semibold shadow-2xs"
											: "border-border/70 bg-surface text-muted hover:border-border hover:bg-surface-raised hover:text-surface-foreground",
									)}
								>
									<span>{name}</span>
									<span className={cn("font-mono text-[10px]", name === group ? "text-primary/80 font-bold" : "text-faint")}>
										{count}
									</span>
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
									<div onContextMenu={(event) => openMenu(event, { kind: "group", group: groupName })}>
										<SectionLabel>{groupName}</SectionLabel>
									</div>
									<div className="space-y-1">
										{items.map((item) => (
											<SnippetRow
												key={item.id}
												item={item}
												active={item.id === selectedId}
												checked={multiSelect ? selectedIds.has(item.id) : undefined}
												onSelect={() => (multiSelect ? toggleSelected(item.id) : selectSnippet(item.id))}
												onContextMenu={(event) => openMenu(event, { kind: "snippet", item })}
											/>
										))}
									</div>
								</div>
							))
						)}
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

						<ShortkeyField
							value={draft.shortkey}
							others={library.filter((item) => item.id !== draft.id)}
							onChange={(shortkey) => setDraft((prev) => (prev ? { ...prev, shortkey } : prev))}
						/>
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

			{menu && (
				<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label={menu.kind === "group" ? "分组菜单" : "片段菜单"}>
					{menu.kind === "group" ? (
						<>
							<MenuItem icon="icon-[lucide--folder-open]" label="打开" onClick={() => (setGroup(menu.group), setMenu(null))} />
							<MenuItem
								icon="icon-[lucide--download]"
								label="导出脚本包"
								disabled={!library.some((item) => item.group === menu.group)}
								onClick={() => {
									setMenu(null);
									void exportSnippets(
										library.filter((item) => item.group === menu.group),
										menu.group,
									);
								}}
							/>
							<MenuItem icon="icon-[lucide--pencil]" label="重命名" onClick={() => (setRenameGroup(menu.group), setMenu(null))} />
							<MenuItem icon="icon-[lucide--trash-2]" label="删除" danger onClick={() => (setDeleteGroup(menu.group), setMenu(null))} />
						</>
					) : (
						<>
							<MenuItem
								icon="icon-[lucide--play]"
								label="运行"
								disabled={!hasSessions}
								onClick={() => {
									setMenu(null);
									runSnippet(menu.item);
								}}
							/>
							<MenuSeparator />
							<MenuItem icon="icon-[lucide--edit-3]" label="编辑" onClick={() => (openEdit(menu.item), setMenu(null))} />
							<MenuItem icon="icon-[lucide--copy]" label="复制" onClick={() => (copySnippet(menu.item), setMenu(null))} />
							<MenuItem
								icon="icon-[lucide--download]"
								label="导出代码片段"
								onClick={() => {
									setMenu(null);
									void exportSnippets([menu.item], menu.item.name);
								}}
							/>
							<MenuItem icon="icon-[lucide--trash-2]" label="删除" danger onClick={() => (setDeleteSnippet(menu.item), setMenu(null))} />
						</>
					)}
				</ContextMenu>
			)}

			<PromptModal
				open={renameGroup !== null}
				title="重命名分组"
				label={renameGroup ? `当前名称：${renameGroup}` : undefined}
				placeholder="输入新名称"
				initialValue={renameGroup ?? ""}
				validate={(value) => {
					const v = value.trim();
					if (!v) return "分组名称不能为空";
					if (v !== renameGroup && groups.includes(v)) return "已存在同名的分组";
					return null;
				}}
				onClose={() => setRenameGroup(null)}
				onSubmit={(value) => renameGroup && doRenameGroup(renameGroup, value)}
			/>

			<Modal
				open={deleteGroup !== null}
				onClose={() => setDeleteGroup(null)}
				title={`删除“${deleteGroup ?? ""}”？`}
				icon="icon-[lucide--trash-2]"
				width={420}
				footer={
					<>
						<Button size="sm" onClick={() => setDeleteGroup(null)}>
							取消
						</Button>
						<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={() => deleteGroup && doDeleteGroup(deleteGroup)}>
							删除
						</Button>
					</>
				}
			>
				<p>这会删除分组，组内片段会保留，并移到「默认」分组。</p>
			</Modal>

			<Modal
				open={deleteSnippet !== null}
				onClose={() => setDeleteSnippet(null)}
				title="删除命令片段"
				icon="icon-[lucide--trash-2]"
				width={420}
				footer={
					<>
						<Button size="sm" onClick={() => setDeleteSnippet(null)}>
							取消
						</Button>
						<Button
							size="sm"
							variant="danger"
							icon="icon-[lucide--trash-2]"
							onClick={() => {
								if (!deleteSnippet) return;
								removeSnippet(deleteSnippet.id);
								setSelectedId((id) => (id === deleteSnippet.id ? "" : id));
								toast({ title: `已删除片段 ${deleteSnippet.name}`, tone: "default" });
								setDeleteSnippet(null);
							}}
						>
							删除
						</Button>
					</>
				}
			>
				<p>
					将删除片段 <span className="font-mono text-surface-foreground">{deleteSnippet?.name ?? "—"}</span>
					，删除后无法恢复。
				</p>
			</Modal>

			<Modal
				open={pendingImport !== null}
				onClose={() => setPendingImport(null)}
				title="导入片段"
				icon="icon-[lucide--upload]"
				width={420}
				footer={
					<>
						<Button size="sm" onClick={() => setPendingImport(null)}>
							取消
						</Button>
						<Button size="sm" onClick={() => pendingImport && applyImport(pendingImport.payload, "skip")}>
							跳过重复
						</Button>
						<Button size="sm" variant="primary" onClick={() => pendingImport && applyImport(pendingImport.payload, "overwrite")}>
							覆盖重复
						</Button>
					</>
				}
			>
				<p>
					文件里有 {pendingImport?.payload.snippets.length ?? 0} 个片段，其中 {pendingImport?.conflicts ?? 0}{" "}
					个与现有片段的命令相同。选择跳过还是覆盖这些重复项。
				</p>
			</Modal>
			<Modal
				open={bulkDelete !== null}
				onClose={() => setBulkDelete(null)}
				title={`删除选中的 ${bulkDelete?.length ?? 0} 项？`}
				icon="icon-[lucide--trash-2]"
				width={420}
				footer={
					<>
						<Button size="sm" onClick={() => setBulkDelete(null)}>
							取消
						</Button>
						<Button size="sm" variant="danger" icon="icon-[lucide--trash-2]" onClick={confirmBulkDelete}>
							删除
						</Button>
					</>
				}
			>
				<p>所选项目将被永久删除，此操作无法撤销。</p>
			</Modal>

			<ShellHistoryDrawer open={historyOpen} onClose={() => setHistoryOpen(false)} onSaveAsSnippet={(entry, label) => saveHistoryAsSnippet(entry.command, label)} />
		</WindowChrome>
	);
}

/** 左侧片段行：名称 + 命令预览 + 变量个数 */
function SnippetRow({
	item,
	active,
	checked,
	onSelect,
	onContextMenu,
}: {
	item: Snippet;
	active: boolean;
	/** 多选模式下的勾选状态；undefined = 不在多选模式 */
	checked?: boolean;
	onSelect: () => void;
	onContextMenu: (event: ReactMouseEvent) => void;
}) {
	return (
		<button
			type="button"
			onClick={onSelect}
			onContextMenu={onContextMenu}
			className={cn(
				"w-full rounded-control border p-2 text-left transition-colors cursor-pointer",
				active ? "border-accent/40 bg-accent/10 shadow-xs" : "border-transparent hover:border-border hover:bg-surface-raised",
			)}
		>
			<div className="flex items-center gap-2">
				{checked !== undefined && (
					<span className={cn("size-3.5 shrink-0", checked ? "icon-[lucide--square-check] text-primary" : "icon-[lucide--square] text-faint")} />
				)}
				<span className="min-w-0 flex-1 truncate text-[12px] font-medium text-surface-foreground">{item.name}</span>
				{item.shortkey && <span className="shrink-0 rounded bg-surface-raised px-1 font-mono text-[9.5px] text-muted">{item.shortkey}</span>}
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
