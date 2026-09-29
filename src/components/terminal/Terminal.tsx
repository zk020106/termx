import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { terminalPanes } from "@/data/mock";
import { attachPty, resizePty, writePty, type PtyAttachment } from "./ptyCache";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { useThemeStore } from "@/store/theme";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { extraScreen, renderLine, resolveVariant, SESSION_BANNER, type DemoVariant } from "./demoContent";
import { demoEcho } from "./demoEcho";
import { buildXtermTheme, fg, readMonoFont, readPalette } from "./terminalTheme";

/* =============================================================================
 * 终端分屏格 —— xterm 6 的 React 封装。
 *
 * - Tauri 内：spawnLocalShell() 起真实 PTY，键盘输入写回 PTY，输出直接写终端。
 * - 浏览器内：spawnLocalShell() 返回 null（没有 Rust 壳），降级为演示模式 ——
 *   把 @/data/mock 里 terminalPanes 中本格的 lines 用 renderLine 上色打印，
 *   用户敲命令回车后追加一行 input 并回显一段模拟输出。这样自检截图不必启动
 *   原生壳也能看出真实观感。
 *
 * 颜色全部来自 terminalTheme 的 token 解析，本文件不出现任何颜色字面量。
 * ========================================================================== */

export interface TerminalMatchInfo {
	/** 当前命中序号（0 基，无命中为 -1） */
	index: number;
	/** 命中总数 */
	count: number;
}

/** 交给工作区调用的命令式接口（右键菜单、搜索栏、快捷键都用它） */
export interface TerminalHandle {
	getSelection: () => string;
	copySelection: () => Promise<boolean>;
	paste: () => Promise<boolean>;
	clear: () => void;
	saveScreen: () => void;
	search: (query: string) => TerminalMatchInfo;
	stepMatch: (delta: number) => TerminalMatchInfo;
	endSearch: () => void;
	focus: () => void;
	isDemo: () => boolean;
}

interface Match {
	row: number;
	col: number;
	len: number;
}

