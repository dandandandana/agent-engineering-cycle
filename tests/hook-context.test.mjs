import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import test, { after, before } from 'node:test';
import { packageProvider } from '../../codex-sol/scripts/package-provider.mjs';
import { sha256 } from '../src/core/contracts.mjs';
import { boundedHookResponse, HookSessionLedger, HOOK_CONTEXT_MAX_BYTES } from '../src/local/hook-context.mjs';
import { createRuntime } from '../src/runtime.mjs';

const cycleId = 'a5ea9d52-155d-45fd-a9f3-7b163a3d5ace';
const basisDigest = 'a'.repeat(64);
const evidenceId = `reuse-${'b'.repeat(64)}`;
const HOOK_GOAL = 'Exercise Hook routing against a real active cycle.';
const HOOK_SCOPE_PATH = 'src/hook-target.mjs';
let providerParent;
let providerManifest;

before(async () => {
  providerParent = await mkdtemp(join(tmpdir(), 'cycle-hook-provider-'));
  const bundle = await packageProvider({ out: join(providerParent, 'provider') });
  providerManifest = join(bundle, 'provider-manifest.json');
});

after(async () => {
  if (providerParent) await rm(providerParent, { recursive: true, force: true });
});

async function makeWorkspace(t) {
  const root = await mkdtemp(join(tmpdir(), 'cycle-hook-context-'));
  t.after(async () => rm(root, { recursive: true, force: true }));
  return root;
}

async function createHookRuntime(t, root) {
  const codexHome = await mkdtemp(join(tmpdir(), 'cycle-hook-home-'));
  t.after(async () => rm(codexHome, { recursive: true, force: true }));
  return createRuntime({
    workspaceRoot: root,
    env: { CODEX_HOME: codexHome },
    configurationOptions: { providerManifest },
  });
}

async function ensureCycleDirectory(root) {
  await mkdir(join(root, '.codex', 'engineering-cycle'), { recursive: true });
}

async function beginActiveCycle(runtime, root, { sessionId, requestId = 'hook-current-begin' } = {}) {
  const target = join(root, ...HOOK_SCOPE_PATH.split('/'));
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, 'export const hookTarget = true;\n', 'utf8');
  const scope = [HOOK_SCOPE_PATH];
  const grant = runtime.authority.issue({
    kind: 'action',
    workspace_id: runtime.store.workspaceId,
    goal_digest: sha256(HOOK_GOAL),
    mode: 'implement',
    paths: scope,
    actions: ['control', 'artifact', 'apply', 'verify', 'qa'],
    source: { adapter: 'interactive-operator', fixture: true },
  }, { operatorConfirmed: true });
  const result = await runtime.invoke('cycle_control', {
    action: 'begin', request_id: requestId, goal: HOOK_GOAL, grant_id: grant.id,
    scope, inputs: scope, acceptance_ids: ['HOOK-SCOPE'],
  }, sessionId ? { hostSessionId: sessionId } : undefined);
  assert.equal(result.ok, true, JSON.stringify(result.error ?? result.result));
  const current = runtime.store.current();
  assert.equal(current.id, result.binding.cycle_id);
  assert.equal(current.lifecycle, 'active');
  assert.deepEqual(current.scope, scope);
  return current;
}

function status(overrides = {}) {
  return {
    ok: true,
    binding: { cycle_id: cycleId, basis_digest: basisDigest, revision: 99 },
    stage: 'implementation',
    lifecycle: 'active',
    blockers: [{ code: 'REUSE_PLAN_REQUIRED', kind: 'reuse', reason: 'MUST NOT APPEAR IN HOOK' }],
    pending_operation: null,
    reuse: {
      status: 'missing',
      summary: { required_targets: 2, covered_targets: 1, decisions: 1, reads: 3, stale: 0, missing: 1 },
      evidence_refs: [{ id: evidenceId, digest: 'c'.repeat(64) }],
    },
    evidence_refs: [{ id: evidenceId, digest: 'c'.repeat(64) }],
    goal: 'PRIVATE GOAL MUST NOT APPEAR',
    next: ['PRIVATE REASON MUST NOT APPEAR'],
    implementation_notes: { summary: { required: 8 }, entries: [{ source: 'PRIVATE IMPLEMENTATION NOTE' }] },
    ...overrides,
  };
}

