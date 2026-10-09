import { Button } from "@/components/ui/Button";
import { Field, Input } from "@/components/ui/Input";
import { Checkbox } from "@/components/ui/Toggle";
import type { AuthMethod, Host } from "@/data/types";
import { cn } from "@/lib/cn";
import { secretDelete, secretLoad, secretSave } from "@/lib/secret";
import {
	listenAuthPrompts,
	sshAuthRespond,
	sshReplaceHostKey,
	sshSupported,
	sshTrustHost,
	stageCredential,
	type AuthPromptRequest,
	type Credential,
	type SshPhase,
} from "@/lib/ssh";
import { useHostsStore } from "@/store/hosts";
import { useKeysStore } from "@/store/keys";
import { useSessionsStore } from "@/store/sessions";
import { toast } from "@/store/toast";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { openSshSession, type SshOpenResult } from "./sshCache";

interface InTabConnectProps {
	paneId: string;
	hostId: string;
	sessionKey: string;
	onConnected: () => void;
	onCancel?: () => void;
}

const AUTH_METHODS: { id: AuthMethod; label: string; icon: string }[] = [
	{ id: "password", label: "密码", icon: "icon-[lucide--lock]" },
	{ id: "key", label: "私钥", icon: "icon-[lucide--key]" },
	{ id: "agent", label: "Agent", icon: "icon-[lucide--bot]" },
	{ id: "keyboard-interactive", label: "交互", icon: "icon-[lucide--keyboard]" },
];

