export const frame = { width: 1440, height: 900, title: "SFTP 双栏" };

import { Link } from "react-router";
import { EnvPill, WindowChrome } from "../components/WindowChrome";

const local = [
	{ name: "src", type: "dir", size: "—", time: "今天 09:02", perm: "drwxr-xr-x" },
	{ name: "package.json", type: "file", size: "2.4 KB", time: "09-20 14:12", perm: "-rw-r--r--" },
	{ name: "README.md", type: "file", size: "6.1 KB", time: "09-18 10:25", perm: "-rw-r--r--" },
	{ name: "deploy.sh", type: "file", size: "1.2 KB", time: "09-12 18:40", perm: "-rwxr-xr-x" },
	{ name: "tsconfig.json", type: "file", size: "840 B", time: "09-10 11:00", perm: "-rw-r--r--" },
	{ name: "dist", type: "dir", size: "—", time: "今天 08:30", perm: "drwxr-xr-x" },
];

const remote = [
	{ name: "logs", type: "dir", size: "—", time: "今天 10:14", perm: "drwxr-xr-x" },
	{ name: "app.log", type: "file", size: "12.4 MB", time: "今天 10:14", perm: "-rw-r--r--" },
	{ name: "config.yml", type: "file", size: "2.1 KB", time: "昨天 18:41", perm: "-rw-r--r--" },
	{ name: "release", type: "dir", size: "—", time: "09-22 15:30", perm: "drwxr-xr-x" },
	{ name: "order-api.jar", type: "file", size: "86.2 MB", time: "09-22 15:28", perm: "-rw-r--r--" },
	{ name: "docker-compose.yml", type: "file", size: "1.8 KB", time: "09-15 09:10", perm: "-rw-r--r--" },
];

export default function Sftp() {
	return (
		<WindowChrome activity="sftp">
			<div className="flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶栏控制栏 */}
				<div className="flex h-10 items-center justify-between border-b border-border bg-surface-sunk px-3 text-[12px]">
					<div className="flex items-center gap-2">
						<span className="font-medium text-surface-foreground">SFTP 远程文件传输</span>
						<span className="text-border">/</span>
						<span className="font-mono text-muted">order-api-01</span>
						<EnvPill env="PROD" />
					</div>

					<div className="flex items-center gap-2">
						<Link
							to="/editor"
							className="flex h-6.5 items-center gap-1.5 rounded border border-border bg-surface px-2 text-[11px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--file-edit] size-3 text-primary" />
							<span>内置编辑器打开 config.yml</span>
						</Link>
						<Link
							to="/transfers"
							className="flex h-6.5 items-center gap-1.5 rounded bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
						>
							<span className="icon-[lucide--arrow-down-up] size-3" />
							<span>传输队列 (2)</span>
						</Link>
					</div>
				</div>

				{/* 双栏文件区 (左本地、右远程) */}
				<div className="grid min-h-0 flex-1 grid-cols-2">
					<Column
						title="本地文件系统"
						path="C:\work\order-api"
						files={local}
						icon="icon-[lucide--laptop]"
					/>
					<Column
						title="远程主机 (order-api-01)"
						path="/home/deploy/app"
						files={remote}
						icon="icon-[lucide--server]"
						dropzone
					/>
				</div>

				{/* 拖拽放置指示条 */}
				<div className="flex h-8 shrink-0 items-center justify-between border-t border-border bg-primary/10 px-3 text-[11.5px] text-surface-foreground">
					<div className="flex items-center gap-2">
						<span className="icon-[lucide--upload] size-3.5 text-primary animate-bounce" />
						<span className="font-medium">拖拽文件至此：</span>
						<span className="text-muted">释放鼠标即可上传至远程目录 <span className="font-mono text-surface-foreground">/home/deploy/app</span></span>
					</div>
					<span className="font-mono text-[10.5px] text-primary">同名文件自动冲突比对</span>
				</div>
			</div>
		</WindowChrome>
	);
}

function Column({
	title,
	path,
	files,
	icon,
	dropzone,
}: {
	title: string;
	path: string;
	files: { name: string; type: string; size: string; time: string; perm: string }[];
	icon: string;
	dropzone?: boolean;
}) {
	return (
		<div className={`flex min-h-0 flex-col ${dropzone ? "border-l border-border bg-surface-raised/40" : "bg-surface"}`}>
			{/* 栏头部 */}
			<div className="flex h-9 items-center justify-between border-b border-border bg-surface-sunk px-3 text-[11.5px]">
				<div className="flex items-center gap-1.5 text-muted">
					<span className={`${icon} size-3.5 text-primary`} />
					<span className="font-medium text-surface-foreground">{title}</span>
				</div>
				<div className="flex items-center gap-1.5 font-mono text-[11px] text-faint">
					<span>{files.length} 项</span>
					<button type="button" className="flex size-5 items-center justify-center rounded hover:bg-surface hover:text-surface-foreground">
						<span className="icon-[lucide--refresh-cw] size-3" />
					</button>
				</div>
			</div>

			{/* 路径条与快速过滤 */}
			<div className="flex h-8 items-center gap-2 border-b border-border bg-surface px-3 text-[11.5px]">
				<span className="font-mono text-muted text-[11px]">路径:</span>
				<div className="flex-1 truncate font-mono text-[11px] text-surface-foreground">
					{path}
				</div>
				<span className="icon-[lucide--folder-plus] size-3 text-muted hover:text-surface-foreground cursor-pointer" title="新建目录" />
			</div>

			{/* 表头 */}
			<div className="grid grid-cols-[1fr_80px_110px_70px] border-b border-border/60 bg-surface-sunk/40 px-3 py-1 font-sans text-[10.5px] text-faint uppercase tracking-wider">
				<span>名称</span>
				<span className="text-right">大小</span>
				<span className="text-right">修改时间</span>
				<span className="text-right">权限</span>
			</div>

			{/* 表格内容行 */}
			<div className="flex-1 overflow-y-auto">
				{files.map((f) => (
					<div
						key={f.name}
						className="grid h-7.5 grid-cols-[1fr_80px_110px_70px] items-center px-3 text-[12px] hover:bg-surface-raised transition-colors cursor-pointer border-b border-border/20"
					>
						<span className="flex items-center gap-2 truncate">
							<span
								className={`${
									f.type === "dir" ? "icon-[lucide--folder] text-primary" : "icon-[lucide--file-text] text-faint"
								} size-3.5 shrink-0`}
							/>
							<span className="font-mono text-[11.5px] text-surface-foreground truncate">{f.name}</span>
						</span>
						<span className="text-right font-mono text-[11px] tabular-nums text-muted">{f.size}</span>
						<span className="text-right font-mono text-[10.5px] text-faint">{f.time}</span>
						<span className="text-right font-mono text-[10px] text-faint">{f.perm}</span>
					</div>
				))}
			</div>
		</div>
	);
}
