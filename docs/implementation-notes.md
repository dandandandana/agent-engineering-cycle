# 当前函数实现说明

本页是维护用原文；运行时引用指向本文行段或代码旁注释，不复制一份独立描述。以下来自当前源码静态检查，测试运行结果沿[实施记录](IMPLEMENTATION_STATE.md)回查；说明文字、符号名称与调用顺序不构成真实运行证明。

## LocalStore.archive(kind, value)

- **职责/输入输出**：校验kind字符串，以value内容摘要保存证据，返回id/digest/kind/schema_revision。value领域结构由调用方负责校验，本方法没有统一JSON类型schema。
- **实现**：先digest(value)，再拼接kind和摘要形成evidence路径；存在则verifyEvidence核对封套和payload；不存在则write immutable。不会改写已有证据。
- **参数流向/依赖**：value → contracts.digest → canonical → JSON.stringify → sha256 → node:crypto.createHash('sha256').update().digest('hex')。kind参与ID/文件名。外层记录由write规范化后经node:fs发布。本方法不直接调用第三方包接口；所在模块通过contracts载入间接依赖zod，抽离复用时须检查模块依赖。
- **错误/副作用**：不合法kind、无效读取或封套不匹配有EVIDENCE_INVALID路径；write发布失败报STORE_UNAVAILABLE，其他早期I/O错误仍可能传播。可能创建控制目录、临时和最终证据文件。
- **并发责任**：archive不拿lease，受管调用由CycleCore、calibration/QA worker等调用方协调；immutable发布本身拒绝覆盖。
- **维护约束/理由**：对象键排序、省略undefined键、数组顺序与摘要算法决定历史ID；更改需检查兼容。内容寻址与不可变记录用于原Store恢复合同，不把重复调用当新证据。
- **验证入口**：tests/store.test.mjs的内容寻址/不可变/封套篡改断言；tests/safety.test.mjs的p0名称与篡改断言。当前运行状态见实施记录，不在本文重复维护pass计数。

## implementationPaths(notes)

- **职责/输入输出**：把已校验notes中的source、documentation和related_sources路径展开为去重路径数组。
- **实现/参数流向**：notes → Array.flatMap提取各path → Set按字符串相等去重 → 数组；使用JavaScript内建能力，没有包或文件I/O。
- **副作用/错误**：不初始化Store，不读写文件；输入schema和真实路径检查由上游公共合同及下游Workspace承担，未校验输入直接调用可能产生标准JavaScript异常。
- **维护约束/理由**：不能漏documentation或related_sources，否则接入/basis可能漏掉维护说明或版本依据；它只展开声明关系，不能当依赖解析器。
- **变化边界/验证**：只随引用形状变化；实际文件读取与状态归属不应挪入此纯转换。验证由implementation-notes.test.mjs覆盖路径集合、允许范围和输入预算。

## inspectImplementationNotes(workspace, options)

- **职责/输入输出**：依据notes、targets、allowedPaths和excludedPaths读取原文与源码事实，返回当前性、每段有界摘录、摘要期望/实际值、symbol/semantic未验证标识。workspace提供既有受保护读取；选项默认空数组。
- **实现**：Zod验证引用、唯一path/symbol及条数；汇总引用与目标路径，检查允许范围和I路径/真实file_id排除；按路径缓存readSource结果；比较全部sha256并区分missing/stale；doc行段越界或空白记invalid；完整字符截断摘录并增加未接入target的missing项，最后汇总计数。
- **参数流向/依赖**：notes/targets → 公共implementationNoteSchema/implementationTargetSchema → zod的`.array().max(16).safeParse(...)`；锁文件为`zod@4.6.5`。source/documentation/related paths → implementationPaths → Workspace.readSource；sha256字段与读取事实比较。documentation.start_line/end_line → String.split/Array.slice → textPage → content；allowed/excluded → Set成员检查，I别名按workspacePathKey及实际file_id排除。依赖公共contracts和Workspace接口，不执行描述中提到的包函数。
- **错误/副作用**：引用格式、重复、输入预算异常拒绝，输出超过预算截断并标记；秘密/越界路径沿Workspace传播拒绝；SOURCE_UNAVAILABLE转成missing。只有有界文件读取和内存摘录，无存储初始化、写入或后台任务。
- **并发/维护约束**：多个文件是顺序观察，不能当冻结快照；受管接入由Core的lease/prepared handle与后续QA snapshot承担。不得把SHA相等、非空说明或symbol声明升级成语义正确/函数存在证明。
- **理由/变化边界**：本轮沿用现有Workspace保护和七工具状态归属；语言解析与调用图未实现。未来增加解析也要保留declared/static/observed边界。文件其他改动会保守地使引用失效。
- **验证入口**：implementation-notes.test.mjs分别覆盖源/文档/related漂移、缺失/越界、路径保护、读/文本预算、prepare篡改和缺target门禁；是否通过以实施记录的原始结果为准。

## textPage(text, offset, limit)

- **职责/输入输出**：按调用方校验的非负UTF-16游标和单元预算截取文本，返回text与实际next_offset；预算可以为0用于有界展示。
- **实现/流向**：offset/end → String.charCodeAt检查是否位于高低代理项之间；非法起点抛EVIDENCE_INVALID，末端位于代理项对内部则回退一单元；text/修正后的offset和end → String.slice → 返回完整字符片段。使用JavaScript内建字符串API，无外部包。
- **错误/副作用/约束**：纯转换无I/O；调用方负责数字和输入字符串校验。极小预算可能得到空片段，有连续分页的接口必须拒绝零进度并提示增大limit；展示允许空摘录并标truncated。
- **变化边界/理由**：游标不改为字节/码点计数，以兼容现有客户端；减少预算也不应拆开非BMP字符。这是独立QA实际分页反例的修正，不能只按ASCII测试。验证见text-pagination.test.mjs的实际stdio分页和调用边界。
