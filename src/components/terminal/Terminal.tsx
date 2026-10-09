import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { attachPty, resizePty, writePty, type PtyAttachment } from "./ptyCache";
import {
	attachSsh,
	hasSshSession,
	resizeSsh,
	writeSsh,
	type SshAttachment,
} from "./sshCache";
import { useHostsStore } from "@/store/hosts";
import { useSettingsStore } from "@/store/settings";
import { useThemeStore } from "@/store/theme";
import { fontStack, scrollbackLines } from "@/data/preferences";
import { useCallback, useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import { fg, noteColor, readPalette, xtermThemeFor } from "./terminalTheme";
import { CommandCompletionPopup } from "./CommandCompletionPopup";
import { useCommandsStore, type CommandSuggestion } from "@/store/commands";
import { cn } from "@/lib/cn";
import { isLikelySecretEntry } from "@/lib/sensitive";
import { effectiveLook } from "@/lib/hostTerminal";
import { broadcastPeers, writeToPane } from "@/store/sessions";

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
	selectAll: () => void;
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
	sessionKey,
	className,
	ref,
}: {
	paneId: string;
	hostId?: string | null;
	/**
	 * 这一格接的 SSH 会话键。每次连接一个（见 sshCache.newSshSessionKey），
	 * 所以同一台主机的两个格子可以各接一条独立会话。
	 */
	sessionKey?: string | null;
	className?: string;
	/** React 19：ref 作为普通 prop 传入，工作区据此拿到命令式句柄 */
	ref?: Ref<TerminalHandle>;
}) {
	const containerRef = useRef<HTMLDivElement | null>(null);
	const termRef = useRef<XTerm | null>(null);
	const fitRef = useRef<FitAddon | null>(null);
	const attachRef = useRef<PtyAttachment | null>(null);
	/** 当前这格没有真实 PTY（浏览器预览 / PTY 启动失败）：只显示说明，不伪造输出 */
	const noPtyRef = useRef(false);
	const sshRef = useRef<SshAttachment | null>(null);
	const matchesRef = useRef<Match[]>([]);
	const cursorRef = useRef(0);
	const resolvedTheme = useThemeStore((s) => s.resolved);
	const accent = useThemeStore((s) => s.accent);

	/* 终端环境偏好：来自设置页的 store，改动会立刻作用到已打开的终端；
	   主机在「终端外观」里自定义过时，以主机的外观为准 */
	const globalFontFamily = useSettingsStore((s) => s.fontFamily);
	const globalFontSize = useSettingsStore((s) => s.fontSize);
	const globalLineHeight = useSettingsStore((s) => s.lineHeight);
	const scrollback = useSettingsStore((s) => s.scrollback);
	const globalCursorStyle = useSettingsStore((s) => s.cursorStyle);
	const globalScheme = useSettingsStore((s) => s.scheme);
	const hostLook = useHostsStore((s) => (hostId ? s.hosts.find((h) => h.id === hostId)?.terminal : undefined));
	const { fontFamily, fontSize, lineHeight, cursorStyle, scheme } = effectiveLook(
		{
			scheme: globalScheme,
			fontFamily: globalFontFamily,
			fontSize: globalFontSize,
			lineHeight: globalLineHeight,
			cursorStyle: globalCursorStyle,
		},
		hostLook,
	);
	const bell = useSettingsStore((s) => s.bell);
	const commandSuggestions = useSettingsStore((s) => s.commandSuggestions);
	const ghostText = useSettingsStore((s) => s.ghostText);

	const [inputBuffer, setInputBuffer] = useState("");
	const inputBufferRef = useRef("");
	const [suggestions, setSuggestions] = useState<CommandSuggestion[]>([]);
	const [selectedIndex, setSelectedIndex] = useState(0);
	const [showPopup, setShowPopup] = useState(false);
	const [cursorCoords, setCursorCoords] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

	const completionStateRef = useRef({
		inputBuffer: "",
		suggestions: [] as CommandSuggestion[],
		selectedIndex: 0,
		showPopup: false,
		/** 用户用方向键在气泡里挑过（此时 Enter 才代表选中候选） */
		navigated: false,
		commandSuggestions,
		ghostText,
	});

	completionStateRef.current.commandSuggestions = commandSuggestions;
	completionStateRef.current.ghostText = ghostText;

	const handleApplySuggestion = useCallback(
		(suggestion: CommandSuggestion) => {
			const current = inputBufferRef.current;
			const targetCmd = suggestion.command;
			const sshKey = sessionKey ?? null;
			const usingSsh = Boolean(sshKey && hasSshSession(sshKey));

			if (targetCmd.toLowerCase().startsWith(current.toLowerCase())) {
				const remainder = targetCmd.slice(current.length);
				if (usingSsh && sshKey) writeSsh(sshKey, remainder);
				else writePty(paneId, remainder);
			} else {
				const backspaces = "\x7f".repeat(current.length);
				if (usingSsh && sshKey) writeSsh(sshKey, backspaces + targetCmd);
				else writePty(paneId, backspaces + targetCmd);
			}

			inputBufferRef.current = targetCmd;
			setInputBuffer(targetCmd);
			setShowPopup(false);
			setSuggestions([]);
			completionStateRef.current.showPopup = false;
			completionStateRef.current.suggestions = [];
			completionStateRef.current.inputBuffer = targetCmd;
		},
		[paneId, sessionKey],
	);

	useEffect(() => {
		const container = containerRef.current;
		if (!container) return;

		const palette = readPalette();
		const term = new XTerm({
			cursorBlink: true,
			cursorStyle,
			fontFamily: fontStack(fontFamily),
			fontSize,
			lineHeight,
			letterSpacing: 0,
			scrollback: scrollbackLines(scrollback),
			smoothScrollDuration: 0,
			theme: xtermThemeFor(scheme, palette, resolvedTheme),
		});
		const fit = new FitAddon();
		fitRef.current = fit;
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
		const note = noteColor(scheme, palette, resolvedTheme);
		const writeNote = (text: string) => writeLine(fg(note, text));

		// 这一格接的是哪条 SSH 会话：会话键由分屏格自己带着。
		// 选了主机但还没有会话时**不能**退回本地 PTY（那会在远程主机名下开一个本地 shell）
		const sshKey = sessionKey ?? null;
		const usingSsh = Boolean(sshKey && hasSshSession(sshKey));

		const updateCursorPosition = () => {
			if (!container || !term) return;
			const cursorEl = container.querySelector(".xterm-cursor");
			if (cursorEl) {
				const cursorRect = cursorEl.getBoundingClientRect();
				const containerRect = container.getBoundingClientRect();
				setCursorCoords({
					x: Math.max(0, cursorRect.left - containerRect.left),
					y: Math.max(0, cursorRect.top - containerRect.top),
					width: cursorRect.width || 8,
					height: cursorRect.height || 18,
				});
				return;
			}
			const cellWidth = (term as any)._core?._renderService?.dimensions?.css?.cell?.width ?? 7.5;
			const cellHeight = (term as any)._core?._renderService?.dimensions?.css?.cell?.height ?? 19;
			setCursorCoords({
				x: Math.max(0, term.buffer.active.cursorX * cellWidth),
				y: Math.max(0, term.buffer.active.cursorY * cellHeight),
				width: cellWidth,
				height: cellHeight,
			});
		};

		const triggerSuggestions = (raw: string) => {
			const { commandSuggestions: enabled } = completionStateRef.current;
			if (!enabled || !raw.trim()) {
				setSuggestions([]);
				setShowPopup(false);
				completionStateRef.current.suggestions = [];
				completionStateRef.current.showPopup = false;
				return;
			}
			const list = useCommandsStore.getState().querySuggestions(raw, hostId, 6);
			setSuggestions(list);
			setSelectedIndex(0);
			// 仿 Warp：单项最佳匹配时优先呈现行内 Ghost Text，避免弹出单行冗余卡片；多项候选时才展开气泡供挑选
			const shouldShowPopup = list.length > 1;
			setShowPopup(shouldShowPopup);
			completionStateRef.current.suggestions = list;
			completionStateRef.current.selectedIndex = 0;
			completionStateRef.current.navigated = false;
			completionStateRef.current.showPopup = shouldShowPopup;
			updateCursorPosition();
		};

		// 光标坐标只在补全 / 幽灵文本可见时才需要；每次光标移动都 setState 会让
		// 大量输出时整格反复重渲染。这里按帧合并，并且没人用时直接跳过
		let cursorRaf = 0;
		const cursorSub = term.onCursorMove(() => {
			const st = completionStateRef.current;
			if (!st.showPopup && st.suggestions.length === 0) return;
			if (cursorRaf) return;
			cursorRaf = window.requestAnimationFrame(() => {
				cursorRaf = 0;
				if (!disposed) updateCursorPosition();
			});
		});

		// 键盘拦截：处理 Tab / 方向键 / Enter / Esc (Warp / VS Code 风格体验)
		term.attachCustomKeyEventHandler((event) => {
			if (term.buffer.active.type === "alternate") return true;

			const state = completionStateRef.current;
			if (event.type === "keydown") {
				// 1. 如果补全气泡处于展开状态
				if (state.showPopup && state.suggestions.length > 0) {
					if (event.key === "ArrowDown") {
						event.preventDefault();
						const next = (state.selectedIndex + 1) % state.suggestions.length;
						state.selectedIndex = next;
						state.navigated = true;
						setSelectedIndex(next);
						return false;
					}
					if (event.key === "ArrowUp") {
						event.preventDefault();
						const next = (state.selectedIndex - 1 + state.suggestions.length) % state.suggestions.length;
						state.selectedIndex = next;
						state.navigated = true;
						setSelectedIndex(next);
						return false;
					}
					if (event.key === "Escape") {
						event.preventDefault();
						state.showPopup = false;
						setShowPopup(false);
						return false;
					}
					// Enter 只在用户用方向键挑过候选之后才代表「选这一项」；
					// 否则就是执行自己敲的命令（不能被补全劫持成另一条命令）
					if (event.key === "Tab" || (event.key === "Enter" && state.navigated)) {
						event.preventDefault();
						const chosen = state.suggestions[state.selectedIndex];
						if (chosen) {
							handleApplySuggestion(chosen);
							return false;
						}
					}
				}

				// 2. 如果仅显示行内幽灵文本 (Ghost Text) 且用户按下 Tab 或 →
				const best = state.suggestions[0];
				if (
					state.ghostText &&
					best &&
					state.inputBuffer &&
					best.command.toLowerCase().startsWith(state.inputBuffer.toLowerCase()) &&
					!state.showPopup
				) {
					if (event.key === "Tab" || event.key === "ArrowRight") {
						event.preventDefault();
						handleApplySuggestion(best);
						return false;
					}
				}
			}
			return true;
		});

		/** 写入本格会话；标签开着广播时同步写入同标签的其它格 */
		const send = (data: string) => {
			if (usingSsh && sshKey) writeSsh(sshKey, data);
			else writePty(paneId, data);
			for (const peer of broadcastPeers(paneId)) writeToPane(peer, data);
		};

		const dataSub = term.onData((data) => {
			if (term.buffer.active.type === "alternate") {
				inputBufferRef.current = "";
				setInputBuffer("");
				setShowPopup(false);
				send(data);
				return;
			}

			if (data === "\r") {
				const cmd = inputBufferRef.current.trim();
				// 在密码 / 口令提示符下（或远端关了回显时）敲的是秘密，不是命令：绝不记进历史
				if (cmd && !isLikelySecretEntry(currentLogicalLine(term), cmd)) {
					useCommandsStore.getState().recordCommand(cmd, hostId);
				}
				inputBufferRef.current = "";
				setInputBuffer("");
				setShowPopup(false);
				setSuggestions([]);
				completionStateRef.current.inputBuffer = "";
				completionStateRef.current.showPopup = false;
				completionStateRef.current.suggestions = [];
			} else if (data === "\x7f" || data === "\b") {
				const next = inputBufferRef.current.slice(0, -1);
				inputBufferRef.current = next;
				setInputBuffer(next);
				completionStateRef.current.inputBuffer = next;
				triggerSuggestions(next);
			} else if (data === "\x03" || data === "\x15" || data === "\x0c") {
				// Ctrl+C, Ctrl+U, Ctrl+L
				inputBufferRef.current = "";
				setInputBuffer("");
				setShowPopup(false);
				setSuggestions([]);
				completionStateRef.current.inputBuffer = "";
				completionStateRef.current.showPopup = false;
				completionStateRef.current.suggestions = [];
			} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
				const next = inputBufferRef.current + data;
				inputBufferRef.current = next;
				setInputBuffer(next);
				completionStateRef.current.inputBuffer = next;
				triggerSuggestions(next);
			}

			// 只有真实会话才接收按键：SSH 会话优先，其次本地 PTY；
			// 两者都没有时既不回显也不伪造输出。
			send(data);
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
					writeLine(fg(note, code === null ? "远端会话已结束" : `远端会话已结束（退出码 ${code}）`)),
			);
			sshRef.current = attachment;
			attachRef.current = null;
			if (attachment?.replay) term.write(attachment.replay);
		} else if (sshKey || hostId) {
			// 这条会话还没建立（或者选了主机但没走连接页）：如实说明，**不能**偷偷开一个本地 shell
			noPtyRef.current = true;
			writeNote("这条会话还没有建立。请在主机库对它发起一次连接。");
		} else {
			// 本地终端：真实 PTY 只在原生壳里有。会话由 ptyCache 持有，独立于组件生命周期，
			// 因此 StrictMode 的「挂载→卸载→再挂载」以及分屏重建都不会丢掉 shell 的输出。
			const attached = attachPty(
				paneId,
				term.cols,
				term.rows,
				(chunk) => term.write(chunk),
				(code) => writeLine(fg(note, code === null ? "会话已结束" : `会话已结束（退出码 ${code}）`)),
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
			window.cancelAnimationFrame(cursorRaf);
			dataSub.dispose();
			resizeSub.dispose();
			cursorSub.dispose();
			// 只解绑订阅；会话本身由 ptyCache / sshCache 持有，避免误杀
			attachRef.current?.detach();
			attachRef.current = null;
			sshRef.current?.detach();
			sshRef.current = null;
			noPtyRef.current = false;
			matchesRef.current = [];
			cursorRef.current = 0;
			termRef.current = null;
			fitRef.current = null;
			term.dispose();
		};
	}, [paneId, hostId, sessionKey]);

	/* 终端环境偏好改动 → 立即改已打开终端的 xterm 运行时选项，不需要重开会话。
	   字号/字体/行高会影响网格，改完必须重新 fit，否则列数还是旧值。 */
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		term.options.fontFamily = fontStack(fontFamily);
		term.options.fontSize = fontSize;
		term.options.lineHeight = lineHeight;
		term.options.scrollback = scrollbackLines(scrollback);
		term.options.cursorStyle = cursorStyle;
		window.requestAnimationFrame(() => {
			try {
				fitRef.current?.fit();
			} catch {
				/* 容器不可见时跳过 */
			}
		});
	}, [fontFamily, fontSize, lineHeight, scrollback, cursorStyle, paneId, hostId, sessionKey]);

	/* 响铃：xterm 只上报 BEL 事件、自己不出声，这里合成一声短促提示音 */
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		const sub = term.onBell(() => {
			if (bell) playBell();
		});
		return () => sub.dispose();
		// 终端实例随格子/会话重建，订阅要跟着重新挂
	}, [bell, paneId, hostId, sessionKey]);

	// 主题 / 强调色切换时重取 token；终端配色方案则决定用哪一套色板。
	// 设计 token 挂在 <html data-theme data-accent> 上，必须重新解析才能拿到新颜色。
	useEffect(() => {
		const term = termRef.current;
		if (!term) return;
		window.requestAnimationFrame(() => {
			const palette = readPalette();
			term.options.theme = xtermThemeFor(scheme, palette, resolvedTheme);
		});
	}, [resolvedTheme, accent, scheme, paneId, hostId, sessionKey]);

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
			selectAll: () => {
				termRef.current?.selectAll();
			},
			copySelection: async () => {
				const selected = termRef.current?.getSelection() ?? "";
				if (!selected) return false;
				// 「复制时去除末尾换行」：避免粘贴到远端时直接执行命令
				const text = useSettingsStore.getState().trimNewline ? selected.replace(/[\r\n]+$/, "") : selected;
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
				const term = termRef.current;
				// 没有真实会话（说明页）时不往终端里塞内容
				if (!term || noPtyRef.current) return false;
				// 走 xterm 的粘贴通道：远端开了 bracketed paste（?2004h）时自动包上
				// \e[200~ … \e[201~，多行粘贴不会被逐行执行；随后经 onData 写入会话（含广播）
				term.paste(text);
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

	const selectedSuggestion = suggestions[selectedIndex] ?? suggestions[0];
	const isPrefixMatch =
		Boolean(inputBuffer) &&
		Boolean(selectedSuggestion) &&
		selectedSuggestion.command.toLowerCase().startsWith(inputBuffer.toLowerCase());
	const ghostRemainder =
		ghostText && isPrefixMatch && selectedSuggestion
			? selectedSuggestion.command.slice(inputBuffer.length)
			: null;

	return (
		<div
			className={cn("relative h-full w-full overflow-hidden", className)}
			onMouseDown={() => {
				setShowPopup(false);
				completionStateRef.current.showPopup = false;
			}}
		>
			<div ref={containerRef} className="h-full w-full" data-pane={paneId} data-host={hostId ?? undefined} />

			{/* Warp 风格行内幽灵文本 (Ghost Text) */}
			{ghostRemainder && cursorCoords && (
				<div
					style={{
						left: cursorCoords.x,
						top: cursorCoords.y,
						height: `${cursorCoords.height}px`,
						display: "flex",
						alignItems: "center",
						fontFamily: fontStack(fontFamily),
						fontSize: `${fontSize}px`,
						lineHeight: 1,
						letterSpacing: "0px",
						whiteSpace: "pre",
					}}
					className="pointer-events-none absolute z-20 select-none font-mono text-faint opacity-50"
				>
					<span style={{ whiteSpace: "pre", fontFamily: fontStack(fontFamily) }}>
						{ghostRemainder.replace(/ /g, "\u00A0")}
					</span>
				</div>
			)}

			{/* VS Code 风格光标下方 IntelliSense 补全气泡 */}
			{showPopup && cursorCoords && suggestions.length > 0 && (
				<CommandCompletionPopup
					suggestions={suggestions}
					selectedIndex={selectedIndex}
					onSelect={handleApplySuggestion}
					onHoverIndex={(idx) => {
						setSelectedIndex(idx);
						completionStateRef.current.selectedIndex = idx;
					}}
					position={{ x: cursorCoords.x, y: cursorCoords.y + cursorCoords.height }}
					currentInput={inputBuffer}
				/>
			)}
		</div>
	);
}

