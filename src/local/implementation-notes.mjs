import { implementationNoteSchema, implementationTargetSchema, fault, textPage } from '../core/contracts.mjs';
import { workspacePathKey } from './workspace.mjs';

const MAX_TEXT = 8192;
const MAX_PATHS = 64;
const MAX_BYTES = 16 * 1024 * 1024;
const key = reference => JSON.stringify([reference.path, reference.symbol]);

/** Exclude captured I bytes, never a later version which happens to reuse its path/inode. */
export function implementationVerdictExclusions(artifact) {
  const hashes = new Set([...(artifact?.manifest?.entries ?? []), ...(artifact?.verdict_sources ?? [])].map(s => s.sha256).filter(Boolean));
  return { hashes };
}

/**
 * 返回笔记引用涉及的去重文件路径；参数是经公共schema校验的notes。
 * notes → source.path/documentation.path/related_sources[].path → Array.flatMap → Set。
 * 不读文件、不解析包、不修改状态；字符相等去重，路径保护留给Workspace边界。
 */
export function implementationPaths(notes = []) {
  return [...new Set(notes.flatMap(n => [n.source.path, n.documentation.path, ...n.related_sources.map(r => r.path)]))];
}

/**
 * 检查原实现说明与源码/相关输入身份，返回当前性、行段摘录和计数，不保存第二份说明正文。
 * notes/targets → Zod schema → implementationPaths → Workspace.readSource 的安全UTF-8文件事实；
 * expected sha256 与 actual sha256比较 → current/stale/missing；documentation行段越界或空白 → invalid。
 * documentation.content → 按行选择 → 合计8192字符截断；related_sources仅检查指定文件，不遍历依赖图。
 * malformed/重复/输入预算超限抛EVIDENCE_INVALID，越界或秘密路径沿Workspace拒绝；缺文件作为missing返回。
 * 只读且无lease/初始化；调用方承担受管接入与snapshot的一致性。本次多文件观察不等同冻结快照。
 * 不变量：scope与I汇总隔离、全文件摘要、读取/输出预算不能省略；symbol与语义保持未验证。
 * 按实际原文和已有Workspace事实查证，避免另增语言解析器；选择范围见docs/design/implementation-notes.md。
 */
export async function inspectImplementationNotes(workspace, { notes = [], targets = [], allowedPaths, excludedPaths = [], excludedHashes } = {}) {
  const parsedNotes = implementationNoteSchema.array().max(16).safeParse(notes);
  const parsedTargets = implementationTargetSchema.array().max(16).safeParse(targets);
  if (!parsedNotes.success || !parsedTargets.success) throw fault('EVIDENCE_INVALID', 'Implementation-note references are malformed.');
  notes = parsedNotes.data; targets = parsedTargets.data;
  const noteKeys = notes.map(n => key(n.source)); const targetKeys = targets.map(key);
  if (new Set(noteKeys).size !== noteKeys.length || new Set(targetKeys).size !== targetKeys.length) throw fault('EVIDENCE_INVALID', 'Implementation symbols must have unique references.');
  const paths = [...new Set([...implementationPaths(notes), ...targets.map(t => t.path)])];
  if (paths.length > MAX_PATHS) throw fault('EVIDENCE_INVALID', 'Implementation notes exceed the explicit path limit.');
  const allowed = allowedPaths && new Set(allowedPaths);
  if (allowed && [...paths, ...targets.map(t => t.path)].some(p => !allowed.has(p))) throw fault('SCOPE_DENIED', 'Implementation-note inputs must be in this cycle scope or declared inputs.');
  const excluded = new Set(excludedPaths.map(workspacePathKey));
  if (paths.some(p => excluded.has(workspacePathKey(p)))) throw fault('EVIDENCE_INVALID', 'Mechanism notes must reference prose/source outside the I verdict summary.');
  if (!paths.length) return { status: 'not-requested', summary: { required: 0, attached: 0, current: 0, stale: 0, missing: 0, invalid: 0 }, entries: [], semantic_verified: false, coverage: 'No implementation targets are declared.' };
  const captured = new Map(); let bytes = 0; let remaining = MAX_TEXT;
  const excludedFiles = new Set(); const excludedContent = new Set(excludedHashes ?? []);
  for (const p of excludedPaths) {
    try { const source = await workspace.readSource(p); bytes += source.size; if (bytes > MAX_BYTES) throw fault('EVIDENCE_INVALID', 'Implementation-note inputs exceed the byte limit.'); if (excludedHashes === undefined || excludedContent.has(source.sha256)) excludedFiles.add(source.file_id); }
    catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; }
  }
  for (const p of paths) {
    try {
      const source = await workspace.readSource(p); bytes += source.size;
      if (bytes > MAX_BYTES) throw fault('EVIDENCE_INVALID', 'Implementation-note inputs exceed the byte limit.');
      if (excludedFiles.has(source.file_id) || excludedContent.has(source.sha256)) throw fault('EVIDENCE_INVALID', 'Implementation notes cannot read an alias or captured bytes of the I verdict summary.');
      captured.set(p, source);
    } catch (error) {
      if (error.code !== 'SOURCE_UNAVAILABLE') throw error;
      captured.set(p, null);
    }
  }
  const entries = notes.map(note => {
    const references = [note.source, note.documentation, ...note.related_sources];
    const inputs = references.map(r => ({ path: r.path, expected_sha256: r.sha256, actual_sha256: captured.get(r.path)?.sha256 ?? null }));
    let status = inputs.some(r => r.actual_sha256 === null) ? 'missing' : inputs.some(r => r.expected_sha256 !== r.actual_sha256) ? 'stale' : 'current';
    const documentation = captured.get(note.documentation.path); let content = null; let truncated = false;
    if (documentation) {
      const lines = documentation.content.split(/\r\n|\n|\r/);
      if (note.documentation.end_line > lines.length) status = 'invalid';
      else {
        const selected = lines.slice(note.documentation.start_line - 1, note.documentation.end_line).join('\n');
        if (!selected.trim()) status = 'invalid';
        content = textPage(selected, 0, remaining).text; remaining -= content.length; truncated = selected.length > content.length;
      }
    }
    return { source: note.source, documentation: note.documentation, status, inputs, content, truncated, symbol_verified: false, semantic_verified: false };
  });
  for (const target of targets) if (!noteKeys.includes(key(target))) entries.push({ source: target, status: 'missing', reason: 'No implementation note is attached for this declared target.', symbol_verified: false, semantic_verified: false });
  const summary = { required: targets.length, attached: notes.length, current: 0, stale: 0, missing: 0, invalid: 0 };
  for (const entry of entries) summary[entry.status] += 1;
  return { status: !entries.length ? 'not-requested' : entries.every(e => e.status === 'current') ? 'current' : 'needs-update', summary, entries, semantic_verified: false, coverage: 'Declared targets only; file identities and selected prose are observed, symbol/call/dataflow meaning is not parsed.' };
}
