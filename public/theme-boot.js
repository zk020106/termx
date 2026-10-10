// 首屏前应用主题，避免闪白（与 src/store/theme.ts 共用同一 key）。
// 独立成文件而不是内联脚本：CSP 的 script-src 只放行 'self'，内联脚本会被拦下。
try {
	var mode = localStorage.getItem("termx.theme") || "dark";
	var resolved =
		mode === "system" ? (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark") : mode;
	document.documentElement.dataset.theme = resolved;
	var accent = localStorage.getItem("termx.accent") || "vercel";
	document.documentElement.dataset.accent = accent;
} catch (e) {
	/* 忽略：保持默认 dark & vercel */
}
