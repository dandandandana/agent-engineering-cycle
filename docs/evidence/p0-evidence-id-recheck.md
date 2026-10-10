# P0 evidence ID 修复定向复验

范围：仅复验此次 `LocalStore` evidence kind/ID 校验改动、路径拒绝和证据篡改边界。没有改源码、测试、原需求或冻结输入；没有调用模型或网络。此补充不改写原 67 项复验结论。

## 结果

- **P0 数字前缀 round-trip：PASS（程序合同 fixture）**。新增 `tests/safety.test.mjs` 中的真实 `LocalStore` + 签名 `qaCapability` 测试通过；`p0-live-qa`、`p0-sandbox` 均能 archive / recall。fixture 明确为模拟校准程序，不证明真实 Codex driver 或 live QA。
- **路径边界：PASS**。隔离临时 workspace 中，archive kind `../p0`、evidence ID 含 `../` 及 ID 后缀路径片段均被 `EVIDENCE_INVALID` 拒绝；没有创建或访问 workspace 外文件。
- **payload 篡改：PASS**。改动已存档 payload 后，`store.evidence(id)` 报 `EVIDENCE_INVALID`。
- **记录元数据篡改：FAIL（残余缺陷）**。在临时 workspace 里只把已存档记录的 `kind` 从 `p0-live-qa` 改成 `p0-sandbox`，保持 `id`、`digest`、`payload` 不变，`store.evidence(id)` 仍返回已篡改记录，repro 输出 `tampered_kind_accepted:true`。这意味着内容摘要保护 payload，但目前 recall 未校验记录 `kind` 与 ID 前缀/摘要的关系；通过 evidence portal 读取完整记录时会暴露未被检测的错误分类。建议 `evidence()` 校验 `record.kind` 是合法 kind 且 `${record.kind}-${record.digest} === id`，并校验 `schema_revision === 1`；archive 遇到已存在记录时也应校验完整记录身份，而不只比较 payload digest。该缺陷不推翻 P0 前缀修复，但 tamper acceptance 不能整体标为通过。
- **定向自动测试：PASS，14/14**。

## 复现与检查

工作树：`D:\zzd\agent-engineering-cycle`。运行：

```text
node --test tests/store.test.mjs tests/safety.test.mjs
```

结果：14 tests、14 pass、0 fail。新增校准合同用例和既有 API 不可变 / payload 篡改测试均通过。

隔离边界脚本：

```text
node D:\zzd\agent-engineering-cycle\slop\p0-evidence-id-recheck.mjs
```

输出：`valid_numeric_prefixes_round_trip:true`、`traversal_rejected:true`、`tampered_kind_accepted:true`、`payload_tampering_rejected:true`。脚本只在 Node 临时 `engineering-cycle-qa-p0-*` workspace 写 fixture，并在结束时删除。

源码与测试文件在运行前后的 SHA-256 未变：

- `src/local/store.mjs`: `BB1B66D06B4DB63010814F6516FFF7E8E36D6CCEE0C49F9563E2673A06BF4FF7`
- `tests/safety.test.mjs`: `3BD01997642DF3F9089AF53E837E611210D80B91A3CA6BBA60C8B98C38AABEB9`

相关实现位置：`src/local/store.mjs:65-77`；新增合同回归：`tests/safety.test.mjs:9-31`；既有 payload 篡改回归：`tests/store.test.mjs:135-160`。

## 未测范围

未调用真实 CLI / Desktop Host / 模型，也未验证 live QA provenance 或实际安装覆盖。真实 CLI P0 与 Host 安装状态由主 Agent 另行取证；本报告不将模拟 driver 视为 live 证明。