function contextFrom(output) {
  return JSON.parse(output.hookSpecificOutput.additionalContext);
}

test('idle hooks remain quiet and do not create workspace state', async t => {
  const root = await makeWorkspace(t);
  const runtime = await createHookRuntime(t, root);
  let coreCalls = 0;
  runtime.core.invoke = async () => { coreCalls += 1; throw new Error('idle Hook must not query cycle status'); };

  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'SessionStart', source: 'startup', cwd: root }), {});
  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'UserPromptSubmit', session_id: 'unjoined-idle-session', cwd: root }), {});
  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'Stop', session_id: 'unjoined-idle-session', cwd: root }), {});
  assert.equal(coreCalls, 0);
  assert.deepEqual(await readdir(root), []);
});

test('an unjoined session stays quiet while another session owns the real current cycle', async t => {
  const root = await makeWorkspace(t);
  const runtime = await createHookRuntime(t, root);
  const owner = 'cycle-owner-session';
  const current = await beginActiveCycle(runtime, root, { sessionId: owner });
  const ledger = new HookSessionLedger({ workspaceRoot: root });
  let statusCalls = 0;
  const invoke = runtime.core.invoke.bind(runtime.core);
  runtime.core.invoke = async (name, args, options) => {
    if (name === 'cycle_status') statusCalls += 1;
    return invoke(name, args, options);
  };

  const unjoined = 'unjoined-session';
  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'SessionStart', source: 'startup', session_id: unjoined, cwd: root }), {});
  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'UserPromptSubmit', session_id: unjoined, cwd: root }), {});
  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'UserPromptSubmit', session_id: unjoined, cwd: root }), {});
  assert.equal(statusCalls, 0);
  assert.equal(runtime.store.current().id, current.id);
  assert.equal(ledger.lookup(unjoined).cycle_id, null);
});

test('runtime binds only a successful non-duplicate settled begin or resume and preserves invoke options', async t => {
  const root = await makeWorkspace(t);
  await ensureCycleDirectory(root);
  const runtime = await createHookRuntime(t, root);
  const hostSessionId = 'host-session-bound-1';
  const options = { hostSessionId, signal: new AbortController().signal };
  let response = { ok: true, lifecycle: 'active', binding: { cycle_id: cycleId } };
  let operation = { request_id: 'req-1', tool: 'cycle_control', cycle_id: cycleId, phase: 'settled', effects_known: true };
  let expectedAction = 'begin';
  runtime.core.invoke = async (name, args, receivedOptions) => {
    assert.equal(name, 'cycle_control');
    assert.strictEqual(receivedOptions, options);
    assert.equal(args.action, expectedAction);
    return response;
  };
  runtime.store.operation = requestId => requestId === 'req-1' ? operation : null;

  const successful = await runtime.invoke('cycle_control', { action: 'begin', request_id: 'req-1' }, options);
  assert.strictEqual(successful, response);
  const ledgerFile = join(root, '.codex', 'engineering-cycle', 'hook-context-v1.json');
  const saved = await readFile(ledgerFile, 'utf8');
  assert.equal(saved.includes(hostSessionId), false);
  assert.equal(JSON.parse(saved).sessions[0].session_hash, sha256(hostSessionId));
  const ledger = new HookSessionLedger({ workspaceRoot: root });
  assert.equal(ledger.lookup(hostSessionId).cycle_id, cycleId);

  const otherCycle = '12345678-1234-1234-1234-123456789012';
  response = { ok: true, duplicate: true, lifecycle: 'active', binding: { cycle_id: otherCycle } };
  operation = { ...operation, cycle_id: otherCycle };
  await runtime.invoke('cycle_control', { action: 'begin', request_id: 'req-1' }, options);
  assert.equal(ledger.lookup(hostSessionId).cycle_id, cycleId);

  expectedAction = 'resume';
  response = { ok: true, lifecycle: 'active', binding: { cycle_id: otherCycle } };
  operation = { ...operation, phase: 'outcome_saved', cycle_id: otherCycle };
  await runtime.invoke('cycle_control', { action: 'resume', request_id: 'req-1' }, options);
  assert.equal(ledger.lookup(hostSessionId).cycle_id, cycleId);
});

