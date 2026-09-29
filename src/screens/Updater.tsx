import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, Segmented } from "@/components/ui/Display";
import { Checkbox } from "@/components/ui/Toggle";
import { toast } from "@/store/toast";
import { useState } from "react";
import { Link, useNavigate } from "react-router";

/* =============================================================================
 * 版本更新 —— 设计帧 termx.vetd/frames/updater.tsx 的骨架版本。
 * 对话框形式：不套 WindowChrome，根节点 h-full 居中一张 560px 卡片。
 * 覆盖状态（需求书 06-更新）：有新版本 / 已是最新 / 下载中——三者都要求真实的更新源，
 * 目前还没有接入，因此卡片主体是「更新服务尚未接入」空状态 + 手动检查入口，
 * 不再展示任何示例版本号、更新日志或下载进度。
 * ========================================================================== */

type Channel = "stable" | "beta";

export default function Updater() {
	const navigate = useNavigate();
	const [channel, setChannel] = useState<Channel>("stable");
	const [autoDownload, setAutoDownload] = useState(true);

	const checkUpdate = () =>
		toast({
			title: "更新服务尚未接入",
			description: "TermX 还没有配置更新源，暂时检查不到新版本。",
			tone: "default",
		});

	const switchChannel = (next: Channel) => {
		setChannel(next);
		toast({
			title: next === "stable" ? "已切换到稳定通道" : "已切换到尝鲜通道 (Beta)",
			description: "更新服务尚未接入，暂时无法按新通道检测更新。",
			tone: "default",
		});
	};

	return (
		/* 整页浮层：底色用应用表面色（跟主题走），不用终端画布色 */
		<div className="relative flex h-full flex-col items-center justify-center overflow-y-auto bg-surface-sunk p-4">
			{/* 背景虚化的主工作台光晕（token 颜色，不硬编码） */}
			<div aria-hidden className="pointer-events-none absolute -top-10 -left-20 size-72 rounded-full bg-primary/10 blur-3xl" />
			<div aria-hidden className="pointer-events-none absolute -right-16 bottom-0 size-80 rounded-full bg-accent/10 blur-3xl" />

			{/* 浮动更新发布弹窗 (Linear / Raycast 风格 560px) */}
			<div className="relative z-10 w-[560px] overflow-hidden rounded-lg border border-border bg-surface-raised shadow-2xl">
				{/* 弹窗顶栏 */}
				<div className="flex h-12 items-center justify-between border-b border-border bg-surface px-4">
					<div className="flex items-center gap-2.5">
						<div className="flex size-6 items-center justify-center rounded bg-primary/15 text-primary">
							<span className="icon-[lucide--sparkles] size-3.5" />
						</div>
						<div className="flex items-center gap-2">
							<h1 className="text-[13px] font-semibold text-surface-foreground">TermX 软件更新</h1>
							<Badge>更新服务未接入</Badge>
						</div>
					</div>

					<div className="flex items-center gap-2">
						<span className="font-mono text-[10.5px] text-faint">当前版本信息未接入</span>
						<Link
							to="/settings"
							className="flex size-6 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
							aria-label="关闭"
						>
							<span className="icon-[lucide--x] size-3.5" />
						</Link>
					</div>
				</div>

				{/* 弹窗主体 */}
				<div className="max-h-[calc(100vh-9rem)] space-y-4 overflow-y-auto p-4">
					{/* 没有更新源：主体是空状态 + 手动检查入口 */}
					<div className="rounded border border-border bg-surface">
						<EmptyState
							icon="icon-[lucide--cloud-off]"
							title="更新服务尚未接入"
							action={
								<Button variant="primary" icon="icon-[lucide--refresh-cw]" onClick={checkUpdate}>
									检查更新
								</Button>
							}
						/>
					</div>

					{/* 渠道切换：偏好可以改，但检测能力还没接入 */}
					<div className="flex items-center justify-between gap-3 rounded border border-border bg-surface px-3 py-2">
						<div className="min-w-0">
							<div className="text-[11.5px] font-medium text-surface-foreground">软件更新通道</div>
							<div className="mt-0.5 text-[10.5px] text-faint">
								{channel === "stable" ? "正式稳定版" : "尝鲜预览版，可能不稳定"}
							</div>
						</div>
						<Segmented
							value={channel}
							onChange={switchChannel}
							options={[
								{ value: "stable", label: "stable" },
								{ value: "beta", label: "beta" },
							]}
						/>
					</div>

					{/* 更新日志：与版本清单一同来自更新服务 */}
					<div>
						<div className="mb-2 flex items-center justify-between">
							<span className="font-mono text-[10.5px] font-medium tracking-wider text-faint uppercase">
								更新日志 (What's New)
							</span>
							<span className="font-mono text-[10px] text-faint">0 个版本</span>
						</div>
						<div className="rounded border border-dashed border-border px-3 py-4 text-center text-[11.5px] text-faint">
							还没有可显示的更新日志 · 等待接入更新服务
						</div>
					</div>
				</div>

				{/* 弹窗底部操作条 */}
				<div className="flex h-12 items-center justify-between border-t border-border bg-surface px-4">
					<Checkbox
						checked={autoDownload}
						onChange={(next) => {
							setAutoDownload(next);
							toast({
								title: next ? "已开启后台自动下载" : "已关闭后台自动下载",
								description: "更新服务尚未接入，该偏好接入后才会生效。",
								tone: "default",
							});
						}}
						label="有新版本时在后台自动下载安装包"
					/>

					<div className="flex shrink-0 items-center gap-2">
						{/* 更新页只从设置页进，关闭就回设置页（首页是主机库，不该把人丢到那里） */}
						<Button onClick={() => navigate("/settings")}>关闭</Button>
					</div>
				</div>
			</div>

			<div className="relative z-10 mt-3 font-mono text-[10.5px] text-faint">TermX Desktop · Windows x64</div>
		</div>
	);
}
