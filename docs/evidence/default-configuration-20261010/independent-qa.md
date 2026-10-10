# DEFAULT-v1 独立 QA

## 结论

当前审查范围无未解决源码发现。DEFAULT-01/02/06/07/08/09/10/12/14/15 的本地验收为 **pass**；DEFAULT-03/04/05/11/13/16 的真实宿主、校准或完整交付边界为 **not-run**。完整 DEFAULT-16 仍未证明：没有真实已校准的 QA、独立 QA 完成及 finish 证据，也没有真实 Codex Desktop/TUI 安装会话验收。

最终源码身份使用 `source-freeze-r4.json`，复核时 53 个条目全部路径存在且 SHA-256/字节数匹配；针对性复验后再次为 53/53。`native-final` 中 45 个可直接映射到发布内容的运行时/Provider 源文件与 r4 匹配。打包器会转换插件描述文件：仓库 `plugin.json` 映射到 `.codex-plugin/plugin.json`，并生成 `.mcp.json`；这不是字节同一。没有实际安装、重启/重载、运行时工具描述或只读 `cycle_status` 宿主证据，因此静态包身份不代表 installed/enabled。

## DEFAULT-01..16

| ID | 结果 | 独立证据与边界 |
|---|---|---|
| DEFAULT-01 | pass | 无配置 `status` 使用内存 standard profile；拒绝未授权 begin/apply，不创建项目记录。`default-runtime.test.mjs` 1/1；`default-config.test.mjs` 1/1。真实宿主未测。 |
| DEFAULT-02 | pass | null、false、0、空值、未知字段、损坏/不可读配置拒绝；rev1/rev2 保持显式旧语义。`default-config.test.mjs` 14/14。 |
| DEFAULT-03 | not-run | 未在 Codex 原生安装目录启动并关联项目甲，也未观测插件缓存哨兵。`native-final` 仅完成静态包文件身份比对。 |
| DEFAULT-04 | not-run | 本地 Host/Hook 上下文边界测试通过；TUI/Desktop 的跨项目、双 session、父子 Agent 与 cwd 切换实际宿主生命周期未测。`host-context.test.mjs` 5/5；Hook 目标测试 2/2。 |
| DEFAULT-05 | not-run | 本地缺 turn、冲突/过期/外来上下文拒绝回退的契约测试覆盖；真实 Hook 缺失、损坏与过期事件未在宿主运行。 |
| DEFAULT-06 | pass | 本地无配置仍可走已授权受管周期；未授权 begin/apply 被拒绝，状态读取不创建项目记录。日常聊天的真实 Desktop 路由未测。 |
| DEFAULT-07 | pass | 无登记项目通过真实 Provider/RepositoryIndex v2 发现共享实现；消费者改为调用现有 `slug` 组件，固定行为检查通过，随后共享源漂移会阻止写入；未造登记 UID/symbol。`default-runtime.test.mjs` 当前性测试 2/2；组件复用集成测试 3/3。 |
| DEFAULT-08 | pass | 实际覆盖空库存、JS/TSX 候选、零关键词命中、预算 partial/blocked、双扫描不稳定、秘密/链接、范围外读取、blocked enumeration 证据保留和 new 决策阻塞；control-file/binary-stat 当前性反例均复验通过。SoL Provider 7/7；`repository-reuse.test.mjs` 16/16。 |
| DEFAULT-09 | pass | R/D 通过 `cycle_apply` 建立目录并记录父目录/文件效果；任意业务 Markdown 仍受 reuse gate 约束。workspace bootstrap 测试 4/4；真实 runtime 首次文档/bootstrap 测试 1/1。 |
| DEFAULT-10 | pass | check-plan 仅识别固定命令，不启动 npm/script；代码行为仍需 behavioral check，只有 source-integrity 时不构成行为验证或 finish 证据。`check-plan.test.mjs` 7/7；source-integrity 收据测试 1/1；无 Q finish 阻断测试 4/4。 |
| DEFAULT-11 | not-run | 默认配置能力明确为 `qa_driver=false`，未把未校准驱动标 ready；未校准真实模型、身份漂移或实际 QA worker。 |
| DEFAULT-12 | pass | rev1/rev2 不合并 standard defaults；rev1 active cycle 在 v2 repository policy 下明确冲突。配置测试 14/14；active v1 冲突测试 1/1。 |
| DEFAULT-13 | not-run | 本地 Hook 目标解码/范围判断覆盖通过；真实原生事件、另一 Desktop session 范围外写和未知输入均未在安装宿主验证。Hook 目标测试 2/2。 |
| DEFAULT-14 | pass | I 引用源或说明变化会 stale，声明目标缺少当前 I note 会阻止 QA/finish；QA 冻结来源并排除 I 摘要及大小写/hardlink 别名。实现说明测试共 8/8。 |
| DEFAULT-15 | pass | pending/unknown 文件 effect 与 capture response 都不重放；saved outcome 只恢复已有结果。store 1/1、core 1/1、组件 lost-capture/currentness 子测包含在 3/3 中。 |
| DEFAULT-16 | not-run | 有本地正常组件复用/实现/固定行为检查正控；完整正常任务的真实独立 QA 报告与 finish 未运行。当前真实 QA 驱动/宿主验收缺失，不能判完整通过。 |

