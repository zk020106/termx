import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import type { Host, Snippet } from "@/data/types";
import { cn } from "@/lib/cn";
import { resolveSnippetCommand } from "@/lib/snippetRun";
import { useSnippetsStore } from "@/store/snippets";
import { toast } from "@/store/toast";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

interface CompanionSnippetsProps {
	activeHost?: Host | null;
	onWriteToTerminal: (cmd: string) => void;
}

export function CompanionSnippets({ onWriteToTerminal }: CompanionSnippetsProps) {
	const navigate = useNavigate();
	const snippets = useSnippetsStore((s) => s.snippets);
	const [query, setQuery] = useState("");
	const [selectedGroup, setSelectedGroup] = useState<string>("all");

	const groups = useMemo(() => {
		const set = new Set<string>();
		for (const s of snippets) {
			if (s.group) set.add(s.group);
		}
		return Array.from(set);
	}, [snippets]);

	const filteredSnippets = useMemo(() => {
		let list = snippets;
		if (selectedGroup !== "all") {
			list = list.filter((s) => s.group === selectedGroup);
		}
		if (query.trim()) {
			const q = query.trim().toLowerCase();
			list = list.filter(
				(s) =>
					s.name.toLowerCase().includes(q) ||
					s.command.toLowerCase().includes(q) ||
					(s.description && s.description.toLowerCase().includes(q)),
			);
		}
		return list;
	}, [snippets, selectedGroup, query]);

	const handleExecute = async (snippet: Snippet, autoRun: boolean) => {
		const resolved = await resolveSnippetCommand(snippet);
		if (resolved === null) return;
		onWriteToTerminal(autoRun ? `${resolved}\r` : resolved);
		toast({
			title: autoRun ? `已在终端执行: ${snippet.name}` : `已填入光标: ${snippet.name}`,
			tone: "success",
		});
	};

	return (
		<div className="flex h-full flex-col p-3 space-y-2.5">
			{/* 顶栏与检索 */}
			<div className="flex items-center justify-between">
				<span className="text-[12px] font-semibold text-surface-foreground">命令片段库</span>
				<button
					type="button"
					onClick={() => navigate("/snippets")}
					className="flex items-center gap-1 text-[11px] text-muted hover:text-surface-foreground cursor-pointer"
					title="打开命令片段管理器"
				>
					<span className="icon-[lucide--settings-2] size-3.5" />
					<span>管理</span>
				</button>
			</div>

			<div className="relative">
				<span className="icon-[lucide--search] pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 size-3.5 text-muted" />
				<Input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索命令名称或指令…"
					className="h-7.5 pl-8 text-xs"
				/>
			</div>

			{/* 分组标签过滤 */}
			{groups.length > 0 && (
				<div className="flex flex-wrap items-center gap-1">
					<button
						type="button"
						onClick={() => setSelectedGroup("all")}
						className={cn(
							"rounded-control border px-2 py-0.5 text-[10px] transition-colors cursor-pointer",
							selectedGroup === "all"
								? "border-surface-foreground/20 bg-surface-foreground/10 text-surface-foreground font-medium"
								: "border-border/60 bg-surface/40 text-muted hover:text-surface-foreground",
						)}
					>
						全部 ({snippets.length})
					</button>
					{groups.map((grp) => (
						<button
							key={grp}
							type="button"
							onClick={() => setSelectedGroup(grp)}
							className={cn(
								"rounded-control border px-2 py-0.5 text-[10px] transition-colors cursor-pointer",
								selectedGroup === grp
									? "border-surface-foreground/20 bg-surface-foreground/10 text-surface-foreground font-medium"
									: "border-border/60 bg-surface/40 text-muted hover:text-surface-foreground",
							)}
						>
							{grp}
						</button>
					))}
				</div>
			)}

			{/* 片段卡片列表 */}
			<div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
				{filteredSnippets.length === 0 ? (
					<div className="py-12 text-center text-muted">
						<span className="icon-[lucide--code-xml] size-8 text-faint mb-2 block mx-auto" />
						<p className="text-[12px] font-medium text-surface-foreground">没有找到匹配的片段</p>
						<p className="text-[10.5px] text-muted mt-1">创建参数化片段，可在终端随时一键调用</p>
						<Button
							size="sm"
							variant="default"
							className="mt-3 text-xs"
							onClick={() => navigate("/snippets")}
						>
							新建命令片段
						</Button>
					</div>
				) : (
					filteredSnippets.map((snippet) => {
						const hasVars = snippet.variables && snippet.variables.length > 0;

						return (
							<div
								key={snippet.id}
								className="group flex flex-col gap-1.5 rounded-card border border-border/70 bg-surface/50 p-2.5 transition-colors hover:border-surface-foreground/20 hover:bg-surface-raised/60"
							>
								{/* 标题与分组 */}
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-1.5 min-w-0">
										<span className="truncate text-[12px] font-semibold text-surface-foreground">
											{snippet.name}
										</span>
										{snippet.group && (
											<span className="rounded-[4px] bg-surface-foreground/5 border border-border px-1 py-0.2 font-mono text-[9px] text-muted shrink-0">
												{snippet.group}
											</span>
										)}
									</div>

									{hasVars && (
										<span className="rounded-[4px] bg-amber-500/10 border border-amber-500/20 px-1.5 py-0.2 font-mono text-[9px] text-amber-400 shrink-0">
											{snippet.variables.length} 个参数
										</span>
									)}
								</div>

								{/* 命令预览 */}
								<div className="rounded-control bg-surface-raised border border-border/60 p-1.5 font-mono text-[11px] text-surface-foreground/90 break-all select-all leading-tight">
									{snippet.command}
								</div>

								{/* 底部一键动作按钮 */}
								<div className="flex items-center justify-end gap-1.5 pt-1">
									<button
										type="button"
										onClick={() => handleExecute(snippet, false)}
										className="flex h-6 items-center gap-1 rounded-control border border-border/70 bg-surface px-2 text-[10.5px] text-muted transition-colors hover:border-surface-foreground/20 hover:bg-surface-foreground/10 hover:text-surface-foreground cursor-pointer"
										title="填入当前终端光标，但不回车执行"
									>
										<span className="icon-[lucide--corner-down-left] size-3" />
										<span>填入光标</span>
									</button>

									<button
										type="button"
										onClick={() => handleExecute(snippet, true)}
										className="flex h-6 items-center gap-1 rounded-control border border-surface-foreground/20 bg-surface-foreground/10 px-2 text-[10.5px] font-medium text-surface-foreground transition-colors hover:bg-surface-foreground/20 cursor-pointer shadow-2xs"
										title="立即在终端执行该命令"
									>
										<span className="icon-[lucide--play] size-3 text-emerald-400" />
										<span>立即运行</span>
									</button>
								</div>
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
