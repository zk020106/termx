export const frame = { width: 1440, height: 900, title: "主机监控" };

import { WindowChrome } from "../components/WindowChrome";

export default function Monitor() {
	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1">
				<div className="min-w-0 flex-1 bg-term p-4 font-mono text-[12px] leading-6 text-term-ink">
					<span className="text-accent">deploy@order-api-01</span>:~$ 
					<div className="mt-6 text-faint">终端保持在左侧。监控从右侧滑出，不另开连接。</div>
				</div>
				<aside className="flex w-[320px] shrink-0 flex-col bg-surface-raised">
					<div className="flex h-10 items-center gap-3 px-3 text-[12px]">
						<span className="text-accent">监控</span>
						<span className="text-muted">片段</span>
						<span className="text-faint">AI</span>
					</div>
					<div className="px-3 pb-2">
						<div className="text-[13px] font-medium">order-api-01</div>
						<div className="font-mono text-[11px] text-faint">Ubuntu 22.04 · 4 核 · 运行 41 天</div>
					</div>
					<div className="grid grid-cols-2 gap-2 px-3">
						<Stat label="CPU" value="42%" hint="1 分钟均值" />
						<Stat label="内存" value="3.1 G" hint="/ 8 G" />
						<Stat label="磁盘 /" value="71%" hint="超 70%" warn />
						<Stat label="负载" value="1.84" hint="4 核" />
					</div>
					<div className="mt-4 px-3">
						<div className="mb-2 flex items-baseline justify-between">
							<span className="text-[12px] text-muted">CPU · 近 60 秒</span>
							<span className="font-mono text-[11px] text-faint">峰值 61%</span>
						</div>
						<Bars values={[22, 28, 31, 26, 40, 48, 44, 42, 55, 61, 50, 42]} />
					</div>
					<div className="mt-4 px-3 font-mono text-[12px]">
						<div className="flex justify-between text-muted"><span>eth0 下行</span><span className="tabular-nums text-surface-foreground">2.1 MB/s</span></div>
						<div className="mt-1 flex justify-between text-muted"><span>eth0 上行</span><span className="tabular-nums text-surface-foreground">0.4 MB/s</span></div>
					</div>
					<div className="mx-3 mt-4 rounded-md bg-surface px-3 py-2 text-[12px] text-warning">
						磁盘 / 已超过 70%。日志目录占 41 GB。
					</div>
					<div className="mt-auto px-3 py-3 text-[11px] text-faint">采样间隔 2s · 无法获取时这里会标出是哪一项</div>
				</aside>
			</div>
		</WindowChrome>
	);
}

function Stat({ label, value, hint, warn }: { label: string; value: string; hint: string; warn?: boolean }) {
	return (
		<div className="rounded-md bg-surface px-3 py-2">
			<div className="text-[11px] text-faint">{label}</div>
			<div className={`font-mono text-lg tabular-nums ${warn ? "text-warning" : ""}`}>{value}</div>
			<div className="text-[11px] text-muted">{hint}</div>
		</div>
	);
}

function Bars({ values }: { values: number[] }) {
	return (
		<div className="flex h-16 items-end gap-1">
			{values.map((v, i) => (
				<div key={i} className="flex-1 rounded-sm bg-accent" style={{ height: `${v}%`, opacity: i === values.length - 1 ? 1 : 0.55 }} />
			))}
		</div>
	);
}
