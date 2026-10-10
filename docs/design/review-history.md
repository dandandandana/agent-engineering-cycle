# 架构评审与主 Agent 裁决

日期：2026-10-07。对象：独立 Agent Engineering Cycle 插件的 Hook + MCP + Skill 架构；本轮交付设计，不实现或安装产品。

入口：[架构](architecture.md)、[实施验收](acceptance.md)。原始评审保存在 [本轮记录目录](reviews/2026-10-07/)，保留决定前草案与各 reviewer 原文；最终方案优先于旧草案。

## 方法和证据

主工作流为已安装的 design-review-council，dispatch-subagents 只负责模型路由。A 设计、B 红队、C 实现/Eval、D 可维护性分别由真实 GPT-6 Luna max 子 Agent 执行。首次使用同一事实包，未互传意见；并发上限包含主 Agent，先 A/B/C 后 D。主 Agent 合并根因、独立裁决；对 v1 的关键约束复用 B/C 定向复核。角色人数和一致意见不作为正确性证明。

用户明确决定独立插件，codex-sol 为参考。该选择已合入最终架构；v0 中的未决落点保留为历史，不再作为当前待办。早前 agy Gemini 搜索实际遇到 location unsupported，未把失败调用算作研究结论；本次架构评审使用已可用的 Luna 路径。

参考版本固定为 codex-sol 的 `codex/linux-adaptation` 分支、`7d7de9569b8e35e0582864789fd83c0c6c956b95`，本地/同分支远端已核对；默认分支不是本次基准。实际读取 runtime、server、Context/Change、Hook、Store/租约、Workspace/写入、Validation/runner 和插件配置。

本聊天已运行：`node --test --test-reporter=spec tests/change-hooks.test.mjs tests/context-change-hook.test.mjs tests/closure.test.mjs tests/change-recovery.test.mjs`，45 计数，44 pass，1 Windows chmod skip，0 fail。相同源码/环境直接复用，未重复运行。这只验证参考仓库的所测路径，不证明新插件。

