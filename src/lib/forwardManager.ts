import type { ForwardRule, Host } from "@/data/types";
import { hopCredential } from "@/lib/connectPlan";
import { resolveConnectProfile } from "@/lib/connectProfile";
import { secretLoad } from "@/lib/secret";
import { listenAuthPrompts } from "@/lib/ssh";
import { isTauri } from "@/lib/tauri";
import { useAuthPromptStore } from "@/store/authPrompts";
import { useForwardsStore } from "@/store/forwards";
import { useHostsStore } from "@/store/hosts";
import { create } from "zustand";

/* =============================================================================
 * 端口转发的运行时：真正调用 Rust 的 forward_start / forward_stop。
 *
 *  - 每条规则一条独立的 SSH 连接（走主机自己的跳板链 / 代理 / 超时设置），
 *    这样关掉终端标签不会把隧道一起带走，停止隧道也不影响终端。
 *  - 凭据按主机登记的认证方式取：密码先读钥匙串，没有就在连接时弹窗问；
 *    私钥 + 口令同样连接时问。提问走全局 AuthPromptHost。
 *  - 主机指纹未知 / 变化：规则进入「启动出错」，并记下待确认的指纹，
 *    转发页提供与连接页相同的「核对指纹并信任」流程，信任后再启动。
 *  - 状态与统计来自 forward://state/{ruleId} 事件，每秒最多一次。
 * ========================================================================== */

export interface ForwardTrustRequest {
	kind: "host_unknown" | "host_changed";
	fingerprint: string | null;
	host: string;
	port: number;
	detail: string;
}

interface ForwardEventPayload {
	state: "starting" | "running" | "stopped" | "error";
	connections: number;
	totalConnections: number;
	trafficIn: number;
	trafficOut: number;
	error?: string | null;
	kind?: string | null;
	fingerprint?: string | null;
	host?: string | null;
	port?: number | null;
	bound?: string | null;
}

interface ForwardRuntimeState {
	/** 待用户核对的主机指纹（按规则） */
	trust: Record<string, ForwardTrustRequest | undefined>;
	/** 实际监听的地址（远程转发 0 端口时由服务器分配） */
	bound: Record<string, string | undefined>;
	/** 累计接受过的连接数 */
	total: Record<string, number | undefined>;
	set: (patch: Partial<Pick<ForwardRuntimeState, "trust" | "bound" | "total">>) => void;
}

export const useForwardRuntime = create<ForwardRuntimeState>((set) => ({
	trust: {},
	bound: {},
	total: {},
	set: (patch) => set((s) => ({ ...s, ...patch })),
}));

const listeners = new Map<string, () => void>();
/** 用户主动停止的规则：启动途中被停止时，后端会回一个「已取消」错误，这不算出错 */
const stopping = new Set<string>();

function patchRule(id: string, patch: Partial<ForwardRule>) {
	const store = useForwardsStore.getState();
	const rule = store.rules.find((r) => r.id === id);
	if (!rule) return;
	store.upsert({ ...rule, ...patch });
}

function setRuntime<K extends "trust" | "bound" | "total">(field: K, id: string, value: ForwardRuntimeState[K][string]) {
	const current = useForwardRuntime.getState()[field];
	useForwardRuntime.getState().set({ [field]: { ...current, [id]: value } } as never);
}

function applyEvent(id: string, ev: ForwardEventPayload) {
	if (ev.state === "error" && stopping.has(id)) {
		// 启动途中被停止
		patchRule(id, { state: "stopped", connections: 0 });
		return;
	}
	if (ev.state === "stopped" || ev.state === "error") stopping.delete(id);
	const patch: Partial<ForwardRule> = {
		state: ev.state,
		connections: ev.state === "running" ? ev.connections : 0,
		trafficIn: ev.trafficIn,
		trafficOut: ev.trafficOut,
	};
	if (ev.state === "running") patch.error = undefined;
	if (ev.state === "error") patch.error = ev.error ?? "转发异常结束（后端没有给出原因）";
	patchRule(id, patch);
	if (ev.bound) setRuntime("bound", id, ev.bound);
	setRuntime("total", id, ev.totalConnections);
	if (ev.state === "error" && (ev.kind === "host_unknown" || ev.kind === "host_changed") && ev.host && ev.port) {
		setRuntime("trust", id, {
			kind: ev.kind,
			fingerprint: ev.fingerprint ?? null,
			host: ev.host,
			port: ev.port,
			detail: ev.error ?? "",
		});
	}
	if (ev.state === "stopped" || ev.state === "error") {
		useAuthPromptStore.getState().resolve(`fwd:${id}`);
	}
}

async function ensureListening(rule: ForwardRule): Promise<void> {
	if (listeners.has(rule.id)) return;
	const { listen } = await import("@tauri-apps/api/event");
	const offState = await listen<ForwardEventPayload>(`forward://state/${rule.id}`, (event) => applyEvent(rule.id, event.payload));
	const key = `fwd:${rule.id}`;
	const offPrompt = await listenAuthPrompts(key, (request) => {
		const current = useForwardsStore.getState().rules.find((r) => r.id === rule.id);
		useAuthPromptStore.getState().push({
			key,
			origin: `端口转发「${current?.name ?? rule.name}」正在连接，需要认证`,
			request,
			onCancel: () => void stopForward(rule.id),
		});
	});
	listeners.set(rule.id, () => {
		offState();
		offPrompt();
	});
}

/** 规则被删除：停掉并清理订阅 */
export async function disposeForward(id: string): Promise<void> {
	await stopForward(id);
	listeners.get(id)?.();
	listeners.delete(id);
}

