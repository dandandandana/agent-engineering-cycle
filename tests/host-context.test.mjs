import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { realpathSync } from 'node:fs';
import { HostContextStore, hostContextFromMetadata, nativeWriteTargets } from '../src/local/host-context.mjs';
import { createWorkspaceRouter } from '../src/server.mjs';

async function fixture(t) {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cycle-host-address-'));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const home = path.join(parent, 'home'); const a = path.join(parent, 'a'); const b = path.join(parent, 'b');
  for (const p of [home, a, b]) await mkdir(p);
  return { home, a, b, env: { CODEX_HOME: home } };
}
const event = (root, session = randomUUID(), turn = randomUUID()) => ({ hook_event_name: 'UserPromptSubmit', session_id: session, turn_id: turn, cwd: root, model: 'gpt-6-luna' });

test('host addresses match only the current turn and never choose the latest project', async t => {
  const { a, b, env } = await fixture(t); const store = new HostContextStore({ env });
  const ea = event(a); const eb = event(b);
  await store.publish(ea); await store.publish(eb);
  const ca = { session_id: ea.session_id, turn_id: ea.turn_id }; const cb = { session_id: eb.session_id, turn_id: eb.turn_id };
  assert.equal(store.lookup(ca).root.toLowerCase(), realpathSync.native(a).toLowerCase());
  assert.equal(store.lookup(cb).root.toLowerCase(), realpathSync.native(b).toLowerCase());
  assert.throws(() => store.lookup({ ...ca, turn_id: randomUUID() }), { code: 'CONTEXT_REQUIRED' });
  const roots = [];
  const router = createWorkspaceRouter({ env, runtimeFactory: async ({ workspaceRoot }) => ({ store: { root: workspaceRoot }, invoke: async () => { roots.push(workspaceRoot); return { ok: true, status: 'unbound' }; } }) });
  await router.invoke('cycle_status', {}, { hostContext: ca }); await router.invoke('cycle_status', {}, { hostContext: cb });
  assert.equal(roots.length, 2); assert.notEqual(roots[0], roots[1]);
  assert.equal((await router.invoke('cycle_status', {})).status, 'context_required');
  await assert.rejects(router.invoke('cycle_control', { action: 'begin' }), { code: 'CONTEXT_REQUIRED' });
  assert.deepEqual(await readdir(a), []); assert.deepEqual(await readdir(b), []);
});
test('same parent session/turn with conflicting cwd is ambiguous and cannot be overwritten back', async t => {
  const { a, b, env } = await fixture(t); const store = new HostContextStore({ env }); const e = event(a);
  await store.publish(e); await store.publish({ ...e, cwd: b }); await store.publish(e);
  assert.throws(() => store.lookup({ session_id: e.session_id, turn_id: e.turn_id }), { code: 'WORKSPACE_CONFLICT' });
});
test('explicit workspace conflicts with reliable Hook context; missing context remains explicit legacy connection', async t => {
  const { a, b, env } = await fixture(t); const e = event(a); await new HostContextStore({ env }).publish(e);
  const router = createWorkspaceRouter({ workspaceRoot: b, env, runtimeFactory: async () => ({ invoke: async () => ({ ok: true }) }) });
  await assert.rejects(router.invoke('cycle_status', {}, { hostContext: { session_id: e.session_id, turn_id: e.turn_id } }), { code: 'WORKSPACE_CONFLICT' });
  assert.equal((await router.invoke('cycle_status', {})).project.source, 'explicit');
});
test('expired, corrupted, replaced-directory and foreign-CODEX_HOME addresses cannot route', async t => {
  const { a, b, home, env } = await fixture(t); let now = Date.now(); const store = new HostContextStore({ env, now: () => now }); const e = event(a);
  await store.publish(e); const c = { session_id: e.session_id, turn_id: e.turn_id };
  now += 25 * 60 * 60 * 1000; assert.throws(() => store.lookup(c), { code: 'CONTEXT_REQUIRED' });
  now = Date.now(); await store.publish(e);
  const recordPath = store.store.file(`records/${store.key(c)}.json`); await writeFile(recordPath, 'null');
  assert.throws(() => store.lookup(c), { code: 'CONTEXT_REQUIRED' });
  const other = path.join(home, 'other'); await mkdir(other);
  assert.throws(() => new HostContextStore({ env: { CODEX_HOME: other } }).lookup(c), { code: 'CONTEXT_REQUIRED' });
  assert.deepEqual(await readdir(b), []);
});
test('native write decoding includes move destinations and declines unknown command wrappers', () => {
  assert.deepEqual(nativeWriteTargets({ tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Update File: src/a.mjs\n*** Move to: src/b.mjs\n@@\n-old\n+new\n*** End Patch\n' } }), ['src/a.mjs', 'src/b.mjs']);
  assert.deepEqual(nativeWriteTargets({ tool_name: 'Write', tool_input: { file_path: 'outside.txt', content: 'x' } }), ['outside.txt']);
  assert.equal(nativeWriteTargets({ tool_name: 'apply_patch', tool_input: { command: 'echo before\n*** Begin Patch\n*** Delete File: a\n*** End Patch' } }), null);
  assert.equal(nativeWriteTargets({ tool_name: 'Edit', tool_input: { file_path: 'a', path: 'b' } }), null);
  assert.equal(hostContextFromMetadata({ 'x-codex-turn-metadata': { thread_id: 'latest', turn_id: 'latest' } }), null);
});
