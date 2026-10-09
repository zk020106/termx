import { Button } from "@/components/ui/Button";
import { Field, Input, Select, Textarea } from "@/components/ui/Input";
import { Drawer } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import type { Identity, SshKey } from "@/data/types";
import { keyTypeOf, keyVaultGenerate, keyVaultImport, type KeyVaultInfo } from "@/lib/keyVault";
import { secretDelete, secretLoad, secretSave } from "@/lib/secret";
import { identitySecretAccount, useIdentitiesStore } from "@/store/identities";
import { useKeysStore } from "@/store/keys";
import { toast } from "@/store/toast";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useState } from "react";

/* =============================================================================
 * 钥匙串面板 —— 对应 Netcatty components/keychain/*：
 *  GenerateStandardPanel（生成密钥）/ ImportKeyPanel（导入密钥）/ IdentityPanel（新建 / 编辑身份）。
 * 私钥交给 Rust 密钥库（key_vault.rs）：信封加密落盘，数据密钥在系统钥匙串；前端不留私钥。
 * ========================================================================== */

const newKeyId = () => `key-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

function toSshKey(id: string, label: string, info: KeyVaultInfo, source: SshKey["source"], savePassphrase: boolean): SshKey {
	return {
		id,
		name: label,
		type: keyTypeOf(info),
		bits: info.bits ?? (info.keyType === "ED25519" ? 256 : undefined),
		fingerprint: info.fingerprint,
		publicKey: info.publicKey,
		comment: info.comment || undefined,
		createdAt: new Date().toISOString(),
		deployedTo: [],
		hasPassphrase: info.encrypted,
		hasPrivateKey: true,
		source,
		savePassphrase: info.encrypted && savePassphrase,
	};
}

/** Netcatty GenerateStandardPanel：Label / 密钥类型 / 密钥长度 / Passphrase / 保存 Passphrase / 生成并保存 */
export function GenerateKeyDrawer({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (key: SshKey) => void }) {
	const [label, setLabel] = useState("");
	const [type, setType] = useState<"ED25519" | "ECDSA" | "RSA">("ED25519");
	const [bits, setBits] = useState(4096);
	const [passphrase, setPassphrase] = useState("");
	const [savePassphrase, setSavePassphrase] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!open) return;
		setLabel("");
		setType("ED25519");
		setBits(4096);
		setPassphrase("");
		setSavePassphrase(false);
	}, [open]);

	const generate = async () => {
		if (!label.trim()) {
			toast({ title: "请输入 Label", tone: "danger" });
			return;
		}
		setBusy(true);
		try {
			const id = newKeyId();
			const keyBits = type === "ED25519" ? null : bits;
			const info = await keyVaultGenerate(id, type, keyBits, `${label.trim()}@termx`, passphrase || null, savePassphrase);
			const key = toSshKey(id, label.trim(), info, "generated", savePassphrase);
			useKeysStore.getState().upsert(key);
			onSaved(key);
			onClose();
		} catch (error) {
			toast({ title: "生成密钥失败", description: String(error), tone: "danger" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Drawer
			open={open}
			onClose={onClose}
			title="生成密钥"
			subtitle="私钥保存在本机密钥库（系统钥匙串加密），不进配置文件"
			width={460}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" icon="icon-[lucide--key-round]" disabled={busy} onClick={() => void generate()}>
						{busy ? "生成中..." : "生成并保存"}
					</Button>
				</>
			}
		>
			<div className="space-y-3 p-3">
				<Field label="Label" required>
					<Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="密钥 Label" />
				</Field>
				<Field label="密钥类型">
					<Select
						value={type}
						onChange={(e) => {
							const next = e.target.value as typeof type;
							setType(next);
							setBits(next === "RSA" ? 4096 : 256);
						}}
					>
						<option value="ED25519">ED25519</option>
						<option value="ECDSA">ECDSA</option>
						<option value="RSA">RSA</option>
					</Select>
				</Field>
				{type !== "ED25519" && (
					<Field label="密钥长度">
						<Select value={String(bits)} onChange={(e) => setBits(Number(e.target.value))}>
							{(type === "RSA" ? [2048, 3072, 4096] : [256, 384, 521]).map((b) => (
								<option key={b} value={b}>
									{b} bits
								</option>
							))}
						</Select>
					</Field>
				)}
				<Field label="Passphrase">
					<Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Passphrase（可选）" autoComplete="new-password" />
				</Field>
				<Checkbox checked={savePassphrase} onChange={setSavePassphrase} disabled={!passphrase} label="保存 Passphrase" />
			</div>
		</Drawer>
	);
}

/** Netcatty ImportKeyPanel：Label / 私钥 * / Passphrase / 保存 Passphrase / 从文件导入 / 保存密钥 */
export function ImportKeyDrawer({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (key: SshKey) => void }) {
	const [label, setLabel] = useState("");
	const [privateKey, setPrivateKey] = useState("");
	const [filePath, setFilePath] = useState<string | null>(null);
	const [passphrase, setPassphrase] = useState("");
	const [savePassphrase, setSavePassphrase] = useState(false);
	const [busy, setBusy] = useState(false);
	useEffect(() => {
		if (!open) return;
		setLabel("");
		setPrivateKey("");
		setFilePath(null);
		setPassphrase("");
		setSavePassphrase(false);
	}, [open]);

	const pickFile = async () => {
		try {
			const picked = await openFileDialog({ multiple: false, directory: false, title: "从文件导入" });
			if (typeof picked === "string" && picked) {
				// 私钥文件由 Rust 读取（路径守卫 + 原生确认框），前端不读私钥文件
				setFilePath(picked);
				setPrivateKey("");
				setLabel((prev) => prev.trim() || picked.split(/[\\/]/).pop() || "已导入密钥");
			}
		} catch {
			/* 用户取消 */
		}
	};

	const save = async () => {
		if (!label.trim() || (!privateKey.trim() && !filePath)) {
			toast({ title: "请输入 Label 和私钥", tone: "danger" });
			return;
		}
		setBusy(true);
		try {
			const id = newKeyId();
			const info = await keyVaultImport(id, privateKey.trim() ? { privateKey } : { path: filePath ?? undefined }, passphrase || null, savePassphrase);
			const key = toSshKey(id, label.trim(), info, "imported", savePassphrase);
			useKeysStore.getState().upsert(key);
			setPrivateKey("");
			onSaved(key);
			onClose();
		} catch (error) {
			toast({ title: "导入密钥失败", description: String(error), tone: "danger" });
		} finally {
			setBusy(false);
		}
	};

	return (
		<Drawer
			open={open}
			onClose={onClose}
			title="新建密钥"
			subtitle="私钥交给本机密钥库（系统钥匙串加密保存），之后不会再显示"
			width={520}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" icon="icon-[lucide--check]" disabled={busy} onClick={() => void save()}>
						{busy ? "保存中..." : "保存密钥"}
					</Button>
				</>
			}
		>
			<div className="space-y-3 p-3">
				<Field label="Label" required>
					<Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="密钥 Label" />
				</Field>
				<Field label="私钥" required hint="支持 OpenSSH、PEM、PKCS#8、PuTTY .ppk">
					<Textarea
						rows={7}
						value={privateKey}
						onChange={(e) => {
							setPrivateKey(e.target.value);
							setFilePath(null);
						}}
						placeholder={filePath ? `将从文件导入：${filePath}` : "-----BEGIN OPENSSH PRIVATE KEY-----"}
						className="text-[10.5px]"
						autoComplete="off"
						spellCheck={false}
					/>
				</Field>
				<Field label="Passphrase">
					<Input type="password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} placeholder="Passphrase（可选）" autoComplete="new-password" />
				</Field>
				<Checkbox checked={savePassphrase} onChange={setSavePassphrase} disabled={!passphrase} label="保存 Passphrase" />
				<Button size="sm" icon="icon-[lucide--file-key]" onClick={() => void pickFile()}>
					从文件导入
				</Button>
			</div>
		</Drawer>
	);
}

/** Netcatty IdentityPanel：Label / 用户名 * / 密码 / 密钥 —— 保存 / 更新 */
export function IdentityDrawer({ open, identity, onClose }: { open: boolean; identity: Identity | null; onClose: () => void }) {
	const keys = useKeysStore((s) => s.keys);
	const [label, setLabel] = useState("");
	const [username, setUsername] = useState("");
	const [password, setPassword] = useState("");
	const [initialPassword, setInitialPassword] = useState("");
	const [showPassword, setShowPassword] = useState(false);
	const [keyId, setKeyId] = useState("");
	useEffect(() => {
		if (!open) return;
		setLabel(identity?.label ?? "");
		setUsername(identity?.username ?? "");
		setPassword("");
		setInitialPassword("");
		setShowPassword(false);
		setKeyId(identity?.authMethod === "key" ? (identity.keyId ?? "") : "");
		if (identity?.hasPassword) {
			void secretLoad(identitySecretAccount(identity.id))
				.then((saved) => {
					if (saved) {
						setPassword(saved);
						setInitialPassword(saved);
					}
				})
				.catch(() => undefined);
		}
	}, [open, identity]);

	const save = async () => {
		if (!label.trim() || !username.trim()) {
			toast({ title: "请输入 Label 和用户名", tone: "danger" });
			return;
		}
		const id = identity?.id ?? `identity-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
		let hasPassword = Boolean(identity?.hasPassword);
		if (password !== initialPassword) {
			try {
				if (password) {
					await secretSave(identitySecretAccount(id), password);
					hasPassword = true;
				} else {
					await secretDelete(identitySecretAccount(id));
					hasPassword = false;
				}
			} catch (error) {
				toast({ title: "身份密码未能存入系统钥匙串", description: String(error), tone: "warning" });
				hasPassword = Boolean(password);
			}
		}
		useIdentitiesStore.getState().upsert({
			id,
			label: label.trim(),
			username: username.trim(),
			authMethod: keyId ? "key" : "password",
			keyId: keyId || undefined,
			hasPassword,
			created: identity?.created ?? Date.now(),
		});
		onClose();
	};

	const privateKeys = keys.filter((k) => k.hasPrivateKey);
	return (
		<Drawer
			open={open}
			onClose={onClose}
			title={identity ? "编辑身份" : "新建身份"}
			subtitle="用户名 + 密码 / 密钥的组合；主机、分组、代理都可以引用"
			width={460}
			footer={
				<>
					<Button onClick={onClose}>取消</Button>
					<Button variant="primary" icon="icon-[lucide--check]" disabled={!label.trim() || !username.trim()} onClick={() => void save()}>
						{identity ? "更新" : "保存"}
					</Button>
				</>
			}
		>
			<div className="space-y-3 p-3">
				<Field label="Label" required>
					<Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Label" />
				</Field>
				<Field label="用户名" required>
					<Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="用户名" className="font-mono" />
				</Field>
				<Field label="密码" hint="存入系统钥匙串（identity:<id>），不进配置文件">
					<div className="relative">
						<Input
							type={showPassword ? "text" : "password"}
							value={password}
							onChange={(e) => setPassword(e.target.value)}
							placeholder="密码"
							autoComplete="new-password"
							className="pr-8 font-mono"
						/>
						<button
							type="button"
							className="absolute right-2 top-1/2 -translate-y-1/2 text-muted hover:text-surface-foreground"
							onClick={() => setShowPassword(!showPassword)}
						>
							<span className={showPassword ? "icon-[lucide--eye-off] size-3.5" : "icon-[lucide--eye] size-3.5"} />
						</button>
					</div>
				</Field>
				<Field label="密钥" hint={privateKeys.length === 0 ? "钥匙串里还没有带私钥的密钥" : undefined}>
					<Select value={keyId} onChange={(e) => setKeyId(e.target.value)}>
						<option value="">（不使用密钥）</option>
						{privateKeys.map((k) => (
							<option key={k.id} value={k.id}>
								{k.name} · {k.type.toUpperCase()}
								{k.bits ? ` ${k.bits}` : ""}
							</option>
						))}
						{keyId && !privateKeys.some((k) => k.id === keyId) && <option value={keyId}>密钥不存在</option>}
					</Select>
				</Field>
			</div>
		</Drawer>
	);
}

/** Netcatty IdentityCard 的摘要文案 */
export function identitySummary(identity: Identity): string {
	if (identity.authMethod === "key" && identity.keyId) return identity.hasPassword ? "认证密码与密钥" : "认证密钥";
	return identity.hasPassword ? "认证密码" : "无凭据";
}
