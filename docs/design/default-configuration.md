# 默认配置与首次使用设计

修订：DEFAULT-v1，2026-10-10。状态：用户要求 design-review-council 后的设计方案；未实现、未改安装或用户配置。沿用现有 R/D/I/Q/Delta、七工具、唯一产品写入控制器与签发许可。评审事实、四个独立角色与裁决见[评审记录](review-history.md#2026-10-10-默认配置与首次使用)。

## 1. 目标与当前事实

用户不应为每个项目手写工程配置、provider 路径和 QA 字段才能开始。正常入口应是：安装插件→打开项目→提出工程任务→Agent 恢复需求、查已有能力、准备范围并推进。配置文件用于覆盖默认选择，不是基础使用的必需品。

当前 `readConfig()` 缺文件返回 `configured=false`，`CycleCore.mutate()` 据此拒绝持久操作；生成的原生 MCP 以插件目录 `.` 启动，server 又把该 cwd 当默认工作区。Hook 有实际项目 cwd，但尚未传给 MCP 做首次定位。因此只添加一个 JSON 默认值不能实现上述体验。

主安装、新接口和只读连接已经核验；这与某个项目是否定位、是否授权、是否已有活动 cycle、是否拥有 QA 能力是不同事实。此设计不把它们合成一个“已就绪”布尔值。

## 2. 默认行为

| 项目 | 新项目的内置选择 | 激活边界 |
| --- | --- | --- |
| 配置 | 内存中的具名 `standard@1` profile；无配置文件也有有效策略 | 只在文件真正不存在时使用 |
| 项目定位 | 经宿主验证的当前项目上下文；既有显式绑定保留 | 无可靠关联时提示一次选择项目，不使用插件缓存或最近访问项目 |
| 工程流程 | 当前任务的 R/D/I、检查、QA 与恢复记录 | 由已授权的 begin 开始；普通问答、status 和 Hook 不自动 begin/resume |
| 组件复用 | 源码任务默认要求先发现、读取真实来源，再在原 D 做 reuse/extend/new 决定 | 发现不可用或相关覆盖不完整时不能把它当“无组件” |
| 实现说明 | 对本次变化的重要共享能力、复杂函数和生命周期边界记录机制 | Agent 在计划中选择目标；沿用源码注释/模块文档，不逐个登记普通私有函数 |
| 检查 | 内建、无命令执行的 `source-integrity`；检测已有 test/lint/typecheck/build 作为候选 | 项目命令仅在固定合同、有效 verify 许可与显式 verify 操作下执行 |
| QA | 自动准备原生 executable 与模型候选；优先既有明确配置，其次宿主报告的当前模型 | 校准和实际 QA 是显式操作，缺 receipt 不标可用，不自动换模型/沙箱 |
| 上下文 | 活动任务的短状态、缺项和下一步；完整 Hook JSON ≤2048 UTF-8 字节 | 空闲时不反复注入 SESSION_UNBOUND；Stop 不续跑 |
| 文件创建 | 读取状态不创建项目配置或业务状态 | 有效授权后才创建必要 state/文档；已有项目文档继续拥有权威 |

默认可用不等于默认有修改权限。Agent 负责调查、生成配置与执行计划；现有有效授权可以复用，新授权仍经原操作者入口确认精确范围。默认不会生成 grant、批准 Delta、启动付费模型或关闭完成门禁。

## 3. 配置解析、来源与兼容

`src/local/config.mjs` 继续作为有效配置的唯一解析入口。新项目使用内置 profile；可选用户级插件设置和项目级稀疏覆盖只提供必要偏好。用户级设置位于插件专属 data 目录，不是第二套 PRD、业务状态或授权来源；不存在时不创建。

优先级为：已有显式 rev1/rev2 文件的完整原语义；对新默认合同则是内置默认→可选用户级插件偏好→可选 rev3 项目覆盖。显式工作区连接参数属于定位事实，不能通过配置优先级扩展权限。默认合同只接受已声明字段，不使用任意递归合并：数组替换、不拼接；provider/QA 复合选择须整体校验；`null` 不是删除或回退指令。

示意项目覆盖如下，**不是当前运行时已支持的输入**；基础使用无需创建此文件：

```json
{
  "schema_revision": 3,
  "profile": "standard",
  "qa": {
    "model": "operator-selected-model"
  }
}
```

原生路径、provider 清单 SHA、实际模型和二进制身份在本机解析为运行事实，不把示例绝对路径或猜测模型写进 portable 项目模板。默认常量、字段校验和 profile 版本只在配置 owner 定义，Skill、Hook 和打包器消费其结果，不复制规则。

配置文件存在但内容非法必须报错：JSON null/false/0/空字符串、非法对象、未知 revision、重复检查 ID、未知字段均不能使用默认值掩盖。存在但暂时不可读取也不是“缺失”。实现时用存在性与读取结果区分，不能沿用 `if (!raw)` 判定。

保留旧 `configured` 表示是否存在显式项目配置；新增 `configuration.source/effective/profile_id/profile_revision/digest`。持久操作判断有效合同及能力，不再只判断文件存在。begin 在原 cycle state 中固定有效配置快照、profile 修订、发现模式与 provider 身份；既有 rev1/rev2 和活动 cycle 不自动迁移。

默认升级只影响新 cycle。旧 profile 的可比较数据可归档在原 Store，但执行器/provider 仍必须与当时身份相符；不能因保存了 JSON 就宣称旧程序可运行。对应旧发行不可用时保留历史并报告能力缺失，走明确迁移/新轮，不放宽策略或伪造当前性。

## 4. 当前项目与会话路由

### 4.1 接入边界

在 server/Hook 适配边界新增小型项目上下文解析器。产品状态仍由原 LocalStore/CycleCore 拥有；解析器只维护宿主地址提示，不维护另一份 current cycle、grant 或任务系统，不需要后台守护进程。

正常 Codex 路径使用 Hook 的 `UserPromptSubmit` 发布 `{session_id, turn_id, cwd, model, observed_at}` 的有界记录到插件专属用户 data 目录；MCP 按宿主请求的 `{thread_id, turn_id}` 精确查找。字段经过当前宿主关联探针后才启用自动路由，不能靠 UUID 格式就认为来自正确执行者。SessionStart 只提供候选，不用上一条消息的路径替代当前 turn。

官方文档明确 Hook 输入含 session_id/cwd/model，turn 事件有 turn_id，而且子 Agent Hook 使用父 session_id；transcript 不是稳定接口。[Hooks](https://developers.openai.com/codex/hooks#common-input-fields) 当前项目源码只验证 MCP 的 thread/turn UUID，现有 CLI 证据仅证明 thread 与 Hook session 的部分关联；未证明所有 turn 或 Desktop 关联。MCP 文档的 cwd 是服务启动目录，不能推断成每个工具请求的项目路径。[MCP 配置](https://developers.openai.com/codex/mcp)

按请求选择正确 root 的 Runtime，复用现有核心。`--workspace` / `CYCLE_WORKSPACE` 作为操作者显式连接继续支持；若它与当前可靠宿主上下文冲突，报 WORKSPACE_CONFLICT，不静默选一边。在无显式连接的插件模式，禁止回退到 process.cwd、插件安装目录、父 Git 根或全局“最近一次 cwd”。

不把 roots/list 作为默认依赖：本机 SDK 的协议支持有限，而且多 roots 不证明当前 turn 使用哪个项目。可验证的其他宿主能力以后作为适配器接入。无 Hook、缺字段、冲突或未知客户端时只返回 context_required/ambiguous 与一次性选择入口；普通问题不因此初始化项目。

### 4.2 隔离、生命周期与显示

地址记录按插件自有 storage namespace 和精确 turn 标识索引，根路径规范化并核对真实目录身份。namespace 是同一已安装发行的 Hook/MCP 共享本地值，由 CODEX_HOME 的真实目录身份、插件身份和路由合同版本派生；它不是假设宿主会提供的新字段，也不是授权。记录 key 对该 namespace、session/thread 和 turn 的已验证对应值做规范化摘要，不直接用外部 ID 拼路径；复用现有有界 JSON、防链接、原子发布与租约模式。不同 CODEX_HOME/插件身份不能复用记录；同一 namespace 中冲突继续拒绝，不猜不同窗口/进程归属。记录只包含定位和能力候选，不含用户全文、源码、I 判词、秘密或操作权限。读写超时/损坏要明确返回上下文不可用，不能退回另一项目。

同一 key 出现不同 cwd、子 Agent 共用父 session 而无法区分、当前 cwd 与已关联根冲突时，标歧义而不是最后写入者获胜。跨 turn 不能借用记录；请求选中的 root 在整个操作内固定，下一次 cwd 变化重新解析。字节/条数和生命周期有界；清理只处理自有 transport 记录，不删除项目 cycle/evidence。

workspace 定位与 session→cycle 绑定分开：未加入 cycle 的默认 status 返回项目/config/能力概览及恢复指针，不自动展示另一 session 的完整 I 或给出续写绑定。显式同项目 cycle/status/历史召回保留审计语义，仍是只读，不构成许可；resume 要由已授权的显式操作取得当前绑定并结算，之后才绑定宿主 session。非控制类持久操作需路由与已加入 cycle 一致；legacy 显式工作区、无宿主 metadata 的操作继续按原 operator/binding 合同验证。

工作区仍只有一个活动可写 cycle；另一个任务不自动采用它。协作或恢复沿原控制入口，不能因自动识别项目就自动开始/继续旧任务。

## 5. 免登记组件发现

这是默认体验的必要依赖，不能只给 `component_reuse` 填固定路径。当前 SoL provider-only 要 architecture_path 和已登记模块，源码事实只支持 `.mjs/.js`；缺登记不等于缺组件，不能宣称现有接口已经支持无登记 JS/TS 项目。

插件应分发固定版本的 **SoL 只读 provider** 和真实清单；Node 路径取运行中的原生 executable，清单身份由发行确定，不让模型临时指定 provider。继续使用现有 Cycle gateway 完整捕获、recall/SHA、范围及已知效果检查；不引入整套 SoL Flow/Write/Hook，也不复制索引控制器。

新增独立版本的 `repository` 模式，既有登记模式/v1不变：

- 有识别且有效的原登记时优先沿原 provider/D v1。明确配置的登记路径非法必须报错；自动看到的同名但无法识别文件仍是普通来源候选，不能擅自赋予其登记权威。
- 没有登记时做有界文件库存和文本候选发现，不为每个私有函数造正式 components.json/architecture.json。复用已有安全读取、召回与静态分析；未支持语言的解析结果明确 unknown，而非“没有导出/没有调用方”。
- 文件级候选有独立 tagged 身份、路径、源 SHA 与 capture 引用，不伪装成登记 UID，不用 `unknown` 字符串冒充真实 symbol。关系分别为 static/inferred/unknown；候选并不证明语义可复用。
- repository 模式必须有对应的版本化 provider 合同和 `cycle-reuse-v2` D：按文件/capture/read 身份引用候选，要求真实源码段、影响调用方证据、选择理由和原验收。保留 D 原位置和单一事实来源，不另建决定数据库。新合同规范化进入原门禁，不复用 v1 的假 UID/symbol。
- 返回库存 complete/partial/blocked、扫描边界、跳过原因和关系覆盖。达到预算、相关文件不可读、未支持的必要关系不允许变成“无匹配”；可以继续查看正向候选，但 new 必须有完整的相关库存与能够独立复核的缺口理由。关系 unknown 不能变成零调用方，QA 也不能用通过判词洗掉该事实。

默认读取边界是已定位项目内、计划相关的源码与调用方，沿现有秘密/链接/控制目录排除；不扫描父目录或兄弟项目，不把全部依赖目录或仓库日志默认塞进上下文。普通 artifact 输入、发现范围与精确可写 scope 分开定义；扩大读取范围不增加写权限。当前 old grant.paths 的文案是精确修改目标，不把本次设计风险反向宣称为已证实的历史读权限漏洞。

初始预算复用现有硬约束：来源路径≤256、query paths≤16、每 read ≤8段×128行、视图≤16KiB、D块≤64KiB、每轮发现证据≤256。standard@1 的 repository 默认库存≤128个来源、单文件≤256KiB、源码捕获合计≤1MiB、枚举/捕获≤30秒；更低的现有读器上限仍优先。预算由配置 owner 固定并回报，超限返回 partial/blocked，禁止截断后称 complete。QA 继续执行原完整交付预检：库存预算通过不保证重复来源/快照也能放入QA容量；过大时拆较小的已授权任务，不降低检查和复用条件。

### 5.1 Repository v2 公共合同（拟实现）

provider 协议新增 `sol-component-discovery/2`，继续仅有 `sol_architecture_query`、`sol_read_file`、`sol_recall`。gateway 的非模型初始化 DTO 为 `{protocol, mode:repository, workspace_root, workspace_id, discovery_scope, scope_digest, budgets}`；repository 分支不要求 architecture_path。v1 初始化、声明与 UID/symbol 保持原样。发行清单列出实际支持的协议/模式，身份仍核验全部清单与原生 executable；未知协议/模式拒绝。

Cycle 的 discover/read 公共参数无需让模型选择mode/root/provider。query仍是有界paths/capability；read仍是安全path/行段，recall仍核验完整字节和SHA。mode来自已固定profile。repository query 的规范化全量包至少含：

- `kind:repository_query_v2`、protocol、workspace_id、scope_digest、inventory_digest、collection_stable、完整raw引用；库存摘要覆盖枚举后的路径、SHA和排除/失败，不仅覆盖视图中的候选。
- `coverage.enumeration` 和 `coverage.candidates` 各有 complete/partial/blocked、计数与原因；`coverage.relations` 独立标 complete_static/partial/unknown，不承诺运行时完整图。
- `sources/candidates` 一一对应读域内的每个可捕获源码文本文件，候选不因关键词、导出名或语言解析不命中而消失。candidate为 `{kind:source-file, candidate_id, path, sha256, line_count, symbol_status}`；candidate_id 是 workspace_id+规范安全path 的内容寻址本地身份，源码版本另外由SHA标识，绝不等于正式module UID。未解析symbol为空而不是字符串unknown。
- `relations` 只记录有来源path/SHA/行段支持的static或inferred边；`unresolved`列出未知关系/依赖及来源，不用空边数组替代unknown。未能分类/捕获的可能源码或必要依赖使coverage不足；已有明确的非源码资源排除在库存摘要中列出，不混作“未找到能力”。

枚举后须复核文件集合与读取身份，才能置 collection_stable=true；新文件、删除或字节变化使捕获失效。capability只影响排序/有界显示，不影响全量候选集合；过滤结果为空不证明无可复用组件。TSX只要是可捕获文本就有文件候选，不能因不支持TS解析而漏掉；其关系仍可为unknown。

gateway 保留原 reuse-query/reuse-source 归档种类，增加严格 protocol/mode/contract版本和coverage字段。所有引用仍是本cycle真实返回值。v2读引用必须匹配同一query中的path/SHA及实际来源，继续原保护、I捕获字节排除、完整recall和状态当前性检查，不另存可编辑的证据主副本。

`cycle-reuse-v2` 每条决定字段固定为 `{id,target_paths,acceptance_ids,decision,query_evidence_id,selected_sources,read_evidence_ids,candidate_assessments,rationale,path_roles}`，沿用规范JSON、决定≤16、target≤64和既有path_roles枚举。selected_sources最多32项，每项为 `{candidate_id,path,sha256}`，不接受selected_capabilities/假symbol。read_evidence_ids最多128项；candidate_assessments最多128项，每项为 `{candidate_id,conclusion:selected|not_applicable,read_evidence_ids,rationale}`，理由≤512字符。id/路径/验收必须来自原合同，coverage/complete不允许由模型填入或覆盖。

v2写前接线仍是 `prepare D→attach D→CycleCore cycle_apply preflight→assertReuseReady`；追加严格v2验证分支，不把v2转换成伪v1。所有决定共同要求固定mode/provider/读域、稳定全量query、当前来源、真实目标前态、精确grant和实际目标覆盖。进一步要求：

| 决定 | v2的额外机械前置条件 | 不能推导的结论 |
| --- | --- | --- |
| reuse | selected_sources非空；全部实际查询候选、来源/接口段与已知static/inferred调用方已读取；本次仅改声明消费者，共享候选前态保持 | 捕获或调用不能单独证明实际复用贡献 |
| extend | 上述引用齐备，受影响共享目标和调用方有覆盖；未知的相关关系/依赖未清理前阻塞共享修改 | inferred/unknown不能伪称全调用方已验证 |
| new | enumeration/candidates均complete且collection_stable；读域内全候选都有真实读引用和不适用判断，selected_sources为空；相关unresolved为空 | 文本关键词无命中、自由理由或QA pass不能证明无组件 |

相关未决集合至少包含涉及实际target/selected来源的未知关系，以及provider不能判定与任务无关的未知源码/依赖；不接受模型以文字宣称“不相关”清空它。解除需支持该语法的固定解析能力或可核验的来源/执行证据；若现有能力不足则保留阻塞，新增能力后开新轮。正向reuse可保留非相关的关系unknown为覆盖限制，但不得把它改为零；最终QA仍需核对原场景与真实贡献。空库存只有读域和收集事实完整时才能支持new；partial/blocked绝不能。

## 6. 检查、QA 与首次任务

发现检查只读 package/项目工具清单及现有入口，不执行脚本、不安装依赖。候选含来源摘要、ID、固定 argv 及执行目录；必须在 begin 的有效执行合同中固定，后续 `cycle_verify` 只能按 ID 选择。shell=false 不证明项目脚本无副作用。执行合同变化需明确更新；相关脚本/源字节变化使旧检查与 Q 过期，不能用 source-integrity 替代测试。

检查合同区分 `integrity` 与 `behavioral` 保证。影响可执行行为的源码任务在begin计划中列出适用的真实测试/构建候选及排除理由，适用项必须成为required行为检查；没有适用检查则明确behavioral_missing，Agent在获准范围准备最小有效回归检查，不把完整性检查或候选数0当测试通过。纯文档、注释或格式变化可以声明行为检查不适用，但须由实际diff和独立QA确认，不能凭实现者自述豁免代码行为变化，也不为这类变化新增无意义测试。finish对影响可执行行为的任务独立要求当前的行为检查覆盖；source-integrity回执永远不能满足该门。完整性、实际执行回执和QA结论分别呈现，未满足原场景覆盖仍不能完成。

默认 QA 优先项目/用户明确选择，否则用当前宿主 model 作为候选；原生 Codex 路径用已知安装布局与固定程序身份解析，不能执行任意仓库 launcher 来“发现”。发现、已配置、已校准、当前可用分别报告。不能猜某个具体模型、把宿主模型名当实际 QA 身份、静默换模型或降低沙箱。

实际校准继续沿显式 live 入口；Agent 可在已有 QA 授权下准备并调用，不要求用户手写整个 QA 配置。只有匹配 binary/model/platform/sandbox/driver 与有效 receipt，才开放受控 QA。普通 status/Hook/begin 不运行模型；模型不可用或校准失败只报告真实缺口，基础调查/已许可实现可继续，full finish 仍需当前有效 Q。候选未确定时只补一个必要选择，不开展整套配置访谈。

首次工程任务顺序：

1. status 解析项目、默认来源和已有记录；Agent 调查原需求/文档/源码，形成精确 scope、inputs、验收及执行计划。
2. 复用有效许可，或由原操作者入口确认本次范围。无许可的状态查询不持久化项目业务记录。
3. begin 固定 profile/执行合同、provider/读取范围和原任务。已有活动 cycle 必须明确恢复/协调，不能自动夺取。
4. 原项目没有 R/D 时，必要文档路径已纳入授权和精确文档豁免，先用原 `cycle_apply` 创建 R/D，再 attach；产品源码仍受 D 复用门禁。不是先让另一个写控制器代写，也不是豁免任意 Markdown。
5. 查询/读取候选→接入原 D→受管实现→原位机制说明与 I→固定检查→显式校准/独立 QA→同步与 finish。

已有 `.prd/`、docs/design、蓝图/NEXT 继续拥有原记录。确实没有载体时使用最少必要文档；R/D 可共用原计划，I 判词与交给 QA 的原需求/说明不能混为同一排除文件。不会在首次打开目录时创建五套文档。

重要函数目标仍由 Agent 按职责和本次变化选择，运行时核验已声明目标的来源/说明当前性，QA 对照实际 diff 检查遗漏和语义。默认不能假称具有 AST 全函数覆盖或参数运行轨迹。

## 7. Hook 与恢复约束

空闲项目的“没有活动 cycle”是正常状态；不在每次普通问答重复注入 unbound 警告。进入任务后 Hook 按已验证项目/session/turn 投影当前阶段、具体缺项和下一动作，不展开文档或调用 provider；完整 JSON 预算保持不变。

默认接入更多项目前须收窄已有过宽的原生写拒绝：对已确认目标与活动受管范围相交的写进行约束；其他 session 的明确范围外文件不因同工作区有 cycle 就被阻断。可信解码不了目标时，已加入该 cycle 的会话要求使用受管入口；未加入会话不能宣称获得路径级覆盖。实际支持的输入形状须用原生事件验证，不能把 benchmark 的观察正则直接当生产安全解析器。

MCP 后端始终核验实际写路径/前态/许可/证据；Hook 不是所有 Shell 或外部编辑器的拦截保证。路由故障不应启动任何备用写入口。

未知效果、pending、请求去重、取消终态和旧 binding 规则不变。默认恢复先查询同一操作，不换 ID 重放，不把配置、指针或 QA 自述当许可/通过。

## 8. 实现划分与验收门

| 边界/owner | 最小改动 | 不做的工作 |
| --- | --- | --- |
| 配置 owner：local/config + contracts | 内置版本/来源、严格覆盖、有效配置与快照 | 不复制业务 policy 到 Skill/Hook |
| 宿主 owner：server/hook + 小型上下文解析器 | 精确 turn 地址、Runtime 选择、session 可见性与坏路径拒绝 | 不读全文 transcript，不建立后台服务/第二个 current |
| 发现 owner：SoL provider-only + 原 Cycle gateway | 固定分发、repository/D v2、完整捕获与覆盖 | 不启用SoL产品写入，不建每函数正式登记 |
| 工程 owner：CycleCore/WorkspaceAdapter | 新合同入口、文档 bootstrap、固定许可/检查/完成条件 | 不因默认值放宽 grant、未知效果或 QA |
| 交付 owner：打包/Skill/现有文档 | 打包默认和provider、解释新状态、完整Skill清单核对 | 不自动改全局规则/旧独立Skill或已安装缓存 |

交付按依赖推进：P0先做真实宿主只读关联探针；P1落默认解析/路由和兼容；P2无登记发现/Dv2与首次文档；P3检查/QA候选和首次完整任务。用于编码的“免配置”验收不能在P1结束时宣称完成，P2/P3是必要依赖。此次仅设计。

| ID | 可观察验收 | 当前状态 |
| --- | --- | --- |
| DEFAULT-01 | 无配置 status 有内存默认来源，不创建项目文件、不启动命令/模型 | planned |
| DEFAULT-02 | 存在 null/false/0/空字符串/非法或未知配置时明确失败，不回退默认 | planned |
| DEFAULT-03 | 原生安装在插件目录启动，但当前项目甲的请求实际指向甲；插件缓存哨兵不变 | planned，真实宿主P0 |
| DEFAULT-04 | 两项目/同项目双session/子Agent父session/cwd切换不串根或自动夺取cycle；冲突不最后写入者胜出 | planned，TUI与Desktop分别测 |
| DEFAULT-05 | 无Hook/缺turn/损坏或过期记录只提示补上下文；不回退安装目录/最近项目 | planned |
| DEFAULT-06 | 无配置、有有效授权可begin；无授权仍拒绝；普通问答无cycle/检查/QA | planned |
| DEFAULT-07 | 无登记空项目和已有共享函数项目走repository；真实reuse改变消费者结果，不造UID/symbol | planned，包含有效贡献正控 |
| DEFAULT-08 | 超限、秘密/链接、未支持必要关系、不可读来源不报告空库存/new可用；TSX已枚举但无解析时仍有文件候选；过滤0不抹掉全量候选；范围外在读字节前拒绝 | planned |
| DEFAULT-09 | 新R/D经同一受管入口创建，任意业务Markdown不因此豁免；I判词不污染QA原需求 | planned |
| DEFAULT-10 | 带sentinel副作用的测试脚本在初始查询/begin中不执行，显式固定verify才执行；仅source-integrity不能关闭代码行为变化的behavioral_missing或满足finish；纯注释/格式变化按实际diff和QA判断不适用，不新增无意义测试 | planned |
| DEFAULT-11 | 发现二进制或model但未校准不标QA ready；身份漂移/失败不静默换能力；finish仍阻塞 | planned |
| DEFAULT-12 | 现有rev1/rev2无默认合并；active旧profile在升级后不静默迁移，旧执行身份缺失如实失败 | planned |
| DEFAULT-13 | 生效范围内原生写约束成立，另一session范围外写不被误拒绝；未知输入不假称路径覆盖 | planned，原生事件 |
| DEFAULT-14 | 源码/说明变化使I引用陈旧；重要目标遗漏由QA检测，不以目标0冒称全函数已说明 | planned |
| DEFAULT-15 | pending/unknown恢复不重放命令或写入；精确scope和QA原门禁保持 | planned |
| DEFAULT-16 | 一次正常新项目任务无需手写配置/provider字段，完成原需求/复用/实现说明/独立QA；不足条件如实未完成 | planned，完整实际任务 |

静态多角色评审不能替代上述运行验收。目前没有为本设计跑模型、修改源码、安装默认配置、改版本或宣布新的组件复用分数。
