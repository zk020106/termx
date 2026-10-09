import { isTauri } from "./tauri";

/* 密钥库（src-tauri/src/key_vault.rs）的前端入口。
 * 私钥只经过一次：导入时把粘贴的文本交给 Rust（或只给 Rust 一个文件路径，由 Rust 读），
 * 之后私钥材料不再回到前端；连接时用 { method: "stored_key", keyId } 让 Rust 自己取。 */

export interface KeyVaultInfo {
	publicKey: string;
	fingerprint: string;
	/** ED25519 / ECDSA / RSA */
	keyType: string;
	bits: number | null;
	comment: string;
	encrypted: boolean;
}

async function call<T>(cmd: string, args: Record<string, unknown>): Promise<T> {
	if (!isTauri()) throw new Error("密钥库需要在桌面端使用");
	const { invoke } = await import("@tauri-apps/api/core");
	return invoke<T>(cmd, args);
}

export const keyVaultImport = (
	id: string,
	source: { privateKey?: string; path?: string },
	passphrase: string | null,
	savePassphrase: boolean,
) =>
	call<KeyVaultInfo>("key_vault_import", {
		id,
		privateKey: source.privateKey ?? null,
		path: source.path ?? null,
		passphrase,
		savePassphrase,
	});

export const keyVaultGenerate = (
	id: string,
	keyType: "ED25519" | "ECDSA" | "RSA",
	bits: number | null,
	comment: string,
	passphrase: string | null,
	savePassphrase: boolean,
) => call<KeyVaultInfo>("key_vault_generate", { id, keyType, bits, comment, passphrase, savePassphrase });

export const keyVaultDelete = (id: string) => call<void>("key_vault_delete", { id });

export const keyVaultSetPassphrase = (id: string, passphrase: string | null, save: boolean) =>
	call<void>("key_vault_set_passphrase", { id, passphrase, save });

export const keyVaultStatus = (ids: string[]) => call<boolean[]>("key_vault_status", { ids });

/** Netcatty KeyType → TermX KeyType */
export function keyTypeOf(info: KeyVaultInfo): "ed25519" | "rsa" | "ecdsa" {
	return info.keyType === "RSA" ? "rsa" : info.keyType === "ECDSA" ? "ecdsa" : "ed25519";
}
