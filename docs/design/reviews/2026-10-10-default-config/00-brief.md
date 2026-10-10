# 默认配置与首次使用评审事实包

用户目标：插件安装后应有默认配置，不应要求每个项目先手写配置、绑定、组件 provider 与 QA 字段才能开始使用。用户明确要求 design-review-council 先设计。任务仅设计与只读调查；主 Agent 可以写设计和评审记录，不实现、不改安装/全局配置、不运行付费模型 benchmark、不提交/推送/发布。

项目：D:/zzd/agent-engineering-cycle。适用 D:/zzd/AGENTS.md 和个人工作路线。沿用 docs/design/、原 R/D/I/Q/Delta、已确认组件复用与 Hook 合同，不建立第二套 PRD。主 Agent 是文档写入唯一 owner；审查者不得编辑文件、回退他人改动或自行派 Agent。审查者独立依据下述事实，不读取其他角色意见。

## 已确认事实

- 插件 0.1.0 已安装/启用，新版主缓存34文件匹配，当前宿主七工具及 reuse_selection/source_view 描述已加载，实际 cycle_status 返回 ok=true/status=unbound/configured=false，qa.available=false/未校准。
- src/local/config.mjs::readConfig 缺 .codex/engineering-cycle.json 时返回 configured=false/checks=[]/qa=null。仅支持 strict rev1/rev2；rev2 component_reuse 要显式 architecture_path、discovery_scope、provider 原生 executable、manifest 与 SHA。
- src/server.mjs::configuredWorkspaceRoot 只用 --workspace / CYCLE_WORKSPACE / 进程 cwd。scripts/package-plugin.mjs 生成的原生 .mcp.json 的 cwd 为插件目录 '.'、仅转发 CYCLE_WORKSPACE；所以默认配置不等于绑定了用户项目。
- server.mjs 读取 x-codex-turn-metadata.thread_id/turn_id 作为 session 路由，已验证这两个 UUID；没有代码证明该 metadata 含当前项目路径。Hook 明确收到事件 cwd/session_id，src/hook.mjs 在绝对 cwd 下创建 runtime；MCP 与 Hook 尚无用于初始项目定位的共享地址机制。
- runtime.mjs 仅在成功 settled begin/resume 后把 host session 绑定活动 cycle。未绑定 Hook 输出 SESSION_UNBOUND。Hook完整JSON≤2048 UTF-8字节；Stop返回空，不自动续跑。
- 只有 CycleCore/WorkspaceAdapter 写产品文件；SoL provider-only只读。七工具：status/control/artifact/apply/verify/qa/reconcile。现有 signature grants 由实际交互 CLI 签发，模型字段不能生成许可；project配置、操作授权、active cycle、QA 能力是不同事实。
- rev2 的真实组件发现/读取/D引用/实际源码写前门禁已实现。new也需要完整登记查询与真实缺口理由；不能缺 provider 就自动视为没有组件或关闭门禁。现有工程核心和SoL provider不支持无登记时的承诺，须查源码确定最小接入方式。
- QA driver需明确原生Codex路径、model、平台/沙箱/driver身份与真实校准receipt；现有校准项目local HMAC，不能把缺receipt改为verified。普通只读检查不能自动调用付费模型。
- 实现说明目前是 begin 的 implementation_targets 与 I source/prose/related SHA 引用；声明目标缺说明/过期会阻止完成，但没有AST判断所有重要函数，说明准确性由独立QA核对。
- 已有 rev1/rev2 用户、活动cycle固定策略、明确操作scope、身份/currentness、pending/unknown不重放与QA完成门禁必须保留。新默认不能静默改已有配置或扩大范围。

## 待评审的方向（未裁决）

默认值随插件分发、项目配置只覆盖必要选项；会话按可靠宿主来源定位实际项目；status读取不自动写项目；进入已授权工程任务后才按需创建local state/文档/登记。组件发现默认可用，独立QA按能力事实准备，运行缺口如实报告。沿用现有边界与固定版本provider，不复制整套SoL写控制器。

需要裁决：项目定位优先级与无Hook宿主降级；跨项目/多session/切cwd时状态归属；无配置/空项目/无登记项目如何做到有用默认；检查命令及QA模型/二进制如何可靠发现且不提前执行；何时创建文件、签发许可与begin；缺能力的状态是否妨碍基础使用；旧配置与active cycle的兼容。

## 原始入口

- src/server.mjs、src/hook.mjs、src/runtime.mjs、src/cli.mjs
- src/local/config.mjs、store.mjs、authority.mjs、hook-context.mjs、reuse-evidence.mjs、check-runner.mjs
- src/core/contracts.mjs、cycle.mjs；src/adapters/component-provider.mjs、qa-cli.mjs、calibrate.mjs
- scripts/package-plugin.mjs；tests/transport.test.mjs、packaging.test.mjs、hook-context.test.mjs、component-reuse.test.mjs、core.test.mjs、safety.test.mjs
- docs/design/architecture.md、component-reuse-context.md、implementation-notes.md、acceptance.md；docs/evidence/plugin-update-20261009.md
- 组件能力只读参考：D:/zzd/codex-sol/src、scripts/package-provider.mjs 与 provider相关测试。不要修改SoL或全库重审。

## 必须考察的变化场景

A：新建JS/TS小项目，无工程配置/组件登记，用户要求修改并留下实现说明；插件应尽量免手工配置地起步。

B：同一插件同时为项目甲/乙服务，甲变更cwd、另一个session仍有active cycle；消息只是询问使用方法，不得自动开启或污染cycle，也不得把插件缓存或错误项目当作写入目标。

按角色返回结论、最小方案和具体反例；每项区分确认缺陷、设计风险、待验证假设与偏好，并标文件/符号、触发→失败→影响、最小改进、验证与维护影响。不要跑整套测试或付费模型。报告是设计审查，不是运行通过。