function credentialFor(host: Host, saved: string | undefined) {
	const cred = hopCredential(host, saved);
	if ("error" in cred) return { error: cred.error.replace("跳板机", "主机") };
	return cred;
}

/** 启动一条规则；结果通过 store 呈现，返回值仅供调用方决定提示 */
export async function startForward(ruleId: string): Promise<{ ok: boolean; error?: string }> {
	const rule = useForwardsStore.getState().rules.find((r) => r.id === ruleId);
	if (!rule) return { ok: false, error: "规则不存在" };
	if (rule.state === "running" || rule.state === "starting") return { ok: true };
	if (!isTauri()) {
		const error = "端口转发需要在桌面端运行";
		patchRule(ruleId, { state: "error", error });
		return { ok: false, error };
	}
	const host = useHostsStore.getState().hosts.find((h) => h.id === rule.hostId);
	if (!host) {
		const error = "这条规则关联的主机已不存在，请编辑规则重新选择主机";
		patchRule(ruleId, { state: "error", error });
		return { ok: false, error };
	}

	stopping.delete(ruleId);
	setRuntime("trust", ruleId, undefined);
	patchRule(ruleId, { state: "starting", connections: 0, trafficIn: 0, trafficOut: 0 });
	await ensureListening(rule);

	const profile = await resolveConnectProfile(host.id);
	if (!profile.ok) {
		patchRule(ruleId, { state: "error", error: profile.error });
		return { ok: false, error: profile.error };
	}
	let saved: string | undefined;
	if (host.auth.method === "password") saved = (await secretLoad(host.id)) ?? undefined;
	const credential = credentialFor(host, saved);
	if ("error" in credential) {
		patchRule(ruleId, { state: "error", error: credential.error });
		return { ok: false, error: credential.error };
	}

	try {
		const { invoke } = await import("@tauri-apps/api/core");
		const ev = await invoke<ForwardEventPayload>("forward_start", {
			ruleId,
			spec: {
				type: rule.type,
				bindAddress: rule.bindAddress,
				bindPort: rule.bindPort,
				targetHost: rule.targetHost,
				targetPort: rule.targetPort,
			},
			host: host.hostname,
			port: host.port,
			username: host.username,
			credential,
			profile: profile.profile,
		});
		applyEvent(ruleId, ev);
		return { ok: true };
	} catch (raw) {
		const ev = raw as Partial<ForwardEventPayload> | string;
		if (typeof ev === "object" && ev && ev.state) {
			applyEvent(ruleId, ev as ForwardEventPayload);
			if (stopping.has(ruleId)) {
				stopping.delete(ruleId);
				return { ok: false };
			}
			return { ok: false, error: ev.error ?? undefined };
		}
		const error = typeof ev === "string" ? ev : String(raw);
		patchRule(ruleId, { state: "error", error });
		return { ok: false, error };
	} finally {
		useAuthPromptStore.getState().resolve(`fwd:${ruleId}`);
	}
}

export async function stopForward(ruleId: string): Promise<void> {
	const rule = useForwardsStore.getState().rules.find((r) => r.id === ruleId);
	if (!rule) return;
	useAuthPromptStore.getState().resolve(`fwd:${ruleId}`);
	if (rule.state !== "running" && rule.state !== "starting") {
		// 没在跑：只是把「出错」清回「已停止」，保留上次失败原因给用户看
		if (rule.state === "error") patchRule(ruleId, { state: "stopped" });
		return;
	}
	stopping.add(ruleId);
	if (!isTauri()) {
		patchRule(ruleId, { state: "stopped" });
		return;
	}
	try {
		const { invoke } = await import("@tauri-apps/api/core");
		await invoke("forward_stop", { ruleId });
	} catch (error) {
		stopping.delete(ruleId);
		patchRule(ruleId, { state: "error", error: String(error) });
	}
}

/** 规则改过参数：在跑的话按新参数重启 */
export async function restartForward(ruleId: string): Promise<void> {
	const rule = useForwardsStore.getState().rules.find((r) => r.id === ruleId);
	if (!rule || (rule.state !== "running" && rule.state !== "starting")) return;
	await stopForward(ruleId);
	// 等后端真正释放端口（stopped 事件）再起
	for (let i = 0; i < 50; i++) {
		const now = useForwardsStore.getState().rules.find((r) => r.id === ruleId);
		if (!now || now.state === "stopped" || now.state === "error") break;
		await new Promise((r) => setTimeout(r, 100));
	}
	await startForward(ruleId);
}

/* ------------------------- 自动启动 ------------------------- */

let autoStartWired = false;

/**
 * 「主机连接建立后自动启动此转发规则」：监听终端会话的建立事件，
 * 某台主机连上时把它名下勾了自动启动、且当前没在跑的规则启动起来。
 */
export async function wireForwardAutoStart(): Promise<void> {
	if (autoStartWired || !isTauri()) return;
	autoStartWired = true;
	const { observeSshLifecycle } = await import("@/components/terminal/sshCache");
	observeSshLifecycle((key, event) => {
		if (event !== "connected" || !key.startsWith("ssh:")) return;
		const rest = key.slice(4);
		const hostId = rest.slice(0, rest.lastIndexOf(":"));
		for (const rule of useForwardsStore.getState().rules) {
			if (rule.hostId === hostId && rule.autoStart && (rule.state === "stopped" || rule.state === "error")) {
				void startForward(rule.id);
			}
		}
	});
}
