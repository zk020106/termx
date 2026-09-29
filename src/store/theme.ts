import { create } from "zustand";
import type { Density, ThemeMode } from "@/data/types";

const THEME_KEY = "termx.theme";
const DENSITY_KEY = "termx.density";

type Resolved = "dark" | "light";

function systemResolved(): Resolved {
	return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: light)").matches
		? "light"
		: "dark";
}

function resolveMode(mode: ThemeMode): Resolved {
	return mode === "system" ? systemResolved() : mode;
}

/** 主题属性必须写回 <html>，--color-* 的 var 引用才会解析到正确主题 */
function applyTheme(mode: ThemeMode): Resolved {
	const resolved = resolveMode(mode);
	if (typeof document !== "undefined") {
		document.documentElement.dataset.theme = resolved;
	}
	return resolved;
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
	setMode: (mode: ThemeMode) => void;
	setDensity: (density: Density) => void;
}

const initialMode = readStored<ThemeMode>(THEME_KEY, ["dark", "light", "system"], "dark");

export const useThemeStore = create<ThemeState>((set) => ({
	mode: initialMode,
	resolved: applyTheme(initialMode),
	density: readStored<Density>(DENSITY_KEY, ["compact", "standard"], "standard"),

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
