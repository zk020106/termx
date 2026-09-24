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
	{ id: "snippets", to: "/snippets", icon: "icon-[lucide--terminal-square]", label: "片段" },
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
		<div className="flex h-full flex-col bg-surface text-surface-foreground antialiased selection:bg-primary/20 selection:text-surface-foreground">
			{/* Windows 自定义无边框标题栏：高密度、深黑、居中 Command Palette */}
			<header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3">
				{/* 左侧应用标识 */}
				<div className="flex w-36 items-center gap-2">
					<div className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
						<span className="icon-[lucide--terminal] size-3.5" />
					</div>
					<span className="font-sans text-[12px] font-semibold tracking-tight text-surface-foreground">
						TermX
					</span>
					<span className="font-mono text-[10px] text-faint">v0.2</span>
				</div>

				{/* 居中 Command Palette（Linear 风格，细腻深色输入框与极简按键帽） */}
				<Link
					to="/palette"
					className="group flex h-6 w-[420px] items-center gap-2 rounded border border-border bg-surface px-2.5 text-[12px] text-faint transition-colors hover:border-white/20 hover:text-surface-foreground"
				>
					<span className="icon-[lucide--search] size-3 text-muted transition-colors group-hover:text-primary" />
					<span className="flex-1 truncate font-sans tracking-tight">
						{command ?? "搜索主机、执行命令、切换设置…"}
					</span>
					<kbd className="flex items-center gap-0.5 rounded border border-border bg-surface-raised px-1 py-0.2 font-mono text-[9px] text-muted">
						Ctrl K
					</kbd>
				</Link>

				{/* 右侧 Windows 经典窗口三键（最小化、最大化、关闭） */}
				<div className="flex w-36 items-center justify-end text-muted">
					<button
						type="button"
						className="flex size-8 items-center justify-center hover:bg-surface-raised hover:text-surface-foreground"
						aria-label="最小化"
					>
						<span className="icon-[lucide--minus] size-3.5" />
					</button>
					<button
						type="button"
						className="flex size-8 items-center justify-center hover:bg-surface-raised hover:text-surface-foreground"
						aria-label="最大化"
					>
						<span className="icon-[lucide--square] size-3" />
					</button>
					<button
						type="button"
						className="flex size-8 items-center justify-center hover:bg-danger hover:text-primary-foreground"
						aria-label="关闭"
					>
						<span className="icon-[lucide--x] size-3.5" />
					</button>
				</div>
			</header>

			{/* 中部核心区：左侧极窄活动栏 + 右侧主工作区 */}
			<div className="flex min-h-0 flex-1">
				{/* Linear 风格活动栏（44px，微弱半透与高亮指示条） */}
				<nav className="flex w-11 shrink-0 flex-col items-center gap-1 border-r border-border bg-surface-sunk py-2">
					{activities.map((item) => {
						const on = item.id === current;
						return (
							<Link
								key={item.id}
								to={item.to}
								title={item.label}
								className={`group relative flex size-7 items-center justify-center rounded transition-colors ${
									on
										? "bg-surface-raised text-surface-foreground"
										: "text-muted hover:bg-surface-raised/60 hover:text-surface-foreground"
								}`}
							>
								{on && (
									<span className="absolute -left-2 h-3.5 w-0.5 rounded-r bg-primary" />
								)}
								<span className={`${item.icon} size-3.5`} />
							</Link>
						);
					})}
					<Link
						to="/settings"
						title="设置"
						className={`mt-auto group relative flex size-7 items-center justify-center rounded transition-colors ${
							current === "settings"
								? "bg-surface-raised text-surface-foreground"
								: "text-muted hover:bg-surface-raised/60 hover:text-surface-foreground"
						}`}
					>
						{current === "settings" && (
							<span className="absolute -left-2 h-3.5 w-0.5 rounded-r bg-primary" />
						)}
						<span className="icon-[lucide--settings] size-3.5" />
					</Link>
				</nav>

				{/* 视图内容容器 */}
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
		<footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-surface-sunk px-3 font-mono text-[11px] text-muted">
			{/* 连接状态 */}
			<div className="flex items-center gap-1.5">
				<span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
				<span className="font-sans font-medium text-surface-foreground">已连接</span>
			</div>

			<span className="text-border">/</span>
			<span>deploy@10.0.3.21:22</span>

			<span className="text-border">/</span>
			<span className="tabular-nums text-surface-foreground">28 ms</span>

			<span className="text-border">/</span>
			<span className="text-faint">UTF-8</span>

			<span className="text-border">/</span>
			<span className="flex items-center gap-1 text-warning">
				<span className="icon-[lucide--arrow-down-up] size-3" />
				<span className="font-sans">传输 2 项 · 64%</span>
			</span>

			<span className="text-border">/</span>
			<span className="font-sans text-faint">转发 3 条活跃</span>

			<div className="ml-auto flex items-center gap-2">
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
		DEV: "border-border bg-surface-raised text-muted",
	}[env];
	return (
		<span className={`rounded border px-1.5 font-mono text-[9px] font-semibold leading-4 tracking-wider ${tone}`}>
			{env}
		</span>
	);
}
