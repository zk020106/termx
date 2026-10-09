import { Button } from "@/components/ui/Button";
import { Segmented } from "@/components/ui/Display";
import { Input, Select, Textarea } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { SettingRow, Switch } from "@/components/ui/Toggle";
import {
	DEFAULT_KEYWORD_HIGHLIGHT_RULES,
	type KeywordHighlightRule,
} from "@/components/terminal/netcatty/keywordHighlightRules";
import { checkRegexSafetyPattern } from "@/components/terminal/netcatty/regexSafety";
import {
	DEFAULT_WORD_SEPARATORS,
	FONT_WEIGHTS,
	MIDDLE_CLICK_ACTIONS,
	TAB_DOUBLE_CLICK_ACTIONS,
	type MiddleClickAction,
	type TabDoubleClickAction,
} from "@/data/preferences";
import { useSettingsStore } from "@/store/settings";
import { useState } from "react";

/* =============================================================================
 * 终端行为 / 关键字高亮设置 —— 对应 Netcatty
 *   components/settings/tabs/TerminalBehaviorSettings.tsx
 *   components/settings/tabs/SettingsTerminalTab.tsx（字重 / 光标闪烁 / 对比度 / Option 作 Meta / 关键字高亮）
 * 文案取自 Netcatty zh-CN 语言包。
 * ========================================================================== */

const MIDDLE_CLICK_LABEL: Record<MiddleClickAction, string> = {
	"context-menu": "显示菜单",
	paste: "粘贴",
	disabled: "禁用",
};

const TAB_DOUBLE_CLICK_LABEL: Record<TabDoubleClickAction, string> = {
	rename: "重命名",
	duplicate: "复制会话",
	copy: "复制标签页",
	disabled: "无操作",
};

const CONTRAST_CHOICES = [1, 3, 4.5, 7, 21];

export function TerminalBehaviorSettings() {
	const s = useSettingsStore();
	const set = s.setTerminal;
	return (
		<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
			<SettingRow title="在全屏应用中也显示菜单" description="tmux / vim 等抓取鼠标时仍弹出右键菜单（Shift+右键始终弹出）">
				<Switch
					checked={s.showContextMenuOverFullscreenApps}
					onChange={(value) => set({ showContextMenuOverFullscreenApps: value })}
					label="在全屏应用中也显示菜单"
				/>
			</SettingRow>
			<SettingRow title="中键行为" description="在终端里按下鼠标中键时">
				<Segmented
					value={s.middleClick}
					onChange={(value) => set({ middleClick: value })}
					options={MIDDLE_CLICK_ACTIONS.map((value) => ({ value, label: MIDDLE_CLICK_LABEL[value] }))}
				/>
			</SettingRow>
			<SettingRow title="选择即复制" description="用鼠标选中终端文本后自动复制到剪贴板">
				<Switch checked={s.copyOnSelect} onChange={(value) => set({ copyOnSelect: value })} label="选择即复制" />
			</SettingRow>
			<SettingRow title="单词分隔符" description="双击选词时作为边界的字符">
				<div className="flex items-center gap-1.5">
					<Input
						value={s.wordSeparators}
						onChange={(event) => set({ wordSeparators: event.target.value })}
						className="w-40 font-mono"
					/>
					<Button size="sm" variant="ghost" onClick={() => set({ wordSeparators: DEFAULT_WORD_SEPARATORS })}>
						重置
					</Button>
				</div>
			</SettingRow>
			<SettingRow title="禁用括号粘贴模式" description="关闭后多行粘贴不再包裹 \e[200~ … \e[201~">
				<Switch checked={s.disableBracketedPaste} onChange={(value) => set({ disableBracketedPaste: value })} label="禁用括号粘贴模式" />
			</SettingRow>
			<SettingRow title="`clear` 同时清空回滚历史" description="关闭后远端的 \e[3J 只清屏、保留回滚">
				<Switch checked={s.clearWipesScrollback} onChange={(value) => set({ clearWipesScrollback: value })} label="clear 同时清空回滚历史" />
			</SettingRow>
			<SettingRow title="输入时自动滚动" description="键入时跳回到最底部">
				<Switch checked={s.scrollOnInput} onChange={(value) => set({ scrollOnInput: value })} label="输入时自动滚动" />
			</SettingRow>
			<SettingRow title="平滑滚动" description="滚动时使用动画">
				<Switch checked={s.smoothScrolling} onChange={(value) => set({ smoothScrolling: value })} label="平滑滚动" />
			</SettingRow>
			<SettingRow title="标签页双击行为" description="双击会话标签时执行的动作">
				<Segmented
					value={s.tabDoubleClick}
					onChange={(value) => set({ tabDoubleClick: value })}
					options={TAB_DOUBLE_CLICK_ACTIONS.map((value) => ({ value, label: TAB_DOUBLE_CLICK_LABEL[value] }))}
				/>
			</SettingRow>
			<SettingRow title="光标闪烁" description="">
				<Switch checked={s.cursorBlink} onChange={(value) => set({ cursorBlink: value })} label="光标闪烁" />
			</SettingRow>
			<SettingRow title="字重 / 粗体字重" description="">
				<div className="flex items-center gap-1.5">
					<Select value={s.fontWeight} onChange={(event) => set({ fontWeight: Number(event.target.value) })} className="w-20">
						{FONT_WEIGHTS.map((w) => (
							<option key={w} value={w}>
								{w}
							</option>
						))}
					</Select>
					<Select value={s.fontWeightBold} onChange={(event) => set({ fontWeightBold: Number(event.target.value) })} className="w-20">
						{FONT_WEIGHTS.map((w) => (
							<option key={w} value={w}>
								{w}
							</option>
						))}
					</Select>
				</div>
			</SettingRow>
			<SettingRow title="粗体使用亮色" description="粗体文字用对应的高亮色绘制">
				<Switch checked={s.drawBoldInBrightColors} onChange={(value) => set({ drawBoldInBrightColors: value })} label="粗体使用亮色" />
			</SettingRow>
			<SettingRow title="最小对比度" description="1 = 不调整；数值越大越强制提高文字与背景的对比">
				<Select
					value={s.minimumContrastRatio}
					onChange={(event) => set({ minimumContrastRatio: Number(event.target.value) })}
					className="w-24"
				>
					{CONTRAST_CHOICES.map((value) => (
						<option key={value} value={value}>
							{value}
						</option>
					))}
				</Select>
			</SettingRow>
			<SettingRow title="将 Option 作为 Meta 键" description="macOS 上 Option 发送 ESC 前缀（Alt 组合键）">
				<Switch checked={s.altAsMeta} onChange={(value) => set({ altAsMeta: value })} label="将 Option 作为 Meta 键" />
			</SettingRow>
		</div>
	);
}

