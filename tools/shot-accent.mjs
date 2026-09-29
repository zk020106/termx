/* =============================================================================
 * 强调色截图与验证（Chromium DevTools Protocol，无第三方依赖）
 *
 * shot.ps1 每次都是新的无头会话，验证不了「同一个会话里切了色、界面立刻变」；
 * 这个脚本在一个会话里打开设置页 → 切到外观 → 换强调色 → 截图 + 读回
 * <html data-accent> 与 --color-accent 的实际值，并验证刷新后仍生效。
 *
 * 用法：node tools/shot-accent.mjs            （需要 dev server 在 5183）
 * ========================================================================== */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 9333;
const URL = "http://localhost:5183/#/settings";
const OUT_DIR = "shots";

const BROWSERS = [
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
	"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
];
const browser = BROWSERS.find((p) => existsSync(p));
if (!browser) throw new Error("找不到 Chrome / Edge");

const profile = mkdtempSync(join(tmpdir(), "termx-accent-"));
mkdirSync(OUT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const chrome = spawn(
	browser,
	[
		"--headless=new",
		"--disable-gpu",
		"--hide-scrollbars",
		"--no-first-run",
		"--no-default-browser-check",
		"--force-device-scale-factor=1",
		"--window-size=1440,900",
		`--remote-debugging-port=${PORT}`,
		"--remote-allow-origins=*",
		`--user-data-dir=${profile}`,
		URL,
	],
	{ stdio: "ignore" },
);

/** 等一个可用的页面 target */
async function pageTarget() {
	for (let i = 0; i < 60; i += 1) {
		try {
			const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
			const page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
			if (page) return page;
		} catch {
			/* 浏览器还没起来 */
		}
		await sleep(500);
	}
	throw new Error("Chromium DevTools 端口没起来");
}

const target = await pageTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
	ws.addEventListener("open", resolve, { once: true });
	ws.addEventListener("error", reject, { once: true });
});

let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (event) => {
	const msg = JSON.parse(event.data);
	const entry = pending.get(msg.id);
	if (!entry) return;
	pending.delete(msg.id);
	if (msg.error) entry.reject(new Error(JSON.stringify(msg.error)));
	else entry.resolve(msg.result);
});

