export const frame = { width: 1440, height: 900, title: "锁屏" };

import { Link } from "react-router";

export default function Lock() {
	return (
		<div className="flex h-full flex-col bg-surface-sunk text-surface-foreground antialiased selection:bg-primary/20">
			{/* Windows 顶栏 */}
			<header className="flex h-9 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3">
				<div className="flex items-center gap-2">
					<div className="flex size-5 items-center justify-center rounded bg-primary/15 text-primary">
						<span className="icon-[lucide--terminal] size-3.5" />
					</div>
					<span className="text-[12px] font-semibold tracking-tight text-surface-foreground">TermX</span>
					<span className="font-mono text-[10px] text-faint">应用锁屏</span>
				</div>
				<div className="flex items-center text-muted">
					<span className="flex size-8 items-center justify-center hover:bg-surface-raised"><span className="icon-[lucide--minus] size-3.5" /></span>
					<span className="flex size-8 items-center justify-center hover:bg-surface-raised"><span className="icon-[lucide--square] size-3" /></span>
					<span className="flex size-8 items-center justify-center hover:bg-danger hover:text-primary-foreground"><span className="icon-[lucide--x] size-3.5" /></span>
				</div>
			</header>

			{/* 居中解锁窗口 (Linear 极简风) */}
			<div className="flex flex-1 items-center justify-center p-4">
				<div className="w-[340px] rounded-lg border border-border bg-surface-raised p-6 shadow-2xl text-center">
					<div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border bg-surface text-primary">
						<span className="icon-[lucide--lock] size-5" />
					</div>

					<h1 className="mt-3 text-[16px] font-semibold tracking-tight text-surface-foreground">
						输入主密码解锁
					</h1>

					<p className="mt-1 text-[12px] text-muted">
						闲置 15 分钟自动锁定 · 8 个远程会话保持连接
					</p>

					<div className="mt-5 text-left">
						<label className="mb-1 text-[11px] font-medium text-muted block">主密码</label>
						<div className="flex h-8 items-center justify-between rounded border border-border bg-surface px-3 font-mono text-[14px] tracking-widest text-surface-foreground">
							<span>••••••••</span>
							<span className="icon-[lucide--key] size-3.5 text-muted" />
						</div>

						{/* 错误提示 */}
						<div className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
							<span className="icon-[lucide--alert-circle] size-3" />
							<span>主密码验证失败，剩余重试次数 4 次</span>
						</div>
					</div>

					<Link
						to="/"
						className="mt-5 flex h-8 w-full items-center justify-center gap-1.5 rounded bg-primary text-[12px] font-medium text-primary-foreground shadow-sm hover:opacity-90"
					>
						<span>验证并解锁工作区</span>
						<span className="icon-[lucide--unlock] size-3.5" />
					</Link>

					<div className="mt-4 flex items-center justify-center gap-2 font-mono text-[10px] text-faint">
						<span>按 Esc 最小化窗口</span>
						<span>·</span>
						<span className="hover:text-muted cursor-pointer">重置应用缓存</span>
					</div>
				</div>
			</div>
		</div>
	);
}
