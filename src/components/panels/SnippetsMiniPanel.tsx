import { EmptyState, SectionLabel } from "@/components/ui/Display";
import { useSnippetsStore } from "@/store/snippets";
import { toast } from "@/store/toast";
import { useState } from "react";

/* 右侧工具面板里的命令片段速用条：不离开工作区就能发一条常用命令。
 * 数据来自用户自己的片段库（useSnippetsStore，自动落盘）。
 * 完整管理（增删改、变量填写、目标选择）在 /snippets 界面。 */

export function SnippetsMiniPanel({ hostName }: { hostName?: string }) {
	const snippets = useSnippetsStore((s) => s.snippets);
	const [query, setQuery] = useState("");

	if (snippets.length === 0) {
		return (
			<div className="flex min-h-0 flex-1 flex-col">
				<EmptyState icon="icon-[lucide--square-terminal]" title="还没有命令片段" />
			</div>
		);
	}

	const q = query.trim().toLowerCase();
	const matched = q
		? snippets.filter((s) => [s.name, s.command, s.group].some((f) => f.toLowerCase().includes(q)))
		: snippets;
	const groups = [...new Set(matched.map((s) => s.group))];

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="border-b border-border p-2">
				<input
					value={query}
					onChange={(e) => setQuery(e.target.value)}
					placeholder="搜索片段…"
					className="h-6.5 w-full rounded-control border border-border bg-surface px-2 text-[11px] text-surface-foreground placeholder:text-faint focus:border-primary/60 focus:outline-none"
				/>
			</div>

			<div className="min-h-0 flex-1 overflow-y-auto p-2">
				{matched.length === 0 ? (
					<EmptyState icon="icon-[lucide--search-x]" title="没有匹配的片段" />
				) : (
					groups.map((group) => (
						<div key={group} className="mb-2">
							<SectionLabel className="px-1">{group}</SectionLabel>
							<div className="space-y-0.5">
								{matched
									.filter((s) => s.group === group)
									.map((s) => (
										<button
											key={s.id}
											type="button"
											onClick={() =>
												toast({
													title: `已发送：${s.name}`,
													description: `${hostName ?? "当前终端"} · ${s.variables.length > 0 ? `需要填写 ${s.variables.length} 个变量` : "无变量"}`,
												})
											}
											className="group flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left transition-colors hover:bg-surface-raised"
										>
											<span className="flex items-center gap-1.5">
												<span className="icon-[lucide--terminal] size-3 shrink-0 text-muted group-hover:text-primary" />
												<span className="truncate text-[11.5px] text-surface-foreground">{s.name}</span>
												{s.variables.length > 0 && (
													<span className="ml-auto shrink-0 font-mono text-[9.5px] text-faint">
														${"{…}"}
													</span>
												)}
											</span>
											<span className="truncate font-mono text-[10px] text-faint">{s.command}</span>
										</button>
									))}
							</div>
						</div>
					))
				)}
			</div>
		</div>
	);
}
