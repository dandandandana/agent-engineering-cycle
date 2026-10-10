# 组件复用与 Hook 上下文控制实施验收

日期：2026-10-09。用户“ok 改吧”后实施 CRCTX-v1。源码已完成，本地全局缓存更新受占用限制；没有提交、推送、发布或改版本。

## 已观察的结果

| 检查 | 结果与证据 |
| --- | --- |
| 工程循环最终 npm run check | 161 tests / 161 pass / 0 fail / 0 cancelled，审计 0 vulnerabilities；Node 24.11.0 / Windows。原日志在 slop/reuse-final-checks-20261009/check-cycle-final.txt，耗时 140801.7446 ms |
| SoL 最终 npm run check | 334 tests / 314 pass / 20 skipped / 0 fail / 0 cancelled，审计 0 vulnerabilities。跳过含 Linux/Bash、POSIX；日志在 ../codex-sol/slop/reuse-final-checks-20261009/npm-run-check-20261009.log |
| 真实 provider / Core 定向 | 4/4，通过实际独立发行、官方 MCP client、完整 query/read/recall/SHA、读范围、D 覆盖、连续消费者写入、候选优先级、v1/文档兼容；新增 unindexed absent→create→delete→recreate、外改拒绝、旧 D 重接拒绝、新 read 后显式刷新，及捕获响应丢失后的同请求去重恢复；日志 component-target-fix.txt |
| QA 原始证据 / 容量 | QA source 仅两只读工具；原捕获分页完整读取才交付，损坏/漏页拒绝。大输入在 pending/worker/CLI 前按当前 1 MiB 捕获预算拒绝，缺失文件不能产生 NaN 绕过；包含在最终 161 项中 |
| Skill | 仓库完整 Skill 与新增按需参考，经 skill-creator quick_validate 通过；主入口仅增加复用指针，Hook 不加载参考全文 |
| v2 reference 正控 | 固定八题25机会，E=25，25 passed / 0 unknown / 0 failed；原报告 blog-eval/slop/blog-reuse-v2-reference-calibration-20261008-01/v2-reference-calibration/report.json，25 captures 含实际进程、源码稳定及临时副本清理事实。校准结果不是模型成绩 |
| v1 保存 | 本轮前67输入身份中，原博客报告、rubric.mjs、runner.mjs 保持原 SHA。旧完整成功2/8、严格有效复用4/25不改；其他 v1 规则/参考身份见 v2 freeze |

## 独立实现复核

Luna/max 对实际 core/gateway/QA 做只读反例与维护复核；它不修改源码或重跑通过套件。主 Agent 采纳并修复三个问题：未登记目标未固定前态、删除 after-state 的 null 比较不一致、QA 源证据预算与 CLI 捕获容量不匹配。定向复核还发现 missing.size 导致 NaN，随后以缺失条目0字节、有效size检查和元数据预算修复。

复核确认 D 的全部 target_baseline 包含不存在状态，原样 D 不重建基线，未登记的已有目标须实际新 read 证据；consumer cursor 只接受已结算效果，共享候选/登记优先级仍覆盖消费者。QA 容量检查在 pending/worker/CLI 前执行。最终定向复核未发现这几个范围内的新具体反例；未声称所有潜在缺陷已被排除。

## 真实 CLI 接线

隔离 CODEX_HOME 通过官方 CLI 安装当前包，npm 原生 Codex 0.161.0 / gpt-6-luna max。真实调用 status→resume→status；resume 使用当前 binding 且已 settled/effects_known。一次原生 apply_patch 被 PreToolUse 拒绝，哨兵 SHA 未变。Host thread UUID 与四条 Hook session_id 相同；实际路由账本的 session 哈希匹配该 UUID 并映射到本 fixture cycle。这条真实副作用链验证了 server metadata→runtime options→settled resume→Hook 路由。

真实 Hook 输出最大196/2048字节；原 handler 的另一次合成 UserPromptSubmit 输出533字节，明确标记 host_event=false。没有 Host ack，delivery保持unknown。临时认证链接和隔离home均已清理。

原观测器分析返回exit1：直接MCP trace文件缺失，且分析器最初读取 item.name 而真实事件使用 item.tool。嵌套Codex实际进程exit0、输出/清理完整；原失败不改写。以上通过点来自原始CLI事件与实际session账本，不能把分析器exit1重标为整套P0通过。安全汇总在 slop/reuse-host-p0-20261009/evidence/host-p0-reconciled.json/.md。安装身份是11个选定文件的哈希汇总，不能称整个包归档哈希；core后续修正另由最终回归验证。

## 本地分发与全局缓存

新插件与 provider 已生成到 C:/Users/dandandandana/.codex/plugins/local-sources/engineering-cycle-local-20261009。29个 src/hooks/skills 文件与最终仓库字节一致，provider 清单 SHA 为29c637db6a583a36b5827667c2be4ec9fbff9574fd80b1911a0fb27b98eac856。详情见 [分发与缓存检查](component-reuse-install-20261009.json)。

官方 plugin add 刷新全局0.1.0缓存时返回“failed to back up plugin cache entry / os error 5 / 拒绝访问”。实际有多个Node MCP进程以旧cache目录为cwd。没有终止这些进程；marketplace注册已恢复原20261008来源。旧缓存25个源/锁身份与实施前参考一致，package运行元数据一致，旧package仅本来就有不同的bench脚本元数据。不能声称全局缓存已经升级。

待所有使用旧缓存的Codex进程关闭后，使用CLI登记上述20261009来源，再 add 同一插件ID；旧来源与旧缓存仍保留用于恢复。rev2配置须配合新缓存使用，现有对话不会自动加载这份源码。全局规则文件未改。

## 边界

本轮验证Windows/Node24、实际内部MCP、受控CLI会话与匹配的原生写入；未验证Linux/macOS/Desktop全流程、真实Host compact/ack、全部故障切点或动态调用全图。QA 对过大输入明确blocked，当前没有流式大回执。未运行新的八题模型off/on实验，不声称有效复用率、token或成本提升。
