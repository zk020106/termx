import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

export type Activity =
	| "hosts"
	| "sftp"
	| "forward"
	| "snippets"
	| "keys"
	| "transfers"
	| "settings";

const activities: { id: Activity; to: string; icon: string; label: string }[] = [
	{ id: "hosts", to: "/", icon: "icon-[lucide--server]", label: "主机库" },
	{ id: "sftp", to: "/sftp", icon: "icon-[lucide--folder-tree]", label: "文件" },
	{ id: "forward", to: "/forward", icon: "icon-[lucide--waypoints]", label: "转发" },
	{ id: "snippets", to: "/snippets", icon: "icon-[lucide--square-terminal]", label: "片段" },
	{ id: "keys", to: "/keys", icon: "icon-[lucide--key-round]", label: "密钥" },
	{ id: "transfers", to: "/transfers", icon: "icon-[lucide--arrow-down-up]", label: "传输" },
];

export function WindowChrome({
	activity,
	command,
	children,
	status,
}: {
	activity?: Activity;
	command?: string;
	children: ReactNode;
	status?: ReactNode;
}) {
	const { pathname } = useLocation();
	const current = activity ?? fromPath(pathname);

	return (
		<div className="flex h-full flex-col bg-surface text-surface-foreground antialiased selection:bg-accent-soft selection:text-accent">
			{/* 顶栏：融合 macOS 信号灯与 Raycast 质感 Spotlight 搜索框 */}
			<header className="flex h-10 shrink-0 items-center justify-between border-b border-border bg-surface-sunk/80 px-3.5 backdrop-blur-md">
				{/* 窗口控制按钮 + 品牌标识 */}
				<div className="flex items-center gap-3.5">
					<div className="flex items-center gap-1.5 pr-2">
						<span className="size-3 rounded-full bg-[#FF5F57] shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)] transition-transform hover:scale-110" />
						<span className="size-3 rounded-full bg-[#FEBC2E] shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)] transition-transform hover:scale-110" />
						<span className="size-3 rounded-full bg-[#28C840] shadow-[inset_0_1px_1px_rgba(255,255,255,0.4)] transition-transform hover:scale-110" />
					</div>
					<div className="flex items-center gap-2">
						<span className="icon-[lucide--terminal] size-4 text-accent drop-shadow-[0_0_8px_var(--color-accent)]" />
						<span className="font-display text-[13px] font-semibold tracking-tight text-surface-foreground">
							TermX
						</span>
					</div>
				</div>

				{/* 居中命令面板入口（Raycast 悬浮胶囊质感） */}
				<Link
					to="/palette"
					className="group flex h-7 w-[460px] items-center gap-2.5 rounded-lg border border-white/[0.08] bg-surface-raised/70 px-3 text-[12px] text-faint shadow-[inset_0_1px_0_0_rgba(255,255,255,0.06)] transition-all hover:border-white/[0.16] hover:bg-surface-raised hover:text-surface-foreground"
				>
					<span className="icon-[lucide--search] size-3.5 text-faint transition-colors group-hover:text-accent" />
					<span className="flex-1 truncate tracking-normal font-sans">
						{command ?? "搜索主机、执行命令、切换设置…"}
					</span>
					<div className="flex items-center gap-1">
						<kbd className="rounded border border-white/10 bg-white/[0.05] px-1.5 py-0.5 font-mono text-[10px] text-muted shadow-[0_1px_0_rgba(255,255,255,0.08)]">
							Ctrl K
						</kbd>
					</div>
				</Link>

				{/* 右侧轻量状态快捷入口 */}
				<div className="flex w-28 items-center justify-end gap-1.5 text-muted">
					<Link
						to="/settings"
						className="grid size-7 place-items-center rounded-md hover:bg-white/[0.06] hover:text-surface-foreground transition-colors"
						title="设置"
					>
						<span className="icon-[lucide--sliders-horizontal] size-3.5" />
					</Link>
					<button
						type="button"
						className="grid size-7 place-items-center rounded-md hover:bg-white/[0.06] hover:text-surface-foreground transition-colors"
						title="分屏"
					>
						<span className="icon-[lucide--split] size-3.5" />
					</button>
				</div>
			</header>

			{/* 中部主内容区 */}
			<div className="flex min-h-0 flex-1">
				{/* 极细活动栏 */}
				<nav className="flex w-12 shrink-0 flex-col items-center gap-1.5 border-r border-border bg-surface-sunk py-3">
					{activities.map((item) => {
						const on = item.id === current;
						return (
							<Link
								key={item.id}
								to={item.to}
								title={item.label}
								className={`group relative grid size-8 place-items-center rounded-lg transition-all ${
									on
										? "bg-accent/10 text-accent ring-1 ring-accent/30 shadow-[0_0_12px_-2px_var(--color-accent)]"
										: "text-muted hover:bg-white/[0.05] hover:text-surface-foreground"
								}`}
							>
								{on && (
									<span className="absolute -left-[9px] h-3.5 w-[3px] rounded-r-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
								)}
								<span className={`${item.icon} size-4 transition-transform group-hover:scale-105`} />
							</Link>
						);
					})}
					<Link
						to="/settings"
						title="设置"
						className={`mt-auto group relative grid size-8 place-items-center rounded-lg transition-all ${
							current === "settings"
								? "bg-accent/10 text-accent ring-1 ring-accent/30 shadow-[0_0_12px_-2px_var(--color-accent)]"
								: "text-muted hover:bg-white/[0.05] hover:text-surface-foreground"
						}`}
					>
						{current === "settings" && (
							<span className="absolute -left-[9px] h-3.5 w-[3px] rounded-r-full bg-accent shadow-[0_0_8px_var(--color-accent)]" />
						)}
						<span className="icon-[lucide--settings] size-4 transition-transform group-hover:rotate-45" />
					</Link>
				</nav>

				{/* 页面主视图 */}
				<div className="flex min-w-0 flex-1 flex-col">{children}</div>
			</div>

			{/* 底部状态栏 */}
			{status ?? <DefaultStatus />}
		</div>
	);
}

