# D：可维护性独立审查

执行者：defaults_maintainability，gpt-6-luna/max，最小上下文；在前三角色后独立启动，没有读取其他角色意见；未改文件/运行测试。主 Agent 整理返回。

- readConfig作为唯一有效配置owner；保留configured表示显式文件，增派生默认来源/版本。status不生成配置，operator/QA不能混进默认值；rev1/rev2保持严格语义。
- session路由目前不约束status读取current；建议适配层管会话归属，通用未绑定状态不自动采用别人cycle，只有结算begin/明确resume才建立绑定，不建第二业务状态。
- 默认组件复用是跨仓依赖，不是填配置就能解决。建议扩展SoL provider-only并保持Cycle gateway捕获/范围/SHA，不复制索引器或完整控制器，缺失/partial不能变无组件。
- 变化场景：默认profile/provider升级。现有basis包含config/policy，active周期会冲突；在begin固定profile id/revision及摘要，只有新cycle用新默认。对应旧执行身份不可用应明示，不伪造恢复能力。稀疏覆盖采用新revision，不放宽旧Schema。
- 工作区、许可、配置、QA/发现能力分别报告ready/unknown/unavailable；默认不能靠“最近一次Hook cwd”或全文transcript。首次启动与候选检查不执行模型/脚本。

关键依据：local/config、core/cycle、server/runtime、provider-server/architecture、package-plugin、qa-cli/calibrate及已有core/component测试。现有代码/声明不证明新的宿主自动root路由或默认组件模式。建议的维护边界和planned验收已并入正式设计。
