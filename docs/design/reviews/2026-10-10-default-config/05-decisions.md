# 主 Agent 裁决与定向复核

2026-10-10。交付合同：[DEFAULT-v1](../../default-configuration.md)。本次范围为默认配置架构设计和文档；未实施、安装、运行模型或重跑 benchmark。

四个角色均为独立 gpt-6-luna/max subagent，首次最小事实包相同，没有提供其他 reviewer 意见。A/B/C并行，槽位释放后D独立启动；父Agent负责裁决、文档和交付检查。agy/Gemini没有参与本轮，不把历史评审复用成新结论。

| 发现 | 裁决 | 设计与验收 |
| --- | --- | --- |
| A/C：默认JSON不能解决插件目录被当项目 | 采纳。适配边界解析当前项目，Hook/MCP字段的实际关联先做P0；无可靠上下文不猜根 | §4；DEFAULT-03–05 |
| A/C/D：配置、授权、活动cycle与QA是不同事实 | 采纳。standard@1内存默认，有效合同与显式configured分别报告；begin沿原许可，不自动夺取旧cycle | §2–4、6；DEFAULT-01/06/11 |
| B：当前if(!raw)会隐藏非法配置 | 采纳。仅文件真正不存在允许默认；存在的非法值/读取失败拒绝 | §3；DEFAULT-02 |
| A/C/D：无登记SoL尚不可直接用 | 采纳。固定provider-only分发，repository protocol/2与cycle-reuse-v2独立严格合同；原v1不伪造UID/symbol | §5/5.1；DEFAULT-07/08 |
| B/D：读域、会话归属、误拦截与历史证据混淆 | 采纳设计约束。读域和写scope分开，当前turn冲突拒绝；显式历史召回保留只读审计；原生写按真实目标/session收窄 | §4/5/7；DEFAULT-04/08/13/15 |
| C：source-integrity可能冒充完整测试 | 采纳。行为变化有独立required行为检查门；来源完整性不替代。纯文档/注释/格式变化按diff与独立QA判断不适用 | §6；DEFAULT-10 |
| C：host namespace没有真实来源字段 | 采纳。使用插件本地派生namespace，CODEX_HOME真实目录身份+插件身份+合同版本；不发明宿主字段 | §4.2；DEFAULT-04/05 |
| D：profile/provider升级会漂移旧任务 | 采纳。begin固定身份/版本；rev1/rev2无默认合并，active不自动迁移，缺旧程序如实不可用 | §3；DEFAULT-12 |
| A：文件枚举complete不能证明语义无匹配 | 采纳。枚举/候选/关系覆盖分开，全部可捕获源码文本均有候选；new须完整稳定库存、逐来源真实读取与不适用判断、无相关未决项 | §5.1；DEFAULT-08 |
| B：额外读取输入意味着旧grant越权 | 校正。现有文案是精确修改目标，不能据此判定已证实历史读漏洞；新默认明确独立读策略 | §5；DEFAULT-08 |

## 定向复核记录

A首次复核指出v2接口/门禁未细化，以及“枚举完整→无匹配”的反例。父Agent补充§5.1的初始化DTO、全量包、严格D字段、候选全集、覆盖维度和写前谓词；A再次只检查这两项，确认均收口、未发现指定范围的具体剩余矛盾。

C首次复核指出来源校验不能独自满足行为变化完成门，以及namespace不能是假设宿主字段。父Agent补充独立行为检查条件和本地namespace派生；C再次确认两项设计缺口已处置，真实P0关联仍未验证。父Agent随后缩小行为检查的适用性，避免给纯注释/格式变化新增无意义测试；代码行为变化的required门保持。

B报告保留对权限语义的校正；D独立维护意见纳入唯一owner、稀疏新revision与旧合同固定策略。未以票数决定；未把静态复核当实现或宿主运行证明。

## 仍须验证

- 当前Hook session/turn与MCP thread/turn的关联，两个项目、子Agent、cwd变化、TUI与Desktop分别验证；失败时自动路由保持不可用。
- provider真正支持repository/D v2及全部读/来源/当前性门；unsupported关系不能变零，完整库存不能变语义证明。
- 原生写目标解析与误拦截修复；普通查询不执行脚本/模型，QA校准身份/终态按原合同。
- 无配置的完整实际任务及有效组件贡献，旧成绩保留；DEFAULT验收全部planned。

本轮只交付文档。交付检查见[delivery-check.json](delivery-check.json)，设计所用当前源码身份见[source-manifest.json](source-manifest.json)。文档编码、链接和身份检查不能证明上述运行能力。

首轮检查仅因交付JSON尚未生成而报告两处本地引用缺失；生成后重查。原始失败保留在[delivery-check-initial.json](delivery-check-initial.json)，不改写成首轮通过。
