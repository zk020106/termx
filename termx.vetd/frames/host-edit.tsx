export const frame = { width: 1440, height: 900, title: "编辑主机" };

import { Link } from "react-router";
import { WindowChrome } from "../components/WindowChrome";

const tabs = ["基本信息", "认证凭据", "跳板机网络", "高级选项", "外观终端"];

export default function HostEdit() {
	return (
		<WindowChrome activity="hosts">
			<div className="relative min-h-0 flex-1 bg-surface-sunk">
				{/* 底层主机网格预览 */}
				<div className="flex h-12 items-center justify-between px-6 border-b border-border/40">
					<div className="text-[13px] text-muted">
						主机库 <span className="text-border">/</span> 订单服务集群
					</div>
					<span className="mr-[480px] font-mono text-[11px] text-faint">8 台节点</span>
				</div>

				<div className="grid grid-cols-3 content-start gap-4 p-6 pr-[500px]">
					{["order-api-01", "order-api-02", "order-stage", "bastion-sh", "redis-test-01", "log-agg"].map((name) => (
						<div
							key={name}
							className="rounded-xl border border-white/[0.06] bg-surface-raised/60 p-4 text-[13px]"
						>
							<div className="font-semibold text-surface-foreground">{name}</div>
							<div className="mt-1 font-mono text-[11px] text-faint">deploy@10.0.3.21</div>
						</div>
					))}
				</div>

				{/* Linear 级高级磨砂右滑抽屉 */}
				<aside className="absolute inset-y-0 right-0 flex w-[480px] flex-col border-l border-white/[0.1] bg-surface-raised/95 shadow-[-24px_0_64px_rgba(0,0,0,0.85)] backdrop-blur-2xl">
					{/* 抽屉标题栏 */}
					<div className="flex h-14 items-center justify-between border-b border-border/70 px-5">
						<div className="flex items-center gap-2">
							<span className="icon-[lucide--server] size-4 text-accent drop-shadow-[0_0_8px_var(--color-accent)]" />
							<h1 className="font-display text-[15px] font-semibold tracking-tight text-surface-foreground">
								编辑主机配置
							</h1>
						</div>
						<Link
							to="/hosts"
							className="grid size-7 place-items-center rounded-lg text-muted hover:bg-white/[0.06] hover:text-surface-foreground transition-colors"
							aria-label="关闭抽屉"
						>
							<span className="icon-[lucide--x] size-4" />
						</Link>
					</div>

					{/* 导航分栏胶囊 */}
					<div className="flex gap-1 border-b border-border/50 px-4 py-2.5">
						{tabs.map((t, i) => (
							<button
								key={t}
								type="button"
								className={`rounded-lg px-2.5 py-1 text-[12px] font-medium transition-colors ${
									i === 1
										? "bg-accent-soft text-accent border border-accent/30 shadow-sm"
										: "text-muted hover:text-surface-foreground hover:bg-white/[0.04]"
								}`}
							>
								{t}
							</button>
						))}
					</div>

					{/* 表单字段区 */}
					<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-5 py-5">
						<Field label="主机显示名称" value="order-api-01" />

						<div className="grid grid-cols-[1fr_96px] gap-3">
							<Field label="IPv4 / 域名地址" value="10.0.3.21" mono />
							<Field label="端口" value="22" mono />
						</div>

						<Field label="SSH 登录用户名" value="deploy" mono />

						<div>
							<div className="mb-1.5 flex items-center justify-between text-[12px]">
								<span className="font-medium text-surface-foreground">认证凭据方式</span>
								<span className="text-[11px] text-faint">推荐 Ed25519 秘钥</span>
							</div>
							<div className="flex h-9 items-center rounded-lg border border-white/[0.07] bg-surface-sunk p-0.5 text-[12px]">
								{["密码验证", "私钥凭据", "私钥+Passphrase", "Agent 转发"].map((m, i) => (
									<span
										key={m}
										className={`flex-1 rounded-md text-center py-1 font-medium transition-all ${
											i === 1
												? "bg-surface-raised text-accent border border-white/[0.08] shadow-sm"
												: "text-muted hover:text-surface-foreground"
										}`}
									>
										{m}
									</span>
								))}
							</div>
						</div>

						<Field label="选择私钥文件" value="工作笔记本专用 · id_ed25519_prod" />

						{/* 生产环境配置提示 */}
						<div className="rounded-lg border border-border bg-surface-sunk/60 p-3 text-[12px] text-muted">
							<div className="flex items-center gap-2">
								<EnvPill env="PROD" />
								<span className="font-medium text-surface-foreground">生产环境安全确认</span>
							</div>
							<p className="mt-1 text-[11px] text-faint leading-relaxed">
								该主机保存后标签与状态栏将标识为生产环境，执行高危命令或粘贴多行脚本前需二次确认。
							</p>
						</div>

						<div className="rounded-lg border border-white/[0.06] bg-surface/50 p-3 text-[11px] text-muted">
							<span className="font-mono text-accent">跳板拓扑：</span>
							<span>bastion-sh (10.0.0.4) → 本机安全隧道。高级选项已折叠。</span>
						</div>
					</div>

					{/* 抽屉底部操作条 */}
					<div className="flex h-14 items-center justify-between border-t border-border px-5 bg-surface-sunk/60">
						<span className="flex items-center gap-1.5 text-[12px] text-warning font-mono">
							<span className="size-1.5 rounded-full bg-warning animate-pulse" />
							<span>检测到未保存配置</span>
						</span>
						<div className="flex items-center gap-2.5">
							<Link
								to="/hosts"
								className="rounded-lg border border-white/10 px-3.5 py-1.5 text-[13px] text-muted hover:text-surface-foreground hover:bg-white/[0.04] transition-colors"
							>
								放弃更改
							</Link>
							<Link
								to="/"
								className="rounded-lg bg-accent px-4 py-1.5 text-[13px] font-semibold text-primary-foreground shadow-[0_0_16px_-2px_var(--color-accent)] transition-all hover:brightness-110 active:scale-95"
							>
								保存配置
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
		<label className="flex flex-col gap-1.5">
			<span className="text-[12px] font-medium text-surface-foreground">{label}</span>
			<span
				className={`flex h-9 items-center rounded-lg border border-white/[0.08] bg-surface/80 px-3 text-[13px] text-surface-foreground shadow-inner focus-within:border-accent/60 ${
					mono ? "font-mono" : ""
				}`}
			>
				{value}
			</span>
		</label>
	);
}
