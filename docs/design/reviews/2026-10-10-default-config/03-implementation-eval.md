# C：实现与验证独立审查

执行者：defaults_impl_eval，gpt-6-luna/max，最小上下文；只读代码/测试/SDK/已有P0记录，未改文件或运行模型/测试。主 Agent 整理返回。

- 默认配置、项目定位、操作许可、provider与QA校准是独立条件，不能合成configured=true。建议唯一config解析器给版本/来源，内存默认不创建项目文件。
- package-plugin生成cwd='.'且只有CYCLE_WORKSPACE转发；server启动root静态。Hook真实cwd与MCP session/turn未完成bootstrap关联。当前status也不按session隔离workspace current。
- 缺配置checks为空，持久操作和verify不能起步；init仍要求JSON。默认source-integrity可以提供来源检查，但不能当功能测试。
- SoL当前不是完全无登记发现器；测试中的未登记目标仍有原architecture。需要单独的有界发现契约，未知/不可用不能当没有组件。
- QA必须匹配native二进制/model/platform/sandbox/driver/receipt，候选不等于ready。原实现说明只追踪声明目标，未提供全函数AST覆盖。
- 本机SDK2.2.0支持mcpReq._meta扩展，但不给它root语义。roots/list在2026-07-28协议已弃用，SDK旧listRoots在该协议下拒绝，客户端还需声明roots；不能当默认当前项目定位。
- 原CLI P0只证实部分thread UUID/session映射及resume账本，缺直接MCP trace与完整turn关联，desktop_window_used=false。新TUI/Desktop必须分开做两项目只读关联/切cwd/子Agent/无写入探针。

验收建议已合入设计DEFAULT-01–16：无配置不写文件、有效许可begin、非法配置拒绝、旧rev固定、脚本sentinel不触发、未校准/身份漂移QA不通过、无登记/不完整发现不虚假new、多项目路由不串、实际完整任务单独验收。本报告是静态设计证据。
