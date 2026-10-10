# 工程循环插件架构：共同事实包

日期 2026-10-07。当前用户授权：使用 design-review-council 先做 Hook + MCP + Skill 的架构，参考 D:/zzd/codex-sol。仅设计/评审；没有授权实现、安装、全局配置修改、提交、推送或发布。

## 用户目标与已确认方向

参考对话 Agent实现文档的重要性（6ac60924-9d1c-83e8-902d-92f4d7ae1a5c）已在本聊天完整读取：需求 R → 设计 D → 实现状态 I 与代码 → 独立 QA Q → 缺陷修复或需求 reconciliation → 下一轮。Agent 承担可调查和可决定的工程劳动；用户处理剩余的关键产品/兼容/权限决定。

已完成的 agent-engineering-cycle Skill 在 C:/Users/dandandandana/.codex/skills/agent-engineering-cycle/，覆盖原需求、实现状态、独立 QA、证据绑定和增量。6 个 UTF-8 文件、结构与本地引用通过，三类离线前向样例和一次源码漂移复验通过。它是指令层，不是强制执行器。

本次要把可程序确定的状态/不变量交给实际运行时，Skill 保留需求/设计/语义判断，Hook 触发/预检/提醒，MCP 承载受控操作。Hook、MCP 应引用同一状态事实源；模型自述不是执行或 QA 身份证明。

落点已由用户明确选择：**独立插件，参考 codex-sol**。保持产品/周期领域独立，本轮不修改 codex-sol。design-v0.md 的两个落点段落保留为决定前草案，读文末确认；最终架构只按独立插件继续，不重复询问或把扩展SoL作为当前推荐。底层真实复用方式仍需据可用接口和分发成本裁决。

## 当前原始源码与证据

- D:/zzd/codex-sol 干净工作树，HEAD 7d7de9569b8e35e0582864789fd83c0c6c956b95，分支 codex/linux-adaptation；已核对 GitHub 同分支相同 SHA。默认分支 codex/v0.1 较旧。
- src/runtime.mjs::createSolRuntime / configureRuntimeChanges：Hook、MCP 共用的无传输组装；包含 ObservationStore、ValidationEngine、ContextEngine、ContextSessions、ChangeCoordinator。
- src/server.mjs::createSolServer：实际 MCP 注册；默认4工具、纯Context6工具、架构13工具；server instructions 明确 Context 不清除聊天历史、结构接收不是完成。
- src/architecture/context.mjs：配置角色、sources、output_schema、blocking_field、consumer字段映射，prepare/submit 绑定任务与版本；context.example.json 当前示例为 plan→implement。
- src/architecture/change.mjs：changeOpenSchema 要 requirement_ref、module_uid scope、acceptance、architecture query/version 和 reuse；当前业务围绕模块归属/组件复用，不是通用工程循环。assertWritableLocked/preflightWriteLocked 对 task/change/version/scope/状态再核验；review 保存来源与版本；complete 检查累计规则并归档再发布；status 查漂移不自动执行runner。
- 同文件约703行：复核方式保存 method.reported，并明确 identity_verified:false。self_review/separate_review 是调用方声明，不证明执行者独立。
- src/context-hook.mjs::handleContextHook：SessionStart/UserPromptSubmit/PreToolUse/Stop；读取共享核心。只覆盖匹配工具；Stop 最多一次可执行续跑，blocked/interrupted 等保留 unfinished，可退出，不无限阻塞。
- src/records.mjs、store.mjs、workspace-snapshot.mjs、workspace-lock.mjs、managed-write.mjs、validation.mjs：归档、校验读取、快照、跨进程租约、受管写入、真实检查回执。旧证据与新状态分开；未知已执行效果不自动重放。
- .codex-plugin/plugin.json、plugin.json、hooks/hooks.json：Hook/MCP插件接入。git ls-files 未发现正式 SKILL.md；引导主要在 MCP instructions 与 Context。
- package.json：Node>=20.8，private:true，没有发布的核心库/exports 契约。已安装依赖包括 MCP server SDK、zod、ajv、yaml；不能假定跨仓库直接import私有文件是可分发复用。

本聊天上轮实际运行 node --test --test-reporter=spec tests/change-hooks.test.mjs tests/context-change-hook.test.mjs tests/closure.test.mjs tests/change-recovery.test.mjs，45计数/44pass/1 Windows chmod跳过/0fail。同源码同环境证据可复用，不重跑。项目历史宿主证据见 fixtures/host/README.md；真实长期模型、Desktop全流程等仍未本轮验收。

官方Hooks资料已读取：https://learn.chatgpt.com/docs/hooks 。支持事件/工具有覆盖边界；部分工具可绕开默认路径，callback错误/超时可能放行；MCP hooks需要已连接server；Stop block是继续提示，不是拒绝整轮。必须验证当前目标宿主，不把Hook当完整安全边界。

## 硬边界

- 无源码改动、无独立QA运行或真实宿主试验；本次只给设计与可执行验收计划。
- 原项目/PRD/蓝图保持权威；不强制另一套PRD，不把候选新功能自动实施；原需求失败不能改标准遮盖。
- R/D/I/Q/Delta、代码、测试、配置和运行环境需可回查版本/来源；实现、验证、批准、完成分列。
- 不把模型填写 qa actor/method/fresh_context=true 当可信身份/上下文证明；宿主拿不到所需证据时如实声明不能达到该保证。
- 程序能核对身份/版本/结构/执行事实，但不能证明需求理解或QA语义判断正确；独立QA和主Agent仍负责任。
- 不假定能阻止用户或任何未覆盖Shell/外部编辑；受管操作门禁与变化检测分别报告。
- 只采集用户授权、客户端可见的执行/输入证据，不捕获隐藏服务端提示或真实凭据。

## 待检验的变化场景

1. QA执行中/通过后源码变化，或归档/完成发布中断；旧pass不能变新绿灯，不重复有副作用操作。
2. 当前只授权文档同步或只是候选需求；工程循环不得扩大为代码修改、需求放宽或无限新目标。
3. 用户有普通Python/文档项目没有JS组件登记；组件复用功能应可选择，不能强迫所有工程循环维护SoL架构索引。
4. QA独立性可证明的宿主与不可证明宿主并存；不得通过填写一个标志消除验证缺口。

## 各角色范围

A 设计：模块/状态owner/生命周期/公共IO/落点与复用路径；B 红队：并发、重放、授权、证据/身份伪造及Hook失效反例；C 实现/Eval：真实可行adapter、最小PoC、测试断言与限制；D 可维护性：跨仓库复用方式、事实归属、兼容/增量/无架构登记场景。

全部读取同一事实包与 design-v0.md，首次不互传意见。Reviewer只读产品/设计文件，唯一可写本人指定的scratch报告；禁止修改源码/Skill或再派Agent。你不是唯一的工作区参与者，不回退其他人的修改。父Agent裁决并保存最终方案与评审历史；当前共4槽含父Agent，先3席再第4席。
