# C 实现与 Eval：v1 定向可实施性复核

日期：2026-10-07<br>
范围：仅复核 design-v1.md、acceptance-v1.md 与 review-C.md 指出的实现/Eval问题。不跑测试、不调用模型、不改 SoL。本报告不是实现或真实宿主验收。

## 结论

v1 采纳了前轮最关键的三项意见：P0 是能力门而非文档证明；CLI/native 均为待验证候选；运行回执明确保留 launch/capture/cleanup 与效果已知性。冻结输入副本、pending/outcome/settle、权威写回逐项恢复、archive-before-finish 也形成了可实现的状态链。尚无新插件实现或 Host PoC，不能称任何 adapter、lease、取消、决策来源或权限已运行验证。

剩余三项实质问题如下；前两项属于 P0 release gate 清晰度，第三项属于七工具进入 P1 前需冻结的契约。

## 发现

### C-V1-1：AC-09 要求两种 QA 候选各实际调用一次，与候选不可用/授权不足的 P0 分支未对齐

**类别/严重度：** 设计/验收风险，中高。<br>
**位置：** design-v1.md §8 第125–130行、§12 第169行；acceptance-v1.md AC-09、P0 go/no-go 第32–36行。<br>
**触发 → 后果：** CLI 或 native subagent 在目标宿主不可启动、输入/终态不可观察，或真实调用尚未获授权 → AC-09 按字面必须两边都做一次真实 fresh QA → P0 无法以“不可用/未授权”关闭，或为了完成矩阵额外消耗一次模型调用；这和设计中的不可用/降级出口及“CLI 先考察、未实测不选赢家”发生歧义。反过来，如果只跑 CLI 就选它，也违反“未 PoC 前不选赢家”。

**最小修正：** 将 AC-09 结果按 provider 分别记录为 not_attempted / blocked_by_authorization / unavailable / failed / passed；只对实际可用且已获授权的候选做 live call。若 P0 决策要求两路线对比，则明确两次调用均需另行授权；否则不把第二个 provider 的 live call 作为 release gate。未实测的候选仍是 unknown，不能据 CLI 优势先判赢家。首版默认只可从满足所有 required assurance 的实测 provider 中选择。

**验收：** 单边不可用或未授权时，PoC 记录能关闭“该 provider 未证明”这一事实，但 QA能力仍未就绪；双方均实测时才允许比较事实并作版本化选择。真实输入/身份/terminal/权限信号仍按 AC-09 检查。当前未执行。

**维护影响：** P0 矩阵以后新增 provider 时沿用每 provider 的可观测证据和授权状态，不把候选数量转化为强制模型调用数。

### C-V1-2：P0 DecisionAdapter 失败时，P1 写能力的禁用矩阵还不够直接

**类别/严重度：** 设计风险，高（涉及动作授权）。<br>
**位置：** design-v1.md §7 第103–109行、§12 第169–171行；acceptance-v1.md AC-03、AC-11。<br>
**触发 → 后果：** P0 不能从目标 Host 取到可信用户决定/许可来源，但 P1 仍按“实现七操作”上线 cycle_control/cycle_apply/cycle_reconcile → runtime 有来源绑定但无可核验的写授权 → 实现者可能把模型输入、历史文本或 imported 字段误当作 ActionGrant。设计虽规定 DECISION_UNVERIFIED 和只启用 P0 通过的能力，却未把“哪些操作/模式可继续”写成验收结果。

**最小修正：** 在 P0 go/no-go 增加 capability-to-tool gate 表：DecisionAdapter verified 才能启用 docs/implement 的受管 write/delete、Delta approval 和权威写回；若未验证，只开放 inspect/status/受限来源捕获，写/批准/finish返回 DECISION_UNVERIFIED。QA driver 未验证时允许保留非独立检查，但对要求独立 QA 的 cycle 停在 ready_for_external_qa，finish 不能标完成。AC-03 / AC-11 覆盖“P0 未通过仍尝试 mutation”的负例，并核对无文件变化。

**验收：** 同一配置分别给有效 DecisionEvidence、reported/imported/旧来源、缺失/伪造来源；仅有效证据可令指定动作进入执行。失败时连 cycle_apply 副作用前状态也可见；不能以运行 Skill 或模型说“用户批准了”越过门禁。当前只是文档条款，未验证。

**维护影响：** 每个 adapter/profile 只公布自己 P0 已过的 capability；MCP/Hook 从同一表生成启用/拒绝投影，避免 profile、工具说明与核心各自维护授权规则。

