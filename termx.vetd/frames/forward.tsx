export const frame = { width: 1440, height: 900, title: "端口转发" };

import { WindowChrome } from "../components/WindowChrome";

const rules = [
	{ name: "订单 API", type: "本地 -L", bind: "127.0.0.1:18080", remote: "10.0.3.21:8080", state: "运行中", note: "3 连接" },
	{ name: "Postgres", type: "本地 -L", bind: "127.0.0.1:5432", remote: "10.2.0.11:5432", state: "已停止", note: "手动" },
	{ name: "调试 SOCKS", type: "动态 -D", bind: "127.0.0.1:1080", remote: "—", state: "出错", note: "端口被占用" },
];

export default function Forward() {
	return (
		<WindowChrome activity="forward">
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-[300px] shrink-0 flex-col bg-surface-raised">
					<div className="flex h-12 items-center justify-between px-3">
						<h1 className="text-[14px] font-semibold">端口转发</h1>
						<span className="text-[12px] text-accent">新建</span>
					</div>
					<div className="px-3 pb-2 text-[11px] text-faint">order-api-01 · 连接后自动启动 1 条</div>
					{rules.map((r, i) => (
						<div key={r.name} className={`mx-2 mb-1 rounded-md px-2 py-2 ${i === 2 ? "bg-danger-soft" : i === 0 ? "bg-accent-soft" : ""}`}>
							<div className="flex items-center justify-between text-[13px]">
								<span>{r.name}</span>
								<span className={`text-[11px] ${r.state === "运行中" ? "text-success" : r.state === "出错" ? "text-danger" : "text-faint"}`}>{r.state}</span>
							</div>
							<div className="mt-0.5 font-mono text-[11px] text-muted">{r.bind}</div>
						</div>
					))}
				</aside>
				<div className="min-w-0 flex-1 px-8 py-6">
					<div className="flex items-center gap-2">
						<h2 className="font-display text-xl font-semibold">调试 SOCKS</h2>
						<span className="rounded bg-danger-soft px-1.5 text-[11px] text-danger">出错</span>
					</div>
					<p className="mt-2 text-[13px] text-danger">本地 1080 已被占用。换一个端口，或关掉占用它的进程。</p>
					<div className="mt-5 flex gap-2 text-[12px]">
						{["本地 -L", "远程 -R", "动态 -D"].map((t, i) => (
							<span key={t} className={`rounded-md px-3 py-1 ${i === 2 ? "bg-accent-soft text-accent" : "bg-surface-raised text-muted"}`}>{t}</span>
						))}
					</div>
					<div className="mt-4 grid max-w-lg grid-cols-2 gap-3">
						<Field label="本地地址" value="127.0.0.1:1080" />
						<Field label="远程" value="跟随当前主机" />
					</div>
					<label className="mt-4 flex items-center gap-2 text-[13px] text-muted">
						<span className="size-3.5 rounded border border-border" />
						连接后自动启动
					</label>
					<div className="mt-6 flex gap-2 text-[13px]">
						<button type="button" className="rounded-md bg-accent px-3 py-1.5 font-medium text-primary-foreground">改用 1081 并启动</button>
						<button type="button" className="rounded-md bg-surface-raised px-3 py-1.5">保持停止</button>
					</div>
					<div className="mt-8 max-w-xl">
						<div className="mb-2 flex items-baseline justify-between">
							<span className="text-[13px] font-medium">远程正在监听</span>
							<span className="font-mono text-[11px] text-faint">order-api-01 · 6</span>
						</div>
						<div className="grid grid-cols-[72px_120px_1fr_56px] text-[11px] text-faint">
							<span>端口</span><span>绑定</span><span>进程</span><span className="text-right">操作</span>
						</div>
						{[
							["8080", "0.0.0.0", "order-api"],
							["9090", "127.0.0.1", "metrics"],
							["5432", "10.2.0.11", "postgres"],
							["6379", "10.0.8.40", "redis"],
							["22", "0.0.0.0", "sshd"],
							["9100", "0.0.0.0", "node-exporter"],
						].map((row) => (
							<div key={row[0]} className="grid h-8 grid-cols-[72px_120px_1fr_56px] items-center font-mono text-[12px]">
								<span className="tabular-nums">{row[0]}</span>
								<span className="text-muted">{row[1]}</span>
								<span className="font-sans text-[13px]">{row[2]}</span>
								<span className="text-right font-sans text-[12px] text-accent">转发</span>
							</div>
						))}
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function Field({ label, value }: { label: string; value: string }) {
	return (
		<label className="flex flex-col">
			<span className="mb-1 block text-[12px] text-muted">{label}</span>
			<span className="flex h-8 items-center rounded-md bg-surface-raised px-2.5 font-mono text-[13px]">{value}</span>
		</label>
	);
}
