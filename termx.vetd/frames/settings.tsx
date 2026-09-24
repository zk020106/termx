export const frame = { width: 1440, height: 900, title: "设置" };

import { useState } from "react";
import { WindowChrome } from "../components/WindowChrome";

const nav = [
	{ name: "外观与主题", on: true, icon: "icon-[lucide--palette]" },
	{ name: "终端环境", on: false, icon: "icon-[lucide--terminal]" },
	{ name: "快捷键绑定", on: false, icon: "icon-[lucide--keyboard]" },
	{ name: "安全与主密码", on: false, icon: "icon-[lucide--shield-check]" },
	{ name: "数据备份与同步", on: false, icon: "icon-[lucide--cloud]" },
];

const accents = [
	{ id: "indigo", name: "Linear 经典靛蓝", class: "bg-primary ring-2 ring-primary ring-offset-2 ring-offset-surface", desc: "Linear 核心品牌色" },
	{ id: "cyan", name: "电光青", class: "bg-accent", desc: "高科技冷感，微弱点缀" },
	{ id: "emerald", name: "翡翠绿", class: "bg-success", desc: "柔和自然，护眼舒适" },
	{ id: "amber", name: "琥珀金", class: "bg-warning", desc: "复古温暖，经典工匠感" },
	{ id: "rose", name: "玫瑰粉", class: "bg-danger", desc: "活力鲜艳，鲜明辨识" },
	{ id: "steel", name: "金属银灰", class: "bg-muted", desc: "极简纯粹，沉浸无干扰" },
];

