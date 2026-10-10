# A 架构与契约审查

审查范围：`facts.md`、`design-v0.md`、现有 `agent-engineering-cycle` Skill，以及 `D:\zzd\codex-sol` 的运行时组合、MCP 注册、Hook、上下文和变更协调器源码。独立插件方向已由用户确认；以下不再讨论是否改成 SoL 扩展。复用了事实包中的 44 pass / 1 skip 定向结果，没有重复运行测试。本报告是静态设计审查，不构成目标宿主、MCP 互连或 Hook 覆盖的实测证明。

## 结论

建议独立插件在自身包内拥有一个小型 `CycleCore`，MCP 与 Hook 都调用它；不从当前 SoL 源码树深层导入、不复用 SoL 的 `ChangeCoordinator` 作为工程循环 owner。Skill 是唯一的语义协调者，恢复项目原有 R/D 来源、判断 I/Q 含义、处理缺陷与 Delta。CycleCore 持有每工作区的循环运行指针、操作恢复状态和不可变运行证据；Hook 不维护第二份状态。

组件分析默认不参与闭环。可选时，Skill 在宿主确实同时提供 SoL 工具、且项目启用了 SoL 架构索引的条件下，调用 `sol_architecture_query`，把带版本和来源 handle 的结果作为可选分析证据引用。不要让 CycleCore 假设它能直接向另一个 MCP server 发请求；当前 SoL 实现提供的是 server 工具注册，没有共享库或 client-side provider 契约。无 SoL、未连接、无索引或无 JS 登记时，循环仍可按普通文件/文档项目工作，组件分析明确为 skipped/unavailable。

## 发现

### A1. SoL 当前的 MCP 工具不是通用循环 provider，深层代码导入也不是可分发共享库

**分类 / 严重度：设计风险，P1（若照“通用执行/证据 provider”实现，会阻塞独立插件的分发边界）。**

**位置与证据：** `design-v0.md:18,20,24,28,43-55` 将 MCP、核心与 provider 作为拟定边界，但没有把“工具组合”“共享代码依赖”和“循环状态 owner”区分开。事实包 `facts.md:17-26` 已确认 SoL 没有已发布的核心库/exports 契约。`codex-sol/package.json:2-17` 声明 `private: true`，没有 package-level `exports` 字段；`src/runtime.mjs:11-29` 的 transport-free 组合实际接入 SoL 的 store、validation、ContextEngine、sessions 和 ChangeCoordinator。`src/server.mjs:54-94,101-148` 暴露的是 SoL 自己的架构查询、context、change、受管写入、读取和 recall 工具。`src/architecture/change.mjs:25-34,110-120,484-503` 的 change 输入要求 architecture version、查询 handle 和每路径 `module_uid`，并持有 SoL 自己的单工作区 `active-change.json` 指针。SoL 的架构配置是可选项（`src/architecture/context.mjs:29-30,122-123`），但 change 工具依赖配置好的架构模式。

**触发 → 失败 → 影响：** 独立插件试图用 SoL MCP 承担通用 cycle 状态、写入或 QA 回执时，现有工具要求 SoL 任务身份、SoL 的变更绑定及模块索引，且写入/完成状态由 SoL 自己的 ChangeCoordinator 拥有；新插件没有可传递的统一 cycle binding，也没有 generic host-evidence API。若绕过 change 工具使用普通写入，则不能据此声称完成了新插件的范围门禁或 QA 证据校验。结果是要么把 Python/文档项目也强制塞进 JS 模块登记，要么形成两个协调器和两个完成状态，要么把尚不存在的 provider 接口当成已可用能力。

**最小修正：** 现在只复用经审查的状态/操作生命周期模式，不复用整套 SoL 变更协调器。CycleCore 自己以窄范围实现本产品必需的状态绑定、追加证据、期望版本检查和显式恢复；项目文件/固定命令由本插件自己的本地 adapter 访问。可选组件查询保持在 Skill 层，通过宿主实际暴露的 `sol_architecture_query` 做工具组合；记录 provider 名称、架构版本和来源 handle，不转移 cycle 状态，不把 SoL 的 `sol_change_*` 或 `sol_apply_*` 当 cycle 核心 API。若以后要在代码层直接复用 SoL，先经另一次授权建立可发布、版本化的 transport-free 公共包与兼容测试，再添加独立 adapter。

**依赖路线的现实成本与建议：**

