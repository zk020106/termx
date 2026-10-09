import { Button, Kbd } from "@/components/ui/Button";
import { Select } from "@/components/ui/Input";
import { SettingRow, Switch } from "@/components/ui/Toggle";
import {
	KEY_BINDING_CATEGORY_LABELS_ZH,
	KEY_BINDING_LABELS_ZH,
	keyEventToString,
	resolveKeyBindings,
	type HotkeyScheme,
	type KeyBinding,
} from "@/lib/keyBindings";
import { cn } from "@/lib/cn";
import { useSettingsStore } from "@/store/settings";
import { useEffect, useMemo, useState } from "react";

/* =============================================================================
 * 快捷键设置 —— 移植自 Netcatty components/settings/tabs/SettingsShortcutsTab.tsx：
 * 方案（禁用 / Mac / PC）、禁用终端缩放、按分类列出键位，点击录制、设为禁用、单项 / 全部重置。
 * [1...9] / arrows 这类范围键位只录制修饰键前缀（同 Netcatty）。
 * ========================================================================== */

const CATEGORIES: KeyBinding["category"][] = ["tabs", "terminal", "navigation", "app", "sftp"];

/** termx 自己保留的固定快捷键（不在 Netcatty 键位表里，不可改绑） */
const TERMX_FIXED: { name: string; keys: string }[] = [
	{ name: "工作区搜索栏（与 Ctrl+F 并存）", keys: "Ctrl Shift F" },
	{ name: "广播输入（与 Ctrl+B 并存）", keys: "Ctrl Shift I" },
	{ name: "最大化 / 还原分屏（与 Alt+M 并存）", keys: "Ctrl Shift M" },
	{ name: "立即锁定", keys: "Ctrl Shift L" },
];

