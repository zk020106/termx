import { create } from "zustand";
import { isSensitiveCommand } from "@/lib/sensitive";
import { useSnippetsStore } from "./snippets";

/* =============================================================================
 * TermX — 命令记忆、Frecency 排名与智能预测引擎 (Warp / VS Code 体验)
 * ========================================================================== */

export type SuggestionSource = "history" | "snippet" | "preset";

export interface CommandRecord {
	id: string;
	command: string;
	hostId?: string | null;
	count: number;
	lastExecuted: number;
}

export interface CommandSuggestion {
	id: string;
	command: string;
	label: string;
	description?: string;
	source: SuggestionSource;
	count?: number;
	score: number;
}

/** 常用内置命令知识库（冷启动推荐） */
const PRESET_COMMANDS: Array<{ command: string; description: string }> = [
	{ command: "docker ps -a", description: "查看所有 Docker 容器" },
	{ command: "docker compose up -d", description: "后台启动 Compose 服务" },
	{ command: "docker compose logs -f", description: "跟踪容器实时日志" },
	{ command: "systemctl status", description: "查看系统服务状态" },
	{ command: "systemctl restart", description: "重启系统服务" },
	{ command: "journalctl -u", description: "查看指定 systemd 单元日志" },
	{ command: "git status", description: "检查 Git 工作区状态" },
	{ command: "git pull --rebase", description: "拉取远端更新并衍合" },
	{ command: "git checkout", description: "切换分支或回滚文件" },
	{ command: "git log --oneline -n 10", description: "紧凑查看最近10条提交" },
	{ command: "tail -f -n 100", description: "实时查看文件末尾" },
	{ command: "netstat -tulnp", description: "查看监听端口与占用进程" },
	{ command: "ss -tulpn", description: "现代 Linux 端口监听排查" },
	{ command: "htop", description: "交互式系统资源监控" },
	{ command: "df -h", description: "查看磁盘空间挂载占用" },
	{ command: "free -h", description: "查看内存与 Swap 占用" },
	{ command: "pnpm run dev", description: "启动前端开发服务器" },
	{ command: "pnpm run build", description: "构建生产包" },
	{ command: "curl -I", description: "仅获取 HTTP 响应头" },
	{ command: "ping -c 4", description: "探测网络连通性 (发送4包)" },
];

const STORAGE_KEY = "termx_command_history";

function loadSavedHistory(): CommandRecord[] {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return [];
		const parsed = JSON.parse(raw);
		if (Array.isArray(parsed)) {
			// 旧版本过滤得不严：载入时把已经混进来的敏感命令清掉，并立即写回
			const clean = (parsed as CommandRecord[]).filter(
				(item) => typeof item?.command === "string" && !isSensitiveCommand(item.command),
			);
			if (clean.length !== parsed.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
			return clean;
		}
	} catch {
		// 忽略读取错误
	}
	return [];
}

function saveHistory(records: CommandRecord[]) {
	try {
		// 最多保存 1000 条高频命令，防止数据膨胀
		const trimmed = records
			.sort((a, b) => b.lastExecuted - a.lastExecuted)
			.slice(0, 1000);
		localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
	} catch {
		// 忽略写入错误
	}
}

/** Frecency 评分公式：时间衰减系数 * 频次 */
function calculateFrecencyScore(record: CommandRecord): number {
	const hoursAgo = (Date.now() - record.lastExecuted) / (1000 * 60 * 60);
	let recencyWeight = 1.0;
	if (hoursAgo < 1) recencyWeight = 5.0; // 1小时内极高权重
	else if (hoursAgo < 24) recencyWeight = 3.0; // 24小时内高权重
	else if (hoursAgo < 168) recencyWeight = 1.8; // 1周内中等权重
	else recencyWeight = 0.8; // 早期命令低权重

	return record.count * recencyWeight;
}

interface CommandsState {
	history: CommandRecord[];
	/** 记录一条刚刚执行完的命令 */
	recordCommand: (command: string, hostId?: string | null) => void;
	/** 清空指定主机或全局历史 */
	clearHistory: (hostId?: string | null) => void;
	/** 获取当前前缀的最佳预测与候选建议列表 */
	querySuggestions: (
		prefix: string,
		hostId?: string | null,
		limit?: number,
	) => CommandSuggestion[];
}

