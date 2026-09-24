export const frame = { width: 1440, height: 900, title: "锁屏" };

import { Link } from "react-router";

export default function Lock() {
	return (
		<div className="flex h-full flex-col bg-surface-sunk text-surface-foreground">
			<header className="flex h-9 items-center px-3">
				<span className="icon-[lucide--terminal] size-3.5 text-accent" />
				<span className="ml-2 text-[13px] font-semibold">TermX</span>
				<span className="ml-3 text-[12px] text-faint">已锁定 · 闲置 15 分钟</span>
				<div className="ml-auto flex gap-3 text-muted">
					<span className="icon-[lucide--minus] size-3.5" />
					<span className="icon-[lucide--square] size-3" />
					<span className="icon-[lucide--x] size-3.5" />
				</div>
			</header>
			<div className="grid flex-1 place-items-center">
				<div className="w-[360px]">
					<div className="grid size-10 place-items-center rounded-md bg-surface-raised">
						<span className="icon-[lucide--lock] size-5 text-accent" />
					</div>
					<h1 className="mt-4 font-display text-2xl font-semibold">输入主密码</h1>
					<p className="mt-1 text-[13px] text-muted">会话还在，解锁后接着用。</p>
					<div className="mt-5 h-10 rounded-md bg-surface px-3 font-mono leading-10 tracking-[0.3em] text-surface-foreground">••••••</div>
					<p className="mt-2 text-[12px] text-danger">密码不对，还可再试 4 次。</p>
					<Link to="/" className="mt-4 flex h-10 items-center justify-center rounded-md bg-accent text-[14px] font-medium text-primary-foreground">
						解锁
					</Link>
				</div>
			</div>
		</div>
	);
}
