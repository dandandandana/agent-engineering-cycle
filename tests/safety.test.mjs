import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fixture, authorize, beginCycle, attachRDI, status, PATHS } from './helpers.mjs';
import { sourceDelivery, reportSchema, parseEvents, qaCapability, binaryIdentity, DRIVER_REVISION } from '../src/adapters/qa-cli.mjs';
import { digest } from '../src/core/contracts.mjs';

test('the capability gate recalls calibration evidence with numeric p0 kind names and rejects tampering', async t => {
  const { runtime } = await fixture(t);
  const { store, authority } = runtime;
  // Program-contract fixture only: this does not assert that Node is a calibrated Codex driver.
  const liveRef = store.archive('p0-live-qa', { simulated_probe: true, passed: true });
  const sandboxRef = store.archive('p0-sandbox', { simulated_probe: true, denied: true });
  const payload = {
    platform: process.platform, driver_revision: DRIVER_REVISION,
    binary_digest: binaryIdentity(process.execPath), model: 'fixture-model',
    sandbox_probe: { denied: true, raw_ref: sandboxRef },
    live_probe: { passed: true, raw_ref: liveRef }, assurance: {},
  };
  authority.key({ create: true });
  store.write('qa-capability.json', { payload, signature: authority.mac(payload) });
  const config = { qa: { executable: process.execPath, model: 'fixture-model', capability_receipt: digest(payload) } };
  assert.equal(qaCapability(store, authority, config).available, true);
  assert.equal(qaCapability(store, authority, { qa: { ...config.qa, windows_sandbox: 'unelevated' } }).available, false);
  const explicitSandbox = { ...payload, windows_sandbox: 'unelevated' };
  store.write('qa-capability.json', { payload: explicitSandbox, signature: authority.mac(explicitSandbox) });
  const explicitConfig = { qa: { ...config.qa, windows_sandbox: 'unelevated', capability_receipt: digest(explicitSandbox) } };
  assert.equal(qaCapability(store, authority, explicitConfig).available, true);
  assert.equal(qaCapability(store, authority, { qa: { ...explicitConfig.qa, windows_sandbox: 'elevated' } }).available, false);
  store.write('qa-capability.json', { payload, signature: authority.mac(payload) });
  assert.deepEqual(store.evidence(liveRef.id).payload, { simulated_probe: true, passed: true });
  const record = store.evidence(sandboxRef.id);
  await writeFile(store.file(`evidence/${sandboxRef.id}.json`), JSON.stringify({ ...record, payload: { denied: false } }), 'utf8');
  assert.equal(qaCapability(store, authority, config).available, false);
  assert.throws(() => store.archive('../p0', {}), e => e.code === 'EVIDENCE_INVALID');
  assert.throws(() => store.evidence(`../p0-${'0'.repeat(64)}`), e => e.code === 'EVIDENCE_INVALID');
});

test('docs grants cannot launch a configured command which would overwrite code', async t => {
  const context = await fixture(t, { checks: [{ id: 'dangerous-for-docs', argv: [process.execPath, '-e', "require('node:fs').writeFileSync('src/subject.mjs','UNAUTHORIZED')"] }] });
  const grant = await authorize(context.runtime, { mode: 'docs' }); await beginCycle(context.runtime, { grantId: grant.id }); await attachRDI(context.runtime);
  const before = await readFile(path.join(context.root, PATHS.subject));
  const result = await context.runtime.invoke('cycle_verify', { binding: (await status(context.runtime)).binding, request_id: 'docs-command', check_ids: ['dangerous-for-docs'] });
  assert.equal(result.ok, false); assert.equal(result.error.code, 'SCOPE_DENIED');
  assert.deepEqual(await readFile(path.join(context.root, PATHS.subject)), before);
  assert.equal(context.runtime.store.operation('docs-command'), null);
});

test('builtin docs integrity records readonly observations without pretending to launch a check process', async t => {
  const context = await fixture(t, { checks: [{ id: 'doc-source', kind: 'source-integrity' }] });
  const grant = await authorize(context.runtime, { mode: 'docs' }); await beginCycle(context.runtime, { grantId: grant.id }); await attachRDI(context.runtime);
  const result = await context.runtime.invoke('cycle_verify', { binding: (await status(context.runtime)).binding, request_id: 'docs-integrity', check_ids: ['doc-source'] });
  assert.equal(result.ok, true, JSON.stringify(result.error));
  assert.equal(result.result.results[0].execution_kind, 'source-integrity');
  assert.equal(result.result.results[0].launch_status, 'not_started');
  assert.equal(result.result.results[0].exit_code, null);
  assert.equal((await status(context.runtime)).current_complete, false);
});

const hash = '1'.repeat(64);
const manifest = { digest: '2'.repeat(64), entries: [{ path: 'subject.mjs', sha256: hash, size: 10 }] };
const event = (tool, args, value) => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'cycle_frozen_sources', tool, arguments: args, result: { structured_content: value } } });
const list = event('qa_source_list', {}, { ok: true, manifest });
const page = (offset, content, next) => event('qa_source_read', { path: 'subject.mjs', offset }, { ok: true, path: 'subject.mjs', sha256: hash, content, next_offset: next });

test('a model verdict and stdin delivery cannot replace actual frozen-source reads', () => {
  assert.equal(sourceDelivery([list], manifest).complete, false);
  assert.equal(sourceDelivery([list, page(5, 'last', null)], manifest).complete, false);
  assert.equal(sourceDelivery([list, page(0, 'first', 5)], manifest).complete, false);
  assert.equal(sourceDelivery([list, page(5, 'last', null), page(0, 'first', 5)], manifest).complete, true);
  const wrong = page(0, 'data', null); wrong.item.result.structured_content.sha256 = '3'.repeat(64);
  assert.equal(sourceDelivery([list, wrong], manifest).complete, false);
});

test('CLI reports cannot self-certify assurance, and missing terminal events remain missing', () => {
  assert.equal(reportSchema.safeParse({ verdict: 'pass', acceptance: [], findings: [], coverage_limits: [], fresh_session: true }).success, false);
  const parsed = parseEvents('{"type":"thread.started","thread_id":"new-thread"}\n');
  assert.equal(parsed.thread_id, 'new-thread'); assert.equal(parsed.terminal, null); assert.equal(parsed.report, null);
});
