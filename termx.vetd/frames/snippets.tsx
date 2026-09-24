export const frame = { width: 1440, height: 900, title: "命令片段" };

import { WindowChrome } from "../components/WindowChrome";

const snippets = [
	{ name: "重启指定微服务", group: "日常发布", cmd: "sudo systemctl restart ${service}", desc: "平滑重启 systemd 托管的服务进程" },
	{ name: "检查服务运行状态", group: "日常发布", cmd: "sudo systemctl status ${service} -l", desc: "查看最近活动日志与退出码" },
	{ name: "排查最近 200 条错误", group: "排障诊断", cmd: "journalctl -u ${service} -n 200 --no-pager | grep -E 'ERROR|WARN'", desc: "过滤关键字并高亮输出" },
	{ name: "查看磁盘挂载利用率", group: "排障诊断", cmd: "df -hT --exclude-type=tmpfs", desc: "排除临时文件系统查看根分区" },
	{ name: "抓取指定端口 TCP 连接", group: "网络运维", cmd: "sudo ss -tulpn | grep :${port}", desc: "查看监听端口所属进程与 PID" },
];

export default function Snippets() {
	return (
		<WindowChrome activity="snippets">
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧命令片段库 (280px) */}
				<aside className="flex w-[280px] shrink-0 flex-col border-r border-border bg-surface-sunk">
					<div className="flex h-10 items-center justify-between border-b border-border px-3">
						<div className="flex items-center gap-1.5">
							<span className="icon-[lucide--terminal-square] size-3.5 text-primary" />
							<h1 className="text-[12px] font-semibold text-surface-foreground">命令片段库</h1>
						</div>
						<button
							type="button"
							className="flex h-6 items-center gap-1 rounded bg-primary px-2 text-[11px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
						>
							<span className="icon-[lucide--plus] size-3" />
							<span>新建</span>
						</button>
					</div>

					<div className="p-2">
						<div className="flex h-7 items-center gap-1.5 rounded border border-border bg-surface px-2 text-[11px] text-faint">
							<span className="icon-[lucide--search] size-3 text-muted" />
							<span className="truncate">搜索片段名称或脚本…</span>
						</div>
					</div>

					{/* 分组列表 */}
					<div className="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
						<div>
							<div className="px-1 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">日常发布</div>
							<div className="space-y-1">
								<SnippetRow item={snippets[0]} active />
								<SnippetRow item={snippets[1]} />
							</div>
						</div>

						<div>
							<div className="px-1 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">排障诊断</div>
							<div className="space-y-1">
								<SnippetRow item={snippets[2]} />
								<SnippetRow item={snippets[3]} />
							</div>
						</div>

						<div>
							<div className="px-1 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">网络运维</div>
							<div className="space-y-1">
								<SnippetRow item={snippets[4]} />
							</div>
						</div>
					</div>
				</aside>

				{/* 右侧片段详情与参数化执行面板 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
					<div className="max-w-2xl space-y-5">
						{/* 片段卡片 */}
						<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-sm">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div>
									<div className="flex items-center gap-2">
										<h2 className="text-[14px] font-semibold text-surface-foreground">重启指定微服务</h2>
										<span className="rounded border border-border bg-surface px-1.5 py-0.2 font-mono text-[10px] text-muted">BASH</span>
									</div>
									<p className="mt-1 text-[11.5px] text-muted">平滑重启 systemd 托管的服务进程</p>
								</div>
								<div className="flex items-center gap-1.5">
									<button type="button" className="flex h-6.5 items-center gap-1 rounded border border-border bg-surface px-2 text-[11px] text-muted hover:bg-surface-raised hover:text-surface-foreground">
										<span className="icon-[lucide--edit-3] size-3" />
										编辑
									</button>
								</div>
							</div>

							{/* 命令预览框 */}
							<div className="mt-4">
								<div className="mb-1 flex items-center justify-between text-[11px] text-faint font-mono">
									<span>SCRIPT TEMPLATE</span>
									<span>包含 1 个动态变量</span>
								</div>
								<div className="rounded border border-border bg-term p-3 font-mono text-[12.5px] text-term-ink">
									<span className="text-muted">sudo systemctl restart </span>
									<span className="rounded bg-primary/20 px-1 py-0.5 text-primary font-semibold ring-1 ring-primary/40">{"${service}"}</span>
								</div>
							</div>
						</div>

						{/* 动态执行参数弹层/卡片 */}
						<div className="rounded-lg border border-border bg-surface-raised p-5 shadow-md">
							<div className="flex items-center gap-2 border-b border-border pb-3">
								<span className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
									<span className="icon-[lucide--play] size-3" />
								</span>
								<h3 className="text-[13px] font-semibold text-surface-foreground">执行前变量替换</h3>
							</div>

							<div className="mt-4 space-y-3">
								<div className="flex flex-col">
									<div className="mb-1 flex items-center justify-between">
										<label className="text-[11.5px] font-mono text-primary font-medium">{"${service}"}</label>
										<span className="text-[11px] text-faint">必填参数</span>
									</div>
									<div className="flex h-7.5 items-center rounded border border-border bg-surface px-2.5 font-mono text-[12px] text-surface-foreground">
										order-api
									</div>
								</div>

								{/* 发送目标终端 */}
								<div className="flex flex-col">
									<label className="mb-1 text-[11.5px] text-muted">发送目标会话</label>
									<div className="grid grid-cols-3 rounded border border-border bg-surface p-0.5 text-[11.5px]">
										{["当前焦点格 (order-api-01)", "选中的 2 个分屏格", "全部已连接终端"].map((t, i) => (
											<button
												key={t}
												type="button"
												className={`rounded py-1 text-center font-medium transition-colors ${
													i === 0
														? "bg-surface-raised text-surface-foreground border border-border shadow-sm"
														: "text-muted hover:text-surface-foreground"
												}`}
											>
												{t}
											</button>
										))}
									</div>
								</div>

								{/* 生产环境安全拦截提示 */}
								<div className="rounded border border-env-prod/30 bg-env-prod/10 p-2.5 text-[11.5px] text-env-prod leading-relaxed">
									<div className="flex items-center gap-1.5 font-medium">
										<span className="icon-[lucide--shield-alert] size-3.5" />
										<span>目标包含生产主机 (order-api-01 · PROD)</span>
									</div>
									<p className="mt-0.5 text-[11px] opacity-90">
										根据防误操作策略，向生产环境发送片段需二次确认。
									</p>
								</div>
							</div>

							{/* 底部按钮栏 */}
							<div className="mt-5 flex items-center justify-between border-t border-border pt-3">
								<span className="font-mono text-[10.5px] text-faint">快捷键: Ctrl + Enter</span>
								<div className="flex items-center gap-2">
									<button
										type="button"
										className="h-7 rounded border border-border bg-surface px-2.5 text-[11.5px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground"
									>
										仅复制命令
									</button>
									<button
										type="button"
										className="flex h-7 items-center gap-1.5 rounded bg-primary px-3 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
									>
										<span className="icon-[lucide--send] size-3" />
										<span>确认并发送到终端</span>
									</button>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function SnippetRow({ item, active }: { item: { name: string; cmd: string }; active?: boolean }) {
	return (
		<div
			className={`rounded border p-2 transition-colors cursor-pointer ${
				active
					? "border-border bg-surface-raised shadow-sm"
					: "border-transparent hover:border-border hover:bg-surface"
			}`}
		>
			<div className="text-[12px] font-medium text-surface-foreground truncate">{item.name}</div>
			<div className="mt-0.5 font-mono text-[10.5px] text-muted truncate">{item.cmd}</div>
		</div>
	);
}
