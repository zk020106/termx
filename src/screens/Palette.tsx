import { CommandPalettePanel } from "@/components/chrome/CommandPalette";
import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { useState } from "react";
import { useSearchParams } from "react-router";

/* 命令面板（对应 termx.vetd/frames/palette.tsx，需求书 06）。
 * 真实入口是 Ctrl+K 触发的 src/components/chrome/CommandPalette.tsx；
 * 本路由用于设计稿比对：渲染「工作区背景 + 打开状态的命令面板」的完整画面，
 * 右下角是骨架期评审用的状态切换器（也支持 ?state=recent|search|command|empty 深链）。 */

const STATES = [
	{ value: "search", label: "搜索分组", query: "order", hint: "结果按主机 / 命令 / 设置分组" },
	{ value: "recent", label: "最近使用", query: "", hint: "空输入时默认展示最近使用" },
	{ value: "command", label: "只搜命令", query: ">", hint: "> 前缀只搜命令片段" },
	{ value: "empty", label: "无结果", query: "redis-cluster", hint: "搜索无结果态" },
	{ value: "multi", label: "多分组", query: "s", hint: "同一关键词同时命中主机与命令两组（mock 数据下能同时命中多组的关键词有限）" },
] as const;

type PaletteState = (typeof STATES)[number]["value"];

export default function Palette() {
	const [search] = useSearchParams();
	const [state, setState] = useState<PaletteState>(() => {
		const fromUrl = search.get("state");
		return STATES.some((s) => s.value === fromUrl) ? (fromUrl as PaletteState) : "search";
	});
	const [open, setOpen] = useState(true);

	const active = STATES.find((s) => s.value === state) ?? STATES[0];

	return (
		<WindowChrome>
			{/* 工作区背景：终端底色被遮罩压暗，与设计帧一致 */}
			<div className="relative flex min-h-0 flex-1 flex-col items-center justify-start bg-term/90 p-4">
				{open ? (
					// key 让切换状态时重新挂载面板，输入框回到该状态的初始查询；
					// 这里的面板挂在内容区（标题栏之下），所以顶部留白比全局浮层略小
					<CommandPalettePanel
						key={state}
						initialQuery={active.query}
						onClose={() => setOpen(false)}
						className="pt-[7.5vh]"
					/>
				) : (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-term-ink/70">
						<span className="icon-[lucide--command] size-6" />
						<span className="text-[12px]">命令面板已关闭，可按 Ctrl+K 重新打开</span>
						<Button size="sm" icon="icon-[lucide--command]" onClick={() => setOpen(true)} className="mt-1">
							重新打开面板
						</Button>
					</div>
				)}

				{/* 状态切换器（骨架期评审工具） */}
				<div className="absolute bottom-3 right-3 z-20 flex items-center gap-1.5 rounded-control border border-border bg-surface-raised/95 px-2 py-1 shadow-lg">
					<span className="font-mono text-[9px] tracking-wider text-faint uppercase">状态</span>
					{STATES.map((option) => (
						<button
							key={option.value}
							type="button"
							title={option.hint}
							onClick={() => {
								setState(option.value);
								setOpen(true);
							}}
							className={cn(
								"rounded px-1.5 py-0.5 text-[10.5px] transition-colors",
								option.value === state && open
									? "border border-border bg-surface font-medium text-surface-foreground"
									: "text-muted hover:text-surface-foreground",
							)}
						>
							{option.label}
						</button>
					))}
				</div>
			</div>
		</WindowChrome>
	);
}
