# C 实现与 Eval 审查

日期：2026-10-07
范围：只读审查工程循环设计；按已确认的独立插件目标。

## 结论

草案的状态与写入恢复原则可以落地，但现有 SoL 不能证明独立 QA，当前取消适配也不是 QA 委派接口。插件启动新的受控 Codex CLI 进程与由宿主启动 native subagent 两条路径都有可行入口，均未由真实宿主 PoC 证实，不能预先选择优胜者。先完成 P0 分路径 PoC，再冻结 P1 契约。

本轮没有模型调用、没有改变 Codex 配置、没有写 SoL 源码、没有运行测试。复用 facts.md 记录的同源码/环境测试结果：45 项计数、44 pass、1 Windows chmod skip、0 fail；该结果只验证所列 SoL 测试，不验证新插件或 Host QA。


## 证据边界

- codex-sol/src/host-cancellation.mjs:7-19 仅对 x-codex-turn-metadata 的 thread_id/turn_id 做 UUID 格式检查；之后本地 thread/read 与 rollout session_meta、task_started、turn_aborted 做关联。它用于取消监视，不创建 QA 执行者、不证明用户或模型身份，也不取得初始 QA 输入。
- codex-sol/src/architecture/change.mjs:701-704 明确将 method.reported 保存为自述、identity_verified=false。review 结构、来源和当前性校验不等于独立 QA 或语义正确性。
- codex-sol/src/process.mjs:24-27 的 toCheckResult 移除 launch_status/capture_error/cleanup_error；src/validation.mjs:415-416 在写 receipt 前调用它。因此 public receipt 的 exit_code=null 不足以区分未启动、启动状态未知、运行后输出/归档失败和清理失败。
- codex-sol/src/architecture/change.mjs:829-866 在写入前持久化 pending operation，取消后仍采集工作区差异、归档实际结果；结算失败保留 pending 与 recovery_required，不重放。:730-815 completion/archive/publish 失败保持 unfinished。tests/closure.test.mjs 与 tests/change-recovery.test.mjs 有取消、归档、指针/结算故障注入。facts.md 记录相同源码/环境 44 pass、1 skip、0 fail；本轮未重跑，且这些是 SoL 逻辑证据，不是新插件或真实宿主 QA 证明。
- package.json private=true 且无 exports；SoL MCP/change 依赖 JS architecture.json/module_uid。不能把私有 src 路径说成独立插件的可发布依赖；无 JS 登记的 Python/docs-only 项目不应被迫配置组件索引。
- hooks/hooks.json 当前只配置 SessionStart/UserPromptSubmit/匹配写工具的 PreToolUse/Stop；不是完整工具授权边界。官方 Hooks 文档记录 SubagentStart 的 agent_id/type 与父 session/turn/permission_mode，但没有初始 prompt；SubagentStop transcript path 和 last message 可缺省，transcript 格式不稳定。

## 发现

### C-1 — HostEvidenceAdapter 缺少可核验的真实 Host 字段映射

**类别/严重度：** 设计风险，高。<br>
**触发 → 失败 → 影响：** QA 返回写 role=reviewer、fresh_context=true，或只给格式合法 UUID → 核心把自述当执行独立性 → 自审被当独立 QA 并可能允许完成。违反 facts.md 中身份/上下文必须由宿主观测、不信模型自述的边界。

**最小修正：** Adapter 分字段记录执行身份来源与 Host 对象 ID、客户端提交输入的可见范围/manifest hash、child-parent 关联来源、输入快照、终态来源/值、输出引用与副作用快照。区分“执行身份已观测”与“人/模型身份”，不读取隐藏服务端提示。缺起始输入或终态时记录 context_unverified/terminal_unknown；如本轮要求独立 QA，则 QA_VERIFICATION_UNAVAILABLE 且不可用自审替代。语义仍须独立评审和主 Agent 裁决。

**验收：** Host PoC 分别注入同 actor、模型自称 fresh、起始输入缺失、终态缺失和错绑 child；所有未证实维度都不可升格为通过。当前未运行。

**维护影响：** CLI、native subagent、app-server 各有窄 provider adapter，核心只依赖稳定 assurance 字段；不把宿主 UUID、transcript 私有解析塞入 cycle 状态。

### C-2 — CLI 与 native subagent 可行性不同，尚不能选优

