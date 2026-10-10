# Benchmark 首轮实际验收

用户目标：安装 agent-engineering-cycle，并为它建立可重复 benchmark。主入口为[运行说明](../../benchmarks/README.md)，设计和裁决为[BM-01–07](../design/benchmark.md)。实际全局插件 `agent-engineering-cycle@engineering-cycle-local`、版本 0.1.0，已安装且 enabled；收尾 CLI list 仍返回这三项事实。远端目录 503 不改变本地安装结果。

## 可执行验证

`npm run bench` 的两个案例控制已执行：9/9 真实后端门禁通过，4/4 oracle/no-op 结果符合预期。每例原始正确代码通过公开检查，原始未改版本不能通过新维护要求，oracle 能通过；多类错误变体另有回归测试。

最终项目检查：[121 tests / 121 pass / 0 fail / 0 skip](check-benchmark-crlf-final-20261008.txt)。该次 check 的 audit 因 TLS 连接中断失败，随后只重试官方注册表审计，[0 vulnerabilities，退出 0](audit-benchmark-retry-20261008.txt)。没有修改依赖或放宽审计级别。

最终真实 pilot 为 `decode-record`、三臂各 1 次、seed=42、gpt-6-luna/low、每次模型 timeout=300000ms、Windows unelevated、CLI 0.161.0、Node 24.11.0。原始[完整报告](../../slop/benchmark-live-20261008-v5/report.json)与[报告表](../../slop/benchmark-live-20261008-v5/report.md)保留原输入身份；共 14 次模型调用，两个真假说明 judge 控制通过。

| 组 | 说明事实 | 隐藏维护检查 | 同步说明 | 插件协议 | 试验耗时 |
| --- | --- | --- | --- | --- | --- |
| 普通任务 | 6/6 | 7/7 | 7/7 | 不适用 | 245.3 秒 |
| 纯 Skill | 6/6 | 7/7 | 7/7 | 不适用 | 278.7 秒 |
| 完整插件 | 6/6 | 7/7 | 7/7 | 实际通过 | 292.8 秒 |

插件组实际读取安装包 Skill/实现说明参考，调用成功的 cycle_status、cycle_apply、cycle_artifact、cycle_verify；受管写入效果 hash 对应最终说明，I 引用当前，固定来源检查有回执。[真实 Hook 记录](../../slop/benchmark-live-20261008-v5/raw/decode-record-plugin-1-hooks.jsonl)含正确 cwd 的 SessionStart、PreToolUse.apply_patch 拒绝和 Stop 空响应。观察 wrapper 的原 handler 字节与源码一致；它是本轮受审自有包的 scoped trust bypass，不是人类信任证明。该 fixture 以已结算 abandon 收尾；没有伪造 QA、finish 或 current_complete。

| 组 | CLI 报告输入 token | 其中 cached input | 报告输出 token | 调用数 |
| --- | ---: | ---: | ---: | ---: |
| 普通任务 | 227331 | 162304 | 4610 | 4 |
| 纯 Skill | 304678 | 213504 | 4193 | 4 |
| 完整插件 | 673806 | 584960 | 6334 | 4 |

上述为每组四次调用的客户端累计用量和整条试验耗时，包含两个 judge 及插件额外协议/探针工作；安装、共同控制和失败的早期调试另有独立记录。不能据此推算费用、完整服务端请求或独立组件的因果收益。

## 反向 QA 与当前性

独立 reviewer 最初发现的五项问题，以及真实响应封套/closeout 问题均修复并复验。后续模型实测暴露引用格式和 CLI quoted override 兼容问题；改用结构化行引用、匿名 judge 目录及官方安装器生成的自有 config。最后的 CRLF 跨行误拒绝改为原文偏移切片，LF/CRLF/混合换行回归与独立最小反例均通过。

换行修复发生在 v5 完成之后，未改写 v5 输入清单或结论。使用当前 scorer 对其冻结输出进行[11 项确定性复评](benchmark-citation-regrade-20261008.json)：八份语义判定和三份维护行为结论完全相同；认证链接全部已删除，无新增模型调用。原报告计时/用量仍是原版本的历史事实。

v1 的 plugin-list timeout、v2 的引文拒绝、v3 的受控中止与 v4 的加载/评分/timeout 失败保持在各自 slop 输出目录。未把它们改为通过，也没有重放未取得终态的旧操作。最终 benchmark 源码没有导入 tests/helpers 或 slop；只有回归测试和一次性复评脚本使用相应试验资料。

## 结论和限制

工具已安装，可重复 benchmark 已实现；这例只证明 runner、评分控制、真实 Hook/MCP 与新会话维护路径能够跑通。三组任务结果相同，本例完整插件的报告输入用量及耗时更高，尚未观察到质量收益。不能由一个简单场景判断普遍效率或成本改善。

发布文件案例仅取得当前 oracle/no-op/错误变体的可执行验证，未做真实模型对照；完整两案例、多重复计划未运行。完整 QA/finish、取消恢复、长对话抗偏移、其他平台、大型真实项目和人类评分一致性仍未测。同用户文件系统隔离是逻辑边界。插件版本仍为 0.1.0，没有提交、推送或发布。
