// 测试用 ESM 解析钩子：tsc 产物里的相对导入不带扩展名、JSON 不带 import attributes，
// 这里补上 .js 并把 JSON 包成默认导出，让移植自 Netcatty 的多文件模块能在 node --test 下直接跑。
import { register } from "node:module";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(specifier, context, next) {
	try {
		return await next(specifier, context);
	} catch (error) {
		if (error?.code === "ERR_MODULE_NOT_FOUND" && (specifier.startsWith("./") || specifier.startsWith("../"))) {
			return next(specifier + ".js", context);
		}
		if (error?.code === "ERR_UNSUPPORTED_DIR_IMPORT") {
			return next(specifier + "/index.js", context);
		}
		throw error;
	}
}
export async function load(url, context, next) {
	if (url.endsWith(".json")) {
		const { readFile } = await import("node:fs/promises");
		const text = await readFile(new URL(url), "utf8");
		return { format: "module", source: "export default " + text + ";", shortCircuit: true };
	}
	return next(url, context);
}
`),
	import.meta.url,
);