## 关键复验与原始证据

1. **blocked enumeration 原合同缺陷已修。** 初始 `repro-enumeration-blocked.txt` 中，设计允许的 `coverage.enumeration.status='blocked'` 被拒绝为 `EVIDENCE_INVALID`。最终实现允许该状态保留为证据，但 new 决策仍 fail-closed。原反例复验输出见 `repro-enumeration-blocked-r3.txt`，r4 的同一复验命令也接受；`repository-reuse.test.mjs` 新增用例在最终 r4 上通过。
2. **worktree `.git` regular file 原缺陷已修。** 初始 `repro-worktree-first.txt` 因 skipped-directory 集合与 regular `.git` control file 不一致而拒绝合法 query；最终 `repro-worktree-final.txt` 及本 QA 的 `independent-qa/repro-worktree-r4.txt` 接受，且 `.git` 留在 metadata inventory、不成为 source。
3. **未变化二进制文件统计精度原缺陷已修。** 初始 `repro-worktree-stat-observation.txt` 中 Provider 的毫秒统计与本地浮点统计末尾精度不同，未改动的 `image.png` 被误报 `REUSE_STALE`。最终 r4 repro 接受 unchanged image；本 QA 另在隔离临时 workspace 只改写同长度二进制并推进 mtime，结果按预期变为 `REUSE_STALE`。原始本地结果见 `independent-qa/repro-binary-stat-change-r4.txt`。

关键源码引用：设计验收表 `docs/design/default-configuration.md:168`；blocked enumeration 解析 `src/local/repository-reuse.mjs:314`；metadata inventory `src/local/repository-inventory.mjs:153`；库存当前性 `src/local/reuse-evidence.mjs:122`；behavioral 缺失阻断与 source-integrity 分支 `src/core/cycle.mjs:181,596`；I 引用校验 `src/local/implementation-notes.mjs:68,81`；unknown/no-replay 与 finish 门禁 `src/core/cycle.mjs:324,378,525`。

## 本次运行的针对性命令

下面均为局部测试，未重跑全套 `npm run check`：

```text
node --test tests/default-config.test.mjs                         14/14
node --test tests/host-context.test.mjs                            5/5
node --test --test-name-pattern='runtime binds only|Hook denies joined' tests/hook-context.test.mjs  2/2
node --test --test-name-pattern='no configuration still has standard defaults|exact signed documents bootstrap through cycle_apply' tests/default-runtime.test.mjs  2/2
node --test --test-name-pattern='unregistered real source discovery permits consumer reuse and blocks stale shared writes|settled own creations remain usable, but an external new file invalidates empty discovery' tests/default-runtime.test.mjs  2/2
node --test --test-name-pattern='new-contract bootstrap|bootstrap validates|bootstrap interruption|bootstrap cannot follow' tests/workspace.test.mjs  4/4
node --test tests/repository-reuse.test.mjs                         16/16 (最终 r4)
node --test --test-name-pattern='component reuse v2 captures real provider evidence and gates managed consumer writes|candidate sources in a mixed shared/consumer target set never inherit a consumer cursor|unindexed new targets keep fixed absent and settled delete baselines; lost capture responses are not replayed' tests/component-reuse.test.mjs  3/3 (最终 r4)
node --test --test-name-pattern='repository v2 initializes on an unregistered empty workspace|repository candidates include shared JavaScript and TSX|repository budgets report partial or blocked coverage|repository collection becomes unstable|repository mode excludes secrets and links' tests/repository-provider.test.mjs  5/5
node --test --test-name-pattern='all indexed source paths are scope-checked|scoped reads reject credential paths and linked paths' tests/provider-server.test.mjs  2/2
node --test tests/check-plan.test.mjs                               7/7
node --test --test-name-pattern='QA freezes implementation-note sources and context while excluding the I summary|captured I aliases remain excluded|QA manifest and implementation notes exclude case and hardlink aliases' tests/implementation-notes.test.mjs  3/3
node --test --test-name-pattern='changing the source, selected prose, or a related source makes its note stale|declared targets block finish and QA start until I is refreshed with current notes' tests/implementation-notes.test.mjs  5/5
node --test --test-name-pattern='crash after persisting pending and an effect leaves both records without replay' tests/store.test.mjs  1/1
node --test --test-name-pattern='finish needs independent QA and external source drift' tests/core.test.mjs  4/4
node --test --test-name-pattern='saved outcomes recover without replay after the file effect already happened' tests/core.test.mjs  1/1
node --test --test-name-pattern='builtin docs integrity records readonly observations without pretending to launch a check process' tests/safety.test.mjs  1/1
node --test --test-name-pattern='v1 active cycles conflict with v2 policy and docs-only discovery does not launch a provider' tests/component-reuse.test.mjs  1/1
node .\slop\default-configuration-20261010\repro-worktree-control-file.mjs
node .\slop\default-configuration-20261010\independent-qa\repro-binary-stat-change-r4.mjs
```

`npm run check` 的全套原始输出在 r3→r4 期间生成，本 QA 没有将它算作全程 r4 验收，也未重跑。Codex Desktop/TUI、实际安装后运行时工具注册、真实模型校准、live QA/finish 均为 **not-run**。
