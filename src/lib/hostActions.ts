import type { Host } from "@/data/types";
import { secretLoad } from "@/lib/secret";
import { formatHostCredentials } from "@/store/hosts";
import { toast } from "@/store/toast";

/* 主机右键里的两个「复制」动作，照搬 Netcatty VaultView 的 handleCopyHostname / handleCopyCredentials。 */

/** 复制主机地址：只复制 hostname（Netcatty getHostAddressForClipboard） */
export async function copyHostAddress(host: Host): Promise<void> {
	const hostname = host.hostname.trim();
	if (!hostname) {
		toast({ title: "复制主机地址失败", tone: "danger" });
		return;
	}
	try {
		await navigator.clipboard.writeText(hostname);
		toast({ title: `已复制主机地址：${hostname}`, tone: "success" });
	} catch {
		toast({ title: "复制主机地址失败", tone: "danger" });
	}
}

/**
 * 复制账密信息：`host: …\nusername: …\npassword: …`。
 * 密码只存在系统钥匙串里（termx 的安全模型），没记住密码时与 Netcatty 一样提示「该主机未保存密码」。
 */
export async function copyHostCredentials(host: Host): Promise<void> {
	const password = host.auth.method === "password" && host.auth.rememberPassword ? await secretLoad(host.id) : null;
	if (!password) {
		toast({ title: "该主机未保存密码", tone: "warning" });
		return;
	}
	try {
		await navigator.clipboard.writeText(formatHostCredentials(host, password));
		toast({ title: "账密信息已复制到剪贴板", tone: "success" });
	} catch {
		toast({ title: "复制失败", tone: "danger" });
	}
}
