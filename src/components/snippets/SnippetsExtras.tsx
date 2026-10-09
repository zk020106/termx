import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Overlay";
import type { Snippet } from "@/data/types";
import { currentHotkeyContext } from "@/lib/hotkeys";
import { KEY_BINDING_LABELS_ZH, keyEventToString, keyStringToKeyboardEvent, matchKeyBinding, matchesKeyBinding } from "@/lib/keyBindings";
import { formatHistoryTime, type ShellHistoryEntry } from "@/lib/shellHistory";
import { useShellHistoryStore } from "@/store/shellHistory";
import { useEffect, useMemo, useRef, useState } from "react";

/* =============================================================================
 * Netcatty SnippetsManager 的三块：快捷键录制（snippets.shortkey.*）、
 * Shell 历史面板（SnippetsHistoryItem / 加载更多 / 保存为代码片段）。文案取 Netcatty zh-CN。
 * ========================================================================== */

/** Netcatty validateShortkey：先查系统快捷键冲突，再查其它片段 */
export function validateShortkey(key: string, others: Snippet[]): string | null {
	if (!key) return null;
	const ctx = currentHotkeyContext();
	const synthetic = keyStringToKeyboardEvent(key);
	if (synthetic && ctx.scheme !== "disabled") {
		const hit = matchKeyBinding(synthetic, ctx.bindings, ctx.isMac);
		if (hit) return `此快捷键与「${KEY_BINDING_LABELS_ZH[hit.id] ?? hit.label}」冲突`;
	}
	const normalize = (v: string) => v.toLowerCase().replace(/\s+/g, "");
	for (const snippet of others) {
		if (!snippet.shortkey) continue;
		const conflict = synthetic ? matchesKeyBinding(synthetic, snippet.shortkey, ctx.isMac) : normalize(snippet.shortkey) === normalize(key);
		if (conflict) return `此快捷键已被代码片段使用：${snippet.name}`;
	}
	return null;
}

export function ShortkeyField({ value, onChange, others }: { value?: string; onChange: (v: string | undefined) => void; others: Snippet[] }) {
	const [recording, setRecording] = useState(false);
	const [error, setError] = useState<string | null>(null);
	useEffect(() => {
		if (!recording) return;
		const onKey = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRecording(false);
				setError(null);
				return;
			}
			if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
			const keyString = keyEventToString(e, currentHotkeyContext().isMac);
			const problem = validateShortkey(keyString, others);
			if (problem) {
				setError(problem);
				return;
			}
			setError(null);
			onChange(keyString);
			setRecording(false);
		};
		const onClick = () => {
			setRecording(false);
			setError(null);
		};
		const timer = window.setTimeout(() => window.addEventListener("click", onClick, true), 100);
		window.addEventListener("keydown", onKey, true);
		return () => {
			window.clearTimeout(timer);
			window.removeEventListener("keydown", onKey, true);
			window.removeEventListener("click", onClick, true);
		};
	}, [recording, others, onChange]);
	return (
		<Field label="快捷键" hint="在终端中按下此快捷键可快速发送命令。" error={error ?? undefined}>
			<div className="flex items-center gap-1">
				<button
					type="button"
					onClick={() => setRecording(true)}
					className="h-7 flex-1 rounded border border-border bg-surface px-2 text-left font-mono text-[11px] text-surface-foreground hover:border-primary/60"
				>
					{recording ? <span className="text-primary">请按下快捷键组合...</span> : value ? value : <span className="text-faint">点击设置快捷键</span>}
				</button>
				{value && !recording && (
					<Button size="sm" variant="ghost" icon="icon-[lucide--x]" title="清除快捷键" onClick={() => onChange(undefined)} />
				)}
			</div>
		</Field>
	);
}

const HISTORY_PAGE_SIZE = 30;