export default function Settings() {
	const [themeMode, setThemeMode] = useState<"dark" | "light" | "system">("dark");
	const [density, setDensity] = useState<"standard" | "compact">("standard");

	return (
		<WindowChrome activity="settings">
			<div className="flex min-h-0 flex-1 bg-surface">
				{/* 左侧设置导航 (200px) */}
				<aside className="w-[200px] shrink-0 border-r border-border bg-surface-sunk p-2.5">
					<div className="px-2 py-1 text-[10px] font-medium tracking-wider text-faint uppercase">系统设置</div>
					<div className="mt-1 space-y-0.5">
						{nav.map((n) => (
							<button
								key={n.name}
								type="button"
								className={`flex h-7.5 w-full items-center gap-2 rounded px-2.5 text-[12px] text-left transition-colors ${
									n.on
										? "bg-surface-raised font-medium text-surface-foreground border border-border shadow-sm"
										: "text-muted hover:bg-surface hover:text-surface-foreground"
								}`}
							>
								<span className={`${n.icon} size-3.5 text-muted`} />
								<span>{n.name}</span>
							</button>
						))}
					</div>

					<div className="mt-6 rounded border border-border bg-surface p-2.5 text-[11px] text-muted">
						<div className="font-medium text-surface-foreground flex items-center gap-1.5">
							<span className="icon-[lucide--info] size-3 text-primary" />
							双轨独立配色
						</div>
						<p className="mt-1 text-[10.5px] leading-relaxed text-faint">
							TermX 解耦了<b>外壳界面</b>与<b>终端仿真</b>，修改外壳主题不影响远程 Shell 的语法色彩输出。
						</p>
					</div>
				</aside>

				{/* 右侧设置主表单 */}
				<div className="flex min-w-0 flex-1 flex-col overflow-y-auto p-6">
					<div className="max-w-2xl space-y-6">
						{/* 模块 1: 界面显示主题 */}
						<div>
							<h2 className="text-[14px] font-semibold text-surface-foreground">外观与界面主题</h2>
							<p className="mt-0.5 text-[11.5px] text-muted">控制桌面窗口外壳、侧边栏及对话框的色彩风格</p>

							<div className="mt-3 grid grid-cols-3 gap-2.5">
								{[
									{ id: "dark", label: "深色模式 (Linear Dark)", desc: "极暗黑背景 · 纯净低噪" },
									{ id: "light", label: "浅色模式 (Linear Light)", desc: "高明度纸质灰 · 清晰通透" },
									{ id: "system", label: "跟随系统 (Auto)", desc: "自动同步操作系统外观偏好" },
								].map((t) => (
									<div
										key={t.id}
										onClick={() => setThemeMode(t.id as any)}
										className={`flex flex-col text-left rounded-md border p-3 transition-colors cursor-pointer ${
											themeMode === t.id
												? "border-primary bg-surface-raised shadow-sm"
												: "border-border bg-surface hover:border-white/20"
										}`}
									>
										<div className="flex items-center justify-between">
											<span className="text-[12px] font-medium text-surface-foreground">{t.label}</span>
											<span className={`size-3 rounded-full border ${themeMode === t.id ? "border-primary bg-primary" : "border-border"}`} />
										</div>
										<span className="mt-1 text-[11px] text-faint">{t.desc}</span>
									</div>
								))}
							</div>
						</div>

						{/* 模块 2: 品牌强调色 */}
						<div className="border-t border-border pt-4">
							<h3 className="text-[12.5px] font-semibold text-surface-foreground">系统强调色 (Accent Color)</h3>
							<p className="mt-0.5 text-[11.5px] text-muted">应用于焦点高亮、主按钮与活跃标签指示条</p>

							<div className="mt-3 grid grid-cols-6 gap-2">
								{accents.map((a, i) => (
									<button
										key={a.id}
										type="button"
										className="flex flex-col items-center gap-1.5 rounded border border-border bg-surface p-2 hover:bg-surface-raised transition-colors"
									>
										<span className={`size-5 rounded-full ${a.class}`} />
										<span className="text-[10.5px] text-muted font-medium truncate">{a.name}</span>
									</button>
								))}
							</div>
						</div>

						{/* 模块 3: 界面密度 */}
						<div className="border-t border-border pt-4">
							<div className="flex items-center justify-between">
								<div>
									<h3 className="text-[12.5px] font-semibold text-surface-foreground">界面显示密度</h3>
									<p className="mt-0.5 text-[11.5px] text-muted">调整侧边栏列表、主机网格与文件表格的行高</p>
								</div>
								<div className="flex h-7 items-center rounded border border-border bg-surface-sunk p-0.5 text-[11.5px]">
									<button
										type="button"
										onClick={() => setDensity("compact")}
										className={`rounded px-2.5 py-0.5 font-medium transition-colors ${
											density === "compact"
												? "bg-surface-raised text-surface-foreground shadow-sm border border-border"
												: "text-muted hover:text-surface-foreground"
										}`}
									>
										紧凑模式 · 26px
									</button>
									<button
										type="button"
										onClick={() => setDensity("standard")}
										className={`rounded px-2.5 py-0.5 font-medium transition-colors ${
											density === "standard"
												? "bg-surface-raised text-surface-foreground shadow-sm border border-border"
												: "text-muted hover:text-surface-foreground"
										}`}
									>
										标准模式 · 32px
									</button>
								</div>
							</div>
						</div>

						{/* 模块 4: 终端字体与实时预览 */}
						<div className="border-t border-border pt-4">
							<h3 className="text-[12.5px] font-semibold text-surface-foreground">终端仿真实时预览</h3>
							<p className="mt-0.5 text-[11.5px] text-muted">当前方案: One Dark · JetBrains Mono (13px · 行高 1.6)</p>

							<div className="mt-3 rounded border border-border bg-term p-3 font-mono text-[12px] leading-relaxed text-term-ink shadow-inner">
								<div className="flex items-center justify-between border-b border-border/40 pb-1.5 text-[10.5px] text-faint">
									<span>bash 5.2.15(1)-release</span>
									<span>24-bit TrueColor</span>
								</div>
								<div className="mt-2 space-y-1">
									<div>
										<span className="text-primary font-medium">deploy@order-api-01</span>
										<span className="text-muted">:</span>
										<span className="text-accent">~/app</span>
										<span className="text-muted">$ </span>
										<span>git status -s</span>
									</div>
									<div className="text-success"> M src/main/java/OrderService.java</div>
									<div className="text-warning">?? config/application-prod.yml</div>
									<div>
										<span className="text-primary font-medium">deploy@order-api-01</span>
										<span className="text-muted">:</span>
										<span className="text-accent">~/app</span>
										<span className="text-muted">$ </span>
										<span className="inline-block h-3.5 w-1.5 bg-primary animate-pulse" />
									</div>
								</div>
							</div>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