function fromPath(pathname: string): Activity | undefined {
	if (pathname === "/" || pathname.startsWith("/hosts")) return "hosts";
	if (pathname.startsWith("/sftp") || pathname.startsWith("/editor")) return "sftp";
	if (pathname.startsWith("/forward")) return "forward";
	if (pathname.startsWith("/snippets")) return "snippets";
	if (pathname.startsWith("/keys")) return "keys";
	if (pathname.startsWith("/transfers")) return "transfers";
	if (pathname.startsWith("/settings")) return "settings";
	if (pathname.startsWith("/workspace") || pathname.startsWith("/monitor")) return "hosts";
	return undefined;
}

function DefaultStatus() {
	return (
		<footer className="flex h-6 shrink-0 items-center gap-4 border-t border-border bg-surface-sunk/90 px-3.5 font-mono text-[11px] text-muted backdrop-blur-md">
			{/* 连接状态带呼吸微光 */}
			<div className="flex items-center gap-2">
				<span className="relative flex size-2">
					<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-50" />
					<span className="relative inline-flex size-2 rounded-full bg-success shadow-[0_0_8px_var(--color-success)]" />
				</span>
				<span className="font-sans font-medium text-surface-foreground text-[11px]">已连接</span>
			</div>

			<span className="text-border">|</span>
			<span className="text-muted/80">deploy@10.0.3.21:22</span>

			<span className="text-border">|</span>
			<span className="flex items-center gap-1 text-surface-foreground">
				<span className="icon-[lucide--activity] size-3 text-success" />
				<span className="tabular-nums">28 ms</span>
			</span>

			<span className="text-border">|</span>
			<span className="text-faint">UTF-8</span>

			<span className="text-border">|</span>
			<span className="flex items-center gap-1.5 text-warning font-sans">
				<span className="icon-[lucide--arrow-down-up] size-3" />
				<span>传输 2 项 · 64%</span>
			</span>

			<span className="text-border">|</span>
			<span className="text-faint">端口转发: 3 条运行</span>

			<div className="ml-auto">
				<EnvPill env="PROD" />
			</div>
		</footer>
	);
}

export function EnvPill({ env }: { env: "PROD" | "STG" | "TEST" | "DEV" }) {
	const tone = {
		PROD: "border-env-prod/40 bg-env-prod/15 text-env-prod",
		STG: "border-env-stage/40 bg-env-stage/15 text-env-stage",
		TEST: "border-env-test/40 bg-env-test/15 text-env-test",
		DEV: "border-white/10 bg-white/[0.04] text-muted",
	}[env];
	return (
		<span className={`rounded-md border px-1.5 font-mono text-[9px] font-semibold tracking-wider leading-4 ${tone}`}>
			{env}
		</span>
	);
}
