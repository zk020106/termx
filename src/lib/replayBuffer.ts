/* 终端回放缓冲：只保留末尾 limit 个字符。
 *
 * 以前每来一块就 `(replay + chunk).slice(-limit)`，大输出（cat 大文件、编译日志）时
 * 每块都要复制一遍 256KB，整体是 O(n²)。这里按块追加，超出上限一倍时才合并裁剪一次，
 * 均摊 O(1)；读取（终端重挂载时回放）才拼接一次。 */
export class ReplayBuffer {
	private chunks: string[] = [];
	private length = 0;

	constructor(private readonly limit: number) {}

	push(chunk: string): void {
		if (!chunk) return;
		this.chunks.push(chunk);
		this.length += chunk.length;
		if (this.length > this.limit * 2) this.compact();
	}

	private compact(): void {
		const text = this.chunks.join("").slice(-this.limit);
		this.chunks = [text];
		this.length = text.length;
	}

	/** 当前保留的输出（末尾 limit 个字符） */
	text(): string {
		if (this.length > this.limit || this.chunks.length > 1) this.compact();
		return this.chunks[0] ?? "";
	}

	set(text: string): void {
		this.chunks = [];
		this.length = 0;
		this.push(text);
	}

	clear(): void {
		this.chunks = [];
		this.length = 0;
	}

	get size(): number {
		return Math.min(this.length, this.limit);
	}
}
