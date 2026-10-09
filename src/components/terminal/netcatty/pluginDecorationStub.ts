/**
 * Netcatty 的 `isSafePluginDecorationPattern` 只用于插件提供的高亮规则（带 providerId）。
 * termx 没有插件系统，永远不会出现插件规则；这里恒返回 false，等价于「拒绝所有插件规则」。
 */
export function isSafePluginDecorationPattern(_source: string): boolean {
  return false;
}
