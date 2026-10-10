# 组件复用与上下文控制实施文档

日期：2026-10-09。用户在 CRCTX-v1 评审与文档交付后明确“ok 改吧”，本轮实施已获授权。本文描述实际源码；设计合同见 [CRCTX-v1](component-reuse-context.md)，历史评审和原始草案保留在 [review-history](review-history.md)。版本仍为 0.1.0，不提交、推送、发布或改全局规则。

## 实际职责与数据流

模型只连接工程循环的七工具。CycleCore 是受管产品写入与阶段转换的唯一 owner；内部 gateway 固定启动 SoL 的独立发现发行，不加载全量 SoL 流程、写工具、Hook 或 Skill。provider 的三个工具为 sol_architecture_query、sol_read_file、sol_recall。它可在明确的控制缓存归档观测，不能通过工具写产品文件；这不是 OS 沙箱隔离承诺。

| 实现入口 | 参数与实现流向 | 返回、错误与副作用 |
| --- | --- | --- |
| SoL createProviderServer / provider-policy | workspaceRoot + architecture_path + discovery_scope + cache_root → ObservationStore、ArchitectureIndex、共享 workspace-read。ArchitectureIndex 的 validateReadPath 在索引源码读取前校验独立读范围；Acorn 读取静态 ESM import/export，Normify 处理现有登记 | 仅三个工具；query 原归档包含完整 versions、固定协议/工作区/登记身份。read 和 recall 使用原观测字节。越界、链接和已知秘密路径拒绝；只写独立观测 cache，不承担工程决定状态 |
| packageProvider | out → 复用原 package-plugin 的安全复制、依赖闭包与实际文件哈希；发行 manifest 登记入口、锁文件和完整文件清单 | 新目录发行；不覆盖旧目录、不混入完整 server、write、Hook/Skill。清单与依赖实际执行由 provider-package 测试核对 |
| validateConfig / readConfig | strict Zod schema_revision 1 或 2；rev2 可显式配置 component_reuse，读取范围和文档豁免独立于 action grant | v1 行为保留。cycle 固定 contract_revision、reuse_policy_digest 与 provider_identity；活动中改变策略产生 POLICY_CONFLICT，重新取 binding 不升级或降低策略 |
| providerIdentity / providerWorkspaceIdentity | 操作者固定 executable/args/manifest SHA → 实际 native 文件与整个发行逐文件身份核验，最多 8 个并行打开；async realpath → 物理 dev/ino 核对 → provider 工作区 SHA | 拒绝缺失、漂移、链接、额外文件和不支持协议。Windows 8.3 短路径与 native realpath 曾产生不同字符串；单独保存 provider_workspace_id，保留历史 cycle workspace_id，避免破坏旧操作引用 |
| captureComponent | state/config/args/operation/signal → 官方 @modelcontextprotocol/client 2.2.0 Client + StdioClientTransport；固定 argv 与专用 namespace → 握手 → tools/list → query/read → 全部 recall chunks | 校验 start_byte/end_byte、游标、完整性、最终 SHA；Cycle 独立重读真实来源。记录 started、terminal、timeout、cancel、cleanup 与完整缓存 inventory。完整已观察失败可结算；清理或缓存未知保留 unknown，不重放 |
| reuseSelectionView / CycleCore.perform | discover 的完整 query capture → 结构化候选、直接调用方路径及其来源 SHA/行数；read 的完整 source capture → 本次请求 snippets 视图 | 只加返回字段，七工具及输入 schema 不变。discover 的 `reuse_selection` 整体 ≤16 KiB UTF-8；read 的 `source_view` 整体 ≤16 KiB，超限明确 incomplete。旧 `view_text/view_complete` 和原始归档分页保留用于审计；不要求正常选择重复分页重建归档 |
| parseReuseDecisions / inspectReuse | 原 D paths → WorkspaceAdapter 读保护 → 唯一 cycle-reuse-v1 规范 JSON/Zod → 实际 capture 引用、目标覆盖、派生角色与固定 target_baseline | D 正文是唯一选择事实；投影保存正文身份、引用及全部目标写前 SHA/不存在状态。summary.missing 只计目标覆盖缺口，summary.reads 只计 D 引用且验证过的不同读取路径。诊断保留原 cause/code/category/message，issues 最多 16 项且合计 ≤4 KiB，并有 total_issues/truncated；Schema 问题定位字段并返回真实角色枚举。缺失或漂移阻止写入；不证明模型理解或理由正确 |
| CycleCore preflight / perform / basis | 当前 binding/grant + 实际 targets → D/来源/固定策略核验 → pending → Workspace.apply → 精确 effects → outcome/settle；basis 加入捕获、投影、来源、游标及环境身份 | implementation_targets 仅为函数说明目标，遗漏不能免除任何实际源码目标。只有完全已知并结算的 consumer after-SHA 推进 cursor；candidate/registry/非目标 caller 具有更高保护。外部修改、partial/unknown 不吸收 |
| server / runtime.invoke / HookSessionLedger | SDK 的真实 x-codex-turn-metadata UUID thread_id/turn_id → hostSessionId；成功非重复 begin/resume 的已结算操作 → session 哈希与 cycle 绑定；Hook event.session_id → 相同路由 | session 是路由，不能生成授权。独立短锁与原子账本最多 64 条；未绑定、争用、损坏均降为通用查询指针。原生写拒绝不依赖路由或去重 |
| projectHookContext / boundedHookResponse | 本地状态 → 白名单枚举、计数和固定工具指针 → 语义指纹 → 有限省略 → 最终完整 JSON 字节核验 | 完整 JSON ≤2048 UTF-8 字节；不注入 goal、源码、组件描述或理由。相同 UserPrompt 最多省略三次，第四次提醒；SessionStart 恢复/压缩必发，Stop 返回 {}。没有 ack 时保持未知 |
| reuseQaContext / QA source connector / sourceDelivery | 完整原捕获 → 内容身份固定的最多 128 条、合计 16 MiB 存储索引；list 仅返回索引，read 分页取原文；CLI 前后复核身份，并预检当前 1 MiB 回执容量 | QA 收当前冻结源、原 R/D、before 原捕获和 settled cursor；I 判词排除。所有分页读完且终态已观察才可算交付。超容量在 pending/worker 前明确拒绝；missing 不产生 NaN 绕过。存储上限不是大输入交付保证，当前没有流式大回执 |