test('session-start forces context; repeated prompts suppress three times then send a pointer', async t => {
  const root = await makeWorkspace(t);
  const runtime = await createHookRuntime(t, root);
  const session = 'session-hook-dedupe';
  const currentState = await beginActiveCycle(runtime, root, { sessionId: session });
  const currentCycleId = currentState.id;
  let statusResponse = status({ binding: { cycle_id: currentCycleId, basis_digest: basisDigest, revision: 99 } });
  let requestedCycle;
  let statusCalls = 0;
  const realInvoke = runtime.core.invoke.bind(runtime.core);
  runtime.core.invoke = async (name, args, options) => {
    if (name === 'cycle_status') {
      statusCalls += 1;
      requestedCycle = args.cycle_id;
      return statusResponse;
    }
    return realInvoke(name, args, options);
  };
  const event = { hook_event_name: 'SessionStart', source: 'resume', session_id: session, cwd: root };
  const started = await runtime.handleHook(event);
  const projected = contextFrom(started);
  assert.equal(requestedCycle, currentCycleId);
  assert.deepEqual(projected, {
    cycle: currentCycleId.slice(0, 8),
    stage: 'implementation',
    lifecycle: 'active',
    reuse: { status: 'missing', required_targets: 2, covered_targets: 1, decisions: 1, reads: 3, stale: 0, missing: 1 },
    implementation_notes: { required: 8 },
    blocker: 'REUSE_PLAN_REQUIRED',
    next: { tool: 'cycle_artifact', action: 'review-reuse-evidence', evidence_id: evidenceId },
  });
  const serialized = JSON.stringify(started);
  for (const privateValue of ['PRIVATE GOAL', 'PRIVATE REASON', 'PRIVATE IMPLEMENTATION NOTE', 'MUST NOT APPEAR', 'basis_digest', 'revision']) {
    assert.equal(serialized.includes(privateValue), false, privateValue);
  }
  assert.equal(serialized.includes('implementation_notes'), true);
  assert.ok(Buffer.byteLength(serialized, 'utf8') <= HOOK_CONTEXT_MAX_BYTES);

  const prompt = { hook_event_name: 'UserPromptSubmit', session_id: session, cwd: root };
  assert.deepEqual(await runtime.handleHook(prompt), {});
  assert.deepEqual(await runtime.handleHook(prompt), {});
  assert.deepEqual(await runtime.handleHook(prompt), {});
  const reminder = contextFrom(await runtime.handleHook(prompt));
  assert.deepEqual(reminder, { tool: 'cycle_status', action: 'inspect-current-cycle' });

  statusResponse = status({ stage: 'qa', binding: { cycle_id: currentCycleId, basis_digest: 'd'.repeat(64), revision: 100 } });
  const changed = contextFrom(await runtime.handleHook(prompt));
  assert.equal(changed.stage, 'qa');
  const resumed = contextFrom(await runtime.handleHook({ ...event, source: 'compact' }));
  assert.equal(resumed.stage, 'qa');

  const staleBinding = (await realInvoke('cycle_status', {})).binding;
  const abandoned = await runtime.invoke('cycle_control', {
    action: 'abandon', request_id: 'hook-abandon-old-cycle', binding: staleBinding, reason: 'Advance the current-cycle fixture.'
  });
  assert.equal(abandoned.ok, true, JSON.stringify(abandoned.error));
  const next = await beginActiveCycle(runtime, root, { requestId: 'hook-current-next-cycle' });
  assert.notEqual(next.id, currentCycleId);
  const beforeStaleRoute = statusCalls;
  assert.deepEqual(await runtime.handleHook(prompt), {});
  assert.equal(statusCalls, beforeStaleRoute, 'A stale session route must not query or summarize a different current cycle.');
});