function send(method, params = {}) {
	const id = nextId++;
	ws.send(JSON.stringify({ id, method, params }));
	return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

/** 页面里求值，返回 JSON 化的结果 */
async function evaluate(expression) {
	const { result, exceptionDetails } = await send("Runtime.evaluate", {
		expression: `JSON.stringify((() => { ${expression} })())`,
		awaitPromise: true,
		returnByValue: true,
	});
	if (exceptionDetails) throw new Error(exceptionDetails.text ?? "页面求值失败");
	return result.value ? JSON.parse(result.value) : null;
}

async function waitFor(expression, label, tries = 40) {
	for (let i = 0; i < tries; i += 1) {
		if (await evaluate(`return Boolean(${expression});`)) return;
		await sleep(250);
	}
	throw new Error(`等待超时：${label}`);
}

async function shot(name, clip) {
	const { data } = await send("Page.captureScreenshot", clip ? { format: "png", clip } : { format: "png" });
	writeFileSync(join(OUT_DIR, name), Buffer.from(data, "base64"));
	console.log(`shot  ${join(OUT_DIR, name)}`);
}

/** 当前生效的强调色状态（DOM 属性 + 解析后的 CSS 变量 + 六个色点） */
const READ_STATE = `
	const root = document.documentElement;
	const cs = getComputedStyle(root);
	return {
		theme: root.dataset.theme,
		accent: root.dataset.accent,
		accentVar: cs.getPropertyValue("--color-accent").trim(),
		dots: [...document.querySelectorAll("[class*=bg-swatch-]")].map((el) => getComputedStyle(el).backgroundColor),
	};
`;

const clickText = (text) => `
	const el = [...document.querySelectorAll("button")].find((b) => b.textContent.includes(${JSON.stringify(text)}));
	if (!el) throw new Error("找不到按钮：" + ${JSON.stringify(text)});
	el.click();
	return true;
`;

/** 终端环境偏好里的实时预览框：那一行路径用的是强调色 */
const PREVIEW_CLIP = `
	const el = [...document.querySelectorAll("span")].find((s) => s.textContent.includes("~/apps/order-api"));
	if (!el) throw new Error("找不到终端预览");
	const box = el.closest("div.rounded-lg") ?? el;
	const r = box.getBoundingClientRect();
	return { x: Math.round(r.x) - 4, y: Math.round(r.y) - 4, width: Math.round(r.width) + 8, height: Math.round(r.height) + 8, scale: 2 };
`;

const openAppearance = async () => {
	await evaluate(clickText("外观与界面主题"));
	await waitFor(`document.body.innerText.includes("强调色")`, "外观分区");
};

const openTerminal = async () => {
	await evaluate(clickText("终端环境偏好"));
	await waitFor(`document.body.innerText.includes("~/apps/order-api")`, "终端分区");
};

await send("Page.enable");
await send("Runtime.enable");

await waitFor("document.querySelector('#root')?.children.length", "应用挂载");
await waitFor(
	`[...document.querySelectorAll("button")].some((b) => b.textContent.includes("外观与界面主题"))`,
	"设置页导航",
);

// 1) 默认：Linear 经典靛蓝（深色）
await openAppearance();
console.log("初始：", await evaluate(READ_STATE));
await shot("accent-01-indigo-dark.png");

// 2) 终端预览里的强调色（靛蓝）
await openTerminal();
await shot("accent-02-preview-indigo-dark.png", await evaluate(PREVIEW_CLIP));

// 3) 同一个会话里切到电光青 → 立刻重绘
await openAppearance();
await evaluate(clickText("电光青"));
await sleep(300);
console.log("点电光青：", await evaluate(READ_STATE));
await shot("accent-03-cyan-dark-same-session.png");
await openTerminal();
await shot("accent-04-preview-cyan-dark.png", await evaluate(PREVIEW_CLIP));

// 4) 再切玫瑰粉，看预览框
await openAppearance();
await evaluate(clickText("玫瑰粉"));
await sleep(300);
await openTerminal();
await shot("accent-05-preview-rose-dark.png", await evaluate(PREVIEW_CLIP));

// 5) 换成琥珀金后刷新：值应写进配置并恢复
await openAppearance();
await evaluate(clickText("琥珀金"));
await sleep(300);
await openAppearance();
await send("Page.reload", { ignoreCache: true });
await waitFor("document.querySelector('#root')?.children.length", "刷新后挂载");
await sleep(800);
console.log("刷新后：", await evaluate(READ_STATE));
console.log(
	"刷新后配置文件里的 accent：",
	await evaluate(`const c = JSON.parse(localStorage.getItem("termx.config") || "{}"); return c.preferences ?? null;`),
);
await openAppearance();
await shot("accent-06-amber-after-reload.png");

// 6) 浅色主题下同样成立
await evaluate(clickText("浅色模式"));
await sleep(300);
console.log("浅色 + 琥珀金：", await evaluate(READ_STATE));
await shot("accent-07-amber-light.png");
await openTerminal();
await shot("accent-08-preview-amber-light.png", await evaluate(PREVIEW_CLIP));
await openAppearance();
await evaluate(clickText("金属银灰"));
await sleep(300);
console.log("浅色 + 金属银灰：", await evaluate(READ_STATE));
await shot("accent-09-steel-light.png");

// 7) 全色板矩阵：6 个强调色 × 深浅两套，逐格核对解析后的 --color-accent
//    （只改 <html> 上的属性，绕开交互，专门验证 CSS 这一层）
const IDS = ["indigo", "cyan", "emerald", "amber", "rose", "steel"];
const matrix = await evaluate(`
	const root = document.documentElement;
	const out = {};
	for (const theme of ["dark", "light"]) {
		root.dataset.theme = theme;
		out[theme] = {};
		for (const id of ${JSON.stringify(IDS)}) {
			root.dataset.accent = id;
			out[theme][id] = getComputedStyle(root).getPropertyValue("--color-accent").trim();
		}
	}
	return out;
`);
console.log("色板矩阵：", matrix);
for (const theme of ["dark", "light"]) {
	const values = IDS.map((id) => matrix[theme][id]);
	if (values.some((v) => !v)) throw new Error(`${theme} 下有强调色没解析出值`);
	if (new Set(values).size !== IDS.length) throw new Error(`${theme} 下有强调色取值重复`);
}

ws.close();
chrome.kill();
await sleep(300);
rmSync(profile, { recursive: true, force: true });
console.log("done");
