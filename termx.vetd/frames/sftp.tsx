export const frame = { width: 1440, height: 900, title: "SFTP 双栏" };

import { Link } from "react-router";
import { WindowChrome } from "../components/WindowChrome";

const local = [
	["src", "文件夹", "今天 09:02"],
	["package.json", "2 KB", "09-20"],
	["README.md", "6 KB", "09-18"],
	["deploy.sh", "1 KB", "09-12"],
];

const remote = [
	["logs", "文件夹", "今天 09:14"],
	["app.log", "12.4 MB", "今天 10:02"],
	["config.yml", "2 KB", "昨天"],
	["release", "文件夹", "09-22"],
	["order-api.jar", "86 MB", "09-22"],
];

export default function Sftp() {
	return (
		<WindowChrome activity="sftp">
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex h-10 items-center gap-3 px-3 text-[13px]">
					<span className="font-medium">order-api-01</span>
					<span className="rounded bg-env-prod px-1.5 font-mono text-[10px] text-primary-foreground">PROD</span>
					<span className="text-faint">本地 ↔ 远程</span>
					<Link to="/editor" className="ml-auto text-[12px] text-accent">打开 config.yml</Link>
				</div>
				<div className="grid min-h-0 flex-1 grid-cols-2">
					<Column title="本地" path="C:\\work\\order-api" rows={local} />
					<Column title="远程" path="/home/deploy/app" rows={remote} drop />
				</div>
				<div className="flex h-8 items-center gap-3 bg-surface-sunk px-3 text-[12px] text-warning">
					<span className="icon-[lucide--upload] size-3.5" />
					松开以上传到 /home/deploy/app
				</div>
			</div>
		</WindowChrome>
	);
}

function Column({ title, path, rows, drop }: { title: string; path: string; rows: string[][]; drop?: boolean }) {
	return (
		<div className={`flex min-h-0 flex-col ${drop ? "bg-accent-soft/40" : "bg-surface"}`}>
			<div className="flex h-9 items-center gap-2 px-3 text-[12px]">
				<span className="text-muted">{title}</span>
				<span className="font-mono text-surface-foreground">{path}</span>
			</div>
			<div className="grid grid-cols-[1fr_88px_88px] px-3 text-[11px] text-faint">
				<span>名称</span><span className="text-right">大小</span><span className="text-right">修改</span>
			</div>
			{rows.map((r) => (
				<div key={r[0]} className="grid h-8 grid-cols-[1fr_88px_88px] items-center px-3 text-[13px]">
					<span className="flex items-center gap-2">
						<span className={`${r[1] === "文件夹" ? "icon-[lucide--folder]" : "icon-[lucide--file]"} size-3.5 text-faint`} />
						{r[0]}
					</span>
					<span className="text-right font-mono text-[11px] tabular-nums text-muted">{r[1] === "文件夹" ? "—" : r[1]}</span>
					<span className="text-right font-mono text-[11px] text-faint">{r[2]}</span>
				</div>
			))}
		</div>
	);
}
