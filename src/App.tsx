import { Component, lazy, Suspense, type ErrorInfo, type ReactNode } from "react";
import { HashRouter, Navigate, Route, Routes } from "react-router";
import { LockGate } from "@/components/chrome/LockGate";

/* 路由与 termx-design-brief「06 设计交付清单」的 16 个界面一一对应。
 * 其中 /welcome、/palette、/updater 是整页或浮层，不套应用外壳；
 * 锁屏不是路由：它由 LockGate 以覆盖层形式盖在整棵界面之上（见该文件），
 * 这样锁屏不会卸载终端，SSH 会话得以保留。
 *
 * 首页是**主机库**（/ 与未知路径都重定向过去）：冷启动没有任何会话，
 * 落在工作区只会看到一个空壳，用户还得自己再找去主机库的路。工作区因此
 * 有独立路径 /workspace，只有「连上以后进入」「点已有会话」「命令面板切会话」
 * 这类**手里已经有会话**的动作才会过去。
 *
 * 桌面端用 HashRouter：打包后由自定义协议加载，无需服务端改写路由。
 * 16 个界面全部按路由懒加载 —— 既让首屏只装载当前界面，也让单个界面的
 * 编译/运行错误不影响其他界面。 */

const Connect = lazy(() => import("@/screens/Connect"));
const Editor = lazy(() => import("@/screens/Editor"));
const Forward = lazy(() => import("@/screens/Forward"));
const HostEdit = lazy(() => import("@/screens/HostEdit"));
const Hosts = lazy(() => import("@/screens/Hosts"));
const Keys = lazy(() => import("@/screens/Keys"));
const Monitor = lazy(() => import("@/screens/Monitor"));
const Palette = lazy(() => import("@/screens/Palette"));
const Settings = lazy(() => import("@/screens/Settings"));
const Sftp = lazy(() => import("@/screens/Sftp"));
const Snippets = lazy(() => import("@/screens/Snippets"));
const Transfers = lazy(() => import("@/screens/Transfers"));
const Updater = lazy(() => import("@/screens/Updater"));
const Welcome = lazy(() => import("@/screens/Welcome"));
const Workspace = lazy(() => import("@/screens/Workspace"));

export default function App() {
	return (
		<HashRouter>
			<LockGate>
				<ScreenBoundary>
					<Suspense fallback={<ScreenLoading />}>
						<Routes>
							<Route path="/welcome" element={<Welcome />} />

							{/* 首页 = 主机库；工作区只从「已经有会话」的入口进 */}
							<Route path="/" element={<Navigate to="/hosts" replace />} />
							<Route path="/workspace" element={<Workspace />} />
							<Route path="/hosts" element={<Hosts />} />
							<Route path="/hosts/new" element={<HostEdit />} />
							<Route path="/hosts/:hostId/edit" element={<HostEdit />} />
							<Route path="/connect" element={<Connect />} />
							<Route path="/sftp" element={<Sftp />} />
							<Route path="/editor" element={<Editor />} />
							<Route path="/transfers" element={<Transfers />} />
							<Route path="/forward" element={<Forward />} />
							<Route path="/snippets" element={<Snippets />} />
							<Route path="/keys" element={<Keys />} />
							<Route path="/monitor" element={<Monitor />} />
							<Route path="/settings" element={<Settings />} />
							<Route path="/palette" element={<Palette />} />
							<Route path="/updater" element={<Updater />} />

							{/* 未知路径同样回到首页，而不是丢给用户一个空工作区 */}
							<Route path="*" element={<Navigate to="/hosts" replace />} />
						</Routes>
					</Suspense>
				</ScreenBoundary>
			</LockGate>
		</HashRouter>
	);
}

function ScreenLoading() {
	return (
		<div className="flex h-full items-center justify-center bg-surface text-[11.5px] text-faint">正在装载界面…</div>
	);
}

/** 兜底：单个界面崩溃时只替换这一屏，应用外壳与其余界面仍可用 */
class ScreenBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
	state: { error: Error | null } = { error: null };

	static getDerivedStateFromError(error: Error) {
		return { error };
	}

	componentDidCatch(error: Error, info: ErrorInfo) {
		console.error("界面渲染失败", error, info.componentStack);
	}

	render() {
		if (this.state.error) {
			return (
				<div className="flex h-full flex-col items-center justify-center gap-2 bg-surface px-6 text-center">
					<span className="icon-[lucide--triangle-alert] size-5 text-danger" />
					<div className="text-[12.5px] font-medium text-surface-foreground">这个界面渲染失败了</div>
					<div className="max-w-[60ch] font-mono text-[11px] leading-5 text-muted">{this.state.error.message}</div>
					<button
						type="button"
						onClick={() => this.setState({ error: null })}
						className="mt-1 rounded-control border border-border bg-surface-raised px-2.5 py-1 text-[11.5px] text-surface-foreground hover:bg-surface-sunk"
					>
						重试
					</button>
				</div>
			);
		}
		return this.props.children;
	}
}