**类别/严重度：** 待验证假设/P0 入口选择，高。<br>
**位置与证据：** design-v0.md「独立 QA 与授权」「P0 Host/复用PoC」；只读检查本机 codex-cli 0.158.0 与 exec help。未调用模型。官方 [CLI non-interactive 文档](https://learn.chatgpt.com/docs/non-interactive-mode) 说明 codex exec 的 sandbox、approval、ephemeral、JSONL 和 turn terminal；官方 [Hooks 文档](https://learn.chatgpt.com/docs/hooks) 与 [Subagents 文档](https://learn.chatgpt.com/docs/agent-configuration/subagents) 说明 native subagent 的 Hook 观测边界、独立上下文和 read-only profile；官方 [App Server 文档](https://learn.chatgpt.com/docs/app-server) 说明 thread/start、turn/start、turn/completed 与 instructionSources。文档与本机 help 是能力入口，不是目标宿主实测。

| 路径 | 可观测输入/身份/终态 | 权限与未证实边界 |
| --- | --- | --- |
| 插件启动 CLI 子进程 | wrapper 自己可记录可执行文件/版本、argv、精确提交输入摘要、冻结工作区快照、cwd、PID、stdout/stderr 引用、退出码/信号；codex exec --json 暴露 thread/turn/events。它证明“该 wrapper 把这些客户端输入送给此进程”，不证明模型身份或报告正确。 | 本机 help 有 --sandbox read-only、--ask-for-approval never、--ephemeral、--json。ephemeral 只不保存 rollout，不免除本地 auth/调用费用。CLI 可读到的 user/project config、AGENTS.md、plugins/MCP 与运行期指令需在 PoC 盘点；read-only 必须在当前 Windows Host 实证。review 子命令 help 未显示相同 sandbox/approval 参数，受控候选需从普通 exec 开始。杀进程不等于观察到了 turn/process terminal；child process tree 与退出也须核对。 |
| Host native subagent | Hook 给 Host agent_id/type、父 session/turn、permission_mode；有独立 agent context/thread 的设计入口，身份比模型表单强。 | SubagentStart 不含完整初始 prompt；Stop 本身不提供 success/failure/interrupted 状态， transcript 与 last message 可能缺失。必须实测受支持 App Server/trace 能否把实际委派输入关联到 child 和终态；否则只能报告 identity observed、context unverified、terminal unknown。默认权限随 parent 继承；只读 reviewer 需实际生效的配置/profile或整体只读 parent。当前 SoL MCP 没有创建 native child 的接口。 |

**最低可实施保障/降级：** CLI 是可由插件程序化启动的新执行进程候选；需要用只读快照和受控 profile 验证 sandbox/上下文来源/终态，再谈安全保证。Native subagent 是 Host 生命周期候选；Hook 单独不足以证明精确输入与终态，需 child/prompt/event 关联 PoC。直接 app-server thread/start 是第三路径，不等于 native subagent；它有公开的新 thread 与 turn status 协议，但 SoL 目前只读 thread，不发新 inference 请求，需另行授权认证/用量。当前结论：两条主路径都“可 PoC、未验证”，不指定赢家。


**P0 PoC 设计（不在本轮执行）：**
1. 使用无秘密的隔离小仓库，固定原始需求、验收和只读源码快照；由实现者先产生一个已知行为错误。QA 包只包含 R/Q、快照 manifest 与变更，不给实现聊天记录。准备一个必须不变的写入哨兵。
2. CLI 分支由本地 wrapper 运行普通 codex exec，显式 read-only sandbox/approval/ephemeral/JSONL；登记实际输入字节 hash、命令与版本、配置/指令来源可观察范围、PID、事件流和前后文件清单。只执行一次经授权的模型调用；测试输出、进程退出和 turn terminal 是否一致，QA 是否看出已知错误，是否写了哨兵。取消时要求终态关联，缺终态记 unknown。
3. Native 分支在真实桌面 Host 委派只读 child，捕获 Hook Start/Stop 与可用的 App Server/受支持 trace；验证实际委派输入、agent_id/thread/turn、权限模式与终态能否关联。不得为 PoC 自动改用户全局配置；需要项目 reviewer profile 时先获授权并记版本。
4. 两分支都测试模型声称 fresh、child 复用、prompt 缺失/被摘要替代、写哨兵、子 agent 取消、迟到输出、最终证据归档失败。以 Host 事件、OS 文件快照和终态作断言；模型结构化报告只作为被审的输出，不作为身份/终态证据。
5. 只有 PoC 得到完整可见 client input manifest + child/process correlation + terminal + permission evidence 后，才把对应 capability 标为 verified。否则明确降低保证，且独立 QA 要求未满足时不得完成。

**外部条件与后续用户决定：** 真实模型/API/ChatGPT 计划用量、目标 Host 是否运行本地 Node/CLI/app-server、运行时能否见到 Host 事件、PoC 是否可用项目级只读配置，都不是当前源码能决定的外部条件。未来要授权一次受限的真实模型调用、文件隔离方式及 QA 输入/输出证据留存策略；目前不改配置、不安装、不运行。插件源与 SoL 共享库若要发布为依赖，也需要独立的后续实现/发布授权；本轮只确定现状不可直接 import private source。

### C-3 — 执行回执压掉了进程启动/采集/清理事实

**类别/严重度：** 已确认的 SoL 可观察性缺口；新插件设计中风险中等。<br>
**证据：** src/process.mjs:24-27 的 toCheckResult 只返回 id/status/reason/exit_code/duration/output；同文件 33-117 的 runner 另有 launch_status/capture_error/cleanup_error。src/validation.mjs:415-416 在 receipt 之前调用 toCheckResult。

**触发 → 失败 → 影响：** spawn 或输出归档失败后，调用方只取 receipt 且看到 exit_code=null → 无法区分 not_started / started but unknown / output-capture failure / cleanup failure → 误判副作用、错误重跑或无法恢复。不得按 null 自动重放。

**最小修正：** 新周期证据需保留可召回的原始 runner 事实或引用，至少含 launch_status、PID/terminal/exit signal、capture/cleanup 错误、输出完整度、operation_id、输入快照；环境秘密仅白名单/摘要，不能写出真实值。unknown 状态转 recovery_required。

**验收：** spawn 前取消、spawn 错误、取得 PID 后采集/归档失败、cleanup 失败、取消时副作用已发生、pointer 发布失败均断言实际副作用次数与恢复状态；未启动与已启动必须区分。当前 SoL 数据结构源码可读，既有测试证据不表示本轮跑过。

**维护影响：** runner/provider 是执行事实唯一 owner；核心引用 immutable receipt，Hook/MCP/状态指针不复制并修改事实语义。

### C-4 — P1 之前需要冻结有界操作合同，不宜把目前名词直接当可实现接口

**类别/严重度：** 设计风险，中高。<br>
**位置与证据：** design-v0.md 公共操作一节明确名称/数量待评审；尚无逐操作 schema / 错误 / 部分副作用 / terminal contract。核心状态和不变量写得清楚，但实现团队无法仅靠名词对齐 stale、interrupted、unknown、failed、unavailable 的语义。

**触发 → 失败 → 影响：** 两个 adapter 对 QA start/status/result 或恢复操作给出不同的 terminal/error semantics → Skill 读错下一安全动作或第二次运行有副作用的任务。

**最小修正：** 只为准备 P1 的职责冻结以下合同，不新增 DSL：
- open/restore：原 R/D 来源引用、workspace/cycle ID、exact scope/action grant、expected_version；旧版 conflict、授权缺失 denied、来源不可读 unavailable。
- capture/submit 工件：role、来源 refs、冻结输入 manifest/hash、contract version、reported vs observed 分列；结构/引用/当前性通过不得等于语义通过。
- managed write：operation_id、expected_version、精确 paths/action；先持久 pending 再操作，回传 changed paths/unknown 和证据 handle。
- verify：规则 ID + 固定配置 argv/executable/cwd identity、输入快照；回执提供 launch/terminal/output-completeness/capture/cleanup facts。模型自述“测试通过”不是执行回执。
- QA：adapter/version/capabilities、冻结 R/Q/source 输入、实际执行身份来源、parent-child/输入关联、请求/运行/完成/失败/中断/不可用/unknown 状态、输出与副作用引用。没有可核验证据时禁止标 verified。
- Delta/approval：本轮可观察用户决定来源；人工导入需标注 import source/trust level，否则仍 proposed。
- complete：执行/归档前保存 pending operation；重核输入当前性；证据归档成功后才发布 completed。失败后 public status 显示副作用 known/unknown 与下一安全动作。

**验收：** 单一 deterministic fixture 运行完整成功和取消/归档/指针失败；逐工具断言输入绑定、允许的状态转换、错误码/handle、前后副作用。Schema 检查不替代状态机和 Host PoC。

**维护影响：** Cycle core 是状态/数据 schema 的唯一 owner；Hook/MCP/Skill 分别为触发、访问与解释层。SoL 的 JS architecture/module_uid 输入保持为 SoL 的可选 provider，Python/docs-only 不配组件索引仍能使用基础 cycle。


## 端到端链

### 成功链（设计路径；Host QA 尚未实跑）

1. 从既有主控读取 R 与确认的 D 来源，确定本轮授权范围/动作类别；open 绑定来源引用、workspace/cycle、scope 与 expected_version，并固化 before snapshot。
2. 受管写入携带 operation_id、精确路径、授权与 expected_version；先持久化 pending，再在租约中复核并执行。捕获实际 diff 与 runner facts，写 I 和验证证据。
3. 用冻结 R/Q + 最新源码快照构造 QA manifest；只在 P0 验过的 provider 上启动新进程/child，记录 Host 可观测的执行 ID、输入关联、权限、terminal 和输出引用。若缺任何 required evidence，拒绝记为独立通过。
4. QA/固定检查后重取快照；任何影响输入变化都标 stale。主 Agent 检查原验收覆盖、未解决项与 Delta；complete 重核全部输入/条件、归档完整证据，最后发布 completed 指针。
5. 对外回复“完成”只引用 completed 状态、证据及已核实 assurance；本轮 facts/源码证据表明 SoL 的 open→受管写→结构化 review→complete 有一部分类似基础行为，但身份验证与新产品 Host QA 仍不存在。以上成功链是待实现设计，不宣称已跑通。

### 取消/归档或发布失败链（聚焦一个恢复路径）

1. operation/QA 已获得 ID 并写入 pending。取消到达后 provider 请求停止，并等待可观察的 process/Host terminal；只发出 kill/interrupt 而没有关联 terminal 时状态为 unknown，部分 QA 文本不是 pass。
2. 无论取消发生于何处，尽可能保存已知输出、runner 错误与工作区前后差异；不能确定副作用时保留 unknown。归档或 pointer/settlement 发布失败则 pending/recovery_required 保持，status 给出已知变化/未证实 facts 和下一安全动作。
3. 恢复为显式操作：先核实 Host/文件实际状态与历史归档；只处理未完成的存储结算，不重放已运行的模型/写入/测试。未补齐所需证据前 task_complete=false。
4. SoL 对写入 operation 的 pending、取消后 snapshot/归档、settlement failure 和 completion archive/publish failure 有源码及既有故障注入证据。新 cycle QA provider 的 cancel/terminal/副作用能力仍未 PoC。

## 最小有效验收矩阵

| 场景 | 可判定输入 | 必须观察的结果 | 当前证据 |
| --- | --- | --- | --- |
| 成功链 | 已授权 R/D、精确 scope、固定 snapshot、固定 runner、P0验证通过的 Host manifest | 绑定版本一致；实际 write/check/QA 均可归档；QA input/actor/terminal assurance 分项可读；无漂移后才发布 completed | SoL 有相邻状态机基线；新产品/Host QA 未实现 |
| 限权 | 文档-only授权后发 write 请求 | write denied；授权与原始 R 不变；无写入副作用 | 设计要求，未验证 |
| 旧绑定/越界 | stale version / 跨 cycle path | stable stale/scope error；写前阻断，不能发布完成 | SoL 有相邻检查，未针对新合同验证 |
| QA身份伪造 | 同 actor、模型声称独立/fresh、格式合法 UUID | 只记录 reported；不能升级 identity/context verified | SoL 固定 identity_verified=false；无 Host PoC |
| 输入污染 | prompt 缺失或 child 收到 parent 摘要/旧 snapshot | context 未核实或 stale；required QA 阻断 complete | 未 PoC |
| 终态缺失/取消 | Host cancel，child 无 terminal；或进程树仍运行/退出但无 final event | interrupted 或 unknown，绝不算 pass；保存已知 partial effects，不重启原操作 | SoL 外部 turn cancellation 只覆盖既有 MCP调用；新 child 未测 |
| 检查与存储失败 | spawn failure；PID后输出归档失败；final archive/pointer failure | not_started 与 started/unknown可区分；pending/recovery_required；副作用计数为一次；显式恢复不重放 | SoL 有 runner和故障测试基础；public receipt 丢字段 |
| 当前性 | QA后文件/配置变化，包括 HEAD 不变 | Q stale、completed=false、说明变更输入，不复用旧 pass | SoL snapshots/tests 有相关证据；新插件未验 |
| Host不可用/Hook旁路 | Hook未加载或MCP/provider不可用；经未覆盖工具外部修改 | unavailable/blocked或检出 drift；不宣称 Hook 提供全局权限边界 | SoL 文档化边界；目标宿主未实测 |

现有 SoL 回归证据按 facts.md 复用，不重跑。新插件最小自动化测试放在其 core 的状态/存储边界，用 deterministic fixtures 检验上表状态与恢复；不建新通用测试框架。真实 Host 权限、输入、child correlation、terminal 和调用成本必须单独由经授权的 P0 acceptance 实测；mock 测试不计作 Host 验收。

## 分期顺序与首期可交付范围

- **P0 — Host/复用 PoC（当前首期交付）：** 不碰 SoL 源码/配置。交付 CLI 与 native subagent capability matrix、一个真实受控 PoC 的输入/权限/身份/terminal/副作用证据，结论按 verified / partial / unavailable 分级；同时确定独立插件可否消费某个稳定依赖。若真实模型调用未授权，交付范围就是静态能力报告 + 尚待实测的 acceptance，不得声称 Host adapter 可用。
- **P1 — 单工作区最小 cycle：** 仅在至少一个 provider 的 P0 assurance 达到需求后实施。交付单一活动 cycle、引用原主控的 R/D、精确 scope/action grants、snapshot/currentness、不可变 I/Q/Delta references、固定 configured checks、受管 write、status/resume/abandon/recovery、归档后发布完成。基础 cycle 不要求 JS 组件登记。provider 未验证则如实限制为“可追踪但独立 QA 未就绪”，不发布完整闭环。
- **P2 — 语义/增量/Host增强：** 缺陷与新目标分流、授权来源集成、主控同步凭证、停止提示/续跑规则、额外 Host/provider。通用 DSL、通用测试框架、自动产品决策、后台循环和发布自动化不在当前首期目标；需新需求与授权。

## 分类：可由实现解决 / 外部能力 / 待用户决定

- **可由实现解决：** 状态机与 expected_version 校验、pending/归档/完成原子关系、snapshot currentness、结构化执行事实、受管 write 范围、未知状态不可重放、Host evidence 字段分级与错误响应。
- **需外部能力与 P0 证明：** 当前插件执行环境能否启动本地 Codex CLI/app-server；Codex desktop是否向插件暴露 subagent创建/事件/child输入；可用的 sandbox profile、真实进程树取消和终态；Model endpoint/auth/usage 是否能用。
- **需要后续用户授权/决策：** 一次最小真实模型 PoC 调用及其用量；是否允许项目级 reviewer profile 或隔离运行目录；保存 R/Q/源码输入摘要与原始输出的范围/保留策略；若需对 SoL 建稳定共享包，另行批准修改和发布。独立插件落点已确认，不再询问。
- **仍不可由代码保证：** reviewer 语义判断正确、模型身份/人类身份、服务端隐藏提示内容、未被 Host 控制的外部编辑绝不发生。必要时保持未验证和不完成，不能通过字段填充或流程图消除限制。

## 验证记录

- 共同事实与待审方案：D:/zzd/slop/engineering-cycle-architecture-20261007/facts.md、design-v0.md；其中最后确认独立插件。
- SoL 工作树证据由 facts.md 记录为 HEAD 7d7de9569b8e35e0582864789fd83c0c6c956b95、clean；本审查只读源码与既有测试。
- 可复用检查结果：所列 Node 测试 45 项计数 / 44 pass / 1 Windows chmod skip / 0 fail。本轮没有再次执行，也没有重新测试测试范围以外的保证。
- 官方只读资料：[Codex CLI non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)、[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Hooks](https://learn.chatgpt.com/docs/hooks)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)。本机只读 help 为 codex-cli 0.158.0、codex --help、codex exec --help、codex exec review --help。未执行 codex exec / app-server inference；无 P0 实际 Host 结论。
