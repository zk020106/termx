export const frame = { width: 1440, height: 900, title: "命令面板" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

export default function Palette() {
	return (
		<WindowChrome command="order">
			<div className="relative flex min-h-0 flex-1 flex-col items-center justify-start bg-term/90 p-4">
				{/* 浮动命令面板 (Linear 风格 580px) */}
				<div className="relative z-10 mt-12 w-[580px] overflow-hidden rounded-lg border border-border bg-surface-raised shadow-2xl">
					{/* 搜索输入栏 */}
					<div className="flex h-11 items-center gap-2.5 border-b border-border bg-surface px-3.5">
						<span className="icon-[lucide--search] size-4 text-primary" />
						<div className="flex flex-1 items-center gap-0.5 text-[13px]">
							<span className="text-surface-foreground font-medium">order</span>
							<span className="inline-block h-4 w-[1.5px] bg-primary animate-pulse" />
						</div>
						<div className="flex items-center gap-1.5">
							<Link
								to="/"
								className="flex items-center rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[9px] text-muted hover:text-surface-foreground"
							>
								ESC
							</Link>
						</div>
					</div>

					{/* 搜索结果分组列表 */}
					<div className="max-h-[460px] overflow-y-auto p-1.5 space-y-2">
						{/* 主机会话 */}
						<div>
							<div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-faint font-semibold">
								匹配的主机 (3)
							</div>
							<div className="space-y-0.5">
								<ResultItem
									icon="icon-[simple-icons--ubuntu]"
									title="order-api-01"
									meta="deploy@10.0.3.21 · 华东1"
									env="PROD"
									selected
									shortcut="↵ 连接"
								/>
								<ResultItem
									icon="icon-[simple-icons--ubuntu]"
									title="order-api-02"
									meta="deploy@10.0.3.22 · 华东1"
									env="PROD"
									shortcut="回车"
								/>
								<ResultItem
									icon="icon-[simple-icons--debian]"
									title="order-stage"
									meta="deploy@10.1.4.8 · 测试环境"
									env="STG"
									shortcut="回车"
								/>
							</div>
						</div>

						{/* 命令片段 */}
						<div>
							<div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-faint font-semibold">
								命令片段 (2)
							</div>
							<div className="space-y-0.5">
								<ResultItem
									icon="icon-[lucide--terminal-square]"
									title="重启指定微服务"
									meta="sudo systemctl restart ${service}"
									tag="日常发布"
								/>
								<ResultItem
									icon="icon-[lucide--file-search]"
									title="排查最近 200 条错误日志"
									meta="journalctl -u order-api -n 200 | grep ERROR"
									tag="排障诊断"
								/>
							</div>
						</div>

						{/* 全局设置与快捷动作 */}
						<div>
							<div className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider text-faint font-semibold">
								快捷操作与设置 (3)
							</div>
							<div className="space-y-0.5">
								<ResultItem
									icon="icon-[lucide--plus]"
									title="新建 SSH 主机配置…"
									meta="配置新连接、认证凭据与跳板链路"
								/>
								<ResultItem
									icon="icon-[lucide--arrow-down-up]"
									title="打开 SFTP 文件传输队列"
									meta="查看正在传输的 2 项任务"
								/>
								<ResultItem
									icon="icon-[lucide--sliders]"
									title="外观与终端字体设置"
									meta="切换深浅主题、JetBrains Mono 字体字号"
								/>
							</div>
						</div>
					</div>

					{/* 底部导航提示 */}
					<div className="flex h-7 items-center justify-between border-t border-border bg-surface-sunk px-3 font-mono text-[10.5px] text-faint">
						<div className="flex items-center gap-3">
							<span><kbd className="text-muted">↑↓</kbd> 选择</span>
							<span><kbd className="text-muted">↵</kbd> 执行</span>
							<span>输入 <kbd className="text-muted">&gt;</kbd> 仅搜命令</span>
						</div>
						<Link to="/" className="text-primary hover:underline font-sans">
							关闭面板
						</Link>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function ResultItem({
	icon,
	title,
	meta,
	env,
	tag,
	selected,
	shortcut,
}: {
	icon: string;
	title: string;
	meta: string;
	env?: "PROD" | "STG" | "TEST" | "DEV";
	tag?: string;
	selected?: boolean;
	shortcut?: string;
}) {
	return (
		<Link
			to="/"
			className={`flex h-9 items-center justify-between rounded px-2.5 text-[12px] transition-colors ${
				selected
					? "bg-surface border border-border text-surface-foreground"
					: "text-muted hover:bg-surface hover:text-surface-foreground"
			}`}
		>
			<div className="flex items-center gap-2 truncate">
				<span className={`${icon} size-3.5 ${selected ? "text-primary" : "text-muted"} shrink-0`} />
				<span className="font-medium text-surface-foreground font-mono">{title}</span>
				<span className="text-faint font-mono text-[11px] truncate">{meta}</span>
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{env && <EnvPill env={env} />}
				{tag && <span className="rounded border border-border bg-surface px-1 py-0.2 font-mono text-[9px] text-muted">{tag}</span>}
				{shortcut && <kbd className="font-mono text-[9.5px] text-muted">{shortcut}</kbd>}
			</div>
		</Link>
	);
}
