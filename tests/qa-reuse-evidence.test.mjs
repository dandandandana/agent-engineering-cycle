import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { LocalStore } from '../src/local/store.mjs';
import { reuseQaContext, publicQaContext, verifyQaEvidence, assertQaDeliveryBudget } from '../src/local/qa-evidence.mjs';
import { sourceDelivery } from '../src/adapters/qa-cli.mjs';

test('large frozen evidence is rejected before CLI launch instead of inevitable capture truncation', () => {
  assert.doesNotThrow(() => assertQaDeliveryBudget({ entries: [{size:100}] }, { original_goal: 'Small QA' }));
  assert.throws(() => assertQaDeliveryBudget({ entries: [] }, { component_reuse: { evidence_refs: [{ size: 2 * 1024 * 1024 }] } }), e => e.code === 'SNAPSHOT_INCOMPLETE' && e.details.effects_known === true);
  assert.throws(() => assertQaDeliveryBudget({ entries: [{path:'absent',missing:true},{size:100000}] }), e => e.code === 'SNAPSHOT_INCOMPLETE');
  assert.doesNotThrow(() => assertQaDeliveryBudget({ entries: [{path:'absent',missing:true}] }));
  assert.throws(() => assertQaDeliveryBudget({ entries: [{}] }), e => e.code === 'EVIDENCE_INVALID');
});

test('QA lists bounded reuse references and requires all original bytes, rejecting archive drift', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-qa-reuse-'));
  const input = path.join(root, 'input'); await fs.mkdir(input);
  const store = new LocalStore(root);
  const before = 'export const shared = "中文🌌";\n'.repeat(1200);
  const ref = store.archive('reuse-source', { raw_text: before, source_capture_complete: true });
  const reuse = { projection: { digest: 'a'.repeat(64), decisions: [] }, evidence_refs: [ref] };
  const component_reuse = reuseQaContext(store, reuse, { reuse_cursor: {} });
  const qa_context = { original_goal: 'Check component reuse', component_reuse };
  assert.equal(publicQaContext(qa_context).component_reuse.archive_workspace, undefined);
  assert.equal(JSON.stringify(publicQaContext(qa_context)).includes(before), false);
  assert.equal(verifyQaEvidence(qa_context), true);
  const manifest = { digest: 'b'.repeat(64), entries: [] };
  const snapshotFile = path.join(root, 'snapshot.json');
  await fs.writeFile(snapshotFile, JSON.stringify({ input_dir: input, manifest, qa_context }));
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('../src/adapters/qa-sources.mjs', import.meta.url)), snapshotFile] });
  const client = new Client({ name: 'reuse-qa-test', version: '1' });
  t.after(async () => { await client.close(); await fs.rm(root, { recursive: true, force: true }); });
  await client.connect(transport);
  const events = [];
  const call = async (tool, args) => {
    const result = await client.callTool({ name: tool, arguments: args });
    const value = result.structuredContent ?? JSON.parse(result.content[0].text);
    events.push({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cycle_frozen_sources', tool, arguments: args, result: { structured_content: value } } });
    return value;
  };
  const listed = await call('qa_source_list', {});
  assert.equal(listed.ok, true);
  assert.ok(Buffer.byteLength(JSON.stringify(listed)) < 2048);
  assert.equal(sourceDelivery(events, manifest, qa_context).complete, false);
  const entry = component_reuse.evidence_refs[0]; let offset = 0; let text = '';
  do {
    const page = await call('qa_source_read', { path: entry.path, offset, limit: 8192 });
    assert.equal(page.ok, true); text += page.content; offset = page.next_offset;
    if (offset !== null) assert.equal(sourceDelivery(events, manifest, qa_context).complete, false);
  } while (offset !== null);
  assert.equal(JSON.parse(text).payload.raw_text, before);
  assert.equal(sourceDelivery(events, manifest, qa_context).complete, true);
  assert.equal(sourceDelivery(events.filter(e => e.item.tool !== 'qa_source_list'), manifest, qa_context).complete, false);
  const absentIndex = events.map(e => e.item.tool === 'qa_source_list' ? { ...e, item: { ...e.item, result: { structured_content: { ok: true, manifest } } } } : e);
  assert.equal(sourceDelivery(absentIndex, manifest, qa_context).complete, false);
  const outside = await call('qa_source_read', { path: 'reuse-evidence:unlisted', offset: 0 });
  assert.equal(outside.error.code, 'SCOPE_DENIED');
  await fs.writeFile(store.file(`evidence/${ref.id}.json`), JSON.stringify({ ...store.evidence(ref.id), payload: { raw_text: 'changed' } }));
  assert.throws(() => verifyQaEvidence(qa_context), e => e.code === 'EVIDENCE_INVALID');
  assert.equal((await call('qa_source_read', { path: entry.path })).ok, false);
});
