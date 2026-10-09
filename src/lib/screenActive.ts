import { createContext, useContext } from "react";

/* 工作区常驻（切到别的界面时只隐藏、不卸载，终端与分屏布局原样保留）。
 * 隐藏期间它仍然挂着，所以全局快捷键、命令面板、通知、状态栏轮询这些「整页只该有一份」
 * 的东西必须知道自己当前是否可见，否则会和正在显示的界面各响应一次。 */
export const ScreenActiveContext = createContext(true);

export function useScreenActive(): boolean {
	return useContext(ScreenActiveContext);
}
