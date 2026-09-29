import type { TerminalLine } from "@/data/types";
import { fg, type TerminalPalette } from "./terminalTheme";

/* =============================================================================
 * 演示模式内容。
 *
 * 浏览器里 spawnLocalShell() 返回 null（没有 Rust 壳），Terminal 会把
 * @/data/mock 里 terminalPanes 的 lines 逐行按 kind 上色打印；本文件提供
 * 「按 kind 上色」的规则，以及分屏格需要的补充画面（htop / 发布 / 本地 shell）。
 * ========================================================================== */

export type DemoVariant = "auto" | "log" | "htop" | "deploy" | "shell";

/** 一行终端输出 → 带 ANSI 颜色的字符串（颜色全部来自设计 token） */
export function renderLine(line: TerminalLine, palette: TerminalPalette): string {
	const text = line.text;
	switch (line.kind) {
		case "input": {
			const at = splitPrompt(text);
			if (at < 0) return fg(palette.foreground, text);
			return fg(palette.primary, text.slice(0, at)) + fg(palette.foreground, text.slice(at));
		}
		case "plain":
			return fg(palette.muted, text);
		default: {
			// INFO / WARN / ERROR 级别词按语义上色，其余正文用静音色
			const tone = line.kind === "warn" ? palette.warning : line.kind === "error" ? palette.danger : palette.success;
			const match = /^([A-Z]{3,6})(\s|$)/.exec(text);
			if (!match) return fg(tone, text);
			return fg(tone, match[1]) + fg(palette.muted, text.slice(match[1].length));
		}
	}
}

/** 找到提示符结束的位置（"~$ " / "> " 之后），用于区分提示符与命令 */ 
function splitPrompt(text: string): number {
	const dollar = text.indexOf("$ ");
	if (dollar >= 0) return dollar + 2;
	const angle = text.indexOf("> ");
	if (angle >= 0 && angle < 30) return angle + 2;
	return -1;
}

/** 补充分屏格的画面：按 mock 里的 subtitle 推断，默认是日志会话 */
export function resolveVariant(subtitle: string | undefined, fallback: DemoVariant = "log"): DemoVariant {
	if (!subtitle) return fallback;
	if (subtitle.includes("htop")) return "htop";
	return fallback;
}

/** 提示符：mock 里 title 就是 "deploy@order-api-01:~$" */
export function promptFor(title: string | undefined, variant: DemoVariant): string {
	if (variant === "shell") return "PS C:\\Users\\suantian>";
	const text = title?.trim();
	if (!text) return "deploy@order-api-01:~$";
	return text;
}

/** 登录横幅：新开的分屏格没有预置输出时打印，避免空白 */
export const SESSION_BANNER: TerminalLine[] = [
	{ kind: "plain", text: "Welcome to Ubuntu 22.04.3 LTS (GNU/Linux 5.15.0-89-generic x86_64)" },
	{ kind: "plain", text: "Last login: Thu Sep 24 16:41:02 2026 from 10.0.0.4" },
];

const DEPLOY_LINES: TerminalLine[] = [
	{ kind: "input", text: "deploy@order-api-01:~$ ./release.sh 1.8.2 --canary" },
	{ kind: "info", text: "INFO 拉取制品 release-1.8.2.tar.gz（86.4 MB）" },
	{ kind: "info", text: "INFO 校验 SHA256 … 通过" },
	{ kind: "warn", text: "WARN order-api-02 仍有 3 个长连接，等待 5s 再摘流" },
	{ kind: "info", text: "INFO 摘流 → 重启 → 回挂 order-api-01，用时 8.4s" },
	{ kind: "ok", text: "INFO 健康检查 /actuator/health → UP" },
];

const SHELL_LINES: TerminalLine[] = [
	{ kind: "input", text: "PS C:\\Users\\suantian> git -C IdeaProjects\\termx status -sb" },
	{ kind: "plain", text: "## main...origin/main" },
	{ kind: "plain", text: " M src/screens/Workspace.tsx" },
	{ kind: "plain", text: "?? src/components/terminal/" },
	{ kind: "input", text: "PS C:\\Users\\suantian> pnpm exec tsc --noEmit" },
	{ kind: "ok", text: "OK 0 errors" },
];

/** htop 风格画面：数值与 termx.vetd/frames/index.tsx 的副分屏格一致 */
function htopScreen(palette: TerminalPalette): string[] {
	const bar = (percent: number, color: string, cells = 26): string => {
		const filled = Math.max(0, Math.min(cells, Math.round((percent / 100) * cells)));
		return fg(color, "|".repeat(filled)) + " ".repeat(cells - filled);
	};
	const rows: [string, string, string][] = [
		["1842", "java -jar order-api.jar", "18.4"],
		["902", "redis-server 10.0.8.40:6379", "4.1"],
		["1104", "nginx: worker process", "1.2"],
		["2411", "node_exporter --collector.systemd", "0.6"],
	];

	return [
		"",
		`${fg(palette.muted, "CPU[")}${bar(42.4, palette.primary)}${fg(palette.muted, " 42.4%]")}  ${fg(palette.faint, "Tasks: 128, 412 thr; 2 running")}`,
		`${fg(palette.muted, "Mem[")}${bar(38.7, palette.accent)}${fg(palette.muted, "  3.10/8.00G]")}  ${fg(palette.faint, "Load average: 1.84 1.75 1.62")}`,
		`${fg(palette.muted, "Swp[")}${bar(0, palette.border)}${fg(palette.muted, "  0.00/2.00G]")}  ${fg(palette.faint, "Uptime: 41 days, 6 hours")}`,
		"",
		`${fg(palette.faint, "  PID USER      PRI  NI  VIRT   RES S  CPU%  MEM%   TIME+  Command")}`,
		...rows.map(
			([pid, command, cpu]) =>
				`${fg(palette.faint, pid.padStart(5))} ${fg(palette.muted, "deploy")}     ${fg(palette.faint, "20   0")} ${fg(palette.muted, "4.21g 1.82g")} ${fg(palette.faint, "S")} ${fg(palette.primary, cpu.padStart(5))}  ${fg(palette.muted, " 12.1")}  ${fg(palette.muted, " 4:32.18")}  ${fg(palette.foreground, command)}`,
		),
		"",
		`${fg(palette.primary, "F1")}${fg(palette.faint, "Help  ")}${fg(palette.primary, "F2")}${fg(palette.faint, "Setup ")}${fg(palette.primary, "F3")}${fg(palette.faint, "Search ")}${fg(palette.primary, "F10")}${fg(palette.faint, "Quit")}`,
	];
}

/** 预置输出之后的补充画面 */
export function extraScreen(variant: DemoVariant, palette: TerminalPalette): string[] {
	switch (variant) {
		case "htop":
			return htopScreen(palette);
		case "deploy":
			return DEPLOY_LINES.map((line) => renderLine(line, palette));
		case "shell":
			return SHELL_LINES.map((line) => renderLine(line, palette));
		default:
			return [];
	}
}
