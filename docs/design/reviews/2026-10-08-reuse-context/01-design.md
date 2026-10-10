# A 原始报告：设计与公共合同

执行者：真实独立 `gpt-6-luna` / max subagent `reuse_contract_review`，首次最小上下文。以下保留返回原文；结论尚须主 Agent 裁决。

## A 角色：设计与公共合同

**A1｜P0｜已确认源码缺口＋设计风险：唯一写入 owner 的范围需要可验证地限定。**
触发反例：同一工作区同时加载工程循环插件和完整 SoL；SoL 的 `sol_apply_changes` 或 `sol_apply_patch` 能独立改产品文件。工程循环的 [`handleHook`](D:/zzd/agent-engineering-cycle/src/runtime.mjs) 只拦截 `apply_patch`、`Edit`、`Write`，其 [`hooks.json`](D:/zzd/agent-engineering-cycle/hooks/hooks.json) 也只匹配这些工具；它不能证明 Shell、外部编辑器或 SoL 写入受控。SoL 的 [`createSolServer`](D:/zzd/codex-sol/src/server.mjs) 注册了自己的写工具。
最小修正：把承诺写成“工程循环是其受管写入口的唯一产品写入 owner”；同一任务只允许它与 SoL provider-only 发行物共存。provider-only 包不含写工具、工作流 instructions 或 Hook。明确宿主外的写入不在可证明边界内。
判别验证：检查实际 MCP 工具清单、Hook 清单和发行物文件清单；验证 provider-only 包没有产品写入口。再用完整 SoL 与循环插件并存作为反例，确认文档不会宣称已实现全宿主独占。

**A2｜P1｜已确认源码缺口：SoL 尚无 provider-only 发行与能力合同。**
触发反例：配置 SoL 作为“只读发现 provider”后，实际启动的仍是完整 MCP。SoL [`plugin-launcher.mjs`](D:/zzd/codex-sol/src/plugin-launcher.mjs) 只有 `mcp`、`hook`、`check-config` 等模式；`mcp` 调用 [`createSolServer`](D:/zzd/codex-sol/src/server.mjs)，仍注册写工具。[`package-plugin.mjs`](D:/zzd/codex-sol/scripts/package-plugin.mjs) 复制完整源码和 Hook。`architectureQuery` 还经 `ContextEngine.archive` 写入 SoL observation store；`readOnlyHint` 不能证明没有写入副作用。循环插件当前也没有 provider 配置，且依赖中只有 MCP server，没有 provider client。
最小修正：单独定义 provider 入口和发行物，列出精确工具、产品写权限、证据 Store 写权限、Hook 状态及版本；由操作员配置固定可执行文件和参数。运行时核验入口身份与工具清单；缺失、超时或能力不符就报 unavailable，不启动或回退到模型给出的命令。
判别验证：核对打包后的注册工具和文件清单；验证未配置时不启动 peer、不创建循环 Store；配置不符时明确失败。provider 查询的归档副作用也应能被能力结果如实表达。

**A3｜P0｜已确认源码缺口＋设计风险：复用计划目前不是写入门禁。**
触发反例：循环在没有当前 D、没有复用判断或来源阅读证据时，仍可 `cycle_apply`。[`cycle_control`](D:/zzd/agent-engineering-cycle/src/core/contracts.mjs) 的 `implementation_targets` 只有路径和 symbol；[`CycleCore.preflight`](D:/zzd/agent-engineering-cycle/src/core/cycle.mjs) 核对授权和目标前态，却不要求复用计划。现有 I 实现说明在写后接入；[`inspectImplementationNotes`](D:/zzd/agent-engineering-cycle/src/local/implementation-notes.mjs) 明确不验证 symbol、调用图或语义。
最小修正：保留七工具，把每个 source-write 目标的 `reuse / extend / new` 决定放进 D 工件元数据，并由 `cycle_apply` 在 pending 前校验。计划至少绑定当前 cycle/binding、D 工件引用、目标路径和 symbol、候选来源身份，以及由 provider 返回并被实际捕获的查询/源码阅读结果引用与完整度。后端重读并核对 SHA、版本和目标匹配；理由与语义适配仍标为 reported。若无法验证调用方覆盖或内容是否被模型实际读到，就明确标为未证实。
判别验证：缺 D、缺来源证据、复制实现冒充复用、source hash 过期、provider unavailable 时，写入须在 pending 和文件副作用前被拒；有效复用、合理扩展、确实不适配的新实现均能保留解释。旧博客评分及分母保持不变。

**A4｜P1｜设计风险：source-write 分类、配置升级和状态绑定要一起定义。**
触发反例：模型把代码修改标为“文档小修”以绕过计划；或新增 provider 配置后，严格的 schema v1 拒绝旧配置、又没有明确兼容路径。当前 [`configSchema`](D:/zzd/agent-engineering-cycle/src/local/config.mjs) 固定 `schema_revision:1`；`cycle_apply` 没有写入分类；只有 `CycleCore.grant` 中对 docs 模式按扩展名限制。
最小修正：由后端按实际目标和现有 operator grant 分类，不接受模型提供的豁免字段；只有明确文档白名单可走 docs 路径，未知类型按 source-write 处理。配置升级应接受旧 v1 并维持其既有语义；新 provider 配置另有版本，默认 unavailable。将当前 provider/复用计划身份纳入 basis 与 prepared handle，但保留现有 request 去重、pending、outcome、settle 和 unknown-effects 恢复路径。
判别验证：旧配置可读取；未配置查询不初始化 Store/启动 peer；文档目标不误触 source 门禁；代码和未知扩展名不能靠模型字段豁免；漂移只使相应绑定过期，不重放写操作。

**A5｜P2｜设计风险：Hook 的预算与去重尚无可验证的宿主证据。**
触发反例：compact 或恢复后发生状态变化，但按 session+task 去重静默省略提醒；或摘要 UTF-8 字节超过 2 KiB。现有 [`handleHook`](D:/zzd/agent-engineering-cycle/src/runtime.mjs) 每次生成摘要，没有字节上限、session/task 去重账本或 delivery acknowledgement。
最小修正：按 UTF-8 字节硬限预算并确定性裁剪；缺少稳定 session/task 标识或宿主确认时，不宣称“已送达”，恢复时重发。Hook 只提示，门禁仍由 backend 执行。
判别验证：测试 2 KiB 边界、中文超限、compact/恢复、重复无变化和状态变化；结果区分“生成”与“确认送达”。

**最小合同建议：**继续使用七个工具；在现有 D 工件接入复用决定和可核验的来源读取证据，在 `cycle_apply` 前验证其当前性。操作员配置 provider-only SoL 入口，缺省不启动；工具能力明确区分产品写、SoL 证据 Store 写和 Hook。source-write 分类由后端按目标和授权决定。所有新增身份纳入当前 binding/basis；旧 v1 配置保持兼容，旧评分与新评估分开。
