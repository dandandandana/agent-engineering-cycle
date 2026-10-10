# Agent Engineering Cycle

独立的工程闭环 MCP/Hook/Skill 插件；核心闭环独立工作，可选的 rev2 组件发现使用固定 SoL provider-only。根目录的 `plugin.json` 与 `mcp.json` 使用 portable plugin 格式；Codex 原生安装包由同一源码生成，安装与 TUI 验证记录见[实施状态](docs/IMPLEMENTATION_STATE.md)。本地状态、授权与能力边界见[架构设计](docs/design/architecture.md)和[验收标准](docs/design/acceptance.md)。

组件复用与 Hook 上下文控制已按四角色评审合同实现，见[设计](docs/design/component-reuse-context.md)和[实际实施文档](docs/design/component-reuse-implementation.md)。启用 rev2 项目策略后，源码写入须有真实组件捕获和原 D 选择；内部使用独立 SoL provider-only，模型仍只看到七工具。Hook 按宿主 session 路由，完整 JSON 不超过 2048 UTF-8 字节。旧 rev1 项目继续原行为；主插件缓存已更新，重启后的当前会话已加载新版 MCP 接口，源码版本保持 0.1.0。

2026-10-10 的[默认配置与首次使用设计](docs/design/default-configuration.md)已落到源码：没有配置文件时使用内存 `standard@1`，原生包按当前 turn 定位项目，携带固定 SoL 只读 provider，未登记项目走 repository/D v2。实际覆盖、检查与安装状态见[默认能力实现记录](docs/design/default-implementation.md)。既有 rev1/rev2 保持原合同。

需要 Node.js 20.8 或更新版本。源码测试和打包复用相邻目录的 codex-sol Provider；CI 固定其已提交版本 `7777b5f2344be324164c1b542756cda108fb1bac`。首次克隆本项目后，在项目目录准备相邻依赖并检查：

```sh
git clone https://github.com/dandandandana/codex-sol.git ../codex-sol
git -C ../codex-sol checkout 7777b5f2344be324164c1b542756cda108fb1bac
npm --prefix ../codex-sol ci --ignore-scripts
npm ci --ignore-scripts
npm test
npm run check
node src/cli.mjs doctor
```

已有相邻 codex-sol 时复用该目录并核对版本；运行安装包的项目不需要再克隆此源码依赖，Provider 已随包分发。

`npm test` 运行项目检查；`npm run check` 运行测试和高危级别依赖审计。无配置的 `doctor` / `cycle_status` 只读返回默认来源、检查与 QA 候选，不初始化项目。`configured=false` 表示没有项目覆盖文件，`configuration.effective=true` 表示默认已生效。只有配置文件确实不存在才采用默认；非法、不可读或未知版本仍失败。可选 `init --config <file>` 支持原 strict rev1/rev2 或 `{"schema_revision":3,"profile":"standard"}` 的稀疏覆盖，初始化不授予操作许可。

Codex CLI 0.158.0 和 0.161.0 会跳过 portable manifest 的 Hook。需要三个层面一起使用时，先生成原生包，再将它登记到本地 marketplace：

```sh
node scripts/package-plugin.mjs --out <new-plugin-directory> --format codex
```

原生包仅含 `.codex-plugin/plugin.json`，共用源码、完整 Skill 与 Hook，并从相邻 codex-sol 构建 provider-only；可用 `--provider-source <root>` 指定其维护源码。`.mcp.json` 使用相对入口和 `--auto-workspace`，转发 CODEX_HOME/CYCLE_WORKSPACE。生成器要求依赖已安装、目标目录不存在，核验完整 provider 清单；不分发项目状态、秘密文件或 slop。portable 可选 `--format portable`。在 TUI `/hooks` 审查并信任四个定义；改变定义后需重新审查。

授权必须在真实交互式终端中执行，例如：

```sh
node src/cli.mjs authorize --workspace <project-path> --spec action.json
```

Action spec 的字段形状如下；`paths` 应列出本次精确目标文件，`mode` 选 `docs` 或 `implement`：

```json
{
  "kind": "action",
  "goal": "本轮目标",
  "mode": "implement",
  "paths": ["src/example.mjs"],
  "actions": ["control", "artifact", "apply", "verify", "qa", "reconcile"]
}
```

终端确认记录的是本地操作来源，不是人类身份认证，也不证明其他同机进程可信。