export function ShortcutsSettings() {
	const scheme = useSettingsStore((s) => s.hotkeyScheme);
	const custom = useSettingsStore((s) => s.customKeyBindings);
	const disableZoom = useSettingsStore((s) => s.disableTerminalFontZoom);
	const set = useSettingsStore((s) => s.setTerminal);
	const bindings = useMemo(() => resolveKeyBindings(custom), [custom]);
	const [recording, setRecording] = useState<string | null>(null);
	const recordScheme: "mac" | "pc" = scheme === "mac" ? "mac" : "pc";

	const updateBinding = (id: string, value: string) => {
		const next = { ...custom, [id]: { ...custom[id], [recordScheme]: value } };
		set({ customKeyBindings: next });
	};
	const resetBinding = (id: string) => {
		const next = { ...custom };
		delete next[id];
		set({ customKeyBindings: next });
	};

	useEffect(() => {
		if (!recording) return;
		const binding = bindings.find((b) => b.id === recording);
		const current = binding ? binding[recordScheme] : "";
		const suffix = current.includes("[1...9]") ? "[1...9]" : current.includes("arrows") ? "arrows" : null;
		const onKeyDown = (e: KeyboardEvent) => {
			e.preventDefault();
			e.stopPropagation();
			if (e.key === "Escape") {
				setRecording(null);
				return;
			}
			if (suffix) {
				// 范围键位：只要修饰键（Netcatty getSpecialSuffix 分支）
				const mods: string[] = [];
				if (recordScheme === "mac") {
					if (e.metaKey) mods.push("⌘");
					if (e.ctrlKey) mods.push("⌃");
					if (e.altKey) mods.push("⌥");
					if (e.shiftKey) mods.push("Shift");
				} else {
					if (e.ctrlKey) mods.push("Ctrl");
					if (e.altKey) mods.push("Alt");
					if (e.shiftKey) mods.push("Shift");
					if (e.metaKey) mods.push("Win");
				}
				if (mods.length === 0) return;
				updateBinding(recording, [...mods, suffix].join(" + "));
				setRecording(null);
				return;
			}
			if (["Meta", "Control", "Alt", "Shift"].includes(e.key)) return;
			updateBinding(recording, keyEventToString(e, recordScheme === "mac"));
			setRecording(null);
		};
		const onClick = () => setRecording(null);
		const timer = setTimeout(() => window.addEventListener("click", onClick, true), 100);
		window.addEventListener("keydown", onKeyDown, true);
		return () => {
			clearTimeout(timer);
			window.removeEventListener("keydown", onKeyDown, true);
			window.removeEventListener("click", onClick, true);
		};
	});

	return (
		<div className="max-w-3xl space-y-4">
			<div>
				<h2 className="text-[14px] font-semibold text-surface-foreground">快捷键绑定</h2>
				<p className="mt-0.5 text-[11.5px] text-muted">键位与 Netcatty 一致；点击键位录制新组合，Esc 取消。</p>
			</div>
			<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
				<SettingRow title="键盘快捷键" description="选择快捷键使用的键盘布局">
					<Select value={scheme} onChange={(e) => set({ hotkeyScheme: e.target.value as HotkeyScheme })} className="w-32">
						<option value="disabled">禁用</option>
						<option value="mac">Mac (Cmd)</option>
						<option value="pc">PC (Ctrl)</option>
					</Select>
				</SettingRow>
				<SettingRow title="禁用终端缩放" description="关闭终端文字缩放快捷操作，包括 Cmd/Ctrl 加滚轮。">
					<Switch checked={disableZoom} onChange={(value) => set({ disableTerminalFontZoom: value })} label="禁用终端缩放" />
				</SettingRow>
			</div>

			{scheme !== "disabled" && (
				<>
					<div className="flex items-center justify-between">
						<h3 className="text-[12.5px] font-semibold text-surface-foreground">自定义快捷键</h3>
						<Button size="sm" variant="ghost" onClick={() => set({ customKeyBindings: {} })}>
							<span className="icon-[lucide--rotate-ccw] size-3" /> 全部重置
						</Button>
					</div>
					{CATEGORIES.map((category) => (
						<div key={category}>
							<h4 className="mb-1.5 text-[10.5px] font-medium tracking-wide text-faint uppercase">
								{KEY_BINDING_CATEGORY_LABELS_ZH[category]}
							</h4>
							<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
								{bindings
									.filter((b) => b.category === category)
									.map((binding) => {
										const key = binding[recordScheme];
										const isRecording = recording === binding.id;
										const isCustom = Boolean(custom[binding.id]?.[recordScheme] !== undefined);
										return (
											<div key={binding.id} className="flex items-center justify-between border-t border-border px-3 py-1.5 first:border-t-0">
												<span className="text-[11.5px] text-surface-foreground">{KEY_BINDING_LABELS_ZH[binding.id] ?? binding.label}</span>
												<div className="flex items-center gap-1.5">
													<button
														type="button"
														onClick={(e) => {
															e.stopPropagation();
															setRecording(binding.id);
														}}
														className={cn(
															"min-w-[72px] rounded border px-2 py-0.5 text-center font-mono text-[10.5px] transition-colors cursor-pointer",
															isRecording ? "animate-pulse border-primary bg-primary/10" : "border-border hover:border-primary/50",
														)}
													>
														{isRecording ? "请按键..." : key === "Disabled" ? "无" : key}
													</button>
													<button
														type="button"
														title="设为禁用"
														aria-label="设为禁用"
														onClick={() => updateBinding(binding.id, "Disabled")}
														className="text-muted hover:text-danger cursor-pointer"
													>
														<span className="icon-[lucide--ban] size-3.5" />
													</button>
													<button
														type="button"
														title="重置为默认"
														aria-label="重置为默认"
														disabled={!isCustom}
														onClick={() => resetBinding(binding.id)}
														className="text-muted hover:text-primary disabled:opacity-30 cursor-pointer"
													>
														<span className="icon-[lucide--rotate-ccw] size-3.5" />
													</button>
												</div>
											</div>
										);
									})}
							</div>
						</div>
					))}
				</>
			)}

			<div>
				<h4 className="mb-1.5 text-[10.5px] font-medium tracking-wide text-faint uppercase">termx 固定快捷键</h4>
				<div className="overflow-hidden rounded-lg border border-border bg-surface-raised">
					{TERMX_FIXED.map((row) => (
						<div key={row.name} className="flex items-center justify-between border-t border-border px-3 py-1.5 first:border-t-0">
							<span className="text-[11.5px] text-surface-foreground">{row.name}</span>
							<Kbd>{row.keys}</Kbd>
						</div>
					))}
				</div>
			</div>
		</div>
	);
}
