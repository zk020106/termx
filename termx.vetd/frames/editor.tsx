export const frame = { width: 1440, height: 900, title: "编辑器" };

import { WindowChrome } from "../components/WindowChrome";

const lines = [
	"server:",
	"  port: 8080",
	"  name: order-api",
	"  env: production",
	"redis:",
	"  host: 10.0.8.40",
	"  port: 6379",
	"  timeout: 200ms",
	"  pool: 16",
	"log:",
	"  level: info",
	"  path: /var/log/app.log",
	"  rotate: daily",
	"db:",
	"  host: 10.2.0.11",
	"  name: orders",
	"  pool: 20",
	"http:",
	"  readTimeout: 5s",
	"  writeTimeout: 10s",
	"metrics:",
	"  enabled: true",
	"  port: 9090",
];

export default function Editor() {
	return (
		<WindowChrome activity="sftp">
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex h-9 items-end gap-px bg-surface-sunk px-2">
					<div className="flex h-8 items-center gap-2 rounded-t-md bg-surface px-3 text-[12px]">
						<span className="size-1.5 rounded-full bg-warning" />
						config.yml
						<span className="text-faint">order-api-01</span>
					</div>
					<div className="flex h-8 items-center gap-2 px-3 text-[12px] text-muted">app.log</div>
				</div>
				<div className="relative min-h-0 flex-1 overflow-hidden bg-term py-2 font-mono text-[13px] leading-6">
					{lines.map((line, i) => (
						<div key={line} className="grid grid-cols-[48px_1fr]">
							<span className="pr-3 text-right text-faint">{i + 12}</span>
							<span className={line.endsWith(":") ? "text-accent" : "text-term-ink"}>{line}</span>
						</div>
					))}
					<div className="absolute bottom-4 right-4 w-[340px] rounded-lg bg-surface-raised p-4 shadow-[0_12px_32px_oklch(8%_0.01_230_/_0.5)]">
						<div className="text-[13px] font-medium">远程文件已被修改</div>
						<p className="mt-1 text-[12px] leading-5 text-muted">你打开后，config.yml 在 10:06 被改过。保存会覆盖那次修改。</p>
						<div className="mt-3 flex gap-2 text-[12px]">
							<button type="button" className="rounded-md bg-accent px-2.5 py-1 font-medium text-primary-foreground">仍要保存</button>
							<button type="button" className="rounded-md bg-surface px-2.5 py-1">对比差异</button>
							<button type="button" className="px-2 py-1 text-muted">放弃</button>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
