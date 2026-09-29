import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { attachPty, resizePty, writePty, type PtyAttachment } from "./ptyCache";
import {
	attachSsh,
	hasSshSession,
	resizeSsh,
	sshKeyForHost,
	writeSsh,
	type SshAttachment,
} from "./sshCache";
import { useHostsStore } from "@/store/hosts";
import { useThemeStore } from "@/store/theme";
import { useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { buildXtermTheme, fg, readMonoFont, readPalette } from "./terminalTheme";

/* =============================================================================
 * 终端分屏格 —— xterm 6 的 React 封装。
 *
 * - Tauri 内：spawnLocalShell() 起真实 PTY，键盘输入写回 PTY，输出直接写终端。
 * - 浏览器内：没有 Rust 壳也就没有 PTY。此时只打印一条诚实的说明，告诉用户
 *   怎么拿到真实终端；不回显按键、不伪造任何命令输出。
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
	/** 当前这格没有真实 PTY（浏览器预览 / PTY 启动失败）：只显示说明，不伪造输出 */
	const noPtyRef = useRef(false);
	const sshRef = useRef<SshAttachment | null>(null);
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

		let disposed = false;
		let raf = 0;
		noPtyRef.current = false;

		const fitNow = () => {
			if (disposed || !term.element?.parentElement) return;
			try {
				fit.fit();
			} catch {
				/* 容器暂时不可见（隐藏标签页）时跳过 */
			}
		};

		const writeLine = (text: string) => term.write(`${text}\r\n`);
		/** 说明性文字：不带任何伪造的命令输出 */
		const writeNote = (text: string) => writeLine(fg(palette.faint, text));

		// 这一格连的是哪台主机：有真实 SSH 会话就走 SSH，否则才考虑本地 PTY
		const sshKey = hostId ? sshKeyForHost(hostId) : null;
		const usingSsh = Boolean(sshKey && hasSshSession(sshKey));

		const dataSub = term.onData((data) => {
			// 只有真实会话才接收按键：SSH 会话优先，其次本地 PTY；
			// 两者都没有时既不回显也不伪造输出。
			if (usingSsh && sshKey) {
				writeSsh(sshKey, data);
				return;
			}
			writePty(paneId, data);
		});
		const resizeSub = term.onResize(({ cols, rows }) => {
			if (usingSsh && sshKey) resizeSsh(sshKey, cols, rows);
			else resizePty(paneId, cols, rows);
		});

		if (usingSsh && sshKey) {
			// 远端会话：会话由 sshCache 持有，这里只负责把输出接上终端
			const attachment = attachSsh(
				sshKey,
				(chunk) => term.write(chunk),
				(code) =>
					writeLine(
						fg(palette.faint, code === null ? "远端会话已结束" : `远端会话已结束（退出码 ${code}）`),
					),
			);
			sshRef.current = attachment;
			attachRef.current = null;
			if (attachment?.replay) term.write(attachment.replay);
		} else if (sshKey) {
			// 选了主机但还没建立 SSH 会话：如实说明，**不能**偷偷开一个本地 shell
			noPtyRef.current = true;
			writeNote("这台主机还没有建立 SSH 会话。请在主机库对它发起连接。");
		} else {
			// 本地终端：真实 PTY 只在原生壳里有。会话由 ptyCache 持有，独立于组件生命周期，
			// 因此 StrictMode 的「挂载→卸载→再挂载」以及分屏重建都不会丢掉 shell 的输出。
			const attached = attachPty(
				paneId,
				term.cols,
				term.rows,
				(chunk) => term.write(chunk),
				(code) => writeLine(fg(palette.faint, `会话已结束（退出码 ${code ?? 0}）`)),
			);
			attachRef.current = attached;
			sshRef.current = null;

			if (!attached) {
				// 浏览器预览：没有 Rust 壳就没有 PTY。如实说明，不打印任何假日志。
				noPtyRef.current = true;
				writeNote("浏览器预览下没有本地 PTY。用 pnpm tauri:dev 启动桌面端即可获得真实终端。");
			} else {
				// 会话可能已经有输出（组件重建 / StrictMode 演练），先回放再接续
				if (attached.replay) term.write(attached.replay);
				void attached.ready.then((ok) => {
					if (!ok && !disposed) {
						noPtyRef.current = true;
						writeNote("本地 PTY 未能启动（spawn_local_shell 失败）。请在桌面端查看日志后重试。");
					}
				});
			}
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
			// 只解绑订阅；会话本身由 ptyCache / sshCache 持有，避免误杀
			attachRef.current?.detach();
			attachRef.current = null;
			sshRef.current?.detach();
			sshRef.current = null;
			noPtyRef.current = false;
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
			/** true = 这格没有真实 PTY（浏览器预览），界面上只有那条说明 */
			isDemo: () => noPtyRef.current,
			focus: () => termRef.current?.focus(),
			clear: () => {
				const term = termRef.current;
				if (!term) return;
				term.clear();
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
				// 有真实会话才谈得上粘贴：SSH 优先，其次本地 PTY；都没有就如实返回失败
				if (hostId && writeSsh(sshKeyForHost(hostId), text)) return true;
				return writePty(paneId, text);
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

	return <div ref={containerRef} className={className} data-pane={paneId} data-host={hostId ?? undefined} />;
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
