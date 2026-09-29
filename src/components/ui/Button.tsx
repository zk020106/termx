import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "default" | "ghost" | "danger";
type Size = "sm" | "md";

const variantClass: Record<Variant, string> = {
	primary: "bg-primary text-primary-foreground hover:brightness-110",
	default: "border border-border bg-surface text-surface-foreground hover:bg-surface-raised",
	ghost: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
	danger: "border border-danger/40 bg-danger/10 text-danger hover:bg-danger/20",
};

const sizeClass: Record<Size, string> = {
	sm: "h-6 gap-1 px-2 text-[11.5px]",
	md: "h-8 gap-1.5 px-2.5 text-[12px]",
};

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: Variant;
	size?: Size;
	icon?: string;
	/** 右侧快捷键提示 */
	kbd?: string;
}

export function Button({
	variant = "default",
	size = "md",
	icon,
	kbd,
	className,
	children,
	...props
}: ButtonProps) {
	return (
		<button
			type="button"
			{...props}
			className={cn(
				"inline-flex shrink-0 items-center justify-center rounded-control font-medium tracking-tight transition-colors disabled:pointer-events-none disabled:opacity-45",
				variantClass[variant],
				sizeClass[size],
				className,
			)}
		>
			{icon && <span className={cn(icon, size === "sm" ? "size-3" : "size-3.5")} />}
			{children}
			{kbd && <Kbd className="ml-1">{kbd}</Kbd>}
		</button>
	);
}

export function IconButton({
	icon,
	label,
	className,
	active,
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean }) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			{...props}
			className={cn(
				"flex size-7 shrink-0 items-center justify-center rounded-control transition-colors",
				active
					? "bg-surface-raised text-surface-foreground"
					: "text-muted hover:bg-surface-raised hover:text-surface-foreground",
				className,
			)}
		>
			<span className={cn(icon, "size-3.5")} />
		</button>
	);
}

/** 键帽：遍布界面的快捷键提示（DESIGN.md「Keyboard hints everywhere」） */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<kbd
			className={cn(
				"inline-flex items-center gap-0.5 rounded border border-border bg-surface-raised px-1 py-px font-mono text-[9px] leading-4 text-muted",
				className,
			)}
		>
			{children}
		</kbd>
	);
}
