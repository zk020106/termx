import { WindowChrome } from "@/components/chrome/WindowChrome";
import { Button, IconButton } from "@/components/ui/Button";
import { Badge, EmptyState, EnvPill, Segmented } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Toggle";
import { localFiles, remoteFiles, terminalPanes } from "@/data/mock";
import type { FileEntry, TerminalLine } from "@/data/types";
import { cn } from "@/lib/cn";
import { formatBytes } from "@/lib/format";
import { toast } from "@/store/toast";
import { transferSummary, useTransfersStore } from "@/store/transfers";
import { Fragment, useState } from "react";
import { Link } from "react-router";

/* =============================================================================
 * SFTP —— 设计帧 termx.vetd/frames/sftp.tsx 的交互版。
 * 状态切换器覆盖需求书 06-SFTP 的六个状态 + 设计帧的双栏基准态（需求书 07-SFTP 拖拽）。
 * ========================================================================== */

type SftpState = "dual" | "panel" | "drop" | "perm" | "conflict" | "empty" | "denied";

const STATE_OPTIONS: { value: SftpState; label: string }[] = [
	{ value: "dual", label: "双栏" },
	{ value: "panel", label: "底部面板" },
	{ value: "drop", label: "拖拽上传" },
	{ value: "perm", label: "权限编辑" },
	{ value: "conflict", label: "同名冲突" },
	{ value: "empty", label: "空目录" },
	{ value: "denied", label: "无权限" },
];

const REMOTE_PREFIX = "/home/deploy/app";

/** 同名冲突的对比数据（界面内演示数据，types.ts 不改） */
const CONFLICT = {
	name: "config.yml",
	localSize: 2_108,
	remoteSize: 2_048,
	localMtime: "今天 09:40",
	remoteMtime: "昨天 18:41",
};

/** 权限编辑默认目标：选中行命中不了时兜底 */
const FALLBACK_FILE: FileEntry = {
	name: "config.yml",
	kind: "file",
	size: 2_048,
	mtime: "昨天 18:41",
	mode: "-rw-r--r--",
	owner: "deploy",
};

const lineTone: Record<TerminalLine["kind"], string> = {
	input: "text-term-ink",
	plain: "text-term-ink",
	info: "text-muted",
	warn: "text-warning",
	error: "text-danger",
	ok: "text-success",
};