export function InTabConnect({ hostId, sessionKey, onConnected, onCancel }: InTabConnectProps) {
	const host = useHostsStore((s) => s.hosts.find((h) => h.id === hostId)) as Host | undefined;
	const keys = useKeysStore((s) => s.keys);

	const [connecting, setConnecting] = useState(false);
	const [phaseText, setPhaseText] = useState("");
	const [error, setError] = useState<string | null>(null);

	// 表单状态：支持在此直接切换认证方式，与主机配置无缝同步
	const [authMethod, setAuthMethod] = useState<AuthMethod>(host?.auth.method ?? "password");
	const [password, setPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [rememberPassword, setRememberPassword] = useState(host?.auth.rememberPassword ?? false);
	const [selectedKeyId, setSelectedKeyId] = useState(host?.auth.keyId ?? (keys[0]?.id || ""));
	const [keyPath, setKeyPath] = useState(host?.auth.keyPath ?? "");
	const [passphrase, setPassphrase] = useState("");
	const [showPassphrase, setShowPassphrase] = useState(false);
	const [updateDefaultAuth, setUpdateDefaultAuth] = useState(true);

	// 指纹告警
	const [fingerprintAlert, setFingerprintAlert] = useState<{
		kind: "host_unknown" | "host_changed";
		fingerprint: string | null;
		detail: string;
		/** 出问题的那一跳（跳板机时与目标不同） */
		target?: { host: string; port: number };
	} | null>(null);

	// 键盘交互状态
	const [authPrompt, setAuthPrompt] = useState<AuthPromptRequest | null>(null);
	const [promptAnswers, setPromptAnswers] = useState<string[]>([]);
	const [submittingPrompt, setSubmittingPrompt] = useState(false);

	const autoConnectAttempted = useRef(false);

	// 监听键盘交互事件
	useEffect(() => {
		if (!sessionKey || !sshSupported()) return;
		let unlisten: (() => void) | null = null;
		void listenAuthPrompts(sessionKey, (payload) => {
			setAuthPrompt(payload);
			setPromptAnswers(payload.prompts.map(() => ""));
		}).then((fn) => {
			unlisten = fn;
		});
		return () => {
			unlisten?.();
		};
	}, [sessionKey]);

	const buildCredential = useCallback(
		(overridePassword?: string, overrideMethod?: AuthMethod, overrideKeyPath?: string): Credential => {
			const activeMethod = overrideMethod ?? authMethod;
			const effectivePassword = overridePassword !== undefined ? overridePassword : password;
			const activeKeyPath = overrideKeyPath !== undefined ? overrideKeyPath : keyPath;

			switch (activeMethod) {
				case "key":
				case "key-passphrase":
					return {
						method: "private_key",
						path: activeKeyPath.trim(),
						passphrase: passphrase ? passphrase : null,
					};
				case "agent":
					return { method: "agent" };
				case "keyboard-interactive":
					return { method: "keyboard_interactive" };
				default:
					return { method: "password", password: effectivePassword };
			}
		},
		[authMethod, keyPath, passphrase, password],
	);

	// 执行真实连接
	const doConnect = useCallback(
		async (overridePassword?: string, overrideMethod?: AuthMethod, overrideKeyPath?: string) => {
			if (!host) return;
			const activeMethod = overrideMethod ?? authMethod;
			const effectivePassword = overridePassword !== undefined ? overridePassword : password;
			const activeKeyPath = overrideKeyPath !== undefined ? overrideKeyPath : keyPath;

			if (activeMethod === "password" && !effectivePassword) {
				setError("请输入登录密码");
				return;
			}
			if ((activeMethod === "key" || activeMethod === "key-passphrase") && !activeKeyPath.trim()) {
				setError("请选择或输入私钥文件路径");
				return;
			}

			setConnecting(true);
			setError(null);
			setFingerprintAlert(null);
			setPhaseText("正在连接…");

			try {
				const cred = buildCredential(effectivePassword, activeMethod, activeKeyPath);
				stageCredential(sessionKey, cred);

				const result: SshOpenResult = await openSshSession(
					sessionKey,
					{
						host: host.hostname,
						port: host.port,
						username: host.username,
						password: cred.method === "password" ? cred.password : "",
						cols: 80,
						rows: 24,
						// 跳板链、代理、TERM / 环境变量 / 登录脚本 / 编码都按主机配置展开
						hostId: host.id,
					},
					(phase: SshPhase) => {
						setPhaseText(phase.detail || phase.phase);
					},
				);

				if (result.ok) {
					// 连接成功：处理钥匙串持久化
					const shouldSavePwd = activeMethod === "password" && rememberPassword;
					if (shouldSavePwd && effectivePassword) {
						void secretSave(host.id, effectivePassword).catch(() => undefined);
					} else if (activeMethod === "password" && !rememberPassword) {
						void secretDelete(host.id).catch(() => undefined);
					}

					// 同步更新主机实体（认证方式、私钥路径、最近连接时间；密码只进钥匙串）
					const updatedHost: Host = {
						...host,
						lastConnectedAt: new Date().toISOString(),
						auth: {
							...host.auth,
							method: updateDefaultAuth ? activeMethod : host.auth.method,
							rememberPassword: activeMethod === "password" ? rememberPassword : host.auth.rememberPassword,
							keyPath: (activeMethod === "key" || activeMethod === "key-passphrase") ? (activeKeyPath.trim() || host.auth.keyPath) : host.auth.keyPath,
							keyId: (activeMethod === "key" || activeMethod === "key-passphrase") && selectedKeyId ? selectedKeyId : host.auth.keyId,
						},
					};
					useHostsStore.getState().upsertHost(updatedHost);

					// 更新 store 状态
					const activeTab = useSessionsStore.getState().tabs.find((t) => t.sessionKey === sessionKey);
					if (activeTab) {
						useSessionsStore.getState().setStatus(activeTab.id, "connected");
					}

					toast({
						title: `已成功连接到 ${host.name}`,
						description: `${host.username}@${host.hostname}:${host.port}`,
						tone: "success",
					});
					onConnected();
				} else {
					setConnecting(false);
					if (result.kind === "host_unknown" || result.kind === "host_changed") {
						setFingerprintAlert({
							kind: result.kind,
							fingerprint: result.fingerprint ?? null,
							detail: result.error ?? (result.kind === "host_unknown" ? "首次连接此主机，请核对指纹" : "主机指纹发生变动！"),
							target: result.host && result.port ? { host: result.host, port: result.port } : undefined,
						});
					} else {
						setError(result.error ?? "连接失败，请检查网络或凭据");
					}
				}
			} catch (err) {
				setConnecting(false);
				setError(err instanceof Error ? err.message : String(err));
			}
		},
		[host, sessionKey, authMethod, password, keyPath, passphrase, rememberPassword, updateDefaultAuth, selectedKeyId, buildCredential, onConnected],
	);

	// 初始加载钥匙串并尝试自动连接
	useEffect(() => {
		if (!host || autoConnectAttempted.current) return;
		autoConnectAttempted.current = true;

		if (host.auth.method === "password") {
			// 已记住密码：从系统钥匙串（或本次运行的内存）载入后自动连接
			if (host.auth.rememberPassword) {
				void secretLoad(host.id).then((savedPassword) => {
					if (savedPassword) {
						setPassword(savedPassword);
						setRememberPassword(true);
						void doConnect(savedPassword, "password");
					}
				});
			}
		} else if (host.auth.method === "agent" || host.auth.method === "keyboard-interactive") {
			void doConnect(undefined, host.auth.method);
		} else if ((host.auth.method === "key" || host.auth.method === "key-passphrase") && host.auth.keyPath) {
			void doConnect(undefined, host.auth.method, host.auth.keyPath);
		}
	}, [host, doConnect]);

	const choosePrivateKeyFile = async () => {
		try {
			const picked = await openFileDialog({ multiple: false, directory: false, title: "选择私钥文件" });
			if (picked) setKeyPath(picked);
		} catch {
			// ignore
		}
	};

	const handleTrustAndConnect = async () => {
		if (!host || !fingerprintAlert) return;
		// 经跳板机时，出问题的可能是跳板机：信任 / 替换作用在 Rust 报回来的那一跳上
		const at = fingerprintAlert.target ?? { host: host.hostname, port: host.port };
		try {
			if (fingerprintAlert.kind === "host_unknown") {
				await sshTrustHost(at.host, at.port, fingerprintAlert.fingerprint);
			} else {
				await sshReplaceHostKey(at.host, at.port, fingerprintAlert.fingerprint);
			}
		} catch (err) {
			// 例如核对期间对端换了钥匙：如实显示，不假装记下了
			setFingerprintAlert(null);
			setError(err instanceof Error ? err.message : String(err));
			return;
		}
		setFingerprintAlert(null);
		void doConnect();
	};

	const submitKeyboardInteractive = async () => {
		if (!authPrompt || submittingPrompt) return;
		setSubmittingPrompt(true);
		try {
			await sshAuthRespond(sessionKey, promptAnswers);
			setAuthPrompt(null);
		} catch (err) {
			toast({ title: "提交验证回答失败", description: String(err), tone: "danger" });
		} finally {
			setSubmittingPrompt(false);
		}
	};

	if (!host) {
		return (
			<div className="flex h-full flex-col items-center justify-center p-6 text-center text-muted">
				<span className="icon-[lucide--server-off] size-8 text-faint mb-2" />
				<div className="text-[13px] font-medium text-surface-foreground">未找到主机配置</div>
				<div className="mt-1 text-[11px] text-faint">主机可能已被删除</div>
			</div>
		);
	}

	return (
		<div className="relative flex h-full w-full flex-col items-center justify-center overflow-y-auto bg-term p-6 text-term-ink select-none">
			{/* 背景装饰光晕 */}
			<div className="pointer-events-none absolute -top-12 -left-12 size-64 rounded-full bg-primary/5 blur-3xl" />
			<div className="pointer-events-none absolute -right-12 -bottom-12 size-64 rounded-full bg-accent/5 blur-3xl" />

			<div className="relative z-10 w-full max-w-[400px] rounded-xl border border-border bg-surface-raised/95 p-5 shadow-2xl backdrop-blur-md">
				{/* 头部信息 */}
				<div className="flex items-center gap-3 border-b border-border/80 pb-3.5">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
						<span className="icon-[lucide--server] size-4.5" />
					</div>
					<div className="min-w-0 flex-1">
						<div className="truncate text-[13px] font-semibold text-surface-foreground">{host.name}</div>
						<div className="truncate font-mono text-[11px] text-muted">
							{host.username}@{host.hostname}:{host.port}
						</div>
					</div>
				</div>

				{/* 1. 服务器指纹首次确认或指纹变更警告 */}
				{fingerprintAlert ? (
					<div className="mt-4 space-y-3">
						<div
							className={cn(
								"rounded-lg border p-3 text-[11.5px] leading-5",
								fingerprintAlert.kind === "host_unknown"
									? "border-primary/40 bg-primary/10 text-surface-foreground"
									: "border-danger/40 bg-danger/10 text-danger",
							)}
						>
							<div className="flex items-center gap-1.5 font-medium">
								<span
									className={cn(
										fingerprintAlert.kind === "host_unknown" ? "icon-[lucide--shield-alert]" : "icon-[lucide--triangle-alert]",
										"size-4 shrink-0",
									)}
								/>
								<span>{fingerprintAlert.kind === "host_unknown" ? "首次连接服务器指纹确认" : "服务器指纹变动警报！"}</span>
							</div>
							<p className="mt-1 text-muted">{fingerprintAlert.detail}</p>
							{fingerprintAlert.fingerprint && (
								<div className="mt-2 rounded bg-surface p-1.5 font-mono text-[10px] break-all select-all text-faint">
									{fingerprintAlert.fingerprint}
								</div>
							)}
						</div>

						<div className="flex items-center justify-end gap-2 pt-1">
							{onCancel && (
								<Button size="sm" variant="ghost" onClick={onCancel}>
									取消
								</Button>
							)}
							<Button
								size="sm"
								variant={fingerprintAlert.kind === "host_unknown" ? "primary" : "danger"}
								onClick={() => void handleTrustAndConnect()}
							>
								{fingerprintAlert.kind === "host_unknown" ? "信任并继续" : "确认信任新指纹"}
							</Button>
						</div>
					</div>
				) : authPrompt ? (
					/* 2. 键盘交互模式（二次验证 / OTP） */
					<div className="mt-4 space-y-3">
						<div className="text-[12px] font-medium text-surface-foreground">
							{authPrompt.name || "服务器多因素认证"}
						</div>
						{authPrompt.instructions && <p className="text-[11px] text-muted">{authPrompt.instructions}</p>}

						{authPrompt.prompts.map((p, idx) => (
							<Field key={idx} label={p.prompt || "输入认证码"}>
								<Input
									type={p.echo ? "text" : "password"}
									autoFocus={idx === 0}
									value={promptAnswers[idx] ?? ""}
									onChange={(e) => {
										const next = [...promptAnswers];
										next[idx] = e.target.value;
										setPromptAnswers(next);
									}}
									onKeyDown={(e) => {
										if (e.key === "Enter") void submitKeyboardInteractive();
									}}
								/>
							</Field>
						))}

						<div className="flex items-center justify-end gap-2 pt-2">
							<Button size="sm" variant="primary" disabled={submittingPrompt} onClick={() => void submitKeyboardInteractive()}>
								{submittingPrompt ? "提交中…" : "提交验证"}
							</Button>
						</div>
					</div>
				) : connecting ? (
					/* 3. 正在握手连接中 */
					<div className="mt-6 flex flex-col items-center justify-center py-4 text-center">
						<div className="flex size-8 items-center justify-center rounded-full bg-primary/10 text-primary">
							<span className="icon-[lucide--loader-circle] size-5 animate-spin" />
						</div>
						<div className="mt-3 text-[12px] font-medium text-surface-foreground">正在建立 SSH 会话…</div>
						<div className="mt-1 font-mono text-[11px] text-muted">{phaseText}</div>
					</div>
				) : (
					/* 4. 凭据输入与连接表单 */
					<form
						onSubmit={(e) => {
							e.preventDefault();
							void doConnect();
						}}
						className="mt-4 space-y-4"
					>
						{error && (
							<div className="flex items-start gap-2 rounded-lg border border-danger/30 bg-danger/10 p-2.5 text-[11.5px] text-danger">
								<span className="icon-[lucide--alert-circle] mt-0.5 size-3.5 shrink-0" />
								<div className="flex-1">{error}</div>
							</div>
						)}

						{/* 认证方式切换 */}
						<div className="grid grid-cols-4 gap-1 rounded-lg border border-border/70 bg-surface-sunk/60 p-1">
							{AUTH_METHODS.map((item) => {
								const active = authMethod === item.id;
								return (
									<button
										key={item.id}
										type="button"
										onClick={() => {
											setAuthMethod(item.id);
											setError(null);
										}}
										className={cn(
											"flex items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-all cursor-pointer",
											active
												? "border border-border/80 bg-surface font-semibold text-primary shadow-2xs"
												: "text-muted hover:bg-surface/50 hover:text-surface-foreground",
										)}
									>
										<span className={cn(item.icon, "size-3.5 shrink-0")} />
										<span>{item.label}</span>
									</button>
								);
							})}
						</div>

						{/* 密码方式 */}
						{authMethod === "password" && (
							<div className="space-y-3">
								<Field label="登录密码">
									<div className="relative">
										<Input
											type={showPassword ? "text" : "password"}
											autoFocus
											placeholder="输入 SSH 登录密码"
											value={password}
											onChange={(e) => setPassword(e.target.value)}
											className="h-8.5 pr-8.5 font-mono text-xs"
										/>
										<button
											type="button"
											tabIndex={-1}
											onClick={() => setShowPassword(!showPassword)}
											className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-surface-foreground cursor-pointer"
											title={showPassword ? "隐藏密码" : "显示密码"}
										>
											<span className={cn("size-3.5", showPassword ? "icon-[lucide--eye-off]" : "icon-[lucide--eye]")} />
										</button>
									</div>
								</Field>

								<Checkbox
									label="记住密码"
									checked={rememberPassword}
									onChange={setRememberPassword}
								/>
							</div>
						)}

						{/* 私钥方式 */}
						{(authMethod === "key" || authMethod === "key-passphrase") && (
							<div className="space-y-3">
								{keys.length > 0 && (
									<Field label="选择密钥">
										<select
											value={selectedKeyId}
											onChange={(e) => setSelectedKeyId(e.target.value)}
											className="h-8.5 w-full rounded-md border border-border bg-surface px-2.5 text-xs text-surface-foreground focus:outline-none focus:ring-1 focus:ring-primary"
										>
											{keys.map((k) => (
												<option key={k.id} value={k.id}>
													🔑 {k.name} ({k.type.toUpperCase()})
												</option>
											))}
											<option value="">不使用已登记密钥</option>
										</select>
									</Field>
								)}

								<Field label="私钥文件">
									<div className="flex gap-1.5">
										<Input
											type="text"
											placeholder="例如 ~/.ssh/id_rsa 或选择本地文件"
											value={keyPath}
											onChange={(e) => setKeyPath(e.target.value)}
											className="h-8.5 font-mono text-xs"
										/>
										<Button type="button" size="sm" variant="default" onClick={() => void choosePrivateKeyFile()}>
											浏览
										</Button>
									</div>
								</Field>

								<Field label="私钥口令 (Passphrase，可选)">
									<div className="relative">
										<Input
											type={showPassphrase ? "text" : "password"}
											placeholder="私钥若设置了加密口令请输入"
											value={passphrase}
											onChange={(e) => setPassphrase(e.target.value)}
											className="h-8.5 pr-8.5 font-mono text-xs"
										/>
										<button
											type="button"
											tabIndex={-1}
											onClick={() => setShowPassphrase(!showPassphrase)}
											className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted hover:text-surface-foreground cursor-pointer"
											title={showPassphrase ? "隐藏口令" : "显示口令"}
										>
											<span className={cn("size-3.5", showPassphrase ? "icon-[lucide--eye-off]" : "icon-[lucide--eye]")} />
										</button>
									</div>
								</Field>
							</div>
						)}

						{/* SSH Agent 方式 */}
						{authMethod === "agent" && (
							<div className="flex items-center gap-2.5 rounded-lg border border-border/80 bg-surface-sunk/40 p-3 text-xs text-muted">
								<span className="icon-[lucide--bot] size-4 text-primary shrink-0" />
								<span>自动使用本机正在运行的 SSH Agent 进行认证。</span>
							</div>
						)}

						{/* 键盘交互方式 */}
						{authMethod === "keyboard-interactive" && (
							<div className="flex items-center gap-2.5 rounded-lg border border-border/80 bg-surface-sunk/40 p-3 text-xs text-muted">
								<span className="icon-[lucide--keyboard] size-4 text-primary shrink-0" />
								<span>连接时服务端将推送交互提示（如 2FA / 动态口令），按提示输入即可。</span>
							</div>
						)}

						{/* 更新为默认认证方式 */}
						<div className="pt-0.5">
							<Checkbox
								label="更新为此主机的默认认证方式"
								checked={updateDefaultAuth}
								onChange={setUpdateDefaultAuth}
							/>
						</div>

						{/* 底部操作按钮 */}
						<div className="flex items-center justify-between pt-2 border-t border-border/60">
							{onCancel ? (
								<Button type="button" size="sm" variant="ghost" onClick={onCancel}>
									关闭标签
								</Button>
							) : <span />}

							<Button type="submit" size="sm" variant="primary" icon="icon-[lucide--plug]">
								立即连接
							</Button>
						</div>
					</form>
				)}
			</div>
		</div>
	);
}
