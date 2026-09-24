export const frame = { width: 1440, height: 900, title: "主机库" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

const groups = [
	{ name: "全部主机", count: 8, active: true },
	{ name: "订单核心集群", count: 3 },
	{ name: "网关与基础设施", count: 3 },
	{ name: "持久化数据节点", count: 2 },
];

const hosts = [
	{
		name: "order-api-01",
		user: "deploy@10.0.3.21",
		env: "PROD" as const,
		os: "Ubuntu 22.04 LTS",
		live: "28 ms",
		on: true,
		icon: "icon-[simple-icons--ubuntu]",
		spec: "8C 32G · 华东1",
	},
	{
		name: "order-api-02",
		user: "deploy@10.0.3.22",
		env: "PROD" as const,
		os: "Ubuntu 22.04 LTS",
		live: "31 ms",
		on: true,
		icon: "icon-[simple-icons--ubuntu]",
		spec: "8C 32G · 华东1",
	},
	{
		name: "order-stage",
		user: "deploy@10.1.4.8",
		env: "STG" as const,
		os: "Debian 12",
		live: "离线",
		on: false,
		icon: "icon-[simple-icons--debian]",
		spec: "4C 16G · 测试网",
	},
	{
		name: "bastion-sh",
		user: "ops@10.0.0.4",
		env: "DEV" as const,
		os: "Rocky Linux 9",
		live: "12 ms",
		on: true,
		icon: "icon-[simple-icons--rockylinux]",
		spec: "2C 4G · 核心跳板",
	},
	{
		name: "redis-test-01",
		user: "redis@10.2.1.15",
		env: "TEST" as const,
		os: "CentOS 7.9",
		live: "离线",
		on: false,
		icon: "icon-[simple-icons--centos]",
		spec: "4C 8G · 缓存集群",
	},
	{
		name: "log-agg-node",
		user: "ops@10.0.8.3",
		env: "DEV" as const,
		os: "Ubuntu 24.04 LTS",
		live: "19 ms",
		on: true,
		icon: "icon-[simple-icons--ubuntu]",
		spec: "8C 16G · ES 收集",
	},
	{
		name: "pg-primary-01",
		user: "postgres@10.2.0.11",
		env: "PROD" as const,
		os: "Debian 12",
		live: "16 ms",
		on: true,
		icon: "icon-[simple-icons--debian]",
		spec: "16C 64G · 主库",
	},
	{
		name: "pg-replica-01",
		user: "postgres@10.2.0.12",
		env: "STG" as const,
		os: "Debian 12",
		live: "22 ms",
		on: true,
		icon: "icon-[simple-icons--debian]",
		spec: "16C 64G · 从库",
	},
];

export default function Hosts() {
	return (
		<WindowChrome activity="hosts">
			<div className="flex min-h-0 flex-1">
				{/* 左侧主机分类导航 */}
				<aside className="flex w-[210px] shrink-0 flex-col border-r border-border bg-surface-sunk p-2.5">
					<div className="mb-2 flex h-7 items-center gap-1.5 rounded border border-border bg-surface px-2 text-[11px] text-faint">
						<span className="icon-[lucide--search] size-3 text-muted" />
						<span className="truncate">搜索名称、IP、标签…</span>
					</div>

					<div className="mt-1 space-y-0.5">
						<div className="px-2 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">分组</div>
						{groups.map((g) => (
							<div
								key={g.name}
								className={`flex h-7 items-center justify-between rounded px-2 text-[12px] transition-colors cursor-pointer ${
									g.active
										? "bg-surface-raised font-medium text-surface-foreground border border-border"
										: "text-muted hover:bg-surface hover:text-surface-foreground"
								}`}
							>
								<span className="truncate">{g.name}</span>
								<span className="font-mono text-[10px] text-faint">{g.count}</span>
							</div>
						))}
					</div>

					<div className="mt-4 space-y-0.5">
						<div className="px-2 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">环境筛选</div>
						{[
							{ label: "生产 (PROD)", count: 3, dot: "bg-env-prod" },
							{ label: "预发 (STG)", count: 2, dot: "bg-env-stage" },
							{ label: "测试 (TEST)", count: 1, dot: "bg-env-test" },
							{ label: "开发 (DEV)", count: 2, dot: "bg-env-dev" },
						].map((e) => (
							<div key={e.label} className="flex h-7 items-center justify-between rounded px-2 text-[12px] text-muted hover:bg-surface hover:text-surface-foreground cursor-pointer">
								<span className="flex items-center gap-1.5 truncate">
									<span className={`size-1.5 rounded-full ${e.dot}`} />
									{e.label}
								</span>
								<span className="font-mono text-[10px] text-faint">{e.count}</span>
							</div>
						))}
					</div>

					<div className="mt-auto border-t border-border pt-2">
						<button
							type="button"
							className="flex h-7 w-full items-center justify-center gap-1.5 rounded border border-border bg-surface text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--download] size-3" />
							导入 ~/.ssh/config
						</button>
					</div>
				</aside>

				{/* 右侧卡片工作区 */}
				<div className="flex min-w-0 flex-1 flex-col bg-surface">
					{/* 操作顶栏 */}
					<div className="flex h-10 items-center justify-between border-b border-border px-4">
						<div className="flex items-center gap-2">
							<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">主机库</h1>
							<span className="text-[11px] text-muted">8 台主机 · 6 台在线</span>
						</div>

						<div className="flex items-center gap-2">
							{/* 视图切换胶囊 */}
							<div className="flex h-6.5 items-center rounded border border-border bg-surface-sunk p-0.5 text-[11px]">
								<span className="rounded bg-surface-raised px-2 py-0.5 font-medium text-surface-foreground shadow-sm">卡片</span>
								<span className="px-2 py-0.5 text-muted hover:text-surface-foreground cursor-pointer">列表</span>
								<span className="px-2 py-0.5 text-muted hover:text-surface-foreground cursor-pointer">树形</span>
							</div>

							<Link
								to="/host-edit"
								className="flex h-6.5 items-center gap-1.5 rounded bg-primary px-2.5 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
							>
								<span className="icon-[lucide--plus] size-3" />
								新建主机
							</Link>
						</div>
					</div>

					{/* 4列卡片网格 */}
					<div className="grid flex-1 grid-cols-4 content-start gap-2.5 overflow-y-auto p-4">
						{hosts.map((h) => (
							<Link
								key={h.name}
								to="/"
								className="group flex flex-col justify-between rounded-md border border-border bg-surface-raised p-3 transition-colors hover:border-white/20"
							>
								<div>
									<div className="flex items-center justify-between gap-1.5">
										<div className="flex items-center gap-1.5 min-w-0">
											<span className={`${h.icon} size-3.5 text-muted group-hover:text-surface-foreground`} />
											<span className="truncate font-mono text-[12px] font-medium text-surface-foreground">{h.name}</span>
										</div>
										<EnvPill env={h.env} />
									</div>

									<div className="mt-2 font-mono text-[11px] text-muted truncate">
										{h.user}
									</div>

									<div className="mt-1 text-[11px] text-faint">
										{h.spec}
									</div>
								</div>

								<div className="mt-3 flex items-center justify-between border-t border-border/40 pt-2 text-[10.5px]">
									<span className="text-faint truncate">{h.os}</span>
									<span className={`flex items-center gap-1 font-mono tabular-nums ${h.on ? "text-success" : "text-faint"}`}>
										<span className={`size-1.5 rounded-full ${h.on ? "bg-success" : "bg-border"}`} />
										{h.live}
									</span>
								</div>
							</Link>
						))}
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
