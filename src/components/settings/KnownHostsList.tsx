/**
 * 已知主机列表 —— 对应 Netcatty components/KnownHostsManager.tsx。
 * 右键菜单与 Netcatty 一致：转换为主机（已有同地址主机时不可用，对应 Netcatty 的 converted）/ 移除。
 * 来源差异：Netcatty 管理自己 vault 里的列表；TermX 列出真正参与校验的文件，
 * OpenSSH 的 ~/.ssh/known_hosts 只读沿用，不在这里改用户文件。
 */
import { ContextMenu, MenuItem } from "@/components/ui/Menu";
import { Badge } from "@/components/ui/Display";
import { Input } from "@/components/ui/Input";
import type { Host } from "@/data/types";
import { convertibleHost, knownHostLabel, knownHostsList, knownHostsRemove, type KnownHostEntry } from "@/lib/knownHosts";
import { isTauri } from "@/lib/tauri";
import { useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router";

export function KnownHostsList() {
	const navigate = useNavigate();
	const hosts = useHostsStore((s) => s.hosts);
	const [entries, setEntries] = useState<KnownHostEntry[]>([]);
	const [loading, setLoading] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [query, setQuery] = useState("");
	const [menu, setMenu] = useState<{ x: number; y: number; entry: KnownHostEntry } | null>(null);

	const refresh = useCallback(async () => {
		setLoading(true);
		try {
			setEntries(await knownHostsList());
			setError(null);
		} catch (e) {
			setError(String(e));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void refresh();
	}, [refresh]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return entries;
		return entries.filter(
			(e) =>
				e.patterns.some((p) => p.toLowerCase().includes(q)) ||
				e.keyType.toLowerCase().includes(q) ||
				(e.fingerprint ?? "").toLowerCase().includes(q),
		);
	}, [entries, query]);

	const existingHost = (entry: KnownHostEntry) => {
		const target = convertibleHost(entry);
		if (!target) return null;
		return hosts.find((h) => h.hostname.toLowerCase() === target.hostname.toLowerCase() && h.port === target.port) ?? null;
	};

	// Netcatty useVaultState.convertKnownHostToHost：label=hostname、端口沿用、用户名留空待补
	const convertToHost = (entry: KnownHostEntry) => {
		const target = convertibleHost(entry);
		if (!target) return;
		const host: Host = {
			id: `host-${Date.now().toString(36)}`,
			name: target.hostname,
			groupId: null,
			hostname: target.hostname,
			port: target.port,
			username: "",
			tags: [],
			favorite: false,
			auth: { method: "password" },
			jumpHostIds: [],
			reachable: false,
		};
		useHostsStore.getState().upsertHost(host);
		toast({ title: "已转换为主机", description: `${target.hostname}:${target.port}，请补充用户名与认证方式`, tone: "success" });
		navigate(`/hosts/${host.id}/edit`);
	};

	const remove = async (entry: KnownHostEntry) => {
		try {
			const n = await knownHostsRemove(entry.line);
			toast({ title: n > 0 ? "已移除" : "记录已不存在", description: knownHostLabel(entry), tone: n > 0 ? "success" : "warning" });
		} catch (e) {
			toast({ title: "移除失败", description: String(e), tone: "danger" });
		}
		void refresh();
	};

	if (!isTauri()) {
		return <p className="px-3 py-2 text-[11.5px] text-muted">已知主机列表读取原生 known_hosts，仅桌面端可用。</p>;
	}

	return (
		<div className="space-y-2 px-3 py-2.5">
			<div className="flex items-center gap-2">
				<Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索主机 / 密钥类型 / 指纹" className="flex-1" />
				<button
					type="button"
					onClick={() => void refresh()}
					className="grid size-7 place-items-center rounded-md text-muted hover:bg-surface-raised hover:text-surface-foreground"
					aria-label="刷新"
					title="刷新"
				>
					<span className={`icon-[lucide--refresh-cw] size-3.5 ${loading ? "animate-spin" : ""}`} />
				</button>
			</div>
			{error && <p className="text-[11.5px] text-danger">{error}</p>}
			{!error && filtered.length === 0 && (
				<p className="py-3 text-center text-[11.5px] text-muted">{entries.length === 0 ? "还没有已知主机记录" : "没有匹配的记录"}</p>
			)}
			<div className="max-h-72 space-y-0.5 overflow-auto">
				{filtered.map((entry) => (
					<div
						key={`${entry.source}:${entry.lineNo}`}
						onContextMenu={(e) => {
							e.preventDefault();
							setMenu({ x: e.clientX, y: e.clientY, entry });
						}}
						className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-surface-raised"
					>
						<span className="icon-[lucide--server] size-3.5 shrink-0 text-muted" />
						<div className="min-w-0 flex-1">
							<div className="truncate font-mono text-[12px] text-surface-foreground">{knownHostLabel(entry)}</div>
							<div className="truncate font-mono text-[10.5px] text-muted">
								{entry.keyType}
								{entry.fingerprint ? ` · ${entry.fingerprint}` : ""}
							</div>
						</div>
						{entry.marker && <Badge className="text-warning">{entry.marker}</Badge>}
						{existingHost(entry) && <Badge>已转换</Badge>}
						<Badge>{entry.source === "termx" ? "TermX" : "OpenSSH"}</Badge>
					</div>
				))}
			</div>
			{menu && (
				<ContextMenu x={menu.x} y={menu.y} onClose={() => setMenu(null)} label="已知主机菜单">
					{!existingHost(menu.entry) && (
						<MenuItem
							icon="icon-[lucide--arrow-right]"
							label="转换为主机"
							disabled={!convertibleHost(menu.entry)}
							onClick={() => {
								const entry = menu.entry;
								setMenu(null);
								convertToHost(entry);
							}}
						/>
					)}
					<MenuItem
						icon="icon-[lucide--trash-2]"
						label={menu.entry.source === "termx" ? "移除" : "移除（OpenSSH 文件只读）"}
						danger
						disabled={menu.entry.source !== "termx"}
						onClick={() => {
							const entry = menu.entry;
							setMenu(null);
							void remove(entry);
						}}
					/>
				</ContextMenu>
			)}
		</div>
	);
}
