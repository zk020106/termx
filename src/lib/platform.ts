/** 平台探测。TermX 以 Windows 为设计基准，但窗口控件位置按平台走：
 *  macOS 在左上（交通灯），Windows / Linux 在右上。
 *  见 docs/DECISIONS.md 的 Q3。 */

export type Platform = "windows" | "macos" | "linux";

export function detectPlatform(): Platform {
	if (typeof navigator === "undefined") return "windows";
	// navigator.platform 已废弃但仍有参考价值；userAgent 在 Tauri 里同样带平台标识
	const probe = `${navigator.userAgent} ${navigator.platform ?? ""}`.toLowerCase();
	if (probe.includes("mac")) return "macos";
	if (probe.includes("linux")) return "linux";
	return "windows";
}

/** 窗口控制按钮应该出现在标题栏的哪一侧 */
export function windowControlsSide(): "left" | "right" {
	return detectPlatform() === "macos" ? "left" : "right";
}
