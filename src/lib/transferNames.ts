/* 「重命名保留两份」：生成 name (1).ext、name (2).ext …（纯函数，便于单测） */

export function splitExt(name: string): [string, string] {
	// .bashrc 这种点开头的整体算文件名；a.tar.gz 只拆最后一段
	const dot = name.lastIndexOf(".");
	if (dot <= 0) return [name, ""];
	return [name.slice(0, dot), name.slice(dot)];
}

export function numberedName(name: string, n: number): string {
	const [base, ext] = splitExt(name);
	return `${base} (${n})${ext}`;
}

/** 在 dir 下找一个不存在的名字；exists 由调用方提供（远端用 sftp_stat，本地用 fs_local_stat） */
export async function freeName(name: string, exists: (candidate: string) => Promise<boolean>, limit = 999): Promise<string> {
	for (let n = 1; n <= limit; n++) {
		const candidate = numberedName(name, n);
		if (!(await exists(candidate))) return candidate;
	}
	throw new Error(`找不到可用的文件名（${name} 已有 ${limit} 个副本）`);
}
