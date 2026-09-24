export const frame = { width: 1440, height: 900, title: "设置" };

import { useState } from "react";
import { WindowChrome } from "../components/WindowChrome";

const nav = [
	{ name: "外观", on: true, icon: "icon-[lucide--palette]" },
	{ name: "终端", on: false, icon: "icon-[lucide--terminal]" },
	{ name: "快捷键", on: false, icon: "icon-[lucide--keyboard]" },
	{ name: "安全与凭据", on: false, icon: "icon-[lucide--shield-check]" },
	{ name: "数据与同步", on: false, icon: "icon-[lucide--cloud]" },
];

const accents = [
	{ id: "cyan", name: "电光青 (默认)", bg: "bg-[oklch(74%_0.14_210)]", desc: "高科技感，与警示色零冲突" },
	{ id: "copper", name: "琥珀铜", bg: "bg-[oklch(73%_0.13_52)]", desc: "经典工匠感，微调后避开预发色" },
	{ id: "iris", name: "鸢尾紫", bg: "bg-[oklch(72%_0.15_295)]", desc: "现代优雅，夜间低疲劳" },
	{ id: "emerald", name: "翡翠绿", bg: "bg-[oklch(74%_0.14_165)]", desc: "清新通透，冷绿不刺眼" },
	{ id: "cobalt", name: "经典蓝", bg: "bg-[oklch(68%_0.16_250)]", desc: "沉稳内敛，专业严谨" },
	{ id: "rose", name: "珊瑚粉", bg: "bg-[oklch(73%_0.17_12)]", desc: "柔和明亮，个性鲜明" },
];

const termSchemes = [
	{ id: "one-dark", name: "One Dark", author: "Atom / VS Code 经典" },
	{ id: "tokyo-night", name: "Tokyo Night", author: "现代紫夜霓虹" },
	{ id: "catppuccin", name: "Catppuccin Mocha", author: "柔和护眼糖系" },
	{ id: "dracula", name: "Dracula", author: "高对比吸血鬼风格" },
	{ id: "nord", name: "Nord Arctic", author: "北极冰川冷调" },
];

