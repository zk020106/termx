export const frame = { width: 1440, height: 900, title: "首次启动" };

import { Link } from "react-router";

export default function Welcome() {
	return (
		<div className="flex h-full flex-col bg-surface text-surface-foreground">
			<header className="flex h-9 items-center bg-surface-sunk px-3">
				<span className="icon-[lucide--terminal] size-3.5 text-accent" />
				<span className="ml-2 font-display text-[13px] font-semibold">TermX</span>
				<div className="ml-auto flex gap-1 text-muted">
					<span className="icon-[lucide--minus] size-3.5" />
					<span className="icon-[lucide--square] mx-2 size-3" />
					<span className="icon-[lucide--x] size-3.5" />
				</div>
			</header>
			<div className="grid min-h-0 flex-1 grid-cols-[1.1fr_0.9fr]">
				<div className="flex flex-col justify-center px-16">
					<div className="font-mono text-[12px] tracking-widest text-accent">TERMX</div>
					<h1 className="mt-3 font-display text-[40px] font-semibold leading-tight tracking-tight">
						一台主机，<br />一个工作区。
					</h1>
					<p className="mt-4 max-w-md text-[15px] leading-7 text-muted">
						终端、文件、端口转发和监控共用同一条连接。先导入已有会话，或手动加第一台主机。
					</p>
					<div className="mt-8 flex flex-col gap-2">
						<Link to="/hosts" className="flex h-11 w-[360px] items-center gap-3 rounded-md bg-surface-raised px-4">
							<span className="icon-[lucide--file-key] size-4 text-accent" />
							<span className="flex-1 text-[14px]">导入 ~/.ssh/config</span>
							<span className="text-[12px] text-faint">12 台</span>
						</Link>
						<Link to="/hosts" className="flex h-11 w-[360px] items-center gap-3 rounded-md bg-surface-raised px-4">
							<span className="icon-[lucide--import] size-4 text-accent" />
							<span className="flex-1 text-[14px]">从 Xshell / FinalShell 导入</span>
						</Link>
						<Link to="/host-edit" className="flex h-11 w-[360px] items-center justify-center rounded-md bg-accent text-[14px] font-medium text-primary-foreground">
							手动新建第一台主机
						</Link>
					</div>
				</div>
				<div className="flex items-center bg-surface-raised px-12">
					<div className="w-full max-w-sm">
						<div className="font-mono text-[11px] tracking-wider text-faint">可选</div>
						<h2 className="mt-1 font-display text-xl font-semibold">设置主密码</h2>
						<p className="mt-2 text-[13px] leading-6 text-muted">凭据会存进系统钥匙串。不设也可以，稍后在设置里打开。</p>
						<label className="mt-5 block text-[12px] text-muted">主密码</label>
						<div className="mt-1 h-9 rounded-md bg-surface px-3 font-mono text-[13px] leading-9 text-faint">••••••••</div>
						<label className="mt-3 block text-[12px] text-muted">再输一次</label>
						<div className="mt-1 h-9 rounded-md bg-surface px-3 font-mono text-[13px] leading-9 text-faint">••••••••</div>
						<div className="mt-5 flex items-center gap-3">
							<Link to="/" className="rounded-md bg-accent px-4 py-2 text-[13px] font-medium text-primary-foreground">保存并进入</Link>
							<Link to="/" className="text-[13px] text-muted">跳过</Link>
						</div>
					</div>
				</div>
			</div>
		</div>
	);
}
