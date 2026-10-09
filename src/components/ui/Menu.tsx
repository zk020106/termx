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

/**
 * 子菜单（Radix ContextMenuSub 的等价物）：悬停 / 点击展开到右侧，贴边时翻到左侧。
 * 用 fixed 定位，避免被父菜单的滚动容器裁掉。
 */
export function MenuSub({
	icon,
	label,
	hint,
	children,
	width = 180,
}: {
	icon?: ReactNode;
	label: string;
	/** 右侧的当前值提示（Netcatty 子菜单触发器右边的小字） */
	hint?: ReactNode;
	children: ReactNode;
	width?: number;
}) {
	const rowRef = useRef<HTMLDivElement | null>(null);
	const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
	const timer = useRef<number | null>(null);
	const openSub = () => {
		if (timer.current) window.clearTimeout(timer.current);
		const rect = rowRef.current?.getBoundingClientRect();
		if (!rect) return;
		const left = rect.right + width + 8 > window.innerWidth ? Math.max(8, rect.left - width - 4) : rect.right + 4;
		setPos({ left, top: rect.top - 6 });
	};
	const closeSoon = () => {
		if (timer.current) window.clearTimeout(timer.current);
		timer.current = window.setTimeout(() => setPos(null), 150);
	};
	return (
		<div ref={rowRef} onMouseEnter={openSub} onMouseLeave={closeSoon}>
			<button
				type="button"
				role="menuitem"
				aria-haspopup="menu"
				aria-expanded={pos !== null}
				onClick={openSub}
				className={cn(
					"group flex h-7.5 w-full items-center gap-2 rounded-lg px-2.5 text-left text-[11.5px] text-surface-foreground transition-all hover:bg-primary/15 hover:text-primary",
					pos && "bg-primary/10",
				)}
			>
				{typeof icon === "string" ? <span className={cn(icon, "size-3.5 shrink-0 text-muted group-hover:text-primary")} /> : icon}
				<span className="flex-1 truncate">{label}</span>
				{hint && <span className="flex shrink-0 items-center gap-1 text-[10px] text-faint">{hint}</span>}
				<span className="icon-[lucide--chevron-right] size-3 shrink-0 text-faint" />
			</button>
			{pos && (
				<div
					role="menu"
					aria-label={label}
					className="fixed z-[60] rounded-2xl border border-border/80 bg-surface/98 p-1.5 shadow-popover backdrop-blur-md ring-1 ring-black/5"
					style={{ left: pos.left, top: pos.top, width }}
					onMouseEnter={openSub}
					onMouseLeave={closeSoon}
				>
					{children}
				</div>
			)}
		</div>
	);
}

/** 不可点的小标题（Radix ContextMenuLabel） */
export function MenuLabel({ icon, label }: { icon?: string; label: string }) {
	return (
		<div className="flex items-center gap-2 px-2.5 pt-1 pb-1 text-[11px] font-medium text-muted">
			{icon && <span className={cn(icon, "size-3.5 shrink-0")} />}
			{label}
		</div>
	);
}