export default function Settings() {
	const [themeMode, setThemeMode] = useState<"dark" | "light" | "system">("dark");
	const [accent, setAccent] = useState("cyan");
	const [termScheme, setTermScheme] = useState("one-dark");
	const [density, setDensity] = useState<"standard" | "compact">("standard");

	const appliedTheme = themeMode === "system" ? "dark" : themeMode;

	return (
		<div data-theme={appliedTheme} data-accent={accent} data-term-scheme={termScheme} className="h-full">
			<WindowChrome activity="settings">
				<div className="flex min-h-0 flex-1">
					{/* 左侧设置导航 */}
					<aside className="w-[210px] shrink-0 border-r border-border bg-surface-raised px-3 py-4">
						<div className="px-2 pb-2 text-[11px] font-medium tracking-wider text-faint uppercase">偏好设置</div>
						<div className="flex flex-col gap-1">
							{nav.map((n) => (
								<button
									key={n.name}
									type="button"
									className={`flex h-8 items-center gap-2 rounded-md px-2.5 text-[13px] text-left transition-colors ${
										n.on
											? "bg-accent-soft font-medium text-accent"
											: "text-surface-foreground hover:bg-surface"
									}`}
								>
									<span className={`${n.icon} size-4 text-faint`} />
									{n.name}
								</button>
							))}
						</div>

						<div className="mt-8 rounded-lg border border-border bg-surface p-3 text-[11px] text-muted">
							<div className="flex items-center gap-1.5 font-medium text-surface-foreground">
								<span className="icon-[lucide--info] size-3.5 text-accent" />
								双轨主题架构
							</div>
							<p className="mt-1.5 leading-relaxed text-faint">
								TermX 独立解耦了<b>界面外壳</b>与<b>终端仿真</b>配色，二者互不干扰，长时间使用更舒适。
							</p>
						</div>
					</aside>

					{/* 右侧设置主面板 */}
					<div className="min-w-0 flex-1 overflow-y-auto px-10 py-7">
						<header className="border-b border-border pb-4">
							<h1 className="font-display text-2xl font-semibold tracking-tight">外观与主题</h1>
							<p className="mt-1 text-[13px] text-muted">
								自定义 TermX 的视觉体验，支持深浅切换、强调色定制、界面密度以及终端配色解耦。
							</p>
						</header>

						{/* 1. 界面主题模式 */}
						<section className="mt-6">
							<div className="text-[13px] font-medium">界面外壳模式 (UI Chrome)</div>
							<p className="mt-0.5 text-[12px] text-faint">控制标题栏、侧边栏、Tab 栏与对话框底色。</p>
							<div className="mt-3 grid max-w-xl grid-cols-3 gap-3">
								{[
									{ id: "dark", label: "深色模式", sub: "黑曜石碳灰 · 沉浸专注", icon: "icon-[lucide--moon]" },
									{ id: "light", label: "浅色模式", sub: "暖石护眼 · 低眩光纸感", icon: "icon-[lucide--sun]" },
									{ id: "system", label: "跟随系统", sub: "自动与操作系统同步", icon: "icon-[lucide--laptop]" },
								].map((t) => {
									const active = themeMode === t.id;
									return (
										<button
											key={t.id}
											type="button"
											onClick={() => setThemeMode(t.id as any)}
											className={`flex flex-col rounded-lg border p-3 text-left transition-all ${
												active
													? "border-accent bg-accent-soft/40 shadow-sm"
													: "border-border bg-surface-raised hover:border-muted"
											}`}
										>
											<div className="flex items-center justify-between">
												<span className={`${t.icon} size-4 ${active ? "text-accent" : "text-muted"}`} />
												{active && <span className="icon-[lucide--check] size-3.5 text-accent" />}
											</div>
											<div className={`mt-2 text-[13px] font-medium ${active ? "text-accent" : "text-surface-foreground"}`}>
												{t.label}
											</div>
											<div className="mt-0.5 text-[11px] text-faint">{t.sub}</div>
										</button>
									);
								})}
							</div>
						</section>

						{/* 2. 强调色 (6 种经过冲突测试的颜色) */}
						<section className="mt-7">
							<div className="flex items-center gap-2">
								<span className="text-[13px] font-medium">界面强调色 (Accent Color)</span>
								<span className="rounded bg-surface-sunk px-2 py-0.5 font-mono text-[10px] text-faint">
									已进行生产红 (PROD) 与告警黄避障验证
								</span>
							</div>
							<div className="mt-3 grid max-w-2xl grid-cols-3 gap-2.5">
								{accents.map((c) => {
									const active = accent === c.id;
									return (
										<button
											key={c.id}
											type="button"
											onClick={() => setAccent(c.id)}
											className={`flex items-center gap-3 rounded-md border p-2 text-left transition-all ${
												active
													? "border-accent bg-accent-soft/30"
													: "border-border bg-surface hover:bg-surface-raised"
											}`}
										>
											<span className={`size-6 shrink-0 rounded-full ${c.bg} shadow-inner ring-1 ring-black/10`} />
											<div className="min-w-0 flex-1">
												<div className="flex items-center justify-between">
													<span className="truncate text-[12px] font-medium">{c.name}</span>
													{active && <span className="icon-[lucide--check] size-3 text-accent" />}
												</div>
												<div className="truncate text-[10px] text-faint">{c.desc}</div>
											</div>
										</button>
									);
								})}
							</div>
						</section>

						{/* 3. 终端仿真配色预设 (解耦) */}
						<section className="mt-7">
							<div className="flex items-baseline justify-between max-w-xl">
								<div>
									<div className="text-[13px] font-medium">终端配色方案 (Terminal Palette)</div>
									<p className="mt-0.5 text-[12px] text-faint">独立控制终端渲染画布背景与 16 色 ANSI 高亮。</p>
								</div>
								<span className="text-[11px] text-accent">支持自定义导入 JSON</span>
							</div>
							<div className="mt-3 flex flex-wrap gap-2 max-w-xl">
								{termSchemes.map((s) => {
									const active = termScheme === s.id;
									return (
										<button
											key={s.id}
											type="button"
											onClick={() => setTermScheme(s.id)}
											className={`flex items-center gap-2 rounded-md border px-3 py-1.5 text-[12px] transition-all ${
												active
													? "border-accent bg-accent text-primary-foreground font-medium shadow-sm"
													: "border-border bg-surface-raised text-muted hover:text-surface-foreground"
											}`}
										>
											<span>{s.name}</span>
											<span className={`text-[10px] ${active ? "text-primary-foreground/75" : "text-faint"}`}>
												· {s.author}
											</span>
										</button>
									);
								})}
							</div>
						</section>

						{/* 4. 界面密度 */}
						<section className="mt-7">
							<div className="text-[13px] font-medium">界面密度 (Density)</div>
							<div className="mt-2.5 flex gap-3 text-[12px]">
								<button
									type="button"
									onClick={() => setDensity("standard")}
									className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
										density === "standard"
											? "border-accent bg-accent-soft text-accent font-medium"
											: "border-border bg-surface-raised text-muted"
									}`}
								>
									<span className="icon-[lucide--rows-3] size-3.5" />
									标准档 · 32px 行高 (推荐日常运维)
								</button>
								<button
									type="button"
									onClick={() => setDensity("compact")}
									className={`flex items-center gap-2 rounded-md border px-3 py-1.5 ${
										density === "compact"
											? "border-accent bg-accent-soft text-accent font-medium"
											: "border-border bg-surface-raised text-muted"
									}`}
								>
									<span className="icon-[lucide--align-justify] size-3.5" />
									紧凑档 · 26px 行高 (高信息量多机管理)
								</button>
							</div>
						</section>

						{/* 5. 实时效果综合预览 */}
						<section className="mt-8 max-w-2xl">
							<div className="flex items-center justify-between pb-2">
								<div className="text-[13px] font-medium">即时效果预览 (Live Preview)</div>
								<div className="flex items-center gap-2 font-mono text-[11px] text-faint">
									<span>Scheme: {termScheme}</span>
									<span>·</span>
									<span>Accent: {accent}</span>
								</div>
							</div>

							<div className="overflow-hidden rounded-lg border border-border bg-term shadow-lg">
								{/* 终端模拟窗口标题 */}
								<div className="flex h-7 items-center justify-between border-b border-border/50 bg-surface-sunk px-3 text-[11px] text-muted">
									<div className="flex items-center gap-2">
										<span className="size-2 rounded-full bg-danger/80" />
										<span className="size-2 rounded-full bg-warning/80" />
										<span className="size-2 rounded-full bg-success/80" />
										<span className="ml-2 font-mono text-term-ink/90">deploy@order-api-01 (PROD)</span>
									</div>
									<span className="rounded bg-env-prod px-1.5 font-mono text-[9px] font-semibold text-white">PROD</span>
								</div>

								{/* 终端内容 */}
								<div className="p-4 font-mono text-[12px] leading-6 text-term-ink">
									<div>
										<span className="text-ansi-green">deploy@order-api-01</span>
										<span className="text-muted">:</span>
										<span className="text-ansi-cyan">~/app</span>
										<span>$ git status -s</span>
									</div>
									<div className="text-ansi-yellow"> M src/config/app.yml</div>
									<div className="text-ansi-green">?? src/services/pay.go</div>

									<div className="mt-1">
										<span className="text-ansi-green">deploy@order-api-01</span>
										<span className="text-muted">:</span>
										<span className="text-ansi-cyan">~/app</span>
										<span>$ tail -f app.log</span>
									</div>
									<div>
										<span className="text-muted">[10:14:02]</span> <span className="text-success font-semibold">INFO</span>{" "}
										<span>[Auth] Token verified uid=98213 duration=4ms</span>
									</div>
									<div>
										<span className="text-muted">[10:14:05]</span> <span className="text-warning font-semibold">WARN</span>{" "}
										<span>[Database] Slow query 1.2s orders.list</span>
									</div>
									<div>
										<span className="text-muted">[10:14:09]</span> <span className="text-danger font-semibold">ERROR</span>{" "}
										<span>[Redis] Connection timeout 10.0.8.40:6379</span>
									</div>

									{/* 光标演示 */}
									<div className="mt-1 flex items-center">
										<span className="text-ansi-green">deploy@order-api-01</span>
										<span className="text-muted">:</span>
										<span className="text-ansi-cyan">~/app</span>
										<span>$&nbsp;</span>
										<span className="inline-block h-3.5 w-2 translate-y-0.5 bg-accent animate-pulse" />
									</div>

									{/* 16 色 ANSI 色块条 */}
									<div className="mt-4 pt-3 border-t border-border/40">
										<div className="mb-1 text-[10px] text-faint">ANSI 16 色标准阶梯：</div>
										<div className="flex gap-1.5">
											<span className="size-4 rounded bg-ansi-black ring-1 ring-border/50" title="Black" />
											<span className="size-4 rounded bg-ansi-red" title="Red" />
											<span className="size-4 rounded bg-ansi-green" title="Green" />
											<span className="size-4 rounded bg-ansi-yellow" title="Yellow" />
											<span className="size-4 rounded bg-ansi-blue" title="Blue" />
											<span className="size-4 rounded bg-ansi-magenta" title="Magenta" />
											<span className="size-4 rounded bg-ansi-cyan" title="Cyan" />
											<span className="size-4 rounded bg-ansi-white" title="White" />
											<span className="mx-1 h-4 w-px bg-border/40" />
											<span className="size-4 rounded bg-ansi-bright-red" title="Bright Red" />
											<span className="size-4 rounded bg-ansi-bright-green" title="Bright Green" />
											<span className="size-4 rounded bg-ansi-bright-yellow" title="Bright Yellow" />
											<span className="size-4 rounded bg-ansi-bright-blue" title="Bright Blue" />
											<span className="size-4 rounded bg-ansi-bright-magenta" title="Bright Magenta" />
											<span className="size-4 rounded bg-ansi-bright-cyan" title="Bright Cyan" />
										</div>
									</div>
								</div>
							</div>
						</section>
					</div>
				</div>
			</WindowChrome>
		</div>
	);
}
