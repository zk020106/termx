import type { ConnectionStatus } from "@/data/types";
import { cn } from "@/lib/cn";
import { connVisual } from "@/lib/status";
import type { ReactNode } from "react";

/* =============================================================================
 * 展示型原语：状态点、进度条、空状态、面板。
 * 这些是「状态始终可见」原则的落地零件。
 * ========================================================================== */

/** 连接状态点，pulse 用于「连接中 / 重连中」 */
export function StatusDot({
	status,
	className,
	size = 6,
}: {
	status: ConnectionStatus;
	className?: string;
	size?: number;
}) {
	const visual = connVisual[status];
	return (
		<span
			role="img"
			aria-label={status}
			style={{ width: size, height: size }}
			className={cn("inline-block shrink-0 rounded-full", visual.dot, visual.pulse && "animate-pulse", className)}
		/>
	);
}

/** 状态点 + 文案 */
export function StatusText({ status, label, className }: { status: ConnectionStatus; label: string; className?: string }) {
	return (
		<span className={cn("inline-flex items-center gap-1.5", connVisual[status].text, className)}>
			<StatusDot status={status} />
			<span className="font-sans">{label}</span>
		</span>
	);
}

export function Badge({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<span
			className={cn(
				"inline-flex items-center rounded border border-border bg-surface-raised px-1.5 py-0.5 font-mono text-[10px] text-muted",
				className,
			)}
		>
			{children}
		</span>
	);
}

export function ProgressBar({
	value,
	max = 100,
	tone = "primary",
	className,
}: {
	value: number;
	max?: number;
	tone?: "primary" | "accent" | "warning" | "danger" | "success";
	className?: string;
}) {
	const pct = max > 0 ? Math.min(100, Math.max(0, (value / max) * 100)) : 0;
	const toneClass = {
		primary: "bg-primary",
		accent: "bg-accent",
		warning: "bg-warning",
		danger: "bg-danger",
		success: "bg-success",
	}[tone];
	return (
		<div className={cn("h-1.5 overflow-hidden rounded-full border border-border bg-surface", className)}>
			<div className={cn("h-full rounded-full transition-[width] duration-200", toneClass)} style={{ width: `${pct}%` }} />
		</div>
	);
}

/** 指标条：左侧标签、右侧数值、下方进度条（监控面板与设置页复用） */
export function MetricBar({
	label,
	value,
	progress,
	warn,
	className,
}: {
	label: string;
	value: string;
	progress: number;
	warn?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("space-y-1", className)}>
			<div className="flex items-baseline justify-between text-[11px]">
				<span className="text-muted">{label}</span>
				<span className={cn("font-mono tabular-nums", warn ? "font-medium text-warning" : "text-surface-foreground")}>
					{value}
				</span>
			</div>
			<ProgressBar value={progress} tone={warn ? "warning" : "primary"} />
		</div>
	);
}

/** 面板容器：层级靠 surface-raised + 1px 边框，不用大阴影 */
export function Panel({
	title,
	actions,
	children,
	className,
	bodyClassName,
}: {
	title?: ReactNode;
	actions?: ReactNode;
	children: ReactNode;
	className?: string;
	bodyClassName?: string;
}) {
	return (
		<section className={cn("flex min-h-0 flex-col rounded-card border border-border bg-surface-raised", className)}>
			{(title || actions) && (
				<header className="flex h-8 shrink-0 items-center justify-between gap-2 border-b border-border px-3">
					<span className="flex items-center gap-2 text-[11.5px] font-medium text-surface-foreground">{title}</span>
					{actions && <span className="flex items-center gap-1">{actions}</span>}
				</header>
			)}
			<div className={cn("min-h-0 flex-1", bodyClassName)}>{children}</div>
		</section>
	);
}

/** 小节标题（小号大写字母，Linear 风格） */
export function SectionLabel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<div className={cn("px-2 py-1 text-[10px] font-medium tracking-wider text-faint uppercase", className)}>
			{children}
		</div>
	);
}

export function EmptyState({
	icon = "icon-[lucide--inbox]",
	title,
	description,
	action,
	className,
}: {
	icon?: string;
	title: string;
	description?: string;
	action?: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center", className)}>
			<span className={cn(icon, "size-6 text-faint")} />
			<div className="text-[12.5px] font-medium text-surface-foreground">{title}</div>
			{description && <div className="max-w-[42ch] text-[11.5px] leading-5 text-muted">{description}</div>}
			{action && <div className="mt-1">{action}</div>}
		</div>
	);
}

/** 分段切换：主机库的卡片 / 列表 / 树形，设置页的分区切换都用它 */
export function Segmented<T extends string>({
	value,
	onChange,
	options,
	className,
}: {
	value: T;
	onChange: (value: T) => void;
	options: { value: T; label: string; icon?: string }[];
	className?: string;
}) {
	return (
		<div className={cn("flex h-6.5 items-center rounded-control border border-border bg-surface-sunk p-0.5", className)}>
			{options.map((opt) => (
				<button
					key={opt.value}
					type="button"
					onClick={() => onChange(opt.value)}
					className={cn(
						"flex h-full items-center gap-1 rounded-[4px] px-2 text-[11px] transition-colors",
						value === opt.value
							? "bg-surface-raised font-medium text-surface-foreground shadow-sm"
							: "text-muted hover:text-surface-foreground",
					)}
				>
					{opt.icon && <span className={cn(opt.icon, "size-3")} />}
					{opt.label}
				</button>
			))}
		</div>
	);
}
