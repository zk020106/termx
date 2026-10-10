import { Button } from "@/components/ui/Button";
import { StatusDot } from "@/components/ui/Display";
import type { ForwardRule, Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { startForward, stopForward } from "@/lib/forwardManager";
import { useForwardsStore } from "@/store/forwards";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router";

interface CompanionForwardProps {
	activeHost: Host | null;
}

export function CompanionForward({ activeHost }: CompanionForwardProps) {
	const navigate = useNavigate();
	const rules = useForwardsStore((s) => s.rules);
	const hosts = useHostsStore((s) => s.hosts);
	const [showAll, setShowAll] = useState(false);

	const displayedRules = useMemo(() => {
		if (showAll || !activeHost) return rules;
		const hostRules = rules.filter((r) => r.hostId === activeHost.id);
		return hostRules.length > 0 ? hostRules : rules;
	}, [rules, activeHost, showAll]);

	const handleToggle = async (rule: ForwardRule) => {
		if (rule.state === "running" || rule.state === "starting") {
			await stopForward(rule.id);
			toast({ title: `已停止转发: ${rule.name || rule.bindPort}`, tone: "default" });
		} else {
			try {
				const res = await startForward(rule.id);
				if (res.ok) {
					toast({ title: `已启动转发: ${rule.name || rule.bindPort}`, tone: "success" });
				} else {
					toast({ title: "启动转发失败", description: res.error, tone: "danger" });
				}
			} catch (err) {
				toast({ title: "启动转发失败", description: String(err), tone: "danger" });
			}
		}
	};

	const handleOpenBrowser = (rule: ForwardRule) => {
		const port = rule.bindPort;
		const url = `http://localhost:${port}`;
		try {
			window.open(url, "_blank");
		} catch {
			navigator.clipboard.writeText(url);
			toast({ title: "已复制地址到剪贴板", description: url, tone: "success" });
		}
	};

	return (
		<div className="flex h-full flex-col p-3 space-y-3">
			{/* 顶栏控制 */}
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5">
					<span className="text-[12px] font-semibold text-surface-foreground">端口隧道 HUD</span>
					{activeHost && (
						<button
							type="button"
							onClick={() => setShowAll((v) => !v)}
							className={cn(
								"rounded-control border px-1.5 py-0.5 text-[10px] transition-colors cursor-pointer",
								showAll
									? "border-surface-foreground/20 bg-surface-foreground/10 text-surface-foreground"
									: "border-border/60 bg-surface text-muted hover:text-surface-foreground",
							)}
						>
							{showAll ? "显示全部" : `仅当前 (${activeHost.name})`}
						</button>
					)}
				</div>

				<button
					type="button"
					onClick={() => navigate("/forward")}
					className="flex items-center gap-1 text-[11px] text-muted hover:text-surface-foreground cursor-pointer"
					title="打开完整端口转发管理中心"
				>
					<span className="icon-[lucide--settings-2] size-3.5" />
					<span>管理</span>
				</button>
			</div>

			{/* 规则列表 */}
			<div className="flex-1 overflow-y-auto space-y-2 pr-0.5">
				{displayedRules.length === 0 ? (
					<div className="py-12 text-center text-muted">
						<span className="icon-[lucide--waypoints] size-8 text-faint mb-2 block mx-auto" />
						<p className="text-[12px] font-medium text-surface-foreground">暂无端口转发规则</p>
						<p className="text-[10.5px] text-muted mt-1">
							{activeHost ? `尚未为 ${activeHost.name} 配置隧道` : "点击下方按钮创建一条本地或远程隧道"}
						</p>
						<Button
							size="sm"
							variant="default"
							className="mt-3 text-xs"
							onClick={() => navigate("/forward")}
						>
							新建转发规则
						</Button>
					</div>
				) : (
					displayedRules.map((rule) => {
						const isRunning = rule.state === "running";
						const isStarting = rule.state === "starting";
						const isError = rule.state === "error";
						const ruleHost = hosts.find((h) => h.id === rule.hostId);

						return (
							<div
								key={rule.id}
								className={cn(
									"group flex flex-col gap-2 rounded-card border p-2.5 transition-colors duration-150",
									isRunning
										? "border-emerald-500/30 bg-emerald-500/[0.03]"
										: isError
											? "border-danger/30 bg-danger/[0.03]"
											: "border-border/70 bg-surface/50 hover:border-border",
								)}
							>
								{/* 首行：状态灯 + 规则名称 + 快捷开关 */}
								<div className="flex items-center justify-between gap-2">
									<div className="flex items-center gap-2 min-w-0">
										<StatusDot
											status={isRunning ? "connected" : isStarting ? "connecting" : isError ? "failed" : "idle"}
											size={7}
										/>
										<span className="truncate text-[12px] font-medium text-surface-foreground">
											{rule.name || `${rule.type === "local" ? "本地" : "远程"} :${rule.bindPort}`}
										</span>
										<span className="rounded-[4px] bg-surface-foreground/5 border border-border px-1 py-0.2 font-mono text-[9px] text-muted shrink-0">
											{rule.type === "local" ? "Local -L" : rule.type === "remote" ? "Remote -R" : "SOCKS5 -D"}
										</span>
									</div>

									<button
										type="button"
										onClick={() => handleToggle(rule)}
										disabled={isStarting}
										className={cn(
											"flex h-6 items-center gap-1 rounded-control px-2 text-[10.5px] font-medium transition-colors cursor-pointer shrink-0 border",
											isRunning
												? "border-danger/30 bg-danger/10 text-danger hover:bg-danger/20"
												: "border-surface-foreground/20 bg-surface-foreground/10 text-surface-foreground hover:bg-surface-foreground/20",
										)}
									>
										{isStarting ? (
											<span className="icon-[lucide--loader-2] size-3 animate-spin" />
										) : isRunning ? (
											"停止"
										) : (
											"启动"
										)}
									</button>
								</div>

								{/* 次行：连接路由信息 */}
								<div className="flex items-center justify-between text-[11px] font-mono text-muted">
									<div className="flex items-center gap-1.5 truncate">
										<span className="text-surface-foreground/80">:{rule.bindPort}</span>
										<span className="icon-[lucide--arrow-right] size-3 text-faint" />
										<span className="truncate">
											{rule.type === "dynamic" ? "SOCKS5 代理网关" : `${rule.targetHost}:${rule.targetPort}`}
										</span>
									</div>

									{ruleHost && (
										<span className="text-[10px] text-faint truncate font-sans">
											{ruleHost.name}
										</span>
									)}
								</div>

								{/* 底行：活动状态 / 直达链接 */}
								{isRunning && rule.type === "local" && (
									<div className="flex items-center justify-between pt-1 border-t border-border/60 text-[10.5px]">
										<span className="text-emerald-500 font-mono text-[10px]">
											● 活跃连接: {rule.connections || 0}
										</span>

										<button
											type="button"
											onClick={() => handleOpenBrowser(rule)}
											className="flex items-center gap-1 text-surface-foreground/90 hover:text-emerald-500 transition-colors cursor-pointer"
										>
											<span className="icon-[lucide--external-link] size-3" />
											<span>打开浏览器</span>
										</button>
									</div>
								)}

								{isError && rule.error && (
									<p className="text-[10px] text-danger truncate" title={rule.error}>
										错误: {rule.error}
									</p>
								)}
							</div>
						);
					})
				)}
			</div>
		</div>
	);
}
