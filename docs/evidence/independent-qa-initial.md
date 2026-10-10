# 独立 QA 报告：Agent Engineering Cycle 插件

对象：冻结输入副本 `D:\zzd\agent-engineering-cycle\slop\qa-da54f716-fc25-4630-969e-9d8d332278c4`。仅读取该副本；未读取实现者报告、原始 I 或评审判词，未改源码、需求或全局配置。

## 结论

发现 3 个可复现的运行时缺陷，涉及 QA unknown 终态、finish 发布恢复和完成归档完整性。`npm test` 的 58 项均通过，但没有覆盖这三个边界。独立 CLI QA/真实宿主能力按本任务限制未运行；测试中的受保护 QA fixture 只用于验证完成门逻辑，不能算独立 QA 成功。

## 验收状态

| AC | 状态 | 独立证据与边界 |
| --- | --- | --- |
| AC-01 | not-run | 未对实际 Python/文档项目执行完整 adopt 与原 R/I/NEXT 接入；不从静态源推断完成。 |
| AC-02 | pass | `npm test` 覆盖两个独立 Node 进程的 lease 竞争和本地写入顺序；真实 Host/MCP 并发未测。 |
| AC-03 | pass | 58 项套件覆盖 docs 权限拒绝代码写入、越界路径、旧 binding、缺失/不可信 grant；不是完整平台安全证明。 |
| AC-04 | pass | 同 request 去重、同 ID 改参冲突和已发生写入后不重放用例通过。 |
| AC-05 | fail | unknown QA outcome 的取消响应错误报告 terminal_observed=true，见 F1。 |
| AC-06 | fail | finish completion 已归档、发布前故障后无法按原 operation 恢复，见 F2。 |
| AC-07 | pass | `workspace.test.mjs` 实测冻结字节经活动源 A→B→A 后保持 A，并检测快照篡改；未运行真实 CLI QA。 |
| AC-08 | blocked | 未获准运行真实独立 QA；模型/会话/权限/终态保证没有 live 证据。 |
| AC-09 | blocked | 未执行 CLI 校准或模型调用。能力候选应保持未验证，不能开放真实独立 QA。 |
| AC-10 | pass | 测试确认 QA 配置变化使旧 Q/检查不再 current，同时保留历史证据。 |
| AC-11 | pass | 测试覆盖不可信 user 来源/跨工作区 receipt，以及精确 Delta 决定不扩大 docs grant；未作真实人类身份认证声明。 |
| AC-12 | not-run | 未执行“批准 R2、只同步文档”的完整原主控场景。 |
| AC-13 | pass | 测试覆盖多文件 before/after/third-state 结算，外部第三态不被覆盖。 |
| AC-14 | fail | 完成归档损坏后 status 仍返回 current_complete=true；finish 发布切点也无法恢复，见 F2/F3。 |
| AC-15 | pass | 当前 runtime 将 Stop continuation 明确关闭且 Stop 返回空响应，不会生成重复 continuation 或阻止 turn；真实 Host Stop 语义未测。 |
| AC-16 | blocked | 受管 apply 有后端 scope/binding guard，Hook 只声称匹配写工具；实际 Hook 超时/宿主拒绝行为及 MCP 断连未做 Host 验收。 |
| AC-17 | not-run | 未构造原要求失败并提议放宽的完整语义裁决场景。 |
| AC-18 | blocked | 未执行实际插件发现、安装、宿主重启、取消与恢复验收。 |

## 可复现缺陷

### F1 — unknown QA 被当作已观察终态

分类：AC-05、AC-06；严重性：高。

当持久 job outcome 为 `status: "unknown"` 且 `terminal_observed: false` 时，`jobOutcome()` 仍返回 truthy 对象。`qaAction(cancel)` 以对象存在判断终态，于是返回 `cancel_requested:false, terminal_observed:true`；QA start 的相同 truthiness 检查也会把该 unknown 当成可重启条件。结果是程序对相同未知事实给出相反状态，并允许对未证明终态的旧 job 发起新 QA。