export default function Sftp() {
	const [mode, setMode] = useState<SftpState>("dual");
	const [localPath, setLocalPath] = useState("C:\\work\\order-api");
	const [remotePath, setRemotePath] = useState(REMOTE_PREFIX);
	const [pickedLocal, setPickedLocal] = useState<string | null>(null);
	const [pickedRemote, setPickedRemote] = useState<string | null>("config.yml");
	const [followTerminal, setFollowTerminal] = useState(true);
	const [rule, setRule] = useState<"overwrite" | "skip" | "rename" | null>(null);
	const [applyAll, setApplyAll] = useState(true);

	const queue = useTransfersStore((s) => s.items);
	const { count: queueCount } = transferSummary(queue);

	const denied = mode === "denied";
	const remoteShownPath = denied ? "/root/.ssh" : remotePath;
	const remoteList: FileEntry[] = mode === "empty" || denied ? [] : remoteFiles;
	const permFile = remoteFiles.find((f) => f.name === pickedRemote) ?? FALLBACK_FILE;

	const goRemote = (next: string) => {
		setRemotePath(next);
		if (denied) setMode("dual");
	};

	const pickRule = (next: "overwrite" | "skip" | "rename") => {
		setRule(next);
		const label = { overwrite: "覆盖远端文件", skip: "跳过本次传输", rename: "重命名保留两份" }[next];
		toast({
			title: `已选择：${label}`,
			description: applyAll ? "本次传输队列中的后续同名文件均按此规则处理" : `仅对 ${CONFLICT.name} 生效`,
			tone: next === "skip" ? "warning" : "default",
		});
	};

	return (
		<WindowChrome>
			<div className="relative flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶栏控制栏 */}
				<div className="flex h-10 shrink-0 items-center justify-between gap-3 border-b border-border bg-surface-sunk px-3 text-[12px]">
					<div className="flex min-w-0 items-center gap-2">
						<span className="shrink-0 font-medium text-surface-foreground">SFTP 远程文件传输</span>
						<span className="text-border">/</span>
						<EnvPill env="prod" size="xs" />
						<span className="font-mono text-muted">order-api-01</span>
						<span className="truncate font-mono text-[11px] text-faint">deploy@10.0.3.21:22</span>
					</div>

					{/* 状态切换器（骨架期评审工具） */}
					<div className="flex shrink-0 items-center gap-2">
						<span className="font-mono text-[10.5px] text-faint">状态</span>
						<Segmented value={mode} onChange={setMode} options={STATE_OPTIONS} />
					</div>

					<div className="flex shrink-0 items-center gap-2">
						<Link
							to="/editor"
							className="flex h-6.5 items-center gap-1.5 rounded-control border border-border bg-surface px-2 text-[11px] font-medium text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
						>
							<span className="icon-[lucide--file-pen-line] size-3 text-primary" />
							<span>内置编辑器打开 config.yml</span>
						</Link>
						<Link
							to="/transfers"
							className="flex h-6.5 items-center gap-1.5 rounded-control bg-primary px-2.5 text-[11px] font-medium text-primary-foreground shadow-sm transition-opacity hover:opacity-90"
						>
							<span className="icon-[lucide--arrow-down-up] size-3" />
							<span className="tabular-nums">传输队列 ({queueCount})</span>
						</Link>
					</div>
				</div>

				{mode === "panel" ? (
					/* ---------------- 底部面板模式 ---------------- */
					<div className="flex min-h-0 flex-1 flex-col">
						<TerminalPreview className="min-h-0 flex-1" />

						<div className="flex h-[340px] shrink-0 flex-col border-t-2 border-primary/50">
							<div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3 text-[11.5px]">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--folder-tree] size-3.5 text-primary" />
									<span className="font-medium text-surface-foreground">SFTP 面板</span>
									<span className="font-mono text-[10.5px] text-faint">
										{followTerminal ? "已跟随终端目录" : "手动浏览"}
									</span>
									<Checkbox checked={followTerminal} onChange={setFollowTerminal} label="跟随终端 cd" />
								</div>
								<div className="flex items-center gap-1">
									<Button size="sm" variant="ghost" icon="icon-[lucide--maximize-2]" onClick={() => setMode("dual")}>
										展开为双栏
									</Button>
									<IconButton icon="icon-[lucide--chevron-down]" label="收起面板" onClick={() => setMode("dual")} />
								</div>
							</div>
							<FileColumn
								title="远程主机 (order-api-01)"
								icon="icon-[lucide--server]"
								path={remotePath}
								files={remoteFiles}
								side="remote"
								selected={pickedRemote}
								onSelect={setPickedRemote}
								onNavigate={goRemote}
								className="flex-1"
							/>
						</div>
					</div>
				) : (
					/* ---------------- 双栏模式（本地 ↔ 远程） ---------------- */
					<div className="grid min-h-0 flex-1 grid-cols-2">
						<FileColumn
							title="本地文件系统"
							icon="icon-[lucide--laptop]"
							path={localPath}
							files={localFiles}
							side="local"
							selected={pickedLocal}
							onSelect={setPickedLocal}
							onNavigate={setLocalPath}
						/>
						<FileColumn
							title="远程主机 (order-api-01)"
							icon="icon-[lucide--server]"
							path={remoteShownPath}
							files={remoteList}
							side="remote"
							dropActive={mode === "drop"}
							denied={denied}
							selected={pickedRemote}
							onSelect={setPickedRemote}
							onNavigate={goRemote}
						/>
					</div>
				)}

				{/* 浮层：权限编辑（勾选框 / 数字两种方式切换） */}
				{mode === "perm" && (
					<PermissionCard file={permFile} path={remoteShownPath} onClose={() => setMode("dual")} />
				)}

				{/* 浮层：同名文件冲突（覆盖 / 跳过 / 重命名 + 全部应用） */}
				{mode === "conflict" && (
					<ConflictCard
						rule={rule}
						applyAll={applyAll}
						onRule={pickRule}
						onApplyAll={setApplyAll}
						onClose={() => setMode("dual")}
					/>
				)}
			</div>
		</WindowChrome>
	);
}

