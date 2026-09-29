import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import pkg from "./package.json";

// TermX 桌面端前端构建配置。
// - dev 端口固定 5183，与 src-tauri/tauri.conf.json 的 devUrl 保持一致
// - envPrefix 放行 TAURI_ 前缀，供前端判断是否运行在原生壳内
export default defineConfig({
	plugins: [react(), tailwindcss()],
	// 真实版本号来自 package.json，界面上不再写死版本
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
	},
	resolve: {
		alias: {
			"@": new URL("./src", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
		},
	},
	clearScreen: false,
	server: {
		port: 5183,
		strictPort: true,
	},
	envPrefix: ["VITE_", "TAURI_ENV_"],
	build: {
		target: "es2022",
		sourcemap: true,
	},
});
