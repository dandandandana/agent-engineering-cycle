# B 原始报告：反例与边界

执行者：真实独立 `gpt-6-luna` / max subagent `reuse_redteam_review`，首次最小上下文。以下保留返回原文；结论尚须主 Agent 裁决。

B1 **P1｜已确认源码缺口＋设计风险：双写入控制器。** 若两个插件同时启用，Cycle 和 SoL 都会响应 SessionStart、UserPromptSubmit、PreToolUse、Stop；SoL 还会注入自己的流程指令并注册写工具。SoL 的 `plugin-launcher.mjs` MCP 入口启动完整 `createSolServer`，不是只读 provider。最小修正：单独打包只读 provider，明确列出工具和 Hook 面；验证实际进程的工具清单及双插件行为。清单和 schema 不能证明 OS 级隔离。

B2 **P1｜设计风险：伪造“已读”和语义适配。** `inspectImplementationNotes` 校验源哈希、文档摘录并明确返回 `semantic_verified:false`；模型声称读过实现或认为接口适配，不构成程序证据。决定记录应绑定实际查询句柄、版本、源码身份及调用方证据，并明确语义判断仍是模型报告。用未读源码、虚构调用方和真实兼容实现做判别样例。

B3 **P1｜设计风险：仓库文本注入与权限混淆。** 恶意注释或登记描述可诱导模型调用写工具或声称已批准。SoL `createSolServer` 指示源码是证据而非覆盖指令；Cycle `reconcile/approve` 另行校验 `OperatorAuthority` 收据，这是应保留的权限边界。Provider 命令和权限必须只来自操作者配置，不能接受模型给出的可执行命令或批准字段。验证投毒文本、伪造 `decision_id` 均不能取得权限；这仍不证明模型不会受文本影响。

B4 **P1｜设计风险：source/registry 漂移。** SoL `ArchitectureIndex.load/fresh` 和 `sol_change_open` 已绑定查询版本并检查输入新鲜度；Cycle 的 `basis` 只包含本地声明的目标、输入、工件等，当前没有 provider 查询身份。若决定只记 capability 名称，登记或源码更新后可能沿用旧结论。最小修正：持久化查询版本及完整源身份，并在写前由 provider 复核；测试准备后修改登记、源文件或调用方均触发 stale。静态 ESM 扫描仍不能覆盖动态注册和完整运行时调用图。

B5 **P1｜已确认源码缺口：同工作区聊天串线。** Cycle `handleHook` 只按 `cwd` 取 `store.current()`，没有 session/task 绑定；聊天 B 可能收到聊天 A 的目标和 blocker。SoL `ContextSessions` 有会话指针，但不会自动给 Cycle 状态加隔离。应按可信 host session/thread 身份绑定；缺身份时不自动套用别的任务。验证同目录双会话及缺失身份场景。

B6 **P2｜已确认源码缺口：提醒去重与 compact 交付。** Cycle Hook 每次生成摘要，没有 session/task 状态账本或送达确认；SoL 支持 compact 恢复，但 `remind` 对持续 blocker 可重复返回。仅保存“已生成”可能造成漏提醒或误判模型已收到。用绑定、任务、摘要哈希去重；恢复/compact 或未确认时重发。测试重复 prompt、状态变化、compact 和未知送达。

B7 **P2｜已确认源码缺口：2 KiB UTF-8 预算。** Cycle `handleHook` 直接 `JSON.stringify(summary)`，没有字节上限。实现应按字段截取并对最终序列化结果执行 UTF-8 字节检查，超限退化为最小状态指针。用中文、转义字符和最大 blocker 集合验证不超过 2048 字节且 JSON 可解析。

B8 **P2｜设计风险：查询超时与重放。** SoL `ContextEngine.architectureQuery` 会归档结果，其 schema 没有 request ID；MCP 超时不能证明归档未发生。Cycle 的持久操作已有未知效果及不重放机制，但不覆盖 provider 调用。为查询提供幂等请求身份或明确其可安全重试边界；模拟归档后响应丢失，确认恢复不会假报“未执行”，也不会重复产生不可区分结果。

B9 **P1｜已确认覆盖限制：Shell/外部编辑器。** Cycle `handleHook` 仅拒绝 apply_patch/Edit/Write，状态页明确只检测、不阻止外部编辑和未匹配 Shell。SoL `native-hook` 会在宿主 Shell 权限下包装 Bash，不能据此宣称单写入者。保留“受管入口”限定；若要强制单写者，须依赖并实测宿主权限或沙箱。用 Shell 和外部编辑器改动验证写前新鲜度门禁会阻止旧绑定。

B10 **P2｜设计风险：复用评分可被 dummy call 通过。** Blog `rubric.inspect` 用函数体指纹查复制，`runner.gradeCase` 用覆盖调用数判断复用；现有报告也承认调用不证明语义最优。新增评分应分列 eligible/opportunity、实际调用和结果贡献，加入“调用但丢弃结果”的反例，并保留旧分数和证据不变。

**阻断建议：** 实施前先定下只读 provider 的实际工具/进程边界、Cycle 对查询证据的当前性合同，以及跨聊天绑定方式。保留风险是模型对恶意文本的响应，以及宿主 Shell/外部编辑器能否受控；静态审查和 schema 均不能证明这两点已隔离。此报告为只读源码审查；未运行插件、模型或测试。
