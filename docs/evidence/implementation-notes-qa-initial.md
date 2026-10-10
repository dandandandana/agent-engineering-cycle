# 独立验收：函数实现说明

日期：2026-10-08。验收依据为冻结合同 `docs/design/implementation-notes.md` 的 NOTES-01–06，并对冻结源码、测试、原始说明与真实 QA source MCP stdio 做反向检查。此报告只绑定本节所列冻结副本；不把后续工作树修复算进结论。

## 对象与结论

- 冻结输入：`D:\zzd\slop\implementation-notes-20261008\notes-aaeb5cd1-b5d5-4b01-812a-f208eacdda73\input`
- 执行副本：`D:\zzd\agent-engineering-cycle\slop\notes-aaeb5cd1-b5d5-4b01-812a-f208eacdda73`
- manifest：`D:\zzd\slop\implementation-notes-20261008\freeze.json`，44 files，digest `a972fcd880d067c03ddb2421df0c31f8a061c412185fa248b9f60613e8d0f39a`
- 前一冻结版为 44 files、digest `6ac851a841952a8f24ebb749280df9988a3bf437fea116690d1f408efcce6cac`；当前报告针对新 digest，旧版仍保留。

此冻结版把函数说明接进了现有 Cycle、I、status、QA 和 Hook 流程，七工具数目与旧式无说明调用保持兼容；缺说明、过期说明不能静默满足完成门禁。当前快照仍有两项 NOTES-05 反例，故不能判定独立验收通过：Windows 大小写别名能把 I 汇总字节送入 QA；分页可能拆开一个 Unicode 代理对。以下观察都来自不可变执行副本，未修改它。

## 已确认的边界缺陷

### 1. I 汇总按字符串排除，Windows 文件别名可绕过（NOTES-05）

`src/core/cycle.mjs:25–27` 用 `Set` 对 I 路径作精确字符串排除；但 Workspace 在 Windows 的路径键会小写化（`src/local/workspace.mjs:79–80,142–148`），实际读取同样按 Windows 文件系统路径解析。QA manifest 再以精确字符串建立允许表，`qa_source_read` 对该条目读取真实 Workspace 文件（`src/adapters/qa-sources.mjs:14,20–23`）。因此 cycle 的排除身份比读取身份窄。

反例：临时 fixture 把 `docs/implementation.md` 作为 I 汇总，`scope`/`inputs` 声明 `Docs/Implementation.md`。R、D、I 正常 attach 后，QA manifest 排除了小写 I 路径，却留下大小写别名。实际创建冻结 snapshot，并经本地 QA stdio 调用 `qa_source_list` 与 `qa_source_read`，返回了标记 `PRIVATE_I_VERDICT_7fd39a2a`。运行平台为 `win32`，别名确实可读。I 汇总结论因而进入 QA 输入，违反冻结合同“仍不交付 I 汇总判词”。测试只检查精确 I 路径缺席，未覆盖文件系统等价路径。

需要按 Workspace 认可的同一文件身份排除 I 路径，不能只比较原始路径字符串。此结论覆盖实际的大小写别名；硬链接身份未在本轮单独验证。

### 2. QA 分页按 UTF-16 code unit 切片，跨页可产出半个字符（NOTES-05）

`src/adapters/qa-sources.mjs:18,23` 描述的是 UTF-8 页，但实现用 JavaScript `String.slice(offset, offset + limit)`，游标也按 UTF-16 code unit 增长。用真实 QA stdio、`WorkspaceAdapter.snapshot` 读取 `'x🌌abc'.repeat(2000)`，每页 limit 8192：第一页末尾 code unit 是 `55356`（高代理项），第二页开头是 `57100`（低代理项）。两页单独各含一个未配对代理项；拼接后恰好等于源字符串，所以现有 `tests/qa-sources.test.mjs` 的拼接断言仍通过，却没有验证每页本身可被独立消费。

这会使按页阅读的 QA 收到被拆开的字符，无法可靠地将该页当作完整文本片段。应使页边界和 offset 使用一致的 Unicode 字符边界（或明确实现并验证 UTF-8 byte 游标协议），并增加页片段本身不含未配对代理项的断言。当前冻结副本仍含此行为。

## NOTES-01–06 覆盖情况

