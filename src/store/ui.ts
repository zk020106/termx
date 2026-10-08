import { create } from "zustand";
import type { ActivityId } from "@/components/chrome/activities";

export type RightPanelTab = "monitor" | "snippets" | "ai";

interface UiState {
	/** 侧边面板（活动栏对应的内容区） */
	sidebarOpen: boolean;
	sidebarWidth: number;
	/** 工具面板页签（/monitor 右栏：监控 / 片段 / AI） */
	rightPanelTab: RightPanelTab;
	/** 底部内嵌 SFTP 面板（附着当前连接） */
	embeddedSftpOpen: boolean;
	/** 命令面板浮层 */
	paletteOpen: boolean;
	/** 上次点击的活动栏项，供 /workspace 侧栏切换内容 */
	activity: ActivityId;

	toggleSidebar: () => void;
	setSidebarWidth: (width: number) => void;
	setRightPanelTab: (tab: RightPanelTab) => void;
	toggleEmbeddedSftp: () => void;
	setPaletteOpen: (open: boolean) => void;
	setActivity: (activity: ActivityId) => void;
}

export const useUiStore = create<UiState>((set) => ({
	sidebarOpen: true,
	sidebarWidth: 260,
	rightPanelTab: "monitor",
	embeddedSftpOpen: true,
	paletteOpen: false,
	activity: "hosts",

	toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
	setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
	setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
	toggleEmbeddedSftp: () => set((s) => ({ embeddedSftpOpen: !s.embeddedSftpOpen })),
	setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
	setActivity: (activity) => set({ activity }),
}));
