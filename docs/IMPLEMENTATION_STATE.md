# 实施状态

目标来源：用户在本聊天确认独立插件后要求“做吧”。需求/验收沿用 [AC-01–18](design/acceptance.md)，设计为 [架构 v2](design/architecture.md)。2026-10-08 用户另行授权自行安装插件、只用 TUI 验收，并要求更新 Codex CLI；已完成真实安装与本机 TUI 复验。提交、推送和插件发布未授权，插件版本仍为 0.1.0。

最新实施恢复点（2026-10-10）：用户在[DEFAULT-v1](design/default-configuration.md)与[四角色裁决](design/review-history.md#2026-10-10-默认配置与首次使用)后确认实施。内置standard@1、严格覆盖/legacy分支、当前turn项目定位、repository/D v2、父目录bootstrap、真实路径集合当前性、检查与QA候选、固定合同和签名校准选择已接入源码。回归228/228与审计0已保留（运行跨r3→r4）；最终r4相关29项复验、53/53生产输入核对与独立源码QA通过，完整Skill8文件和Provider1750项打包匹配。真实CLI校准被Windows sandbox helper刷新失败阻塞，未启动主任务QA/finish；安装更新因旧marketplace地址冲突未完成，当前已运行MCP仍不能视为新版。[实际实现/恢复点](design/default-implementation.md)与[独立QA](evidence/default-configuration-20261010/independent-qa.md)为当前入口。版本0.1.0，未改全局规则或旧独立Skill，历史博客分数不变。

主安装续接（2026-10-09）：用户重启后继续安装，并提出直接卸载重装。官方更新因占用返回 os error 5；官方卸载删除文件后因目录占用返回 os error 32，安装记录仍启用。已在确认空缓存后发布核对过的完整原生包，并更新 marketplace 来源；34文件匹配、0缺失、0漂移，含完整8个Skill文件。新进程注册七工具、新描述/只读status/SessionStart Hook通过；用户再次重启后，当前会话已加载新接口描述，实际 MCP status 返回 ok=true，旧服务进程已退出。当前项目没有绑定工程循环，SESSION_UNBOUND不表示安装失败。不把这些检查当成Desktop全事件覆盖或新的博客成绩。详情见[主安装证据](evidence/plugin-update-20261009.md)。

最新实施恢复点（2026-10-09）：用户“ok 改吧”后的 CRCTX-v1 源码已完成。真实 SoL provider-only、七工具内写前门禁、D 固定目标前态/settled cursor、Hook 会话/2048字节预算、QA 证据分页/容量预检及 v2 贡献评分均已接入。最终工程循环161/161、SoL314通过/20平台跳过，审计均0漏洞；25个reference正控全通过。独立实现反例复核的目标前态/删除游标/QA容量问题已修正。真实CLI会话路由与原生拒绝有证据，直接trace分析器失败及其边界保留。新包已生成；全局cache正被MCP进程占用，官方刷新返回os error5，旧注册/缓存已保留。完整证据与下一安全动作见[本轮验收](evidence/component-reuse-20261009.md)。版本仍0.1.0，旧博客2/8、4/25及历史证据不改，没有新模型off/on收益结论。

历史博客交付（2026-10-08）：基线P1/P2、函数实现说明、本机TUI夹具和固定八题已交付；当时项目141/141检查、审计0漏洞及Move负例11项定向通过，详见[原博客验收](evidence/benchmark-blog-20261008.md)。旧三臂121项、72/92项、模型与安装证据保留。博客测量到verified implementation handoff与外部评分，其他平台和Desktop全流程未验收；这些旧结果不替代上述新增能力检查。

本轮新增目标来源：用户要求“安装这个工具，然后针对这个工具写一个 benchmark”，沿用[BM-01–07](design/benchmark.md)，入口为[运行说明](../benchmarks/README.md)。新增 benchmarks/ 数据集、门禁、隔离 CLI、外部评分和报告，以及 npm bench/bench:live 命令；生产 runtime/七工具/Skill 契约与依赖保持原实现。后端9项、两个案例的4个oracle/no-op符合预期；真实模型对照仅decode-record三臂各1例、14调用，三组说明/维护/同步均通过，完整插件实际 Hook/MCP生效，但本例尚无质量收益证据。CRLF修复后的11项确定性复评保持结论，认证链接已清理，无运行中的benchmark/QA。下一执行指针是按运行说明选择新的案例/重复计划；完整QA/finish和长对话抗偏移benchmark未运行，不自动宣称效率或费用改善。

本轮博客增量：用户指定“在 Codex 安装插件，依旧做博客项目，用 benchmark 跑分”。全局 agent-engineering-cycle@engineering-cycle-local/0.1.0 已启用，16 个生产源码与安装缓存/v3 冻结输入一致。`bench:blog` 复用 blog-eval-v1 固定题，真实 gpt-6-luna/max 八项、41/41 行为、88/96 合规、完整成功2/8、有效复用4/25，原评分未改。六题额外更改登记文案违反旧评分的精确字段冻结，B04/B07还有复制函数体扣分；功能均通过，不将分数解释成六题功能失败。最终全量源码/登记说明评估32/32（未人工/负控校准），真实浏览器11/11。实际候选 B03 提供可运行 demo；认证链接已清理、模型已结束。恢复点为现有报告和入口，无需重新生成代码；后续若要比较插件收益，应另立新开关对照，不改写本轮结果。未提交、推送、发布或改版本。

分工：主Agent维护公共合同、Store/权限、CycleCore、runtime/CLI、QA driver与最终验收；Luna workspace owner负责文件/快照；runner owner负责固定argv与取消；transport owner负责MCP/Hook/插件/Skill分发。各owner仅写本人范围，独立QA在源码冻结后启动。

原架构和原评审是历史基线，不把其中“本轮只设计”当成这轮的新权限限制。原始报告保留，以下只记录当前实际结果。

## 实际系统

入口：[README](../README.md)、[CLI](../src/cli.mjs)、[MCP](../src/server.mjs)、[Hook](../src/hook.mjs)。两种传输共用 [CycleCore](../src/core/cycle.mjs)，公共schema只在 [contracts](../src/core/contracts.mjs) 定义。源码不导入SoL或slop；源码保留 portable manifest，Codex 原生包由 [打包脚本](../scripts/package-plugin.mjs) 生成，分发同一份运行时与 Skill。

状态目录为目标项目 `.codex/engineering-cycle/`，项目检查配置为 `.codex/engineering-cycle.json`。原R/D/I/Delta仍由原文件拥有，core保留内容身份、冻结副本、操作/检查/QA证据与恢复指针。`cycle_status`和prepare在未配置时只读；初始化、授权和CLI校准是显式操作，普通查询不代做。

七个工具已注册：control、status、artifact、apply、verify、qa、reconcile。实现了精确全文件write/delete、路径/链接/秘密文件保护、跨进程租约、binding、request去重、pending/outcome/settle与归档后恢复。未知结果不重放，外部源/配置/环境变化使相应证据过期；源/完成/检查归档损坏也阻止当前完成。

授权入口由交互式CLI在确认精确scope后签发本地HMAC receipt，MCP只引用receipt，不接受调用方source/user/approved字段铸造批准。它记录本地operator通道，不认证人类身份，不隔离拥有相同OS权限的其他进程。需求决定与动作许可独立；Delta同步前/后/第三态分别结算、显式续写、冲突退出。

QA由独立CLI exec运行，程序冻结真实输入，异步worker保存job、原始执行/报告与终态。私有只读MCP提供冻结文件分页、原目标/动作模式和原始检查事实；不交付I判词。只有实际完整读取、身份/终态与校准所需维度满足，才接受为当前Q。Cancel请求不代表终态；unknown继续阻止新job。

## 验证与缺陷处置

| 范围 | 已取得证据 | 限制 |
| --- | --- | --- |
| 本地行为 | [check.txt](evidence/check.txt)：72 tests / 72 pass / 0 fail，含真实多进程租约、Node进程树取消、UTF-8 stdin、ABA副本、scope/幂等/同步/归档恢复与实际MCP stdio | 部分QA/批准fixture明确为模拟，不能当真实身份或模型证明 |
| 依赖审计 | [check.txt](evidence/check.txt)最终整条命令退出0，npm官方端点0 vulnerabilities；[单独审计](evidence/audit.txt)也通过 | [首轮失败](evidence/check-mirror-failure.txt)因全局npmmirror审计端点404；项目命令显式指定官方端点，未改全局配置 |
| CLI QA P0 | [p0-cli.json](evidence/p0-cli.json)：driver3、codex-cli 0.158.0、本机Windows；固定read-only写探针被拒绝，fresh QA实际读冻结源码并发现18岁边界错误 | 这是已知缺陷夹具的能力验证，不是本插件全部REQ的模型验收 |
| 包装/发现 | [host-plugin.json](evidence/host-plugin.json)：独立临时CODEX_HOME中marketplace add/plugin add/list退出0，installed/enabled=true | 用户真实安装未改；未证明Desktop Hook信任、启动或事件覆盖 |
| 独立源码QA | [初验](evidence/independent-qa-initial.md)发现3个原套件未覆盖的问题；[定向复验](evidence/independent-qa-recheck.md)在新冻结副本中确认原反例修复，67项相关测试通过 | 该reviewer未运行模型/Host；CLI和安装保证引用各自独立证据 |
| 真实异步闭环 | [async-poc.json](evidence/async-poc.json)：原R/D/I接入、真实Node边界检查、一个`gpt-6-luna` CLI QA job、完整源读取、`turn.completed`/exit0、当前Q有效、finish归档后`current_complete=true`；[最后只读核验](evidence/delivery-check.json)再次确认同一job与完成状态 | 这是正向边界夹具；本地授权刻意标为synthetic fixture，不证明真人来源、全部AC或Desktop行为 |

三项原失败保留：unknown QA被误判终态；finish归档与发布之间无恢复引用；完成归档损坏仍报当前完成。修正分别是明确quiescent、归档前持久化completion_expected_ref并复核恢复、验证整个完成/检查引用链。新增回归覆盖同一完成引用恢复、不重跑、漂移时不发布、损坏时保留历史但当前无效。

真实async预检又发现校准程序生成的`p0-live-qa`/`p0-sandbox`证据名称被Store读取规则拒绝，虽然原始证据摘要和签名正确，QA仍未启动。已统一归档与读取的kind规则，允许数字前缀片段并保留路径/摘要校验；新增Store与qaCapability集成回归同时覆盖成功读取、证据篡改和非法路径拒绝，不重签或重新校准已有证据。

[数字前缀复验](evidence/p0-evidence-id-recheck.md)还发现只改kind仍被接受。已把kind、schema_revision、id与payload摘要一起校验，归档复用和读取共用同一规则；[封套复验](evidence/p0-evidence-envelope-recheck.md)以原反例确认两处都拒绝，14项定向测试通过。此前失败、修复前检查及复验历史均保留。

真实QA读取需求、设计和代码；I作为工件保存，未交付实现者判词。QA报告、完成记录与P0的安全原始证据已按内容身份导出到`evidence/raw/`，私钥和authority记录没有导出。最后的只读核验不重跑检查、模型或finish。

## 刻意限制与设计适配

- Docs权限只准运行具名内建 `source-integrity` 读校验，不准任意配置命令改代码。它核对真实来源身份，不冒称代码测试或语义验收；配置形式为 `{"id":"doc-source","kind":"source-integrity"}`。
- MCP需显式 `--workspace` / `CYCLE_WORKSPACE`，Hook核对实际event.cwd。portable默认目录不能推断用户工作区，未绑定项目不初始化状态。
- Stop continuation/自动block仍关闭；缺少已验turn/ticket来源时仅提供其他事件提醒和已匹配写入口guard。Shell/外部编辑器不在全面拦截保证内。
- Native subagent运行时observer未实现；首版使用已校准CLI路径。CLI虽然不继承原会话，仍可能加载全局Skill目录；不声明空上下文、隐藏服务端prompt或模型真实身份已验证。
- Node20.8、Linux/WSL/ARM64、真实Desktop重启/信任/Hook timeout与全部18项Host矩阵尚未本轮验证。CI已配置Windows/Node24，但远端未运行。

基线恢复点：本地首版源码与上述验证已收齐，无需重做架构或原始研究。后续在用户明确指定的工作区接入运行时，校准实际driver，再验收Desktop信任/启动/Hook覆盖；Stop自动续跑仍待可核验turn/ticket合同。只补受影响验证，保留当前失败历史和独立证据。

## 2026-10-08 函数实现说明增量

用户批准的是[NOTES-01–06](design/implementation-notes.md)：为后续LLM维护和抽象补充实现步骤、参数/包接口流向、错误副作用与不变量。已更新插件Skill的按需参考、原位说明与I/Q交接；[当前实际函数说明](implementation-notes.md)和代码旁注释覆盖archive及新增两个引用检查函数。

运行时沿用七工具。begin声明需说明的path/symbol；I保存原文与源码/相关文件SHA引用；status读取有界原文并显示当前性，过期或遗漏target阻止QA/finish，Hook仅输出计数。新组件`src/local/implementation-notes.mjs`复用Workspace；没有新增包、解析器、全局配置或自动Stop续跑。symbol/文字正确性仍待语义QA。

最终检查：[npm run check](evidence/check-implementation-notes-20261008.txt)退出0，88 tests / 88 pass / 0 fail，官方审计0 vulnerabilities；Skill quick_validate通过。旧无notes行为、七工具stdio及原恢复/权限套件均包含在本次检查中。

[独立初验](evidence/implementation-notes-qa-initial.md)实际复现了Windows大小写路径别名将I判词送入QA，以及分页拆Unicode代理对。已按实际打开文件身份排除I别名（新测试也覆盖硬链接），并让QA/status/prepare/笔记摘录共用完整字符切片；未放宽写入授权。旧固定页长断言改为实际游标和每页字符完整性，[旧失败](evidence/check-implementation-notes-old-page-assertion.txt)保留。

[独立复验](evidence/implementation-notes-qa-recheck.md)绑定45文件最终冻结digest `7ab3abad7faef83abc8524e1c370486e4bf8cc94f6d86fd10accdfc66ec0315f`，确认原两项边界关闭；维护案例补齐了zod具体API、锁版本及直接/间接依赖说明。最终源码/测试/Skill身份核对见[交付核验](evidence/implementation-notes-delivery.json)，I总结在验证后更新，不反向替代冻结证据。

QA冻结输入集成用例实际保存source/doc/related原字节与targets/references，排除I汇总；未校准worker真实返回unknown/unavailable且确认PID退出后才清理。这证明冻结输入与负校准行为，未调用模型，不把它说成模型QA通过。本轮独立Agent的源码/原文维护案例与真实本地MCP复验另列于报告；旧CLI模型PoC不能替代新文字语义的全自动保证。

完成范围：当前声明的函数说明可供LLM按需读取与回查源码，过期/缺失会阻止完成；程序不自动识别全部函数、不验证symbol存在或文字语义、不生成全仓调用图。全文件SHA意味着同文件其他修改也保守失效；未来增量只补受影响项。全局Skill/安装、SoL、Stop续跑和未测平台边界保持原状。

## 2026-10-08 真实安装与 TUI 复验

用户新增授权后，Codex CLI 已更新为 0.161.0，独立插件已安装并启用。TUI 读取了打包 Skill、注册七个工具、审查并信任四个 Hook；实际原生 apply_patch 被拒绝，受控修改、实现说明引用、固定检查、独立 CLI QA 与 finish 有真实结果。最终夹具为 completed/current_complete=true；详见[验收记录](evidence/tui-acceptance-20261008.md)与[原始事实](evidence/tui-acceptance-20261008.json)。

本轮补齐 Codex 原生分发、显式 Windows QA 沙箱模式及校准绑定，修复 Windows 快照发布的有限重试，并保留失败阶段诊断。持续权限拒绝、目标占用和未知 QA 操作不会被转成成功或强制重放。前两份失败夹具保留，最终夹具另行授权、重新校准并完成。

最终源码检查为[92项测试与审计](evidence/check-tui-final-repair-20261008.txt)，全部通过、零漏洞。TUI/QA、已匹配 Hook 与权限边界分别按证据接受；旧段落关于未全局安装的描述属于此前阶段。Standalone Skill、SoL 与插件版本未改，未提交、推送或发布。Desktop 全流程、其他平台与自动 Stop 续跑仍未验收。

## 2026-10-09 复用门控真实博客实测

当前源码在隔离 CLI 中安装，交互 TUI 启动探针通过；八项真实 gpt-6-luna/max 任务使用原生 CLI exec，复用策略开启。完整任务 0/8、行为 0/41、v1 有效复用 0/25、v2 M=0/E=25；25 项正控及贡献探测均执行，基础博客浏览器 11/11。七项超时，一项主动报告阻塞，产品代码均未写入。D 的缺失调用方反馈、错误计数和重复分页消费存在实际使用障碍；源码检查通过不能替代这次失败的模型任务。

夹具补齐 public/ 读取范围，保持写 scope；修复 v2 probe 的候选目录调用，16 项相关检查通过。原环境失败和后处理 exit1 均保留，补充评分在同一原冻结输入上完成，没有重跑模型、修补候选或改评分规则。完整证据与待改进项见[本轮博客实测](evidence/blog-benchmark-20261009.md)。没有同输入 off/on 因果比较、完整 TUI 博客流程或插件内校准 QA/finish 证据；正式 cohort 的认证链接及临时 home 已清理。

## 2026-10-09 复用反馈与增量取证修复

已增加有界候选/调用方/行数视图、具体缺读与字段诊断，按已验证 D 引用统计读取和覆盖；正常选择不再重复拼原始归档。独立读范围与 I 捕获字节隔离补齐实际反例；旧 I 用原 manifest SHA兼容。未变 read ID 可随 ready 新查询继续使用，登记同步应先规划并批量提交，不能将 blocked 查询当成有效新证据。

全套检查166/166、审计0漏洞；最终范围1/1、增量provider1/1和记录器11/11另验，真实 native Hook输入与deny、未变产品字节已核对。两个 B01 smoke 连接中断或超时，虽有 D挂接和产品写入，未完成 I/verify；部分消费者探针仅确认分页贡献，不能当新八题复用率。失败、清理和源身份详见[当前证据](evidence/reuse-usability-20261009.md)。全局缓存未刷新，本轮使用当前源码的隔离安装；没有 commit/push/发布。
