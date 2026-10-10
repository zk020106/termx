import { create } from "zustand";
import type { ActivityId } from "@/components/chrome/activities";

export type RightPanelTab = "monitor" | "snippets" | "ai";
export type CompanionTab = "sftp" | "forward" | "snippets" | "monitor";

interface UiState {
	/** 侧边面板（活动栏对应的内容区） */
	sidebarOpen: boolean;
	sidebarWidth: number;
	/** 工具面板页签（/monitor 右栏：监控 / 片段 / AI） */
	rightPanelTab: RightPanelTab;
	/** 底部/右侧内嵌 SFTP 面板（附着当前连接，保留兼容） */
	embeddedSftpOpen: boolean;
	/** 一体化会话流体伴随面板 (Companion Dock) */
	companionOpen: boolean;
	companionTab: CompanionTab;
	companionWidth: number;
	/** 命令面板浮层 */
	paletteOpen: boolean;
	/** 上次点击的活动栏项，供 /workspace 侧栏切换内容 */
	activity: ActivityId;

	toggleSidebar: () => void;
	setSidebarOpen: (open: boolean) => void;
	setSidebarWidth: (width: number) => void;
	setRightPanelTab: (tab: RightPanelTab) => void;
	toggleEmbeddedSftp: () => void;
	setCompanionOpen: (open: boolean) => void;
	setCompanionTab: (tab: CompanionTab) => void;
	setCompanionWidth: (width: number) => void;
	toggleCompanion: (tab?: CompanionTab) => void;
	setPaletteOpen: (open: boolean) => void;
	setActivity: (activity: ActivityId) => void;
}

export const useUiStore = create<UiState>((set) => ({
	sidebarOpen: true,
	sidebarWidth: 260,
	rightPanelTab: "monitor",
	embeddedSftpOpen: false,
	companionOpen: false,
	companionTab: "sftp",
	companionWidth: 380,
	paletteOpen: false,
	activity: "hosts",

	toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
	setSidebarOpen: (sidebarOpen) => set({ sidebarOpen }),
	setSidebarWidth: (sidebarWidth) => set({ sidebarWidth }),
	setRightPanelTab: (rightPanelTab) => set({ rightPanelTab }),
	toggleEmbeddedSftp: () =>
		set((s) => {
			const next = !s.companionOpen || s.companionTab !== "sftp";
			return {
				embeddedSftpOpen: next,
				companionOpen: next,
				companionTab: "sftp",
			};
		}),
	setCompanionOpen: (companionOpen) => set({ companionOpen, embeddedSftpOpen: companionOpen }),
	setCompanionTab: (companionTab) => set({ companionTab, companionOpen: true, embeddedSftpOpen: companionTab === "sftp" }),
	setCompanionWidth: (companionWidth) => set({ companionWidth }),
	toggleCompanion: (tab) =>
		set((s) => {
			if (!tab) {
				const nextOpen = !s.companionOpen;
				return { companionOpen: nextOpen, embeddedSftpOpen: nextOpen && s.companionTab === "sftp" };
			}
			if (s.companionOpen && s.companionTab === tab) {
				return { companionOpen: false, embeddedSftpOpen: false };
			}
			return {
				companionOpen: true,
				companionTab: tab,
				embeddedSftpOpen: tab === "sftp",
			};
		}),
	setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
	setActivity: (activity) => set({ activity }),
}));