/* ------------------------------- 文件栏 ------------------------------- */

function FileColumn({
	title,
	icon,
	path,
	files,
	side,
	dropActive,
	denied,
	selected,
	onSelect,
	onNavigate,
	className,
}: {
	title: string;
	icon: string;
	path: string;
	files: FileEntry[];
	side: "local" | "remote";
	dropActive?: boolean;
	denied?: boolean;
	selected: string | null;
	onSelect: (name: string | null) => void;
	onNavigate: (path: string) => void;
	className?: string;
}) {
	const totalBytes = files.reduce((sum, f) => sum + (f.kind === "dir" ? 0 : f.size), 0);

	return (
		<div
			className={cn(
				"relative flex min-h-0 flex-col",
				side === "remote" ? "border-l border-border bg-surface-raised/40" : "bg-surface",
				dropActive && "bg-primary/5 ring-1 ring-primary/50 ring-inset",
				className,
			)}
		>
			{/* 栏头部 */}
			<div className="flex h-9 shrink-0 items-center justify-between gap-2 border-b border-border bg-surface-sunk px-3 text-[11.5px]">
				<div className="flex min-w-0 items-center gap-1.5 text-muted">
					<span className={cn(icon, "size-3.5 shrink-0 text-primary")} />
					<span className="truncate font-medium text-surface-foreground">{title}</span>
					{dropActive && <Badge className="border-primary/50 text-primary">接收上传</Badge>}
				</div>
				<div className="flex shrink-0 items-center gap-2 font-mono text-[11px] text-faint">
					<span className="tabular-nums">{files.length} 项</span>
					{totalBytes > 0 && <span className="tabular-nums">{formatBytes(totalBytes)}</span>}
					<IconButton
						icon="icon-[lucide--refresh-cw]"
						label="刷新目录"
						className="size-5"
						onClick={() => toast({ title: "已刷新目录", description: path })}
					/>
				</div>
			</div>

			{/* 路径面包屑（可点击跳转 / 点击铅笔改为手输） */}
			<PathBar path={path} onNavigate={onNavigate} />

			{/* 表头 */}
			<div className="grid shrink-0 grid-cols-[1fr_80px_110px_70px] border-b border-border/60 bg-surface-sunk/40 px-3 py-1 text-[10.5px] tracking-wider text-faint uppercase">
				<span>名称</span>
				<span className="text-right">大小</span>
				<span className="text-right">修改时间</span>
				<span className="text-right">权限</span>
			</div>

			{/* 列表 / 空目录 / 无权限 */}
			<div className="relative min-h-0 flex-1 overflow-y-auto">
				{denied ? (
					<DeniedBlock path={path} />
				) : files.length === 0 ? (
					<EmptyDirBlock />
				) : (
					files.map((f) => (
						<button
							key={f.name}
							type="button"
							onClick={() => onSelect(f.name)}
							className={cn(
								"grid h-7.5 w-full grid-cols-[1fr_80px_110px_70px] items-center border-b border-border/20 px-3 text-left text-[12px] transition-colors",
								selected === f.name ? "bg-primary/10" : "hover:bg-surface-raised",
							)}
						>
							<span className="flex min-w-0 items-center gap-2">
								<span
									className={cn(
										f.kind === "dir"
											? "icon-[lucide--folder] text-primary"
											: f.kind === "link"
												? "icon-[lucide--link] text-accent"
												: "icon-[lucide--file-text] text-faint",
										"size-3.5 shrink-0",
									)}
								/>
								<span className="truncate font-mono text-[11.5px] text-surface-foreground">{f.name}</span>
								{f.owner && <span className="truncate font-mono text-[10px] text-faint">{f.owner}</span>}
							</span>
							<span className="text-right font-mono text-[11px] tabular-nums text-muted">
								{f.kind === "dir" ? "—" : formatBytes(f.size)}
							</span>
							<span className="text-right font-mono text-[10.5px] tabular-nums text-faint">{f.mtime}</span>
							<span className="text-right font-mono text-[10px] text-faint">{f.mode}</span>
						</button>
					))
				)}

				{dropActive && <DropHint />}
			</div>
		</div>
	);
}