/* ------------------------------ 关键字高亮 ------------------------------ */

export function validateHighlightPatterns(patterns: string[]): string | null {
	for (const pattern of patterns) {
		try {
			new RegExp(pattern, "gi");
		} catch {
			return `无效的正则表达式：${pattern}`;
		}
		if (!checkRegexSafetyPattern(pattern).safe) return `正则可能导致灾难性回溯：${pattern}`;
	}
	return null;
}

export function KeywordHighlightSettings() {
	const enabled = useSettingsStore((s) => s.keywordHighlightEnabled);
	const rules = useSettingsStore((s) => s.keywordHighlightRules);
	const set = useSettingsStore((s) => s.setTerminal);
	const [editing, setEditing] = useState<{ rule: KeywordHighlightRule; isNew: boolean } | null>(null);
	const builtInIds = new Set(DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((r) => r.id));

	const update = (id: string, patch: Partial<KeywordHighlightRule>) =>
		set({ keywordHighlightRules: rules.map((r) => (r.id === id ? { ...r, ...patch } : r)) });

	return (
		<div className="space-y-2">
			<div className="flex items-center justify-between">
				<h3 className="text-[12.5px] font-semibold text-surface-foreground">关键字高亮</h3>
				<div className="flex items-center gap-1.5">
					<Button
						size="sm"
						variant="ghost"
						onClick={() =>
							set({
								keywordHighlightRules: rules.map((r) => {
									const d = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((x) => x.id === r.id);
									return d ? { ...r, color: d.color } : r;
								}),
							})
						}
					>
						重置为默认颜色
					</Button>
					<Button
						size="sm"
						variant="ghost"
						onClick={() =>
							set({
								keywordHighlightRules: [
									...DEFAULT_KEYWORD_HIGHLIGHT_RULES.map((r) => ({ ...r, patterns: [...r.patterns] })),
									...rules.filter((r) => !builtInIds.has(r.id)),
								],
							})
						}
					>
						把内置规则恢复为默认
					</Button>
					<Button
						size="sm"
						onClick={() =>
							setEditing({
								isNew: true,
								rule: { id: `custom-${Date.now().toString(36)}`, label: "", patterns: [], color: "#F59E0B", enabled: true },
							})
						}
					>
						添加自定义规则
					</Button>
					<Switch checked={enabled} onChange={(value) => set({ keywordHighlightEnabled: value })} label="关键字高亮" />
				</div>
			</div>
			<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
				{rules.map((rule) => (
					<div key={rule.id} className="flex items-center gap-2 border-t border-border px-3 py-1.5 first:border-t-0">
						<input
							type="color"
							value={rule.color}
							onChange={(event) => update(rule.id, { color: event.target.value.toUpperCase() })}
							className="size-5 cursor-pointer rounded border border-border bg-transparent"
							aria-label={`${rule.label} 颜色`}
						/>
						<span className="w-28 truncate text-[11.5px] font-medium" style={{ color: rule.color }}>
							{rule.label}
						</span>
						<span className="flex-1 truncate font-mono text-[10.5px] text-faint">{rule.patterns.join("  ")}</span>
						<Button size="sm" variant="ghost" onClick={() => setEditing({ rule, isNew: false })}>
							编辑
						</Button>
						{!builtInIds.has(rule.id) && (
							<Button
								size="sm"
								variant="ghost"
								onClick={() => set({ keywordHighlightRules: rules.filter((r) => r.id !== rule.id) })}
							>
								删除
							</Button>
						)}
						<Switch checked={rule.enabled} onChange={(value) => update(rule.id, { enabled: value })} label={rule.label} />
					</div>
				))}
			</div>
			{editing && (
				<HighlightRuleModal
					rule={editing.rule}
					builtIn={builtInIds.has(editing.rule.id)}
					onClose={() => setEditing(null)}
					onSave={(next) => {
						const customized = builtInIds.has(next.id) ? { ...next, customized: true } : next;
						set({
							keywordHighlightRules: editing.isNew
								? [...rules, customized]
								: rules.map((r) => (r.id === next.id ? customized : r)),
						});
						setEditing(null);
					}}
				/>
			)}
		</div>
	);
}

