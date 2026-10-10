import { create } from "zustand";
import type { Accent, Density, ThemeMode } from "@/data/types";

const THEME_KEY = "termx.theme";
const DENSITY_KEY = "termx.density";
const ACCENT_KEY = "termx.accent";

type Resolved = "dark" | "light";

function systemResolved(): Resolved {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

function resolveMode(mode: ThemeMode): Resolved {
	return mode === "system" ? systemResolved() : mode;
}

/** 规范：主题与强调色切换时抑制所有过渡，防止全局颜色插值涂抹 */
function withDisabledTransitions(fn: () => void): void {
	if (typeof document === "undefined") {
		fn();
		return;
	}
	const style = document.createElement("style");
	style.append(
		document.createTextNode("*,*::before,*::after{transition:none !important}"),
	);
	document.head.append(style);

	fn();

	// 强制同步样式重排，确保新主题变量立即解析后再恢复 transition
	if (document.body) {
		void document.body.offsetHeight;
	}

	requestAnimationFrame(() => {
		requestAnimationFrame(() => {
			style.remove();
		});
	});
}

/** 主题属性必须写回 <html>，--color-* 的 var 引用才会解析到正确主题 */
function applyTheme(mode: ThemeMode, suppressTransitions = true): Resolved {
	const resolved = resolveMode(mode);
	if (typeof document !== "undefined") {
		if (suppressTransitions) {
			withDisabledTransitions(() => {
				document.documentElement.dataset.theme = resolved;
			});
		} else {
			document.documentElement.dataset.theme = resolved;
		}
	}
	return resolved;
}

/** 强调色同样挂在 <html>：theme.css 按 data-accent 把 --tx-accent 指向对应色板 */
function applyAccent(accent: Accent, suppressTransitions = true): void {
	if (typeof document !== "undefined") {
		if (suppressTransitions) {
			withDisabledTransitions(() => {
				document.documentElement.dataset.accent = accent;
			});
		} else {
			document.documentElement.dataset.accent = accent;
		}
	}
}

function readStored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
	try {
		const raw = localStorage.getItem(key) as T | null;
		return raw && allowed.includes(raw) ? raw : fallback;
	} catch {
		return fallback;
	}
}

interface ThemeState {
	mode: ThemeMode;
	resolved: Resolved;
	density: Density;
	accent: Accent;
	setMode: (mode: ThemeMode) => void;
	setDensity: (density: Density) => void;
	setAccent: (accent: Accent) => void;
}

const initialMode = readStored<ThemeMode>(THEME_KEY, ["dark", "light", "system"], "dark");
const initialAccent = readStored<Accent>(ACCENT_KEY, ["vercel", "indigo", "cyan", "emerald", "amber", "rose", "steel"], "vercel");
applyAccent(initialAccent, false);

export const useThemeStore = create<ThemeState>((set) => ({
	mode: initialMode,
	resolved: applyTheme(initialMode, false),
	density: readStored<Density>(DENSITY_KEY, ["compact", "standard"], "standard"),
	accent: initialAccent,

	setMode: (mode) => {
		const resolved = applyTheme(mode);
		try {
			localStorage.setItem(THEME_KEY, mode);
		} catch {
			/* 忽略：无持久化权限时仅当前会话生效 */
		}
		set({ mode, resolved });
	},

	setDensity: (density) => {
		try {
			localStorage.setItem(DENSITY_KEY, density);
		} catch {
			/* 同上 */
		}
		document.documentElement.dataset.density = density;
		set({ density });
	},

	/** 强调色入配置文件与本地存储，改 <html> 即全界面即时生效 */
	setAccent: (accent) => {
		applyAccent(accent);
		try {
			localStorage.setItem(ACCENT_KEY, accent);
		} catch {
			/* 忽略 */
		}
		set({ accent });
	},
}));

// 跟随系统：监听偏好变化，但仅在 mode === "system" 时生效
if (typeof window !== "undefined") {
	const mq = window.matchMedia("(prefers-color-scheme: light)");
	mq.addEventListener("change", () => {
		const { mode } = useThemeStore.getState();
		if (mode === "system") {
			useThemeStore.setState({ resolved: applyTheme("system") });
		}
	});
}
