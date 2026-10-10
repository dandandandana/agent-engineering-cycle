# 组件复用门控博客实测

2026-10-09：用户授权新开 Codex TUI，测试当前工程循环插件。当前源码通过独立 CODEX_HOME 安装；Codex CLI 0.161.0 / gpt-6-luna max / Windows / Node 24.11.0。一轮启用复用门控的八项固定任务，两项并行，每项 900000 ms。没有修改全局规则、提交、推送、发布或版本。

## 实际成绩

| 指标 | 结果 |
| --- | --- |
| 完整任务成功 | 0/8 |
| 新增功能行为检查 | 0/41 |
| 代码合规 | 88/96；八项均未同步新增公共登记，其他规则主要由未改动基线满足 |
| v1 有效组件复用 | 0/25 |
| v1 函数执行覆盖 | 0/25 |
| v2 实际贡献 M/25、M/E | 0/25、0/25；E=25 |
| v2 正控、探测覆盖 | 25/25 校准、25/25 已探测；25 项因候选任务行为失败而未证实贡献 |
| 基础博客浏览器检查 | 11/11；脚本 SHA 未变、page_errors 为空，预期注入的 503 被恢复检查覆盖 |
| Hook/MCP/说明协议交接 | 0/8 |

七项达到 15 分钟上限，一项主动报告阻塞并正常退出；八项均没有产品代码改动。原登记和隐藏功能评分仍失败，不把进程正常退出、基线合规或基础页面可用称为任务完成。B08 的独立说明评估未通过；其他七项未形成可交付说明，没有实际运行其说明 judge。没有测量插件内校准 QA/finish。

完整数据：[完成后处理报告](D:/zzd/agent-engineering-cycle/slop/blog-benchmark-20261009-reuse-on-v2/postprocess-report.json)、[评分汇总](D:/zzd/agent-engineering-cycle/slop/blog-benchmark-20261009-reuse-on-v2/evaluation-summary.md)、[原始 v1 分数](D:/zzd/blog-eval/slop/blog-benchmark-20261009-reuse-on-v2-scores/report.json)。历史 4/25 来自另一 v1 bundle 身份，本轮没有同输入的插件关闭对照，不做因果改善或下降结论。中断 turn 缺完整 usage，不能用报告的部分 token 总数估计本轮总费用。

## 暴露的使用问题

1. `inspectReuse` 对全部 selected_capabilities 要求匹配 UID 的直接调用方读取，包括未修改的基础依赖。D 中引用缺失会阻塞挂接；磁盘已捕获不等于最终 D 已引用。
2. `summary.reads/covered_targets/missing` 在完整循环结束后才更新；中途缺失调用方时，它们保持 0。catch 丢弃具体错误 message，prepare 最后只给通用 REUSE_PLAN_REQUIRED/REUSE_STALE。闭合 B01/B02 分别有 37/21 个 source capture，却仍显示 reads=0、covered_targets=0、missing=0。模型因此难以定位需要补读或修正的字段。
3. B03 对同一份 7 页查询归档进行 281 次不同 item ID 的读取，约重复 40 轮，累计回传 1,290,760 字符；最后一页明确 next_offset=null。此证据说明重复取证，没有证明传输接口损坏或真实 token 数。仅控制 Hook 提示量不能控制 MCP 重复回包。

证据：[闭合候选只读复现](D:/zzd/agent-engineering-cycle/slop/blog-benchmark-20261009-reuse-on-v2/diagnostic-reproduction.json)、[独立诊断](D:/zzd/agent-engineering-cycle/slop/blog-tui-boot-20261009/reuse-gate-diagnostic.md)、[分页统计](D:/zzd/agent-engineering-cycle/slop/blog-benchmark-20261009-reuse-on-v2/archive-repeat-diagnostic.json)。本轮不修改被测 runtime 或候选来改善成绩。优先后续工作是准确、可操作的 D 错误反馈和更直接的组件检索消费方式；共享接口修改与只复用依赖的调用方取证成本需要重新评估。

## TUI、夹具与后处理

独立交互 TUI 正常启动，唯一 prompt 返回 BLOG_TUI_READY，exit0，工作区为空，模型无工具调用；八项任务使用同版本原生 CLI exec。启动探针不等于完整 TUI 博客流程验证：[TUI 事实](D:/zzd/agent-engineering-cycle/slop/blog-tui-boot-20261009/tui-outcome.json)。B05/B06/B08 观察到原生 Hook deny；探针输入的路径/注释分类未被观测器识别，不能据此算精确协议探针通过。

首次环境尝试遗漏 public/ 读取范围，被正常拒绝；已停止且不计本轮评分。两个候选的 60 个产品文件均与基线一致，已核对自有进程终止并移除认证链接，保留原 TASKKILL_FAILED 和缺失 native receipt 事实：[中断核对](D:/zzd/agent-engineering-cycle/slop/blog-benchmark-20261009-reuse-on-v1/cancellation-reconciliation.json)。后续全新 cohort 的配置读取 src/public，代码写入仍限固定任务 scope；新增预检在任务模型启动前发现索引范围遗漏。

原运行器完成 v1 评分后，把 grading projection 传给 v2 probe，违反原有 exact-candidate 校验，exit1。修正调用为原始候选目录；原失败报告与 SHA 保留。后处理重新取得真实 freeze 工厂对象并逐字段核对模型前的原 freeze，原 v1 输入、v2 计划和评分实现身份完全一致；首次失败发生在启动探测进程前。模型没有重跑，候选没有修补，评分规则没有改。25 探测及浏览器随后完成，postprocess exit0，补充报告保存 original_error 与恢复身份。

本轮改动为 benchmarks/blog.mjs 的夹具范围/会话绑定说明/探测目录，以及 tests/benchmark-blog.test.mjs 的范围回归；相关检查 16/16，通过。正式 cohort 的认证链接和隔离 home 已清理；TUI 与无效环境 home 仅保留无认证链接的证据。Demo 是 B01 原始候选的基础博客副本：[桌面截图](D:/zzd/agent-engineering-cycle/slop/blog-benchmark-20261009-reuse-on-v2/demo/slop/browser/browse-desktop.png)，其 11 项浏览器检查不替代本轮八个新增功能。