export const useCommandsStore = create<CommandsState>((set, get) => ({
	history: loadSavedHistory(),

	recordCommand: (rawCommand, hostId) => {
		const command = rawCommand.trim();
		// 忽略超短命令、空命令或纯控制字符
		if (!command || command.length < 2) return;
		// 敏感过滤：命令行里带着密码 / token / 凭据的不入历史库
		// （在密码提示符下敲的内容由终端在回车时识别并跳过，根本不会走到这里）
		if (isSensitiveCommand(command)) return;

		set((state) => {
			const now = Date.now();
			const existingIndex = state.history.findIndex(
				(item) => item.command === command && (!item.hostId || !hostId || item.hostId === hostId),
			);

			let updated: CommandRecord[];
			if (existingIndex >= 0) {
				const old = state.history[existingIndex];
				const nextItem: CommandRecord = {
					...old,
					count: old.count + 1,
					lastExecuted: now,
					hostId: hostId ?? old.hostId,
				};
				updated = [
					nextItem,
					...state.history.slice(0, existingIndex),
					...state.history.slice(existingIndex + 1),
				];
			} else {
				const newItem: CommandRecord = {
					id: `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
					command,
					hostId: hostId ?? null,
					count: 1,
					lastExecuted: now,
				};
				updated = [newItem, ...state.history];
			}

			saveHistory(updated);
			return { history: updated };
		});
	},

	clearHistory: (hostId) => {
		set((state) => {
			const filtered = hostId
				? state.history.filter((h) => h.hostId !== hostId)
				: [];
			saveHistory(filtered);
			return { history: filtered };
		});
	},

	querySuggestions: (rawPrefix, hostId, limit = 6) => {
		const prefix = rawPrefix.trimStart();
		if (!prefix) return [];
		const lowerPrefix = prefix.toLowerCase();

		const results: CommandSuggestion[] = [];
		const seenCommands = new Set<string>();

		// 1. 检索用户历史记录（含 Frecency 计算）
		const { history } = get();
		const historyMatches = history
			.filter((item) => {
				const lower = item.command.toLowerCase();
				// 支持前缀匹配以及单词包含匹配
				return lower.startsWith(lowerPrefix) && item.command !== prefix;
			})
			.map((item) => {
				// 主机匹配优先：同主机的历史命中加权
				const hostMultiplier = hostId && item.hostId === hostId ? 2.0 : 1.0;
				const score = calculateFrecencyScore(item) * hostMultiplier;
				return {
					id: item.id,
					command: item.command,
					label: item.command,
					source: "history" as const,
					count: item.count,
					score,
				};
			});

		for (const m of historyMatches) {
			if (!seenCommands.has(m.command)) {
				seenCommands.add(m.command);
				results.push(m);
			}
		}

		// 2. 检索自定义 Snippets 片段库
		const snippets = useSnippetsStore.getState().snippets;
		for (const sn of snippets) {
			const cmd = sn.command.trim();
			const lowerCmd = cmd.toLowerCase();
			const lowerName = sn.name.toLowerCase();
			if (
				(lowerCmd.startsWith(lowerPrefix) || lowerName.includes(lowerPrefix)) &&
				cmd !== prefix &&
				!seenCommands.has(cmd)
			) {
				seenCommands.add(cmd);
				results.push({
					id: `sn-${sn.id}`,
					command: cmd,
					label: sn.name ? `${sn.name} (${cmd})` : cmd,
					description: sn.group ? `片段 · ${sn.group}` : "快捷片段",
					source: "snippet",
					score: 50, // 片段赋予高默认权重
				});
			}
		}

		// 3. 检索预设常用命令
		for (const p of PRESET_COMMANDS) {
			const lower = p.command.toLowerCase();
			if (lower.startsWith(lowerPrefix) && p.command !== prefix && !seenCommands.has(p.command)) {
				seenCommands.add(p.command);
				results.push({
					id: `pre-${p.command}`,
					command: p.command,
					label: p.command,
					description: p.description,
					source: "preset",
					score: 10,
				});
			}
		}

		// 按 Frecency 分数从高到低排序，截取前 N 项
		return results.sort((a, b) => b.score - a.score).slice(0, limit);
	},
}));
