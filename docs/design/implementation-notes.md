# 函数与组件实现说明增量

来源：2026-10-08，用户要求记录函数作用、实际实现过程、参数流向与包接口，供后续LLM维护和抽象；经资料检索与示例讨论后明确要求“可以，做吧”。沿用原架构和七个工具，新增以下范围，不重编AC-01–18。

| 要求 | 本轮可观察验收 |
| --- | --- |
| NOTES-01 | Skill指导写职责、输入输出、实现步骤、参数/包接口流向、错误与副作用、并发责任、不变量和有依据的理由；简单函数简写，复杂或共享函数详写 |
| NOTES-02 | begin可声明本轮需说明的路径/符号；I接入仅保存原说明的路径/行段与实际内容身份，不另维护一份说明正文 |
| NOTES-03 | status返回有界原文、源码/文档/相关输入的当前性；代码、文档或相关输入改变，旧引用显示stale/missing/invalid，不能满足finish门禁 |
| NOTES-04 | pending前核对scope、文件保护、摘要、行段与prepared handle；错误引用在此阶段无operation/受管写入。pending后发生漂移保留失败outcome/interrupted供显式恢复，产品文件不变、不重放；已跟踪target不可通过省略notes消失 |
| NOTES-05 | QA冻结读取机制说明和对应源码；I汇总判词仍不交付。symbol及文字意义保持声明/待语义QA，不把文件hash或结构接受当正确实现证明 |
| NOTES-06 | Hook只给当前计数与安全动作提醒；七工具数量、旧无notes调用、Stop不续跑及全局安装边界保持兼容 |

## 实现边界

公共输入由`src/core/contracts.mjs`拥有；`src/local/implementation-notes.mjs`读原说明及其相关源码，用既有Workspace保护和sha256事实检查引用；CycleCore拥有接入、目标保留、basis和完成门禁；runtime输出Hook摘要。Workspace实际打开文件的身份用于排除I的大小写、硬链接等物理别名，写入grant匹配未放宽。文本游标仍按UTF-16计数，分页/摘录不拆Unicode代理项对，分页起点或预算无法容纳完整字符时拒绝。Skill只是说明与QA规范入口。没有新增包、语言解析器、独立台账或后台任务。

说明可以位于代码旁注释或原模块Markdown。I汇总仅链接它。元数据含source的path/symbol/sha256、documentation的path/sha256/start_line/end_line及可选related_sources。包接口、参数转换和理由在原文维护；第三方版本/本地依赖的关键事实可把项目已有锁文件或源码加入related_sources，程序不猜版本或运行路径。

第一版以全文件身份检查，文件中的其他修改也会保守地使引用失效。每轮最多16个指定符号，每段1–128行，相关输入最多8项；最多64个文件，接受输入合计上限16MiB。沿用Workspace的单文件有界读取，超预算检测最多多读一个1MiB文件，随后立即拒绝；不承诺所有I/O总量不超16MiB。status说明原文合计最多8192字符。只覆盖明确目标，不宣称自动识别全部函数、调用图或完整参数数据流。

结构校验与语义判定分开：程序证明当前文件和行段，QA对照源码验证实现说明。没有原始设计依据的动机写unknown；静态调用不冒称已观察到运行。Docs动作许可不因此扩大为代码写入或任意命令执行。

研究依据与写法见插件Skill的[实现说明参考](../../skills/agent-engineering-cycle/references/implementation-notes.md)。原始基线验证保留在实施记录；本轮结果另存，不能用旧72项检查或已知边界夹具替代新要求验收。
