import { CommandPalettePanel } from "@/components/chrome/CommandPalette";
import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button } from "@/components/ui/Button";
import { useState } from "react";
import { useSearchParams } from "react-router";

/* 命令面板（对应 termx.vetd/frames/palette.tsx，需求书 06）。
 * 真实入口是 Ctrl+K 触发的 src/components/chrome/CommandPalette.tsx；
 * 本路由用于设计稿比对：渲染「工作区背景 + 打开状态的命令面板」的完整画面。 */

const STATES = [
	{ value: "search", label: "搜索分组", query: "order", hint: "结果按主机 / 命令 / 设置分组" },
	{ value: "recent", label: "最近使用", query: "", hint: "空输入时默认展示最近使用" },
	{ value: "command", label: "只搜命令", query: ">", hint: "> 前缀只搜命令片段" },
	{ value: "empty", label: "无结果", query: "redis-cluster", hint: "搜索无结果态" },
	{ value: "multi", label: "多分组", query: "s", hint: "同一关键词同时命中主机与命令两组" },
] as const;

type PaletteState = (typeof STATES)[number]["value"];

export default function Palette() {
	const [search] = useSearchParams();
	const [state] = useState<PaletteState>(() => {
		const fromUrl = search.get("state");
		return STATES.some((s) => s.value === fromUrl) ? (fromUrl as PaletteState) : "search";
	});
	const [open, setOpen] = useState(true);

	const active = STATES.find((s) => s.value === state) ?? STATES[0];

	return (
		<WindowChrome>
			{/* 工作区背景：底色跟主题走，压暗交给面板自带的半透明遮罩（与全局面板一致） */}
			<div className="relative flex min-h-0 flex-1 flex-col items-center justify-start bg-surface p-4">
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
					<div className="flex h-full flex-col items-center justify-center gap-2 text-muted">
						<span className="icon-[lucide--command] size-6" />
						<span className="text-[12px]">命令面板已关闭，可按 Ctrl+K 重新打开</span>
						<Button size="sm" icon="icon-[lucide--command]" onClick={() => setOpen(true)} className="mt-1">
							重新打开面板
						</Button>
					</div>
				)}
			</div>
		</WindowChrome>
	);
}
