import { ConflictBody } from "@/components/transfer/ConflictBody";
import { Modal } from "@/components/ui/Overlay";
import { resolveConflict, type ConflictChoice } from "@/lib/transferManager";
import { useTransfersStore } from "@/store/transfers";
import { useState } from "react";
import { useLocation } from "react-router";

/* 传输从 SFTP 页 / 侧栏 / 终端抽屉发起，冲突需要就地确认：
 * 全局弹出与传输队列详情卡片同一份「同名文件覆盖冲突」内容（传输队列页自己会显示，不再叠弹窗）。 */
export function TransferConflictHost() {
	const item = useTransfersStore((s) => s.items.find((t) => t.pendingConflict) ?? null);
	const onTransfersPage = useLocation().pathname.startsWith("/transfers");
	const [applyAll, setApplyAll] = useState(true);
	const [rule, setRule] = useState<"overwrite" | "skip" | "rename" | null>(null);
	if (!item || onTransfersPage) return null;

	const choose = (target: typeof item, choice: ConflictChoice) => {
		if (choice !== "resume") setRule(choice);
		resolveConflict(target.id, choice, applyAll);
	};

	return (
		<Modal
			open
			onClose={() => choose(item, "skip")}
			title={`${item.direction === "upload" ? "上传" : "下载"} ${item.name}`}
			icon="icon-[lucide--arrow-down-up]"
			width={560}
		>
			<div className="-m-3">
				<ConflictBody item={item} applyAll={applyAll} rule={rule} onApplyAll={setApplyAll} onRule={choose} />
			</div>
		</Modal>
	);
}
