# 博客 benchmark 独立审查与修复

角色：新上下文 GPT-6 Luna/max，只读检查 benchmark 代码与隔离测试；未读取候选、实现 I 或实际评分判词，未调用模型或操作插件。主 agent 负责修复与实际浏览器/模型验收。初验、复验以源文件 SHA 和实际运行断言区分，不以角色名称宣称通过。

| 发现 | 处理与有效证据 |
| --- | --- |
| 候选浏览器脚本可伪造 passed | expectedScriptSha256 必填，来自受保护 baseline；执行前后核对实际字节，并要求完整 11 个有序 check ID。mock 测试仅验证接线；另有真实 Chrome 证据。 |
| Promise.all 快失败提前清理共用 auth | runBlogTrials 用 allSettled drain 两个 scope，各 trial 保存 error/unknown；deferred gate 反例验证慢任务结束前 coordinator 不结束，保留八项分母。 |
| 任意 Hook deny 可能被计分 | 核对 cwd、唯一目标和单次 apply_patch；分类器拒绝非注释、删除、Add/Delete/Move、重复、Unicode 行终止符和 lone CR；CRLF 正例保留。 |
| 说明来源未含间接 helper/登记 | collectNoteSources 提供全量 src 与真实 package/components/architecture 字节，不交付 I；相关 fixture 验证 validation/errors 与登记不依赖 required reuse 列表。 |
| 全量输入超过 runner 64 KiB | 大输入使用匿名冻结文件、原始字节 SHA manifest 与只读 judge；跨目录来源拒绝，引用仍取原文。预检超限保存 not_started，不冒称原生副作用未知。 |
| 临时 home 残留 | 只删除本次 mkdtemp 生成且经 canonical 临时父目录核对的路径；unknown 时保留，认证链接独立清理；demo 不携带 private cycle state。 |

审查者最后复核 `benchmark-blog.test.mjs` 和 `benchmark-judge-files.test.mjs` 11/11 pass。其指出 Move 负例尚缺，主 agent 随后补齐同一测试并保存最终 11/11 输出。Stock `src/hook.mjs` 与 `check-runner.mjs` 没有修改，最终还以全 16 源码字节核对生产源码/安装缓存/v3 冻结输入一致；不依赖未跟踪文件的空 git diff 证明相同。

审查范围是 source/helper 可靠性，不能冒称真实模型或浏览器运行验收。大输入路径已在真实最终说明重评使用；真实浏览器身份和流程由单独进程证据覆盖。home 删除/保留尚无专门隔离单测，不把源码核对说成所有环境已验。
