import { create } from "zustand";

/* 编辑器打开的文件放在内存 store 里，而不是编辑器页面的组件 state：
 * 切到别的界面再回来（编辑器页面会卸载），未保存的修改仍然在。 */

export interface EditorFileTab {
	id: string;
	name: string;
	path: string;
	side: "remote" | "local";
	sessionKey?: string;
	content: string;
	savedContent: string;
	loading: boolean;
	saving: boolean;
	/** 打开 / 上次保存时磁盘上的修改时间（秒）；0 = 未知（不做冲突检查） */
	mtime: number;
	/** 读取失败：不显示错误文本当内容，也不允许保存（否则会把错误文本写回文件） */
	readError?: string;
}

type Updater<T> = T | ((prev: T) => T);

interface EditorStore {
	tabs: EditorFileTab[];
	activeTabId: string;
	setTabs: (next: Updater<EditorFileTab[]>) => void;
	setActiveTabId: (id: string) => void;
}

export const useEditorStore = create<EditorStore>((set) => ({
	tabs: [],
	activeTabId: "",
	setTabs: (next) => set((s) => ({ tabs: typeof next === "function" ? next(s.tabs) : next })),
	setActiveTabId: (id) => set({ activeTabId: id }),
}));

/** 有没有未保存的编辑器文件（关闭窗口前提示用） */
export function hasUnsavedEditorTabs(): boolean {
	return useEditorStore.getState().tabs.some((t) => !t.readError && t.content !== t.savedContent);
}
