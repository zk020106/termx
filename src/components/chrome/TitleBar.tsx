import { Kbd } from "@/components/ui/Button";
import type { Accent, ThemeMode } from "@/data/types";
import { cn } from "@/lib/cn";
import { windowControlsSide } from "@/lib/platform";
import { isTauri } from "@/lib/tauri";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "@/lib/window";
import { useThemeStore } from "@/store/theme";
import { useUiStore } from "@/store/ui";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

/** 自定义无边框标题栏（Vercel / Geist 现代硬朗质感）：居中为 Geist omni-search 搜索框与主题切换器 */
export function TitleBar() {
	const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);
	const [native, setNative] = useState(false);

	useEffect(() => setNative(isTauri()), []);

	const side = windowControlsSide();
	const controls = <WindowControls native={native} />;
	const brand = <Brand />;

	return (
		<header
			data-tauri-drag-region
			className="flex h-9.5 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3 select-none"
		>
			<div data-tauri-drag-region className="flex w-36 items-center">
				{side === "left" ? controls : brand}
			</div>

			{/* 居中命令面板入口与主题色快捷切换 */}
			<div className="flex items-center gap-2">
				<button
					type="button"
					onClick={() => setPaletteOpen(true)}
					className="group flex h-7 w-[380px] max-w-[40vw] items-center gap-2 rounded-control border border-border bg-surface-raised/60 px-2.5 text-[12px] text-muted transition-[color,border-color,background-color] duration-150 ease-out hover:border-surface-foreground/20 hover:bg-surface-raised hover:text-surface-foreground cursor-pointer"
				>
					<span className="icon-[lucide--search] size-3.5 text-muted transition-colors group-hover:text-surface-foreground" />
					<span className="flex-1 truncate text-left font-sans tracking-tight">搜索主机、执行命令、切换设置…</span>
					<Kbd>Ctrl K</Kbd>
				</button>

				<ThemeSwitcher />
			</div>

			<div className="flex w-36 items-center justify-end">
				{side === "left" ? <div className="mr-auto">{brand}</div> : controls}
			</div>
		</header>
	);
}

function ThemeSwitcher() {
	const mode = useThemeStore((s) => s.mode);
	const resolved = useThemeStore((s) => s.resolved);
	const setMode = useThemeStore((s) => s.setMode);
	const accent = useThemeStore((s) => s.accent);
	const setAccent = useThemeStore((s) => s.setAccent);
	const [open, setOpen] = useState(false);
	const ref = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		if (!open) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (ref.current && !ref.current.contains(e.target as Node)) {
				setOpen(false);
			}
		};
		window.addEventListener("mousedown", handleClickOutside);
		return () => window.removeEventListener("mousedown", handleClickOutside);
	}, [open]);

	const ACCENTS = [
		{ id: "vercel", name: "Vercel 蓝", bg: "bg-swatch-vercel" },
		{ id: "indigo", name: "靛蓝", bg: "bg-swatch-indigo" },
		{ id: "cyan", name: "青蓝", bg: "bg-swatch-cyan" },
		{ id: "emerald", name: "翠绿", bg: "bg-swatch-emerald" },
		{ id: "amber", name: "琥珀", bg: "bg-swatch-amber" },
		{ id: "rose", name: "玫瑰", bg: "bg-swatch-rose" },
		{ id: "steel", name: "银灰", bg: "bg-swatch-steel" },
	] as const;

	return (
		<div ref={ref} className="relative">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				className="flex h-7 items-center gap-1.5 rounded-control border border-border bg-surface-raised/60 px-2 text-[11px] font-medium text-muted hover:border-accent/40 hover:text-surface-foreground hover:bg-surface-raised transition-colors cursor-pointer"
				title="快速切换界面外观与主题色"
			>
				<span className={cn(resolved === "dark" ? "icon-[lucide--moon]" : "icon-[lucide--sun]", "size-3.5 text-accent")} />
				<span className="size-2 rounded-full bg-accent ring-1 ring-accent/40" />
				<span className="icon-[lucide--chevron-down] size-2.5 opacity-60" />
			</button>

			{open && (
				<div className="absolute right-0 top-full mt-1.5 z-50 w-60 rounded-card border border-border bg-surface-raised p-2.5 shadow-popover backdrop-blur-md space-y-2.5 animate-in fade-in zoom-in-95 duration-100">
					<div>
						<div className="text-[10px] font-mono text-faint mb-1.5 uppercase tracking-wider">外观模式</div>
						<div className="grid grid-cols-3 gap-1">
							{[
								{ id: "dark", label: "深色", icon: "icon-[lucide--moon]" },
								{ id: "light", label: "浅色", icon: "icon-[lucide--sun]" },
								{ id: "system", label: "系统", icon: "icon-[lucide--monitor]" },
							].map((m) => (
								<button
									key={m.id}
									type="button"
									onClick={() => setMode(m.id as ThemeMode)}
									className={cn(
										"flex h-6.5 items-center justify-center gap-1 rounded-control text-[11px] font-medium transition-colors cursor-pointer border",
										mode === m.id
											? "border-accent/40 bg-accent/15 text-accent"
											: "border-border/60 bg-surface/50 text-muted hover:bg-surface-raised hover:text-surface-foreground",
									)}
								>
									<span className={cn(m.icon, "size-3")} />
									<span>{m.label}</span>
								</button>
							))}
						</div>
					</div>

					<div className="border-t border-border/50 pt-2">
						<div className="text-[10px] font-mono text-faint mb-1.5 uppercase tracking-wider">主题色 (Accent)</div>
						<div className="grid grid-cols-7 gap-1">
							{ACCENTS.map((c) => (
								<button
									key={c.id}
									type="button"
									title={c.name}
									onClick={() => setAccent(c.id as Accent)}
									className={cn(
										"flex size-6 items-center justify-center rounded-full transition-transform cursor-pointer border",
										accent === c.id
											? "scale-110 border-surface-foreground ring-2 ring-accent shadow-xs"
											: "border-transparent hover:scale-105",
									)}
								>
									<span className={cn("size-3.5 rounded-full", c.bg)} />
								</button>
							))}
						</div>
					</div>
				</div>
			)}
		</div>
	);
}

