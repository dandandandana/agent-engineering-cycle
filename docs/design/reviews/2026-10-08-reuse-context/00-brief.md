# 组件复用与 Hook 上下文控制：评审前事实包

日期：2026-10-08。此文件固定评审前提案，不是最终合同。范围：审查架构并交付设计、实施文档；不实现运行时代码、不修改全局安装、不运行模型 benchmark，不提交或发布。

## 用户目标

有效组件复用优先。写代码前检查已有组件的真实接口、实现和调用方；复用 codex-sol 的发现能力。独立 engineering-cycle 插件继续拥有工程状态、QA 和产品写入控制。Hook 注入应控制内容、时机和权限，不依赖一大段 Skill 维持约束。用户已同意这个方向，并要求 design-review-council 独立审核。

## 已核对基线

- engineering-cycle 已有七工具、固定 argv 检查、binding/source identity、授权 receipt、pending/outcome/settle、冻结输入的独立 CLI QA。当前配置 schema_revision=1，无组件 provider、复用计划或注入预算配置；现有安装 0.1.0 不含此增量。
- `src/runtime.mjs` 当前 Hook 在 SessionStart/UserPromptSubmit/PreToolUse 返回状态摘要；只匹配原生 apply_patch/Edit/Write，Stop 返回空对象。当前没有 session 注入账本与语义去重，不保证任意 Shell/外部编辑器受控。
- SoL 全量 server/runtime/context/native Hook 包含自己的写入工具、会话状态及流程 instructions。只关掉某个 Hook，仍无法证明只有一个流程控制器。
- SoL 已有 ArchitectureIndex 与 sol_architecture_query、sol_read_file、sol_recall。静态查询可以给出登记、exports、importers、位置及源 SHA，但不是完整调用图或运行时复用证明。当前没有独立的 provider-only 产品入口；不能把草案当已实现能力。
- 博客旧评分：41/41 行为、88/96 合规、严格成功 2/8、严格有效复用 4/25；实际调用观测 19/25。六题有登记文案变更导致旧严格分母门禁，B04/B07还有复制函数体。来源：`docs/evidence/benchmark-blog-20261008.md`。不得改旧分数或据此声称 Hook 是费用、质量的因果来源。

## 同一初始提案（待裁决）

1. engineering-cycle 为产品写入、R/D/I/Q/Delta 状态和上下文流程的唯一 owner。SoL 提供单独、可分发的组件发现入口，复用既有索引与读取实现；不加载 ChangeEngine、写工具、流程 instructions 或 Hook。仍保持独立插件，不复制索引解析器或私有跨仓 deep import。
2. 新能力按项目显式启用。provider 路径/启动参数/版本能力来自操作者配置和可核验 capability，而非模型给出的 command。缺失时明确 unavailable；原有非集成项目继续工作。未配置只读查询仍不得初始化 Store 或启动 peer。
3. 在 implement/source-write 前持久化有源身份的复用决定，分别为复用、兼容扩展、必要新实现。读真实接口/实现/调用方；解释不适配原因。沿用 D 工件与七工具，不预建通用 provider DSL 或每函数台账。backend 对绑定/目标/源及登记变化检查当前性，不能用 Hook 提示替代门禁。
4. provider 查询返回值、登记文案、源码/注释都是待验证数据，不能直接成为批准、写入许可或 Hook 高优先级指令。依赖身份与结果写入证据；查询发现并不等于已完整读取或语义适配。
5. Hook 只给任务/阶段/复用状态/主要 blocker/下一工具。初始预算 2 KiB UTF-8，完整内容按需 MCP 读取。预算仅覆盖本集成拥有的 summary，不能声称控制宿主所有上下文。语义状态去重按 session + task；首次/恢复重发，普通无变化提示静默。未获 delivery acknowledgement 时不把“已生成”当“模型收到”；省略 Hook 仍由 backend 检查。
6. 写后核对实际数据流/调用方与行为，拒绝为了得分加无用调用或复制函数体。静态调用与真实运行证据分列；承认真正不适配、性能复杂度和 uncovered。优先复用项目固定检查和冻结 QA。
7. benchmark 新版本把功能、合规、实际/有效复用和说明质量分列，明确 eligible/opportunity 与理由；保留原八题/25个机会、旧严格评分和原始证据。先冻结标准再跑开关对照。本轮仅定义验证计划，不运行或追认新分数。

## 共同必须检查的问题

- 单一写入 owner 是否只是文字承诺？provider 的启动、能力、工具面和全量 SoL 冲突如何核验？哪些事实目前无法观测？
- 复用决定依赖哪些身份、目标和阅读证据？自报读取/模型理由是否会被误当程序保证？如何避免重复台账、死锁和恢复重放？
- 当前配置/七工具的最小演进合同是什么？文档/私有小修应如何准确分类，不让模型任意关闭门禁？
- 多聊天同工作区、去重漏提醒、UTF-8预算、恢复/compact、source/registry漂移、provider超时及 unknown effects 怎么处理？
- 如何设计能判别真实复用与 dummy call/clone 的验证，并让旧分数不被污染？实施次序与跨仓分发兼容是否可实际落地？

## 只读证据入口

工程循环：`D:/zzd/agent-engineering-cycle/src/runtime.mjs`、`src/core/contracts.mjs`、`src/core/cycle.mjs`、`src/local/config.mjs`、`src/local/store.mjs`、`src/local/workspace.mjs`、`src/local/implementation-notes.mjs`、`hooks/hooks.json`、`src/server.mjs`、`scripts/package-plugin.mjs`、`skills/agent-engineering-cycle/SKILL.md`。

既有合同和证据：`docs/design/architecture.md`、`docs/design/acceptance.md`、`docs/design/implementation-notes.md`、`docs/IMPLEMENTATION_STATE.md`、`docs/evidence/benchmark-blog-20261008.md`、`benchmarks/blog-score.mjs`。

SoL：`D:/zzd/codex-sol/src/runtime.mjs`、`src/server.mjs`、`src/context-hook.mjs`、`src/native-hook.mjs`、`src/architecture/index.mjs`、`src/architecture/session.mjs`、`hooks/hooks.json`、`src/plugin-launcher.mjs`、`scripts/package-plugin.mjs`、`package.json`。入口更正：SoL 没有 `src/cli.mjs`；最初事实包列错了路径，三个 reviewer 同时收到此更正。

评分器：`D:/zzd/blog-eval/evals/rubric.mjs`、`evals/runner.mjs`，必要时查看 fixtures 中实际接口/调用方。

## 评审输出与限制

四个独立角色：A 设计/合同、B 红队、C 实施/Eval、D 维护。每个收到本事实包与自己的重点问题，不预先互传结论。只读；不得写文件、运行模型、启动插件/浏览器/全局配置或再派子 Agent。请返回可完整归档的中文报告，按确认的源码缺口、设计风险、未验证假设和偏好区分；每项给 severity、具体触发、路径/符号证据、最小修正及判别验证。主 Agent 最终逐项采纳/不采纳/待验证，评审结论不代表运行时验收。
