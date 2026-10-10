# Codex 工程循环插件：真实博客 benchmark

用户指定在 Codex 安装插件，继续用博客项目跑分。本轮测试对象为 `agent-engineering-cycle@engineering-cycle-local`，版本 0.1.0；全局安装启用已核实，16 个生产源码文件与安装缓存、v3 冻结输入完全相同。测试不启用 SoL 插件，SoL 仅作为原博客评分器的依赖库。

## 结果

实际使用 Codex CLI 0.161.0、GPT-6 Luna/max、Node 24.11.0、Windows unelevated；八项独立固定博客任务，一次插件开启 cohort。原 `blog-eval-v1` 任务、参考答案和评分器未修改。

| 指标 | 通过 / 固定分母 | 分数 |
| --- | --- | --- |
| 行为检查 | 41/41 | 100% |
| 代码规范 | 88/96 | 91.7% |
| 完整任务成功 | 2/8 | 25% |
| 有效复用 | 4/25 | 16% |
| 观察到的复用调用 | 19/25 | 76% |

完整成功的是 B01、B03。其余六题均通过功能行为，但修改了组件登记里的说明文案，违反旧评分器“除 exports/options 增量外保留原登记”的精确规则；B04、B07 另有复制保护函数体的检测失败。没有放宽旧规则或修正模型代码来提高分数。这里的 25% 是合并规范后的任务成功率，不是功能通过率；登记文案变化也不能等同于功能错误。

原始代码评分：[report.json](../../../blog-eval/slop/blog-benchmark-20261008-v3-scores/report.json)。实际模型、Hook、MCP、I、校验和 closeout 原文保留在 [v3](../../slop/blog-benchmark-20261008-v3/report.json)，执行源码版本另有 [30 文件快照](../../slop/blog-benchmark-20261008-v3/input-snapshot/manifest.json)。完整交付身份及路径见[delivery.json](benchmark-blog-delivery-20261008.json)。

## 插件、说明与真实页面

八题均完成真实模型执行；八份 I 的声明引用当前，注册的原项目检查通过，实际 Hook 拒绝和成功 MCP 写入/归档/verify 有原始记录。所有 fixture 以 settled abandon 结束；授权是明示的 synthetic operator fixture，不证明人类身份，没有宣称完整校准 QA/finish。

改进后的探针计分额外要求同 workspace、唯一 `src/features.mjs` 目标、恰好一次纯注释添加。冻结原生 stderr 中的完整 patch 与唯一 Hook 事件交叉核对后为 6/8；B02、B07 使用替换行形式，未满足这个更严格的形式检查。两题仍有真实 Hook deny，不能将这个诊断分数解读为 Hook 未加载。原 wrapper 没有保存 tool_input，重核明确标注来源为原生 router 的完整错误文本；新 wrapper 已直接记录路径、输入摘要和纯注释分类。

原说明评估漏交付间接校验/错误处理源码；第一次补齐仍未提供登记原文。两份旧判词均保留。最终固定 32 项重新核对全部源码与真实登记字节，**8/8 说明、32/32 criteria 通过**，原文行引用可回查；[最终说明报告](../../slop/blog-benchmark-20261008-v3-final-notes/report.json)。这是新会话模型判断，尚无人工一致性或真假负控校准，作为诊断，不替代功能 grader 或程序保证。

全量来源超过生产 runner 的 64 KiB stdin 预算时，新的 judge 输入方式将精确字节写入匿名冻结目录并用短 prompt 请求只读读取，不扩大 runner 限制、不交付 I 判词；引用仍从原始内存字节解析。超预算输入若未启动原生进程，显式记录 `not_started`，避免错误归类为未知副作用。发生在完整上下文调试中的预检失败保留，没有模型请求或代码重跑。

可运行博客是实际成功候选 B03 的[demo](../../slop/blog-benchmark-20261008-v3/demo/README.benchmark.md)，保留其源码和实现说明，已移除复制的私有 synthetic cycle state。八题独立产物都保留，没有合并参考答案或评分后修复。网页新增业务仍沿用原客户端；B03 的分类概览是导出的独立 API，没有另接新界面。

真实 Chrome/Playwright 复验 **11/11**：列表分页、搜索、待审核不公开、批量批准、审核与安全文本、隐藏评价排除、草稿编辑发布、空结果、失败重试、移动端无横向溢出和键盘导航。受保护 baseline 脚本完整 SHA-256 在执行前后相同，page_errors 为空；[完整进程与脚本身份](benchmark-blog-browser-verified-20261008.json)、[页面截图/证据](../../slop/blog-benchmark-20261008-v3/demo/slop/browser-verified/browser-evidence.json)。使用 headless，不打开用户桌面窗口。

## 检查、失败保留与范围

最终项目检查：[npm run check](check-benchmark-blog-delivery-20261008.txt) 退出 0，141 tests / 141 pass / 0 fail，官方审计 0 vulnerabilities。随后只在原测试加入 Move to 负例，[11 项定向检查](check-benchmark-blog-targeted-final-20261008.txt)通过；生产代码和其余已验内容未改变。独立只读审查发现并修复候选浏览器脚本伪通过、并行异常提前清理、探针路径/次数/行分隔误判、评分来源不全和大输入预检事实缺失；[审查记录](benchmark-blog-qa-20261008.md)列实际范围和限制。

v1 的 WebSocket idle timeout 及原始 unknown 事实保留；之后核实两个原 PID 均不存在，才使用全新的候选目录。v2 内置 provider 覆写被 CLI 拒绝，没有模型工作；v3 使用独立 `cycle-bench-http`、现有 OpenAI 登录和默认服务地址，invocation-scoped 禁用 WebSocket，健康探针返回完整 `BLOG_BENCH_READY`。没有改变全局 provider/config。

v3 生产实现及原 judge 共 17 个完整 CLI turn，客户端累计 input_tokens=11157880、其中 cached_input_tokens=9980160、output_tokens=320244；这包含协议、来源阅读、反复工具交互和评分，不是独立代码量或唯一输入量。说明的后续重评调用、失败调试各自单列原始 invocations；不估算费用或节省比例。

认证链接全部已清理，实际模型任务均结束。临时 home 仅在已知终态且核对本次创建的临时路径后清理；历史 unknown 保留或先完成进程核实。没有提交、推送、发布或版本变更。

这是单次插件开启的博客试验，没有关闭插件的 A/B、长期上下文抗偏移、插件内完整 QA/finish、人类评分一致性或跨平台测量。结果证明安装、真实 Hook/MCP/说明交接和评测路径可运行，不证明普遍质量收益。
