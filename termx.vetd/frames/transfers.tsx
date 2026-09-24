export const frame = { width: 1440, height: 900, title: "传输队列" };

import { WindowChrome } from "../components/WindowChrome";

const jobs = [
	{
		name: "order-api.jar",
		dir: "↑ 上传至 /home/deploy/app",
		state: "进行中",
		meta: "54 MB / 86.2 MB · 4.2 MB/s · 剩余 8s",
		progress: 64,
		status: "active",
	},
	{
		name: "config.yml",
		dir: "↑ 上传至 /home/deploy/app",
		state: "已暂停",
		meta: "等待同名文件冲突确认",
		progress: 10,
		status: "warning",
	},
	{
		name: "dump-20260920.sql",
		dir: "↓ 下载至 C:\\work\\order-api",
		state: "传输失败",
		meta: "远端权限不足 (EACCES) · 可重试",
		progress: 18,
		status: "danger",
	},
	{
		name: "app.log",
		dir: "↓ 下载至 C:\\work\\order-api",
		state: "已完成",
		meta: "12.4 MB · 耗时 2.8s",
		progress: 100,
		status: "success",
	},
];

export default function Transfers() {
	return (
		<WindowChrome activity="transfers">
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧任务列表 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--arrow-down-up] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">传输队列</h1>
						</div>
						<div className="flex items-center gap-2 font-mono text-[11px] text-muted">
							<span>4 个任务</span>
							<button type="button" className="flex size-5 items-center justify-center rounded hover:bg-surface-raised hover:text-surface-foreground" title="暂停全部">
								<span className="icon-[lucide--pause] size-3" />
							</button>
						</div>
					</div>

					{/* 队列项 */}
					<div className="flex-1 overflow-y-auto p-2 space-y-1.5">
						{jobs.map((j, i) => (
							<div
								key={j.name}
								className={`rounded border p-2.5 transition-colors cursor-pointer ${
									i === 1
										? "border-warning/40 bg-surface-raised shadow-sm"
										: "border-border bg-surface hover:border-white/20"
								}`}
							>
								<div className="flex items-center justify-between text-[12px]">
									<span className="font-mono font-medium text-surface-foreground truncate max-w-[170px]">{j.name}</span>
									<span
										className={`font-mono text-[10px] ${
											j.status === "warning"
												? "text-warning"
												: j.status === "danger"
												? "text-danger"
												: j.status === "success"
												? "text-success"
												: "text-primary"
										}`}
									>
										{j.state}
									</span>
								</div>

								<div className="mt-1 font-mono text-[10.5px] text-faint truncate">{j.dir}</div>

								<div className="mt-2 h-1 overflow-hidden rounded bg-surface-sunk border border-border">
									<div
										className={`h-full ${
											j.status === "warning"
												? "bg-warning"
												: j.status === "danger"
												? "bg-danger"
												: j.status === "success"
												? "bg-success"
												: "bg-primary"
										}`}
										style={{ width: `${j.progress}%` }}
									/>
								</div>

								<div className="mt-1.5 flex items-center justify-between font-mono text-[10px] text-faint">
									<span className="truncate">{j.meta}</span>
									<span>{j.progress}%</span>
								</div>
							</div>
						))}
					</div>

					{/* 底部限速调节器 */}
					<div className="flex h-9 items-center justify-between border-t border-border bg-surface-raised px-3 text-[11px] text-muted">
						<span className="flex items-center gap-1">
							<span className="icon-[lucide--gauge] size-3 text-primary" />
							<span>全局带宽限速</span>
						</span>
						<span className="font-mono text-surface-foreground">8.0 MB/s</span>
					</div>
				</aside>

				{/* 右侧同名文件冲突确认详情 */}
				<div className="flex min-w-0 flex-1 flex-col items-center justify-center p-6">
					<div className="w-[480px] rounded-lg border border-border bg-surface-raised p-5 shadow-lg">
						<div className="flex items-center gap-2 border-b border-border pb-3">
							<span className="flex size-6 items-center justify-center rounded bg-warning/15 text-warning">
								<span className="icon-[lucide--alert-triangle] size-3.5" />
							</span>
							<div>
								<h2 className="text-[13px] font-semibold text-surface-foreground">同名文件覆盖冲突</h2>
								<p className="text-[11px] text-muted">目标路径已有同名文件，请确认处理方式</p>
							</div>
						</div>

						{/* 对比表格 */}
						<div className="mt-4 rounded border border-border bg-surface overflow-hidden">
							<div className="grid grid-cols-[100px_1fr_1fr] border-b border-border bg-surface-sunk/60 px-3 py-1.5 font-mono text-[10.5px] text-faint uppercase">
								<span>属性</span>
								<span>本地待上传文件</span>
								<span>远程已有文件</span>
							</div>

							<div className="divide-y divide-border/40 text-[11.5px] font-mono">
								<div className="grid grid-cols-[100px_1fr_1fr] items-center px-3 py-2">
									<span className="text-muted font-sans">文件名称</span>
									<span className="text-surface-foreground">config.yml</span>
									<span className="text-surface-foreground">config.yml</span>
								</div>
								<div className="grid grid-cols-[100px_1fr_1fr] items-center px-3 py-2">
									<span className="text-muted font-sans">文件大小</span>
									<span className="tabular-nums text-surface-foreground">2,108 字节 (2.1 KB)</span>
									<span className="tabular-nums text-surface-foreground">2,048 字节 (2.0 KB)</span>
								</div>
								<div className="grid grid-cols-[100px_1fr_1fr] items-center px-3 py-2">
									<span className="text-muted font-sans">修改时间</span>
									<span className="text-success tabular-nums">今天 09:40 (较新)</span>
									<span className="text-faint tabular-nums">昨天 18:41</span>
								</div>
							</div>
						</div>

						{/* 选项按钮组 */}
						<div className="mt-5 flex items-center gap-2">
							<button
								type="button"
								className="flex h-7.5 flex-1 items-center justify-center gap-1 rounded bg-primary text-[12px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
							>
								<span className="icon-[lucide--check] size-3" />
								覆盖远端文件
							</button>
							<button
								type="button"
								className="flex h-7.5 flex-1 items-center justify-center gap-1 rounded border border-border bg-surface text-[12px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
							>
								跳过本次传输
							</button>
							<button
								type="button"
								className="flex h-7.5 flex-1 items-center justify-center gap-1 rounded border border-border bg-surface text-[12px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
							>
								重命名保留两份
							</button>
						</div>

						{/* 记忆选项 */}
						<div className="mt-4 flex items-center justify-between border-t border-border pt-3 text-[11px] text-muted">
							<label className="flex items-center gap-2 cursor-pointer">
								<span className="flex size-3.5 items-center justify-center rounded border border-primary bg-primary/20 text-primary">
									<span className="icon-[lucide--check] size-2.5" />
								</span>
								<span>对本次传输队列中的后续所有冲突文件均应用此规则</span>
							</label>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
