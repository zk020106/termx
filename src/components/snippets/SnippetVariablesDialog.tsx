import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { snippetVariableNames, useSnippetPromptStore } from "@/lib/snippetRun";
import { useEffect, useState } from "react";

/** 片段变量填写框（Netcatty SnippetExecutionProvider 的变量弹窗），全局挂一个 */
export function SnippetVariablesDialog() {
	const pending = useSnippetPromptStore((s) => s.pending);
	const [values, setValues] = useState<Record<string, string>>({});
	useEffect(() => setValues({}), [pending]);
	if (!pending) return null;
	const names = snippetVariableNames(pending.snippet.command);
	const done = (result: Record<string, string> | null) => {
		pending.resolve(result);
		useSnippetPromptStore.setState({ pending: null });
	};
	const complete = names.every((n) => (values[n] ?? "").trim());
	return (
		<Modal
			open
			onClose={() => done(null)}
			title={pending.snippet.name}
			icon="icon-[lucide--variable]"
			width={420}
			footer={
				<>
					<Button size="sm" onClick={() => done(null)}>
						取消
					</Button>
					<Button size="sm" variant="primary" icon="icon-[lucide--play]" disabled={!complete} onClick={() => done(values)}>
						执行
					</Button>
				</>
			}
		>
			<form
				className="space-y-2"
				onSubmit={(e) => {
					e.preventDefault();
					if (complete) done(values);
				}}
			>
				{names.map((name, i) => (
					<Field key={name} label={name} required>
						<Input
							autoFocus={i === 0}
							value={values[name] ?? ""}
							onChange={(e) => setValues((v) => ({ ...v, [name]: e.target.value }))}
							className="font-mono"
						/>
					</Field>
				))}
				<button type="submit" className="hidden" />
			</form>
		</Modal>
	);
}
