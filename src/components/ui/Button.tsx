import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "default" | "ghost" | "danger" | "solid";
type Size = "sm" | "md";

/* Geist Design: Crisp 6px rectangular buttons with theme accent typography */
const variantClass: Record<Variant, string> = {
	primary: "bg-accent text-accent-foreground font-medium hover:opacity-90 shadow-xs border border-transparent",
	default: "border border-border bg-surface-raised/50 text-surface-foreground font-normal hover:bg-surface-raised hover:border-surface-foreground/20 shadow-2xs",
	ghost: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
	danger: "border border-danger/25 bg-danger/10 text-danger font-medium hover:bg-danger/20",
	solid: "bg-surface-foreground text-surface font-medium hover:opacity-90 shadow-xs border border-transparent",
};

const tapScale = "motion-safe:enabled:active:scale-[0.98]";

const sizeClass: Record<Size, string> = {
	sm: "h-6.5 gap-1 px-2.5 text-[11px]",
	md: "h-7.5 gap-1.5 px-3 text-[12px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
	icon?: string;
	/** 右侧快捷键提示 */
	kbd?: string;
	/** 静态按钮：关闭按压缩放动效 */
	static?: boolean;
}

export function Button({
	variant = "default",
	size = "md",
	icon,
	kbd,
	static: isStatic,
	className,
	children,
	...props
}: ButtonProps) {
	const isPlayIcon = icon?.includes("lucide--play");
	const hasChildren = Boolean(children);
	// 光学微调：当左侧有图标且包含文字时，图标侧内边距减少 1px 达到视觉居中平衡
	const opticalPadding = icon && hasChildren
		? size === "sm" ? "h-6.5 gap-1 pl-2 pr-2.5 text-[11px]" : "h-7.5 gap-1.5 pl-2.5 pr-3 text-[12px]"
		: sizeClass[size];

	return (
		<button
			type="button"
			{...props}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-control tracking-tight transition-[color,background-color,border-color,transform,box-shadow,opacity] duration-150 ease-out cursor-pointer disabled:pointer-events-none disabled:opacity-40",
				variantClass[variant],
				!isStatic && tapScale,
				opticalPadding,
				className,
			)}
		>
			{icon && (
				<span
					className={cn(
						icon,
						size === "sm" ? "size-3" : "size-3.5",
						isPlayIcon && "translate-x-0.5",
					)}
				/>
			)}
			{children}
			{kbd && <Kbd className="ml-1.5">{kbd}</Kbd>}
		</button>
	);
}

export function IconButton({
	icon,
	label,
	className,
	active,
	static: isStatic,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean; static?: boolean }) {
	const isPlayIcon = icon?.includes("lucide--play");

	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			{...props}
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-control border border-transparent transition-[color,background-color,border-color,transform] duration-150 ease-out cursor-pointer disabled:pointer-events-none disabled:opacity-40",
				!isStatic && tapScale,
				active
					? "border-border bg-surface-raised text-surface-foreground"
					: "text-muted hover:border-border/60 hover:bg-surface-raised hover:text-surface-foreground",
				className,
			)}
		>
			<span className={cn(icon, "size-3.5", isPlayIcon && "translate-x-0.5")} />
		</button>
	);
}

/** 键帽：快捷键提示（Geist 矩形精密小标） */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<kbd
			className={cn(
				"inline-flex items-center gap-0.5 rounded-[4px] border border-border bg-surface-raised/80 px-1 py-0.2 font-mono text-[9px] font-medium leading-tight text-muted",
				className,
			)}
		>
			{children}
		</kbd>
	);
}
