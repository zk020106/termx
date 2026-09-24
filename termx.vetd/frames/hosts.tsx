export const frame = { width: 1440, height: 900, title: "主机库" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

const groups = [
	{ name: "订单核心集群", count: 3, icon: "icon-[lucide--layers]", env: "PROD" as const },
	{ name: "网关与基础设施", count: 3, icon: "icon-[lucide--network]", env: "DEV" as const },
	{ name: "持久化数据节点", count: 2, icon: "icon-[lucide--database]", env: "STG" as const },
];

const hosts = [
	{
		name: "order-api-01",
		ip: "10.0.3.21",
		user: "deploy",
		env: "PROD" as const,
		os: "Ubuntu 22.04 LTS",
		live: "28 ms",
		on: true,
		icon: "icon-[simple-icons--ubuntu]",
		iconBg: "bg-[#E95420]/15 text-[#E95420] border-[#E95420]/30",
		spec: "8C 32G · 华东1",
	},
	{
		name: "order-api-02",
		ip: "10.0.3.22",
		user: "deploy",
		env: "PROD" as const,
		os: "Ubuntu 22.04 LTS",
		live: "31 ms",
		on: true,
		icon: "icon-[simple-icons--ubuntu]",
		iconBg: "bg-[#E95420]/15 text-[#E95420] border-[#E95420]/30",
		spec: "8C 32G · 华东1",
	},
	{
		name: "order-stage",
		ip: "10.1.4.8",
		user: "deploy",
		env: "STG" as const,
		os: "Debian 12",
		live: "离线",
		on: false,
		icon: "icon-[simple-icons--debian]",
		iconBg: "bg-[#D70A53]/15 text-[#D70A53] border-[#D70A53]/30",
		spec: "4C 16G · 测试网",
	},
	{
		name: "bastion-sh",
		ip: "10.0.0.4",
		user: "ops",
		env: "DEV" as const,
		os: "Rocky Linux 9",
		live: "12 ms",
		on: true,
		icon: "icon-[simple-icons--rockylinux]",
		iconBg: "bg-[#10B981]/15 text-[#10B981] border-[#10B981]/30",
		spec: "2C 4G · 核心跳板",
	},
	{
		name: "redis-test-01",
		ip: "10.2.1.15",
		user: "redis",
		env: "TEST" as const,
		os: "CentOS 7.9",
		live: "离线",
		on: false,
		icon: "icon-[simple-icons--centos]",
		iconBg: "bg-[#9333EA]/15 text-[#9333EA] border-[#9333EA]/30",
		spec: "4C 8G · 内存缓存",
	},
	{
		name: "log-agg-node",
		ip: "10.0.8.3",
		user: "ops",
		env: "DEV" as const,
		os: "Ubuntu 24.04",
		live: "19 ms",
		on: true,
		icon: "icon-[simple-icons--ubuntu]",
		iconBg: "bg-[#E95420]/15 text-[#E95420] border-[#E95420]/30",
		spec: "16C 64G · 日志汇聚",
	},
	{
		name: "pg-primary-01",
		ip: "10.2.0.11",
		user: "postgres",
		env: "PROD" as const,
		os: "Debian 12 Bookworm",
		live: "16 ms",
		on: true,
		icon: "icon-[simple-icons--debian]",
		iconBg: "bg-[#D70A53]/15 text-[#D70A53] border-[#D70A53]/30",
		spec: "32C 128G · NVMe",
	},
	{
		name: "pg-replica-02",
		ip: "10.2.0.12",
		user: "postgres",
		env: "STG" as const,
		os: "Debian 12 Bookworm",
		live: "22 ms",
		on: true,
		icon: "icon-[simple-icons--debian]",
		iconBg: "bg-[#D70A53]/15 text-[#D70A53] border-[#D70A53]/30",
		spec: "16C 64G · 同步从库",
	},
];

export default function Hosts() {
	return (
		<WindowChrome activity="hosts">
			<div className="flex min-h-0 flex-1">
				{/* 侧边导航栏：精细化分组与书签 */}
				<aside className="flex w-[230px] shrink-0 flex-col border-r border-border bg-surface-sunk/60 px-3 py-3.5">
					<div className="group mb-3 flex h-8 items-center gap-2 rounded-lg border border-white/[0.06] bg-surface-raised/60 px-2.5 text-[12px] text-faint transition-all hover:border-white/[0.12] hover:bg-surface-raised">
						<span className="icon-[lucide--search] size-3.5 transition-colors group-hover:text-accent" />
						<span>快速定位主机…</span>
					</div>

					<div className="mb-1.5 flex items-center justify-between px-1 text-[10px] font-mono font-medium tracking-wider text-faint uppercase">
						<span>主机分组</span>
						<span className="icon-[lucide--folder-plus] size-3 text-muted/60 hover:text-surface-foreground cursor-pointer" />
					</div>
					<div className="flex flex-col gap-0.5">
						{groups.map((g, i) => (
							<div
								key={g.name}
								className={`flex h-8 items-center justify-between rounded-lg px-2.5 text-[13px] transition-colors cursor-pointer ${
									i === 0
										? "bg-accent-soft font-medium text-accent"
										: "text-muted hover:bg-white/[0.04] hover:text-surface-foreground"
								}`}
							>
								<span className="flex items-center gap-2 truncate">
									<span className={`${g.icon} size-3.5 text-faint`} />
									{g.name}
								</span>
								<span className="font-mono text-[11px] text-faint">{g.count}</span>
							</div>
						))}
					</div>

					<div className="mt-5 mb-1.5 flex items-center justify-between px-1 text-[10px] font-mono font-medium tracking-wider text-faint uppercase">
						<span>常用星标</span>
						<span className="icon-[lucide--star] size-3 text-warning/80" />
					</div>
					<div className="flex flex-col gap-0.5">
						<Link
							to="/"
							className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted hover:bg-white/[0.04] hover:text-surface-foreground transition-colors"
						>
							<span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
							<span className="truncate">order-api-01</span>
							<span className="ml-auto font-mono text-[10px] text-env-prod">PROD</span>
						</Link>
						<Link
							to="/"
							className="flex h-8 items-center gap-2 rounded-lg px-2.5 text-[13px] text-muted hover:bg-white/[0.04] hover:text-surface-foreground transition-colors"
						>
							<span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
							<span className="truncate">bastion-sh</span>
							<span className="ml-auto font-mono text-[10px] text-faint">DEV</span>
						</Link>
					</div>

					{/* 底部存储与密钥快捷入口 */}
					<div className="mt-auto rounded-xl border border-white/[0.06] bg-surface p-3 shadow-inner">
						<div className="flex items-center justify-between text-[11px]">
							<span className="font-medium text-surface-foreground">SSH 密钥代理</span>
							<span className="text-success font-mono">2 就绪</span>
						</div>
						<div className="mt-1 text-[10px] text-faint font-mono">id_ed25519_prod · active</div>
					</div>
				</aside>

				{/* 主展示区：对标 Netcatty 现代高级卡片阵列 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
					{/* 顶层工具栏 */}
					<div className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
						<div className="flex items-center gap-3">
							<h1 className="font-display text-lg font-semibold tracking-tight">全部主机</h1>
							<span className="rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-0.5 font-mono text-[11px] text-muted">
								共 8 台 · 6 台在线
							</span>
						</div>

						<div className="flex items-center gap-3">
							{/* 视图切换胶囊 */}
							<div className="flex h-8 items-center rounded-lg border border-white/[0.08] bg-surface-sunk p-0.5 text-[12px]">
								<button
									type="button"
									className="flex items-center gap-1.5 rounded-md bg-surface-raised px-2.5 py-1 text-surface-foreground font-medium shadow-sm"
								>
									<span className="icon-[lucide--layout-grid] size-3.5 text-accent" />
									卡片
								</button>
								<button type="button" className="flex items-center gap-1.5 px-2.5 py-1 text-muted hover:text-surface-foreground">
									<span className="icon-[lucide--list] size-3.5" />
									列表
								</button>
								<button type="button" className="flex items-center gap-1.5 px-2.5 py-1 text-muted hover:text-surface-foreground">
									<span className="icon-[lucide--folder-tree] size-3.5" />
									拓扑
								</button>
							</div>

							<Link
								to="/host-edit"
								className="flex h-8 items-center gap-1.5 rounded-lg bg-accent px-3 text-[12px] font-medium text-primary-foreground shadow-[0_0_16px_-3px_var(--color-accent)] transition-all hover:brightness-110 active:scale-95"
							>
								<span className="icon-[lucide--plus] size-3.5" />
								新建主机
							</Link>
						</div>
					</div>

					{/* 主机卡片阵列：高质感材质与发光徽章 */}
					<div className="grid flex-1 grid-cols-3 content-start gap-4 p-6">
						{hosts.map((h) => (
							<Link
								key={h.name}
								to="/"
								className="group relative flex flex-col justify-between rounded-xl border border-white/[0.07] bg-surface-raised/60 p-4 transition-all duration-200 hover:-translate-y-0.5 hover:border-white/[0.16] hover:bg-surface-raised hover:shadow-[0_8px_24px_-8px_rgba(0,0,0,0.6)]"
							>
								{/* 顶部头部：立体系统徽标 + 主机名 + 环境胶囊 */}
								<div>
									<div className="flex items-start gap-3">
										{/* OS 品牌徽章 */}
										<div
											className={`grid size-10 shrink-0 place-items-center rounded-xl border ${h.iconBg} shadow-inner transition-transform group-hover:scale-105`}
										>
											<span className={`${h.icon} size-5`} />
										</div>

										<div className="min-w-0 flex-1">
											<div className="flex items-center justify-between gap-1">
												<span className="truncate font-display text-[14px] font-semibold text-surface-foreground group-hover:text-accent transition-colors">
													{h.name}
												</span>
												<EnvPill env={h.env} />
											</div>
											<div className="mt-0.5 font-mono text-[11px] text-muted tracking-tight truncate">
												{h.user}@{h.ip}
											</div>
										</div>
									</div>

									{/* 规格标签 */}
									<div className="mt-3 flex items-center gap-2">
										<span className="rounded bg-surface-sunk px-2 py-0.5 font-mono text-[10px] text-faint">
											{h.spec}
										</span>
										<span className="truncate text-[11px] text-faint">{h.os}</span>
									</div>
								</div>

								{/* 底部状态与操作触发 */}
								<div className="mt-4 flex items-center justify-between border-t border-border/40 pt-3 text-[11px]">
									{/* 在线状态带呼吸灯 */}
									<div className="flex items-center gap-1.5 font-mono">
										{h.on ? (
											<>
												<span className="relative flex size-2">
													<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-success opacity-40" />
													<span className="relative inline-flex size-2 rounded-full bg-success shadow-[0_0_6px_var(--color-success)]" />
												</span>
												<span className="font-semibold text-success tabular-nums">{h.live}</span>
											</>
										) : (
											<>
												<span className="size-2 rounded-full bg-border" />
												<span className="text-faint">离线</span>
											</>
										)}
									</div>

									<div className="flex items-center gap-2 text-faint group-hover:text-accent transition-colors">
										<span className="text-[11px] font-medium">一键终端</span>
										<span className="icon-[lucide--chevron-right] size-3.5 transition-transform group-hover:translate-x-0.5" />
									</div>
								</Link>
							))}
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
