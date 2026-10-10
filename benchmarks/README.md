# 工程闭环 benchmark

在插件源码目录运行，产出可回查的 JSON/Markdown 报告、原始进程事实、模型输入输出和实际候选文件。运行时与已安装插件共用源码；benchmark 不增加 MCP 工具或依赖。

## 博客固定八题

用户指定的博客场景使用现有 `blog-eval-v1`：八项独立代码任务、41 项行为检查、96 项代码规则和 25 个有效复用机会。`blog.mjs` 直接复用原评分器，未改题目、参考答案、断言或分母；SoL 源码仅作为原评分器的库，不启用 SoL 插件。实际运行的是 agent-engineering-cycle。

```powershell
npm run bench:blog -- --out slop/blog-unique-run --blog-root ../blog-eval --sol-root ../codex-sol --codex <native-codex.exe> --model gpt-6-luna --effort max --packages <existing-node_modules> --browser <existing-chrome.exe>
```

输出目录必须全新，`--packages` 使用已有 Playwright 安装目录，`--browser` 指定现有 Chrome/Edge 可执行文件；不下载浏览器、不打开桌面窗口。默认两个隔离候选并行，每项一次真实实现和一次匿名新会话说明评估，共最多 17 次模型调用（含一个连接探针）。CLI 0.161 的内置 provider 不允许覆写；本 runner 使用 invocation-scoped `cycle-bench-http` 自定义 provider、现有 OpenAI 登录和默认服务地址，设置 `supports_websockets=false`，保留真实 stderr/用量，不改全局配置。[配置字段依据](https://learn.chatgpt.com/docs/config-file/config-reference)。

先检查接线时可在上述命令增加 `--reuse-mode on --smoke-case B01`：只执行这一题的真实插件协议与说明交接，保留实际候选、Hook、MCP、进程及清理证据，不生成八题或 25 机会成绩。视图或诊断修改后的 smoke 通过，仍需在新的输出目录运行完整八题才能报告复用率。smoke 和完整跑次不会复用候选、操作 ID 或旧 binding。

每项先载入真实插件 Skill/说明参考，原生 patch 探针须在本候选对 `src/features.mjs` 触发 Hook deny，实际代码与说明经 MCP 写入、I 引用绑定完整文件 hash，并执行原项目检查。合成 operator fixture 仅提供本轮测试授权，不证明人类身份；以 abandon 结束该阶段。工程循环内部校准 QA/finish 不在此轮评分，外部原评分器负责代码结果，独立模型按四项固定事实 criteria 核对说明及真实原文行引用。博客说明 rubric 尚无人类一致性或真假负控校准，不能把模型判词说成语义保证。

说明 evaluator 接收全量项目源码与原始登记，避免缺少间接校验/错误处理实现。超过 runner 的 64 KiB stdin 限制时，将精确来源/说明字节冻结到匿名目录，由只读 judge 读取；不扩大生产输入预算，不交付 I 判词，引用继续从原始字节提取。本轮实际[博客结果与限制](../docs/evidence/benchmark-blog-20261008.md)保留原评分和失败历史。

完整候选留在博客 `slop/`，投影只排除 `.codex/engineering-cycle.json`、`.codex/engineering-cycle/`、四个明示的 `docs/cycle/*.md` 以及原评分器忽略的 slop/.git；未知文件、产品改动和删除继续参与评分。选一份实际候选复制为可运行 demo，八题仍各自隔离，未把参考答案或评分后的修复混入结果。浏览器验收要求受保护 baseline 中的固定脚本 hash、完整 11 项检查、真实进程事实及零 page error。报告区分功能、有效复用、插件协议、说明语义与浏览器，失败/未运行项保留分母；没有关闭插件的 A/B，不能推出质量收益或节省费用。

```powershell
npm run bench
node benchmarks/run.mjs --plan --cases decode-record --repeats 1
```

第一条不调用模型，运行 9 个真实后端门禁场景及两个案例的 oracle/no-op 对照。第二条只生成真实模型实验的计划。两条都要求新的输出目录，默认保存在源码项目的 `slop/benchmark-<唯一标识>/`；可用 `--out <新目录>` 指定保存位置，既有结果不会被覆盖。

真实模型试跑需要已登录的原生 Codex CLI：

```powershell
npm run bench:live -- --codex <codex.exe的绝对路径> --cases decode-record --repeats 1 --timeout-ms 300000
```

这会计划三个对照臂，每个执行“生成说明 → 独立评分 → 新会话维护 → 更新后说明独立评分”，另有两个真假说明校准调用，共最多 14 次模型调用。默认完整计划为两案例、三个臂、每项三次重复，共最多 76 次调用；用 `--plan` 先检查规模。模型调用使用现有登录额度，benchmark 不估算价格。

`--model` 默认 `gpt-6-luna`，`--effort` 默认 `low`，`--timeout-ms` 默认每次模型调用 180000。三个臂使用同一组参数和相同原始代码；`--seed` 默认 42，决定每轮臂顺序。Windows 沙箱显式默认 `unelevated`，可用 `--windows-sandbox elevated` 指定；失败不会自动切换。

## 独立的 blog-reuse-v2 校准

`benchmarks/data/blog-reuse-v2.json` 冻结原 `blog-eval-v1` 的八题和 25 个机会、每项机会对应的任务消费者检查、B05/B06/B08 扩展兼容检查、纯返回值/回调副作用哨兵及负控计划。v2 不修改原 `blog-eval` 题目、rubric、runner、旧报告或严格 4/25、成功 2/8；`M/25` 固定保留全部机会，`E` 从冻结 eligible 清单计算，`E=0` 时 `M/E` 显示 `N/A`。必要新实现应由上层报告单列，不计入 M。

主 runner 在模型候选开始前先用原 `prepareRun` 建立完整八题 v1 run，再在同一个 Node 进程中调用新模块：

已接入 `bench:blog --reuse-mode off` 与 `--reuse-mode on`（其余参数沿原博客命令）。on 在隔离安装中配置独立 provider 与 rev2 门禁；off 使用原写入流程。两者均先冻结规则，再在独立评分投影探测全部25机会；省略参数保留原入口行为。比较时须核对 `comparison_sha256`、`runtime_sources.digest`、`pipeline_sha256`、模型/预算/CLI等参数，而不是把含唯一run路径的freeze_sha256当成跨跑次身份。

无需模型的完整reference校准入口：`npm run bench:reuse-calibrate -- --blog-root <blog-eval-root> --sol-root <codex-sol-root> --out <new-path-under-blog-eval-slop>`。本轮25个正控通过，参见[验收证据](../docs/evidence/component-reuse-20261009.md)；尚未跑新的模型off/on成绩。

```js
const freeze = await freezeBlogReuseV2({ blogRoot, preparedRun });
const evidence = await probeReuseContribution({
  blogRoot, solRoot, preparedRun, freeze,
  taskId: 'B01',
  opportunityId: 'B01/domain.posts.searchPosts',
  candidateRoot: path.join(preparedRun, 'B01', 'workspace'),
});
const reuseMetrics = await scoreBlogReuseV2({ blogRoot, preparedRun, freeze, evidence: [evidence] });
```

`probeReuseContribution` 先在一次性 reference 副本验证对应哨兵确实让映射的**任务消费者**固定行为检查从 pass 变 fail，再用 `runCheck` 的子进程隔离、终态、超时、输出捕获和清理事实运行候选原版与一次性扰动副本。只有候选原版全通过，且同一个受控依赖扰动令对应消费者检查产生可识别的断言失败，才产生 `contributed`；任意运行时异常不能单独作为贡献证据。helper 自测、兼容性单测、导入/调用计数、源码合规与 SHA 变化只作诊断或门槛，不直接计 M。纯函数只扰动返回值；B07 的 `runBatch` 通过不调用 `onItem` 检查 `save` 回调与推进结果。无差异、reference 正控未校准、运行/清理未知、或无法定位命名导出都返回 `unknown` 并不计 M。

每项机会分别对照原 rubric 的 AST 函数体指纹，报告原样与改名/格式化克隆命中；命中会排除该机会的 `M`，不受其他机会的真贡献影响。轻微语义改写可能避开指纹，仍须经行为扰动判别，无法证明贡献时为 `unknown`。`coverage_limits` 逐项列出已探测、未探测和 reference 正控校准覆盖，样例结果不能推广到未校准机会；`necessary_new` 明确记为 `not_assessed`，由 D/QA 单列且不计入 `M`。候选代码只在隔离的临时副本中被扰动；`scoreBlogReuseV2` 只接受当前进程中 `freezeBlogReuseV2` 与 `probeReuseContribution` 真实返回的对象，拒绝手工拼写 `reported: true` 的证据。冻结要求同进程完成 freeze、probe 与 score，以保证分母、规则身份和运行证据连续。

## 测什么

| 层 | 输入 | 判定 |
| --- | --- | --- |
| 后端合同 | 真实 runtime、独立临时文件、synthetic 范围授权 | 缺失/过期说明、改参、docs 越界与 Hook handler 的预期接受/拒绝；比较实际字节 |
| 说明生成 | 同一份正确源码与同一用户目标 | 固定六条事实：职责、参数流、具体 API/依赖、错误、副作用/清理、不变量 |
| 后续维护 | 新进程/新会话、原始源码与该臂实际说明 | 外部隐藏行为断言：指定增量、原行为回归、错误、并发和清理 |
| 说明同步 | 维护后的实际源码与实际说明 | 原六条事实及新增参数/行为路径；保留旧说明不能通过 |

`decode-record` 使用锁定版本 Zod，维护目标是增加受限数字字符串输入。`publish-text` 使用 Node 标准库，维护目标是增加并发安全的 create-only 发布，保留默认替换、错误和清理行为。任务与公开基本检查进入被测工作区；隐藏断言、oracle、真假说明与评分判据留在外部 evaluator。

baseline 只有普通任务；skill 额外读取项目 Skill 和实现说明参考；plugin 在隔离 Codex home 中安装同源码的原生包，要求实际 MCP 受管写入、I 引用、固定来源检查与原生 Hook 拒绝探针。后续维护统一使用普通新会话，以比较交接产物的实际帮助。完整插件的额外协议工作保留在时间和用量里。

## 如何避免假通过

隐藏 grader 必须接受 oracle、拒绝未修改版本，原始代码的公开检查则必须通过。测试还包含多种错误修改：过宽输入转换、必填字段被默认值掩盖、错误类型变化、输入修改、参数流错误、覆盖既有文件、泄漏临时文件、吞异常和 Unicode 字节计数错误。

模型语义 grader 先检查 gold 说明和含实质错误/评分诱导的说明。校准失败时正式 trial 不运行。评分需覆盖全部固定判据；模型返回原文路径与行段，由 harness 按原文偏移提取 pass 证据，保留 LF/CRLF，引用必须真实出现在源码/说明中。判词、章节数量、字数、hash 当前或工具退出 0 均不能直接给内容通过。MCP 业务错误不计成功，受管写入效果的 hash 必须对应最终说明字节。

报告保留 `planned = pass + fail + blocked + error + not-run`。缺产物和环境失败不能通过删样本提高成功率；原始事实缺失、捕获不全或清理未知不算成功。结果按说明、维护功能、同步说明与插件协议分别展示。相关 benchmark 输入在运行中改变会使本次结果失效。

## 隔离与结论范围

每个模型调用是独立 CLI 进程、ephemeral 会话，不加载原用户 config/rules，关闭 apps、memories、multi-agent、远端插件和宿主 Skill 发现。插件臂读取隔离 home 中由官方安装器生成的本地 marketplace/启用配置，并只为本插件 MCP 配置 approve；其他调用跳过 user config。三个臂的配置与实际调用证据均保留，judge 使用匿名目录。认证只通过临时目录中的链接复用，链接不进入源码、报告或被测工作区；结束时逐个清理。

Hook 投递由隔离包中的观察 wrapper 记录；原 handler 字节不变，stdout/stderr/退出码原样转交。只对本次已审查自有包使用 invocation-scoped hook-trust bypass，不声明取得真实用户信任。维护行为测试在模型退出后复制候选源码到独立评分夹具，再启动固定 Node grader。这个本机试跑属于逻辑隔离，不宣称阻止同 OS 权限的恶意读文件或篡改评分器。

本版本测受管说明阶段与 fresh handoff，尚不测完整校准 QA/finish、取消恢复、长对话抗偏移、其他平台、真实大型仓库或人类评分一致性。少量重复只能用于发现问题；不能据此宣布普遍效率、token 或成本改善。原始 token 字段只是 CLI 可观察用量。

方法依据：[OpenAI 的 task-specific eval、可执行断言与参考评分建议](https://developers.openai.com/api/docs/guides/evaluation-best-practices)，以及 [SWE-bench 的独立测试、oracle 验证和完整结果分母](https://www.swebench.com/SWE-bench/guides/evaluation/)。上述小型数据集和三臂设计是本项目针对用户场景作出的选择。

修改案例时同步其公开输入、维护目标、rubric/maintenanceCriterion、oracle 和隐藏断言，重新运行 oracle/no-op 及相应错误变体。运行入口、语义判据和行为 scorer 各有独立责任，不修改生产 runtime 来迎合 benchmark。
