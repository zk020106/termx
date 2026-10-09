# 移植自 Netcatty 的终端模块

来源：https://github.com/MoLi-MoChou/Netcatty （v1.1.92，commit 7538338），许可证 **GPL-3.0-or-later**。

| 文件 | Netcatty 原路径 | 改动 |
|---|---|---|
| keywordHighlight.ts | components/terminal/keywordHighlight.ts | 仅改 import 路径 |
| keywordHighlightRegex.ts | components/terminal/keywordHighlightRegex.ts | 无 |
| keywordHighlightRules.ts | domain/models/terminal.ts（KeywordHighlightRule、默认规则、normalize） | 摘取相关片段 |
| copyOnSelect.ts | components/terminal/copyOnSelect.ts | 无 |
| terminalOutputPressure.ts | components/terminal/runtime/terminalOutputPressure.ts | 仅改 import 路径 |
| terminalFlowConstants.ts/.json | components/terminal/runtime/terminalFlowConstants.ts、infrastructure/config/terminalFlowConstants.json | 仅改 import 路径 |
| terminalReplay.ts | components/terminal/terminalReplay.ts | 无 |
| pluginTerminalBufferText.ts | components/terminal/pluginTerminalBufferText.ts | 无 |
| xtermPerformance.ts | infrastructure/config/xtermPerformance.ts | 无 |
| clearTerminalViewport.ts | components/terminal/clearTerminalViewport.ts | 无 |
| regexSafety.ts | lib/regexSafety.ts | 无 |
| pluginDecorationStub.ts | （替代 domain/pluginTerminalProviders.isSafePluginDecorationPattern） | termx 无插件系统，恒返回 false |

把这些 GPL 代码并入 termx 后，termx 若对外分发需要按 GPL-3.0 提供源码。
