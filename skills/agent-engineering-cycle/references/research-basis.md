# 设计依据与适配边界

资料于 2026-10-07 实际搜索并打开；下表区分原始事实与本 Skill 的适配决定。不是完整的软工教材或认证流程，执行普通任务无需每次重读。框架 main 分支内容会变化；未来需要其精确命令/API 时重新核对实际版本。

| 议题 / 一手来源 | 原始资料支持的机制 | 本 Skill 的适配与限制 |
| --- | --- | --- |
| [SEI Spiral Development, CMU/SEI-2000-SR-008](https://www.sei.cmu.edu/library/spiral-development-experience-principles-and-refinements-spiral-development-workshop-february-9-2000/)（2000-07-01，已读摘要/落地页） | 反复执行开发活动并主动降低风险 | 用本轮结果与风险更新下一步；未全文审读，不宣称完整采用螺旋方法或里程碑制度 |
| [NASA SWE-052 双向追踪，Ver D](https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695427/SWE-052%2B-%2BBidirectional%2BTraceability) | 关联需求、设计、代码、verification 与不符合项 | 当前范围内稳定 ID 与双向链接；不强制 NASA 的分类矩阵、全量危险分析或认证 |
| [NASA SWE-080 变更跟踪，Ver D](https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695459/SWE-080%2B-%2BTrack%2Band%2BEvaluate%2BChanges) | 变更应被跟踪和评估 | 缺陷、候选/批准变更、影响与来源分开；不引入企业变更委员会 |
| [NASA SWE-063 版本描述，Ver D](https://swehb.nasa.gov/spaces/SWEHBVD/pages/102695447/SWE-063%2B-%2BRelease%2BVersion%2BDescription?desktop=true&macroName=report-body) | 交付版本的内容、配置、改动与已知问题应有记录 | I 借鉴真实状态与版本绑定，保存工程连续性；工作中实现摘要不等同发布 SVD，不替代源码/运行证据 |
| [NASA IV&V Overview](https://www.nasa.gov/ivv-overview/) | 技术、管理和财务三个独立性维度 | 独立 QA 技术视角、首次输入隔离和自主取证；不声称子 Agent 满足完整组织/财务 IV&V |
| [NASA 系统工程手册 V&V 附录](https://www.nasa.gov/reference/system-engineering-handbook-appendix/)（网页版次未核实） | Verification 检查符合要求，validation 检查用户期待；有多种证据方式 | 同时核对原要求与用户场景，不以测试通过取代用户目标；不复制完整 V&V 计划模板 |
| [ISTQB CTFL v4.0.1](https://istqb.org/wp-content/uploads/2024/11/ISTQB_CTFL_Syllabus_v4.0.1.pdf)（2024-09-15，§1.2/4.5.2/5.5） | 可判定验收、正负场景、异常记录/分类/处置 | 选择本次适用边界与可复现发现；教学大纲不变成强制认证或统一测试数量 |
| [NASA SWE-034 验收准则](https://swehb.nasa.gov/spaces/7150/pages/16450634/SWE-034%2B-%2BAcceptance%2BCriteria) | 准则预先定义，并可随理解深化复核 | 本轮固定验收，获准变更保留旧/新；不以失败为由放宽标准 |
| [NASA CR-PR 建议字段](https://swehb.nasa.gov/pages/viewpage.action?navigatingVersions=true&pageId=138707031) | 复现、预期/实际、理由、纠正动作和受影响工件 | 最少可处理缺陷/变更记录；建议格式不要求每个小修新建表单 |
| [GitHub Spec Kit converge 模板](https://github.com/github/spec-kit/blob/main/templates/commands/converge.md)（访问时的 main） | 对照 spec/plan/tasks 查当前代码，将剩余工作追加为可追踪任务；模板不改规格/设计/产品代码 | 验证剩余差距与冻结期望；不安装框架、不依赖特定发行版，不把静态检查当独立运行 QA |
| [Spec Kit Spec of Specs](https://github.github.com/spec-kit/concepts/spec-of-specs.html) | 大范围可分成有持久化 roadmap 的规格循环 | 只在真实范围过大时分解，不默认递归新建规划层级 |
| [OpenSpec overview 源码](https://github.com/Fission-AI/OpenSpec/blob/main/docs/overview.md)（访问时的 main） | 基线规格、变更工件、delta 与完成后的合入 | 保留原要求并处理局部增量；不复制它的目录/命令，合入需求与实现/验证分开 |
| [Anthropic 长运行 Agent](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)（2025-11-26） | 增量实现、结构化交接、真实端到端检查 | 保存可恢复 I/证据与下一动作；不照抄自动 commit/revert、初始化框架或隐式扩范围 |
| [Anthropic 长应用开发 harness](https://www.anthropic.com/engineering/harness-design-long-running-apps)（2026-03-24） | generator/evaluator 分离及根据任务/模型检查脚手架成本 | 默认聚焦必要独立 QA，不每轮全委员会/固定 sprint；实验结果不是此 Skill 的性能保证 |

实现状态作为跨轮工程语义摘要、五种状态分工、权限与主控适配，是本次用户目标和独立评审后的设计决定；上述来源不直接规定这个 Skill 的文件名、工具或完整循环。

现有 `开工前需求`、`design-gate`、`code-quality-workflow`、`project-engineering-baseline`、`orchestrate-project-blueprint` 的入口也已核对：它们分别保留原契约、设计决策、代码质量、配置/检查、蓝图执行权威。本 Skill 消费这些边界，不取代它们的主控或重新初始化。
