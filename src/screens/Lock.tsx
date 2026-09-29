import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { cn } from "@/lib/cn";
import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

/* 锁屏（对应 termx.vetd/frames/lock.tsx，需求书 06）。
 * 全窗口覆盖，不套 WindowChrome。状态：正常输入 / 密码错误（红色提示 + 剩余次数 + 输入框抖动）。
 * 演示规则：输入空或长度小于 4 视为错误，其余视为正确。
 * 右下角为骨架期评审用的状态切换器（也支持 ?state=error 深链）。 */

const MAX_ATTEMPTS = 5;

export default function Lock() {
	const navigate = useNavigate();
	const [search] = useSearchParams();

	const [password, setPassword] = useState("");
	const [remaining, setRemaining] = useState(MAX_ATTEMPTS);
	const [error, setError] = useState<string | null>(null);
	const [shakeKey, setShakeKey] = useState(0);
	const [previewError, setPreviewError] = useState(() => search.get("state") === "error");

	const showError = error !== null || previewError;
	const errorText = error ?? `主密码验证失败，剩余重试次数 ${Math.max(remaining - 1, 0)} 次`;

	const submit = () => {
		if (password.trim().length < 4) {
			const left = Math.max(remaining - 1, 0);
			setRemaining(left);
			setPreviewError(false);
			setError(
				left === 0
					? "主密码验证失败，已达到尝试上限，请稍后重试或重置应用缓存"
					: `主密码验证失败，剩余重试次数 ${left} 次`,
			);
			setPassword("");
			setShakeKey((key) => key + 1);
			return;
		}

		setError(null);
		setPreviewError(false);
		navigate("/");
	};

	return (
		<div className="relative flex h-full flex-col bg-surface-sunk text-surface-foreground antialiased selection:bg-primary/20">
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
					<span className="flex size-8 items-center justify-center hover:bg-surface-raised">
						<span className="icon-[lucide--minus] size-3.5" />
					</span>
					<span className="flex size-8 items-center justify-center hover:bg-surface-raised">
						<span className="icon-[lucide--square] size-3" />
					</span>
					<span className="flex size-8 items-center justify-center hover:bg-danger hover:text-primary-foreground">
						<span className="icon-[lucide--x] size-3.5" />
					</span>
				</div>
			</header>

			{/* 居中解锁窗口 */}
			<div className="flex flex-1 items-center justify-center p-4">
				<div className="w-[340px] rounded-lg border border-border bg-surface-raised p-6 text-center shadow-2xl">
					<div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border bg-surface text-primary">
						<span className="icon-[lucide--lock] size-5" />
					</div>

					<h1 className="mt-3 text-[16px] font-semibold tracking-tight text-surface-foreground">输入主密码解锁</h1>

					<p className="mt-1 text-[12px] text-muted">闲置 15 分钟自动锁定 · 8 个远程会话保持连接</p>

					<div className="mt-5 text-left">
						<label htmlFor="master-password" className="mb-1 block text-[11px] font-medium text-muted">
							主密码
						</label>

						{/* key 变化会重挂载输入框：既重新播抖动动画，也把焦点交回输入框 */}
						<div
							key={shakeKey}
							style={shakeKey ? { animation: "tx-lock-shake 340ms ease-in-out" } : undefined}
							className="relative"
						>
							<Input
								id="master-password"
								type="password"
								autoFocus
								value={password}
								onChange={(e) => {
									setPassword(e.target.value);
									setError(null);
								}}
								onKeyDown={(e) => e.key === "Enter" && submit()}
								placeholder="••••••••"
								className={cn(
									"h-8 pr-8 font-mono text-[14px] tracking-widest",
									showError && "border-danger/60 focus:border-danger/70 focus:ring-danger/30",
								)}
							/>
							<span className="icon-[lucide--key] pointer-events-none absolute top-1/2 right-3 size-3.5 -translate-y-1/2 text-muted" />
						</div>

						{showError && (
							<div className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
								<span className="icon-[lucide--alert-circle] size-3" />
								<span>{errorText}</span>
							</div>
						)}
					</div>

					<Button variant="primary" size="md" onClick={submit} className="mt-5 w-full">
						验证并解锁工作区
						<span className="icon-[lucide--unlock] size-3.5" />
					</Button>

					<div className="mt-4 flex items-center justify-center gap-2 font-mono text-[10px] text-faint">
						<span>按 Esc 最小化窗口</span>
						<span>·</span>
						<button type="button" className="cursor-pointer hover:text-muted">
							重置应用缓存
						</button>
					</div>
				</div>
			</div>

			{/* 状态切换器（骨架期评审工具） */}
			<div className="absolute right-3 bottom-3 flex items-center gap-1.5 rounded-control border border-border bg-surface-raised/95 px-2 py-1 shadow-lg">
				<span className="font-mono text-[9px] tracking-wider text-faint uppercase">状态</span>
				<button
					type="button"
					onClick={() => {
						setPreviewError(false);
						setError(null);
						setRemaining(MAX_ATTEMPTS);
						setPassword("");
					}}
					className={cn(
						"rounded px-1.5 py-0.5 text-[10.5px] transition-colors",
						!showError ? "border border-border bg-surface font-medium text-surface-foreground" : "text-muted hover:text-surface-foreground",
					)}
				>
					正常输入
				</button>
				<button
					type="button"
					onClick={() => {
						setPreviewError(true);
						setError(null);
						setRemaining(MAX_ATTEMPTS);
						setPassword("");
					}}
					className={cn(
						"rounded px-1.5 py-0.5 text-[10.5px] transition-colors",
						showError ? "border border-border bg-surface font-medium text-surface-foreground" : "text-muted hover:text-surface-foreground",
					)}
				>
					密码错误
				</button>
			</div>

			{/* 输入框抖动的关键帧（token 之外不改动全局样式） */}
			<style>
				{`@keyframes tx-lock-shake {
					0%, 100% { transform: translateX(0); }
					15% { transform: translateX(-6px); }
					30% { transform: translateX(5px); }
					45% { transform: translateX(-4px); }
					60% { transform: translateX(3px); }
					80% { transform: translateX(-2px); }
				}`}
			</style>
		</div>
	);
}
