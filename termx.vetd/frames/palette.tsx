export const frame = { width: 1440, height: 900, title: "命令面板" };

import { Link } from "react-router";
import { WindowChrome } from "../components/WindowChrome";

export default function Palette() {
	return (
		<WindowChrome command="order">
			{/* 背景暗沉模糊遮罩 */}
			<div className="relative flex min-h-0 flex-1 flex-col items-center justify-start bg-term/95 p-4">
				{/* 虚化底层内容 */}
				<div className="absolute inset-0 bg-black/60 backdrop-blur-md transition-opacity" />

				{/* Raycast 级悬浮聚光搜索框 */}
				<div className="relative z-10 mt-14 w-[620px] overflow-hidden rounded-2xl border border-white/[0.12] bg-surface-raised/90 shadow-[0_32px_80px_-16px_rgba(0,0,0,0.9),inset_0_1px_0_0_rgba(255,255,255,0.12)] backdrop-blur-2xl">
					{/* 搜索输入行 */}
					<div className="flex h-14 items-center gap-3 border-b border-border/80 px-4">
						<span className="icon-[lucide--search] size-5 text-accent drop-shadow-[0_0_8px_var(--color-accent)]" />
						<div className="flex flex-1 items-center gap-0.5 text-[15px] font-sans">
							<span className="text-surface-foreground font-medium">order</span>
							<span className="inline-block h-5 w-[2px] bg-accent shadow-[0_0_8px_var(--color-accent)] animate-pulse" />
						</div>
						<div className="flex items-center gap-1.5">
							<span className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-faint">
								⌘K
							</span>
							<Link
								to="/"
								className="rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-mono text-[10px] text-muted hover:text-surface-foreground transition-colors"
							>
								ESC
							</Link>
						</div>
					</div>

					{/* 选项组列表 */}
					<div className="p-2 space-y-3 max-h-[460px] overflow-y-auto">
						{/* 组 1: 主机快速直连 */}
						<div>
							<div className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-faint font-semibold">
								匹配的主机 (3)
							</div>
							<div className="flex flex-col gap-0.5 mt-0.5">
								<Item
									icon="icon-[simple-icons--ubuntu]"
									iconColor="text-[#E95420]"
									title="order-api-01"
									hint="deploy@10.0.3.21 · 华东1 生产集群"
									badge="PROD"
									selected
									action="↵ 直连终端"
								/>
								<Item
									icon="icon-[simple-icons--ubuntu]"
									iconColor="text-[#E95420]"
									title="order-api-02"
									hint="deploy@10.0.3.22 · 华东1 生产集群"
									badge="PROD"
									action="回车连接"
								/>
								<Item
									icon="icon-[simple-icons--debian]"
									iconColor="text-[#D70A53]"
									title="order-stage"
									hint="deploy@10.1.4.8 · 预发布验证节点"
									badge="STG"
									action="回车连接"
								/>
							</div>
						</div>

						{/* 组 2: 常用操作与片段 */}
						<div>
							<div className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-faint font-semibold">
								快捷操作与代码片段 (2)
							</div>
							<div className="flex flex-col gap-0.5 mt-0.5">
								<Item
									icon="icon-[lucide--terminal-square]"
									title="查看订单服务实时异常"
									hint="片段 · tail -f /var/log/order.log | grep ERROR"
									tag="命令片段"
								/>
								<Item
									icon="icon-[lucide--folder-git-2]"
									title="打开 order-api-01 的 SFTP 目录"
									hint="快速定位 /home/deploy/app"
									tag="文件浏览"
								/>
							</div>
						</div>

						{/* 组 3: 系统偏好设置 */}
						<div>
							<div className="px-2.5 py-1 text-[10px] font-mono uppercase tracking-widest text-faint font-semibold">
								应用设置 (1)
							</div>
							<div className="flex flex-col gap-0.5 mt-0.5">
								<Item
									icon="icon-[lucide--palette]"
									title="外观与终端配色设置"
									hint="偏好设置 · 主题 / 强调色 / 字体"
									tag="设置"
								/>
							</div>
						</div>
					</div>

					{/* 底部 Linear 风格快捷键微导航 */}
					<div className="flex h-10 items-center justify-between border-t border-border/80 bg-surface-sunk/80 px-4 text-[11px] text-faint font-mono">
						<div className="flex items-center gap-3">
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 text-[9px]">↑↓</kbd>
								<span>导航</span>
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-white/10 bg-white/[0.04] px-1.5 py-0.5 text-[9px]">↵</kbd>
								<span>确认打开</span>
							</span>
							<span className="flex items-center gap-1">
								<kbd className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 text-[9px]">&gt;</kbd>
								<span>仅搜命令</span>
							</span>
						</div>
						<div className="flex items-center gap-1 text-muted">
							<span>按</span>
							<kbd className="rounded border border-white/10 bg-white/[0.04] px-1 py-0.5 text-[9px]">Tab</kbd>
							<span>更多操作</span>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function Item({
	icon,
	iconColor,
	title,
	hint,
	badge,
	tag,
	selected,
	action,
}: {
	icon: string;
	iconColor?: string;
	title: string;
	hint: string;
	badge?: string;
	tag?: string;
	selected?: boolean;
	action?: string;
}) {
	return (
		<div
			className={`group flex h-11 items-center gap-3 rounded-xl px-3 transition-all cursor-pointer ${
				selected
					? "bg-accent/15 text-surface-foreground border border-accent/35 shadow-[0_0_16px_-4px_var(--color-accent)]"
					: "text-surface-foreground/90 hover:bg-white/[0.04] border border-transparent"
			}`}
		>
			<span className={`${icon} size-4 shrink-0 ${iconColor ?? (selected ? "text-accent" : "text-muted")}`} />
			<div className="flex flex-1 items-center gap-2 min-w-0">
				<span className={`text-[13px] font-medium tracking-tight truncate ${selected ? "text-accent" : ""}`}>
					{title}
				</span>
				<span className="text-[12px] text-faint truncate font-mono">{hint}</span>
			</div>

			{badge && (
				<span
					className={`rounded-md border px-1.5 py-0.5 font-mono text-[9px] font-semibold tracking-wider ${
						badge === "PROD"
							? "border-env-prod/40 bg-env-prod/15 text-env-prod shadow-[0_0_8px_-2px_var(--color-env-prod)]"
							: "border-env-stage/40 bg-env-stage/15 text-env-stage"
					}`}
				>
					{badge}
				</span>
			)}

			{tag && (
				<span className="rounded bg-white/[0.05] border border-white/5 px-2 py-0.5 font-mono text-[10px] text-faint">
					{tag}
				</span>
			)}

			{action && (
				<span
					className={`ml-2 rounded-lg border px-2 py-0.5 font-mono text-[10px] transition-colors ${
						selected
							? "border-accent/40 bg-accent text-primary-foreground font-semibold shadow-sm"
							: "border-white/10 bg-white/[0.04] text-muted opacity-0 group-hover:opacity-100"
					}`}
				>
					{action}
				</span>
			)}
		</div>
	);
}
