import { WindowChrome } from "@/components/chrome/WindowChrome";
import { HostEditModal } from "@/components/host/HostEditModal";
import { useHostsStore } from "@/store/hosts";
import { useSessionsStore } from "@/store/sessions";
import { useNavigate, useParams } from "react-router";

/**
 * 主机编辑独立路由界面 (/hosts/new, /hosts/:hostId/edit)
 * 复用规范化 HostEditModal，保持全站一致的交互与表单体验。
 */
export default function HostEdit() {
	const navigate = useNavigate();
	const { hostId } = useParams();
	const hosts = useHostsStore((s) => s.hosts);

	const handleClose = () => {
		useSessionsStore.getState().setActiveTab("vaults");
		navigate("/workspace");
	};

	const handleSaved = (savedHost: { id: string }, andConnect?: boolean) => {
		if (andConnect) {
			const newTabId = useSessionsStore.getState().openSession(savedHost.id);
			useSessionsStore.getState().setActiveTab(newTabId);
		} else {
			useSessionsStore.getState().setActiveTab("vaults");
		}
		navigate("/workspace");
	};

	return (
		<WindowChrome>
			<div className="relative min-h-0 flex-1 bg-surface-sunk/30 flex flex-col">
				{/* 背景展示：真实主机概览（带磨砂遮罩） */}
				<div className="flex h-10 items-center justify-between border-b border-border bg-surface-sunk px-4">
					<div className="flex items-center gap-2 text-[12px] text-muted">
						<span className="icon-[lucide--server] size-4 text-primary" />
						<span>主机库配置中心</span>
					</div>
					<span className="font-mono text-[11px] text-faint">{hosts.length} 台节点</span>
				</div>

				<div className="flex-1 p-6 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3 opacity-30 pointer-events-none">
					{hosts.slice(0, 8).map((h) => (
						<div key={h.id} className="rounded-2xl border border-border bg-surface p-4 text-[12px] space-y-1">
							<div className="font-semibold text-surface-foreground truncate">{h.name}</div>
							<div className="font-mono text-muted text-[11px] truncate">{h.username}@{h.hostname}:{h.port}</div>
						</div>
					))}
				</div>

				{/* 规范的居中双栏配置弹窗 */}
				<HostEditModal
					open
					hostId={hostId || "new"}
					onClose={handleClose}
					onSaved={handleSaved}
				/>
			</div>
		</WindowChrome>
	);
}
