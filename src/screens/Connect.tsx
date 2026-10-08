import { WindowChrome } from "@/components/chrome/WindowChrome";
import { closeSshSession, hasSshSession, newSshSessionKey, openSshSession, type SshOpenResult } from "@/components/terminal/sshCache";
import { Button } from "@/components/ui/Button";
import { Badge, EmptyState, Segmented, StatusDot } from "@/components/ui/Display";
import { Field, Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Overlay";
import { Checkbox } from "@/components/ui/Toggle";
import { AUTH_LABEL, type AuthMethod, type ConnectionStatus } from "@/data/types";
import { cn } from "@/lib/cn";
import { copySensitive } from "@/lib/clipboard";
import { describeProbe, formatMs, probeSupported, type ProbeReport } from "@/lib/probe";
import { secretAvailable, secretDelete, secretLoad, secretSave } from "@/lib/secret";
import {
	listenAuthPrompts,
	sshAgentIdentities,
	sshAuthRespond,
	sshReplaceHostKey,
	sshSupported,
	sshTrustHost,
	stageCredential,
	type AgentIdentity,
	type AuthPromptRequest,
	type Credential,
	type SshPhase,
} from "@/lib/ssh";
import { useHostsStore } from "@/store/hosts";
import { useKeysStore } from "@/store/keys";
import { useProbeStore } from "@/store/probe";
import { useSessionsStore } from "@/store/sessions";
import { useSettingsStore } from "@/store/settings";
import { toast } from "@/store/toast";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";

/* =============================================================================
 * 连接过程（路由 /connect?host=<id>）
 *
 * 只呈现真实结果：
 *  - 点「连接」之前，前两步来自 useProbeStore 对这台主机的实测 TCP 探测
 *    （浏览器内没有探测能力，如实标注「需桌面端」）。
 *  - 点「连接」之后，五步全部由 Rust 端推送的真实 SSH 阶段驱动：
 *    resolve → tcp → handshake → auth → shell，失败时收到 failed + 中文原因。
 *  - known_hosts 校验已由 Rust 侧接管：首次连接这台主机会**拒绝**握手并要求用户核对
 *    指纹（kind = host_unknown），指纹与已保存记录不一致会**拒绝并告警**（kind = host_changed）。
 *    本页负责把这两种情况引导成「确认并继续」或「取消」，绝不静默放行。
 *  - 指纹一律取 Rust 事件的真实值（phase.fingerprint / 结果里的 fingerprint），
 *    界面不预填、不推测、不补造。
 *  - 认证方式五种都已接入：密码、私钥、私钥 + 口令、SSH Agent、键盘交互（二次验证）。
 *    默认按主机登记的 auth.method 渲染，也允许在本页临时切换（否则主机配错就把人锁死了）。
 *    键盘交互的提问由 ssh://auth-prompt/{key} 事件驱动，服务器连着问几轮就弹几轮。
 *
 * 凭据默认只活在内存里：用来建立会话，不进主机库、不写配置文件，应用退出即消失。
 * 只有密码方式下、用户明确勾选「记住密码（存入系统钥匙串）」时，才额外交给操作系统钥匙串；
 * 私钥口令始终只在内存里，连钥匙串都不进。
 * ========================================================================== */

/** 步骤状态：五步全部由真实阶段驱动，没有「尚未接入」这种中间态了 */
type StepState = "done" | "failed" | "active" | "pending";

interface Step {
	id: string;
	label: string;
	state: StepState;
	detail: string;
}

/** 与 Rust 端 emit_phase 的 phase 名一一对应，顺序就是步骤条的顺序 */
const SSH_STAGES = ["resolve", "tcp", "handshake", "auth", "shell"] as const;
type SshStage = (typeof SSH_STAGES)[number];

const STAGE_LABEL: Record<SshStage, string> = {
	resolve: "解析地址",
	tcp: "建立 TCP 连接",
	handshake: "SSH 握手",
	auth: "认证",
	shell: "打开终端",
};

/** 会话在进入本页之前就已建立时，各步没有过程记录，只能如实说「已完成」 */
const ESTABLISHED_DETAIL: Record<SshStage, string> = {
	resolve: "已确认",
	tcp: "已连接",
	handshake: "握手已完成",
	auth: "认证已完成",
	shell: "终端已就绪",
};

/** 单个阶段收到的真实结果 */
interface StageResult {
	ok: boolean;
	detail: string;
	/** Rust 事件里直接带的指纹；有就不必从 detail 文本里解析 */
	fingerprint: string | null;
}

interface SshProgress {
	/** 用户在本页点过「连接」：从这一刻起步骤条交给真实事件 */
	started: boolean;
	connecting: boolean;
	connected: boolean;
	/** phase 名 → 真实结果（含 failed 这一伪阶段） */
	stages: Record<string, StageResult>;
	/** 失败落在哪一步，由已收到的阶段推导 */
	failedStage: SshStage | null;
	failure: string | null;
}

const EMPTY_PROGRESS: SshProgress = {
	started: false,
	connecting: false,
	connected: false,
	stages: {},
	failedStage: null,
	failure: null,
};

/** 认证方式在本页可临时切换：主机登记错了不至于把人锁死在一种方式上 */
const AUTH_CHOICES: { value: AuthMethod; label: string }[] = [
	{ value: "password", label: "密码" },
	{ value: "key", label: "私钥" },
	{ value: "key-passphrase", label: "私钥+口令" },
	{ value: "agent", label: "Agent" },
	{ value: "keyboard-interactive", label: "键盘交互" },
];

/**
 * 主机密钥需要用户决策的两种情况：
 *  - host_unknown：首次连接这台主机，Rust 已拒绝握手，等用户核对指纹；
 *  - host_changed：指纹与已保存记录不一致，Rust 已拒绝并告警。
 * detail 一律用 Rust 给的中文说明，界面不自己编原因。
 */
interface HostAlert {
	kind: "host_unknown" | "host_changed";
	/** 本次握手返回的真实指纹（SHA256:…）；Rust 没给就是 null，界面如实说没有 */
	fingerprint: string | null;
	detail: string;
	/** 确认弹窗 / 告警操作区是否还开着；用户取消后置 false，但告警本身留在页面上 */
	open: boolean;
}

export default function Connect() {
	const navigate = useNavigate();
	const [params] = useSearchParams();
	const hostId = params.get("host");
	const hosts = useHostsStore((s) => s.hosts);
	const host = hosts.find((h) => h.id === hostId) ?? null;

	const probeResults = useProbeStore((s) => s.results);
	const probing = useProbeStore((s) => s.probing);
	const runProbe = useProbeStore((s) => s.run);

	/** 真实 SSH 进度：全部来自 Rust 端事件，退出即消失 */
	const [progress, setProgress] = useState<SshProgress>(EMPTY_PROGRESS);
	/** 密码只在内存里活到本次连接结束，绝不写进任何 store 或配置文件 */
	const [password, setPassword] = useState("");
	/** 本页临时选用的认证方式；null = 跟主机登记的一致（进页面时的默认） */
	const [methodOverride, setMethodOverride] = useState<AuthMethod | null>(null);
	/** 私钥文件路径：用户在文件选择器里选的，或手动粘贴的；只进 credential，不写配置文件 */
	const [keyPath, setKeyPath] = useState("");
	/** 私钥口令：只在内存里，连系统钥匙串都不进 */
	const [passphrase, setPassphrase] = useState("");
	/** SSH Agent 里的身份：null = 还没读到（读不到就是 null + agentError） */
	const [agentIdentities, setAgentIdentities] = useState<AgentIdentity[] | null>(null);
	const [agentLoading, setAgentLoading] = useState(false);
	const [agentError, setAgentError] = useState<string | null>(null);
	/** 每次点「重新读取」自增，用来重新枚举 Agent 身份 */
	const [agentTicket, setAgentTicket] = useState(0);
	/** 服务器当前这一轮的键盘交互提问；null = 没有在等用户作答 */
	const [authPrompt, setAuthPrompt] = useState<AuthPromptRequest | null>(null);
	/** 与 authPrompt.prompts 顺序一一对应的作答 */
	const [answers, setAnswers] = useState<string[]>([]);
	/** 正在把这一轮作答交给后端 */
	const [responding, setResponding] = useState(false);
	/** 这一轮已经提交，等服务器下一步（可能再问一轮，也可能直接建立会话） */
	const [promptSubmitted, setPromptSubmitted] = useState(false);
	/** 提交失败的真实原因 */
	const [promptError, setPromptError] = useState<string | null>(null);
	/** 桌面端探测本身失败（Rust 端没返回结果）：既不是可达也不是不可达，如实标出来 */
	const [probeError, setProbeError] = useState<string | null>(null);
	/** 主机密钥需要用户决策时的告警（首次连接确认 / 指纹变化） */
	const [alert, setAlert] = useState<HostAlert | null>(null);
	/** 正在把确认结果写回 known_hosts（信任或替换），期间按钮禁用，防重复提交 */
	const [trusting, setTrusting] = useState(false);
	/** known_hosts 写回失败的真实原因 */
	const [trustError, setTrustError] = useState<string | null>(null);
	/** 记住密码：默认不勾选，只有用户自己勾了才写钥匙串（需求书 07）；只对密码方式有效 */
	const [remember, setRemember] = useState(false);
	/** 系统钥匙串是否可用；null = 还没问出来，先不吓唬用户 */
	const [secretUsable, setSecretUsable] = useState<boolean | null>(null);
	/** 钥匙串里当前是否存着这台主机的密码（决定要不要给「删除已保存的密码」入口） */
	const [hasSavedSecret, setHasSavedSecret] = useState(false);
	/** 本次进页面时从钥匙串读到了密码：给一行提示，没保存过的用户不被打扰 */
	const [loadedFromKeychain, setLoadedFromKeychain] = useState(false);

	const supported = probeSupported();
	const sshReady = sshSupported();
	const report: ProbeReport | undefined = host ? probeResults[host.id] : undefined;
	const isProbing = host ? probing.includes(host.id) : false;
	/** 主机登记的认证方式；本页没手动切换时就用它 */
	const hostMethod: AuthMethod = host?.auth.method ?? "password";
	const authMethod: AuthMethod = methodOverride ?? hostMethod;
	/**
	 * 本次连接的会话键：**每次进入本页都生成一个新的**。
	 *
	 * 本页的语义就是「现在发起一次连接」，所以这里不该复用别的会话：
	 * 复用了就退回「一台主机只能有一条连接」。同一台主机想再开一条，
	 * 从主机库再走一次连接页即可，两条会话各有各的键、互不影响。
	 * 换主机（路由参数变了但组件没重挂载）时重新生成。
	 */
	const [sessionKey, setSessionKey] = useState(() => (hostId ? newSshSessionKey(hostId) : ""));
	const keyHostRef = useRef(hostId);
	useEffect(() => {
		if (keyHostRef.current === hostId) return;
		keyHostRef.current = hostId;
		setSessionKey(hostId ? newSshSessionKey(hostId) : "");
	}, [hostId]);
	/** 主机登记的那把密钥（密钥库只存公钥元数据，没有文件路径，所以仍要用户指定文件） */
	const registeredKey = useKeysStore((s) => (host?.auth.keyId ? s.keys.find((k) => k.id === host.auth.keyId) : undefined));

	// 从主机配置与系统钥匙串预填凭据
	const storedHostId = host?.id ?? null;
	useEffect(() => {
		if (host?.auth.password) {
			setPassword(host.auth.password);
			setRemember(true);
			setHasSavedSecret(true);
		}
		if (host?.auth.keyPath) {
			setKeyPath(host.auth.keyPath);
		}

		let alive = true;
		if (!storedHostId) return;
		void (async () => {
			const available = await secretAvailable();
			if (!alive) return;
			setSecretUsable(available);
			if (!available) return;
			const saved = await secretLoad(storedHostId);
			if (!alive || !saved) return;
			setPassword(saved);
			setRemember(true);
			setHasSavedSecret(true);
			setLoadedFromKeychain(true);
		})();
		return () => {
			alive = false;
		};
	}, [storedHostId, host]);

	// 换主机（只是路由参数变了、组件没重挂载）时，回到这台主机登记的认证方式
	useEffect(() => {
		setMethodOverride(null);
	}, [hostId]);

	// 键盘交互：服务器在认证阶段随时可能提问，监听要在发起连接之前就挂上，否则第一轮提问会丢。
	// 事件不经过 sshCache 的会话缓冲，这里单独订阅一条。
	useEffect(() => {
		if (!sessionKey || !sshReady) return;
		let alive = true;
		let unlisten: (() => void) | null = null;
		void listenAuthPrompts(sessionKey, (payload) => {
			// 服务器可以连着问好几轮：每来一轮就换一组输入框，上一轮的回答按顺序提交完就作废
			setAuthPrompt(payload);
			setAnswers(payload.prompts.map(() => ""));
			setPromptSubmitted(false);
			setPromptError(null);
		})
			.then((off) => {
				if (alive) unlisten = off;
				else off();
			})
			.catch(() => {
				/* 订阅不上不编造提问：真实提问一定会再走事件，界面不假装 */
			});
		return () => {
			alive = false;
			unlisten?.();
		};
	}, [sessionKey, sshReady]);

	// 会话已经建立、或者已经失败：这一轮问答窗口就该收起（不作答了，也不继续等）
	const promptFinished = progress.connected || progress.failure !== null;
	useEffect(() => {
		if (!authPrompt || !promptFinished) return;
		setAuthPrompt(null);
		setAnswers([]);
		setPromptSubmitted(false);
		setPromptError(null);
	}, [authPrompt, promptFinished]);

	// 自检/深链用：带 ?autoconnect=1 进入时直接发起连接。
	// 只对「不需要先输入东西」的方式自动触发（Agent / 键盘交互）；
	// 密码与私钥必须由人来填，绝不自动连。
	useEffect(() => {
		if (params.get("autoconnect") !== "1") return;
		if (authMethod !== "agent" && authMethod !== "keyboard-interactive") return;
		if (!sshReady) return;
		const timer = window.setTimeout(() => void startConnect(), 900);
		return () => window.clearTimeout(timer);
		// 有意只在挂载时触发一次
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 选中 SSH Agent 时枚举一次身份：一条都没有要如实说出来，别让用户白点连接
	useEffect(() => {
		if (authMethod !== "agent" || !sshReady) return;
		let alive = true;
		setAgentLoading(true);
		setAgentError(null);
		void sshAgentIdentities()
			.then((list) => {
				if (!alive) return;
				setAgentIdentities(list);
			})
			.catch((error) => {
				if (!alive) return;
				setAgentIdentities(null);
				setAgentError(messageOf(error));
			})
			.finally(() => {
				if (alive) setAgentLoading(false);
			});
		return () => {
			alive = false;
		};
	}, [authMethod, sshReady, agentTicket]);

	if (!host) {
		return (
			<WindowChrome>
				<div className="flex min-h-0 flex-1 flex-col">
					<EmptyState
						icon="icon-[lucide--server-off]"
						title={hostId ? "找不到这台主机" : "没有指定要连接的主机"}
						description={hostId ? `主机库里没有 id 为 ${hostId} 的主机。` : undefined}
						action={
							<Button
								size="sm"
								variant="primary"
								icon="icon-[lucide--server]"
								onClick={() => {
									useSessionsStore.getState().setActiveTab("vaults");
									navigate("/workspace");
								}}
							>
								去主机库
							</Button>
						}
					/>
				</div>
			</WindowChrome>
		);
	}

	// 本页之前就已建立、且还活着的会话（从工作区点回连接页时会走到这里）
	const alreadyConnected = hasSshSession(sessionKey);
	const base: SshProgress = alreadyConnected && !progress.connected ? { ...progress, connected: true } : progress;
	// 主机密钥被拦下时，Rust 紧接着还会补发一条笼统的 failed；展示上只用带 kind 的那条说明，
	// 并把失败阶段钉在「SSH 握手」—— 密钥校验本来就发生在握手阶段，不是 TCP 那一步。
	const ssh: SshProgress =
		alert && !base.connected ? { ...base, failure: alert.detail, failedStage: "handshake" } : base;

	const connecting = ssh.connecting;
	const connected = ssh.connected;
	/** 真实指纹：优先用 Rust 事件里直接带的 fingerprint，其次从握手 detail 里取；都没有就不显示 */
	const fingerprint = progress.stages.handshake?.fingerprint || fingerprintOf(progress.stages.handshake?.detail);

	/** 当前认证方式还差什么才能发起连接；null = 齐了。桌面端不可用另有提示，不算在这里 */
	const credentialProblem: string | null =
		authMethod === "password"
			? password
				? null
				: "请先输入登录密码"
			: authMethod === "key" || authMethod === "key-passphrase"
				? keyPath.trim()
					? null
					: "请先选择或粘贴私钥文件路径"
				: authMethod === "agent" && agentIdentities !== null && agentIdentities.length === 0
					? "SSH Agent 里没有可用身份：请先 ssh-add 添加私钥"
					: null;

	const steps = buildSteps(report, supported, isProbing, probeError, ssh, alert !== null, authMethod);
	const conclusion = summarize(report, supported, isProbing, probeError, ssh, alert);
	const tabStatus: ConnectionStatus = connected
		? "connected"
		: connecting
			? "connecting"
			: ssh.failure
				? "failed"
				: report
					? report.reachable
						? "connected"
						: "failed"
					: probeError
						? "failed"
						: "connecting";
	const tabLabel = connected
		? "SSH 已连接"
		: connecting
			? "SSH 连接中…"
			: // 主机密钥被拦下不是「连接失败」这么简单：要么等你确认指纹，要么是危险的指纹变化
				alert
				? alert.kind === "host_unknown"
					? alert.open
						? "等待确认指纹"
						: "指纹未确认"
					: "指纹变化，已拒绝"
				: ssh.failure
					? "SSH 连接失败"
					: report
						? report.reachable
							? "TCP 已确认"
							: "TCP 不可达"
						: probeError
							? "探测失败"
							: isProbing
								? "探测中…"
								: "未探测";

	const copy = (text: string, title: string) => {
		void navigator.clipboard
			?.writeText(text)
			.then(() => toast({ title, tone: "success" }))
			.catch(() => toast({ title: "复制失败，请手动选择文本", tone: "warning" }));
	};

	/** 复制登录密码：敏感内容，按设置页的偏好在 30 秒后自动清空剪贴板 */
	const copyPassword = async () => {
		if (!password) return;
		const autoClear = useSettingsStore.getState().clearClipboard;
		const ok = await copySensitive(password, () => toast({ title: "剪贴板已清空", tone: "default" }));
		toast(
			ok
				? { title: "密码已复制", description: autoClear ? "30 秒后自动清空剪贴板" : undefined, tone: "success" }
				: { title: "复制失败，请手动选择文本", tone: "warning" },
		);
	};

	const probeNow = async () => {
		if (!supported) {
			toast({ title: "浏览器内无法探测", description: "TCP 可达性由 Rust 端探测，请用 pnpm tauri:dev 启动桌面端", tone: "warning" });
			return;
		}
		const summary = await runProbe([{ id: host.id, host: host.hostname, port: host.port }]);
		if (!summary) {
			setProbeError("探测未能完成：Rust 端没有返回结果");
			toast({ title: "探测没有返回结果", description: "请稍后重试", tone: "danger" });
			return;
		}
		setProbeError(null);
		toast({
			title: summary.ok > 0 ? "TCP 可达" : "TCP 不可达",
			tone: summary.ok > 0 ? "success" : "danger",
		});
	};

	/** 会话标签 + 进入工作区：工作区的终端会自己挂到这条 SSH 会话上 */
	const enterWorkspace = () => {
		const store = useSessionsStore.getState();
		// 已经是同一个会话键的标签就聚焦它，别再开一个一模一样的格子；
		// 真正要开第二条连接得生成新的键（本页每次进入就是一个新键）。
		const existing = store.tabs.find((t) => t.sessionKey === sessionKey);
		const tabId = existing ? existing.id : store.openSession(host.id, sessionKey);
		useSessionsStore.getState().setActiveTab(tabId);
		// 走到这里说明 shell 已经起来了，标签与分屏格的状态要跟着变成「已连接」，
		// 否则状态栏与标签会一直停在「连接中」。
		useSessionsStore.getState().setStatus(tabId, "connected");
		navigate("/workspace");
	};

	/**
	 * 连接成功之后才处理「记住密码」：勾了就写钥匙串，没勾而钥匙串里有旧密码就删掉。
	 * 这里出错只提示，绝不影响已经建立的会话，也不改「连接成功」这个事实。
	 * 只对密码方式调用：用 Agent / 私钥连上时不该去动钥匙串里那点密码。
	 */
	const persistSecret = async () => {
		if (remember && secretUsable === false) {
			toast({
				title: "系统钥匙串不可用，密码没有保存",
				description: "密码仍只在本次会话的内存里，连接不受影响",
				tone: "warning",
			});
			return;
		}
		if (remember) {
			try {
				await secretSave(host.id, password);
				setHasSavedSecret(true);
				setLoadedFromKeychain(false);
				toast({ title: "密码已存入系统钥匙串", description: `${host.name} 的登录密码已交给操作系统保管`, tone: "success" });
			} catch (error) {
				toast({ title: "密码未能存入系统钥匙串", description: messageOf(error), tone: "danger" });
			}
			return;
		}
		// 没勾选，但钥匙串里还有旧密码：如实删掉，别让「不记住」变成一句空话
		if (!hasSavedSecret) return;
		try {
			await secretDelete(host.id);
			setHasSavedSecret(false);
			setLoadedFromKeychain(false);
			toast({ title: "已删除保存的密码", description: `${host.name} 在系统钥匙串里不再有密码`, tone: "default" });
		} catch (error) {
			toast({ title: "删除已保存的密码失败", description: messageOf(error), tone: "danger" });
		}
	};

	/** 按界面上的选择拼出凭据；私钥路径与口令都只在内存里过一手 */
	const buildCredential = (): Credential => {
		switch (authMethod) {
			case "key":
			case "key-passphrase":
				return {
					method: "private_key",
					path: keyPath.trim(),
					// 没填口令就是「这把私钥没有口令」：key 方式下不显示口令框，一律 null
					passphrase: authMethod === "key-passphrase" && passphrase ? passphrase : null,
				};
			case "agent":
				return { method: "agent" };
			case "keyboard-interactive":
				return { method: "keyboard_interactive" };
			default:
				return { method: "password", password };
		}
	};

	/** 主按钮：发起真实连接。凭据只在这次调用里用一次。 */
	const startConnect = async () => {
		if (connecting) return;
		if (!sshReady) {
			toast({
				title: "SSH 需要在桌面端运行",
				description: "浏览器预览里没有原生 SSH 通道，请用 pnpm tauri:dev 启动桌面端",
				tone: "warning",
			});
			return;
		}
		if (credentialProblem) {
			toast({ title: credentialProblem, tone: "warning" });
			return;
		}

		setAlert(null);
		setTrustError(null);
		setProgress({ ...EMPTY_PROGRESS, started: true, connecting: true });

		let result: SshOpenResult;
		try {
			// sshCache.openSshSession 的入参固定是 password（那个文件不在本次写入范围），
			// 所以真正的凭据先按会话键寄存在 ssh.ts，再由 sshConnect 取走 —— 五种方式走同一条路。
			stageCredential(sessionKey, buildCredential());
			result = await openSshSession(
				sessionKey,
				{
					host: host.hostname,
					port: host.port,
					username: host.username,
					// 密码方式顺手带上；其他方式这个字段没人会用（寄存的凭据优先）
					password: authMethod === "password" ? password : "",
					cols: 80,
					rows: 24,
				},
				(phase: SshPhase) => setProgress((prev) => applyPhase(prev, phase)),
			);
		} catch (error) {
			// 例如原生通道不可用：如实报出，不伪造阶段
			result = { ok: false, error: messageOf(error) };
		}

		setProgress((prev) => ({
			...prev,
			connecting: false,
			connected: result.ok,
			failure: result.ok ? prev.failure : (result.error ?? prev.failure ?? "连接失败"),
		}));

		if (!result.ok) {
			const kind = result.kind;
			// 主机密钥没过校验：这不是普通失败，要引导用户去确认或处理指纹，而不是弹个「连接失败」了事
			if (kind === "host_unknown" || kind === "host_changed") {
				setAlert({
					kind,
					fingerprint: result.fingerprint ?? null,
					detail:
						result.error ??
						(kind === "host_unknown"
							? "首次连接这台主机，需要你确认服务器指纹"
							: "主机指纹与已保存的记录不一致，已拒绝连接"),
					open: true,
				});
				return;
			}
			toast({ title: "SSH 连接失败", description: result.error ?? "请查看失败原因", tone: "danger" });
			return;
		}

		// 会话已经建立：同步持久化密码与主机配置，再进工作区
		if (authMethod === "password") await persistSecret();
		useHostsStore.getState().upsertHost({
			...host,
			lastConnectedAt: new Date().toISOString(),
			auth: {
				...host.auth,
				method: authMethod,
				rememberPassword: authMethod === "password" ? remember : host.auth.rememberPassword,
				password: authMethod === "password" && remember ? password : (authMethod === "password" && !remember ? undefined : host.auth.password),
				keyPath: (authMethod === "key" || authMethod === "key-passphrase") ? (keyPath || host.auth.keyPath) : host.auth.keyPath,
			},
		});
		toast({
			title: "SSH 会话已建立",
			description: `${host.username}@${host.hostname}:${host.port} · ${AUTH_LABEL[authMethod]}`,
			tone: "success",
		});
		enterWorkspace();
	};

	/** 选私钥文件：路径只进内存里的 credential，不写配置文件、也不写钥匙串 */
	const chooseKeyFile = async () => {
		try {
			const picked = await open({ multiple: false, directory: false, title: "选择私钥文件" });
			if (picked) setKeyPath(picked);
			// 返回 null = 用户取消，什么都不做也不提示
		} catch (error) {
			toast({ title: "没能打开文件选择器", description: messageOf(error), tone: "danger" });
		}
	};

	/** 提交这一轮键盘交互的回答：顺序必须与服务器给的 prompts 一致 */
	const submitAuthPrompt = async () => {
		if (!authPrompt || responding) return;
		setResponding(true);
		setPromptError(null);
		try {
			// 按 prompts 的顺序逐个取值；空着的就是空串，不替用户补内容
			await sshAuthRespond(
				sessionKey,
				authPrompt.prompts.map((_, index) => answers[index] ?? ""),
			);
			// 不关窗：服务器可能紧接着再问一轮（新事件会替换掉这一轮），
			// 也可能直接进 shell —— 那时由 promptFinished 把窗口收掉。
			setPromptSubmitted(true);
		} catch (error) {
			setPromptError(messageOf(error));
		} finally {
			setResponding(false);
		}
	};

	/** 取消键盘交互：真的把这条连接断掉，并如实说明「已取消认证」 */
	const cancelAuthPrompt = async () => {
		setAuthPrompt(null);
		setAnswers([]);
		setPromptSubmitted(false);
		setPromptError(null);
		setProgress({ ...EMPTY_PROGRESS });
		await closeSshSession(sessionKey);
		toast({
			title: "已取消认证",
			description: "已断开这次 SSH 连接；没有把任何回答发给服务器",
			tone: "default",
		});
	};

	/** 首次连接确认指纹：把待确认的密钥写进 known_hosts，然后自动重连 */
	const trustAndRetry = async () => {
		if (trusting) return;
		setTrusting(true);
		setTrustError(null);
		try {
			const written = await sshTrustHost(host.hostname, host.port);
			setTrusting(false);
			setAlert(null);
			toast({ title: "已信任这台主机的指纹，正在重新连接", description: written, tone: "success" });
			await startConnect();
		} catch (error) {
			// 例如 Rust 报「没有待确认的主机密钥，请重新发起连接」：如实显示，不假装记下了
			setTrustError(messageOf(error));
			setTrusting(false);
		}
	};

	/** 指纹变化、且用户人工核对后决定替换旧记录：危险操作，只由用户显式点击触发 */
	const replaceHostKeyAndRetry = async () => {
		if (trusting) return;
		setTrusting(true);
		setTrustError(null);
		try {
			const note = await sshReplaceHostKey(host.hostname, host.port);
			setTrusting(false);
			setAlert(null);
			toast({ title: "已替换保存的主机指纹，正在重新连接", description: note, tone: "warning" });
			await startConnect();
		} catch (error) {
			setTrustError(messageOf(error));
			setTrusting(false);
		}
	};

	/** 关闭确认弹窗 / 收起告警操作区：连接保持中止，known_hosts 一个字节都不改 */
	const dismissAlert = () => {
		setAlert((current) => (current ? { ...current, open: false } : current));
		setTrustError(null);
	};

	/** 小入口：用户主动删掉钥匙串里保存的密码 */
	const forgetSavedSecret = async () => {
		try {
			await secretDelete(host.id);
			setHasSavedSecret(false);
			setLoadedFromKeychain(false);
			setRemember(false);
			toast({ title: "已删除保存的密码", description: `${host.name} 在系统钥匙串里不再有密码`, tone: "default" });
		} catch (error) {
			toast({ title: "删除已保存的密码失败", description: messageOf(error), tone: "danger" });
		}
	};

	const disconnect = async () => {
		setProgress({ ...EMPTY_PROGRESS });
		setAlert(null);
		setTrustError(null);
		setPassword("");
		setPassphrase("");
		setAuthPrompt(null);
		setAnswers([]);
		setPromptSubmitted(false);
		setPromptError(null);
		await closeSshSession(sessionKey);
		toast({ title: "已断开 SSH 会话", description: `${host.username}@${host.hostname}`, tone: "default" });
	};

	return (
		<WindowChrome>
			<div className="flex min-h-0 flex-1 flex-col bg-surface">
				{/* 顶置标签：进度显示在标签内部，不弹窗（需求书 07）。
				    底色与工作区的活动标签一致（应用表面色），不用终端画布色 —— 标签是外壳 */}
				<div className="flex h-8.5 shrink-0 items-end border-b border-border bg-surface-sunk px-2">
					<div className="flex h-7.5 items-center gap-2 rounded-t border-t border-x border-border bg-surface-raised px-3 text-[12px] text-surface-foreground">
						<StatusDot status={tabStatus} size={6} />
						<span className="font-mono">{host.name}</span>
						<span
							className={cn(
								"text-[10px]",
								tabStatus === "failed" ? "text-danger" : tabStatus === "connected" ? "text-success" : "text-faint",
							)}
						>
							{tabLabel}
						</span>
					</div>
				</div>

				{/* 终端背景 + 居中连接面板 */}
				<div className="relative min-h-0 flex-1 overflow-hidden bg-term">
					<div className="p-4 font-mono text-[12px] text-faint">
						<div>TermX 连接过程 · {host.name}</div>
						<div className="text-muted">
							目标 {host.hostname}:{host.port} · 用户 {host.username} · 认证方式 {AUTH_LABEL[authMethod]}
							{methodOverride && methodOverride !== hostMethod
								? `（主机登记的是${AUTH_LABEL[hostMethod]}，本次临时改用）`
								: ""}
						</div>
						<div className="text-muted">
							{connected
								? "SSH 会话已建立，远端输出在工作区终端里回放"
								: connecting
									? `正在连接：${SSH_STAGES.join(" → ")}`
									: report
										? describeProbe(report)
										: !supported
											? "浏览器内无法探测 TCP，请用桌面端运行"
											: (probeError ?? (isProbing ? "正在探测 TCP 可达性…" : "等待发起连接"))}
						</div>
						{!connected && ssh.failure && <div className="text-danger">SSH：{ssh.failure}</div>}
						{!connecting && report && !report.reachable && (
							<div className="text-danger">TCP 不可达：{report.error ?? "目标端口无响应"}</div>
						)}
					</div>

					<div className="absolute inset-0 flex items-center justify-center bg-term/80 p-4 backdrop-blur-sm">
						<div className="max-h-full w-[420px] overflow-y-auto rounded-card border border-border bg-surface-raised p-5 shadow-2xl">
							<div className="flex items-center justify-between border-b border-border pb-3">
								<div className="flex items-center gap-2">
									<span className="icon-[lucide--server] size-4 text-primary" />
									<h1 className="text-[13px] font-semibold tracking-tight text-surface-foreground">连接 {host.name}</h1>
								</div>
								<span className="font-mono text-[10.5px] text-faint">端口 {host.port}</span>
							</div>

							{/* 分步进度：五步全部由真实结果驱动 */}
							<div className="mt-3.5 space-y-2">
								{steps.map((s) => (
									<div key={s.id} className="flex items-center justify-between gap-3 text-[12px]">
										<div className="flex min-w-0 items-center gap-2">
											<StepMark state={s.state} />
											<span
												className={cn(
													"truncate",
													s.state === "failed"
														? "font-medium text-danger"
														: s.state === "active"
															? "font-medium text-surface-foreground"
															: s.state === "pending"
																? "text-faint"
																: "text-muted",
												)}
											>
												{s.label}
											</span>
										</div>
										<span
											title={s.detail}
											className={cn(
												"max-w-[52%] shrink-0 truncate font-mono text-[11px]",
												s.state === "failed" ? "text-danger" : s.state === "pending" ? "text-faint" : "text-muted",
											)}
										>
											{s.detail}
										</span>
									</div>
								))}
							</div>

							{/* 结论：TCP 可达 ≠ SSH 可用；连上以后一律以真实阶段为准 */}
							<div className={cn("mt-4 rounded-control border p-3", conclusion.tone)}>
								<div className="flex items-center gap-2">
									<span className={cn("size-3.5 shrink-0", conclusion.icon)} />
									<span className="text-[12px] font-medium text-surface-foreground">{conclusion.headline}</span>
								</div>
								{conclusion.body && <p className="mt-1.5 text-[11px] leading-4 text-muted">{conclusion.body}</p>}
								<div className="mt-2.5 flex items-center gap-1.5">
									<Button
										size="sm"
										icon="icon-[lucide--gauge]"
										disabled={isProbing || connecting}
										onClick={() => void probeNow()}
									>
										{isProbing ? "正在探测…" : "重新探测 TCP"}
									</Button>
									<Button size="sm" icon="icon-[lucide--pencil]" disabled={connecting} onClick={() => navigate(`/hosts/${host.id}/edit`)}>
										编辑主机
									</Button>
								</div>
							</div>

							{/* 首次连接确认被取消：指纹没被确认，连接保持中止 */}
							{alert?.kind === "host_unknown" && !alert.open && (
								<div className="mt-4 rounded-control border border-warning/40 bg-warning/10 p-3">
									<div className="flex items-center gap-2">
										<span className="icon-[lucide--fingerprint] size-3.5 shrink-0 text-warning" />
										<span className="text-[11.5px] font-medium text-surface-foreground">首次连接未确认指纹，连接已中止</span>
									</div>
									<p className="mt-1.5 text-[11px] leading-4 text-muted">
										主机密钥未被信任，握手已被拒绝。
									</p>
									<FingerprintBlock value={alert.fingerprint} className="mt-2.5" />
									<div className="mt-2.5 flex items-center gap-1.5">
										<Button
											size="sm"
											variant="primary"
											icon="icon-[lucide--fingerprint]"
											disabled={connecting || !sshReady}
											onClick={() => setAlert({ ...alert, open: true })}
										>
											重新核对指纹
										</Button>
									</div>
									{trustError && <p className="mt-2 text-[10.5px] leading-4 text-danger">{trustError}</p>}
								</div>
							)}

							{/* 指纹变化：Rust 已拒绝连接，这里只负责把风险和两条出路讲清楚 */}
							{alert?.kind === "host_changed" && (
								<div className="mt-4 rounded-control border border-danger/50 bg-danger/10 p-3">
									<div className="flex items-start gap-2">
										<span className="icon-[lucide--shield-alert] mt-px size-4 shrink-0 text-danger" />
										<div className="min-w-0 flex-1">
											<div className="text-[12px] font-semibold text-danger">主机指纹变化警告 · 连接已被拒绝</div>
											<p className="mt-1.5 text-[11px] leading-4 text-muted">
												指纹与已保存的记录不一致，可能是服务器重装，也可能是中间人攻击。
											</p>
											<FingerprintBlock
												value={alert.fingerprint}
												label="本次握手返回的指纹（与已保存的记录不一致）"
												className="mt-2.5"
											/>
											{alert.detail && (
												<div className="selectable mt-2 rounded border border-border bg-term px-2 py-1.5 font-mono text-[10.5px] leading-4 break-all text-term-ink">
													{alert.detail}
												</div>
											)}
											{trustError && <p className="mt-2 text-[10.5px] leading-4 text-danger">{trustError}</p>}
											{alert.open ? (
												<div className="mt-2.5 flex flex-wrap items-center gap-1.5">
													{/* 默认出路：不替换、不连接。危险操作放在最右侧，拉开距离，避免误点 */}
													<Button size="sm" variant="primary" icon="icon-[lucide--x]" disabled={trusting} onClick={dismissAlert}>
														取消连接
													</Button>
													<span className="min-w-4 flex-1" />
													<Button
														size="sm"
														variant="danger"
														icon="icon-[lucide--triangle-alert]"
														disabled={trusting || !sshReady}
														onClick={() => void replaceHostKeyAndRetry()}
													>
														{trusting ? "正在替换…" : "我已人工核对，替换已保存的指纹"}
													</Button>
												</div>
											) : (
												<div className="mt-2.5 flex items-center gap-1.5">
													<span className="text-[10.5px] leading-4 text-faint">
														已取消这次连接，known_hosts 未改动。
													</span>
													<Button size="sm" icon="icon-[lucide--rotate-cw]" onClick={() => setAlert({ ...alert, open: true })}>
														重新查看
													</Button>
												</div>
											)}
										</div>
									</div>
								</div>
							)}

							{/* 认证：五种方式（密码 / 私钥 / 私钥+口令 / SSH Agent / 键盘交互）都由 Rust 侧真实实现 */}
							{!connected && (
								<div className="mt-4 rounded-control border border-border bg-surface p-3">
									{/* 认证方式：默认按主机登记的那一种，也允许在本页临时切换，免得主机配错就把人锁死 */}
									<div className="flex items-center justify-between gap-2">
										<span className="text-[11px] font-medium text-muted">认证方式</span>
										<Badge className="font-mono text-[9.5px]">
											{methodOverride && methodOverride !== hostMethod
												? `本页临时切换 · ${AUTH_LABEL[authMethod]}`
												: `主机配置 · ${AUTH_LABEL[hostMethod]}`}
										</Badge>
									</div>
									<Segmented value={authMethod} onChange={setMethodOverride} options={AUTH_CHOICES} className="mt-2 w-full" />
									{methodOverride && methodOverride !== hostMethod && (
										<p className="mt-1.5 text-[10.5px] leading-4 text-warning">
											这台主机登记的是「{AUTH_LABEL[hostMethod]}」，本次连接改用「{AUTH_LABEL[authMethod]}」。
										</p>
									)}

									{/* ① 密码 */}
									{authMethod === "password" && (
										<div className="mt-3">
											<div className="flex items-center justify-between">
												<label htmlFor="ssh-password" className="text-[11px] font-medium text-muted">
													输入 {host.username}@{host.hostname} 的登录密码
												</label>
												<Badge className="font-mono text-[9.5px]">
													{remember ? "将存入钥匙串" : "只存内存"}
												</Badge>
											</div>
											<Input
												id="ssh-password"
												type="password"
												value={password}
												disabled={connecting}
												autoComplete="off"
												autoFocus
												placeholder={connecting ? "正在认证…" : "SSH 登录密码"}
												onChange={(e) => setPassword(e.target.value)}
												onKeyDown={(e) => {
													if (e.key === "Enter") void startConnect();
												}}
												className="mt-2 font-mono"
											/>
											<div className="mt-1.5 flex items-center justify-end">
												<Button
													size="sm"
													variant="ghost"
													icon="icon-[lucide--copy]"
													disabled={password === ""}
													onClick={() => void copyPassword()}
												>
													复制密码
												</Button>
											</div>
											{/* 从钥匙串读到了才提示，没保存过的用户不被打扰 */}
											{loadedFromKeychain && (
												<p className="mt-1.5 flex items-start gap-1.5 text-[10.5px] leading-4 text-success">
													<span className="icon-[lucide--key-round] mt-px size-3 shrink-0" />
													已从系统钥匙串读取到保存的密码。
												</p>
											)}
											<div
												className="mt-2.5 border-t border-border pt-2.5"
												onClickCapture={(e) => {
													// Checkbox 本身没有 disabled 属性（本次写入范围只允许改本文件），
													// 所以在捕获阶段就把点击拦住：钥匙串不可用时这个勾选框真的改不动，
													// 并且明确告诉用户为什么，而不是让他点了没反应。
													if (secretUsable !== false) return;
													e.preventDefault();
													e.stopPropagation();
													toast({
														title: "系统钥匙串不可用，密码无法保存",
														description: "密码只能留在内存里；请用桌面端，或先修好系统的钥匙串服务",
														tone: "warning",
													});
												}}
											>
												<Checkbox
													checked={remember}
													onChange={setRemember}
													className={secretUsable === false ? "cursor-not-allowed opacity-45" : undefined}
													label="记住密码"
												/>
												{secretUsable === false && (
													<p className="mt-1.5 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
														<span className="icon-[lucide--triangle-alert] mt-px size-3 shrink-0" />
														系统钥匙串当前不可用，这个选项已禁用。
													</p>
												)}
												{hasSavedSecret && (
													<div className="mt-1.5 flex flex-wrap items-center gap-2">
														<Button size="sm" variant="ghost" icon="icon-[lucide--trash-2]" onClick={() => void forgetSavedSecret()}>
															删除已保存的密码
														</Button>
														<span className="text-[10.5px] text-faint">系统钥匙串里已存有这台主机的密码</span>
													</div>
												)}
											</div>
										</div>
									)}

									{/* ② 私钥 / ③ 私钥 + 口令 */}
									{(authMethod === "key" || authMethod === "key-passphrase") && (
										<div className="mt-3">
											<div className="flex items-center justify-between">
												<label htmlFor="ssh-key-path" className="text-[11px] font-medium text-muted">
													私钥文件
												</label>
												<Badge className="font-mono text-[9.5px]">只进内存</Badge>
											</div>
											<div className="mt-2 flex items-center gap-1.5">
												<Input
													id="ssh-key-path"
													value={keyPath}
													disabled={connecting}
													autoComplete="off"
													autoFocus
													placeholder={connecting ? "正在认证…" : "C:\\Users\\you\\.ssh\\id_ed25519"}
													onChange={(e) => setKeyPath(e.target.value)}
													onKeyDown={(e) => {
														if (e.key === "Enter") void startConnect();
													}}
													className="font-mono"
												/>
												<Button size="sm" icon="icon-[lucide--folder-open]" disabled={connecting} onClick={() => void chooseKeyFile()}>
													选择文件…
												</Button>
											</div>
											{registeredKey && (
												<p className="mt-1.5 text-[10.5px] leading-4 text-faint">
													主机登记的密钥：{registeredKey.name}（{registeredKey.type}
													{registeredKey.bits ? ` ${registeredKey.bits}` : ""} · {registeredKey.fingerprint}）
												</p>
											)}
											{authMethod === "key-passphrase" && (
												<div className="mt-2.5">
													<div className="flex items-center justify-between">
														<label htmlFor="ssh-key-passphrase" className="text-[11px] font-medium text-muted">
															私钥口令
														</label>
														<Badge className="font-mono text-[9.5px]">只存内存</Badge>
													</div>
													<Input
														id="ssh-key-passphrase"
														type="password"
														value={passphrase}
														disabled={connecting}
														autoComplete="off"
														placeholder={connecting ? "正在认证…" : "私钥口令"}
														onChange={(e) => setPassphrase(e.target.value)}
														onKeyDown={(e) => {
															if (e.key === "Enter") void startConnect();
														}}
														className="mt-2 font-mono"
													/>
													<p className="mt-1.5 text-[10.5px] leading-4 text-faint">私钥没有口令就留空。</p>
												</div>
											)}
										</div>
									)}

									{/* ④ SSH Agent */}
									{authMethod === "agent" && (
										<div className="mt-3">
											<div className="flex items-center justify-between">
												<span className="text-[11px] font-medium text-muted">SSH Agent 里的身份</span>
												<Badge className="font-mono text-[9.5px]">私钥不经过 TermX</Badge>
											</div>

											{!sshReady && (
												<p className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
													<span className="icon-[lucide--laptop] mt-px size-3 shrink-0" />
													<span>浏览器预览里读不到 SSH Agent：这一项只在桌面端可用。</span>
												</p>
											)}

											{sshReady && agentLoading && <p className="mt-2 text-[11px] leading-4 text-muted">正在读取系统 SSH Agent…</p>}

											{sshReady && !agentLoading && agentError && (
												<div className="mt-2 rounded-control border border-danger/40 bg-danger/10 p-2.5">
													<p className="text-[11px] leading-4 text-danger">读取 SSH Agent 失败：{agentError}</p>
													<Button
														size="sm"
														icon="icon-[lucide--rotate-cw]"
														className="mt-2"
														onClick={() => setAgentTicket((n) => n + 1)}
													>
														重试
													</Button>
												</div>
											)}

											{sshReady && !agentLoading && !agentError && agentIdentities?.length === 0 && (
												<div className="mt-2 rounded-control border border-warning/40 bg-warning/10 p-2.5">
													<div className="flex items-center gap-1.5 text-[11.5px] font-medium text-surface-foreground">
														<span className="icon-[lucide--triangle-alert] size-3.5 shrink-0 text-warning" />
														SSH Agent 里没有可用身份：请先 ssh-add 添加私钥
													</div>
													<p className="mt-1 text-[10.5px] leading-4 text-muted">
														在系统终端里执行 ssh-add ~/.ssh/id_ed25519（Windows 上用它认识的真实路径），加好之后再点「重新读取」。
													</p>
													<Button
														size="sm"
														icon="icon-[lucide--rotate-cw]"
														className="mt-2"
														onClick={() => setAgentTicket((n) => n + 1)}
													>
														重新读取
													</Button>
												</div>
											)}

											{sshReady && !agentLoading && !agentError && agentIdentities && agentIdentities.length > 0 && (
												<div className="mt-2 rounded-control border border-border bg-surface-sunk p-2.5">
													<div className="flex items-center justify-between gap-2">
														<span className="text-[11px] font-medium text-muted">
															Agent 里有 {agentIdentities.length} 个身份
														</span>
														<Button
															size="sm"
															variant="ghost"
															icon="icon-[lucide--rotate-cw]"
															onClick={() => setAgentTicket((n) => n + 1)}
														>
															重新读取
														</Button>
													</div>
													<ul className="mt-1.5 space-y-1">
														{agentIdentities.map((identity, index) => (
															<li
																key={`${identity.fingerprint}-${index}`}
																className="rounded border border-border bg-surface px-2 py-1.5"
															>
																<div className="selectable font-mono text-[10.5px] leading-4 break-all text-surface-foreground">
																	{identity.fingerprint || "（Rust 侧没有给出指纹）"}
																</div>
																<div className="mt-0.5 text-[10.5px] leading-4 text-muted">
																	{identity.algorithm || "算法未报告"}
																	{identity.comment ? ` · ${identity.comment}` : ""}
																</div>
															</li>
														))}
													</ul>
													<p className="mt-1.5 flex items-start gap-1.5 text-[10.5px] leading-4 text-faint">
														<span className="icon-[lucide--info] mt-px size-3 shrink-0" />
														<span>按顺序尝试下列身份，由服务器决定接受哪一把。</span>
													</p>
												</div>
											)}
										</div>
									)}

									{/* ⑤ 键盘交互（二次验证 / 服务器逐步提问） */}
									{authMethod === "keyboard-interactive" && (
										<div className="mt-3">
											<div className="flex items-center justify-between">
												<span className="text-[11px] font-medium text-muted">键盘交互</span>
												<Badge className="font-mono text-[9.5px]">问答只走内存</Badge>
											</div>
										</div>
									)}

									{/* 主按钮：五种方式共用；缺什么就如实说缺什么 */}
									<div className="mt-3 flex items-center gap-2">
										<Button
											size="sm"
											variant="primary"
											icon="icon-[lucide--plug-zap]"
											disabled={connecting || !sshReady || credentialProblem !== null}
											onClick={() => void startConnect()}
										>
											{connecting ? "连接中…" : "连接"}
										</Button>
										{!connecting && sshReady && credentialProblem && (
											<span className="text-[10.5px] text-faint">{credentialProblem}</span>
										)}
									</div>
									{!sshReady && (
										<div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
											<span className="icon-[lucide--laptop] mt-px size-3 shrink-0" />
											<span>浏览器预览里没有原生 SSH 通道，按钮已禁用。</span>
										</div>
									)}
								</div>
							)}

							{/* 连接成功：真实指纹 + 进入工作区 */}
							{connected && (
								<div className="mt-4 rounded-control border border-success/40 bg-success/10 p-3">
									<div className="flex items-center gap-2">
										<span className="icon-[lucide--check-circle] size-3.5 shrink-0 text-success" />
										<span className="text-[12px] font-medium text-surface-foreground">SSH 会话已建立</span>
									</div>
									<p className="mt-1.5 text-[11px] leading-4 text-muted">
										{host.username}@{host.hostname}:{host.port} 的远程 shell 已就绪。
									</p>
									<FingerprintBlock value={fingerprint} verified className="mt-2.5" />
									{!fingerprint && (
										<p className="mt-1.5 text-[10.5px] leading-4 text-faint">本页没有握手阶段的记录，因此没有指纹可显示。</p>
									)}
									<div className="mt-2.5 flex items-center gap-1.5">
										<Button size="sm" variant="primary" icon="icon-[lucide--terminal]" onClick={enterWorkspace}>
											进入工作区
										</Button>
										<Button size="sm" icon="icon-[lucide--x]" onClick={() => void disconnect()}>
											断开连接
										</Button>
										<Button size="sm" icon="icon-[lucide--pencil]" onClick={() => navigate(`/hosts/${host.id}/edit`)}>
											编辑主机
										</Button>
									</div>
								</div>
							)}

							{/* 普通失败态（认证失败、TCP 不通等）：只展示 Rust 端真实返回的原因；
							    主机密钥被拦下的情况由上面的告警卡片负责，不在这里重复 */}
							{!connected && ssh.failure && !alert && (
								<div className="mt-4 rounded-control border border-danger/40 bg-danger/10 p-3">
									<div className="flex items-start gap-2">
										<span className="icon-[lucide--circle-x] mt-px size-3.5 shrink-0 text-danger" />
										<div className="min-w-0 flex-1">
											<div className="text-[11.5px] font-medium text-danger">
												SSH 连接失败
												{ssh.failedStage ? ` · 失败于「${STAGE_LABEL[ssh.failedStage]}」` : ""}
											</div>
											<p className="mt-1 text-[11px] leading-4 text-muted">{ssh.failure}</p>
											<div className="selectable mt-2 rounded border border-border bg-term px-2 py-1.5 font-mono text-[10.5px] leading-4 break-all text-term-ink">
												{host.username}@{host.hostname}:{host.port}
												{"\n"}
												{ssh.failure}
											</div>
											<div className="mt-2.5 flex items-center gap-1.5">
												<Button
													size="sm"
													variant="primary"
													icon="icon-[lucide--rotate-cw]"
													disabled={connecting || !sshReady || credentialProblem !== null}
													onClick={() => void startConnect()}
												>
													重试
												</Button>
												<Button size="sm" icon="icon-[lucide--pencil]" onClick={() => navigate(`/hosts/${host.id}/edit`)}>
													编辑主机
												</Button>
												<Button
													size="sm"
													icon="icon-[lucide--copy]"
													onClick={() =>
														copy(
															`${host.name} (${host.username}@${host.hostname}:${host.port})\n${ssh.failure ?? ""}`,
															"已复制错误信息",
														)
													}
												>
													复制错误信息
												</Button>
											</div>
										</div>
									</div>
								</div>
							)}

							{/* 操作按钮栏 */}
							<div className="mt-4 flex items-center justify-end gap-2">
								<Button
									size="sm"
									className="h-7 px-2.5"
									onClick={() => {
										toast({ title: `已离开连接页 ${host.name}`, tone: "default" });
										useSessionsStore.getState().setActiveTab("vaults");
										navigate("/workspace");
									}}
								>
									返回主机库
								</Button>
								<Button
									size="sm"
									icon="icon-[lucide--gauge]"
									className="h-7 px-3"
									disabled={isProbing || connecting}
									onClick={() => void probeNow()}
								>
									{isProbing ? "正在探测…" : "重新探测 TCP"}
								</Button>
							</div>
						</div>
					</div>
				</div>

				{/* 首次连接确认指纹：Rust 已经拒绝这次握手，只有用户核对并确认后才会写入 known_hosts 并重连 */}
				<Modal
					open={alert?.kind === "host_unknown" && alert.open}
					onClose={dismissAlert}
					title="首次连接该主机，请确认指纹"
					icon="icon-[lucide--fingerprint]"
					width={470}
					footer={
						<>
							<Button size="sm" disabled={trusting} onClick={dismissAlert}>
								取消
							</Button>
							<Button
								size="sm"
								variant="primary"
								icon="icon-[lucide--fingerprint]"
								disabled={trusting || !sshReady}
								onClick={() => void trustAndRetry()}
							>
								{trusting ? "正在记录信任…" : "信任并继续"}
							</Button>
						</>
					}
				>
					<p>
						<span className="font-mono text-surface-foreground">
							{host.hostname}:{host.port}
						</span>{" "}
						的主机密钥还不在本机 known_hosts 里；确认后才会写入并继续连接。
					</p>
					<FingerprintBlock
						value={alert?.fingerprint ?? null}
						label="服务器在本次握手中返回的真实指纹"
						size="large"
						className="mt-2.5"
					/>
					<p className="mt-2.5">
						请在服务器上核对指纹（例如{" "}
						<code className="rounded border border-border bg-surface-sunk px-1 font-mono text-[10.5px] text-surface-foreground">
							ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub
						</code>
						）。
					</p>
					<div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-warning">
						<span className="icon-[lucide--triangle-alert] mt-px size-3 shrink-0" />
						<span>指纹对不上就不要点「信任并继续」。</span>
					</div>
					{trustError && (
						<div className="mt-2 rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-[10.5px] leading-4 text-danger">
							没能在 known_hosts 里记录这把密钥：{trustError}
						</div>
					)}
				</Modal>

				{/* 键盘交互问答：服务器问一轮就弹一轮，答完接着下一轮，直到认证结束或用户取消 */}
				<Modal
					open={authPrompt !== null}
					onClose={() => void cancelAuthPrompt()}
					title={authPrompt?.name || "服务器要求交互式验证"}
					icon="icon-[lucide--shield-question]"
					width={440}
					footer={
						<>
							<Button size="sm" disabled={responding} onClick={() => void cancelAuthPrompt()}>
								取消认证
							</Button>
							<Button
								size="sm"
								variant="primary"
								icon="icon-[lucide--arrow-right]"
								disabled={responding || promptSubmitted}
								onClick={() => void submitAuthPrompt()}
							>
								{responding ? "正在提交…" : promptSubmitted ? "已提交，等待服务器…" : "继续"}
							</Button>
						</>
					}
				>
					{authPrompt && (
						<>
							{authPrompt.instructions ? (
								<p className="whitespace-pre-wrap">{authPrompt.instructions}</p>
							) : (
								<p>服务器没有给额外说明，只给了下面这些提问。</p>
							)}
							<div className="mt-2.5 space-y-2">
								{authPrompt.prompts.map((item, index) => (
									<Field
										key={`${item.prompt}-${index}`}
										label={item.prompt || `第 ${index + 1} 项`}
										hint={item.echo ? undefined : "不回显"}
									>
										<Input
											type={item.echo ? "text" : "password"}
											value={answers[index] ?? ""}
											disabled={responding || promptSubmitted}
											autoComplete="off"
											autoFocus={index === 0}
											onChange={(e) =>
												setAnswers((prev) =>
													authPrompt.prompts.map((_, i) => (i === index ? e.target.value : (prev[i] ?? ""))),
												)
											}
											onKeyDown={(e) => {
												if (e.key === "Enter" && !promptSubmitted) void submitAuthPrompt();
											}}
											className="font-mono"
										/>
									</Field>
								))}
							</div>
							<p className="mt-2.5 text-[10.5px] leading-4 text-faint">
								回答按提问顺序原样提交给服务器。
							</p>
							{promptError && (
								<div className="mt-2 rounded-control border border-danger/40 bg-danger/10 px-2 py-1.5 text-[10.5px] leading-4 text-danger">
									回答没能交给服务器：{promptError}
								</div>
							)}
						</>
					)}
				</Modal>
			</div>
		</WindowChrome>
	);
}

/* ---------------------------------- 逻辑 ---------------------------------- */

function isSshStage(phase: string): phase is SshStage {
	return (SSH_STAGES as readonly string[]).includes(phase);
}

/** 把任意抛出物转成能展示的文案：Tauri 的 invoke 失败直接抛字符串，不一定是 Error */
function messageOf(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** 失败落在哪一步：优先取自带 ok:false 的阶段，否则是最后一个成功阶段的下一步 */
function stageOfFailure(stages: Record<string, StageResult>): SshStage | null {
	for (const stage of SSH_STAGES) {
		const result = stages[stage];
		if (result && !result.ok) return stage;
	}
	const lastOk = [...SSH_STAGES].reverse().find((stage) => stages[stage]?.ok);
	const index = lastOk ? SSH_STAGES.indexOf(lastOk) + 1 : 0;
	return SSH_STAGES[index] ?? null;
}

/** 把一条真实阶段事件并入进度 */
function applyPhase(progress: SshProgress, phase: SshPhase): SshProgress {
	const stages = {
		...progress.stages,
		[phase.phase]: { ok: phase.ok, detail: phase.detail, fingerprint: phase.fingerprint ?? null },
	};
	if (phase.phase === "failed") {
		return { ...progress, stages, failure: phase.detail, failedStage: stageOfFailure(stages) };
	}
	if (!phase.ok) {
		return {
			...progress,
			stages,
			failure: phase.detail,
			failedStage: isSshStage(phase.phase) ? phase.phase : progress.failedStage,
		};
	}
	return { ...progress, stages };
}

/** 从握手阶段的真实 detail 里取指纹（Rust 端形如「主机指纹 SHA256:...」）；取不到就原样返回，不编造 */
function fingerprintOf(detail: string | undefined): string | null {
	if (!detail) return null;
	const match = /SHA256:[A-Za-z0-9+/=]+/.exec(detail);
	return match ? match[0] : detail;
}

/** 用真实结果推导分步进度：未发起 SSH 时前两步看 TCP 探测，发起后五步全看 SSH 阶段 */
function buildSteps(
	report: ProbeReport | undefined,
	supported: boolean,
	probing: boolean,
	probeError: string | null,
	ssh: SshProgress,
	hostKeyRefused: boolean,
	authMethod: AuthMethod,
): Step[] {
	const sshDriven = ssh.started || ssh.connected;
	const probeDetail = !supported ? "需桌面端" : probing ? "正在探测…" : probeError ? "探测失败" : "等待探测";
	const probeState: StepState = probing ? "active" : probeError ? "failed" : "pending";
	const nextStage = SSH_STAGES.find((stage) => !ssh.stages[stage]);

	const sshStep = (id: SshStage, label: string): Step => {
		const result = ssh.stages[id];
		if (result) return { id, label, state: result.ok ? "done" : "failed", detail: result.detail };
		if (ssh.connected) return { id, label, state: "done", detail: ESTABLISHED_DETAIL[id] };
		if (ssh.failedStage === id) return { id, label, state: "failed", detail: ssh.failure ?? "连接失败" };
		// 有一步失败了：这一步没走到，如实留 pending，不写「尚未接入」也不写成功
		if (ssh.failedStage) return { id, label, state: "pending", detail: "未走到这一步" };
		if (ssh.connecting) {
			return id === nextStage
				? { id, label, state: "active", detail: "进行中…" }
				: { id, label, state: "pending", detail: "等待上一步" };
		}
		return { id, label, state: "pending", detail: "等待连接" };
	};

	const resolve: Step = sshDriven
		? sshStep("resolve", STAGE_LABEL.resolve)
		: report
			? { id: "resolve", label: STAGE_LABEL.resolve, state: "done", detail: `目标 ${report.host}:${report.port}` }
			: { id: "resolve", label: STAGE_LABEL.resolve, state: probeState, detail: probeDetail };

	const tcp: Step = sshDriven
		? sshStep("tcp", STAGE_LABEL.tcp)
		: report
			? report.reachable
				? {
						id: "tcp",
						label: STAGE_LABEL.tcp,
						state: "done",
						// 口径写清楚：这是本机 TCP 建连耗时，不是到主机的往返
						detail: `TCP 建连 ${formatMs(report.median_ms)} ms`,
					}
				: { id: "tcp", label: STAGE_LABEL.tcp, state: "failed", detail: report.error ?? "TCP 不可达" }
			: { id: "tcp", label: STAGE_LABEL.tcp, state: probeState, detail: probeDetail };

	const steps: Step[] = [
		resolve,
		tcp,
		sshStep("handshake", STAGE_LABEL.handshake),
		sshStep("auth", `认证 · ${AUTH_LABEL[authMethod]}`),
		sshStep("shell", STAGE_LABEL.shell),
	];

	// 主机密钥被拦下时，TCP 其实已经通了 —— 服务器都把主机密钥发过来了，只是 Rust 没有单独
	// 推送 tcp 阶段。如实说明这一点，免得这一行读起来像「TCP 都没连上」。
	if (hostKeyRefused && steps[1].state === "pending") {
		steps[1] = { id: "tcp", label: STAGE_LABEL.tcp, state: "done", detail: "已连通（握手时收到了服务器的主机密钥）" };
	}

	return steps;
}

interface Conclusion {
	tone: string;
	icon: string;
	headline: string;
	body?: string;
}

/** 顶部结论卡片的文案：优先讲真实 SSH 结果，其次讲 TCP 探测，都不伪造 */
function summarize(
	report: ProbeReport | undefined,
	supported: boolean,
	probing: boolean,
	probeError: string | null,
	ssh: SshProgress,
	alert: HostAlert | null,
): Conclusion {
	// 主机密钥没过校验不是普通失败：文案要说清「是 TermX 主动拦下的」，以及下一步该做什么
	if (alert && !ssh.connected) {
		return alert.kind === "host_unknown"
			? {
					tone: "border-warning/40 bg-warning/10",
					icon: "icon-[lucide--fingerprint] text-warning",
					headline: alert.open ? "首次连接该主机，等待你确认指纹" : "首次连接未确认指纹，连接已中止",
					body: alert.open ? "核对指纹并确认后才会继续连接。" : "指纹未确认，连接保持中止。",
				}
			: {
					tone: "border-danger/40 bg-danger/10",
					icon: "icon-[lucide--shield-alert] text-danger",
					headline: "主机指纹与已保存的记录不一致，已拒绝连接",
					body: alert.detail,
				};
	}
	if (ssh.connected) {
		return {
			tone: "border-success/40 bg-success/10",
			icon: "icon-[lucide--check-circle] text-success",
			headline: "SSH 会话已建立",
		};
	}
	if (ssh.connecting) {
		return {
			tone: "border-primary/40 bg-primary/10",
			icon: "icon-[lucide--circle-dashed] text-primary",
			headline: "正在建立 SSH 会话",
		};
	}
	if (ssh.failure) {
		return {
			tone: "border-danger/40 bg-danger/10",
			icon: "icon-[lucide--circle-x] text-danger",
			headline: ssh.failedStage ? `SSH 连接失败 · 失败于「${STAGE_LABEL[ssh.failedStage]}」` : "SSH 连接失败",
			body: ssh.failure,
		};
	}
	if (report && !report.reachable) {
		return {
			tone: "border-danger/40 bg-danger/10",
			icon: "icon-[lucide--circle-x] text-danger",
			headline: "TCP 不可达；尚未发起 SSH 连接",
			body: report.error ?? "目标端口无响应，请检查安全组、防火墙或跳板机路由。",
		};
	}
	if (report) {
		return {
			tone: "border-success/40 bg-success/10",
			icon: "icon-[lucide--check-circle] text-success",
			headline: "TCP 可达性已确认；尚未发起 SSH 连接",
		};
	}
	if (!supported) {
		return {
			tone: "border-border bg-surface",
			icon: "icon-[lucide--circle-dashed] text-faint",
			headline: "浏览器内无法确认 TCP 可达性，也无法发起 SSH 连接",
			body: "TCP 探测与 SSH 都跑在 Rust 端，请用 pnpm tauri:dev 启动桌面端。",
		};
	}
	if (probeError) {
		return {
			tone: "border-warning/40 bg-warning/10",
			icon: "icon-[lucide--triangle-alert] text-warning",
			headline: "TCP 探测没有完成；尚未发起 SSH 连接",
			body: probeError,
		};
	}
	return {
		tone: "border-border bg-surface",
		icon: "icon-[lucide--circle-dashed] text-faint",
		headline: probing ? "正在探测 TCP 可达性…" : "TCP 可达性尚未确认；尚未发起 SSH 连接",
	};
}

/* ---------------------------------- 零件 ---------------------------------- */

/**
 * 真实指纹区块：值只可能来自服务器（Rust 侧握手时算出来的 SHA256）。
 * verified 表示这条连接确实通过了 known_hosts 校验，才敢在界面上说「已校验」。
 */
function FingerprintBlock({
	value,
	label = "服务器返回的主机指纹",
	size = "normal",
	verified = false,
	className,
}: {
	value: string | null;
	label?: string;
	size?: "normal" | "large";
	verified?: boolean;
	className?: string;
}) {
	return (
		<div className={cn("rounded-control border border-border bg-surface-sunk p-2.5", className)}>
			<div className="flex items-center gap-1.5 text-[10.5px] font-medium text-muted">
				<span className="icon-[lucide--fingerprint] size-3 shrink-0" />
				{label}
			</div>
			<div
				className={cn(
					"selectable mt-1.5 font-mono break-all text-surface-foreground",
					size === "large" ? "text-[13px] leading-5" : "text-[11px] leading-4",
				)}
			>
				{value ?? "尚未握手，没有指纹可显示"}
			</div>
			{value && verified && (
				<div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-success">
					<span className="icon-[lucide--shield-check] mt-px size-3 shrink-0" />
					<span>已通过 known_hosts 校验。</span>
				</div>
			)}
			{!value && (
				<div className="mt-2 flex items-start gap-1.5 text-[10.5px] leading-4 text-faint">
					<span className="icon-[lucide--info] mt-px size-3 shrink-0" />
					<span>指纹只能来自服务器握手时返回的密钥。</span>
				</div>
			)}
		</div>
	);
}

function StepMark({ state }: { state: StepState }) {
	if (state === "done") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-success/15 text-success">
				<span className="icon-[lucide--check] size-2.5" />
			</span>
		);
	}
	if (state === "active") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-primary/20 text-primary">
				<span className="size-1.5 animate-ping rounded-full bg-primary" />
			</span>
		);
	}
	if (state === "failed") {
		return (
			<span className="flex size-4 items-center justify-center rounded-full bg-danger/20 text-danger">
				<span className="icon-[lucide--x] size-2.5" />
			</span>
		);
	}
	return (
		<span className="flex size-4 items-center justify-center rounded-full border border-border">
			<span className="size-1 rounded-full bg-border" />
		</span>
	);
}
