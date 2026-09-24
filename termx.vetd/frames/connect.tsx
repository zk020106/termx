export const frame = { width: 1440, height: 900, title: "连接过程" };

import { Link } from "react-router";
import { WindowChrome } from "../components/WindowChrome";

const steps = [
	{ name: "解析地址", detail: "10.0.3.21", state: "done" },
	{ name: "建立连接", detail: "经 bastion-sh", state: "done" },
	{ name: "握手", detail: "OpenSSH 9.6", state: "done" },
	{ name: "认证", detail: "等待二次验证码", state: "now" },
	{ name: "打开终端", detail: "尚未开始", state: "wait" },
];

export default function Connect() {
	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 flex-col">
				<div className="flex h-9 items-end bg-surface-sunk px-2">
					<div className="flex h-8 items-center gap-2 rounded-t-md bg-surface px-3 text-[12px]">
						<span className="size-1.5 animate-pulse rounded-full bg-accent" />
						order-api-01
					</div>
				</div>
				<div className="relative min-h-0 flex-1 bg-term">
					<div className="p-4 font-mono text-[12px] text-faint">正在连接 deploy@10.0.3.21 …</div>
					<div className="absolute inset-0 grid place-items-center bg-term/80">
						<div className="w-[420px] rounded-lg bg-surface-raised p-5 shadow-[0_16px_40px_oklch(8%_0.01_230_/_0.55)]">
							<div className="flex items-center justify-between">
								<h1 className="font-display text-base font-semibold">连接 order-api-01</h1>
								<span className="rounded bg-env-prod px-1.5 font-mono text-[10px] text-primary-foreground">PROD</span>
							</div>
							<ol className="mt-4 flex flex-col gap-2">
								{steps.map((s) => (
									<li key={s.name} className="flex items-center gap-3 text-[13px]">
										<Mark state={s.state} />
										<span className={s.state === "wait" ? "text-faint" : ""}>{s.name}</span>
										<span className="ml-auto font-mono text-[11px] text-muted">{s.detail}</span>
									</li>
								))}
							</ol>
							<div className="mt-4">
								<div className="mb-1 text-[12px] text-muted">验证码</div>
								<div className="flex h-9 items-center rounded-md bg-surface px-3 font-mono tracking-[0.4em]">482</div>
								<label className="mt-2 flex items-center gap-2 text-[12px] text-muted">
									<span className="size-3.5 rounded border border-border" />
									记住密码（默认不勾选）
								</label>
							</div>
							<div className="mt-4 flex justify-end gap-2 text-[13px]">
								<Link to="/hosts" className="px-3 py-1.5 text-muted">取消</Link>
								<Link to="/" className="rounded-md bg-accent px-3 py-1.5 font-medium text-primary-foreground">继续</Link>
							</div>
						</div>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}

function Mark({ state }: { state: string }) {
	if (state === "done") return <span className="icon-[lucide--check] size-3.5 text-success" />;
	if (state === "now") return <span className="size-2 rounded-full bg-accent" />;
	return <span className="size-2 rounded-full bg-border" />;
}
