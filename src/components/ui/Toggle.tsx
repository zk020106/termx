import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

export function Switch({
	checked,
	onChange,
	disabled,
	label,
	className,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	disabled?: boolean;
	label?: string;
	className?: string;
}) {
	return (
		<button
			type="button"
			role="switch"
			aria-checked={checked}
			aria-label={label}
			disabled={disabled}
			onClick={() => onChange(!checked)}
			className={cn(
				"relative h-4 w-7 shrink-0 rounded-full border transition-colors disabled:opacity-45",
				checked ? "border-primary bg-primary" : "border-border bg-surface-sunk",
				className,
			)}
		>
			<span
				className={cn(
					"absolute top-0.5 size-2.5 rounded-full transition-[left] duration-150",
					checked ? "left-3.5 bg-primary-foreground" : "left-0.5 bg-faint",
				)}
			/>
		</button>
	);
}

export function Checkbox({
	checked,
	onChange,
	label,
	description,
	disabled,
	className,
}: {
	checked: boolean;
	onChange: (checked: boolean) => void;
	label?: ReactNode;
	description?: string;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<label
			className={cn(
				"flex items-start gap-2",
				disabled ? "cursor-not-allowed opacity-45" : "cursor-pointer",
				className,
			)}
		>
			<button
				type="button"
				role="checkbox"
				aria-checked={checked}
				disabled={disabled}
				onClick={() => onChange(!checked)}
				className={cn(
					"mt-0.5 flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border transition-colors",
					checked ? "border-primary bg-primary text-primary-foreground" : "border-border bg-surface",
				)}
			>
				{checked && <span className="icon-[lucide--check] size-2.5" />}
			</button>
			{(label || description) && (
				<span className="min-w-0 space-y-0.5">
					{label && <span className="block text-[11.5px] text-surface-foreground">{label}</span>}
					{description && <span className="block text-[10.5px] leading-4 text-faint">{description}</span>}
				</span>
			)}
		</label>
	);
}

/** 设置行：左标题右控件的横向排布 */
export function SettingRow({
	title,
	description,
	children,
	className,
}: {
	title: string;
	description?: string;
	children: ReactNode;
	className?: string;
}) {
	return (
		<div className={cn("flex items-center justify-between gap-4 border-b border-border px-3 py-2.5 last:border-b-0", className)}>
			<div className="min-w-0">
				<div className="text-[11.5px] text-surface-foreground">{title}</div>
				{description && <div className="mt-0.5 text-[10.5px] leading-4 text-faint">{description}</div>}
			</div>
			<div className="flex shrink-0 items-center gap-2">{children}</div>
		</div>
	);
}