test('Hook denies joined unknown targets and decoded scope intersections, but ignores other-session writes outside scope', async t => {
  const root = await makeWorkspace(t);
  const runtime = await createHookRuntime(t, root);
  const session = 'joined-write-session';
  const current = await beginActiveCycle(runtime, root, { sessionId: session });
  assert.deepEqual(current.scope, [HOOK_SCOPE_PATH]);
  let statusCalls = 0;
  const invoke = runtime.core.invoke.bind(runtime.core);
  runtime.core.invoke = async (name, args, options) => {
    if (name === 'cycle_status') statusCalls += 1;
    return invoke(name, args, options);
  };
  const denialReason = 'Use cycle_apply with the current binding; the backend rechecks scope and permission.';

  const unknownTarget = { hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: 'not a patch' }, cwd: root, session_id: session };
  const joinedUnknown = await runtime.handleHook(unknownTarget);
  assert.equal(joinedUnknown.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(joinedUnknown.hookSpecificOutput.permissionDecisionReason, denialReason);
  assert.deepEqual(await runtime.handleHook(unknownTarget), joinedUnknown);

  const decodedIntersection = await runtime.handleHook({
    hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, session_id: 'other-session',
    tool_input: { file_path: HOOK_SCOPE_PATH, content: 'outside-session write' },
  });
  assert.equal(decodedIntersection.hookSpecificOutput.permissionDecision, 'deny');

  assert.deepEqual(await runtime.handleHook({
    hook_event_name: 'PreToolUse', tool_name: 'Write', cwd: root, session_id: 'other-session',
    tool_input: { file_path: 'outside/unrelated.mjs', content: 'outside scope' },
  }), {});
  assert.deepEqual(await runtime.handleHook({
    hook_event_name: 'PreToolUse', tool_name: 'Read', cwd: root, session_id: session,
    tool_input: { file_path: HOOK_SCOPE_PATH },
  }), {});
  assert.deepEqual(await runtime.handleHook({ hook_event_name: 'Stop', cwd: root, session_id: session }), {});
  assert.equal(statusCalls, 0, 'PreToolUse Read and Stop must not query cycle status.');
  assert.ok(Buffer.byteLength(JSON.stringify(joinedUnknown), 'utf8') <= HOOK_CONTEXT_MAX_BYTES);
});

test('ledger bounds session count, stores hashes, and degrades on corrupt or contended writes', async t => {
  const root = await makeWorkspace(t);
  await ensureCycleDirectory(root);
  const ledger = new HookSessionLedger({ workspaceRoot: root });
  for (let index = 0; index < 65; index += 1) {
    assert.equal(ledger.bindHostSession(`session-${index}`, cycleId).ok, true);
  }
  const ledgerFile = join(root, '.codex', 'engineering-cycle', 'hook-context-v1.json');
  const parsed = JSON.parse(await readFile(ledgerFile, 'utf8'));
  assert.equal(parsed.sessions.length, 64);
  assert.equal(ledger.lookup('session-0').cycle_id, null);
  assert.equal(ledger.lookup('session-64').cycle_id, cycleId);
  assert.equal((await readFile(ledgerFile, 'utf8')).includes('session-64'), false);

  const lockFile = join(root, '.codex', 'engineering-cycle', 'hook-context-v1.lock');
  await writeFile(lockFile, JSON.stringify({ nonce: 'other-writer', pid: process.pid }));
  assert.deepEqual(ledger.bindHostSession('contended-session', cycleId), { ok: false, diagnostic: 'HOOK_LEDGER_BUSY' });
  await rm(lockFile);

  await writeFile(ledgerFile, '{broken');
  assert.equal(ledger.lookup('session-64').diagnostic, 'HOOK_LEDGER_CORRUPT');
  assert.deepEqual(ledger.bindHostSession('corrupt-session', cycleId), { ok: false, diagnostic: 'HOOK_LEDGER_CORRUPT' });
  assert.equal(await readFile(ledgerFile, 'utf8'), '{broken');
});

test('ledger refuses to create a missing cycle directory and reports unavailable writes', async t => {
  const root = await makeWorkspace(t);
  const ledger = new HookSessionLedger({ workspaceRoot: root });
  assert.deepEqual(ledger.bindHostSession('session-without-cycle', cycleId), { ok: false, diagnostic: 'HOOK_LEDGER_UNAVAILABLE' });
  assert.equal(ledger.lookup('session-without-cycle').cycle_id, null);
  assert.deepEqual(await readdir(root), []);
});

test('oversized Hook context falls back to a parseable bounded cycle-status pointer', () => {
  const output = boundedHookResponse('UserPromptSubmit', { arbitrary: 'x'.repeat(4096) });
  assert.deepEqual(contextFrom(output), {
    tool: 'cycle_status', action: 'inspect-current-cycle', diagnostic: 'HOOK_CONTEXT_BUDGET',
  });
  assert.ok(Buffer.byteLength(JSON.stringify(output), 'utf8') <= HOOK_CONTEXT_MAX_BYTES);
});
