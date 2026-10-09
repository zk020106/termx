import { matchHotkey, shouldSkipHotkeyForTarget } from "@/lib/hotkeys";
import { ActivityBar } from "@/components/chrome/ActivityBar";
import { CommandPalette } from "@/components/chrome/CommandPalette";
import { StatusBar } from "@/components/chrome/StatusBar";
import { TitleBar } from "@/components/chrome/TitleBar";
import { AuthPromptHost } from "@/components/ssh/AuthPromptHost";
import { TransferConflictHost } from "@/components/transfer/TransferConflictHost";
import { Toaster } from "@/components/ui/Overlay";
import { useScreenActive } from "@/lib/screenActive";
import { useUiStore } from "@/store/ui";
import { useEffect, type ReactNode } from "react";
import { useLocation, useNavigate } from "react-router";

/* 应用外壳（需求书 04）：标题栏 + 活动栏 + 内容区 + 状态栏。
 * 抽屉与模态框用 absolute 定位，所以根节点必须是定位上下文（relative）。 */

export function WindowChrome({ children }: { children: ReactNode }) {
	// 常驻但当前隐藏的工作区不响应全局快捷键、不叠第二份面板与通知
	const active = useScreenActive();
	useGlobalShortcuts(active);
	// /palette 路由自带一个打开状态的命令面板，这里不能再叠一个全局浮层
	const onPaletteRoute = useLocation().pathname.startsWith("/palette");

	return (
		<div className="relative flex h-full flex-col overflow-hidden bg-surface text-surface-foreground antialiased">
			<TitleBar />
			<div className="flex min-h-0 flex-1">
				<ActivityBar />
				<div className="flex min-w-0 flex-1 flex-col">{children}</div>
			</div>
			<StatusBar />
			{active && !onPaletteRoute && <CommandPalette />}
			{active && <AuthPromptHost />}
			{active && <TransferConflictHost />}
			{active && <Toaster />}
		</div>
	);
}

/**
 * 应用级快捷键（Netcatty AppHandlers 的 commandPalette / quickSwitch / openSettings /
 * toggleSidePanel / portForwarding / snippets）。键位来自 设置 → 快捷键。
 * 标签与分屏类动作由工作区自己处理。
 */
function useGlobalShortcuts(active: boolean) {
	const navigate = useNavigate();
	const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

	useEffect(() => {
		if (!active) return;
		const onKey = (e: KeyboardEvent) => {
			const binding = matchHotkey(e);
			if (!binding || shouldSkipHotkeyForTarget(e, binding)) return;
			const ui = useUiStore.getState();
			switch (binding.action) {
				case "commandPalette":
				case "quickSwitch":
					setPaletteOpen(true);
					break;
				case "openSettings":
					navigate("/settings");
					break;
				case "toggleSidePanel":
					ui.toggleSidebar();
					break;
				case "portForwarding":
					navigate("/forward");
					break;
				case "snippets":
					navigate("/snippets");
					break;
				default:
					return;
			}
			e.preventDefault();
			e.stopPropagation();
		};

		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [navigate, setPaletteOpen, active]);
}
