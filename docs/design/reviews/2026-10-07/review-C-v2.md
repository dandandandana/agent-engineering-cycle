# C 实现与 Eval：v2 定向增量复核

日期：2026-10-07<br>
范围：仅复核 C-V1-1/2/3 对应增量；未跑测试、未执行 Host PoC、未调用模型。

## 结论

C-V1-1、C-V1-2、C-V1-3 均已在 v2 中实质处置。本次指定范围内没有剩余设计阻断，七工具错误/效果合同、可信授权门禁与单条合格 QA driver 的 release gate 可以进入实现准备。P0 与 P1 验收仍是 planned，本文不将设计文本视为运行证明。

## 对照结果

| 前轮发现 | v2 处置 | 结论 |
| --- | --- | --- |
| C-V1-1：AC-09 要求 CLI 与 native 各做一次真实调用，与候选不可用/授权不足分支不清 | design-v2.md §8 末尾按候选记录 not_attempted / blocked_by_authorization / unavailable / failed / passed；只对实际可用且获准路线 live 调用；至少一个满足 required assurance 才启用 QA；未测路线保持 unknown、不比较优胜、不强制额外调用。acceptance-v2.md AC-09、P0 go/no-go 第32–38行一致明确单条通过即可、未测另一条不作优劣结论、均未过则未就绪 | 已处置。CLI 保留为先考察候选，不预选胜者 |
| C-V1-2：DecisionAdapter 未过时 P1 写能力启用范围不够直接 | design-v2.md §7.1 对 Store、DecisionAdapter/ActionGrant、QA、Hook、效果未知分别列“仍可用”和“必须拒绝/限制”；无可信 Grant 仅非持久 inspect，拒绝持久 begin/resume/abandon/attach、写删、verify/QA启动、批准、权威写回、finish。QA driver 未满足独立保证时停在 ready_for_external_qa，finish 不发布完成。AC-03/11 与 P0 go/no-go 同步检验 | 已处置。缺可信来源时无产品 mutation，缺 QA driver 时无要求独立 QA 的完成 |
| C-V1-3：逐工具错误、局部效果、持久化点和重试恢复映射不足 | design-v2.md §6.1 给每个有副作用动作列 pending/outcome/settle 点、错误/失败阶段、effects_known 与同 request/status 恢复；特别列 partial write、runner launch/capture/cleanup、QA cancel/late result、reconcile 第三态、finish archive/publish。design-v2.md §9 also preserves public launch_status、terminal/exit/signal、changed_paths、capture/cleanup、completeness、outcome/settle facts。acceptance-v2.md AC-04–06/13–14 与 P0 failure-injection 第36行按该表断言 | 已处置。结构化 field schema 留给 CycleCore 单一 owner 的 P1 实现，不再构成当前架构审查阻断 |

## 成功/失败合同检查

- **成功链：** acceptance-v2.md 第28行覆盖 adopt → 权限/R/D → 受管实施/I → 固定检查 → frozen input + 已验 driver → 语义裁决 → 可选 Delta/主控同步 → finish 归档、basis 复核、发布和 status 核验。design-v2.md §6.1 finish 与 §10 补充 finish 的同租约条件、归档后重核及 completed 发布；顺序可实现。
- **取消/部分效果/发布失败链：** acceptance-v2.md 第30、36行和 AC-04–06、13–14 覆盖 pending、已有副作用、取消/捕获/归档/结算失败、查询原 operation、known/unknown、禁止重放。design-v2.md §6.1 对 cycle_apply/verify/QA/reconcile/finish 分别定义 partial 与 unknown 结果；§9 保留公开执行事实并要求未知终态阻塞 finish。failure chain 未假定跨文件事务或强行清理未知锁。
- **QA与授权 gate：** design-v2.md §7.1、§8末尾及 acceptance-v2.md AC-03、09、11、P0产物对 release gate 一致：未有可信 DecisionAdapter/Grant 不做持久副作用；无合格 driver 时独立 QA 不就绪；单条真实通过足够开放当前 QA，但另一候选保持 unknown。身份不依赖模型字段或 UUID 格式。

## 限制与下一步

没有剩余设计阻断建议；可以按 v2 开始获准的实现准备，仍须严格保留以下状态差异：设计已列失败合同 ≠ 测试已实现/通过；单条候选规划 ≠ PoC通过；P0不能满足授权/宿主条件时应停在 read-only / ready_for_external_qa，不降低独立 QA 要求。

本轮只读复核上述文档增量，没有运行验收、SoL 测试或真实模型/宿主调用；P0/P1 所有实证仍待执行。
