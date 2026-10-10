# 默认配置实际实现 · DEFAULT-v1

来源：[默认设计与 DEFAULT-01–16](default-configuration.md)、[四角色裁决](reviews/2026-10-10-default-config/05-decisions.md)。用户在设计后确认“做吧”，随后授权 Git 提交与公开推送；保留原版本 0.1.0，没有插件版本发布或全局规则修改。源码集成、打包与独立源码 QA 已交付；实际安装更新和完整 live QA/finish 仍受下述阻塞限制，不能标全部 DEFAULT 完成。

## 实际系统与恢复边界

`local/config.mjs` 拥有严格读取与来源合并，`default-profile.mjs` 拥有 standard@1 固定发行。仅真正缺失项目文件走默认；用户 preferences 与 rev3 项目覆盖可选，rev1/rev2 直接沿原合同。CycleCore 的 begin 将有效默认、检查计划、精确文档豁免与 QA 身份固定为内容快照；显式覆盖漂移不能静默迁移活动任务。真实登记文件由已核验 provider 内的纯 Normify 声明校验器识别，语法有效只选择 v1，不冒称图、来源或 QA ready；图与来源仍由真实发现验证。

`host-context.mjs` 把真实 UserPromptSubmit 地址按 CODEX_HOME 实体身份、插件身份、session/thread 与当前 turn 有界保存，server 逐请求解析，不采用进程 cwd 或“最近项目”。同 key 不同根固定为歧义，过期、损坏、物理根变化均拒绝；显式 root 与可靠地址冲突拒绝。地址是传输定位，不是许可。Runtime 将 session 加入 cycle 与 root 定位分开，只有完全结算的 begin/resume 才加入；未加入的默认 status 没有可写 binding，也不注入另一任务的 I。

SoL 的 `provider-policy/provider-server/repository-index` 负责真实 repository 库存与静态事实；Cycle 继续负责完整 recall/SHA、archive、D 与写门。v2 用实际 source-file 身份、源 SHA、whole-source reads 和有来源的调用关系，不转换成假 UID/symbol。collection_stable、enumeration/candidates/relations 覆盖和 unresolved 均由 provider 产生；语义选择由 D 和独立 QA 审查。

补齐的实现细节：provider 输出 metadata `path_inventory` 和单独摘要，记录全部实际 regular-file 名称及未展开目录；原 inventory_digest preimage 不变。Cycle 的 metadata-only 双遍枚举使外部新增/删除和非源码分类输入变化进入 binding/currentness；精确 authority 文档单独过滤，仅同 D、完全结算且有真实效果的 consumer cursor 可覆盖自身创建/删除。它不是原子文件系统快照，不能保证两遍间回滚或最终观测后的无变化；观察到链接、根身份变化或枚举不足会阻塞。

WorkspaceAdapter 是唯一写入控制器。rev3 新文件可创建必要父目录：全目标语法、预算、前态先验证，随后逐项 mkdir/write 并保存真实 directory/file effects；中断/存储失败保留已知或未知效果，不回滚或重放。legacy 默认不自动建父目录。已有 `.prd/`、设计和机制说明继续由原文件拥有，任意 Markdown 不自动成为 authority。

检查发现只读现有 package 入口，固定原生 Node/npm argv，status/Hook/begin 不执行脚本或模型。begin 固定 required 检查和排除理由；无命令时保留 behavioral_missing。not_applicable 的代码任务须由独立 Q 对实际 diff 单独确认，完整性检查不能代替行为验证。QA model/二进制只是候选，CLI 显式 live 校准后才保存签名选择与匹配回执；活动身份不静默更换，finish 仍要求当前、完整、quiescent 的原 Q 和原目标覆盖。

## 当前证据与下一动作

公开Git交付前，在最终r4生产源码固定后重新运行完整检查：工程循环230/230、审计0；配套SoL325通过/20按原平台条件跳过、审计0。原始输出见[工程循环最终检查](../evidence/default-configuration-20261010/check-cycle-publish.txt)与[SoL最终检查](../evidence/default-configuration-20261010/check-sol-publish.txt)。CI已补齐相邻Provider源码检出并固定其Git版本7777b5f；远端CI与本机Host安装仍分别观察，源码检查不替代其结果。提交准备只清理历史Markdown硬换行表示和日志空行尾空格，原字节副本留在本机slop，不改变历史失败事实。

修改前 49 个评审范围输入逐项匹配，真实 before 保存在本机 `slop/default-configuration-20261010/before/`；生产冻结清单含当时未跟踪文件。原验证时该项目尚无独立Git历史，当前在公开推送准备中建立自己的仓库；原输入身份仍以冻结清单核对，不以随后产生的HEAD反推旧验证。临时夹具、认证副本、node_modules与打包产物不提交。

定向 Windows/Node 24 检查已运行：缺省/非法/legacy 配置，Host turn 地址与歧义，source-file D v2，安全 metadata 枚举，检查/QA 候选，真实 bundle 及目录效果测试。第一轮226项中220通过、6失败，原始失败保留；修正后回归228/228与审计0，运行跨r3→r4，不冒称全程最终源码验证。随后最终r4相关29/29复验通过，独立QA核对53/53生产输入，并复验 blocked枚举、worktree .git文件与二进制metadata精度/漂移反例，审查范围没有未解决源码发现。证据见[回归](../evidence/default-configuration-20261010/check-all-final.txt)、[最终复验](../evidence/default-configuration-20261010/check-runtime-final.txt)、[独立QA](../evidence/default-configuration-20261010/independent-qa.md)。P0真实CLI两项目只读只证明Hook/MCP同turn metadata关联，不代替新版Host/完整Desktop验收。

最终包的37项src/Skill文件全部匹配源码（含完整8个Skill文件），Provider1750项SHA一致；单独准备的安装来源2990项匹配，但官方 marketplace add 因同名旧地址拒绝，尚未注册新来源/更新当前缓存。真实CLI校准在sandbox阶段终态失败，报 helper setup refresh had errors、没有拒写证据；主任务、模型QA及finish未执行。认证副本与临时home已在终态后清理。详见[包清单](../evidence/default-configuration-20261010/delivery-check.json)、[安装错误](../evidence/default-configuration-20261010/marketplace-add.txt)、[live冒烟](../evidence/default-configuration-20261010/live-smoke-report.json)。下一安全动作是处理旧安装来源冲突和本机只读沙箱设置后再验真实新包，不更换沙箱来掩盖失败。旧博客2/8与4/25不改，本轮没有新八题或收益结论；源码公开推送不表示本机安装或完整DEFAULT-16已完成。
