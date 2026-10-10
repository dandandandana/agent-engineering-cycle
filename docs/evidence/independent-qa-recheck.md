# Agent Engineering Cycle 定向独立复验

复验对象：`D:\zzd\agent-engineering-cycle\slop\qa-df1f2fbb-9892-4a4c-8022-54495714c322`，对应新冻结输入 `df1f2fbb-9892-4a4c-8022-54495714c322`。仅在执行副本 `slop/` 放置复现脚本；未修改冻结源、实现源码、需求、验收或全局配置。

## 结论

原 F1、F2、F3 均在新副本中通过定向复验：unknown QA 仍保持 unknown；finish 归档切点恢复同一 completion 且不重跑检查或替换 Q；completion 损坏会令 `current_complete=false` 并形成 blocker。Docs mode 和 QA 输入边界的定向检查也通过。

这不关闭真实 CLI P0、真实模型 QA 或 Host 安装/Hook/MCP 验收。它们本轮没有运行，仍保持未测。

## 原反例复验

| 反例 | 状态 | 证据 |
| --- | --- | --- |
| F1：unknown QA 被当作终态 | pass | `node slop/qa-unknown-cancel.mjs` 返回 `OUTCOME_UNKNOWN`、`cancel_requested:true`、`terminal_observed:false`，后续状态仍为 unknown 且 Q 未通过。`node --test tests/recovery.test.mjs tests/safety.test.mjs tests/core.test.mjs tests/store.test.mjs` 中的回归用例还验证 abandon 与新 start 均阻塞，未调用 QA action，也未登记新 operation。 |
| F2：completion 归档后中断不可恢复 | pass | `node slop/qa-finish-recovery-recheck.mjs` 注入 archive 后发布前故障；resume 成功，`runner_replayed:false`，旧 finish operation 结算，current complete，check ref/计数和 QA job/report 未变，completion archive 仍只有一份。测试套件还验证源在切点漂移时 resume 回到 active、保留 stale candidate，不发布完成。 |
| F3：completion archive 损坏仍宣称 complete | pass | `node slop/qa-finish-archive.mjs` 损坏 archive 后 `store.evidence()` 拒绝该证据，status 返回 `current_complete:false` 和 `EVIDENCE_INVALID` blocker。回归用例覆盖删除和 cycle identity 篡改。 |

F1/F2/F3 原复现脚本已复制到新执行副本 `slop/`；额外的 finish recovery 核对脚本也只在该目录。

## 新边界复验

| 边界 | 状态 | 证据 |
| --- | --- | --- |
| Docs mode 拒绝运行任意配置命令 | pass | 定向 `tests/safety.test.mjs` 验证带写入副作用的命令在启动前以 `SCOPE_DENIED` 拒绝，哨兵源码不变且没有 operation。内建 `source-integrity` 返回 `launch_status:not_started`、`exit_code:null`，不会伪称启动了检查进程。 |
| QA 输入须来自真实完成的 MCP 读取并覆盖分页 | pass（本地合同） | `tests/safety.test.mjs` 的事件合同检查 list-only、分页缺口、错误 hash 不完整；实际 `tests/qa-sources.test.mjs` 启动私有 MCP server，验证只暴露只读 list/read、两页合并后字节与原文一致、越界路径和快照篡改被拒。Fresh/session 字段不能由模型报告 schema 自行提供。 |
| 私有只读 portal 交付原目标、Action mode、检查事实，不交付 I verdict | pass（portal 本地行为） | `node slop/qa-context-portal.mjs` 对私有 `qa_source_list` MCP 进程发实际 JSON-RPC 请求，返回的 `qa_context` 与传入 original_goal、docs mode 和检查事实一致，且没有 `I_verdict`。此结果证明本地 portal 接口行为，不证明真实 CLI/Host 消费了该调用。 |
| malformed/failed CLI 事件不形成通过 | pass（代码路径；未做真实 CLI 调用） | `runCliQA` 对非法 JSONL 保存 `capture_error` 并强制 `receipt.passed=false`；成功条件要求 `turn.completed` 且 exit code 为 0；worker 将 `turn.failed` 记为 failed，缺终态记为 unknown。没有调用模型或真实 CLI。 |
| 原始 check/verification 证据当前性 | pass | 定向 recovery suite 覆盖损坏 check archive 和 verification archive 均阻止 finish；`view()` 重新验证当前 basis、verification ref 和每个 raw check ref。 |

## 实际运行检查

- `node --test tests/recovery.test.mjs tests/safety.test.mjs tests/core.test.mjs tests/store.test.mjs`：45/45 通过。
- `node --test tests/qa-sources.test.mjs tests/workspace.test.mjs tests/check-runner.test.mjs`：22/22 通过。
- `node slop/qa-unknown-cancel.mjs`：F1 反例现在保持 unknown。
- `node slop/qa-finish-recovery-recheck.mjs`：F2 恢复成功且 runner/check/Q 未重放。
- `node slop/qa-finish-archive.mjs`：F3 archive 损坏后 current complete 被撤销。
- `node slop/qa-context-portal.mjs`：原目标、模式、检查事实由真实本地只读 MCP list 响应交付；不含 I verdict。
- 未运行 `npm test` 全套、`npm run check`、模型、真实 Codex CLI 校准或 Host 插件安装。无需网络、全局安装或外部用量。

## 未测与保留边界

真实 CLI JSONL/Host 实际暴露的 `mcp_tool_call` 事件、真实 QA 会话独立性、sandbox/权限证明以及插件安装后 Hook 覆盖仍未通过 live 验收。`sourceDelivery` 的事件合同和私有 portal 的本地调用分别通过，但不能据此宣称真实 CLI Q 已可用；这些能力应继续保持 blocked/unknown。
