# TermX 决策记录

设计需求书 [`termx-design-brief.html`](termx-design-brief.html) 第 10 节留了四个待确认问题。这里不再等拍板，
而是**照参考产品已经验证过的做法定下来**——参考对象是需求书点名的两个产品：

- [binaricat/Netcatty](https://github.com/binaricat/Netcatty) —— Electron + React + xterm.js，GPL-3.0
- [AnalyseDeCircuit/oxideterm](https://github.com/AnalyseDeCircuit/oxideterm) —— Rust + GPUI，GPL-3.0

每条决策都标了依据来源；凡是从截图/README 推不出来、需要读更多代码才能确认的，都写明"未验证"。

---

## Q1 · 多台电脑之间要不要同步配置？

**决策：不做云端账号同步，做「加密的可移植配置包」；云同步留作可选，且必须是显式确认的计划式同步。**

依据：

| 参考 | 做法 |
| --- | --- |
| OxideTerm | 有 Cloud Sync，但定位是 **plan-and-apply**：「Sync is a plan-and-apply workflow, not silent background mutation」，同步前出预览计划、冲突由人裁决（`docs/user-guide/en/architecture.md`）。便携包 `.oxide` 用 **ChaCha20-Poly1305 + Argon2id** 加密（README），且明确规定**后台同步不得静默包含托管的 SSH 密钥**，要迁移完整凭据必须走手动导出（`docs/user-guide/zh-Hans/portable-oxide.md`）|
| Netcatty | 可见的是本地 **Vaults**（多库切换）与 grid/list/tree 三种视图，没有账号体系；平台徽章是 macOS / Windows / Linux |

落到 TermX：需求书原选项 A（加密备份导入导出）+ OxideTerm 的"可移植包"形态。**这个已经实现**——
[`src/screens/Settings.tsx`](../src/screens/Settings.tsx) 的数据与备份分区已有 `.termx` 包导出/导入、
AES-256-GCM 加密备份（密钥由主密码经 Argon2id 派生）、冲突按主机地址合并、凭据交系统钥匙串。

**不做**：账号注册、把配置托管给第三方服务。与两个参考的 local-first 取向一致。

---

## Q2 · AI 助手是否进入规划？

**决策：进入规划，按 OxideTerm 的 BYOK 模型做——用户自带 provider，不内置 AI 服务；任何会改动远端状态的动作必须用户批准。**

依据：

| 参考 | 做法 |
| --- | --- |
| OxideTerm | **BYOK-first**：「OxideSens uses your OpenAI/Anthropic/Gemini/Ollama/OpenAI-compatible endpoint with MCP, RAG, provider-aware reasoning controls, and **approved workspace actions**」（README）。另有 command policy 概念 |
| Netcatty | 另一个方向：**内置 Agent**（Catty Agent），自然语言管理服务器、多主机编排（README）|

TermX 是个人自用工具，不需要内置服务的运营成本，所以选 OxideTerm 路线。需求书本来就写了"执行前必须由用户确认"，与 OxideTerm 的 approved actions 一致。

落地形态：右侧工具面板里的「AI 助手」入口是真面板（`src/components/panels/AiAssistPanel.tsx`），
可配 provider / 模型 / API Key（存系统钥匙串），并列出三项能力（解释输出、生成命令、分析报错）与执行策略开关。

---

## Q3 · 主要用什么系统？

**决策：三平台为目标，Windows 为主设计；窗口控件按平台分支（macOS 在左，Windows/Linux 在右）。**

依据：两个参考的发布平台徽章都是 **macOS | Windows | Linux**（两份 README）。
而 TermX 现有的设计帧 `termx.vetd/components/WindowChrome.tsx` 明确画的是 Windows 自定义无边框标题栏（三键在右），
使用者本机也是 Windows。所以：以 Windows 为设计基准，但不写死——窗口控件位置按平台走。

落地形态：[`src/lib/platform.ts`](../src/lib/platform.ts) 做平台探测，[`TitleBar.tsx`](../src/components/chrome/TitleBar.tsx) 据此决定窗口按钮在左还是在右。

---

## Q4 · 是否需要对接公司堡垒机（如 JumpServer）？

**决策：不对接厂商堡垒机 API，用 SSH 原生多跳（ProxyJump 式）表达跳板链；UI 上参考 OxideTerm 的「钻入下一跳」。**

依据：

| 参考 | 做法 |
| --- | --- |
| Netcatty | 跳板就是 SSH 原生 `ProxyJump` 语义。其研究文档明确指出 ProxyJump 会为跳板机单独建立一条 SSH 连接，因而**跳板机需要自己那份配置**（`docs/research/issue-2079-password-key-fallback-comparison.md`），没有任何厂商堡垒机 API 集成 |
| OxideTerm | 会话树里每台主机节点下挂 `新建终端 / SFTP / IDE / 端口转发 / 断开 / 钻入（下一跳）`，跳板链表现为**可钻入的嵌套会话**（产品截图 `ox_pf.png`、`ox_sftp.png` 左侧「活动会话」树）|

这与需求书 05-B 的 P0「跳板机：多级跳板链，每一跳可单独配置认证方式」是同一件事。
**不做** JumpServer 之类的 API 对接；若以后确实要接，再单开一题。

---

## 顺带对齐的其他做法（不是待确认问题，但值得照抄）

1. **凭据交操作系统钥匙串**，应用本身不落盘明文——两个参考都这么做，需求书也要求。
2. **断线宽限期**：OxideTerm 的做法是"探测旧连接 30 秒再替换"，好让 TUI 程序扛过短抖动（README）。
   需求书 07 的"宽限期重连"同义，实现时按 30s 量级设计。
3. **命令式的东西要可回退**：OxideTerm 只在动作显式返回 `undo_ref` 时才宣称可撤销，绝不伪造撤销句柄
   （`docs/user-guide/en/app.md`）。对应需求书 03-6「可撤销优于确认」——撤销只给真的能撤销的操作。

## 未验证 / 仍需你拍板的

- 上面 Q1 里 Netcatty 那排顶部图标中疑似"云同步"的那个按钮，**我没有读它的实现代码去确认功能**，只从截图推断，故未作为依据写入。
- 两个参考都是 GPL-3.0。TermX 目前是个人自用、未定许可证；**如果打算参考它们的代码实现（而非只参考行为），需要先决定 TermX 的许可证与合规口径**——本项目只参考了产品行为，没有复制任何代码。