/* --------------------------- 路径面包屑 --------------------------- */

function PathBar({ path, onNavigate }: { path: string; onNavigate: (path: string) => void }) {
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(path);

	const sep = path.includes("\\") ? "\\" : "/";
	const segments = path.split(sep).filter((s) => s.length > 0);

	const open = () => {
		setDraft(path);
		setEditing(true);
	};

	const commit = () => {
		const next = draft.trim();
		setEditing(false);
		if (next && next !== path) onNavigate(next);
	};

	return (
		<div className="flex h-8 shrink-0 items-center gap-2 border-b border-border bg-surface px-3 text-[11.5px]">
			<span className="shrink-0 font-mono text-[11px] text-faint">路径:</span>

			{editing ? (
				<Input
					autoFocus
					value={draft}
					onChange={(e) => setDraft(e.target.value)}
					onBlur={() => setEditing(false)}
					onKeyDown={(e) => {
						if (e.key === "Enter") commit();
						if (e.key === "Escape") setEditing(false);
					}}
					className="h-6 flex-1 font-mono text-[11px]"
				/>
			) : (
				<div className="flex min-w-0 flex-1 items-center overflow-hidden font-mono text-[11px]">
					{segments.map((seg, i) => {
						const prefix =
							sep === "/"
								? `/${segments.slice(0, i + 1).join("/")}`
								: `${segments.slice(0, i + 1).join(sep)}${i === 0 ? sep : ""}`;
						const last = i === segments.length - 1;
						return (
							<Fragment key={prefix}>
								{i > 0 && <span className="shrink-0 px-0.5 text-faint">{sep}</span>}
								<button
									type="button"
									title={`跳转到 ${prefix}`}
									onClick={() => !last && onNavigate(prefix)}
									className={cn(
										"shrink-0 rounded px-1 transition-colors hover:bg-surface-raised hover:text-surface-foreground",
										last ? "text-surface-foreground" : "text-muted",
									)}
								>
									{seg}
								</button>
							</Fragment>
						);
					})}
				</div>
			)}

			<button
				type="button"
				onClick={open}
				title="点击编辑路径"
				aria-label="点击编辑路径"
				className="flex size-5 shrink-0 items-center justify-center rounded text-muted transition-colors hover:bg-surface-raised hover:text-surface-foreground"
			>
				<span className="icon-[lucide--pencil-line] size-3" />
			</button>
			<span
				className="icon-[lucide--folder-plus] size-3 shrink-0 cursor-pointer text-muted hover:text-surface-foreground"
				title="新建目录"
			/>
		</div>
	);
}

/* --------------------------- 空目录 / 无权限 --------------------------- */

function EmptyDirBlock() {
	return (
		<EmptyState
			icon="icon-[lucide--folder-open]"
			title="该目录为空"
			description="把文件从系统文件管理器拖到这里即可上传，也可以先新建目录再传入。"
			action={
				<Button size="sm" icon="icon-[lucide--upload]">
					上传文件
				</Button>
			}
		/>
	);
}

function DeniedBlock({ path }: { path: string }) {
	return (
		<EmptyState
			icon="icon-[lucide--shield-x]"
			title="403 · 无权限访问该目录"
			description={`deploy 用户对 ${path} 没有读取权限，服务端返回 Permission denied（EACCES）。`}
			action={
				<div className="flex flex-col items-center gap-2">
					<div className="flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
						<span className="icon-[lucide--square-terminal] size-3" />
						<span>可执行 sudo -i 提权后重试，或改用有权限的账号连接</span>
					</div>
					<div className="flex items-center gap-2">
						<Button size="sm" variant="primary" icon="icon-[lucide--shield-check]">
							用 sudo 重试
						</Button>
						<Button size="sm" icon="icon-[lucide--arrow-left]">
							返回上级
						</Button>
					</div>
				</div>
			}
		/>
	);
}

/* --------------------------- 拖拽放置高亮 --------------------------- */

