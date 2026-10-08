import { cn } from "@/lib/cn";
import type { ButtonHTMLAttributes, ReactNode } from "react";

type Variant = "primary" | "default" | "ghost" | "danger";
type Size = "sm" | "md";

/* Meta Design: Pill buttons with bold confident typography */
const variantClass: Record<Variant, string> = {
	primary: "bg-primary text-primary-foreground font-semibold hover:opacity-95 active:scale-[0.98] shadow-xs",
	default: "border border-border bg-surface text-surface-foreground font-medium hover:bg-surface-raised active:scale-[0.98] shadow-2xs",
	ghost: "text-muted hover:bg-surface-raised hover:text-surface-foreground active:scale-[0.98]",
	danger: "border border-danger/30 bg-danger/10 text-danger font-medium hover:bg-danger/20 active:scale-[0.98]",
};

const sizeClass: Record<Size, string> = {
	sm: "h-7 gap-1 px-3 text-[11.5px]",
	md: "h-8.5 gap-1.5 px-4 text-[12px]",
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
				"inline-flex shrink-0 items-center justify-center rounded-full tracking-tight transition-all duration-150 cursor-pointer disabled:pointer-events-none disabled:opacity-40",
				variantClass[variant],
				sizeClass[size],
				className,
			)}
		>
			{icon && <span className={cn(icon, size === "sm" ? "size-3" : "size-3.5")} />}
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
	...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon: string; label: string; active?: boolean }) {
	return (
		<button
			type="button"
			title={label}
			aria-label={label}
			{...props}
			className={cn(
				"flex size-7.5 shrink-0 items-center justify-center rounded-full transition-colors duration-150 cursor-pointer",
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

/** 键帽：快捷键提示（Meta 胶囊小标） */
export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<kbd
			className={cn(
				"inline-flex items-center gap-0.5 rounded-full border border-border bg-surface-raised px-1.5 py-px font-mono text-[9px] font-medium leading-4 text-muted",
				className,
			)}
		>
			{children}
		</kbd>
	);
}