export function Terminal({
	paneId,
	hostId,
	className,
	ref,
}: {
	paneId: string;
	hostId?: string | null;
	className?: string;
	/** React 19：ref 作为普通 prop 传入，工作区据此拿到命令式句柄 */
	ref?: Ref<TerminalHandle>;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const attachRef = useRef<PtyAttachment | null>(null);
	const demoRef = useRef(false);
	/** 演示模式下把文本塞进终端的入口（粘贴走这里） */
	const feedRef = useRef<(data: string) => void>(() => {});
	/** 重画提示符（清屏后用） */
	const repromptRef = useRef<() => void>(() => {});
	const matchesRef = useRef<Match[]>([]);
	const cursorRef = useRef(0);
	const resolvedTheme = useThemeStore((s) => s.resolved);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const palette = readPalette();
		const term = new XTerm({
			cursorBlink: true,
			cursorStyle: "bar",
			fontFamily: readMonoFont(),
			fontSize: 12,
			lineHeight: 1.6,
			letterSpacing: 0,
			scrollback: 5000,
			smoothScrollDuration: 0,
			theme: buildXtermTheme(palette),
		});
		const fit = new FitAddon();
		term.loadAddon(fit);
		term.loadAddon(new WebLinksAddon());
		term.open(container);
		termRef.current = term;

		// mock 里本格的预置输出与元信息（演示模式的素材来源）
		const preset = terminalPanes.find((p) => p.id === paneId);
		const variant: DemoVariant = preset ? resolveVariant(preset.subtitle) : hostId ? "deploy" : "shell";
		const prompt = panePrompt(hostId, preset?.title);

		let disposed = false;
		let demoStarted = false;
		let raf = 0;
		let typed = "";

		const fitNow = () => {
			if (disposed || !term.element?.parentElement) return;
			try {
				fit.fit();
			} catch {
				/* 容器暂时不可见（隐藏标签页）时跳过 */
			}
		};

		const writeLine = (text: string) => term.write(`${text}\r\n`);
		const writePrompt = () => term.write(`${fg(palette.primary, prompt)} `);

		const startDemo = () => {
			if (demoStarted || disposed) return;
			demoStarted = true;
			demoRef.current = true;
			(preset?.lines ?? SESSION_BANNER).forEach((line) => writeLine(renderLine(line, palette)));
			extraScreen(variant, palette).forEach(writeLine);
			writeLine(fg(palette.faint, "— 演示模式（浏览器内无 Rust 壳）：直接输入命令回车，看看回显 —"));
			writePrompt();
			fitNow();
		};

		/** 回车：把当前输入追加为一行 input，再回显一段模拟输出 */
		const submit = () => {
			const command = typed;
			typed = "";
			term.write("\r\n");
			if (command.trim()) {
				useSessionsStore.getState().appendLine(paneId, { kind: "input", text: `${prompt} ${command}` });
			}
			if (/^(clear|cls)$/.test(command.trim())) {
				term.clear();
				writePrompt();
				return;
			}
			demoEcho(command, palette).forEach(writeLine);
			writePrompt();
		};

		const feed = (data: string) => {
			if (disposed) return;
			let text = data;
			if (text.includes("\u001b")) {
				// 方向键、功能键等转义序列在演示模式里没有语义，直接忽略；
				// 但括号粘贴要放行，否则粘贴命令会没反应。
				const paste = /\u001b\[200~([\s\S]*?)\u001b\[201~/.exec(text);
				if (!paste) return;
				text = paste[1];
			}
			for (const ch of text) {
				if (ch === "\r" || ch === "\n") submit();
				else if (ch === "\u007f") {
					if (!typed) continue;
					typed = typed.slice(0, -1);
					term.write("\b \b");
				} else if (ch === "\u0003") {
					typed = "";
					term.write(`${fg(palette.warning, "^C")}\r\n`);
					writePrompt();
				} else if (ch === "\u000c") {
					term.clear();
					writePrompt();
				} else if ((ch.codePointAt(0) ?? 0) >= 0x20) {
					typed += ch;
					term.write(ch);
				}
			}
		};

		feedRef.current = feed;
		repromptRef.current = writePrompt;

		const dataSub = term.onData((data) => {
			// 真实 PTY 可用就写给它，否则走演示回显
			if (!writePty(paneId, data)) feed(data);
		});
		const resizeSub = term.onResize(({ cols, rows }) => resizePty(paneId, cols, rows));

		// 真实 PTY 只在原生壳里有。会话由 ptyCache 持有，独立于组件生命周期，
		// 因此 StrictMode 的「挂载→卸载→再挂载」以及分屏重建都不会丢掉 shell 的输出。
		const attached = attachPty(
			paneId,
			term.cols,
			term.rows,
			(chunk) => term.write(chunk),
			(code) => writeLine(fg(palette.faint, `会话已结束（退出码 ${code ?? 0}）`)),
		);
		attachRef.current = attached;

		if (!attached) {
			// 浏览器内没有 Rust 壳：同步出画面，避免首帧空屏
			startDemo();
		} else {
			// 会话可能已经有输出（组件重建 / StrictMode 演练），先回放再接续
			if (attached.replay) term.write(attached.replay);
			void attached.ready.then((ok) => {
				if (!ok && !disposed) startDemo();
			});
		}

		fitNow();
		// 等 Web 字体落地再算一次网格，避免列宽按回退字体算歪
		void document.fonts.ready.then(() => fitNow());

		const observer = new ResizeObserver(() => {
			window.cancelAnimationFrame(raf);
			raf = window.requestAnimationFrame(fitNow);
		});
		observer.observe(container);

		return () => {
			disposed = true;
			observer.disconnect();
			window.cancelAnimationFrame(raf);
			dataSub.dispose();
			resizeSub.dispose();
			// 只解绑订阅；会话本身由 ptyCache 延迟销毁，避免误杀
			attachRef.current?.detach();
			attachRef.current = null;
			feedRef.current = () => {};
			repromptRef.current = () => {};
			demoRef.current = false;
			matchesRef.current = [];
			cursorRef.current = 0;
			termRef.current = null;
			term.dispose();
		};
	}, [paneId, hostId]);

	// 主题切换时重取 token（设计 token 挂在 <html data-theme> 上，必须重新解析）
	useEffect(() => {
		const term = termRef.current;
		if (term) term.options.theme = buildXtermTheme(readPalette());
	}, [resolvedTheme]);

	useImperativeHandle(
		ref,
		(): TerminalHandle => ({
			getSelection: () => termRef.current?.getSelection() ?? "",
			isDemo: () => demoRef.current,
			focus: () => termRef.current?.focus(),
			clear: () => {
				const term = termRef.current;
				if (!term) return;
				term.clear();
				if (demoRef.current) repromptRef.current();
			},
			copySelection: async () => {
				const text = termRef.current?.getSelection() ?? "";
				if (!text) return false;
				try {
					await navigator.clipboard.writeText(text);
					return true;
				} catch {
					// 非安全上下文里没有剪贴板 API，退回 execCommand
					try {
						const area = document.createElement("textarea");
						area.value = text;
						area.style.position = "fixed";
						area.style.opacity = "0";
						document.body.appendChild(area);
						area.select();
						const ok = document.execCommand("copy");
						area.remove();
						return ok;
					} catch {
						return false;
					}
				}
			},
			paste: async () => {
				let text = "";
				try {
					text = await navigator.clipboard.readText();
				} catch {
					return false;
				}
				if (!text) return false;
				if (!writePty(paneId, text)) feedRef.current(text);
				return true;
			},
			saveScreen: () => {
				const term = termRef.current;
				if (!term) return;
				const buffer = term.buffer.active;
				const lines: string[] = [];
				for (let row = 0; row < buffer.length; row += 1) {
					lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
				}
				while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
				const blob = new Blob([`${lines.join("\n")}\n`], { type: "text/plain;charset=utf-8" });
				const url = URL.createObjectURL(blob);
				const link = document.createElement("a");
				link.href = url;
				link.download = `${paneId}-screen.txt`;
				document.body.appendChild(link);
				link.click();
				link.remove();
				URL.revokeObjectURL(url);
			},
			search: (query) => {
				matchesRef.current = collectMatches(termRef.current, query);
				cursorRef.current = 0;
				if (matchesRef.current.length > 0) showMatch(termRef.current, matchesRef.current, 0);
				return { index: matchesRef.current.length > 0 ? 0 : -1, count: matchesRef.current.length };
			},
			stepMatch: (delta) => {
				const list = matchesRef.current;
				if (list.length === 0) return { index: -1, count: 0 };
				const next = (((cursorRef.current + delta) % list.length) + list.length) % list.length;
				cursorRef.current = next;
				showMatch(termRef.current, list, next);
				return { index: next, count: list.length };
			},
			endSearch: () => {
				matchesRef.current = [];
				cursorRef.current = 0;
				termRef.current?.clearSelection();
			},
		}),
		[],
	);

	return <div ref={containerRef} className={className} data-pane={paneId} />;
}

/** 提示符：优先按主机信息推导（deploy@order-api-01:~$），本地终端给 PowerShell 风格 */
export function panePrompt(hostId: string | null | undefined, fallbackTitle?: string): string {
	const title = fallbackTitle?.trim() ?? "";
	if (!hostId) return title.startsWith("PS ") ? title : "PS C:\\Users\\suantian>";
	const host = useHostsStore.getState().hosts.find((h) => h.id === hostId);
	if (host) return `${host.username}@${host.name}:~$`;
	return title || "deploy@app:~$";
}

/** 在滚动缓冲里找出全部命中（大小写不敏感，逐行不跨行） */
function collectMatches(term: XTerm | null, query: string): Match[] {
	if (!term || !query) return [];
	const found: Match[] = [];
	const buffer = term.buffer.active;
	const needle = query.toLowerCase();
	for (let row = 0; row < buffer.length; row += 1) {
		const text = buffer.getLine(row)?.translateToString(true).toLowerCase() ?? "";
		let from = 0;
		for (;;) {
			const at = text.indexOf(needle, from);
			if (at < 0) break;
			found.push({ row, col: at, len: needle.length });
			from = at + Math.max(1, needle.length);
		}
	}
	return found;
}

/** 选中第 index 个命中并把它滚进视口（xterm 没有内置搜索，用选区当高亮） */
function showMatch(term: XTerm | null, list: Match[], index: number): void {
	if (!term || list.length === 0) return;
	const match = list[index];
	if (!match) return;
	const viewportY = term.buffer.active.viewportY;
	if (match.row < viewportY || match.row >= viewportY + term.rows) {
		term.scrollLines(match.row - viewportY - Math.floor(term.rows / 2));
	}
	term.select(match.col, match.row, match.len);
}
