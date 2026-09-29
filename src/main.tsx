import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@/styles/theme.css";

import App from "@/App";
import { hydrateStores, startAutosave } from "@/store/persistence";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

// 先把磁盘上的配置读进 store 再渲染，避免首帧闪一下空列表。
// 加超时兜底：持久化层出任何问题都不该让应用起不来。
await Promise.race([
	hydrateStores(),
	new Promise((resolve) => window.setTimeout(resolve, 3000)),
]);

startAutosave();

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