### C-V1-3：七工具的全局错误类和副作用原则需落到“每工具错误→状态→可知效果”表后再实现

**类别/严重度：** 实施合同缺项，中等。<br>
**位置：** design-v1.md §6 第83–99行；§9 第136–144行；acceptance-v1.md AC-04–06、AC-13–14。<br>
**触发 → 后果：** 同一错误可由不同工具边界发生（例如 cycle_apply 第一目标已写、第二目标写入失败；cycle_reconcile 多文件写回中断；cycle_control.finish 已归档但 pointer 发布失败；cycle_qa 取消但 Host 终态缺失）→ 现有错误枚举与统一响应给出错误来源/通用状态，却未说明各工具必须返回哪个错误类、保留哪个 operation/job binding、effects_known 如何映射、同 request 的再次调用应返回哪种终态 → MCP调用方可能继续、重试或把部分副作用当整体失败。§6 明确输入 schema 尚需 P1 冻结，合理；但错误/局部效果映射必须先于 P1 实现冻结，否则 AC 虽能要求“正确”却不能裁定唯一契约。

**最小修正：** 保留七工具边界；在开始 P1 前增加紧凑表，每个工具/动作列出：前置条件与binding字段、幂等键、预写持久化点、各错误码、失败返回的稳定状态与 operation/job/evidence 引用、局部效果 known/unknown、相同 request 重试行为、status 恢复动作。重点至少覆盖 cycle_apply 目标部分写、cycle_verify launch/capture/cleanup 失败、cycle_qa cancel/late result、cycle_reconcile 第三态冲突和 cycle_control.finish 最终发布失败。公共通用错误字段仍可共享，不需要重复完整 schema 或增加 DSL。

**验收：** 以确定性故障注入逐工具断在上述持久化/副作用/settle点，断言同一 request 可查回唯一 operation，回执保留 launch_status、terminal/exit/signal、capture_error、cleanup_error、output completeness、changed_paths_known/outcome_ref/settle status；status 显示确定的下一动作，不发生第二次 runner/写入。与 AC-04–06、AC-13–14 一一映射。当前合同意图已存在，细节尚未展开或实现。

**维护影响：** 状态owner仍是 CycleCore；Store/runner/Host 各自产生原始事实，由单一 transition 表决定公开语义，MCP/Hook 不自行推断错误或重放。

## 可采纳条款与当前缺口

可采纳为 v1 设计基线的内容：

- 七工具职责分界清楚；begin/resume/abandon/finish、status、artifact、apply、verify、QA、reconcile 的副作用范围合理，没有要求依赖未发布 SoL 核心。
- §9 的 pending → outcome → archive/pointer → settle、未知不重放、同 request 去重、QA 长任务释放租约后复核basis，能支撑失败恢复；AC-04–06 对关键计数与unknown行为有可观察断言。
- §8 的不可变输入副本避免以起止hash掩盖 A→B→A；AC-07 检验冻结实际输入。§10 与 AC-13 分别处理权威写回的后态、前态、第三态。
- §10 的 finish 核对当前basis/同步/未完成操作，归档后再次检查再发布；AC-14 覆盖归档损坏和发布前漂移。历史 completed 与 current_complete 分离是正确的恢复语义。
- §9 明确公开回执不得剥除 launch/capture/cleanup；AC-05/06 观察启动、terminal、effect 与恢复结果。这正好消除前轮 review-C 的 receipt 可诊断性问题，属设计已采纳，实施时还需验收。

仍需实验的项目（本轮未做，不能宣称 passed）：

- AC-09 的实际 Host CLI/native 输入传递、child/process身份关联、readonly副作用哨兵、正常终态、取消终态；CLI 是先考察的候选，不代表预选赢家。
- AC-11 的 DecisionAdapter 源事件、普通用户输入与自动续跑/模型填表区分、ActionGrant scope 绑定；不可行时按 C-V1-2 降级。
- AC-02 的跨进程 lease/CAS/crash recovery；AC-05/06 的启动/捕获/清理真实细节；AC-13 的多文件同步各切点和外部第三态；AC-14 的最终 archive/pointer 顺序；AC-15/16 的具体目标 Host Hook 覆盖与失败模式。

## 当前裁决建议

前三项最小澄清落入 design-v1.md / acceptance-v1.md 后，七工具与成功/失败主链足以进入按模块 owner 拆分的 P0/P1 实施准备；任何“P0通过/verified”的说法须由目标 Host 原始证据支持。本次只读评审未验证代码、测试、Host或模型效果，P0 go/no-go 仍未达成。