| 合同 | 独立观察 |
| --- | --- |
| NOTES-01 | Skill 参考明确要求职责、输入输出步骤、具体项目/平台/包 API 与参数流向、错误副作用并发、不变量和有证据的理由（`skills/agent-engineering-cycle/references/implementation-notes.md:11–17`）。`LocalStore.archive` 原文是具体的机制示例：参数如何经 `digest → canonical → JSON.stringify → node:crypto.createHash('sha256')`，何时调用 Store 写入、错误和 lease 责任都能与源码核对。覆盖仍不完整：`docs/implementation-notes.md:27` 对 `inspectImplementationNotes` 只写“公共 Zod schema/现有 zod”，未写源码中的 `.array().max(16).safeParse(...)` 以及锁定的 zod `4.6.5`，弱于 Skill 自己的具体 API/版本要求。此项是说明质量缺口，不是第三个运行时反例。 |
| NOTES-02 | `begin` 目标和 I 引用保留路径、符号、文档行段与 SHA 身份，不复制一份说明正文；`docs/implementation-notes.md` 是维护原文。测试覆盖目标持久化、attach 的 prepared handle 以及引用资料身份。 |
| NOTES-03 | 当前性依赖原文及 source/documentation/related source 的整文件 SHA；测试分别改变三类文件并检查 stale，覆盖 missing、越界/空摘录和预算边界。状态的 symbol/semantic 标志保持未验证。 |
| NOTES-04 | 普通过期/变更 handle 在预检阶段被拒绝，相关测试检查没有新 operation 或受管效果；目标缺少当前说明时 finish 与 QA 都被阻断，省略 `implementation_notes` 不会删除既有 target。另观察到一个分阶段竞态：第二次复核若在 pending 后发现文档变化，留下 settled failure outcome 与 `interrupted` 生命周期、无 I artifact、pending 清除。这与“pending 前拒绝不登记 op；pending 后保留失败事实供显式恢复”的阶段合同一致，不应声称每个切点均为零日志。该竞态后的显式恢复未测。 |
| NOTES-05 | 新 QA snapshot 集成测试确认冻结输入携带说明原文、源码及 QA context 中 targets/references；I 汇总路径被排除，context 的 `symbol_verified`/`semantic_verified` 为 false，未带入 status 的 I 判词；负校准集成用例在无模型校准时得到 unknown/unavailable，并等待 worker PID 真实退出后清理。当前快照仍被上面两项真实 MCP 反例否决。 |
| NOTES-06 | 全量测试和 stdio transport 检查仍列出原七个工具；旧式无 notes 流程通过，Hook 只报告摘要计数，Stop 不续跑。未作插件安装或全局授权。 |

## 维护案例与不应升级的结论

按候选 Skill 的写法，从真实代码手工追踪 `inspectImplementationNotes(workspace, options)`：notes/targets 进入 `implementationNoteSchema.array().max(16).safeParse` 与 target schema 校验；schema 默认 `related_sources: []`；路径经 `implementationPaths` 展开后交给 `WorkspaceAdapter.readSource`；期望 SHA 与读取 SHA 比较；`documentation.start_line/end_line` 决定行段摘录。对应源码是 `src/local/implementation-notes.mjs:27–55`、`src/core/contracts.mjs:24–30`、`src/local/workspace.mjs`，包版本取自 `package-lock.json` 的 zod `4.6.5`。这说明规范会把维护者引向可核查的参数流，不要求编造调用图或运行证据；本轮未运行模型 CLI，因此不能证明模型会遵守规范或语义描述质量。

在临时只读调用中，`LocalStore.archive` 的真实说明与源码/相关文件 SHA 均为 current，而 `symbol_verified=false`、`semantic_verified=false`。把 symbol 改成一个不存在的声明名后，文件身份仍可 current 且两个验证标志仍为 false。这是预期边界：哈希证明字节身份，不证明符号存在或说明语义正确。另有 `src/local/store.mjs:77` 指向冻结输入中不存在的 `docs/design/architecture.md`；文档把原始策略理由写为 unknown，本报告也不从当前行为臆造设计动机。

## 原始命令与观察

命令均在执行副本运行，依赖由该副本父级现有 `node_modules` 解析；没有模型 CLI、网络访问、install 或授权真实项目。

```text
node --test --test-reporter=dot tests/implementation-notes.test.mjs tests/qa-sources.test.mjs
```
15 个测试通过（输出 15 dots）。

```text
node --test tests/transport.test.mjs
```
4/4 通过；包含真实 MCP stdio 初始化、七工具列表和只读 status 调用。

```text
npm test
```
完整冻结副本套件 86/86 通过，0 fail，约 20.8s。测试通过不覆盖上面两个新增反例。

额外反例命令是 PowerShell here-string 管道执行一次性 Node ES module：`@' <fixture/probe module> '@ | node --input-type=module`。I 别名探针使用 `tests/helpers.mjs` 建立临时 cycle，真实调用 CycleCore manifest、Workspace snapshot 和 `src/adapters/qa-sources.mjs` 子进程 stdio；观察到 `IPathExcluded=true`、`aliasInSnapshotManifest=true`、`aliasReadable=true`、`verdictMarkerReturned=true`。分页探针直接建立临时 UTF-8 文件、冻结 snapshot 并启动相同 QA stdio；观察到 `page1Length=8192`、`page1LastCodeUnit=55356`、`page2FirstCodeUnit=57100`、`concatEqualsSource=true`、`page1HasUnpairedHighSurrogate=true`、`page2HasUnpairedLowSurrogate=true`。两探针的完整一次性脚本未写入项目或冻结副本；输入与 snapshot 均在 OS 临时目录，fixture 清理后退出。

## 未测边界与冻结身份复核

未测非 Windows 文件系统对大小写别名的解析、硬链接的文件身份、所有可能的 Unicode 切点、该竞态后的恢复流程、外部模型是否按 Skill 产出高质量说明，以及真实宿主安装/全局授权场景。未用模型 CLI或网络，因此语义正确性仍需后续独立 QA 逐项对照。

冻结身份在报告写入前校验：按 manifest 的 44 个相对路径逐个计算 SHA-256，冻结 `input` 与执行副本各为 44/44 match，0 missing、0 mismatch、0 extra。报告只写在冻结根目录之外的 `D:\zzd\slop\implementation-notes-20261008\independent-qa.md`；写后会再次逐项校验同一 digest 与两份目录身份。