function DropHint() {
	return (
		<>
			<div className="pointer-events-none absolute inset-1.5 rounded-card border border-dashed border-primary/40" />
			<div className="pointer-events-none absolute inset-x-8 bottom-10 flex flex-col items-center gap-1.5 rounded-card border border-dashed border-primary/60 bg-primary/10 px-4 py-4 text-center">
				<span className="icon-[lucide--cloud-upload] size-5 text-primary" />
				<div className="text-[12.5px] font-medium text-surface-foreground">
					上传到 <span className="font-mono">{REMOTE_PREFIX}</span>
				</div>
				<div className="font-mono text-[10.5px] tabular-nums text-muted">
					3 个文件 · {formatBytes(12_400_000)} · 松开鼠标开始上传
				</div>
				<div className="font-mono text-[10.5px] text-faint">停留 600ms 可自动展开子目录</div>
			</div>
		</>
	);
}

/* --------------------------- 底部面板模式里的终端 --------------------------- */

function TerminalPreview({ className }: { className?: string }) {
	const pane = terminalPanes[0];

	return (
		<div className={cn("flex min-h-0 flex-col bg-term", className)}>
			<div className="flex h-8 shrink-0 items-center justify-between border-b border-border bg-surface-sunk px-3">
				<div className="flex min-w-0 items-center gap-2">
					<span className="icon-[lucide--terminal] size-3.5 shrink-0 text-primary" />
					<span className="truncate font-mono text-[11.5px] text-muted">{pane.title}</span>
					<span className="shrink-0 text-[10.5px] text-faint">{pane.subtitle}</span>
				</div>
				<span className="shrink-0 font-mono text-[10.5px] text-faint">Ctrl + Shift + S 收起面板</span>
			</div>
			<div className="min-h-0 flex-1 overflow-hidden p-3 font-mono text-[12px] leading-5">
				{pane.lines.map((line, i) => (
					<div key={i} className={cn("truncate", lineTone[line.kind])}>
						{line.text}
					</div>
				))}
				<div className="mt-1 flex items-center gap-1">
					<span className="text-success">deploy@order-api-01</span>
					<span className="text-muted">:~/app$</span>
					<span className="ml-1 inline-block h-3.5 w-1.5 animate-pulse bg-primary align-middle" />
				</div>
			</div>
		</div>
	);
}

/* --------------------------- 权限编辑浮层 --------------------------- */

const PERM_GROUPS = ["所有者", "用户组", "其他"];
const PERM_BITS_LABEL = ["读 r", "写 w", "执行 x"];
const PERM_VALUES = [4, 2, 1];
const PERM_PRESETS = ["600", "644", "755", "777"];

function modeToBits(mode: string): boolean[] {
	const body = mode.slice(1).padEnd(9, "-").slice(0, 9);
	return body.split("").map((c) => c !== "-");
}

function bitsToOctal(bits: boolean[]): string {
	let out = "";
	for (let g = 0; g < 3; g += 1) {
		let digit = 0;
		for (let i = 0; i < 3; i += 1) if (bits[g * 3 + i]) digit += PERM_VALUES[i];
		out += String(digit);
	}
	return out;
}

function octalToBits(text: string): boolean[] | null {
	const digits = text.replace(/[^0-7]/g, "");
	if (digits.length !== 3) return null;
	return digits
		.split("")
		.flatMap((d) => PERM_VALUES.map((value) => (Number(d) & value) !== 0));
}

function bitsToMode(bits: boolean[]): string {
	return bits.map((on, i) => (on ? "rwx"[i % 3] : "-")).join("");
}