function HighlightRuleModal({
	rule,
	builtIn,
	onClose,
	onSave,
}: {
	rule: KeywordHighlightRule;
	builtIn: boolean;
	onClose: () => void;
	onSave: (rule: KeywordHighlightRule) => void;
}) {
	const [label, setLabel] = useState(rule.label);
	const [color, setColor] = useState(rule.color);
	const [text, setText] = useState(rule.patterns.join("\n"));
	const patterns = text
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const error = !label.trim() ? "请填写标签" : patterns.length === 0 ? "至少一条正则" : validateHighlightPatterns(patterns);
	return (
		<Modal
			open
			onClose={onClose}
			title={builtIn ? "编辑内置规则" : "编辑规则"}
			footer={
				<div className="flex items-center gap-2">
					{builtIn && (
						<Button
							size="sm"
							variant="ghost"
							onClick={() => {
								const d = DEFAULT_KEYWORD_HIGHLIGHT_RULES.find((x) => x.id === rule.id);
								if (d) {
									setLabel(d.label);
									setText(d.patterns.join("\n"));
								}
							}}
						>
							恢复内置标签与正则
						</Button>
					)}
					<Button size="sm" onClick={onClose}>
						取消
					</Button>
					<Button
						size="sm"
						variant="primary"
						disabled={error !== null}
						onClick={() => onSave({ ...rule, label: label.trim(), color, patterns })}
					>
						保存
					</Button>
				</div>
			}
		>
			<div className="space-y-2">
				<div className="text-[11px] text-muted">标签与颜色</div>
				<div className="flex items-center gap-2">
					<input type="color" value={color} onChange={(e) => setColor(e.target.value.toUpperCase())} className="size-7 rounded border border-border" />
					<Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="标签（如 Down）" className="flex-1" />
				</div>
				<div className="text-[11px] text-muted">正则表达式</div>
				<Textarea value={text} onChange={(e) => setText(e.target.value)} rows={6} className="w-full" placeholder="每行一个正则（如 \bdown\b）" />
				<div className="text-[10.5px] text-faint">每行一个正则。匹配忽略大小写。</div>
				{error && <div className="text-[11px] text-danger">{error}</div>}
			</div>
		</Modal>
	);
}
