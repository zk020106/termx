import type { LockVerifier } from "@/data/preferences";

/* 应用锁密码的校验材料。
 * 只保存「随机盐 + PBKDF2-SHA256 摘要」，不保存密码本身；
 * 解不开就说明密码不对，没有任何后门（忘了只能重设，见设置页）。 */

const ITERATIONS = 120_000;
const KEY_BITS = 256;
const SALT_BYTES = 16;

/** 运行环境是否真的提供了 WebCrypto（没有就不该假装能设密码） */
export function lockCryptoAvailable(): boolean {
	return typeof crypto !== "undefined" && typeof crypto.subtle !== "undefined";
}

function toHex(bytes: Uint8Array): string {
	return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array {
	const out = new Uint8Array(Math.floor(hex.length / 2));
	for (let i = 0; i < out.length; i += 1) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	return out;
}

async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
	const material = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, [
		"deriveBits",
	]);
	const bits = await crypto.subtle.deriveBits(
		{ name: "PBKDF2", hash: "SHA-256", salt: salt as unknown as BufferSource, iterations },
		material,
		KEY_BITS,
	);
	return toHex(new Uint8Array(bits));
}

/** 定长比较：不按字符提前返回 */
function sameDigest(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let diff = 0;
	for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	return diff === 0;
}

export async function createVerifier(password: string): Promise<LockVerifier> {
	const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
	return { salt: toHex(salt), hash: await derive(password, salt, ITERATIONS), iterations: ITERATIONS };
}

export async function verifyPassword(password: string, verifier: LockVerifier): Promise<boolean> {
	if (!lockCryptoAvailable() || !verifier.salt || !verifier.hash) return false;
	const hash = await derive(password, fromHex(verifier.salt), verifier.iterations || ITERATIONS);
	return sameDigest(hash, verifier.hash);
}
