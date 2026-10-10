import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { protocolObserved, notesRubric, runBlogTrials, collectNoteSources, prepareCycle, reuseComparisonDigest } from '../benchmarks/blog.mjs';
import { sha256 } from '../src/core/contracts.mjs';
import { discoveryAllows } from '../src/local/reuse-evidence.mjs';
import { patchEvidence } from '../benchmarks/hook-observer.mjs';

test('paired reuse comparison ignores run location and retains baseline/rule identity', () => {
  const first = { benchmark_id: 'v2', source_benchmark_id: 'v1', denominator: 25, eligible_opportunity_ids: ['one'], plan_sha256: 'plan', implementation_sha256: 'code', prepared_run: 'first',
    v1: { bundle_sha256: 'bundle', run_json_sha256: 'first-metadata', baseline: { sha256: 'baseline' }, input_files: { sha256: 'inputs' }, task_bytes_sha256: 'tasks' } };
  const second = { ...first, prepared_run: 'second', v1: { ...first.v1, run_json_sha256: 'second-metadata' } };
  assert.equal(reuseComparisonDigest(first), reuseComparisonDigest(second));
  assert.notEqual(reuseComparisonDigest(first), reuseComparisonDigest({ ...second, plan_sha256: 'changed-rule' }));
  assert.notEqual(reuseComparisonDigest(first), reuseComparisonDigest({ ...second, v1: { ...second.v1, baseline: { sha256: 'changed-input' } } }));
});

test('reuse-on blog fixtures require real discovery before source writes while the legacy fixture attaches D', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-blog-reuse-wiring-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const providerDir = path.join(root, 'provider'); await fs.mkdir(providerDir);
  // Metadata-only fixture: this does not substitute for a real MCP provider.
  const files = { 'entry.mjs': 'export {};\n', 'package-lock.json': '{}' };
  for (const [file, text] of Object.entries(files)) await fs.writeFile(path.join(providerDir, file), text);
  const manifest = path.join(providerDir, 'provider-manifest.json');
  const manifestText = JSON.stringify({ schema_revision: 1, protocol: 'sol-component-discovery/1', entry: 'entry.mjs', files: Object.entries(files).map(([file, text]) => ({ path: file, bytes: Buffer.byteLength(text), sha256: sha256(text) })) });
  await fs.writeFile(manifest, manifestText);
  const task = { id: 'B01', title: 'Fixture', entry: 'src/features.mjs', export_name: 'feature', allowed_paths: ['src/features.mjs','architecture.json','components.json'], reuse: [] };
  for (const mode of ['on','off']) {
    const workspace = path.join(root, mode); await fs.mkdir(path.join(workspace, 'src'), { recursive: true });
    await fs.writeFile(path.join(workspace, task.entry), 'export function feature() { return 1; }\n');
    for (const file of ['package.json','package-lock.json','components.json','architecture.json']) await fs.writeFile(path.join(workspace, file), '{}');
    await fs.mkdir(path.join(workspace, 'public'));
    await fs.writeFile(path.join(workspace, 'public/app.mjs'), 'export {};\n');
    await fs.writeFile(path.join(workspace, 'architecture.json'), JSON.stringify({ modules: [
      { source: [{ path: task.entry }] }, { source: [{ path: 'public/app.mjs' }] },
    ] }));
    const provider = { executable: process.execPath, args: [], manifest, manifest_sha256: sha256(manifestText), protocol: 'sol-component-discovery/1' };
    const prepared = await prepareCycle(task, workspace, 'Fixed task', mode === 'on' ? provider : undefined);
    const state = prepared.runtime.store.current();
    assert.equal(prepared.reuse_enabled, mode === 'on');
    assert.equal(Boolean(state.artifacts.D), mode === 'off');
    if (mode === 'on') {
      const config = JSON.parse(await fs.readFile(path.join(workspace, '.codex/engineering-cycle.json'), 'utf8'));
      assert.equal(discoveryAllows(config.component_reuse.discovery_scope, 'public/app.mjs'), true);
      assert.equal(state.scope.includes('public/app.mjs'), false, 'Discovery must not widen the product-write grant');
      const status = await prepared.runtime.invoke('cycle_status', {});
      const old = await fs.readFile(path.join(workspace, task.entry), 'utf8');
      const denied = await prepared.runtime.invoke('cycle_apply', { binding: status.binding, request_id: 'unprepared-source', targets: [{ path: task.entry, action: 'write', expected_sha256: sha256(old), content: 'changed' }] });
      assert.equal(denied.error.code, 'REUSE_PLAN_REQUIRED');
      assert.equal(prepared.runtime.store.operation('unprepared-source'), null);
      assert.equal(await fs.readFile(path.join(workspace, task.entry), 'utf8'), old);
    }
  }
});

