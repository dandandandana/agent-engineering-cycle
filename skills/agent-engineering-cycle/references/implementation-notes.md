# 函数与组件实现说明

本参考为 I 补一层可追溯的函数/组件说明，服务于后续接手和有边界的变更。I 仍是实现状态摘要；原需求与设计保持各自权威，源码与原位注释/模块文档维护实现事实，Q 负责独立核验。引用元数据只标识原文，不复制正文，不构成批准、实现或 QA 结论。

## 何时记录

优先说明具有稳定职责或公共契约、跨模块数据流、状态/授权/资源生命周期、重要错误边界，或未来修改需要协调调用方的函数与组件。单一职责明显、没有值得说明的特殊约束的简单私有函数可略写或不登记；不要按函数数量、文件长度或重复次数机械建台账。

每条说明按需覆盖：

- **职责与边界**：负责什么、由谁调用、哪些变化应留在本模块；未来要抽象的理由需有真实复用和稳定变化边界支撑，不因说明本身自动拆分。
- **输入、输出与步骤**：参数如何经过关键函数到返回值、持久化或外部结果；写出重要分支，不复述每行代码。
- **调用与依赖**：列出影响行为的具体项目函数、标准库/平台接口或外部包 API；包依赖按锁文件所用名称和版本表达。说明输入如何流经这些接口，不把静态调用关系说成运行期已验证。
- **错误、副作用与并发**：记录实际传播的错误、文件/网络/状态变化、取消和资源释放责任，以及锁、幂等和并发由哪个边界负责。没有证据的行为写 `unknown`；确实不适用时说明原因。
- **维护不变量与理由**：写出必须共同保持的限制和可引用的设计/代码依据。源码未给出理由时写 `unknown`，不补造作者动机或隐藏推理。

简单说明可以合并或省略不相关小节。语言不限；第一版只用路径、声明名、全文 SHA-256 和原文行段，不要求 AST、CodeQL 或专用解析框架。

## 七工具中的可选引用

工具总数仍为七个。`cycle_control` 的 `begin` 可选固定本轮要追踪的目标；目标路径须位于当前声明的 `scope` 或 `inputs`，最多 16 项。`path` 是字符串，`symbol` 是 1–160 字符的声明名：

```json
{
  "action": "begin",
  "request_id": "begin-1",
  "goal": "示例目标",
  "grant_id": "已签发的授权引用",
  "scope": ["src/local/store.mjs", "docs/IMPLEMENTATION_STATE.md"],
  "inputs": ["src/local/store.mjs", "docs/IMPLEMENTATION_STATE.md", "src/core/contracts.mjs"],
  "acceptance_ids": ["AC-01"],
  "implementation_targets": [
    { "path": "src/local/store.mjs", "symbol": "LocalStore.archive" }
  ]
}
```

`cycle_artifact` 仅在 `kind: "I"` 的 `prepare` / `attach` 接受可选的 `implementation_notes`，最多 16 项；目标与说明中来源符号合并去重后也最多 16 项。每项精确字段如下；行号从 1 开始且首尾包含，`documentation` 最多 128 行，`related_sources` 可省略（默认空数组）且最多 8 项。`sha256` 是各自整个文件的 64 位小写十六进制 SHA-256，不是摘录或声明的摘要。

```json
{
  "source": {
    "path": "<scope 或 inputs 中的源文件>",
    "symbol": "<源码中的声明名>",
    "sha256": "<该源文件的完整 SHA-256>"
  },
  "documentation": {
    "path": "<scope 或 inputs 中的原注释/模块文档>",
    "sha256": "<该文档文件的完整 SHA-256>",
    "start_line": 1,
    "end_line": 20
  },
  "related_sources": [
    { "path": "<scope 或 inputs 中的相关文件>", "sha256": "<相关文件的完整 SHA-256>" }
  ]
}
```

字段组合为 `cycle_artifact({action: "prepare", kind: "I", paths, implementation_notes?})`；把 prepare 返回的 `prepared_handle`、prepare 返回的当前 `binding`、同一组 `paths` 和完全相同的 `implementation_notes` 带入 `attach`，并提供本次唯一 `request_id`。准备阶段只读并返回原文摘录与身份；attach 才归档 I。若目标没有在 begin 声明，引用中的源符号也会登记为目标；若完全没有声明目标或说明，原 cycle 保持兼容且不因此产生完成阻塞。

目标只是可追踪范围，说明元数据不是授权。`begin` 仍须符合原有 `control` grant；attach 仍须使用原 `artifact` 动作与当前 binding/request 流程。既有 `docs` / `implement` 模式、签发路径和 grant 中的动作/路径原样适用；说明引用不会扩大 `scope`、授权路径、可写范围或动作。Docs 模式可读取代码作为说明依据，但不能因此用 `cycle_apply` 修改代码。

