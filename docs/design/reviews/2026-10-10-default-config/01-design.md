# A：架构与契约独立审查

执行者：defaults_architect，gpt-6-luna/max，最小上下文；只读源码审查，未改文件/运行测试。以下由主 Agent 整理其返回，不增加运行保证。

- 配置与项目地址是两处独立缺口：config.mjs缺文件返回false，CycleCore因此拒绝持久操作；native包cwd='.'与server回退规则会把安装目录当项目。先可靠定位root，再应用默认值。
- 建议适配边界按Hook/MCP的当前session+turn相关事实选Runtime；无可靠关联只报告未绑定，不回退缓存/父目录/最近cwd。operator显式连接继续支持，地址提示不是授权。
- 默认profile可内存提供source-integrity与明确来源/版本；旧rev1/rev2按原完整语义，不自动合并或改active策略。QA未校准允许基本工作，但不能finish。
- 当前SoL provider要求有登记的architecture模块；实际解析.mjs/.js，不能冒称无登记/TS完整发现。无登记须增加版本化候选模式，继续原gateway和D写前门禁。

窄问题补查：有界文本库存与文件级候选可用作未登记线索，但现有v1的uid+symbol与调用方门禁不能原样承载。建议repository模式和独立D版本，返回路径/SHA/capture、symbol_status与static/inferred/unknown关系。缺失/超限不能说无组件；未知关系不能说零调用方。

关键依据：src/server.mjs、hook.mjs、runtime.mjs、local/config.mjs、reuse-evidence.mjs、core/contracts.mjs；SoL provider-server.mjs与architecture/index.mjs。宿主thread/turn与Hook字段的完整匹配待真实probe，本报告不证明运行通过。