位置：[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:77)、[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:222)、[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:344)。

触发命令：`node slop/qa-unknown-cancel.mjs`。脚本在一次性测试工作区写入 `unknown/terminal_observed:false` 的已持久化 job outcome，然后走实际 `cycle_qa cancel` 入口。输出显示持久记录仍是 unknown/false，cancel 响应却是 terminal_observed=true，后续 status 仍是 unknown/QA 未通过。

最小修正：将“有 outcome 文件”与“已观察终态”分开判断；cancel 只有在明确终态观测为 true 时才返回 terminal，unknown 继续阻塞新的 QA start，并保留原 job 供 status/恢复查询。增加 unknown outcome 的 cancel 和 start 回归用例。

### F2 — completion 归档与 operation 结果之间有不可恢复切口

分类：AC-06、AC-14；严重性：高。

finish 先写 completion archive，再触发 `before_finish_publish`，而操作级 outcome/ref 直到 `perform()` 返回后才写入。若两者之间中断，completion archive 已存在，operation 却是 `unknown` 且无 `outcome_ref`；之后 `resume` 因缺 operation outcome 返回 `OUTCOME_UNKNOWN`，无法结算已存在的归档，也不会完成恢复。

位置：[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:267)、[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:164)、[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:201)。

触发命令：`node slop/qa-finish-cut.mjs`。注入点位于 completion archive 写成功之后、finish 发布之前。结果为 `completion_archives_written:1`、operation `unknown` 且没有 outcome ref，status 有 `OUTCOME_UNKNOWN`，resume 仍返回 `OUTCOME_UNKNOWN`。

最小修正：让 completion archive 可由 operation ID 唯一回查，并在发布切点前持久化可恢复的 operation outcome；恢复时验证 archive 与当前 cycle/basis，再结算，不重跑检查或 QA。覆盖 completion archive 后每个持久化切点的故障注入。

### F3 — status 不验证已完成 cycle 的 completion archive

分类：AC-14；严重性：高。

`view()` 的 `current_complete` 只要求 lifecycle 是 completed 且 blocker 列表为空；它不验证 `state.completion_ref` 指向的归档存在、digest 有效或归属当前 cycle/basis。因此完成记录损坏后，status 仍宣称当前完成。

位置：[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:34)、[src/core/cycle.mjs](D:/zzd/agent-engineering-cycle/slop/qa-da54f716-fc25-4630-969e-9d8d332278c4/src/core/cycle.mjs:66)。

触发命令：`node slop/qa-finish-archive.mjs`。先通过现有 fixture 完成 cycle，再损坏其 completion archive；`store.evidence()` 已拒绝该 archive，但 status 仍返回 `current_complete:true` 且无 blocker。

最小修正：status 计算 current_complete 前验证 completion ref 的内容身份、cycle/basis 及其引用证据；损坏或缺失时保留历史 lifecycle，但返回 current_complete=false 和明确 blocker。对检查归档也应在 finish/status 中验证，而不能只信任 current.json 中的 passed/basis 字段。

## 验证记录与未测范围

- `npm test`：通过，58/58。它是项目自检；上述三条独立边界复现均另行运行，故套件通过不覆盖其结果。
- `node slop/qa-unknown-cancel.mjs`：失败复现，见 F1。
- `node slop/qa-finish-cut.mjs`：失败复现，见 F2。
- `node slop/qa-finish-archive.mjs`：失败复现，见 F3。
- 未运行 `npm run check`：其中的依赖审计需要联网，本任务禁止联网。
- 未运行真实模型、Codex CLI 校准、真实插件安装或 Host Hook/MCP 验收；相关能力仍 blocked/unknown。没有修改冻结副本源码、验收文档或任何全局配置。四份最小复现脚本仅位于冻结副本的 `slop/`。
- `node slop/qa-unfinished-stop.mjs`：在真实运行时创建 active cycle 且保留 blockers；PreToolUse/Edit 返回 deny，Stop 返回 `{}`，cycle 仍 active/unfinished。
