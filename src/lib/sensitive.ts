/* =============================================================================
 * 命令历史的敏感内容过滤。
 *
 * 终端会把每次回车前敲的内容记进命令历史（localStorage）。两类内容绝不能进：
 * 1. 在密码 / 口令 / 验证码提示符下敲的东西（sudo、ssh、su、mysql -p 等）——
 *    它们根本不是命令，而是明文秘密；
 * 2. 命令行里直接带着秘密的命令（--password=…、TOKEN=… curl、URL 里的 user:pass@ 等）。
 *
 * 本文件保持纯函数、无运行时依赖，便于单测。
 * ========================================================================== */

/** 常见的「请输入秘密」提示：行尾是冒号（可带空白），前面出现密码类关键词 */
const SECRET_PROMPT =
	/(password|passwd|passphrase|pass phrase|密码|口令|密碼|verification code|验证码|one[- ]time|otp|\bpin\b|token|secret)[^\n]*[:：]\s*$/i;

/** 看起来像「提示符等你输入」而不是 shell 提示符（$ # % > 结尾）的行尾 */
const PROMPT_LIKE_END = /[:：?？]\s*$/;

export function looksLikeSecretPrompt(lineBeforeInput: string): boolean {
	return SECRET_PROMPT.test(lineBeforeInput);
}

/**
 * 回车时判断这一行输入是不是秘密。
 * @param visibleLine 回车那一刻光标所在的逻辑行（含折行）在屏幕上的文本
 * @param typed       这次敲进去的内容
 */
export function isLikelySecretEntry(visibleLine: string, typed: string): boolean {
	const line = visibleLine.replace(/\s+$/, "");
	if (looksLikeSecretPrompt(line)) return true;
	// 远端关了回显（敲的字没出现在屏幕上），而这一行又像个提问：按秘密处理
	if (typed && !line.includes(typed) && PROMPT_LIKE_END.test(line)) return true;
	return false;
}

const SENSITIVE_COMMAND_PATTERNS: RegExp[] = [
	// --password=x / --password x / -password / --token / --secret / --api-key …
	/(^|\s)--?(password|passwd|pass|pwd|token|secret|api[-_]?key|access[-_]?key|secret[-_]?key|auth[-_]?token)([=\s]|$)/i,
	// 环境变量赋值：DB_PASSWORD=… / GITHUB_TOKEN=… / export AWS_SECRET_ACCESS_KEY=…
	/(^|[\s;&|])(export\s+)?[A-Za-z0-9_]*(password|passwd|secret|token|api_?key|access_?key|credential)[A-Za-z0-9_]*=/i,
	// mysql -pSECRET（-p 后紧跟密码）
	/\bmysql(dump|admin|import)?\b.*\s-p\S/,
	// sshpass -p / htpasswd -b / chpasswd / echo xxx | passwd --stdin
	/\bsshpass\b/,
	/\bhtpasswd\b.*\s-\w*b/,
	/\bchpasswd\b/,
	/\bpasswd\b.*--stdin/,
	// curl -u user:pass / --user user:pass
	/\s(-u|--user)\s+\S+:\S+/,
	// URL 里内嵌凭据：scheme://user:pass@host
	/[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@/i,
	// HTTP 认证头
	/authorization:\s*(basic|bearer|token)\s+\S+/i,
	/\bx-api-key:\s*\S+/i,
];

/** 命令行本身是否带着秘密 */
export function isSensitiveCommand(command: string): boolean {
	return SENSITIVE_COMMAND_PATTERNS.some((pattern) => pattern.test(command));
}
