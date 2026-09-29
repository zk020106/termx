import { Button } from "@/components/ui/Button";
import { Badge, ProgressBar, Segmented } from "@/components/ui/Display";
import { Checkbox } from "@/components/ui/Toggle";
import { updateInfo } from "@/data/mock";
import { cn } from "@/lib/cn";
import { toast } from "@/store/toast";
import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";

/* =============================================================================
 * 版本更新 —— 设计帧 termx.vetd/frames/updater.tsx 的交互版。
 * 对话框形式：不套 WindowChrome，根节点 h-full 居中一张 560px 卡片。
 * 状态：有新版本 / 已是最新 / 下载中（含下载完成），渠道 stable / beta 可切换。
 * ========================================================================== */

type UpdateState = "available" | "latest" | "downloading";
type Channel = "stable" | "beta";

const STATE_OPTIONS: { value: UpdateState; label: string }[] = [
	{ value: "available", label: "有新版本" },
	{ value: "latest", label: "已是最新" },
	{ value: "downloading", label: "下载中" },
];

/** 尝鲜通道用界面内演示版本号：mock 只提供稳定版数据 */
const BETA_LATEST = "0.3.0-beta.2";

const PACKAGE_MB = Number.parseFloat(updateInfo.sizeText) || 64.2;

export default function Updater() {
	const navigate = useNavigate();
	const [state, setState] = useState<UpdateState>("downloading");
	const [channel, setChannel] = useState<Channel>(updateInfo.channel);
	const [autoDownload, setAutoDownload] = useState(true);
	const [progress, setProgress] = useState(0);

	const latestVersion = channel === "stable" ? updateInfo.latestVersion : BETA_LATEST;
	const finished = state === "downloading" && progress >= 100;
	const newRelease = updateInfo.releases.find((r) => !r.current);

	/* 下载进度演示：进入「下载中」后自动推进到 100% */
	useEffect(() => {
		if (state !== "downloading") return;
		setProgress(4);
		const timer = window.setInterval(() => {
			setProgress((p) => (p >= 100 ? 100 : Math.min(100, p + 3 + Math.round(Math.random() * 5))));
		}, 300);
		return () => window.clearInterval(timer);
	}, [state]);

	useEffect(() => {
		if (finished) toast({ title: "安装包下载完成", description: `${updateInfo.sizeText} · 签名校验通过，可重启应用更新。`, tone: "success" });
		// 仅在进度首次到达 100% 时提示
	}, [finished]);

	const startDownload = () => {
		setState("downloading");
		toast({ title: `开始下载 v${latestVersion}`, description: `${updateInfo.sizeText} · 可最小化到后台继续下载。`, tone: "default" });
	};

	const remindLater = () => {
		toast({ title: "已改为稍后提醒", description: "24 小时内不再弹出更新提示。", tone: "default" });
		navigate("/");
	};

	const cancelDownload = () => {
		setProgress(0);
		setState("available");
		toast({ title: "已取消下载", description: "临时文件已删除。", tone: "default" });
	};

	const applyUpdate = () => {
		toast({ title: "正在重启并应用更新", description: `v${latestVersion} 将在应用退出后安装。`, tone: "success" });
		navigate("/");
	};

	return (
		<div className="relative flex h-full flex-col items-center justify-center overflow-y-auto bg-term p-4">
			{/* 背景虚化的主工作台光晕（token 颜色，不硬编码） */}
			<div aria-hidden className="pointer-events-none absolute -top-10 -left-20 size-72 rounded-full bg-primary/10 blur-3xl" />
			<div aria-hidden className="pointer-events-none absolute -right-16 bottom-0 size-80 rounded-full bg-accent/10 blur-3xl" />

			{/* 评审用状态切换器 */}
			<div className="absolute top-4 right-4 z-20 flex items-center gap-2">
				<span className="font-mono text-[10.5px] text-term-ink/60">状态</span>
				<Segmented value={state} onChange={setState} options={STATE_OPTIONS} className="bg-surface" />
			</div>

			{/* 浮动更新发布弹窗 (Linear / Raycast 风格 560px) */}
			<div className="relative z-10 w-[560px] overflow-hidden rounded-lg border border-border bg-surface-raised shadow-2xl">
				{/* 弹窗顶栏 */}
				<div className="flex h-12 items-center justify-between border-b border-border bg-surface px-4">
					<div className="flex items-center gap-2.5">
						<div
							className={cn(
								"flex size-6 items-center justify-center rounded",
								state === "latest" ? "bg-success/15 text-success" : "bg-primary/15 text-primary",
							)}
						>
							<span className={cn(state === "latest" ? "icon-[lucide--check]" : "icon-[lucide--sparkles]", "size-3.5")} />
						</div>
						<div className="flex items-center gap-2">
							<h1 className="text-[13px] font-semibold text-surface-foreground">
								{state === "available" && "TermX 新版本已就绪"}
								{state === "latest" && "TermX 已是最新版本"}
								{state === "downloading" && (finished ? "安装包下载完成" : "正在下载 TermX 更新")}
							</h1>
							<span
								className={cn(
									"rounded border px-1.5 py-0.2 font-mono text-[10px]",
									state === "latest" ? "border-border bg-surface-raised text-muted" : "border-primary/40 bg-primary/10 text-primary",
								)}
							>
								v{state === "latest" ? updateInfo.currentVersion : latestVersion}
							</span>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<span className="font-mono text-[10.5px] text-faint">当前版本: v{updateInfo.currentVersion}</span>
						<Link
							to="/"
							className="flex size-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
							aria-label="关闭"
						>
							<span className="icon-[lucide--x] size-3.5" />
						</Link>
					</div>
				</div>

				{/* 弹窗主体 */}
				<div className="max-h-[calc(100vh-9rem)] space-y-4 overflow-y-auto p-4">
					{state === "latest" ? (
						/* 已是最新：成功态 */
						<div className="flex items-center gap-2.5 rounded border border-success/40 bg-success/10 px-3 py-2.5">
							<span className="icon-[lucide--badge-check] size-4 shrink-0 text-success" />
							<div>
								<div className="text-[12px] font-medium text-surface-foreground">
									当前版本 v{updateInfo.currentVersion} 已是最新（{channel === "stable" ? "稳定通道" : "尝鲜通道"}）
								</div>
								<div className="mt-0.5 text-[11px] text-muted">上次检测：2 分钟前 · 下次自动检测：启动应用时</div>
							</div>
						</div>
					) : (
						/* 版本对比：当前版本 vs 新版本 */
						<div className="flex items-center gap-3 rounded border border-border bg-surface p-3">
							<div className="min-w-0 flex-1">
								<div className="font-mono text-[10px] tracking-wider text-faint uppercase">当前版本</div>
								<div className="mt-0.5 font-mono text-[13px] text-muted">v{updateInfo.currentVersion}</div>
								<div className="mt-0.5 text-[10.5px] text-faint">2026-09-10 发布</div>
							</div>
							<span className="icon-[lucide--arrow-right] size-4 shrink-0 text-faint" />
							<div className="min-w-0 flex-1">
								<div className="font-mono text-[10px] tracking-wider text-faint uppercase">新版本</div>
								<div className="mt-0.5 flex items-center gap-1.5">
									<span className="font-mono text-[13px] font-medium text-primary">v{latestVersion}</span>
									<Badge className="border-primary/40 bg-primary/10 text-primary">
										{channel === "stable" ? "Stable" : "Beta"}
									</Badge>
								</div>
								<div className="mt-0.5 text-[10.5px] text-faint">{newRelease?.date ?? "2026-09-24"} 发布</div>
							</div>
							<div className="shrink-0 border-l border-border pl-3">
								<div className="font-mono text-[10px] tracking-wider text-faint uppercase">安装包</div>
								<div className="mt-0.5 font-mono text-[12px] text-surface-foreground">{updateInfo.sizeText}</div>
								<div className="mt-0.5 text-[10.5px] text-faint">Windows x64 · .msi</div>
							</div>
						</div>
					)}

					{/* 渠道切换 */}
					<div className="flex items-center justify-between gap-3 rounded border border-border bg-surface px-3 py-2">
						<div className="min-w-0">
							<div className="text-[11.5px] font-medium text-surface-foreground">软件更新通道</div>
							<div className="mt-0.5 text-[10.5px] text-faint">
								{channel === "stable" ? "正式稳定版 · 推荐日常工作使用" : "尝鲜预览版 · 提前体验新特性，可能不稳定"}
							</div>
						</div>
						<Segmented
							value={channel}
							onChange={(next) => {
								setChannel(next);
								setProgress(0);
								setState("available");
								toast({ title: next === "stable" ? "已切换到稳定通道" : "已切换到尝鲜通道 (Beta)", description: "已按新通道重新检测更新。", tone: "default" });
							}}
							options={[
								{ value: "stable", label: "stable" },
								{ value: "beta", label: "beta" },
							]}
						/>
					</div>

					{/* 下载进度态 */}
					{state === "downloading" && (
						<div className="space-y-2 rounded border border-primary/30 bg-primary/5 p-3">
							<div className="flex items-baseline justify-between">
								<span className="flex items-center gap-1.5 text-[12px] font-medium text-surface-foreground">
									<span className={cn(finished ? "icon-[lucide--badge-check]" : "icon-[lucide--download]", "size-3.5 text-primary")} />
									{finished ? "下载完成，签名校验通过" : `正在下载 v${latestVersion} 安装包`}
								</span>
								<span className="font-mono text-[11px] tabular-nums text-primary">{progress}%</span>
							</div>
							<ProgressBar value={progress} tone={finished ? "success" : "primary"} />
							<div className="flex items-center justify-between font-mono text-[10.5px] text-muted">
								<span>
									{((PACKAGE_MB * progress) / 100).toFixed(1)} MB / {updateInfo.sizeText}
								</span>
								<span>{finished ? "已完成 · 等待重启安装" : "6.8 MB/s · 剩余约 9 秒"}</span>
							</div>
						</div>
					)}

					{/* 重点更新 Banner */}
					{state !== "latest" && (
						<div className="rounded border border-primary/30 bg-primary/5 p-3 text-[12px] leading-relaxed">
							<div className="flex items-center gap-1.5 font-medium text-surface-foreground">
								<span className="icon-[lucide--zap] size-3.5 text-primary" />
								<span>分屏焦点修复 · SFTP 队列断线自动恢复</span>
							</div>
							<p className="mt-1 text-[11px] text-muted">
								本次更新修复了分屏时焦点格丢失的问题，命令面板支持 <span className="font-mono text-muted">&gt;</span> 前缀只搜命令，
								SFTP 传输队列在断线后会自动恢复。
							</p>
						</div>
					)}

					{/* 更新日志列表 */}
					<div>
						<div className="mb-2 flex items-center justify-between">
							<span className="font-mono text-[10.5px] font-medium tracking-wider text-faint uppercase">
								{state === "latest" ? "版本历史 (Release History)" : "更新日志 (What's New)"}
							</span>
							<span className="font-mono text-[10px] text-faint">{updateInfo.releases.length} 个版本</span>
						</div>

						<div className="space-y-3 text-[12px]">
							{updateInfo.releases.map((rel) => {
								const isCurrent = Boolean(rel.current);
								const isNewest = !isCurrent && rel.version === newRelease?.version;
								return (
									<div key={rel.version}>
										<div className="mb-1.5 flex items-center gap-2">
											<span className={cn("size-1.5 rounded-full", isCurrent ? "bg-faint" : "bg-primary")} />
											<span className={cn("font-mono text-[11px]", isCurrent ? "text-muted" : "text-primary")}>v{rel.version}</span>
											<span className="font-mono text-[10px] text-faint">{rel.date}</span>
											{isCurrent ? (
												<Badge>当前版本</Badge>
											) : (
												<Badge className={cn(isNewest ? "border-primary/40 bg-primary/10 text-primary" : "border-border text-muted")}>
													{isNewest ? (channel === "stable" ? "新版本" : "最新稳定版") : "历史版本"}
												</Badge>
											)}
										</div>
										<div className="space-y-1 border-l border-border pl-2 text-[11.5px] text-muted">
											{rel.items.map((item) => (
												<div key={item}>• {item}</div>
											))}
										</div>
									</div>
								);
							})}
						</div>
					</div>
				</div>

				{/* 弹窗底部操作条 */}
				<div className="flex h-12 items-center justify-between border-t border-border bg-surface px-4">
					<Checkbox
						checked={autoDownload}
						onChange={(next) => {
							setAutoDownload(next);
							toast({ title: next ? "已开启后台自动下载" : "已关闭后台自动下载", description: next ? "检测到新版本时静默下载并校验。" : "新版本需要手动点击下载。", tone: "default" });
						}}
						label="有新版本时在后台自动下载安装包"
					/>

					<div className="flex shrink-0 items-center gap-2">
						{state === "available" && (
							<>
								<Button onClick={remindLater}>稍后提醒</Button>
								<Button variant="primary" icon="icon-[lucide--download]" onClick={startDownload}>
									立即下载
								</Button>
							</>
						)}

						{state === "latest" && (
							<>
								<Button
									icon="icon-[lucide--refresh-cw]"
									onClick={() => toast({ title: "已是最新版本", description: `v${updateInfo.currentVersion} · 检查于刚刚`, tone: "success" })}
								>
									重新检测
								</Button>
								<Button variant="primary" onClick={() => navigate("/")}>
									关闭
								</Button>
							</>
						)}

						{state === "downloading" && !finished && (
							<>
								<Button onClick={cancelDownload}>取消下载</Button>
								<Button
									variant="primary"
									icon="icon-[lucide--arrow-down-to-line]"
									onClick={() => {
										toast({ title: "已转入后台下载", description: "下载完成后会提示重启安装。", tone: "default" });
										navigate("/");
									}}
								>
									后台继续
								</Button>
							</>
						)}

						{state === "downloading" && finished && (
							<>
								<Button onClick={remindLater}>稍后提醒</Button>
								<Button variant="primary" icon="icon-[lucide--refresh-cw]" onClick={applyUpdate}>
									立即重启并应用更新
								</Button>
							</>
						)}
					</div>
				</div>
			</div>

			<div className="relative z-10 mt-3 font-mono text-[10.5px] text-term-ink/50">
				TermX Desktop · Windows x64 · 更新过程不会中断正在运行的会话
			</div>
		</div>
	);
}
