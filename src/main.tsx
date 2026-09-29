import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@/styles/theme.css";

import App from "@/App";

const container = document.getElementById("root");
if (!container) throw new Error("找不到 #root 挂载点");

createRoot(container).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
