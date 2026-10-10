# 架构实施与验收合同 v2

状态：可执行验收计划，尚未运行新插件。指向 design-v2.md；AC 是本方案本地稳定标识，不重编已有项目 REQ。每条对应可观察结果，不以字段、关键词或角色人数代替行为。

| ID | 输入/触发 | 应观察结果 | 层 / 阶段 |
| --- | --- | --- | --- |
| AC-01 | 无SoL、无JS登记的Python/文档项目，已有自由格式R/I/NEXT | 独立启动/adopt，原件/ID不变、未知字段显示unknown；不强制架构登记 | 安装/来源 P0/P1 |
| AC-02 | 两个独立进程barrier后以同revision创建/更新/执行 | 一个成功、一个busy/conflict；无指针覆盖，runner最多一次 | Store/Core P0/P1 |
| AC-03 | 旧binding、跨任务/工作区、越界write/delete、docs许可写代码、未通过Decision能力仍尝试mutation | 拒绝且产品文件不变；范围校验覆盖实际所有目标；无可信Grant只可非持久inspect，不能attach/launch/写回或finish | Core/Workspace P1 |
| AC-04 | 同request_id重发、相同ID换参数、pending时换ID重试 | 返回已有操作/拒绝改参或新执行；实际副作用计数仍1 | 执行 P1 |
| AC-05 | 启动前取消、启动状态未知、输出采集失败、cleanup失败 | launch/terminal/capture/cleanup/effect各自正确，空exit不等于没执行 | Runner P1 |
| AC-06 | 已发生副作用、outcome前崩溃；已归档、settle前失败 | 前者unknown且不自动重放；后者恢复真实已知结果，计数1 | Store/Runner P1 |
| AC-07 | QA运行中源A→B→A；dirty/untracked/config输入 | QA读实际冻结A或失败；manifest覆盖声明相关输入，不只起止hash | Snapshot/QA P0/P2 |
| AC-08 | 同actor或模型伪造fresh/parent/source；初始输入/终态缺失 | 不形成verified独立Q；缺证维度明确unavailable/unknown | QA/Host P0/P2 |
| AC-09 | 逐CLI/native候选检查可用性与调用授权；对可用且获准候选做fresh QA，已有边界bug、写哨兵 | 分列not_attempted/blocked_by_authorization/unavailable/failed/passed；实测身份/交付/终态/权限关联、QA发现bug、哨兵不变或权限失败。至少一个满足全部必需保证才启用独立QA；未测候选保持unknown，不强制两次调用或宣称比较优胜 | QA/Host P0 |
| AC-10 | 只改QA配置/内置policy，源码不变 | 旧Q保留但不能满足新策略；只复验受影响项，未变结果有依据才复用 | Core/QA P1/P2 |
| AC-11 | 引用批准文字、模型source=user、旧Delta/自动续跑提示、DecisionAdapter失败/缺失 | 不自造批准或扩大ActionGrant；真实来源与语义分列；未验证时write/delete/approve/sync/finish或启动有副作用执行均拒绝、文件不变；有效仍适用许可可复用 | Decision/Core P0/P2 |
| AC-12 | 用户批准R2但本轮只允许文档同步 | 原主控R2/旧历史保持，代码不变，I指出未实现/未测，不叫完成实现 | Reconcile/Skill P2 |
| AC-13 | 权威多文件写回各切点中断或外部改成第三态 | 后态结算、前态经显式许可续写、第三态冲突；不重复Delta或覆盖外部改动 | Reconcile/Store P1/P2 |
| AC-14 | finish归档、最终发布前改变source/策略/许可或归档损坏 | current_complete=false，历史保留；无假completed，无runner重放 | Core/Store P2 |
| AC-15 | 连续Stop、跨turn同revision/action、blocked与缺turn flag | 同一动作无重复续跑；外部等待允许unfinished退出；缺证只提示 | Hook P0/P2 |
| AC-16 | Hook报错/超时、MCP未连接、未覆盖Shell修改 | 不假称已拦截；受管入口二次guard，检出变化使证据失效 | Host/Core P0/P2 |
| AC-17 | 原需求失败但Agent提议放宽；已有REQ全过却漏用户场景 | 原失败不改标准遮盖；缺陷与proposed Delta分流；覆盖缺口不整体通过 | QA/Skill P2 |
| AC-18 | 旧纯Skill、无runtime、装插件后重启/取消恢复 | 明确模式/保障等级；不伪造激活、不双维护Skill；实际取消/恢复证据齐备 | 插件/Skill P3 |

## 两条主路径

成功链：adopt原主控 → 确认可回查的本轮许可/R/D → 受管实施+I → 真实固定检查 → frozen输入+已验QA driver → 主Agent语义裁决 → 需要时Delta/原记录同步 → finish归档、复核basis、发布 → status核验有效。任何结构accepted不得提前当完成。

失败链：pending持久化 → 实际效果已发生 → 取消/捕获/归档/指针结算失败 → 查询同operation → 有充分outcome恢复known，缺证保留unknown → 不重放/不伪通过 → 明确许可和外部条件后resume或reconcile。

## P0 go/no-go 产物

提交能力矩阵（adapter/Host/版本/被测平台/实际保证/未证实范围）、原始命令/事件/输入manifest/终态与哨兵前后身份、租约/故障切点证据、用户决定与动作许可来源。QA候选逐个记not_attempted / blocked_by_authorization / unavailable / failed / passed；只对可用且获准路线live调用，至少一个实测passed且满足必需保证才开放独立QA。单条通过可成为当前可用默认，未测另一条不能作优劣结论；均未过则独立QA未就绪。Decision/Store未过时按架构§7.1限制操作，不只在报告里提示风险。

AC-04–06、13–14按架构§6.1逐操作注入故障：核对pending/outcome/settle位置、稳定operation/job、错误码/failure_phase、局部effects_known、公开原始执行事实和下一动作；同request只能查询原操作，未知结果与部分失败不得重放。模型字段/UUID格式/文档不能作为身份、输入或授权证明。

真实模型/宿主配置/安装按后续任务的明确授权执行；已有有效授权复用。未获此类授权仍可完成本轮设计和不依赖它的静态合同检查；不要为设计直接消耗新模型用量或改全局配置。

## 验证状态

本聊天已完成的是参考SoL的44 pass / 1 Windows chmod skip及四角色静态审查；新插件的上述AC全部planned。验收采用新插件自己的真实程序/宿主，不以旧SoL结果替代。
