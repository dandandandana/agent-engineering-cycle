# C 原始报告：实施与评估

执行者：真实独立 `gpt-6-luna` / max subagent `reuse_eval_review`，首次最小上下文。以下保留返回原文；结论尚须主 Agent 裁决。

### C1 — P1【已确认源码缺口】

**触发反例：**为查组件而启用 SoL，结果同时带入第二套流程指令和写入工具。`codex-sol/src/server.mjs::createSolServer` 注册 Context、变更生命周期、`sol_apply_patch`、`sol_apply_changes`；`scripts/package-plugin.mjs::TREE_INPUTS` 打包整个 `src`，并包含 Hook。尚无 provider-only 入口。虽然 `architecture/index.mjs::select` 能查登记能力和静态依赖，它明确不提供完整调用图或完成证据。

**最小修正：**在 SoL 增加显式分发的只读 provider 入口，复用现有 ArchitectureIndex 与读取能力，只暴露查询、读文件、召回；不加载流程指令、写工具或 Hook。engineering-cycle 配置由操作者提供固定启动配置和期望版本/能力；未配置或能力不符时返回 unavailable，不让查询触发启动。

**验证：**目标 Codex 宿主实际列出 provider 工具与七个 cycle 工具，并确认没有 SoL 写工具、上下文指令和 Hook；未配置时确认查询不启动 provider、Store 或 peer。未做宿主运行验收。

### C2 — P1【已确认源码缺口／设计风险】

**触发反例：**模型先调用 `cycle_apply`，之后才声称查过组件，或把旧源码身份附在新决定上。`core/contracts.mjs::TOOL_SCHEMAS` 的七工具合同里没有复用决定字段；`cycle.mjs::cycle_apply`（273–278）只校验授权、路径和目标前态，不要求已有 D 决定。D 工件只绑定文件快照；现有 I 说明能校验 SHA，但 `implementation-notes.mjs::inspectImplementationNotes` 明确返回 `symbol_verified:false`、`semantic_verified:false`。

**最小修正：**不增第八个 cycle 工具：在现有 D 工件记录每个实现目标的 `reuse / extend / new` 决定、provider 能力/版本、候选源码路径与身份、适配理由；对声明的实现目标，让 `cycle_apply` 在副作用前检查 D 记录及源身份仍当前。provider 输出保留为待核实证据，不能作为授权或语义证明；I 工件记录实际依赖与数据流。`cycle_verify` 继续只跑项目配置的固定 `check_ids`，独立 QA 继续使用冻结输入。

**验证：**缺 D 决定、伪造路径或过期 SHA 时写入前拒绝；文档目标和未声明实现目标维持原行为；成功路径仍须通过全部固定检查和独立 QA。当前没有这项门禁。

### C3 — P1【设计风险】

**触发反例：**SoL 与 cycle 并载时，经 SoL MCP 写入仍绕过 cycle 的 `cycle_apply`。`agent-engineering-cycle/src/runtime.mjs::handleHook` 只拒绝 `apply_patch/Edit/Write`，Shell 和其他 MCP 工具不受它控制；SoL 自身仍注册写工具。该 Hook 也没有 session/task 去重或 UTF-8 字节预算，每次提示事件都可能注入状态；Stop 当前返回空对象。

**最小修正：**把单一写入 owner 建立在 provider-only 工具面上，不依靠扩大 Hook 正则覆盖所有写路径。Hook 仅投影状态摘要，按 UTF-8 字节数限额并按 session+task 状态变化去重；未确认的宿主送达能力标记为未知，后端门禁始终有效。

**验证：**在真实宿主核对 Hook 输入、返回内容字节数、恢复/重复事件行为及实际暴露的写工具；若仍能调用第二套写工具，不宣称已实现单一 owner。

### C4 — P1【设计风险】

**触发反例：**把调用数增长直接报告成有效复用，或用新规则重算旧分。基线证据固定为 v1 有效复用 **4/25**、V8 观测调用 **19/25**；六题因登记说明文案不符旧规则失分，B04/B07 另有复制函数体。`blog-eval/evals/runner.mjs::gradeCase` 用 `result.success && observed_calls >= min_calls` 才算有效，V8 覆盖只统计指定导出函数的调用次数；丢弃返回值的 dummy call 仍可能过调用门槛。`rubric.mjs::bodies` 的结构匹配也不能证明语义复用。

**最小修正：**v1 的 4/25、19/25、原始证据与规则原样保留。v2 先冻结八题/25 个机会的适用性及理由，再分别报告行为、合规、适用机会、实际调用、有效数据流复用和说明质量；加入返回值未使用的 dummy call 与克隆实现负控。v1 与 v2 分开报告，不追认涨分，也不以模型自报评分。

**验证：**先证明评测器能拒绝两类负控，再跑固定分母、相同任务和版本的开关对照；评测标准冻结后不因结果修改。

### 有限实施阶段与失败门

1. 先冻结 provider 只读工具面、D 决定字段、Hook 投影约束和 v2 评测规则。
2. 分别实现 SoL provider-only 分发与 cycle D/写前门禁，保持七工具和项目固定检查合同。
3. 做目标宿主工具面/Hook 验收、固定检查与冻结 QA，再运行含负控的 v2 对照。

若宿主无法证明只读 provider 能力或 Hook 送达，能力应标 unavailable/未验证；若竞争写入口仍可用，停止声称单一 owner；若评测器未能拒绝 dummy/clone，停止报告 v2 有效复用收益。本轮只读核对，未运行模型、插件或宿主评测。
