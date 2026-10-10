# P0 evidence envelope 定向复验

范围仅限重放原 `kind` 元数据篡改反例，并运行 Store 与 safety 两组定向测试。未改源码、测试、原失败报告或冻结输入；未调用模型、网络或真实 CLI/Desktop Host。

- 原反例复放：**PASS**。在临时 workspace 中 archive `p0-live-qa`，只将已存档封套的 `kind` 改为 `p0-sandbox`，保留 id、digest、payload。`store.evidence(ref.id)` 现在以 `EVIDENCE_INVALID` 拒绝；对同一损坏记录再次 `archive('p0-live-qa', payload)` 也以 `EVIDENCE_INVALID` 拒绝。脚本输出：`kind_tamper_rejected_by_recall_and_archive=true`。
- 定向测试：**PASS，14/14**，命令 `node --test tests/store.test.mjs tests/safety.test.mjs`（cwd `D:\zzd\agent-engineering-cycle`）。
- repro 脚本：`D:\zzd\agent-engineering-cycle\slop\p0-evidence-envelope-recheck.mjs`。只写入并清理 Node 临时 workspace fixture。
- 源码和两组测试在本轮复验前后 SHA-256 相同：
  - `src/local/store.mjs`: `AD866EDEA960A9F2643AE8F039DBA5F02025812793C2033E7A6DDD3669D8DDFD`
  - `tests/store.test.mjs`: `34BEB44B2AD4D361CA037F1A11E1FA44AD68BEB1A26309CECDE56C68110A81FD`
  - `tests/safety.test.mjs`: `3BD01997642DF3F9089AF53E837E611210D80B91A3CA6BBA60C8B98C38AABEB9`

本次复验仅关闭 `kind` 篡改这一具体反例；模拟 fixture 不构成 live QA、driver、Host 安装或桌面集成证明。