| 路线 | 当前可行性与成本 | 建议 |
| --- | --- | --- |
| 参考模式，在新插件内部实现最小核心 | 可立即分发；需维护本产品自己的小型状态存储、跨进程锁/版本检查及操作回执，需从 SoL 经验中挑选具体不变量并建立本项目检查 | **当前最低必要方案。** 不复制整个协调器，也不为未知消费者先抽公共框架 |
| 可选 MCP 工具组合 | 只能复用当前明确公开的 SoL 工具语义；受宿主连接、SoL 配置和工具版本影响。SoL server 当前无 MCP client/provider 适配层，因此自动调用能力须由宿主/Skill 组合并验证。`sol_architecture_query` 适合可选组件分析，不提供独立 QA 身份或通用 cycle 状态/执行能力 | 仅作为显式可选分析功能；工具不可用时不中断核心闭环、不伪造结果 |
| 固定版本源码/依赖 + adapter | Git commit pin 在技术上可能，但当前没有正式可依赖的 package exports；`private:true` 也意味着不是现成的 npm 发布物。深层路径会绑定内部类、配置与 SoL 的模块 UID 假设；每次 pin 更新都需协调 SoL 版本、适配器和两边测试，也要维护双插件安装及运行时兼容 | 现在不采用。仅在先发布稳定公共包并确认真实共享边界后再考虑版本化 adapter；不能描述为当前已有能力 |

**可判定验收与维护影响：** 用无 SoL、SoL 未连接、SoL 已连接但无架构配置、SoL 架构已配置四个环境分别验证：只有最后一种能提供可追溯的可选组件分析；前三种不得阻塞循环，也不得写入“分析已验证”。另用无 JS 索引的 Python 或纯文档项目确认能够建立、恢复和关闭循环。核心流程测试不得依赖 SoL 私有路径；后续升级 SoL 时，只有可选 adapter 需要重新做兼容验收。

### A2. 生命周期字段混合了工作阶段与运行终态

**分类 / 严重度：设计风险，P1。**

**位置与证据：** `design-v0.md:37-41` 将 `planning / implementing / verifying / reconciling` 阶段和 `completed / interrupted / abandoned` 终态放进同一个 `state` 列表，同时又说 `blocked` 是进展状态；`design-v0.md:47-53` 再用当前阶段、操作 pending 与完成条件驱动状态转移。

**触发 → 失败 → 影响：** QA 正在 `verifying` 时宿主取消、归档失败或输入漂移，恢复时需要同时知道“当前工作阶段是 verifying”和“本次 cycle 已 interrupted/blocked”。单一枚举只能覆盖其中一个维度，或者继续扩成大量 `verifying_interrupted` 一类状态；恢复指针、下一安全动作和完成派生会出现不一致。

**最小修正：** 按正交维度保存：`stage`（R/D/I/Q/Delta 的当前工作位置）；`lifecycle`（active/interrupted/abandoned/completed）；独立 `blockers[]` 与 `pending_operation`（operation_id、输入绑定、执行状态/效果是否已知）。`blocked` 是当前阻塞事实/派生视图，不覆盖 stage 或真实副作用。`completed` 仍由核心检查必要工件、当前 Q、授权与同步条件后发布，不能由 Skill 提交布尔值。

**可判定验收：** 至少覆盖 `verifying+active`、`verifying+blocked`、`verifying+interrupted`、未知执行效果后显式恢复、归档失败后不可自动重放，以及只有满足条件才能转 `completed`。每个恢复响应都能给出保留的 stage、cycle binding、操作事实已知性和下一允许动作。

**维护影响：** 新增 QA 或 Delta 状态不会与取消/放弃状态相乘，生命周期迁移与工作流阶段分别演进，状态迁移表可直接覆盖取消和恢复场景。

### A3. 原主控、Skill 与 CycleCore 的“当前事实”所有权还没有落实到字段级

**分类 / 严重度：设计风险，P1。**

**位置与证据：** `design-v0.md:15-20,32-41,47-55` 同时提出原文档是外部权威、R/D/I/Q/Delta 工件和 Cycle 指针，但未列明每类字段的唯一 owner 与写回顺序。`facts.md:34-40` 要求权威来源、运行证据和批准状态可回查；现有 `agent-engineering-cycle/references/state-contract.md` 也要求单项状态只在一个实际 owner 处维护，Delta `incorporated` 必须对应原主控写回。

**触发 → 失败 → 影响：** 原 Skill 更新项目的 I/Delta 文档，同时 MCP 另存一份“当前 I/Delta”并更新 cycle 指针；或 cycle 先标完成、但原需求/设计主控尚未同步。两个副本都可能被恢复流程当成新鲜事实，导致 I 状态、获准增量、Q 绑定或完成结论分叉。

**最小修正：** 在最终方案加入字段 owner 表及一次明确同步协议：

- 原项目 PRD/蓝图/决定及用户批准仍是 R/D 与授权来源；CycleCore 只保存来源身份、修订/版本和验收所需的不可变输入快照，不另建可独立改范围的需求正文。
- 原 Skill 是唯一语义协调者与 I/Delta 的写回者；若项目已有正式 I 记录，该记录继续是权威。CycleCore 保存每轮已提交 I/Q/Delta 工件的不可变引用及状态指针，作为运行证据，不与原文件形成第二个可编辑主副本。
- CycleCore 是每工作区运行时 cycle 指针、pending/恢复事实、机器观测回执和完成判定的唯一 owner。Q 中的命令/环境/产物事实来自实际 adapter；QA 的语义判断和独立性结论保留 `reported`/`observed` 边界。
- Delta 的批准只能引用原用户决定/授权来源；CycleCore 可持有 proposed/approved/synced 的追踪状态，但只有 Skill 完成原主控写回并回传可核对的版本引用后才可标记 incorporated。同步失败保留 approved-but-unreconciled，cycle 不得完成。

