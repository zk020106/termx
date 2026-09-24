export const frame = { width: 1440, height: 900, title: "命令片段" };

import { WindowChrome } from "../components/WindowChrome";

const items = [
	{ name: "看最近错误", group: "排障", cmd: "journalctl -u ${service} -n 200 | grep ERROR" },
	{ name: "重启服务", group: "发布", cmd: "sudo systemctl restart ${service}" },
	{ name: "磁盘", group: "排障", cmd: "df -h" },
];

export default function Snippets() {
	return (
		<WindowChrome activity="snippets">
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-[280px] shrink-0 flex-col bg-surface-raised">
					<div className="flex h-12 items-center justify-between px-3">
						<h1 className="text-[14px] font-semibold">命令片段</h1>
						<span className="text-[12px] text-accent">新建</span>
					</div>
					<div className="px-3 pb-2 text-[11px] text-faint">发布</div>
					{items.filter((i) => i.group === "发布").map((i) => (
						<Row key={i.name} name={i.name} on />
					))}
					<div className="px-3 pb-2 pt-3 text-[11px] text-faint">排障</div>
					{items.filter((i) => i.group === "排障").map((i) => (
						<Row key={i.name} name={i.name} />
					))}
				</aside>
				<div className="relative min-w-0 flex-1">
					<div className="px-8 py-6">
						<h2 className="font-display text-xl font-semibold">重启服务</h2>
						<pre className="mt-3 max-w-xl rounded-md bg-term p-3 font-mono text-[12px] text-term-ink">sudo systemctl restart ${"{service}"}</pre>
					</div>
					<div className="absolute bottom-6 left-8 w-[420px] rounded-lg bg-surface-raised p-4 shadow-[0_12px_32px_oklch(8%_0.01_230_/_0.5)]">
						<div className="text-[12px] text-faint">发送前填写</div>
						<div className="mt-2 text-[12px] text-muted">service</div>
						<div className="mt-1 flex h-8 items-center rounded-md bg-surface px-2 font-mono text-[13px]">order-api</div>
						<div className="mt-3 text-[12px] text-muted">发到</div>
						<div className="mt-1 flex gap-1 text-[12px]">
							{["当前终端", "选中的格", "全部"].map((t, i) => (
								<span key={t} className={`rounded-md px-2 py-1 ${i === 0 ? "bg-accent-soft text-accent" : "text-muted"}`}>{t}</span>
							))}
						</div>
						<p className="mt-3 text-[12px] text-danger">包含生产主机，需单独确认后才会发出。</p>
						<button type="button" className="mt-3 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-primary-foreground">确认并发送</button>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function Row({ name, on }: { name: string; on?: boolean }) {
	return <div className={`mx-2 flex h-8 items-center rounded px-2 text-[13px] ${on ? "bg-accent-soft" : ""}`}>{name}</div>;
}
