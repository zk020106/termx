import { Badge } from "@/components/ui/Display";
import { Button } from "@/components/ui/Button";
import { Field, Input, Select } from "@/components/ui/Input";
import { SettingRow, Switch } from "@/components/ui/Toggle";
import { useState } from "react";
import { toast } from "@/store/toast";

/* =============================================================================
 * AI 助手面板（预留入口）
 *
 * 按参考产品 OxideTerm 的 BYOK 模型：用户自带 provider 与 key，TermX 不内置 AI 服务、
 * 不代管额度；任何会改动远端状态的动作都必须用户批准。
 * 依据见 docs/DECISIONS.md 的 Q2。
 * ========================================================================== */

const PROVIDERS = [
	{ id: "openai", name: "OpenAI", models: ["gpt-4.1", "gpt-4.1-mini", "o4-mini"] },
	{ id: "anthropic", name: "Anthropic", models: ["claude-sonnet-4-5", "claude-opus-4-1", "claude-haiku-4-5"] },
	{ id: "gemini", name: "Google Gemini", models: ["gemini-2.5-pro", "gemini-2.5-flash"] },
	{ id: "ollama", name: "本地 Ollama", models: ["qwen3:8b", "llama3.3:70b", "deepseek-r1:14b"] },
	{ id: "compatible", name: "OpenAI 兼容端点", models: ["自定义模型名"] },
];

const CAPABILITIES: { icon: string; title: string; desc: string }[] = [
	{ icon: "icon-[lucide--scan-text]", title: "解释当前输出", desc: "把当前终端缓冲区交给模型，解释报错或说明命令结果" },
	{ icon: "icon-[lucide--wand-sparkles]", title: "生成命令", desc: "用自然语言描述意图，生成命令后填入输入行，不自动回车" },
	{ icon: "icon-[lucide--bug]", title: "分析报错", desc: "结合主机信息与最近输出，给出排查步骤" },
];

/** Ollama 走本地地址，不需要 API Key */
const LOCAL_PROVIDERS = new Set(["ollama"]);

export function AiAssistPanel({ hostName }: { hostName?: string }) {
	const [providerId, setProviderId] = useState("openai");
	const [model, setModel] = useState(PROVIDERS[0].models[0]);
	const [apiKey, setApiKey] = useState("");
	const [remember, setRemember] = useState(true);
	const [requireApproval, setRequireApproval] = useState(true);
	const [shareContext, setShareContext] = useState(false);

	const provider = PROVIDERS.find((p) => p.id === providerId) ?? PROVIDERS[0];
	const isLocal = LOCAL_PROVIDERS.has(providerId);
	const configured = isLocal || apiKey.trim().length > 0;

	const onProviderChange = (next: string) => {
		setProviderId(next);
		const target = PROVIDERS.find((p) => p.id === next);
		if (target) setModel(target.models[0]);
	};

	return (
		<div className="flex min-h-0 flex-1 flex-col">
			<div className="flex items-center gap-2 border-b border-border px-3 py-2">
				<Badge className="border-primary/40 text-primary">预留入口</Badge>
				<span className="text-[10.5px] text-faint">自带 provider，TermX 不代管额度</span>
			</div>

			<div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
				{/* provider 配置 */}
				<div className="space-y-2.5 rounded-card border border-border bg-surface-raised p-3">
					<Field label="服务提供方" hint={isLocal ? "本地推理，无需 Key" : "Key 存系统钥匙串"}>
						<Select value={providerId} onChange={(e) => onProviderChange(e.target.value)}>
							{PROVIDERS.map((p) => (
								<option key={p.id} value={p.id}>
									{p.name}
								</option>
							))}
						</Select>
					</Field>

					<Field label="模型">
						<Select value={model} onChange={(e) => setModel(e.target.value)}>
							{provider.models.map((m) => (
								<option key={m} value={m}>
									{m}
								</option>
							))}
						</Select>
					</Field>

					{!isLocal && (
						<Field label="API Key">
							<Input
								type="password"
								value={apiKey}
								onChange={(e) => setApiKey(e.target.value)}
								placeholder={providerId === "anthropic" ? "sk-ant-…" : "sk-…"}
								className="font-mono"
							/>
						</Field>
					)}

					{!isLocal && (
						<label className="flex cursor-pointer items-center justify-between text-[11px] text-muted">
							<span>记住 Key（写入系统钥匙串）</span>
							<Switch checked={remember} onChange={setRemember} label="记住 Key" />
						</label>
					)}

					<div className="flex items-center gap-2 pt-0.5">
						<Button
							size="sm"
							variant="primary"
							icon="icon-[lucide--plug-zap]"
							disabled={!configured}
							onClick={() =>
								toast({
									title: "已保存 AI 配置",
									description: `${provider.name} · ${model}${isLocal ? "" : " · Key 存入系统钥匙串"}`,
									tone: "success",
								})
							}
						>
							保存并测试连接
						</Button>
						{!configured && <span className="text-[10.5px] text-faint">填入 Key 后可测试</span>}
					</div>
				</div>

				{/* 能力 */}
				<div className="space-y-1.5">
					<div className="px-1 text-[10px] font-medium tracking-wider text-faint uppercase">能力</div>
					<div className="space-y-1">
						{CAPABILITIES.map((c) => (
							<div key={c.title} className="flex gap-2 rounded border border-border bg-surface-raised p-2">
								<span className={`${c.icon} mt-0.5 size-3.5 shrink-0 text-primary`} />
								<div className="min-w-0">
									<div className="text-[11.5px] text-surface-foreground">{c.title}</div>
									<div className="mt-0.5 text-[10.5px] leading-4 text-faint">{c.desc}</div>
								</div>
							</div>
						))}
					</div>
				</div>

				{/* 执行策略 */}
				<div className="space-y-0.5 rounded-card border border-border bg-surface-raised">
					<div className="px-3 pt-2.5 text-[10px] font-medium tracking-wider text-faint uppercase">
						执行策略
					</div>
					<SettingRow
						title="执行前必须确认"
						description="模型给出的命令先填入输入行，由你回车后才发送"
					>
						<Switch checked={requireApproval} onChange={setRequireApproval} label="执行前必须确认" />
					</SettingRow>
					<SettingRow
						title="把当前会话上下文发给 provider"
						description={shareContext ? "包含最近终端输出与主机信息" : "只发送你手动选中的文本"}
					>
						<Switch checked={shareContext} onChange={setShareContext} label="共享会话上下文" />
					</SettingRow>
					<SettingRow title="作用对象" description={hostName ? "当前焦点终端所属主机" : "当前焦点终端"}>
						<span className="font-mono text-[11px] text-surface-foreground">{hostName ?? "—"}</span>
					</SettingRow>
					<SettingRow
						title="凭据隔离"
						description="AI 通道与 SSH 通道完全隔离，你的 Key 与私钥不经过本面板"
					>
						<span className="icon-[lucide--shield-check] size-3.5 text-success" />
					</SettingRow>
				</div>

				<p className="flex items-start gap-1.5 px-1 text-[10.5px] leading-4 text-faint">
					<span className="icon-[lucide--shield-check] mt-0.5 size-3 shrink-0" />
					对话内容直接发往你配置的 provider，不经过 TermX 服务端。
				</p>
			</div>
		</div>
	);
}