function PermissionCard({ file, path, onClose }: { file: FileEntry; path: string; onClose: () => void }) {
	const [way, setWay] = useState<"bits" | "octal">("bits");
	const [bits, setBits] = useState<boolean[]>(() => modeToBits(file.mode));
	const [octalText, setOctalText] = useState(() => bitsToOctal(modeToBits(file.mode)));
	const [recursive, setRecursive] = useState(false);

	const octal = bitsToOctal(bits);

	const applyBits = (next: boolean[]) => {
		setBits(next);
		setOctalText(bitsToOctal(next));
	};

	const onOctalInput = (raw: string) => {
		const text = raw.replace(/[^0-7]/g, "").slice(0, 3);
		setOctalText(text);
		const parsed = octalToBits(text);
		if (parsed) setBits(parsed);
	};

	return (
		<div className="absolute right-4 bottom-4 z-30 w-[380px] rounded-card border border-border bg-surface-raised p-4 shadow-2xl">
			<div className="flex items-start justify-between gap-3">
				<div className="flex min-w-0 items-center gap-2.5">
					<span className="flex size-6 shrink-0 items-center justify-center rounded bg-primary/15 text-primary">
						<span className="icon-[lucide--shield-check] size-3.5" />
					</span>
					<div className="min-w-0">
						<h3 className="text-[12.5px] font-semibold text-surface-foreground">编辑文件权限</h3>
						<p className="truncate font-mono text-[10.5px] text-faint">
							{path}/{file.name} · deploy:deploy
						</p>
					</div>
				</div>
				<IconButton icon="icon-[lucide--x]" label="关闭" className="size-6" onClick={onClose} />
			</div>

			<div className="mt-3 flex items-center justify-between rounded-control border border-border bg-surface px-3 py-2">
				<span className="font-mono text-[12.5px] text-surface-foreground">{bitsToMode(bits)}</span>
				<span className="font-mono text-[12.5px] tabular-nums text-primary">{`0${octal}`}</span>
			</div>

			<div className="mt-3 flex items-center justify-between">
				<span className="text-[11px] text-muted">编辑方式</span>
				<Segmented
					value={way}
					onChange={setWay}
					options={[
						{ value: "bits", label: "勾选框" },
						{ value: "octal", label: "数字" },
					]}
				/>
			</div>

			{way === "bits" ? (
				<div className="mt-3 grid grid-cols-3 gap-2">
					{PERM_GROUPS.map((group, g) => (
						<div key={group} className="rounded-control border border-border bg-surface p-2">
							<div className="mb-1.5 text-[10px] tracking-wider text-faint uppercase">{group}</div>
							<div className="space-y-1.5">
								{PERM_BITS_LABEL.map((label, i) => (
									<Checkbox
										key={label}
										label={label}
										checked={bits[g * 3 + i]}
										onChange={(on) => applyBits(bits.map((b, idx) => (idx === g * 3 + i ? on : b)))}
									/>
								))}
							</div>
						</div>
					))}
				</div>
			) : (
				<div className="mt-3 space-y-2">
					<Input
						value={octalText}
						onChange={(e) => onOctalInput(e.target.value)}
						maxLength={3}
						placeholder="644"
						className="h-7 font-mono text-[13px] tabular-nums"
					/>
					<div className="flex items-center gap-1.5">
						{PERM_PRESETS.map((preset) => (
							<Button
								key={preset}
								size="sm"
								variant={octal === preset ? "primary" : "default"}
								className="flex-1 justify-center font-mono tabular-nums"
								onClick={() => {
									setOctalText(preset);
									const parsed = octalToBits(preset);
									if (parsed) setBits(parsed);
								}}
							>
								{preset}
							</Button>
						))}
					</div>
					<div className="flex items-center gap-1.5 font-mono text-[10.5px] text-faint">
						<span className="icon-[lucide--info] size-3" />
						三位八进制：所有者 / 用户组 / 其他
					</div>
				</div>
			)}

			<Checkbox
				className="mt-3"
				checked={recursive}
				onChange={setRecursive}
				label="递归应用到该目录下的所有子项"
			/>

			<div className="mt-3 flex items-center justify-end gap-2 border-t border-border pt-3">
				<Button size="sm" onClick={onClose}>
					取消
				</Button>
				<Button
					size="sm"
					variant="primary"
					icon="icon-[lucide--check]"
					onClick={() => {
						toast({
							title: `已应用权限 ${octal}`,
							description: `${file.name} → ${bitsToMode(bits)}${recursive ? " · 已递归到子项" : ""}`,
							tone: "success",
						});
						onClose();
					}}
				>
					应用权限
				</Button>
			</div>
		</div>
	);
}

/* --------------------------- 同名冲突浮层 --------------------------- */

