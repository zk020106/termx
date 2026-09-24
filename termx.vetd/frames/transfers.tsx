export const frame = { width: 1440, height: 900, title: "传输队列" };

import { WindowChrome } from "../components/WindowChrome";

const jobs = [
	{ name: "order-api.jar", dir: "↑ /home/deploy/app", state: "进行中", meta: "54 MB / 86 MB · 4.2 MB/s · 剩 8s", width: "64%", tone: "text-accent" },
	{ name: "config.yml", dir: "↑ /home/deploy/app", state: "已暂停", meta: "等待同名确认", width: "20%", tone: "text-warning" },
	{ name: "dump.sql", dir: "↓ C:\\work\\order-api", state: "失败", meta: "权限不足 · 可重试", width: "12%", tone: "text-danger" },
	{ name: "app.log", dir: "↓ C:\\work\\order-api", state: "已完成", meta: "12.4 MB · 3s", width: "100%", tone: "text-success" },
];

export default function Transfers() {
	return (
		<WindowChrome activity="transfers">
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-[280px] shrink-0 flex-col bg-surface-raised">
					<div className="flex h-12 items-center justify-between px-3">
						<h1 className="text-[14px] font-semibold">传输队列</h1>
						<span className="font-mono text-[11px] text-muted">4</span>
					</div>
					{jobs.map((j, i) => (
						<div key={j.name} className={`px-3 py-2 ${i === 1 ? "bg-accent-soft" : ""}`}>
							<div className="flex items-center justify-between text-[13px]">
								<span>{j.name}</span>
								<span className={`text-[11px] ${j.tone}`}>{j.state}</span>
							</div>
							<div className="mt-0.5 font-mono text-[11px] text-faint">{j.dir}</div>
							<div className="mt-1.5 h-1 overflow-hidden rounded-full bg-surface">
								<div className={`h-full ${j.state === "失败" ? "bg-danger" : j.state === "已完成" ? "bg-success" : "bg-accent"}`} style={{ width: j.width }} />
							</div>
						</div>
					))}
				</aside>
				<div className="flex min-w-0 flex-1 flex-col px-8 py-6">
					<div className="text-[12px] text-faint">同名文件</div>
					<h2 className="mt-1 font-display text-xl font-semibold">config.yml 已存在</h2>
					<p className="mt-2 max-w-lg text-[13px] leading-6 text-muted">远程 2 KB，修改于昨天 18:41。本地 2 KB，修改于今天 09:40。</p>
					<div className="mt-5 flex gap-2 text-[13px]">
						<button type="button" className="rounded-md bg-accent px-3 py-1.5 font-medium text-primary-foreground">覆盖</button>
						<button type="button" className="rounded-md bg-surface-raised px-3 py-1.5">跳过</button>
						<button type="button" className="rounded-md bg-surface-raised px-3 py-1.5">重命名</button>
					</div>
					<label className="mt-4 flex items-center gap-2 text-[12px] text-muted">
						<span className="grid size-3.5 place-items-center rounded border border-accent text-accent">
							<span className="icon-[lucide--check] size-3" />
						</span>
						之后全部按此处理
					</label>
					<div className="mt-8 font-mono text-[12px] text-faint">限速 8 MB/s · 可在状态栏点开本队列</div>
				</div>
			</div>
		</WindowChrome>
	);
}
