import { cn } from "@/lib/cn";
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

/* =============================================================================
 * 右键菜单基础件 —— 沿用 termx 工作区原有的菜单外观（圆角浮层 + 图标 + 快捷键），
 * 抽出来给终端 / 标签 / 主机 / SFTP / 片段 / 转发 / 密钥等所有右键菜单共用。
 *
 * Netcatty 用的是 Radix ContextMenu；termx 保留自己的浮层实现（UI 风格一致），
 * 行为上对齐：点外面 / 再次右键 / Esc 关闭，贴边时自动翻转到视口内，禁用项不可点。
 * ========================================================================== */

export function ContextMenu({
	x,
	y,
	width = 215,
	onClose,
	children,
	label,
}: {
	x: number;
	y: number;
	width?: number;
	onClose: () => void;
	children: ReactNode;
	label?: string;
}) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState({ left: x, top: y });

	// 先按点击点放，量出真实高度后再夹回视口（Radix collision 的等价物）
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const left = Math.max(8, Math.min(x, window.innerWidth - rect.width - 8));
		const top = y + rect.height > window.innerHeight - 8 ? Math.max(8, y - rect.height) : y;
		setPos({ left, top });
	}, [x, y]);

	useLayoutEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				event.stopPropagation();
				onClose();
			}
		};
		window.addEventListener("keydown", onKey, true);
		return () => window.removeEventListener("keydown", onKey, true);
	}, [onClose]);

	return (
		<>
			<div
				className="fixed inset-0 z-40"
				onMouseDown={onClose}
				onContextMenu={(event) => {
					event.preventDefault();
					onClose();
				}}
			/>
			<div
				ref={ref}
				role="menu"
				aria-label={label}
				className="fixed z-50 max-h-[calc(100vh-16px)] overflow-y-auto rounded-2xl border border-border/80 bg-surface/98 p-1.5 shadow-popover backdrop-blur-md ring-1 ring-black/5"
				style={{ left: pos.left, top: pos.top, width }}
				onContextMenu={(event) => event.preventDefault()}
			>
				{children}
			</div>
		</>
	);
}

export function MenuHeader({ title, subtitle, icon = "icon-[lucide--square-terminal]" }: { title: string; subtitle?: string; icon?: string }) {
	return (
		<div className="flex items-center gap-2 border-b border-border px-2.5 pt-1 pb-1.5 text-[10px] text-faint">
			<span className={cn(icon, "size-3 text-muted")} />
			<span className="text-muted">{title}</span>
			{subtitle && <span className="truncate font-mono">{subtitle}</span>}
		</div>
	);
}

export function MenuSeparator() {
	return <div className="my-1 border-t border-border" />;
}

export function MenuItem({
	icon,
	label,
	kbd,
	disabled,
	danger,
	checked,
	onClick,
}: {
	icon: string;
	label: string;
	kbd?: string;
	disabled?: boolean;
	danger?: boolean;
	checked?: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			role="menuitem"
			disabled={disabled}
			onClick={onClick}
			className={cn(
				"group flex h-7.5 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11.5px] transition-all cursor-pointer select-none",
				disabled && "cursor-not-allowed opacity-40 text-faint",
				!disabled && !danger && "text-surface-foreground hover:bg-primary/15 hover:text-primary font-normal hover:font-medium",
				!disabled && danger && "text-danger hover:bg-danger/15 hover:text-danger font-normal hover:font-medium",
			)}
		>
			<span
				className={cn(
					icon,
					"size-3.5 shrink-0 transition-colors",
					disabled ? "text-faint" : danger ? "text-danger" : "text-muted group-hover:text-primary",
				)}
			/>
			<span className="flex-1 truncate">{label}</span>
			{checked && <span className="icon-[lucide--check] size-3 text-primary" />}
			{kbd && <span className="font-mono text-[9.5px] text-faint group-hover:text-primary/80">{kbd}</span>}
		</button>
	);
}
