# 独立复验：函数实现说明修复

日期：2026-10-08。此复验只覆盖此前两项 NOTES-05 边界及修复后受影响的 stdio 用例，不替代完整验收，也未重跑全套测试。

## 最终冻结身份

- 输入：`D:\zzd\slop\implementation-notes-20261008\notes-2f8fcb82-906f-48dd-8ea4-3c872e7f1465\input`
- 执行副本：`D:\zzd\agent-engineering-cycle\slop\notes-2f8fcb82-906f-48dd-8ea4-3c872e7f1465`
- manifest：`D:\zzd\slop\implementation-notes-20261008\freeze.json`，45 files，digest `7ab3abad7faef83abc8524e1c370486e4bf8cc94f6d86fd10accdfc66ec0315f`

按 manifest 逐文件核对后，input 与 execution 均为 45/45 match，0 missing、0 mismatch、0 extra。与上一冻结副本 `7b2c628640979442bfdf87fc0af84264fe33e65959d7ff7389055d6039a42e9d` 对比，唯一变化是 `tests/qa-sources.test.mjs`；函数身份、I 路径别名排除、分页实现、实现说明和别名回归均为相同字节。因此前一轮在该副本完成的 Workspace file_id、case/hardlink、I summary 隔离和维护说明复核可绑定到此最终冻结版。

## 最终 stdio 复验

在最终执行副本运行：

```text
node --test tests/qa-sources.test.mjs tests/text-pagination.test.mjs
```

结果 2/2 通过，0 fail。两项均启动本地 QA source MCP stdio：普通分页用例通过；Unicode 回归页不再拆开代理对，页长/`next_offset` 与实际内容一致，单页保持 well-formed。`text-pagination.test.mjs` 还验证半字符 offset 与 limit=1 无法容纳完整 astral 字符时返回有界 `EVIDENCE_INVALID`，不会产出半字符页面。

上一冻结副本的相关测试组合曾有 25 pass / 1 fail：`tests/qa-sources.test.mjs:183` 固定要求页长等于 8192，但安全边界在该 fixture 中正确返回 8191；这条旧断言没有接受不拆代理对所需的可变页长。最终版只改该测试：期望页长改为该输入的正确 8191、令 `next_offset` 等于实际长度，并验证页文本没有孤立代理项。最终 stdio 命令已通过，修复没有通过放松边界断言来消除失败。

## 同字节沿用的别名结论

前一冻结副本的 `tests/implementation-notes.test.mjs` 通过：读取实际 case variant/hardlink 的 `file_id` 与 I 路径一致；QA manifest 不含 I 原路径、大小写别名或硬链接别名；尝试把这些别名用作 mechanism documentation 时，inspect/prepare 拒绝且没有替换已有 I notes。相邻的 QA snapshot 测试也检查 context 的 targets/references 和 `symbol_verified=false`、`semantic_verified=false`。最终快照只变更 QA 分页断言测试文件，上述实现和回归测试字节未变；本次按要求未重跑这些非 stdio 检查。

维护案例文档现已写明 `implementationNoteSchema.array().max(16).safeParse(...)` / target schema 调用和 `zod@4.6.5` 锁版本；说明中的 SHA/currentness 仍明确不证明符号存在或语义正确。NOTE-04 也区分 pending 前拒绝不登记 operation 与 pending 后保留失败 outcome 供显式恢复。本轮未重跑维护案例、完整测试套件或模型。

报告写在冻结目录之外。报告落盘后再次核对同一 manifest：输入、执行副本仍分别为 45/45 match，0 missing、0 mismatch、0 extra。