关键代码位于 src/core/cycle.mjs、src/local/reuse-evidence.mjs、src/adapters/component-provider.mjs、src/local/hook-context.mjs、src/local/qa-evidence.mjs。新增共享辅助均有实际调用方，未新增第二套登记或工程决定框架。

`implementationVerdictExclusions` 复用 I 捕获的 SHA 与历史 `verdict_sources`，同时供 discovery/read 预检、结构化选择、D 全部 query/read 来源、QA manifest 和 notes 使用。I 接入观察 file_id/SHA 后归档并绑定，最多保留 256 个身份；旧 I 用原 manifest SHA 兼容。按捕获字节隔离，不能用当前路径或 inode 的后来版本扩大排除集。范围拒绝不返回新路径问题、原 selected 预览或可用发现引用；未登记目标缺读取权限时直接报告操作者范围阻塞。

## 项目启用与维护

旧 schema_revision=1 项目继续原行为。操作者显式采用 rev2，并固定 provider 的 native executable、发行 manifest 与 SHA；组件发现路径在独立 discovery_scope 内。documentation_paths 只豁免确切的文档路径，不能豁免源码；活动任务的策略不能由模型修改。

配置与打包命令见 [README](../../README.md)。插件主 Skill 只增加入口，结构化 discover/read、D 诊断修复、规范字段、QA 完整分页与恢复方法在 [component-reuse.md](../../skills/agent-engineering-cycle/references/component-reuse.md) 按需读取。函数实现说明仍沿原 I 引用与 [implementation-notes](implementation-notes.md)，不强制普通私有函数另建台账。

捕获也沿原 request_id 生命周期：缺/伪造/过期 D 在 pending 前拒绝；响应丢失先检查同操作的归档与效果；known-failed 可以结算后显式新捕获，unknown 只能依据 saved outcome 恢复，不能换 request_id 重放。

## 评分与验证证据

独立 blog-reuse-v2 复用原固定八题/25 机会/消费者行为检查，模型开始前冻结 E、规则和基线。贡献 M 必须由实际受控依赖扰动使消费者的固定断言从 pass 变 fail；调用数、import、hash 或 helper 自测不直接计分。原样及改名格式化克隆排除对应机会；难以证明的语义改写保持 unknown。必要 new 由 D/QA 单列且不计 M；E=0 时 M/E 为 N/A。

25 个 reference 正控已实测通过；原始报告为 blog-eval/slop/blog-reuse-v2-reference-calibration-20261008-01/v2-reference-calibration/report.json，25 份 captures 保留实际终态、源文件稳定与临时副本清理。B01 的 dummy/clone 校准与定向测试保留。该结果是评分器校准，不能当新模型的 25/25 成绩。

bench:blog 新增可选 --reuse-mode off/on，同一跑次先冻结规则，再生成候选并探测 25 个结果贡献；on 使用真实 provider-only 与 rev2 门禁，off 保留原写入流程。省略此参数继续原 benchmark 行为。当前未运行新的八题模型对照，因此没有声称复用率或成本提升。原 v1 行为 41/41、合规 88/96、完整成功 2/8、严格有效复用 4/25、观测调用 19/25 与原报告不改。

针对 2026-10-09 暴露的诊断与取证路径，全套本地检查166/166、官方审计0漏洞；最终范围映射1/1、增量真实 provider 回归1/1、记录器检查11/11。缺 caller 的具体问题可修复并继续受控写入；同步登记后可沿新 query 保留未变 read ID，只补变化消费者。两次 B01 CLI smoke 分别连接中断、15分钟超时，均未完成交接，不能宣称新整体成绩。原生 Hook 的 command 输入、deny 和未变产品字节另有观察核验。完整证据与最终澄清验证边界见[增量证据](../evidence/reuse-usability-20261009.md)；既有 [0/8、0/25 实测报告](../evidence/blog-benchmark-20261009.md)保持历史原样，固定分母仍为25。

最终检查、宿主接线与独立实现复查见 [本轮验收](../evidence/component-reuse-20261009.md)：工程循环161/161、SoL314通过/20平台跳过，审计0漏洞。全局缓存因活动MCP占用而刷新失败，旧注册已恢复，新发行29个源文件与当前仓库一致。历史141项和旧TUI证据不代替本轮；其他平台、Desktop、动态调用全图、隐藏provider上下文与模型理解未验证。
