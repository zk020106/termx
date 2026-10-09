/** 运行环境探测：是否跑在 Tauri 原生壳内。前端单独跑（浏览器）时全部降级为空实现。 */
export function isTauri(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** 本地终端（PTY）接口，原生壳未就绪时返回 null，由调用方降级为演示模式 */
export interface PtyHandle {
	write: (data: string) => void;
	resize: (cols: number, rows: number) => void;
	kill: () => void;
}

export async function spawnLocalShell(
	cols: number,
	rows: number,
	onData: (chunk: string) => void,
	onExit: (code: number | null) => void,
): Promise<PtyHandle | null> {
	if (!isTauri()) return null;
	const { invoke } = await import("@tauri-apps/api/core");
	const { listen } = await import("@tauri-apps/api/event");

	// 会话 key 由前端生成，并且「先挂监听、再启动 shell」。
	// 反过来做的话，shell 的首屏输出（提示符 / 横幅）会在监听注册完成前发出而永久丢失，
	// 表现为原生壳里终端一片空白。
	const key = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

	const unlistenData = await listen<string>(`pty://data/${key}`, (event) => onData(event.payload));
	// shell 自己退出后监听就没用了：报完退出码顺手注销，别让监听跟着标签一直挂着
	let unlistenExit: () => void = () => undefined;
	unlistenExit = await listen<number | null>(`pty://exit/${key}`, (event) => {
		onExit(event.payload);
		unlistenData();
		unlistenExit();
	});

	try {
		await invoke("pty_spawn", { key, cols, rows });
	} catch (error) {
		unlistenData();
		unlistenExit();
		throw error;
	}

	return {
		write: (data) => {
			void invoke("pty_write", { key, data });
		},
		resize: (nextCols, nextRows) => {
			void invoke("pty_resize", { key, cols: nextCols, rows: nextRows });
		},
		kill: () => {
			void invoke("pty_kill", { key });
			unlistenData();
			unlistenExit();
		},
	};
}
