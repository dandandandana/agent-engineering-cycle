# B：反例与故障独立审查

执行者：defaults_redteam，gpt-6-luna/max，最小上下文；只读审查，未改文件/运行测试。以下由主 Agent 整理返回，包含对权限语义的校正，不把条件假设当已证实漏洞。

- 确认无配置持久操作受拒绝、MCP默认地址可能是插件缓存。默认profile必须先取得可靠项目上下文；普通问题不得自动begin；缺上下文要一次选择而非猜目录。
- 确认runtime PreToolUse仅按工具名与全workspace active状态拒绝，没有目标/session过滤；扩大默认启用范围会使无关文件或session误阻断。建议实测解码后按受管路径约束，未知输入不能假称路径覆盖。
- 默认配置选择必须区分缺文件与非法值：当前if(!raw)把null/false/0/空字符串当缺失。引入默认后会掩盖坏配置，需存在性分支及负例。
- 新默认的只读范围与可写scope应分开；不能自动扫父目录/全仓，也不能把所有只读输入都强制放进修改许可。begin/prepare/attach当前代码确实接受额外输入，但old grant.paths文案是修改目标；无明确读授权合同，不判成已证实产品越权漏洞。
- status/Hook/begin不启动仓库脚本或模型；固定verify动作才执行命令，QA无receipt不称可用。未知副作用继续原pending/request恢复，禁止自动换ID重试。
- 子Agent父session、切cwd、全局最近记录会串项目；必须当前关联、冲突拒绝、旧profile固定。历史evidence显式召回是审计，不替代current binding或许可。

关键依据：src/local/config.mjs、store.mjs、runtime.mjs、server.mjs、hook.mjs、core/cycle.mjs、check-runner.mjs、hook-context.mjs及architecture/acceptance/CRCTX合同。尚未运行新宿主/反例；模型/QA和读范围风险不能据本报告宣称已修复。