function ConflictCard({
	rule,
	applyAll,
	onRule,
	onApplyAll,
	onClose,
}: {
	rule: "overwrite" | "skip" | "rename" | null;
	applyAll: boolean;
	onRule: (rule: "overwrite" | "skip" | "rename") => void;
	onApplyAll: (value: boolean) => void;
	onClose: () => void;
}) {
	const rows = [
		{ label: "文件名称", local: CONFLICT.name, remote: CONFLICT.name, tone: "" },
		{
			label: "文件大小",
			local: `${CONFLICT.localSize.toLocaleString("en-US")} 字节 (${formatBytes(CONFLICT.localSize)})`,
			remote: `${CONFLICT.remoteSize.toLocaleString("en-US")} 字节 (${formatBytes(CONFLICT.remoteSize)})`,
			tone: "",
		},
		{
			label: "修改时间",
			local: `${CONFLICT.localMtime} (较新)`,
			remote: CONFLICT.remoteMtime,
			tone: "newer",
		},
	];

	const ruleLabel =
		rule === "overwrite" ? "覆盖远端文件" : rule === "skip" ? "跳过本次传输" : rule === "rename" ? "重命名保留两份" : null;

	return (
		<div className="absolute right-4 bottom-4 z-30 w-[480px] rounded-card border border-warning/40 bg-surface-raised p-4 shadow-2xl">
			<div className="flex items-start gap-2.5">
				<span className="flex size-6 shrink-0 items-center justify-center rounded bg-warning/15 text-warning">
					<span className="icon-[lucide--triangle-alert] size-3.5" />
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex items-center justify-between gap-2">
						<h3 className="text-[12.5px] font-semibold text-surface-foreground">同名文件覆盖冲突</h3>
						<span className="font-mono text-[10px] tabular-nums text-faint">10:06:12</span>
					</div>
					<p className="mt-0.5 text-[11px] text-muted">
						目标路径 <span className="font-mono">{REMOTE_PREFIX}</span> 已有同名文件，请确认处理方式
					</p>
				</div>
				<IconButton icon="icon-[lucide--x]" label="关闭" className="size-6" onClick={onClose} />
			</div>

			<div className="mt-3 overflow-hidden rounded-control border border-border bg-surface">
				<div className="grid grid-cols-[92px_1fr_1fr] border-b border-border bg-surface-sunk/60 px-3 py-1.5 font-mono text-[10.5px] tracking-wider text-faint uppercase">
					<span>属性</span>
					<span>本地待上传文件</span>
					<span>远程已有文件</span>
				</div>
				<div className="divide-y divide-border/40 font-mono text-[11.5px]">
					{rows.map((row) => (
						<div key={row.label} className="grid grid-cols-[92px_1fr_1fr] items-center px-3 py-1.5">
							<span className="font-sans text-muted">{row.label}</span>
							<span className={cn("truncate tabular-nums", row.tone === "newer" ? "text-success" : "text-surface-foreground")}>
								{row.local}
							</span>
							<span className="truncate tabular-nums text-faint">{row.remote}</span>
						</div>
					))}
				</div>
			</div>

			<div className="mt-4 flex items-center gap-2">
				<Button
					size="sm"
					variant="primary"
					icon="icon-[lucide--check]"
					className="h-7.5 flex-1 justify-center"
					onClick={() => onRule("overwrite")}
				>
					覆盖远端文件
				</Button>
				<Button size="sm" className="h-7.5 flex-1 justify-center" onClick={() => onRule("skip")}>
					跳过本次传输
				</Button>
				<Button size="sm" className="h-7.5 flex-1 justify-center" onClick={() => onRule("rename")}>
					重命名保留两份
				</Button>
			</div>

			<div className="mt-3 flex items-center justify-between gap-3 border-t border-border pt-3">
				<Checkbox
					checked={applyAll}
					onChange={onApplyAll}
					label="对本次传输队列中的后续所有冲突文件均应用此规则"
				/>
				{ruleLabel && (
					<span className="flex shrink-0 items-center gap-1 font-mono text-[10.5px] text-success">
						<span className="icon-[lucide--check] size-3" />
						已选择：{ruleLabel}
					</span>
				)}
			</div>
		</div>
	);
}