原生插件以 UserPromptSubmit 的真实 session/turn/cwd 与 MCP 当前 turn metadata 定位项目；地址有界保存于插件自有 CODEX_HOME 数据目录，不代替动作授权。缺失、过期或歧义返回 context_required/ambiguous，不猜安装目录或最近项目。操作者 `--workspace` / `CYCLE_WORKSPACE` 仍是显式连接；与可靠当前地址冲突时拒绝。未加入活动 cycle 的会话只得到只读恢复指针，需授权 resume 才可续写；空闲问答不会开始任务。

新默认的 QA model 优先明确选择，否则以宿主 model 为候选；原生 executable 只从已知可信布局发现，歧义或缺失如实报告。候选不表示可用：先显式 `node src/cli.mjs calibrate-qa --workspace <root> --live --model <model> --executable <native-executable> --windows-sandbox elevated`，程序保存签名选择与真实校准回执，免手填 QA JSON。模型/二进制需要补选时，在 begin 前完成；活动任务的执行身份已经冻结。Windows 沙箱也可明确选 unelevated，不自动降级；身份变化须重新校准。原 rev1/rev2 保持配置/回执要求。Hook 约束明确目标与受管 scope 相交的原生写，不能证明所有 Shell/编辑器覆盖；Stop 不自动续跑，Desktop 与其他平台仍分别验收。

首次工程任务先调查原需求、源码与检查，再复用或确认精确许可。必要新 R/D 文档需同时列入 action 的 `paths` 和 `documentation_paths`，由原 `cycle_apply` 创建父目录与文件；业务 Markdown 不自动豁免。begin 固定检查候选、排除理由或获准的 `planned_node_tests` 精确路径；无实际行为检查会保留 behavioral_missing，source-integrity 和 QA 自述不能抹掉该缺口。现有规划文档继续拥有原记录。

Docs权限只运行配置的具名内建来源校验，例如 `{"id":"doc-source","kind":"source-integrity"}`，不执行任意检查命令。它证明当前来源身份，不能代替代码测试或语义QA；仍需满足当前目标的独立QA与同步门。

需要记录关键函数或组件如何工作时，可在 I 中附源码实现说明引用；正文仍维护在原源码注释或模块文档中，QA 会回查源码判定语义。目标、引用字段和授权边界见[实现说明参考](skills/agent-engineering-cycle/references/implementation-notes.md)。

源码目录另附[可重复 benchmark](benchmarks/README.md)：`npm run bench` 运行后端门禁与 oracle/no-op；`npm run bench:live -- --codex <native executable> --cases decode-record --repeats 1` 运行普通任务、纯 Skill、完整插件三个说明生产对照，再交给新会话维护和独立评分。真实模型执行使用现有额度，首次建议先用 `--plan` 查看规模；小样本结果和完整 QA/长期抗偏移的未测边界分开报告。

用户指定的真实博客测试另有 `npm run bench:blog`：复用固定八题、独立说明评分和真实浏览器验收，运行参数及边界见同一份 [benchmark 说明](benchmarks/README.md#博客固定八题)。

组件复用可显式采用 `schema_revision: 2`。先在 codex-sol 仓库运行 `node scripts/package-provider.mjs --out <new-provider-directory>`，取其 provider-manifest.json 的真实 SHA-256。项目配置中的 component_reuse 形状如下；绝对路径由操作者配置，不能由工具参数临时改变：

```json
{
  "schema_revision": 2,
  "checks": [],
  "component_reuse": {
    "architecture_path": "architecture.json",
    "discovery_scope": { "roots": ["src"], "files": ["architecture.json", "components.json"] },
    "documentation_paths": ["docs/requirements.md", "docs/design.md", "docs/implementation.md"],
    "provider": {
      "executable": "<absolute-native-node-executable>",
      "args": [],
      "manifest": "<absolute-provider-manifest.json>",
      "manifest_sha256": "<actual-64-character-sha256>",
      "protocol": "sol-component-discovery/1",
      "timeout_ms": 30000
    }
  }
}
```

完整固定检查和 QA 配置沿用原项目。schema/策略在活动 cycle 中固定；要切换策略，先按原授权结束或放弃旧 cycle。发现和 D 的填写见 [组件复用参考](skills/agent-engineering-cycle/references/component-reuse.md)，不能通过遗漏 implementation_targets 绕过源码门禁。

rev2 任务使用工程循环作为完整流程控制器，SoL 走独立 provider；在该任务的 profile 中不要同时启用另一套完整 SoL Flow/Write/Hook。主缓存与新版来源已更新，文件身份和新进程启动核验通过；重启后的当前会话已连通新版 MCP 接口，详情见[主安装续接](docs/evidence/plugin-update-20261009.md)。早前官方更新的占用失败保留在[原验收记录](docs/evidence/component-reuse-20261009.md)。