test('invalid indexed source scope is rejected before a blog fixture or model can start', async t => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-blog-invalid-scope-'));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, 'architecture.json'), JSON.stringify({ modules: [{ source: [{ path: 'outside/source.mjs' }] }] }));
  await assert.rejects(prepareCycle({}, workspace, 'Fixed task', {}), /discovery scope excludes indexed sources: outside\/source\.mjs/);
  await assert.rejects(fs.access(path.join(workspace, '.codex')), { code: 'ENOENT' });
});

function protocol() {
  const workspace = process.cwd();
  const notesHash = 'a'.repeat(64);
  return {
    workspace, notesHash,
    current: { ok: true, implementation_notes: { status: 'current' }, blockers: [] },
    hooks: [
      { cwd: workspace, output: { hookSpecificOutput: { additionalContext: '{"binding":"actual"}' } } },
      { cwd: workspace, tool: 'apply_patch', patch_paths: ['src/features.mjs'], patch_comment_only: true, output: { hookSpecificOutput: { permissionDecision: 'deny' } } },
    ],
    calls: [
      { tool: 'cycle_status', success: true },
      { tool: 'cycle_artifact', success: true },
      { tool: 'cycle_verify', success: true },
      { tool: 'cycle_apply', success: true, value: { operation: { phase: 'settled' }, result: { effects_known: true,
        changed_paths: ['docs/cycle/notes.md'], effects: [{ path: 'docs/cycle/notes.md', after: { sha256: notesHash } }] } } },
    ],
  };
}

test('blog protocol requires real settled note bytes, current references and successful business calls', () => {
  const value = protocol();
  assert.equal(protocolObserved(value), true);
  value.calls.at(-1).value.result.effects[0].after.sha256 = 'b'.repeat(64);
  assert.equal(protocolObserved(value), false);
});

test('stale notes, failed checks and MCP business errors cannot pass protocol', () => {
  for (const change of [
    value => { value.current.implementation_notes.status = 'stale'; },
    value => { value.current.blockers = [{ kind: 'checks' }]; },
    value => { value.calls.find(call => call.tool === 'cycle_verify').success = false; },
    value => { value.calls.at(-1).value.operation.phase = 'pending'; },
    value => { value.calls.at(-1).value.result.effects_known = false; },
  ]) {
    const value = protocol(); change(value);
    assert.equal(protocolObserved(value), false);
  }
});

test('activation context alone does not substitute for a denied native write', () => {
  const value = protocol();
  value.hooks.pop();
  assert.equal(protocolObserved(value), false);
  value.hooks = protocol().hooks;
  value.hooks[0].cwd = process.cwd() + '-another-workspace';
  assert.equal(protocolObserved(value), false);
});

test('a denial from another workspace or target cannot satisfy the declared Hook probe', () => {
  for (const change of [
    value => { value.hooks[1].cwd += '-other'; },
    value => { value.hooks[1].patch_paths = ['README.md']; },
    value => { value.hooks[1].patch_paths = []; },
    value => { value.hooks[1].patch_paths = ['src/features.mjs', 'README.md']; },
    value => { value.hooks.push({ ...value.hooks[1] }); },
    value => { value.hooks[1].patch_comment_only = false; },
  ]) {
    const value = protocol(); change(value);
    assert.equal(protocolObserved(value), false);
  }
});

