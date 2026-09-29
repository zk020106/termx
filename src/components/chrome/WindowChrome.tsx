import { ActivityBar } from "@/components/chrome/ActivityBar";
import { CommandPalette } from "@/components/chrome/CommandPalette";
import { StatusBar } from "@/components/chrome/StatusBar";
import { TitleBar } from "@/components/chrome/TitleBar";
import { Toaster } from "@/components/ui/Overlay";
import { useUiStore } from "@/store/ui";
import { useEffect, type ReactNode } from "react";
import { useNavigate } from "react-router";

/* 应用外壳（需求书 04）：标题栏 + 活动栏 + 内容区 + 状态栏。
 * 抽屉与模态框用 absolute 定位，所以根节点必须是定位上下文（relative）。 */

export function WindowChrome({ children }: { children: ReactNode }) {
	useGlobalShortcuts();

	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-surface text-surface-foreground antialiased">
			<TitleBar />
			<div className="flex min-h-0 flex-1">
				<ActivityBar />
				<div className="flex min-w-0 flex-1 flex-col">{children}</div>
			</div>
			<StatusBar />
			<CommandPalette />
			<Toaster />
		</div>
	);
}

/** 全局快捷键：Ctrl+K 命令面板、Ctrl+B 侧栏、Ctrl+Shift+S SFTP 面板、Ctrl+, 设置 */
function useGlobalShortcuts() {
	const navigate = useNavigate();
	const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.ctrlKey || e.metaKey;
			if (!mod) return;

			if (!e.shiftKey && e.key.toLowerCase() === "k") {
				e.preventDefault();
				setPaletteOpen(true);
				return;
			}
			if (!e.shiftKey && e.key.toLowerCase() === "b") {
				e.preventDefault();
				useUiStore.getState().toggleSidebar();
				return;
			}
			if (e.shiftKey && e.key.toLowerCase() === "s") {
				e.preventDefault();
				useUiStore.getState().toggleEmbeddedSftp();
				return;
			}
			if (!e.shiftKey && e.key === ",") {
				e.preventDefault();
				navigate("/settings");
			}
		};

		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate, setPaletteOpen]);
}
