import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { sshAuthRespond } from "@/lib/ssh";
import { useAuthPromptStore } from "@/store/authPrompts";
import { useEffect, useState } from "react";

/* 全局认证提问弹窗：样式与连接页的键盘交互弹窗一致。
 * 一次只处理队首一个；作答后等服务器的下一轮（新事件替换这一轮）或连接结束（发起方 resolve）。 */
export function AuthPromptHost() {
	const current = useAuthPromptStore((s) => s.queue[0] ?? null);
	const resolve = useAuthPromptStore((s) => s.resolve);
	const [answers, setAnswers] = useState<string[]>([]);
	const [responding, setResponding] = useState(false);
	const [submitted, setSubmitted] = useState(false);
	const [error, setError] = useState<string | null>(null);

	// 换了一轮提问：清空上一轮的作答
	useEffect(() => {
		setAnswers([]);
		setSubmitted(false);
		setError(null);
	}, [current]);

	if (!current) return null;
	const { request } = current;

	const submit = async () => {
		if (responding || submitted) return;
		setResponding(true);
		setError(null);
		try {
			await sshAuthRespond(
				current.key,
				request.prompts.map((_, index) => answers[index] ?? ""),
			);
			setSubmitted(true);
		} catch (e) {
			setError(e instanceof Error ? e.message : String(e));
		} finally {
			setResponding(false);
		}
	};

	const cancel = () => {
		resolve(current.key);
		current.onCancel();
	};

	return (
		<Modal
			open
			onClose={cancel}
			title={request.name || "服务器要求交互式验证"}
			icon="icon-[lucide--shield-question]"
			width={440}
			footer={
				<>
					<Button size="sm" disabled={responding} onClick={cancel}>
						取消认证
					</Button>
					<Button
						size="sm"
						variant="primary"
						icon="icon-[lucide--arrow-right]"
						disabled={responding || submitted}
						onClick={() => void submit()}
					>
						{responding ? "正在提交…" : submitted ? "已提交，等待服务器…" : "继续"}
					</Button>
				</>
			}
		>
			<p className="text-[11px] text-muted">{current.origin}</p>
			{request.instructions ? (
				<p className="mt-1.5 whitespace-pre-wrap">{request.instructions}</p>
			) : (
				<p className="mt-1.5">服务器没有给额外说明，只给了下面这些提问。</p>
			)}
			<div className="mt-2.5 space-y-2">
				{request.prompts.map((item, index) => (
					<Field key={`${item.prompt}-${index}`} label={item.prompt || `第 ${index + 1} 项`} hint={item.echo ? undefined : "不回显"}>
						<Input
							type={item.echo ? "text" : "password"}
							value={answers[index] ?? ""}
							disabled={responding || submitted}
							autoComplete="off"
							autoFocus={index === 0}
							onChange={(e) =>
								setAnswers((prev) => request.prompts.map((_, i) => (i === index ? e.target.value : (prev[i] ?? ""))))
							}
							onKeyDown={(e) => {
								if (e.key === "Enter") void submit();
							}}
							className="font-mono"
						/>
					</Field>
				))}
			</div>
			<p className="mt-2.5 text-[10.5px] leading-4 text-faint">回答按提问顺序原样提交给服务器。</p>
			{error && (
				<div className="mt-2 rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-[10.5px] leading-4 text-danger">
					回答没能交给服务器：{error}
				</div>
			)}
		</Modal>
	);
}
