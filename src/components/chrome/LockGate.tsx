import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { autoLockMs } from "@/data/preferences";
import { cn } from "@/lib/cn";
import { useLockStore } from "@/store/lock";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { useEffect, useState, type ReactNode } from "react";

/* =============================================================================
 * 应用锁：设置页的「启动时锁定」「闲置自动锁定」和 Ctrl+Shift+L 都由它来兑现。
 *
 * 覆盖层盖在整棵界面之上 —— 终端只是被挡住，SSH 会话与滚动缓冲原样保留，
 * 解锁后继续用，不会因为锁屏断线。
 * ========================================================================== */

/** 算作「有人在用」的动作 */
const ACTIVITY_EVENTS = ["mousemove", "mousedown", "keydown", "wheel"] as const;
/** 连续输错这么多次后进入冷却 */
const MAX_ATTEMPTS = 5;
const COOLDOWN_SECONDS = 30;

export function LockGate({ children }: { children: ReactNode }) {
	const locked = useLockStore((s) => s.locked);
	const autoLock = useSettingsStore((s) => s.autoLock);
	const hasPassword = useSettingsStore((s) => s.lockVerifier !== null);

	// 启动即锁：配置在渲染前已经水合，这里只跑一次
	useEffect(() => {
		if (!useSettingsStore.getState().startLocked) return;
		if (!useLockStore.getState().lock()) {
			toast({ title: "已开启启动锁定，但还没有设置解锁密码", tone: "warning" });
		}
	}, []);

	// 闲置自动锁定：有任何键鼠动作就重新计时；锁屏期间不计时
	useEffect(() => {
		const ms = autoLockMs(autoLock);
		if (ms === null || !hasPassword || locked) return;
		const lockNow = () => useLockStore.getState().lock();
		let timer = window.setTimeout(lockNow, ms);
		const reset = () => {
			window.clearTimeout(timer);
			timer = window.setTimeout(lockNow, ms);
		};
		ACTIVITY_EVENTS.forEach((name) => window.addEventListener(name, reset, { passive: true }));
		return () => {
			window.clearTimeout(timer);
			ACTIVITY_EVENTS.forEach((name) => window.removeEventListener(name, reset));
		};
	}, [autoLock, hasPassword, locked]);

	// Ctrl+Shift+L 立即锁定（快捷键表里登记的就是这个组合）
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
			if (event.key.toLowerCase() !== "l") return;
			event.preventDefault();
			if (!useLockStore.getState().lock()) {
				toast({ title: "还没有设置解锁密码", description: "到 设置 → 安全与主密码 里设置后才能锁定", tone: "warning" });
			}
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<>
			{children}
			{locked && <LockScreen />}
		</>
	);
}

function LockScreen() {
	const [password, setPassword] = useState("");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [failures, setFailures] = useState(0);
	const [cooldown, setCooldown] = useState(0);

	// 冷却倒计时：真实计时器，走完才允许再试
	useEffect(() => {
		if (cooldown <= 0) return;
		const timer = window.setTimeout(() => setCooldown((value) => value - 1), 1000);
		return () => window.clearTimeout(timer);
	}, [cooldown]);

	const submit = async () => {
		if (busy || cooldown > 0 || password === "") return;
		setBusy(true);
		const ok = await useLockStore.getState().unlock(password);
		setBusy(false);
		if (ok) {
			setPassword("");
			setError(null);
			setFailures(0);
			return;
		}
		const next = failures + 1;
		setFailures(next);
		setPassword("");
		if (next >= MAX_ATTEMPTS) {
			setCooldown(COOLDOWN_SECONDS);
			setError(`密码连续错误 ${next} 次，${COOLDOWN_SECONDS} 秒后可再试`);
			return;
		}
		setError(`密码不正确（已失败 ${next} 次）`);
	};

	return (
		<div className="fixed inset-0 z-[100] flex flex-col bg-surface-sunk text-surface-foreground antialiased">
			<div className="flex flex-1 items-center justify-center p-4">
				<div className="w-[340px] rounded-lg border border-border bg-surface-raised p-6 text-center shadow-2xl">
					<div className="mx-auto flex size-10 items-center justify-center rounded-md border border-border bg-surface text-primary">
						<span className="icon-[lucide--lock] size-5" />
					</div>
					<h1 className="mt-3 text-[16px] font-semibold tracking-tight text-surface-foreground">已锁定</h1>
					<p className="mt-1 text-[12px] text-muted">输入解锁密码继续使用</p>

					<div className="mt-5 text-left">
						<label htmlFor="unlock-password" className="mb-1 block text-[11px] font-medium text-muted">
							解锁密码
						</label>
						<Input
							id="unlock-password"
							type="password"
							autoFocus
							value={password}
							disabled={busy || cooldown > 0}
							onChange={(event) => {
								setPassword(event.target.value);
								setError(null);
							}}
							onKeyDown={(event) => {
								if (event.key === "Enter") void submit();
							}}
							placeholder="••••••••"
							className={cn("h-8 font-mono text-[14px] tracking-widest", error !== null && "border-danger/60")}
						/>
						{error && (
							<div className="mt-2 flex items-center gap-1.5 text-[11px] text-danger">
								<span className="icon-[lucide--alert-circle] size-3" />
								<span>{error}</span>
							</div>
						)}
					</div>

					<Button variant="primary" size="md" disabled={busy || cooldown > 0 || password === ""} onClick={() => void submit()} className="mt-5 w-full">
						{busy ? "校验中…" : "解锁"}
						<span className="icon-[lucide--unlock] size-3.5" />
					</Button>

					<div className="mt-4 font-mono text-[10px] text-faint">忘了密码只能在设置页重设</div>
				</div>
			</div>
		</div>
	);
}
