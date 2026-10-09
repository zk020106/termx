import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/Overlay";
import { PromptModal } from "@/components/ui/PromptModal";
import { Checkbox } from "@/components/ui/Toggle";
import type { HostGroup } from "@/data/types";
import { proxySecretAccount } from "@/lib/configSecrets";
import { secretDelete } from "@/lib/secret";
import { groupPathLabel, groupWithDescendants, useHostsStore } from "@/store/hosts";
import { toast } from "@/store/toast";
import { useCallback, useMemo, useState } from "react";

/* 分组右键菜单背后的三个弹窗（新建 / 新建子分组、重命名、删除），侧栏主机树和主机工作台共用。
 * 对应 Netcatty VaultView 的 New Folder / Rename Group / Delete Group 对话框：
 * 删除时默认把组内主机移到根级别，可勾选「同时删除该分组下的所有主机」。 */

type DialogState =
	| { kind: "create"; parentId: string | null }
	| { kind: "rename"; group: HostGroup }
	| { kind: "delete"; group: HostGroup }
	| null;

export function useHostGroupDialogs(options?: { onCreated?: (group: HostGroup) => void; onDeleted?: (ids: Set<string>) => void }) {
	const [state, setState] = useState<DialogState>(null);
	const [deleteHosts, setDeleteHosts] = useState(false);
	const groups = useHostsStore((s) => s.groups);
	const hosts = useHostsStore((s) => s.hosts);

	const openCreate = useCallback((parentId: string | null = null) => setState({ kind: "create", parentId }), []);
	const openRename = useCallback((group: HostGroup) => setState({ kind: "rename", group }), []);
	const openDelete = useCallback((group: HostGroup) => {
		setDeleteHosts(false);
		setState({ kind: "delete", group });
	}, []);
	const close = () => setState(null);

	const deleteInfo = useMemo(() => {
		if (state?.kind !== "delete") return null;
		const ids = groupWithDescendants(groups, state.group.id);
		return { ids, subgroups: ids.size - 1, hostCount: hosts.filter((h) => h.groupId && ids.has(h.groupId)).length };
	}, [state, groups, hosts]);

	const dialogs = (
		<>
			<PromptModal
				open={state?.kind === "create"}
				title={state?.kind === "create" && state.parentId ? "新建子分组" : "新建分组"}
				label={
					state?.kind === "create" && state.parentId
						? `在「${groupPathLabel(groups, state.parentId)}」下新建子分组：`
						: "请输入新分组名称（如：生产集群、测试服务器、海外节点）："
				}
				placeholder="分组名称..."
				confirmText="创建"
				onClose={close}
				onSubmit={(name) => {
					if (state?.kind !== "create") return;
					const group = useHostsStore.getState().addGroup(name, state.parentId);
					toast({ title: `已创建分组「${groupPathLabel(useHostsStore.getState().groups, group.id)}」`, tone: "success" });
					close();
					options?.onCreated?.(group);
				}}
			/>
			<PromptModal
				open={state?.kind === "rename"}
				title="重命名分组"
				label={state?.kind === "rename" ? `修改「${state.group.name}」的名称：` : undefined}
				initialValue={state?.kind === "rename" ? state.group.name : ""}
				placeholder="新分组名称..."
				confirmText="保存"
				onClose={close}
				onSubmit={(name) => {
					if (state?.kind !== "rename") return;
					useHostsStore.getState().renameGroup(state.group.id, name);
					toast({ title: `分组已重命名为「${name}」`, tone: "success" });
					close();
				}}
			/>
			<Modal
				open={state?.kind === "delete"}
				onClose={close}
				title="删除分组"
				footer={
					<div className="flex items-center gap-2">
						<Button size="sm" onClick={close}>
							取消
						</Button>
						<Button
							size="sm"
							variant="danger"
							onClick={() => {
								if (state?.kind !== "delete" || !deleteInfo) return;
								const removed = useHostsStore.getState().removeGroup(state.group.id, { deleteHosts });
								for (const id of removed) {
									void secretDelete(id).catch(() => undefined);
									void secretDelete(proxySecretAccount(id)).catch(() => undefined);
								}
								toast({
									title: `已删除分组「${state.group.name}」`,
									description: removed.length ? `同时删除了 ${removed.length} 台主机` : undefined,
								});
								options?.onDeleted?.(deleteInfo.ids);
								close();
							}}
						>
							确认删除
						</Button>
					</div>
				}
			>
				{state?.kind === "delete" && deleteInfo && (
					<div className="space-y-3">
						<div className="text-surface-foreground">
							确认删除分组「<span className="font-semibold text-danger">{groupPathLabel(groups, state.group.id)}</span>」吗？
						</div>
						<div className="text-[11px] text-faint">
							这将永久删除该分组{deleteInfo.subgroups ? `及其 ${deleteInfo.subgroups} 个子分组` : ""}，并将所有主机（{deleteInfo.hostCount} 台）移动到「未分组」。
						</div>
						<Checkbox
							checked={deleteHosts}
							onChange={setDeleteHosts}
							disabled={deleteInfo.hostCount === 0}
							label="同时删除该分组下的所有主机"
						/>
					</div>
				)}
			</Modal>
		</>
	);

	return { openCreate, openRename, openDelete, dialogs };
}
