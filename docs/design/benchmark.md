# Benchmark 设计与评审记录

目标来源：2026-10-08 用户要求“安装这个工具，然后针对这个工具写一个 benchmark”。插件已真实安装启用，本轮不重复删除安装，也不扩大 Codex-SoL 职责。继续使用原 [实施状态](../IMPLEMENTATION_STATE.md)、[函数说明合同](../../skills/agent-engineering-cycle/references/implementation-notes.md)，bench 命令和指标权威见 [benchmark 说明](../../benchmarks/README.md)。

## 本轮接受标准

| ID | 可观察结果 |
| --- | --- |
| BM-01 | 不依赖模型的后端门禁使用真实 runtime/文件，明确 synthetic 授权和未覆盖 QA 门；生产 API 不因 benchmark 改变 |
| BM-02 | 两个正确初始案例、固定 oracle/no-op、隐藏行为断言与可发现常见错误的回归；代码正确性不能来自模型自报 |
| BM-03 | baseline/Skill/plugin 相同目标与初始源码；固定参数、seed、重复数、新会话、实际加载和使用证据 |
| BM-04 | 说明由新会话按固定事实评价；gold 与错误/诱导负控先通过；内容与 byte freshness 分开 |
| BM-05 | 真正执行后续维护，验证增量和原行为，并对维护后实际说明重新评分 |
| BM-06 | 完整计划分母、超时/捕获/清理事实和原始产物保留；新 output，不重放未知操作；绑定输入变更使结果失效 |
| BM-07 | 可重复命令、JSON/Markdown 报告、安装现状与有效范围说明；无提交、发布、版本变更或无关项目修改 |

## Council 裁决

三名独立只读 reviewer 覆盖 A 架构、B 反例、C 实现/Eval + D 维护；主 Agent 负责决定和可执行验收。采用 A 的“同一正确源码写说明，再交给新维护者”；采用 B 的外部固定内容分母、错误且 hash 当前的反例、完整失败分母与实际宿主调用证据；采用 C/D 的公开 runtime/固定 runner 复用和两份小案例，避免建立通用评测平台。

本轮采用“后端合同 + 说明语义 + fresh 维护”的分层指标。完整 QA/finish 与长期对话抗偏移延期，报告不得借已有 TUI 成功推导这些模型收益。三臂整体差异也不能单独归因 Hook/MCP/Skill 中某一个组件。未使用 SoL 八项博客 evaluator；未取得 Gemini 工具，不声明 Gemini 参与。

上述是首轮小型三臂试验的历史范围。用户随后指定“在 Codex 安装插件，依旧做博客项目，用 benchmark 跑分”，本轮增量复用现有 `blog-eval-v1` 固定八题和原独立评分器，SoL 只作为评分库。新增博客入口和说明/协议/浏览器维度，不修改旧三臂设计或评分历史。分母固定为 8 项任务、41 项行为、96 项合规、25 项复用和 32 项说明 criteria；本轮只跑一次插件开启的 cohort，不宣称因果收益。

独立 QA 反向检查发现：维护后的说明未重新评价；MCP business error 被当成成功调用；隐藏测试遗漏 quantity 必填；worker 失败未存外层事实；认证链接首个清理失败跳过后续。分别增加当前代码/说明复评与增量判据、真实业务结果/最终写入 hash 校验、缺失/undefined 回归、wrapper 原始回执和未知终态停止，以及逐项清理回归。原反例和限制保留，复验结果由实施状态链接实际证据。

真实首轮调试记录亦保留：v1 的隔离 plugin-list 在 30 秒超时，无模型 trial；v2 的 gold judge 返回 Markdown 包裹及非连续引用，literal 校验拒绝且 trial 保持 not-run。改为使用已成功的本地安装回执/安装文件核验，并明确要求每项一个连续原文引用；未降低内容判据或把失败改成通过。

后续实测进一步将引用改为路径/行号、由 harness 提取实际正文；judge 的工作目录改为匿名 UUID。v4 暴露 CLI dotted override 保留引号导致 plugin ID 无效，插件臂转为读取官方安装器在自有隔离 home 写入的配置；未触碰原用户配置。最终 v5 真实试跑三臂各 1 例，说明/维护/同步说明均通过，插件组实际 Hook/MCP 生效。独立 QA 最后复现 CRLF 跨行引用误拒绝，已改为原文偏移切片，保留严格 substring 检查；对已冻结 v5 模型输出做确定性复评，避免为换行修复重新消耗模型。v5 原始报告保留当时输入身份，当前修复另有验证记录。
