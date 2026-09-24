export const frame = { width: 1440, height: 900, title: "编辑主机" };

import { Link } from "react-router";
import { WindowChrome } from "../components/WindowChrome";

const tabs = ["基本信息", "认证凭据", "跳板机网络", "高级选项", "外观终端"];

export default function HostEdit() {
	return (
		<WindowChrome activity="hosts">
			<div className="relative min-h-0 flex-1 bg-surface">
				{/* 底层主机网格预览 */}
				<div className="flex h-10 items-center justify-between border-b border-border bg-surface-sunk px-4">
					<div className="flex items-center gap-1.5 text-[12px] text-muted">
						<span>主机库</span>
						<span className="text-border">/</span>
						<span className="text-surface-foreground">订单服务集群</span>
					</div>
					<span className="mr-[480px] font-mono text-[11px] text-faint">8 台节点</span>
				</div>

				<div className="grid grid-cols-3 content-start gap-3 p-4 pr-[480px]">
					{["order-api-01", "order-api-02", "order-stage", "bastion-sh", "redis-test-01", "log-agg-node"].map((name) => (
						<div
							key={name}
							className="rounded-md border border-border bg-surface-raised p-3 text-[12px]"
						>
							<div className="font-mono font-medium text-surface-foreground">{name}</div>
							<div className="mt-1 font-mono text-[11px] text-muted">deploy@10.0.3.21</div>
						</div>
					))}
				</div>

				{/* Linear 风格侧滑抽屉 (460px) */}
				<aside className="absolute inset-y-0 right-0 flex w-[460px] flex-col border-l border-border bg-surface-raised shadow-xl">
					{/* 抽屉头部 */}
					<div className="flex h-11 items-center justify-between border-b border-border px-4">
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--server] size-4 text-primary" />
							<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">
								编辑主机配置
							</h1>
						</div>
						<Link
							to="/hosts"
							className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground"
							aria-label="关闭抽屉"
						>
							<span className="icon-[lucide--x] size-3.5" />
						</Link>
					</div>

					{/* 选项卡 */}
					<div className="flex gap-1 border-b border-border bg-surface-sunk p-2">
						{tabs.map((t, i) => (
							<button
								key={t}
								type="button"
								className={`rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors ${
									i === 1
										? "bg-surface-raised text-surface-foreground shadow-sm border border-border"
										: "text-muted hover:text-surface-foreground"
								}`}
							>
								{t}
							</button>
						))}
					</div>

					{/* 表单字段区 */}
					<div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4">
						<Field label="主机显示名称" value="order-api-01" />

						<div className="grid grid-cols-[1fr_80px] gap-2">
							<Field label="连接主机地址 (IP / 域名)" value="10.0.3.21" mono />
							<Field label="SSH 端口" value="22" mono />
						</div>

						<Field label="登录用户名" value="deploy" mono />

						{/* 认证方式切换 */}
						<div className="flex flex-col">
							<span className="mb-1 text-[11px] text-muted">认证方式</span>
							<div className="grid grid-cols-4 rounded border border-border bg-surface p-0.5 text-[11px]">
								{["密码", "私钥", "私钥+口令", "Agent"].map((m, i) => (
									<button
										key={m}
										type="button"
										className={`rounded py-1 text-center font-medium transition-colors ${
											i === 1
												? "bg-surface-raised text-surface-foreground shadow-sm border border-border"
												: "text-muted hover:text-surface-foreground"
										}`}
									>
										{m}
									</button>
								))}
							</div>
						</div>

						<Field label="指定私钥身份" value="工作笔记本 · Ed25519 (默认)" />

						{/* 生产环境提示卡片 */}
						<div className="rounded border border-env-prod/30 bg-env-prod/10 p-2.5 text-[11.5px] text-env-prod leading-relaxed">
							<div className="flex items-center gap-1.5 font-medium">
								<span className="icon-[lucide--shield-alert] size-3.5" />
								<span>生产环境 (PROD) 已激活</span>
							</div>
							<p className="mt-1 text-[11px] opacity-90">
								标签与终端将带红条标识，执行 rm -rf 等危险命令前必须二次弹窗确认。
							</p>
						</div>

						{/* 跳板机与高级折叠项 */}
						<div className="rounded border border-border bg-surface p-2.5 text-[11.5px]">
							<div className="flex items-center justify-between text-muted">
								<span className="flex items-center gap-1.5 font-medium text-surface-foreground">
									<span className="icon-[lucide--waypoints] size-3.5 text-primary" />
									跳板机链路
								</span>
								<span className="font-mono text-[11px]">bastion-sh (直连)</span>
							</div>
							<div className="mt-2 text-[10.5px] text-faint">
								高级选项：自动心跳 30s、UTF-8 编码、终端类型 xterm-256color（已折叠）
							</div>
						</div>
					</div>

					{/* 抽屉底部操作栏 */}
					<div className="flex h-12 items-center justify-between border-t border-border bg-surface-sunk px-4">
						<span className="flex items-center gap-1 text-[11px] text-warning">
							<span className="size-1.5 rounded-full bg-warning" />
							有未保存的修改
						</span>
						<div className="flex items-center gap-2">
							<Link
								to="/hosts"
								className="h-7 rounded border border-border bg-surface px-2.5 text-[11.5px] font-medium text-muted hover:bg-surface-raised hover:text-surface-foreground flex items-center"
							>
								取消
							</Link>
							<Link
								to="/"
								className="h-7 rounded bg-primary px-3 text-[11.5px] font-medium text-primary-foreground shadow-sm hover:opacity-90 flex items-center gap-1"
							>
								<span className="icon-[lucide--check] size-3" />
								保存主机
							</Link>
						</div>
					</div>
				</aside>
			</div>
		</WindowChrome>
	);
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div className="flex flex-col">
			<span className="mb-1 text-[11px] text-muted">{label}</span>
			<div className={`flex h-7.5 items-center rounded border border-border bg-surface px-2.5 text-[12px] text-surface-foreground ${mono ? "font-mono" : ""}`}>
				{value}
			</div>
		</div>
	);
}
