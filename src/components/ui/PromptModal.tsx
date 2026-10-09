import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { useEffect, useState } from "react";

/** 单行输入弹窗：重命名 / 新建 / 移动到… 等右键操作共用 */
export function PromptModal({
	open,
	title,
	label,
	initialValue = "",
	placeholder,
	confirmText = "确定",
	validate,
	onClose,
	onSubmit,
}: {
	open: boolean;
	title: string;
	label?: string;
	initialValue?: string;
	placeholder?: string;
	confirmText?: string;
	/** 返回错误文案时禁止提交 */
	validate?: (value: string) => string | null;
	onClose: () => void;
	onSubmit: (value: string) => void;
}) {
	const [value, setValue] = useState(initialValue);
	useEffect(() => {
		if (open) setValue(initialValue);
	}, [open, initialValue]);
	const error = validate ? validate(value) : value.trim() ? null : "";
	const submit = () => {
		if (error !== null) return;
		onSubmit(value.trim());
	};
	return (
		<Modal
			open={open}
			onClose={onClose}
			title={title}
			footer={
				<div className="flex items-center gap-2">
					<Button size="sm" onClick={onClose}>
						取消
					</Button>
					<Button size="sm" variant="primary" disabled={error !== null} onClick={submit}>
						{confirmText}
					</Button>
				</div>
			}
		>
			<div className="space-y-1.5">
				{label && <div className="text-[11px] text-muted">{label}</div>}
				<Input
					autoFocus
					value={value}
					placeholder={placeholder}
					onChange={(event) => setValue(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter") {
							event.preventDefault();
							submit();
						}
					}}
					className="w-full font-mono"
				/>
				{error && <div className="text-[11px] text-danger">{error}</div>}
			</div>
		</Modal>
	);
}
