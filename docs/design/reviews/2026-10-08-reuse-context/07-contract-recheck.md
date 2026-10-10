# A 定向复核原文

## 首次复核

输入：[设计草稿原文](05-draft-design.txt) SHA-256 `d60acf9b2d3f3b274af13cd960e95cec3cd918685b147b5e5fd2cc9ad827e993`；[实施草稿原文](06-draft-implementation.txt) SHA-256 `8d2a3ad6d10fdd4e578900c8bc883f1cfbb252252063508756376c06b3d7aca7`。范围：设计 §3–6、实施 §2–4。执行者与最初 A 相同；只读。草稿保持原字节、以纯文本归档；其相对引用基于原 docs/design 目录，不作为归档位置的可导航链接。

定向复核结论：七工具内的 discover/read 和 D 单块投影已有可落地的方向；仍有两处门禁需要补明，另有一处恢复语义需显式绑定。

1. **P1｜读取授权范围仍不完整。** discover 会返回完整索引 manifest，而 SoL 的索引查询需先读取声明内的全部源码，再筛选候选；调用者给出的最多 16 个 `paths` 不能代表实际读取范围。文档要求“已有授权”，但没有说明超出 cycle 写入 `scope` 的候选源码如何单独获准读取。应明确独立的只读 discovery scope，并在 provider 读取源码前核验完整索引路径；不可复用可写 scope 来扩大读权限。验证需覆盖 manifest 含未授权路径时，在 provider/cache 读取前拒绝。

2. **P1｜cursor 处理尚未彻底消除自失效。** query manifest 包含所有索引源码；计划的消费者文件也可能是已记录 caller 或 query 输入。首次受管写入后，若将这些路径一律判为“caller/source 已变化”，计划就会立即 `needs_refresh`；若用 cursor 一概豁免，又可能掩盖共享实现变化。应规定路径角色和优先级：只有 D 明确列出的消费者 target，且其写入有完整结算回执，才能按精确 after-SHA 推进 cursor；候选实现、registry 和非目标 caller 的漂移仍须刷新。对同时属于候选实现与 target 的路径应禁止 cursor 豁免。验证覆盖消费者 target、共享实现、登记文件、非目标 caller、部分写入和 unknown outcome。

3. **P1｜rev2 对旧活动 cycle 的行为需落到持久状态。** 文档已规定 v1 严格读取、旧配置/旧 cycle 不自动升级，也要求 begin 固定策略；但只读旧配置并不能判断活动 cycle 是否按 v1 语义运行。应在 cycle 状态中固定 `contract_revision` 与复用策略身份；v1 活动 cycle 遇到 rev2 配置时明确冲突并要求显式迁移，不能通过重新取当前 binding 悄然套用新策略。验证覆盖 v1 活动 cycle 配置切换、v1 无 provider 的原语义，以及 v2 provider 变更后不得降低已固定门禁。

4. **P2｜D 唯一 block 的提取边界需写成拒绝规则。** 以原 D 文档的单一 fenced block 为唯一投影，避免另建台账，这个设计已处理了分叉事实源问题。实现合同仍应写明：启用策略且有 source-write 时必须恰有一个 block；重复、未闭合、超限或 JSON/Zod 不合格均拒绝，不能截断后接受，也不能从多个 D 文件拼合。验证覆盖重复 block、缺失 block、行段漂移和伪造 evidence ID。

**已处理范围：** `implementation_targets` 不再是完整目标清单；文档改为按实际全部写/删目标分类，并由 operator 的精确 `documentation_paths` 白名单豁免，模型没有 `source=false` 参数。嵌入代码模板只有在操作员未将其列入文档白名单时才能被机器判为 source-write，因此该配置的可信归属应保持为 operator 管理。七工具中将 discover/read 收入 `cycle_artifact`、限定 D、绑定 request/binding 并在写前复核，结构上可行；具体 Zod discriminated union、错误条件和逐字段输出仍需在实现合同冻结。

官方 MCP client/stdio 与 runner 复用也已列为 P0 核验，不臆造现有依赖或 API；provider cache 限于原始传输字节，且模型只见 cycle 工具，这两项边界清楚。

## 最终定向复核

输入为按上述发现修订后的正式文档，公开范围与定向派单相同；最终文档身份在本轮交付检查固定。此返回后，主 Agent 仅补了下述重复键规范化条款与验收，不新开架构轮。

定向复核通过：先前指出的四处边界已补齐，恢复例外也闭合。

- `discovery_scope` 与写入 scope 分离；provider 在读索引源码或写缓存前核对完整源码清单，越界即失败。
- cycle 状态固定合同版本和策略；缺版本按 v1 处理，活动 v1 遇 rev2 配置明确冲突，不能靠刷新 binding 升级。
- D 要求唯一且完整的复用区块；实际写入目标逐一分类，`implementation_targets` 不再决定是否豁免。
- 受管消费者 target 仅凭已结算回执和精确 after-SHA 推进 cursor；候选实现、登记和非目标 caller 优先触发刷新，baseline query 不会被冒称为新版本。
- discover/read 的缓存与捕获副作用进入 request/pending/outcome/settle；仅在终态、清理、缓存效果完整可查且 outcome 已保存时结算已知失败。其余情况保留 unknown，不重放，也不能换 request ID 绕过。

剩余一项低优先级实现细节：若使用普通 `JSON.parse` 后再做 Zod 校验，重复 JSON 对象键会被折叠，Zod 无法发现。建议 D 区块解析时拒绝重复键，避免原文与投影之间出现歧义。
