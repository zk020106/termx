import { Kbd } from "@/components/ui/Button";
import { cn } from "@/lib/cn";
import { windowControlsSide } from "@/lib/platform";
import { isTauri } from "@/lib/tauri";
import { closeWindow, minimizeWindow, toggleMaximizeWindow } from "@/lib/window";
import { useUiStore } from "@/store/ui";
import { useEffect, useState } from "react";
import { Link } from "react-router";

/** 自定义无边框标题栏（Meta 现代高阶质感）：居中为 Meta search-pill 胶囊搜索框 */
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

			{/* 居中命令面板入口：Meta 胶囊 Search-Pill 风格 */}
			<button
				type="button"
				onClick={() => setPaletteOpen(true)}
				className="group flex h-7 w-[430px] max-w-[46vw] items-center gap-2 rounded-full border border-border bg-surface-raised px-3 text-[12px] text-muted transition-all duration-150 hover:border-primary/50 hover:text-surface-foreground hover:shadow-xs cursor-pointer"
			>
				<span className="icon-[lucide--search] size-3.5 text-muted transition-colors group-hover:text-primary" />
				<span className="flex-1 truncate text-left font-sans tracking-tight">搜索主机、执行命令、切换设置…</span>
				<Kbd>Ctrl K</Kbd>
			</button>

			<div className="flex w-36 items-center justify-end">
				{side === "left" ? <div className="mr-auto">{brand}</div> : controls}
			</div>
		</header>
	);
}

function Brand() {
	return (
		<div data-tauri-drag-region className="flex items-center gap-2">
			<div className="flex size-5.5 items-center justify-center rounded-full bg-primary text-white shadow-xs">
				<span className="icon-[lucide--terminal] size-3" />
			</div>
			<span className="font-sans text-[12.5px] font-bold tracking-tight text-surface-foreground">TermX</span>
			<span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[9px] font-semibold text-primary">v0.2</span>
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
