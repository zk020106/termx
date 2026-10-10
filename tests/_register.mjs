// 测试用 ESM 解析钩子：tsc 产物里的相对导入不带扩展名、JSON 不带 import attributes，
// 这里补上 .js 并把 JSON 包成默认导出，让移植自 Netcatty 的多文件模块能在 node --test 下直接跑。
import { register } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve as pathResolve } from "node:path";

const testBuildDir = pathToFileURL(pathResolve(process.cwd(), ".tmp/test-build")).href + "/";

register(
	"data:text/javascript," +
		encodeURIComponent(`
export async function resolve(specifier, context, next) {
	if (specifier.startsWith("@/")) {
		const target = "${testBuildDir}" + specifier.slice(2) + ".js";
		try {
			return await next(target, context);
		} catch (e) {
			return next("${testBuildDir}" + specifier.slice(2) + "/index.js", context);
		}
	}
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