test('only comment additions qualify as harmless patch evidence', () => {
  const patch = body => ({ tool_name: 'apply_patch', tool_input: `*** Begin Patch\n*** Update File: src/features.mjs\n@@\n${body}\n*** End Patch` });
  assert.deepEqual(patchEvidence(patch('+// probe')), { patch_paths: ['src/features.mjs'], patch_comment_only: true });
  assert.deepEqual(patchEvidence({ tool_name: 'apply_patch', tool_input: { command: patch('+// probe').tool_input } }), { patch_paths: ['src/features.mjs'], patch_comment_only: true });
  assert.equal(patchEvidence({ tool_name: 'apply_patch', tool_input: { command: ['not a patch string'] } }).patch_comment_only, false);
  assert.equal(patchEvidence({ ...patch('+// probe'), tool_input: patch('+// probe').tool_input.replaceAll('\n', '\r\n') }).patch_comment_only, true);
  for (const body of ['+export const changed = true;', '-export {};\n+// probe', '+// probe\u2028changed()', '+// probe\rchanged()', ' export {};']) {
    assert.equal(patchEvidence(patch(body)).patch_comment_only, false);
  }
  for (const changed of ['*** Add File:', '*** Delete File:']) assert.equal(patchEvidence({ ...patch('+// probe'), tool_input: patch('+// probe').tool_input.replace('*** Update File:', changed) }).patch_comment_only, false);
  assert.equal(patchEvidence({ ...patch('+// probe'), tool_input: patch('+// probe').tool_input.replace('@@', '*** Move to: src/other.mjs\n@@') }).patch_comment_only, false);
});

test('notes judge receives validation and error helpers even when not in required reuse metadata', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-blog-sources-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.mkdir(path.join(directory, 'src/domain'), { recursive: true });
  const files = {
    'src/features.mjs': 'import { normalize } from "./domain/validation.mjs"; export const feature = normalize;',
    'src/domain/validation.mjs': 'import { error } from "./errors.mjs"; export function normalize(value) { if (!value) throw error(); return {...value}; }',
    'src/domain/errors.mjs': 'export const error = () => Object.assign(new Error("bad"), {code:"INVALID_INPUT",status:400});',
    'package.json': '{"type":"module"}',
    'components.json': '{"modules":[{"id":"features","exports":["feature"]}]}',
    'architecture.json': '{"schema_version":1,"modules":[]}',
  };
  for (const [relative, bytes] of Object.entries(files)) await fs.writeFile(path.join(directory, relative), bytes);
  assert.deepEqual(await collectNoteSources(directory), files);
});

test('each of the eight fixed blog tasks has four source-grounded note criteria', () => {
  const all = Array.from({ length: 8 }, (_, index) => notesRubric({ id: `B0${index + 1}`, export_name: 'publicFunction' })).flat();
  assert.equal(all.length, 32);
  assert.equal(new Set(all.map(value => value.id)).size, 32);
  assert.ok(all.every(value => value.critical && value.criterion.length > 60));
});

test('an unexpected trial failure waits for the other active scope before shared cleanup', async () => {
  const ctx = { rows: [], invocations: [] };
  const tasks = Array.from({ length: 8 }, (_, index) => ({ id: `B0${index + 1}` }));
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  let firstReady;
  const started = new Promise(resolve => { firstReady = resolve; });
  let secondFinished = false;
  let cohortFinished = false;
  const completion = runBlogTrials(ctx, tasks, 'isolated-run', async (isolated, task) => {
    isolated.invocations.push({ id: task.id });
    if (task.id === 'B01') { await started; throw new Error('evidence write failed'); }
    if (task.id === 'B02') { firstReady(); await gate; secondFinished = true; }
    return { id: task.id, status: 'model-completed' };
  }).then(result => { cohortFinished = true; return result; });
  await started;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(cohortFinished, false);
  assert.equal(secondFinished, false);
  release();
  assert.deepEqual(await completion, []);
  assert.equal(secondFinished, true);
  assert.equal(ctx.rows.length, 8);
  assert.equal(ctx.rows.find(row => row.id === 'B01').status, 'error');
  assert.equal(ctx.rows.find(row => row.id === 'B02').status, 'model-completed');
  assert.equal(ctx.rows.filter(row => row.status === 'not-run').length, 6);
  assert.deepEqual(ctx.invocations.map(value => value.id).sort(), ['B01', 'B02']);
});
