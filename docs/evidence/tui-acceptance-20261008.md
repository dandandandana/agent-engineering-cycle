# 2026-10-08 本机安装与 TUI 验收

用户授权自行安装、只使用 TUI，并明确要求更新 Codex CLI。全局 npm CLI 已从 0.158.0 更新到 0.161.0；原生 executable 与 `codex --version` 均核验为 0.161.0。Desktop 程序未升级，未打开或关闭其他会话的窗口。

插件身份为 `agent-engineering-cycle@engineering-cycle-local`，版本仍为 0.1.0，真实用户配置中 installed/enabled 均为 true。安装路径是用户 Codex plugin cache 下的 `engineering-cycle-local/agent-engineering-cycle/0.1.0`；本地来源是 `local-sources/engineering-cycle-local-20261008/agent-engineering-cycle-native-v2`。运行时、Hook、Skill 与来源字节身份见[最终原始记录](tui-acceptance-20261008.json)。

## 发现与修复

最初 portable 包能注册七个 MCP 工具，但未加载 Hook。核对当前宿主源码确认，0.161.0 的 [loader.rs](https://github.com/openai/codex/blob/rust-v0.161.0/codex-rs/core-plugins/src/loader.rs#L953-L962) 对 AgentPlugin 格式返回空 Hook 列表；0.158.0 同样如此。新增打包脚本从原有 manifest 生成单独的 Codex 原生包，省去会遮蔽原生入口的根 `plugin.json`。原生 MCP 使用相对入口、宿主解析的 `cwd: "."`，并显式转发 `CYCLE_WORKSPACE`。

真实安装的第一次 marketplace add/plugin add 成功。刷新原生包时，官方 remove/add 因共享 Desktop MCP 进程占用缓存目录而失败；remove 已将本插件缓存清空。仅恢复这个已确认为空的自有目录，再同步本次修改的文件；未停止共享 Desktop 进程。最终本地来源与缓存的内容身份相符，真实 TUI 加载成功。此前 portable 来源与失败历史均保留。

CLI 更新后，默认 Windows 沙箱初始化遇到既有 Desktop runtime 文件锁，无法完成初始探针。项目增加可选 `qa.windows_sandbox`，校准与实际 QA 使用同一显式模式，模式变化会使校准失效；本次隔离夹具选 `unelevated`，未修改全局默认值。driver revision 为 4，真实只读写拒绝与已知缺陷发现重新校准通过。部分 TUI Shell 命令仍遇到宿主 setup refresh 错误；MCP 读取实际源码与后端固定检查可用。

首轮 QA 冻结快照发布遇到 `EPERM`，操作被保留为 unknown/interrupted，未返回 job ID、未重复启动。新夹具进一步复现了 `phase: publish` 的目录 rename 失败。新增发布阶段诊断，并仅在 Windows 对尚未发布且内容仍匹配的自有树进行最多三次 rename 尝试；重试前确认目标不存在，持续拒绝或目标占用仍失败。没有更改未知操作恢复规则，前两份失败状态保持原样。外部文件锁的具体来源未认定。

## 实际验证

| 范围 | 观察到的结果 |
| --- | --- |
| 加载与信任 | TUI `/mcp` 注册七个工具；`/hooks` 审查并信任本插件四个定义；实际读取打包 Skill |
| 权限与上下文 | 错误 grant 引用被拒绝；运行时 Hook 交付当前 binding、阶段和笔记计数；未批准的 reconcile 请求被拒绝 |
| 原生写入拦截 | 唯一一次 `apply_patch` 被本插件 PreToolUse 拒绝；哨兵 SHA 保持一致，拒绝原文留在首轮工具记录中 |
| 实现说明 | TUI 经 `cycle_apply` 修复 18 岁边界并更新机制说明；I 保存源码、笔记行段和相关测试 SHA，状态为 current |
| QA 前置门 | I、笔记与检查缺失时，真实 `cycle_qa start` 返回 EVIDENCE_INVALID，未创建 job |
| 独立 QA | 最终 TUI 启动新 CLI job；实际读取六份冻结输入，AC-AGE、AC-NOTES 均 pass；终态、退出及输入交付事实完整 |
| 完成 | TUI 读取实际 QA 报告，再提交报告判断和当前证据引用；返回 `current_complete=true`、`lifecycle=completed`、无 blockers |
| 本地检查 | [最终检查](check-tui-final-repair-20261008.txt)：92 tests / 92 pass / 0 fail，审计 0 vulnerabilities |

首轮 TUI session 为 `01a11907-fa32-71b0-bb50-1fc2b1652b55`，七个工具均有实际调用；[首轮记录](tui-first-attempt-20261008.json)保留拒绝、Shell 失败和未完成状态。最终 TUI session 为 `01a1192b-8cb8-7651-b976-03b42b180a73`，QA job 为 `a25ed5d3-594b-4443-bb4e-7ea1f32e1b45`。最终夹具由操作者通过同一运行时建立 R/D/I，TUI 执行 verify、真实 QA 与 finish；这些不同来源没有合并成一次连续成功的运行。

QA 输入包含需求、设计、源码、原笔记、相关检查和哨兵；I 总结未交付。原始检查、QA 报告与执行记录按内容身份导出到 `raw-tui-20261008/`。没有导出 authority key 或授权签名；终端确认由用户授权的主 Agent 操作，`human_identity_verified=false`。

这是 Windows 本地夹具验收。Hook 证据覆盖此次匹配的原生 `apply_patch` 和实际状态上下文；未覆盖所有 Shell/编辑器、全部超时/取消组合、Linux/ARM64 或 Desktop 完整流程。自动 Stop 续跑仍关闭，也没有取得成本或效率 A/B 结论。
