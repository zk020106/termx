import { cn } from "@/lib/cn";
import { useToastStore, type ToastTone } from "@/store/toast";
import { useEffect, useState, type ReactNode } from "react";
import { Button, Kbd } from "./Button";
import { Input } from "./Input";

/* =============================================================================
 * 浮层：右侧抽屉、模态框、危险确认、Toast。
 * 原则（需求书 03-2）：少用模态弹窗 —— 编辑用抽屉，只有危险操作与指纹确认才用模态。
 * ========================================================================== */

/** 右侧抽屉：编辑主机、查看详情 */
export function Drawer({
	open,
	onClose,
	title,
	subtitle,
	width = 460,
	footer,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	subtitle?: ReactNode;
	width?: number;
	footer?: ReactNode;
	children: ReactNode;
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div className="absolute inset-0 z-40 flex justify-end">
			<button
				type="button"
				aria-label="关闭抽屉"
				onClick={onClose}
				className="absolute inset-0 cursor-default bg-black/40 backdrop-blur-[1px]"
			/>
			<aside
				role="dialog"
				aria-modal="true"
				style={{ width }}
				className="relative flex h-full flex-col border-l border-border bg-surface-raised shadow-lg"
			>
				<header className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border px-3">
					<div className="min-w-0">
						<div className="truncate text-[12.5px] font-semibold tracking-tight text-surface-foreground">{title}</div>
						{subtitle && <div className="truncate text-[10.5px] text-faint">{subtitle}</div>}
					</div>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭"
						className="flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground"
					>
						<span className="icon-[lucide--x] size-3.5" />
					</button>
				</header>

				<div className="min-h-0 flex-1 overflow-y-auto">{children}</div>

				{footer && (
					<footer className="flex h-11 shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-3">
						{footer}
					</footer>
				)}
			</aside>
		</div>
	);
}

/** 居中模态框：指纹确认、连接失败详情等 */
export function Modal({
	open,
	onClose,
	title,
	icon,
	width = 400,
	footer,
	children,
}: {
	open: boolean;
	onClose: () => void;
	title: ReactNode;
	icon?: string;
	width?: number;
	footer?: ReactNode;
	children: ReactNode;
}) {
	useEffect(() => {
		if (!open) return;
		const onKey = (e: KeyboardEvent) => {
			if (e.key === "Escape") onClose();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [open, onClose]);

	if (!open) return null;

	return (
		<div className="absolute inset-0 z-50 flex items-center justify-center p-6">
			<button type="button" aria-label="关闭" onClick={onClose} className="absolute inset-0 cursor-default bg-black/50" />
			<div
				role="dialog"
				aria-modal="true"
				style={{ width }}
				className="relative flex max-h-full flex-col overflow-hidden rounded-card border border-border bg-surface-raised shadow-lg"
			>
				<header className="flex items-center gap-2 border-b border-border px-3 py-2.5">
					{icon && <span className={cn(icon, "size-4 text-warning")} />}
					<span className="text-[12.5px] font-semibold tracking-tight text-surface-foreground">{title}</span>
					<button
						type="button"
						onClick={onClose}
						aria-label="关闭"
						className="ml-auto flex size-6 items-center justify-center rounded text-muted hover:bg-surface hover:text-surface-foreground"
					>
						<span className="icon-[lucide--x] size-3.5" />
					</button>
				</header>
				<div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 text-[11.5px] leading-5 text-muted">{children}</div>
				{footer && (
					<footer className="flex shrink-0 items-center justify-end gap-2 border-t border-border bg-surface px-3 py-2.5">
						{footer}
					</footer>
				)}
			</div>
		</div>
	);
}

/** 危险确认：必须手动输入主机名才能继续（需求书 06-通用组件） */
export function DangerousConfirm({
	open,
	onClose,
	onConfirm,
	hostName,
	action,
	description,
}: {
	open: boolean;
	onClose: () => void;
	onConfirm: () => void;
	hostName: string;
	action: string;
	description?: string;
}) {
	const [typed, setTyped] = useState("");
	useEffect(() => {
		if (open) setTyped("");
	}, [open]);

	const matched = typed.trim() === hostName;

	return (
		<Modal
			open={open}
			onClose={onClose}
			title={`确认在生产主机上执行：${action}`}
			icon="icon-[lucide--triangle-alert]"
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="danger" disabled={!matched} onClick={onConfirm}>
						确认执行
					</Button>
				</>
			}
		>
			<p className="mb-2">
				{description ?? "该操作会影响生产环境，且无法撤销。"}请手动输入主机名以确认：
			</p>
			<Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder={hostName} className="font-mono" />
			<div className="mt-2 flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
				<span className="icon-[lucide--info] size-3" />
				需与服务端主机名完全一致
			</div>
		</Modal>
	);
}

const toneClass: Record<ToastTone, string> = {
	default: "border-border",
	success: "border-success/40",
	warning: "border-warning/40",
	danger: "border-danger/40",
};

/** Toast 容器：删除类操作带「撤销」（需求书 03-6） */
export function Toaster() {
	const toasts = useToastStore((s) => s.toasts);
	const dismiss = useToastStore((s) => s.dismiss);

	if (toasts.length === 0) return null;

	return (
		<div className="pointer-events-none absolute bottom-9 left-1/2 z-50 flex w-[min(420px,80vw)] -translate-x-1/2 flex-col gap-1.5">
			{toasts.map((t) => (
				<div
					key={t.id}
					className={cn(
						"pointer-events-auto flex items-start gap-2 rounded-card border bg-surface-raised px-3 py-2 shadow-lg",
						toneClass[t.tone],
					)}
				>
					<div className="min-w-0 flex-1">
						<div className="text-[11.5px] font-medium text-surface-foreground">{t.title}</div>
						{t.description && <div className="mt-0.5 text-[10.5px] text-muted">{t.description}</div>}
					</div>
					{t.action && (
						<button
							type="button"
							onClick={() => {
								t.action?.run();
								dismiss(t.id);
							}}
							className="shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium text-primary hover:bg-primary/10"
						>
							{t.action.label}
						</button>
					)}
					<button
						type="button"
						onClick={() => dismiss(t.id)}
						aria-label="关闭提示"
						className="flex size-5 shrink-0 items-center justify-center rounded text-faint hover:bg-surface hover:text-surface-foreground"
					>
						<span className="icon-[lucide--x] size-3" />
					</button>
				</div>
			))}
		</div>
	);
}

/** 快捷键提示气泡（共用） */
export function Hint({ children, keys }: { children: ReactNode; keys: string[] }) {
	return (
		<span className="inline-flex items-center gap-1.5 text-[10.5px] text-faint">
			{children}
			{keys.map((k) => (
				<Kbd key={k}>{k}</Kbd>
			))}
		</span>
	);
}