/** 光标所在的逻辑行（把软折行拼回一行）在屏幕上的文本：用来判断当前是不是密码提示符 */
function currentLogicalLine(term: XTerm): string {
	const buffer = term.buffer.active;
	let y = buffer.baseY + buffer.cursorY;
	const parts: string[] = [];
	for (let guard = 0; guard < 50 && y >= 0; guard += 1, y -= 1) {
		const line = buffer.getLine(y);
		if (!line) break;
		parts.unshift(line.translateToString(true));
		if (!line.isWrapped) break;
	}
	return parts.join("");
}

/** 响铃发声：WebAudio 合成，不引入音频文件（xterm 自身只上报 BEL 事件） */
let bellContext: AudioContext | null = null;

function playBell(): void {
	try {
		const Ctor = window.AudioContext;
		if (!Ctor) return;
		bellContext ??= new Ctor();
		const ctx = bellContext;
		if (ctx.state === "suspended") void ctx.resume();
		const osc = ctx.createOscillator();
		const gain = ctx.createGain();
		osc.type = "sine";
		osc.frequency.value = 880;
		const now = ctx.currentTime;
		gain.gain.setValueAtTime(0.0001, now);
		gain.gain.exponentialRampToValueAtTime(0.06, now + 0.01);
		gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.12);
		osc.connect(gain);
		gain.connect(ctx.destination);
		osc.start(now);
		osc.stop(now + 0.13);
	} catch {
		/* 音频设备不可用就算了，响铃不该影响终端 */
	}
}

/** 提示符：优先按主机信息推导（deploy@order-api-01:~$），本地终端给 PowerShell 风格 */
export function panePrompt(hostId: string | null | undefined, fallbackTitle?: string): string {
	const title = fallbackTitle?.trim() ?? "";
	if (!hostId) return title || "local:~$";
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
