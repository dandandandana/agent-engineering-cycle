# 主插件安装续接

用户沿用先前安装授权，重启 Codex 后继续安装，并提出直接卸载旧插件再安装新版。没有提交、推送、发布或变更版本；插件身份仍为 `agent-engineering-cycle@engineering-cycle-local` / `0.1.0`。

## 实际状态与处置

重启前的新源码此前仅通过隔离发行验证。重启后主缓存仍是旧版，marketplace 仍指向 20261008 来源；旧 `cycle_artifact` 描述不含新结构化视图。当前一个 Node 服务的真实 cwd 是主缓存 `0.1.0`，只读进程目录探针已用自身目录核验；没有终止该服务或其他会话。

官方 `plugin add` 再次返回 os error 5；来源注册在失败后恢复。用户提出卸载重装后，官方 `plugin remove` 返回 os error 32。随后的实查表明缓存目录还在、内容已空，安装记录仍为 installed/enabled；因此卸载未完整成功，不能称为官方重装成功。

已验证的新原生包保存在 `C:/Users/dandandandana/.codex/plugins/local-sources/engineering-cycle-local-20261009-final/agent-engineering-cycle`。先在主缓存的同级临时目录复制完整包并核对身份，再次确认主缓存为空，以原生命名发布各入口；`.codex-plugin` 最后发布。未替换非空的运行文件树，未删除或移动占用中的根目录。完成后临时目录已空并移除，marketplace 注册指向新版来源；旧源码发行保留。

## 已运行核验

- 安装源与此前最终源码/完整 Skill 清单28项一致；完整原生发行34项全部匹配、0缺失、0漂移，含全部8个Skill文件、Hook、锁文件和原生入口。主缓存不含会遮蔽原生入口的根 `plugin.json`。
- 从实际主缓存启动独立 MCP 进程：七工具注册、新 `reuse_selection` / `source_view` 描述、只读 `cycle_status` 通过；未配置夹具未创建工程状态。
- 从实际主缓存执行 SessionStart Hook：退出0、无stderr、夹具保持空。它仅证明此只读启动分支，不证明 Desktop 全事件覆盖。
- 官方 plugin list 显示原插件身份 installed/enabled=true，marketplace 来源指向新发行。

原始记录位于 [primary-plugin-update-20261009](../../slop/primary-plugin-update-20261009/)：`plugin-add.log` / `plugin-remove.log` 保留失败；`cache-publication.json`、`installed-verification.json`、`installed-runtime.json`、`final-plugin-list.json` 与 `update-status.json` 分别记录发布、文件身份、真实新进程、安装配置与待重载状态。

## 重启后的当前会话核验

用户再次要求检查安装。当前官方列表仍为 installed/enabled=true，34文件重新核对全部匹配、0缺失、0漂移，完整8个Skill文件一致。当前宿主暴露七工具，cycle_artifact 的真实描述已经包含 reuse_selection/source_view；直接调用当前会话的 cycle_status 返回 ok=true/status=unbound/configured=false。旧服务进程已退出，新服务的实际 cwd 指向更新后的主缓存。因此已经确认当前宿主加载新版 MCP 接口，不再处于待重载状态。原始事实见 [host-reload-verification.json](../../slop/primary-plugin-update-20261009/host-reload-verification.json)。

宿主注入的 SESSION_UNBOUND 提醒与源码逻辑一致：当前会话没有绑定活动工程循环；它不是安装失败。此次只检查安装与连接，没有初始化项目、授予操作范围或开始工程循环。

## 尚未验证

后台等待程序只准备过，未启动，没有自动待执行安装。未再运行模型或完整博客 benchmark，没有新的有效复用率或 Desktop 全事件覆盖结论。