function Brand() {
	return (
		<div data-tauri-drag-region className="flex items-center gap-2">
			<div className="flex size-5.5 items-center justify-center rounded-control bg-accent/20 border border-accent/40 text-accent shadow-xs font-bold transition-colors">
				<span className="icon-[lucide--terminal] size-3" />
			</div>
			<span className="font-sans text-[12.5px] font-semibold tracking-tight text-surface-foreground">TermX</span>
			<span className="rounded-[4px] border border-border bg-surface-raised px-1 py-0.5 font-mono text-[9px] text-muted">v0.1.0</span>
		</div>
	);
}

/** 原生壳里是真实窗口按钮；浏览器预览时降级为一个提示入口 */
function WindowControls({ native }: { native: boolean }) {
	if (!native) {
		return (
			<Link
				to="/welcome"
				className="rounded-full px-2.5 py-0.5 font-mono text-[10px] text-faint hover:bg-surface-raised hover:text-surface-foreground transition-colors"
				title="浏览器预览模式：窗口控制需在桌面端运行"
			>
				浏览器预览
			</Link>
		);
	}

	return (
		<div className="flex items-center text-muted gap-0.5">
			<WindowButton icon="icon-[lucide--minus]" label="最小化" onClick={() => void minimizeWindow()} />
			<WindowButton icon="icon-[lucide--square]" label="最大化" onClick={() => void toggleMaximizeWindow()} />
			<WindowButton icon="icon-[lucide--x]" label="关闭" danger onClick={() => void closeWindow()} />
		</div>
	);
}

function WindowButton({
	icon,
	label,
	onClick,
	danger,
}: {
	icon: string;
	label: string;
	onClick: () => void;
	danger?: boolean;
}) {
	return (
		<button
			type="button"
			aria-label={label}
			title={label}
			onClick={onClick}
			className={cn(
				"flex size-6.5 items-center justify-center rounded-md transition-colors cursor-pointer",
				danger ? "hover:bg-danger hover:text-white" : "hover:bg-surface-raised hover:text-surface-foreground",
			)}
		>
			<span className={cn(icon, "size-3.5")} />
		</button>
	);
}
