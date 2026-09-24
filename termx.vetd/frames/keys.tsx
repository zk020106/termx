export const frame = { width: 1440, height: 900, title: "密钥库" };

import { WindowChrome } from "../components/WindowChrome";

const keys = [
	{ name: "工作笔记本", type: "Ed25519", use: "12 台主机", fingerprint: "SHA256:k9Qm…e2" },
	{ name: "跳板专用", type: "Ed25519", use: "bastion-sh", fingerprint: "SHA256:a1Lp…90" },
	{ name: "旧 RSA", type: "RSA 4096", use: "未使用", fingerprint: "SHA256:zz18…44" },
];

export default function Keys() {
	return (
		<WindowChrome activity="keys">
			<div className="flex min-h-0 flex-1">
				<aside className="flex w-[280px] shrink-0 flex-col bg-surface-raised">
					<div className="flex h-12 items-center justify-between px-3">
						<h1 className="text-[14px] font-semibold">密钥库</h1>
						<span className="text-[12px] text-accent">生成</span>
					</div>
					{keys.map((k, i) => (
						<div key={k.name} className={`mx-2 mb-1 rounded-md px-2 py-2 ${i === 0 ? "bg-accent-soft" : ""}`}>
							<div className="flex items-center justify-between text-[13px]">
								<span>{k.name}</span>
								<span className="font-mono text-[11px] text-muted">{k.type}</span>
							</div>
							<div className="text-[11px] text-faint">{k.use}</div>
						</div>
					))}
					<div className="mx-3 mt-2 text-[12px] text-muted">导入私钥</div>
				</aside>
				<div className="min-w-0 flex-1 px-8 py-6">
					<div className="text-[12px] text-faint">Ed25519 · 2024-03-02</div>
					<h2 className="mt-1 font-display text-xl font-semibold">工作笔记本</h2>
					<div className="mt-3 font-mono text-[12px] text-muted">SHA256:k9Qm3pL8nR2vXc4e2</div>
					<pre className="mt-4 max-w-xl overflow-hidden rounded-md bg-term p-3 font-mono text-[12px] text-term-ink">ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIBk7… deploy@studio</pre>
					<div className="mt-4 flex gap-2 text-[13px]">
						<button type="button" className="rounded-md bg-surface-raised px-3 py-1.5">复制公钥</button>
						<button type="button" className="rounded-md bg-accent px-3 py-1.5 font-medium text-primary-foreground">部署到主机</button>
					</div>
					<div className="mt-8 max-w-md rounded-lg bg-surface-raised p-4">
						<div className="text-[13px] font-medium">部署公钥</div>
						<p className="mt-1 text-[12px] leading-5 text-muted">写入 order-api-01 的 authorized_keys。经 bastion-sh，使用当前身份。</p>
						<div className="mt-3 flex h-8 items-center rounded-md bg-surface px-2 font-mono text-[12px]">deploy@10.0.3.21</div>
						<button type="button" className="mt-3 rounded-md bg-accent px-3 py-1.5 text-[13px] font-medium text-primary-foreground">写入</button>
					</div>
				</div>
			</div>
		</WindowChrome>
	);
}