SoL 的 [共享 runtime](https://github.com/dandandandana/codex-sol/blob/7d7de9569b8e35e0582864789fd83c0c6c956b95/src/runtime.mjs) 与 [Hook](https://github.com/dandandandana/codex-sol/blob/7d7de9569b8e35e0582864789fd83c0c6c956b95/src/context-hook.mjs) 可参考职责分工；[Change](https://github.com/dandandandana/codex-sol/blob/7d7de9569b8e35e0582864789fd83c0c6c956b95/src/architecture/change.mjs) 的组件业务与 `identity_verified:false` 使它不能直接承担通用循环或证明独立 QA。

C 只读核对了本机 codex-cli 0.158.0 help，以及 [CLI non-interactive](https://learn.chatgpt.com/docs/non-interactive-mode)、[Hooks](https://learn.chatgpt.com/docs/hooks)、[Subagents](https://learn.chatgpt.com/docs/agent-configuration/subagents)、[App Server](https://learn.chatgpt.com/docs/app-server) 官方入口。未启动新 CLI inference 或 Host PoC；文档/help 不构成运行证明。

## 发现处置

表中“采纳”表示已形成设计条款；对应行为仍按 AC 验收，不能据此写成已实现。

| 原发现 | 裁决与理由 | 最终位置 / 验收 |
| --- | --- | --- |
| A1、D1：SoL 不是可分发通用循环 provider，独立安装不能暗依赖它 | 采纳。插件自带窄 CycleCore/本地 adapter；当前 SoL 无发布公共库合同，深层 import 或整体复制会绑入 module_uid/JS 业务。组件查询仅为可选 Skill 工具组合 | 架构 §1–3，AC-01 |
| A2：工作阶段与生命周期混在单字段 | 采纳。stage、lifecycle、blockers、pending 正交；恢复不丢原工程位置 | §5、9，AC-02、05、06 |
| A3、D2：R/D/I/Delta 正文和 runtime 状态可能双维护 | 采纳。原文档拥有正文，core 只持不可变 refs 与运行事实；不建第二 PRD 或通用工件总线 | §4、6、10，AC-01、12、13 |
| A4：旧草案仍把已答的落点写为未决 | 采纳。最终基线明确独立产品，v0 仅留评审历史 | §1，用户答复 |
| B1、C1：报告字段可伪造独立执行/输入/终态 | 采纳规则；实际能力待验证。adapter 独占 observed 证据，保证按维度分列，模型字段不可升级；缺证不能完成要求独立 QA 的目标 | §7–8，AC-08、09 |
| B2：引用批准、角色字段或获准需求可越过动作权限 | 采纳规则；可信来源待 P0。ActionGrant 与 RequirementDecision 分开；来源可见性不等于授权语义，现有适用授权复用 | §7，AC-03、11、12 |
| B3：仅前后 hash 会漏掉 QA 期间 A→B→A | 采纳。QA 实际消费冻结副本和 manifest；源码变化只允许归档历史报告，不能把晚到结果接为当前 Q | §8–9，AC-07、08 |
| B4：进程内 mutex 无法保护 Hook/MCP 多进程 | 采纳。跨进程 lease 内重读 binding/CAS、登记 pending、发布指针；文件系统与故障行为待 PoC | §5、9，AC-02、06 |
| B5、C3：已执行后 capture/archive/settle 失败可能误重放；公开回执会丢事实 | 采纳。稳定 request_id、请求摘要、pending→outcome→settle，known/unknown 分列，完整保留 launch/terminal/capture/cleanup/effect；不靠空 exit 判没执行 | §6、9，AC-04–06 |
| B6：Stop 次数范围和无进展判定不清楚 | 采纳。每 turn 最多一次，同 cycle revision/action 去重；ticket 为 core 辅助账本，blocked/interrupted/缺证允许未完成退出 | §11，AC-15、16 |
| D3：只绑定源码，忽略 QA 策略变更 | 采纳。具名 policy ID/revision 与项目配置身份进入 Q 当前性；仅复验受影响边界，旧报告保留 | §4、8，AC-10 |
| D4：旧文档接入和多文件同步缺少恢复条件 | 采纳。只映射来源不迁移正文；逐项前/后态与 operation ID；after 结算、before 显式续写、第三态冲突 | §4、10，AC-01、13 |
| C2：CLI 与 native subagent 尚不能选优 | 采纳。先考察程序可控 CLI 入口、对照 native；两者均待 P0，选默认驱动须靠真实结果；无可用 driver 不假称完成 | §8、12，AC-08、09 |
| C4：术语不是可实现的公共合同 | 采纳。收敛为七个工具，明确消费者、输入输出、错误与局部效果；P1 冻结 schema/调用方，验收保留成功/失败主链 | §3、6、9–12，全部 AC |
| C-V1-1：AC-09 会被理解成强制两种驱动都调用 | 采纳。v2 候选逐条分列尝试/授权/可用/失败/通过；首版至少一个实测驱动满足所需保证即可启用，未测路线不比较优劣，不为凑矩阵消费调用 | §8，AC-09、P0 矩阵 |
| C-V1-2：来源能力失败时哪些操作禁用不直观 | 采纳。v2 明列能力到工具的门禁；未验证 Decision/Grant 只开非持久只读视图，不准启动、写回、批准或完成；有效原授权继续复用 | §7.1，AC-03、11 |
| C-V1-3：错误/局部效果缺少逐操作稳定合同 | 采纳。v2 加入七工具逐操作持久化点、错误/可知效果、同 request 查询与恢复表，不由 MCP/Hook 各自推断可重试 | §6.1，AC-04–06、13–14 |

## 未选路径与剩余假设

- **不采用当前 SoL 私有 import / 整体 ChangeCoordinator。** 独立分发和通用项目是当前要求；未来真实复用代码要先建立可发布公共边界与兼容验收，本轮不扩大 SoL。
- **不把任意 Shell、外部编辑器、Hook fail-open 视为受控。** 首版只有明确匹配的 Host 入口与受管操作保证，其余变化检测会使旧证据失效；这不是全面隔离系统。
- **不预建通用 provider/DSL 或强制 PRD 迁移。** 首版消费者明确，原文档/项目检查和精确写入足够；patch 引擎、多可写 cycle 与第三 QA 路径等按真实需求再设计。
- **暂不选择 QA 驱动或承诺批准来源已观测。** Driver 身份/输入/终态、宿主确认来源、readonly、取消/子进程清理、锁存活、Hook 重复 Stop 都是 P0/P1 实验门；失败时降低可用能力并明确未就绪，不能用 schema 补证。

## 定向复核与交付状态

B 对 v1 确认原 B1–B6 规则缺口已处置、未发现新增架构阻断。C 对 v1 提出上述三项澄清，主 Agent 合入 v2；C 定向复核 v2 后确认 C-V1-1/2/3 均已处置、指定范围无新增设计阻断。原报告随本轮记录保留。最终 runtime 行为仍需执行 AC，评审通过不替代 P0/P1/P2/P3。

本轮新增的正式内容仅为本目录设计、验收和评审历史。参考 codex-sol 与已安装纯 Skill 保留当前文件；未创建源代码、package、Hook/MCP 注册或全局配置，未 commit/push。新插件 AC-01 至 AC-18 全部为 planned。

正式文档检查：16 个 Markdown 文件均可严格 UTF-8 解码，无冲突标记；3 份主文档的 9 个本地链接有效；AC-01–18 唯一且连续；13 份原始记录与工作稿 SHA-256 一致。交付前再次核对参考仓库工作树干净、HEAD 不变，现有 Skill 入口摘要不变。文档检查不证明新插件运行行为；产品构建/测试尚未配置。

## 2026-10-08 组件复用与上下文控制

本轮对象为博客评分后的组件发现接入、写前复用决定、单一受管写入 owner 和 Hook 注入控制。用户要求按 design-review-council 审核后交付设计/实施文档；未授权本轮实现、安装、跑新分、提交或发布。主工作流读取已安装 council 与架构/Prompt 边界参考，dispatch-subagents 只负责路由。

真实 A/B/C 以相同[事实包](reviews/2026-10-08-reuse-context/00-brief.md)首次最小上下文独立执行，槽位释放后启动 D；全部是用户偏好的 gpt-6-luna/max，没有把旧审查或角色模拟冒充本轮，未声称 Gemini 参与。角色依次为设计/合同、红队、实施/Eval、维护；首次不提供其他 reviewer 意见，均只读、不运行插件或 benchmark。SoL 不存在 src/cli.mjs 的路径更正同时发送给 A/B/C，保留在事实包。

原始记录：[A](reviews/2026-10-08-reuse-context/01-design.md)、[B](reviews/2026-10-08-reuse-context/02-redteam.md)、[C](reviews/2026-10-08-reuse-context/03-implementation-eval.md)、[D](reviews/2026-10-08-reuse-context/04-maintainability.md)。主 Agent 作以下裁决；采纳仅表示设计已处置，运行时仍 planned。

| 发现 | 裁决和理由 | 合同 / 验收 |
| --- | --- | --- |
| A1、B1、B9、C3、D2：双控制器与未受管写路径 | 采纳。provider-only 独立入口，完整 SoL 同任务组合冲突；唯一 owner 仅为受管入口，不靠扩大 Hook 正则承诺全宿主隔离 | CRCTX §2–3，REUSE-01/09 |
| A2、C1、D1：实际无 provider-only/公共能力/客户端 | 采纳主体。固定发行/协议/工具与启动身份，独立分发，client 为 P0。**不采纳 D1 完全禁止观测 Store**：复用 ObservationPack/read/recall 需专用传输 cache；禁用的是 SoL 业务状态/流程工厂，不是可丢弃原字节归档 | §3–4；REUSE-01/02/06 |
| C1、C5：宿主直连或内部 gateway 两条路径 | 采纳澄清。选 Cycle 内部 gateway，模型只见七 cycle 工具；其请求/回应直接捕获，不采信模型转述。模型直连多工具不纳入首版 | §2、4；实施 §2；REUSE-01/02 |
| A3、B2、B4、C2、D4、D5：写前来源/决定未被门禁控制 | 采纳。D 唯一 block，完整实际捕获引用与版本，pending 前复核。结构/字节/视图与语义/送达分开，读取/理由不授予批准 | §4–6；REUSE-03/05/10 |
| A4、C2、C6：目标分类可能绕过 | 采纳 A/C6 的实际全目标检查；**不采纳 C2 的未声明实现目标继续旧写入行为**，仅在未启用项目保留旧行为。enabled 下除 operator 文档白名单外均需覆盖，implementation_targets 只管说明 | §4–5；REUSE-03/04 |
| B3：源文本与命令/权限混淆 | 采纳。原批准机制保持，固定 executable/argv/环境；仓库描述/源码/模型理由不进入 Hook 指令 | §3、7；REUSE-09 |
| B5、B6、A5、D6：session 串线与未知送达 | 采纳。实际 Host 关联、缺身份通用指针；有限 debounce、恢复必发；generated 与 ack 分开。SoL ContextSessions 不复用为投递回执 | §7；REUSE-07/08 |
| B7、A5：预算不可验证 | 采纳。完整 Hook JSON 连 envelope/reason UTF-8 ≤2048，确定性删字段、最小指针；不声称整个宿主 token 预算 | §7；REUSE-08 |
| B8：查询超时/归档副作用重放 | 采纳。每 operation cache namespace、终态/清理/缓存实际效果与 outcome 齐备才 known-failed 结算；unknown 继续阻止新执行，原产品写恢复不放宽 | §6；REUSE-06 |
| D3：决定状态重复维护 | 采纳。D 正文唯一选择来源，Core 只持原文绑定投影/程序事实；SoL 不存决定、阶段/完成副本 | §5；REUSE-03/05 |
| D4、A 定向2：自身改动让计划永久 stale | 采纳。路径角色优先级、只允许已结算 consumer target cursor；候选/登记/非目标 caller 必须 refresh，baseline query 不冒充新版本 | §6；REUSE-05/06 |
| A 定向1：query.paths 不等于真实索引读范围 | 采纳。独立 operator discovery_scope，先核验声明中的全部源路径再读源/缓存；不扩大可写授权 | §3–4；REUSE-04/09 |
| A 定向3：v1/v2 活动合同未持久固定 | 采纳。state contract_revision/策略身份，缺版本按 v1；活动 v1 切配置显式冲突，不靠新 binding 暗升级 | §4；REUSE-04 |
| A 定向4与最终细节：D 提取/重复键歧义 | 采纳。恰一个完整有界 block，规范化 JSON 往返一致后 strict schema；重复/歧义/伪 refs 均拒绝，不另建 parser/Markdown 框架 | §5；REUSE-03 |
| B 定向：投递并发/原子中断未列测项 | 采纳。独立短锁仅账本 I/O，不调用 provider/业务/runner；并发争用与原子发布中断列入矩阵 | §7；REUSE-07/08 |
| B10、C4、D5、C7/C8：计数、clone 与旧分污染 | 采纳。v1 原样保留；v2 冻结 E/25、M 为有贡献且兼容的 reuse/extend、E=0 N/A、new 单列；dummy/改名轻改 clone 负控，unknown 不给分 | §8；REUSE-11/12 |

### 定向复核与验证边界

A/B/C 对候选文档做定向复核，不重新泛审；[设计初稿原文](reviews/2026-10-08-reuse-context/05-draft-design.txt)及[实施初稿原文](reviews/2026-10-08-reuse-context/06-draft-implementation.txt)保留当时身份，作为纯文本快照保存原相对引用。A 新发现读范围/cursor/持久合同/D 提取四项，B 补并发账本与本地信任边界，C 补内部入口明示/实际目标/M-E/clone。主 Agent 合入后，同一 A/B/C 最终定向复核确认原指定阻断已处置，原文见 [A 复核](reviews/2026-10-08-reuse-context/07-contract-recheck.md)、[B 复核](reviews/2026-10-08-reuse-context/08-redteam-recheck.md)、[C 复核](reviews/2026-10-08-reuse-context/09-eval-recheck.md)。A 末尾低优先级重复键建议随后按现有 canonical 规范化加入；不是运行证明。

主 Agent 最终合同为[设计](component-reuse-context.md)与[实施文档](component-reuse-implementation.md)，原架构/验收/README/实施状态已链接。仍**待验证**：真实 provider/client、发行身份和 OS 权限边界、Host session/ack、读取及故障切点、Hook 字节/并发、冻结 QA 与 v2 正负控/off-on；REUSE 全部 planned。不因四角色同意宣称模型收益或真实可用。

当前 67 个相关生产/分发/评分文件身份已记录为[source-manifest](reviews/2026-10-08-reuse-context/source-manifest.json)。本轮只检查文档和这些身份，不重复旧 141 tests/模型/浏览器。文档链接、编码、编号、原输入一致与交付身份的实际结果见[交付检查](reviews/2026-10-08-reuse-context/delivery-check.json)；新功能测试未运行，未 commit/push/发布或改全局规则。

首轮文档检查发现复制到评审目录的两份草稿相对链接失效，[失败记录](reviews/2026-10-08-reuse-context/delivery-check-initial.json)保留；改为纯文本原字节快照并修正当前入口，SHA 未变。正式文档的本地引用仍按实际位置逐条检查；不通过改写历史草稿隐藏检查失败。

## 2026-10-09 CRCTX-v1 实施与定向复核

用户明确“ok 改吧”授权实施，前一日的纯设计记录保留。主 Agent 集成 core/gateway/QA；Luna/max 完成 provider、Hook、v2 贡献校准与真实CLI接线。另由独立Luna做当前core/gateway/QA反例和维护复查，发现未索引目标前态遗漏、删除null游标不一致、QA容量不匹配，主Agent采纳修复；定向复核补充missing.size导致NaN，随后修正并实际探针通过。最终原D基线固定、未索引目标新读取、删除游标、共享优先级和QA预算点未发现新的具体反例。

最终工程循环161/161，SoL314通过/20平台跳过，审计0漏洞；25reference正控通过。真实CLI的status/resume、session路由副作用与native拒绝已有证据；直接trace分析失败和合成Hook边界保留，不能称整套Host矩阵完成。全局刷新因占用/拒绝访问受阻，旧来源已恢复，未停止其他进程；新的八题模型off/on成绩未跑。源码与检查身份、原始证据、分发及恢复条件见[本轮验收](../evidence/component-reuse-20261009.md)和[实际实施文档](component-reuse-implementation.md)。没有提交、推送、发布或全局规则修改。

## 2026-10-09 复用可用性增量

用户批准改进 D 缺读诊断与重复分页。A（设计）、B（反例）、C（实施/Eval，兼维护）为独立 Luna/max subagent；首次最小事实审查后由父 agent 实现。A/B 定向复看实际修改，C 更新原三份契约文档。C 编辑与 B 一次复核曾遇到 stream disconnected；父 agent 检查已落盘文档并接管，B 另一次窄复核完成，未把失败 turn 说成通过。

| 确定发现 | 裁决与实际处理 |
| --- | --- |
| 旧 `view_complete=false` 的 Skill 指令仍强制拼整份归档 | 采纳：正常选择改用结构化 complete；QA 完整分页另按原合同；不硬限合法重读 |
| 只报告统一 stale/required，缺少具体 caller 和 Schema 字段；有效读取计数在失败路径为零 | 采纳：有界问题清单、原 cause 类别、真实枚举和已验证引用计数；保留原写入 blocker |
| 未登记已有目标没有具体缺读路径；可写但不可读目标会形成重复补读回环 | 采纳：可读时给 TARGET_READ_REQUIRED；缺独立读取权限时明确 SCOPE_DENIED，模型不能改策略 |
| I 别名只比较当前路径身份，替换后原 inode 仍存活；空 selected 的 new 也可能漏查 | 采纳：捕获身份/字节历史，全部 query/read 来源均检查；发布 ref/旧预览前处理范围拒绝 |
| 把 I 路径的未接入新版本或同 inode 后来内容排除，会掩盖应给 QA 的字节 | 采纳：仅排除捕获 SHA，prospective I 限定 prepare/attach；旧版本排除，新版本在接入前保留 |
| 必须先用一题证明实际交接，再跑八题，不得改评分规则掩盖门控失败 | 采纳：新 smoke 入口无八题/25成绩；失败历史独立保留，模型中断不称任务完成 |

B 最后窄复核确认上述五处共享排除入口没有剩余阻断，属于只读审查、没有运行测试；166 项完整本地检查和最终范围定向回归由父 agent 实际运行。当前成果与模型验证限制见[增量证据](../evidence/reuse-usability-20261009.md)。

真实CLI又确认当前原生patch输入为command字段，观察器按实际输入修复；原生stderr与输入SHA、deny和未变产品字节单独核验，模型超时仍保留失败。增量provider回归首先因未同步Source fingerprint而blocked，随后在原授权内先同步登记，再保留稳定读取ID通过。该反例促使Skill明确多份登记一起提交，不放宽query ready条件。最终166/166和0漏洞、发行28项源码/Skill一致；完整八题收益仍未验证。

## 2026-10-10 默认配置与首次使用

用户指出已安装插件仍显示“项目未配置、未绑定工程循环”，要求使用design-review-council设计默认配置。本轮范围是架构与文档；当前插件、全局设置和版本保持原实现。

主Agent读取已安装council及architecture参考，dispatch-subagents只支持模型路由。A（架构/契约）、B（红队）、C（实施/Eval）、D（维护）均为真实独立gpt-6-luna/max subagent；首次使用同一[事实包](reviews/2026-10-10-default-config/00-brief.md)，未共享其他角色意见。前三角色并行，D在槽位释放后独立执行；本轮没有Gemini返回或运行模型benchmark。

角色记录由父Agent忠实整理：[A](reviews/2026-10-10-default-config/01-design.md)、[B](reviews/2026-10-10-default-config/02-redteam.md)、[C](reviews/2026-10-10-default-config/03-implementation-eval.md)、[D](reviews/2026-10-10-default-config/04-maintainability.md)。发现、采纳理由和定向复核见[裁决记录](reviews/2026-10-10-default-config/05-decisions.md)，最终合同为[DEFAULT-v1](default-configuration.md)。

采纳的核心选择是内存standard@1、缺失/非法配置分开、真实项目路由、session绑定与授权分开、无登记provider/D v2、行为检查与来源完整性分开，以及旧合同固定。B对额外读输入的权限推论已按现有精确修改目标语义校正，未宣称已证实旧产品读漏洞；不采用缓存目录/最近cwd、假UID/symbol、自动QA通过或第二写控制器。

A定向复核先发现v2公共合同缺细节及枚举完整不能证明无匹配，父Agent补§5.1后，A确认指定两项已收口。C发现缺独立行为检查门和namespace来源，修订后确认两项设计缺口已处置。真实Hook/MCP关联、provider v2、原生目标解析和无配置完整任务仍需验证；静态复核不证明运行通过。

DEFAULT-01–16全部planned，实施顺序P0真实宿主只读关联→P1配置/路由→P2无登记发现/文档起步→P3检查QA/完整任务。当前缺配置/未绑定事实未改变，旧成绩不改。本轮仅检查文档与交付源码身份，证据见[交付检查](reviews/2026-10-10-default-config/delivery-check.json)；未运行新功能测试、模型或安装。
