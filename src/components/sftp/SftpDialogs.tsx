import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Overlay";
import { getFileExtension, hasFileExtension, isKnownBinaryFile } from "@/lib/sftpArchive";
import type { SftpFileEntry } from "@/lib/sftp";
import { useEffect, useState } from "react";

/* SFTP 右键菜单配套的两个对话框：
 * - 权限：对应 Netcatty SftpPermissionsDialog（所有者 / 群组 / 其他 × 读写执行，显示八进制与符号形式）；
 * - 打开方式：对应 Netcatty FileOpenerDialog（内置编辑器 / 选择应用程序…，可「始终使用此方式打开 .ext 文件」）。 */

const BITS: { who: string; shift: number }[] = [
	{ who: "所有者", shift: 6 },
	{ who: "群组", shift: 3 },
	{ who: "其他", shift: 0 },
];
const PERMS: { label: string; bit: number; ch: string }[] = [
	{ label: "读", bit: 4, ch: "r" },
	{ label: "写", bit: 2, ch: "w" },
	{ label: "执行", bit: 1, ch: "x" },
];

export function symbolicMode(mode: number): string {
	return BITS.map(({ shift }) => PERMS.map(({ bit, ch }) => ((mode >> shift) & bit ? ch : "-")).join("")).join("");
}

export function SftpPermissionsModal({
	entry,
	onClose,
	onSave,
}: {
	entry: SftpFileEntry | null;
	onClose: () => void;
	onSave: (entry: SftpFileEntry, mode: number) => void;
}) {
	const [mode, setMode] = useState(0o644);
	const [octal, setOctal] = useState("644");
	useEffect(() => {
		if (!entry) return;
		const m = (entry.permissions || 0o644) & 0o777;
		setMode(m);
		setOctal(m.toString(8).padStart(3, "0"));
	}, [entry]);
	const apply = (m: number) => {
		setMode(m);
		setOctal(m.toString(8).padStart(3, "0"));
	};
	return (
		<Modal
			open={entry !== null}
			onClose={onClose}
			title="编辑权限"
			footer={
				<div className="flex items-center gap-2">
					<Button size="sm" onClick={onClose}>
						取消
					</Button>
					<Button size="sm" variant="primary" onClick={() => entry && onSave(entry, mode)}>
						保存
					</Button>
				</div>
			}
		>
			{entry && (
				<div className="space-y-3">
					<div className="truncate font-mono text-[12px] text-surface-foreground">{entry.name}</div>
					<div className="grid grid-cols-3 gap-2 rounded border border-border bg-surface p-2.5 text-[11px]">
						{BITS.map(({ who, shift }) => (
							<div key={who} className="space-y-1.5">
								<div className="font-medium text-surface-foreground">{who}</div>
								{PERMS.map(({ label, bit }) => {
									const mask = bit << shift;
									return (
										<label key={label} className="flex cursor-pointer items-center gap-1.5">
											<input
												type="checkbox"
												checked={Boolean(mode & mask)}
												onChange={(e) => apply(e.target.checked ? mode | mask : mode & ~mask)}
											/>
											<span>{label}</span>
										</label>
									);
								})}
							</div>
						))}
					</div>
					<div className="flex items-center gap-3 text-[11px] text-muted">
						<label className="flex items-center gap-1.5">
							<span>八进制</span>
							<input
								value={octal}
								onChange={(e) => {
									const v = e.target.value.replace(/[^0-7]/g, "").slice(0, 3);
									setOctal(v);
									if (v.length === 3) setMode(parseInt(v, 8));
								}}
								className="h-6 w-14 rounded border border-border bg-surface px-1.5 font-mono text-surface-foreground outline-none focus:border-primary"
							/>
						</label>
						<span>
							符号 <span className="font-mono text-surface-foreground">{symbolicMode(mode)}</span>
						</span>
					</div>
				</div>
			)}
		</Modal>
	);
}

export type FileOpenerChoice = { type: "builtin-editor" } | { type: "system-app"; app: { path: string; name: string } };

export function FileOpenerModal({
	fileName,
	onClose,
	onSelect,
	onPickApp,
}: {
	fileName: string | null;
	onClose: () => void;
	onSelect: (choice: FileOpenerChoice, remember: boolean) => void;
	onPickApp: () => Promise<{ path: string; name: string } | null>;
}) {
	const [remember, setRemember] = useState(false);
	const [picking, setPicking] = useState(false);
	useEffect(() => {
		if (fileName) setRemember(hasFileExtension(fileName));
	}, [fileName]);
	const ext = fileName ? getFileExtension(fileName) : "file";
	const displayExt = ext === "file" ? "无扩展名文件" : `.${ext}`;
	const canEdit = fileName ? !isKnownBinaryFile(fileName) : false;
	return (
		<Modal
			open={fileName !== null}
			onClose={() => !picking && onClose()}
			title="打开方式"
			footer={
				<Button size="sm" onClick={onClose} disabled={picking}>
					取消
				</Button>
			}
		>
			<div className="space-y-2">
				<div className="truncate text-[11px] text-muted">{fileName}</div>
				{canEdit && (
					<button
						type="button"
						onClick={() => onSelect({ type: "builtin-editor" }, remember)}
						className="flex h-12 w-full items-center gap-3 rounded border border-border bg-surface px-3 text-left hover:border-primary"
					>
						<span className="icon-[lucide--edit-2] size-4.5 text-primary" />
						<span>
							<span className="block text-[12px] font-medium text-surface-foreground">内置编辑器</span>
							<span className="block text-[10.5px] text-muted">编辑文本文件</span>
						</span>
					</button>
				)}
				<button
					type="button"
					disabled={picking}
					onClick={async () => {
						setPicking(true);
						try {
							const app = await onPickApp();
							if (app) onSelect({ type: "system-app", app }, remember);
						} finally {
							setPicking(false);
						}
					}}
					className="flex h-12 w-full items-center gap-3 rounded border border-border bg-surface px-3 text-left hover:border-primary disabled:opacity-50"
				>
					<span className="icon-[lucide--folder-open] size-4.5 text-primary" />
					<span>
						<span className="block text-[12px] font-medium text-surface-foreground">选择应用程序...</span>
						<span className="block text-[10.5px] text-muted">从本地选择一个应用程序</span>
					</span>
				</button>
				<label className="flex cursor-pointer items-center gap-2 pt-1 text-[11px] text-muted select-none">
					<input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
					<span>始终使用此方式打开 {displayExt} 文件</span>
				</label>
			</div>
		</Modal>
	);
}