function HistoryItem({ entry, onSave, onCopy, copied }: { entry: ShellHistoryEntry; onSave: (label: string) => void; onCopy: () => void; copied: boolean }) {
	const [editing, setEditing] = useState(false);
	const [label, setLabel] = useState("");
	const save = () => {
		if (!label.trim()) return;
		onSave(label.trim());
		setEditing(false);
		setLabel("");
	};
	return (
		<div className="group rounded-lg border border-border/60 bg-surface p-2.5">
			<div className="flex items-start gap-2">
				<div className="min-w-0 flex-1">
					<div className="truncate font-mono text-[12px] text-surface-foreground">{entry.command}</div>
					<div className="mt-1 flex items-center gap-1.5 text-[10.5px] text-faint">
						<span>{entry.hostLabel}</span>
						<span>•</span>
						<span>{formatHistoryTime(entry.timestamp)}</span>
					</div>
				</div>
				{!editing && (
					<div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
						<Button size="sm" variant="ghost" icon={copied ? "icon-[lucide--check]" : "icon-[lucide--copy]"} onClick={onCopy} />
						<Button size="sm" variant="primary" onClick={() => setEditing(true)}>
							保存
						</Button>
					</div>
				)}
			</div>
			{editing && (
				<div className="mt-2 space-y-2">
					<Input autoFocus placeholder="为此代码片段设置一个 Label" value={label} onChange={(e) => setLabel(e.target.value)} onKeyDown={(e) => e.key === "Enter" && save()} />
					<div className="flex justify-end gap-2">
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								setEditing(false);
								setLabel("");
							}}
						>
							取消
						</Button>
						<Button size="sm" variant="primary" disabled={!label.trim()} onClick={save}>
							保存为代码片段
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

export function ShellHistoryDrawer({ open, onClose, onSaveAsSnippet }: { open: boolean; onClose: () => void; onSaveAsSnippet: (entry: ShellHistoryEntry, label: string) => void }) {
	const entries = useShellHistoryStore((s) => s.entries);
	const [visible, setVisible] = useState(HISTORY_PAGE_SIZE);
	const [copiedId, setCopiedId] = useState<string | null>(null);
	const scrollRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (open) setVisible(HISTORY_PAGE_SIZE);
	}, [open]);
	const shown = useMemo(() => entries.slice(0, visible), [entries, visible]);
	const hasMore = visible < entries.length;
	return (
		<Drawer open={open} onClose={onClose} title="Shell 历史" subtitle={`${entries.length} 条命令`} width={460}>
			<div
				ref={scrollRef}
				className="h-full space-y-2 overflow-y-auto p-3"
				onScroll={(e) => {
					const el = e.currentTarget;
					if (el.scrollHeight - el.scrollTop - el.clientHeight < 100 && hasMore) setVisible((v) => Math.min(v + HISTORY_PAGE_SIZE, entries.length));
				}}
			>
				{entries.length === 0 ? (
					<div className="py-10 text-center">
						<span className="icon-[lucide--clock] size-6 text-faint" />
						<div className="mt-2 text-[12px] font-medium text-surface-foreground">暂无 Shell 历史</div>
						<div className="mt-1 text-[11px] text-muted">你执行过的命令会显示在这里</div>
					</div>
				) : (
					<>
						{shown.map((entry) => (
							<HistoryItem
								key={entry.id}
								entry={entry}
								copied={copiedId === entry.id}
								onCopy={() => {
									void navigator.clipboard?.writeText(entry.command).catch(() => undefined);
									setCopiedId(entry.id);
									window.setTimeout(() => setCopiedId((id) => (id === entry.id ? null : id)), 1500);
								}}
								onSave={(label) => onSaveAsSnippet(entry, label)}
							/>
						))}
						{hasMore && (
							<Button size="sm" variant="ghost" className="w-full" onClick={() => setVisible((v) => Math.min(v + HISTORY_PAGE_SIZE, entries.length))}>
								加载更多
							</Button>
						)}
					</>
				)}
			</div>
		</Drawer>
	);
}
