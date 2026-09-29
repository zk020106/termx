import { create } from "zustand";
import type { ActivityId } from "@/components/chrome/activities";

export type RightPanelTab = "monitor" | "snippets" | "ai";

interface UiState {
	/** 侧边面板（活动栏对应的内容区） */
	sidebarOpen: boolean;
	sidebarWidth: number;
	/** 右侧工具面板，默认收起（需求书 04-⑦） */
	rightPanelOpen: boolean;
	rightPanelTab: RightPanelTab;
	/** 底部内嵌 SFTP 面板（附着当前连接） */
	embeddedSftpOpen: boolean;
	/** 命令面板浮层 */
	paletteOpen: boolean;
	/** 上次点击的活动栏项，供 /workspace 侧栏切换内容 */
	activity: ActivityId;

	toggleSidebar: () => void;
	setSidebarWidth: (width: number) => void;
	toggleRightPanel: (tab?: RightPanelTab) => void;
	setRightPanelTab: (tab: RightPanelTab) => void;
	toggleEmbeddedSftp: () => void;
	setPaletteOpen: (open: boolean) => void;
	setActivity: (activity: ActivityId) => void;
}

export const useUiStore = create<UiState>((set) => ({
	sidebarOpen: true,
	sidebarWidth: 260,
	rightPanelOpen: false,
	rightPanelTab: "monitor",
	embeddedSftpOpen: true,
	paletteOpen: false,
	activity: "hosts",

	toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
	setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
	toggleRightPanel: (tab) =>
		set((s) => ({
			rightPanelOpen: tab ? (s.rightPanelOpen && s.rightPanelTab === tab ? false : true) : !s.rightPanelOpen,
			rightPanelTab: tab ?? s.rightPanelTab,
		})),
	setRightPanelTab: (rightPanelTab) => set({ rightPanelTab, rightPanelOpen: true }),
	toggleEmbeddedSftp: () => set((s) => ({ embeddedSftpOpen: !s.embeddedSftpOpen })),
	setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
	setActivity: (activity) => set({ activity }),
}));
