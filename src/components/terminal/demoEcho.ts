import { fg, type TerminalPalette } from "./terminalTheme";

/* =============================================================================
 * 演示模式下的「命令 → 输出」回路。
 *
 * 浏览器里没有 Rust 壳，Terminal 会进入演示模式：输入的命令不发往 PTY，而是
 * 由这里挑一段合理回显，让评审时能看出「敲命令 → 有输出 → 回到提示符」的完整
 * 交互，而不是一张静态图。颜色同样只取设计 token。
 * ========================================================================== */

/** 支持的命令清单，未知命令会把这行提示回去 */
const HINT =
	"提示：可试 ls / pwd / whoami / date / git status / docker ps / tail -f app.log / systemctl status order-api / clear / help";

const HELP_LINES = [
	"演示模式内置命令：",
	"  ls · pwd · whoami · date · uname -a · df -h",
	"  tail -f app.log · cat config.yml · docker ps",
	"  git status · git log · systemctl status order-api",
	"  clear（清屏） · help（本帮助）",
];

export function demoEcho(command: string, palette: TerminalPalette): string[] {
	const cmd = command.trim();
	if (!cmd) return [];

	const [bin, ...args] = cmd.split(/\s+/);
	const info = (text: string) => fg(palette.success, "INFO ") + fg(palette.muted, text);
	const plain = (text: string) => fg(palette.muted, text);
	const ok = (text: string) => fg(palette.success, text);

	switch (bin) {
		case "help":
			return HELP_LINES.map(plain);

		case "pwd":
			return [plain("/home/deploy/app")];

		case "whoami":
			return [plain("deploy")];

		case "date":
			return [plain("2026年 09月 29日 星期一 12:14:08 CST")];

		case "uname":
			return [plain("Linux order-api-01 5.15.0-89-generic #99-Ubuntu SMP x86_64 GNU/Linux")];

		case "df":
			return [
				plain("Filesystem      Size  Used Avail Use% Mounted on"),
				plain("/dev/vda1        40G   28G   11G  71% /"),
				plain("/dev/vdb1       200G   96G   94G  51% /data"),
			];

		case "ls":
		case "ll":
			return [
				fg(palette.accent, "drwxr-xr-x  ") + plain("4 deploy deploy 4096 09-23 14:12 ") + fg(palette.primary, "logs/"),
				plain("-rw-r--r--  1 deploy deploy  12M 09-23 14:41 app.log"),
				plain("-rw-r--r--  1 deploy deploy  2.0K 09-23 14:12 config.yml"),
				fg(palette.accent, "drwxr-xr-x  ") + plain("3 deploy deploy 4096 09-22 18:20 ") + fg(palette.primary, "release/"),
				plain("-rw-r--r--  1 deploy deploy   84M 09-22 18:20 order-api.jar"),
			];

		case "cat": {
			const file = args[0] ?? "config.yml";
			if (file.includes("log")) return [plain("app.log 有 12.4 MB，请用 tail -f app.log 跟踪")];
			return [
				plain("server:"),
				plain("  port: 8080"),
				plain("  env: prod"),
				plain("database:"),
				plain("  url: jdbc:postgresql://10.2.0.11:5432/orders"),
				plain("redis:"),
				plain("  host: 10.0.8.40"),
				plain("  port: 6379"),
			];
		}

		case "tail":
			return [
				info("10:14:12.004 [http-nio-8080] OrderService: created id=88244 user=lu"),
				info("10:14:13.317 [http-nio-8080] OrderService: paid id=88244 amount=¥268.00"),
				fg(palette.warning, "WARN ") + fg(palette.muted, "10:14:15.882 [db-pool-2] Slow query 0.9s: SELECT * FROM orders WHERE status = 'PENDING'"),
				ok("INFO 10:14:16.140 [retry-worker] Redis 连接已恢复，队列积压 0"),
			];

		case "docker":
			return [
				fg(palette.faint, "CONTAINER ID   IMAGE                     STATUS          PORTS                    NAMES"),
				plain("a13f9c2e71b4   order-api:1.8.2           Up 41 days      0.0.0.0:8080->8080/tcp   order-api"),
				plain("7c2d40aa19e8   redis:7.2-alpine          Up 41 days      6379/tcp                 order-redis"),
				plain("2f81bb0c4d33   nginx:1.25                Up 41 days      80/tcp, 443/tcp          order-gateway"),
			];

		case "git":
			return [
				plain("## release/1.8.2...origin/release/1.8.2"),
				plain(" M src/main/resources/application-prod.yml"),
				fg(palette.success, "?? deploy/release-1.8.2.tar.gz"),
			];

		case "systemctl":
			return [
				plain("● order-api.service - TermX Order API"),
				plain("     Loaded: loaded (/etc/systemd/system/order-api.service; enabled)"),
				ok("     Active: active (running) since Thu 2026-08-20 06:12:04 CST; 41 days ago"),
				plain("   Main PID: 1842 (java)"),
			];

		case "htop":
		case "top":
			return [fg(palette.faint, "演示模式不渲染 htop 交互界面，请查看右侧「主机监控」面板")];

		case "exit":
		case "logout":
			return [fg(palette.warning, "演示模式：会话保持打开，不会真的退出")];

		default:
			return [plain(`bash: ${bin}: 演示模式没有内置它的输出`), fg(palette.faint, HINT)];
	}
}
