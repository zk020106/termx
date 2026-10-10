import { cn } from "@/lib/cn";
import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

const fieldBase =
	"w-full rounded-control border border-border bg-surface-raised/40 px-2.5 py-1 text-[12px] text-surface-foreground placeholder:text-faint transition-colors focus:border-accent focus:bg-surface focus:outline-none focus:ring-1 focus:ring-accent/35 disabled:opacity-50";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
	return <input {...props} className={cn(fieldBase, "h-7 py-0", className)} />;
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
	return <textarea {...props} className={cn(fieldBase, "font-mono leading-5 resize-y", className)} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
	return (
		<div className="relative w-full">
			<select {...props} className={cn(fieldBase, "h-7 cursor-pointer py-0 appearance-none pr-6", className)}>
				{children}
			</select>
			<span aria-hidden="true" className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 icon-[lucide--chevron-down] size-3 text-muted" />
		</div>
	);
}

/** 表单行：左侧标签 + 右侧控件，纵向堆叠时用 block */
export function Field({
	label,
	hint,
	error,
	required,
	children,
	className,
}: {
	label: string;
	hint?: string;
	error?: string;
	required?: boolean;
	children: ReactNode;
	className?: string;
}) {
	const errorId = useId();
	return (
		<label className={cn("block space-y-1.5", className)}>
			<span className="flex items-baseline gap-1.5">
				<span className="text-[11.5px] font-medium text-surface-foreground">{label}</span>
				{required && <span className="text-danger">*</span>}
				{hint && <span className="text-[10.5px] text-faint">{hint}</span>}
			</span>
			{children}
			{error && (
				<span id={errorId} role="alert" className="flex items-center gap-1 text-[10.5px] text-danger">
					<span className="icon-[lucide--circle-alert] size-3" />
					{error}
				</span>
			)}
		</label>
	);
}

/** 只读信息块，用于抽屉里的「指纹 / 路径」等 */
export function ReadonlyValue({ children, mono = true }: { children: ReactNode; mono?: boolean }) {
	return (
		<div
			className={cn(
				"flex h-7 items-center gap-2 rounded-control border border-border bg-surface-sunk px-2 text-[11.5px] text-muted",
				mono && "font-mono",
			)}
		>
			{children}
		</div>
	);
}
