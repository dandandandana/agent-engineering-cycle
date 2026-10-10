# 组件复用诊断与结构化取证增量

用户批准修复上一轮博客实测暴露的 D 缺读反馈和重复归档消费。沿用 code-quality-workflow，由 design-review-council 的设计、反例、实施/Eval 三个独立 Luna/max 角色审查；维护角度并入实施/Eval。首次意见、当前实现和定向反例分别处理，评审意见不作为运行通过证据。

## 实际修改

discover 增加 16 KiB UTF-8 有界 `reuse_selection`，列出真实候选 UID/symbol、位置、直接调用方、静态 import 定位提示及来源行数；read 增加同预算 `source_view`，明确只完整展示本次请求的 snippets。旧归档保留审计兼容，Skill 的常规选择不再按旧文本截断标志反复分页。

D 失败返回原始原因类别、具体缺少的接口/调用方/目标读取或覆盖，计数按已验证引用更新；最多 16 个问题、issues 合计 4 KiB，并显式标记未列出的问题。角色词表与 Schema 共用定义，可由后端推导角色。独立读范围不足直接阻塞，写范围不能变成读取授权。

反例复查发现 I 的旧硬链接可在原路径替换后存活。I 接入现在记录捕获 file_id/SHA，并保留有界历史；各入口沿捕获 SHA 排除判词原字节，旧格式沿原 manifest SHA。尚未接入 I 的后来版本不因同一路径或 inode 被误排除。范围拒绝在发布新发现引用或旧文本预览之前终止。

七个工具、公开输入、项目授权、唯一受管写入 owner、当前性和 QA 完整交付要求继续沿原合同；未改评分题目、断言、25 分母、生产 Hook handler、版本或全局规则。

## 本地验证

- 首个新 provider 回归在旧实现上真实失败：缺少 `reuse_selection`；实现后通过。仅使用公开返回的 UID、路径、行数及 evidence ID，缺少 D 调用方引用时获得具体路径；修正后 prepare/attach 和 consumer 受管写入已 settled。
- 最终交付版 `npm run check`：166/166，官方依赖审计 0 vulnerabilities，退出0。日志：[check-delivery-final.log](../../slop/reuse-usability-20261009/check-delivery-final.log)。此前 164/164 后的首次审计因 TLS 连接中断失败，独立重试通过；前一份 [check-final.log](../../slop/reuse-usability-20261009/check-final.log)也保留。
- Workspace 范围错误映射和 blocked 查询指引做定向回归 1/1：[check-selection-repaired-final.log](../../slop/reuse-usability-20261009/check-selection-repaired-final.log)。它包含视图超预算、实际 SHA 漂移、独立范围、合成受保护路径、旧 I 别名和空选择隐藏 inventory 等边界；随后最终166项全套包含这些补充。
- 原 I 原子替换、重新挂接、后来版本别名及同 inode 新版本定向回归 1/1；最终全套已包含该用例。QA manifest 保留未接入的新字节，原判词字节仍排除。新目标在写范围却无读取权限的 provider 回归也包含在全套。
- 增量取证回归 1/1：[check-incremental-repaired.log](../../slop/reuse-usability-20261009/check-incremental-repaired.log)。先同步真正的 Source fingerprint，再用新 query、变化消费者的新 read 和两个未变来源的原 read ID 重接 D，下一次受控写入 settled。首轮未同步 fingerprint 的查询 blocked，失败日志 [check-incremental-final.log](../../slop/reuse-usability-20261009/check-incremental-final.log)保留；未放宽 ready 条件。
- 记录器的当前 CLI `command` 格式及既有拒绝条件检查 11/11：[check-hook-decoder-final.log](../../slop/reuse-usability-20261009/check-hook-decoder-final.log)。源码、前后差异和空白检查保存在 [source-manifest.json](../../slop/reuse-usability-20261009/source-manifest.json)。没有 commit/push。
- 最终 Codex 发行已生成，源码与完整 Skill 目录28项匹配、0缺失、0漂移：[package-verification.json](../../slop/reuse-usability-20261009/package-verification.json)。打包目录 [plugin-final](../../slop/reuse-usability-20261009/plugin-final) 保留，版本仍为0.1.0；主缓存未刷新。

## 模型验证边界

B01 smoke 使用全新隔离安装与原生 CLI 0.161.0、gpt-6-luna/max、900000 ms 实现预算；单题接线验证不产生八题或 25 机会成绩。v1 的真实模型在发现/读取和 D 准备之后因 `stream disconnected before completion: error sending request` 退出 1。已观察终态、无进程清理错误、fixture abandon、认证链接和临时 home 清理完成；原失败不修候选、不改成通过。见 [v1 report](../../slop/blog-smoke-reuse-usability-20261009-v1/report.json)。

v2 在 900000 ms 上限退出 1，输出完整、无进程清理错误、fixture abandon、认证链接及 home 已清理。D 首次缺读明确指出 components.json，修正后 attach 成功，产品实现与组件登记通过受控写入；后续更新登记再次取证，未完成 architecture/I/verify 交接。实际还有模型目录请求超时，不能把全部耗时归因于插件或网络。见 [v2 report](../../slop/blog-smoke-reuse-usability-20261009-v2/report.json)。这两份 smoke 没有新八题成绩。

v2 的实际 CLI 暴露记录器未识别 `tool_input.command`。修正只影响测试观察，生产 Hook 字节未改。短 native probe 也遇到连接重试并在 180000 ms 上限结束，原 report.passed=false 保留；其 native stderr 的原始 patch 与 Hook 输入 SHA 完全一致，记录器正确提取唯一 src/features.mjs、纯注释、deny，三个产品文件与原基线字节相同。独立的[Hook 观察核验](../../slop/native-hook-probe-20261009-v1/hook-verification.json)接受这个拦截事实，明确模型未完成，不改写原 smoke 通过条件。

对 v2 原未完成 B01 候选，在同一原冻结数据与规则上运行三个原消费者贡献探针：仅 paginate 验证 contributed；searchPosts 扰动产生非断言异常，summarizeRatings 未改变映射消费者，两者均保留 unknown。其他 22 项未探测；原分母仍为 25，M=1 的部分报告不能当成完整八题成绩或普遍提升。候选未修补，源文件稳定、临时副本清理均保留在原 probe 中。见[部分贡献报告](../../slop/blog-smoke-reuse-usability-20261009-v2/partial-b01-score/report.json)。

最后将“先同步相互依赖的登记、再用 ready 新查询增量更新 D”写入 Skill 和新跑次提示。它避免先写半份登记后陷入 stale fingerprint；这些最终流程澄清没有另跑完整模型 cohort。旧 [0/8、0/25 报告](blog-benchmark-20261009.md)保持原样。目前不能宣称新的整体有效组件复用率提升。

全局插件缓存刷新未在本轮执行；真实 CLI 使用当前源码的隔离发行，未停止其他会话。没有 Desktop/其他平台或同输入 off/on 因果比较结果。

后续用户重启并继续安装后，主缓存另行完成文件更新与新进程核验；再次重启后的当前会话已加载新版 MCP 接口，实际只读调用通过。安装续接独立记录在[主安装证据](plugin-update-20261009.md)，不改变上述模型失败和评分边界。