**可判定验收：** 从已有 docs/design 与陈旧 I 状态恢复；批准一个 Delta 但模拟主控写回失败；确认原 R/D/I 文件保持唯一权威、cycle 指针清晰报告待同步，且没有新目标自动变成实现授权。写回成功后，状态引用确切的新修订；源码或验收变更后，关联 Q 标记 stale 并只要求相关复验。

**维护影响：** 更换 Skill、原主控格式或宿主时，只需更新边界适配；不会要求同步维护两份活跃需求、实现状态或“已完成”字段。

### A4. 草案仍把已确认的产品落点写成待裁决

**分类 / 严重度：确认的文档矛盾，P2。**

**位置与证据：** `design-v0.md:3` 写“最终归属待用户答复”，第 22 节标题为“两个待裁决落点”；但 `design-v0.md:95-97` 与 `facts.md:13` 已确认独立插件，并明确扩展 SoL 仅是历史备选。

**触发 → 失败 → 影响：** 最终方案沿用前文时，reviewer 或实施者可能再次要求用户在两个落点中选择，或把 SoL 扩展方案作为当前架构的一部分，冲淡已授权范围。

**最小修正：** 更新草案导语与章节标题，改为“独立插件内的复用路线”；把 SoL 扩展段保留为历史记录，明确不属于本轮候选实现。

**可判定验收：** 最终方案不再出现待用户选择插件归属的措辞，也不把修改 SoL 或启用 SoL 扩展列为本轮方案依赖。

**维护影响：** 后续实现任务的入口和变更范围保持与用户确认一致。

## 建议的最小边界与接口契约

| 边界 | 唯一责任与建议接口 |
| --- | --- |
| `CycleCore`（插件内部、无传输依赖） | 唯一裁定 cycle binding/version、阶段/生命周期、权限范围、artifact 引用、Q 当前性、操作恢复及完成条件。所有更改走同一转移/校验入口；Hook 与 MCP 不各自改 JSON 状态。 |
| workspace/evidence adapter（先作内部依赖，不抽公共包） | 在明确 cycle/scope 下执行窄范围读写、输入快照与固定 argv 检查；开始有副作用前持久化 pending/operation_id，settle 时保存实际效果或 unknown。adapter 返回机器观察事实，不能把模型报告升级为 verified。 |
| MCP adapter | Schema 与大小/来源验证、宿主取消、调用 CycleCore、结构化成功/错误/部分效果返回；状态查询与执行分开。状态返回至少含 binding、阶段/生命周期、缺项、证据引用、可继续动作及未证实范围。 |
| Hook adapter | 调用同一 CycleCore。SessionStart/UserPromptSubmit 仅提供恢复摘要；PreToolUse 只检查已支持工具的绑定/范围；Stop 做有限可执行收尾提示。不可用或被绕过时不伪报完成，Hook 不成为权限安全边界，也不自己写第二状态。 |
| Skill | 保持原主控入口与语义裁决：恢复原 R/D，整理验收和授权，解释实现/QA 结果，独立派 QA，分流缺陷与 Delta，完成原主控写回，再请求核心核对完成。插件随包 Skill 若存在，应是该入口的可分发/兼容层，不能形成第二套需求或第二个协调器。 |
| 可选组件分析 | 默认未启用；启用时用可发现的 provider 产出带 provider/version/source-ref 的观察。当前 SoL 只作为可选 `sol_architecture_query` 工具组合路径；它不可用时报告 skipped/unavailable，不改变 cycle 合约。 |

本评审建议首版只支持一个工作区内一个活动可写 cycle；每个 mutation 明确传 `cycle_id + expected_version + action scope`，跨 MCP/Hook 进程用同一持久化锁和版本比较。若将来需并行 cycle，再用明确的多指针/路径仲裁设计，不默认让多个 cycle 同时写同一范围。

## 尚未证明的宿主边界

MCP 两端能否由目标宿主在同轮稳定共存、Skill 能否以用户可见方式组合 SoL 工具、Hook 对目标工具实际覆盖、HostEvidence 能否观察 QA 的独立身份/起始上下文/终态，都需 P0 在实际宿主验证。当前源码与设计只能说明 SoL 自身提供了哪些接口，不能证明新插件能直接调用其他 server，也不能证明 Hook 防止所有未覆盖写入。若宿主不能提供 QA 所需观测，记录 `identity observed/context unverified` 或 `QA_VERIFICATION_UNAVAILABLE`，不能降级成已验证独立 QA。