所有说明引用路径须在本轮 `scope` 或 `inputs` 中，并且不能指向本次 I 汇总文件的 `paths`；说明可以是源码旁注释，也可以是独立模块 Markdown。相关文件也必须已进入同一现有输入边界。元数据不维护第二份说明正文；实现代码、注释或文档更新后，先对照源码复核并修正原说明，再重算全文 hash、更新行段并重新 prepare/attach I。只更新hash不能证明旧说明仍正确。

工具按以下数据流工作：

1. `cycle_control.begin` 持久化可选目标清单；它只声明要追踪的目标，不解析符号。
2. `cycle_artifact.prepare` 读取已授权的 I 原文及说明所引用文件，复核完整文件身份，返回有界原文段与 `prepared_handle`。说明列表和 I `paths` 必须在 prepare/attach 一致。
3. `cycle_artifact.attach` 在当前 binding 下重读并复核身份后，保存 I 引用和快照，并把说明引用的文件并入本轮输入。失败或中途文件变化时更新来源后重新 prepare，不能复用旧 handle。
4. `cycle_status` 返回条目当前性、计数及有界原文摘录（当前总摘录预算为 8192 字符）。条目状态为 `current`、`stale`、`missing` 或 `invalid`；目标已声明但没有说明时产生 `missing`。源码/说明/相关文件 hash 改变会使记录过期；路径不存在会缺失；行段越界或空摘录无效。任一目标缺说明或说明不当前都会成为 finish blocker。
5. QA 冻结输入包含原说明文件、源码和相关输入；私有只读连接器分页提供实际字节。QA context还携带声明的目标和引用行段，不传status中的截断片段，不接收I汇总判词。`symbol` 是作者声明，运行时没有做AST符号解析；hash/currentness只证明捕获的字节身份。QA必须对照真实代码、调用方及依赖独立判断说明语义与原需求是否成立。

Hook 只显示有界计数/下一步提示，不展开整份说明，不自动修改实现或续跑。任何 stale、missing、invalid 或结构拒绝都应回查原文件并按当前授权更新；不得改写判词来消除 blocker。

## 短例：`LocalStore.archive`

源码位于 `src/local/store.mjs`。`archive(kind, value)` 的输入是 kind 与可规范化为 JSON 的 payload，输出 `{id, digest, kind, schema_revision}`。它先以 `EVIDENCE_KIND` 检查 `kind`，再通过 `digest(value)`（`src/core/contracts.mjs` 中对规范化 JSON 求 SHA-256）形成 `kind-hash` 身份和 `evidence/<id>.json` 路径。它读取并核验已有记录；不存在时写入包含 `id`、摘要、schema revision、kind 和 payload 的不可变记录，最后返回引用。具体依赖是 Node 内建 `node:fs`、`node:path`、`node:crypto` 与项目本地 `canonical/digest/fault`，没有第三方包。无效 kind 或封套会产生 `EVIDENCE_INVALID`；不可变发布阶段的文件操作失败会被包装为 `STORE_UNAVAILABLE`，底层其他 I/O/序列化错误由调用边界处理。可见副作用是读取本地 Store，并在无对应记录时发布一个内容寻址的文件。

这个方法本身不取租约；`CycleCore` 的受管变更和校准调用方在外层用 `LocalStore.withLease` 串行化操作。维护发布原子性、已有封套复核和调用方租约责任时，应一起检查 `LocalStore.read/write/archive/withLease` 与 `digest/verifyEvidence`；不需要为其中每个私有辅助函数单独建说明。这里“没有第三方包”仅指函数没有直接调用第三方接口；contracts模块载入仍依赖zod，复用时不能漏掉这种间接依赖。源码未记载的原始选择动机标unknown；已确认设计合同中的公开理由可以引用。

## 资料依据

采用函数注释说明契约、构建块视图、真实数据流追踪与信息隐藏边界的具体启发；这些来源不构成运行时规则或必须使用的模板：[Google C++ Function Comments](https://google.github.io/styleguide/cppguide.html#Function_Comments)、[arc42 Section 5](https://docs.arc42.org/section-5/)、[CodeQL JavaScript/TypeScript data flow](https://codeql.github.com/docs/codeql-language-guides/analyzing-data-flow-in-javascript-and-typescript/)、David L. Parnas, *On the Criteria To Be Used in Decomposing Systems into Modules* [技术报告原文](https://prl.khoury.northeastern.edu/img/p-tr-1971.pdf)。
