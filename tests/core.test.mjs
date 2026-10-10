import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { createRuntime } from '../src/runtime.mjs';
import { sha256 } from '../src/core/contracts.mjs';
import {
  INITIAL_FILES,
  PATHS,
  applyArgs,
  applyFile,
  attachArtifact,
  authorize,
  beginCycle,
  defaultChecks,
  fixture,
  issueRequirementDecision,
  simulateProtectedStoreQa,
  status,
  temporaryRoot,
  verifiedFixture,
  verifyFixed,
  writeConfig,
} from './helpers.mjs';

async function authorizedFixture(t, { mode = 'implement', faultInjector } = {}) {
  const context = await fixture(t, { faultInjector });
  const grant = await authorize(context.runtime, { mode });
  const begun = await beginCycle(context.runtime, { grantId: grant.id });
  assert.equal(begun.ok, true);
  return { ...context, grant, begun };
}

async function proposeDelta(runtime, deltaId) {
  const current = await status(runtime);
  const response = await runtime.invoke('cycle_reconcile', {
    action: 'propose',
    delta_id: deltaId,
    description: 'Update the approved authority text for the scoped change.',
    request_id: `propose-${deltaId}`,
    binding: current.binding,
  });
  assert.equal(response.ok, true);
  return response.result.delta;
}

async function plannedSync(t, deltaId) {
  const context = await authorizedFixture(t, { mode: 'docs' });
  await attachArtifact(context.runtime, 'R', PATHS.requirements);
  await attachArtifact(context.runtime, 'D', PATHS.design);
  const delta = await proposeDelta(context.runtime, deltaId);
  const decision = await issueRequirementDecision(context.runtime, delta);
  const beforePlan = await status(context.runtime);
  const targets = [
    {
      path: PATHS.requirements,
      action: 'write',
      expected_sha256: sha256(INITIAL_FILES[PATHS.requirements]),
      content: '# Requirements v2\nApproved authority update.\n',
    },
    {
      path: PATHS.design,
      action: 'write',
      expected_sha256: sha256(INITIAL_FILES[PATHS.design]),
      content: '# Design v2\nApproved authority update.\n',
    },
  ];
  const approval = await context.runtime.invoke('cycle_reconcile', {
    action: 'approve',
    delta_id: deltaId,
    decision_id: decision.id,
    request_id: `approve-${deltaId}`,
    binding: beforePlan.binding,
  });
  assert.equal(approval.result.delta.status, 'approved');
  const beforeSyncPlan = await status(context.runtime);
  const plan = await context.runtime.invoke('cycle_reconcile', {
    action: 'plan',
    delta_id: deltaId,
    targets,
    request_id: `plan-${deltaId}`,
    binding: beforeSyncPlan.binding,
  });
  assert.equal(plan.ok, true);
  assert.equal(plan.result.delta.status, 'sync_planned');
  return { ...context, delta, targets };
}

async function settle(runtime, deltaId, requestId) {
  const current = await status(runtime);
  return runtime.invoke('cycle_reconcile', {
    action: 'settle',
    delta_id: deltaId,
    request_id: requestId,
    binding: current.binding,
  });
}

async function finishArgs(runtime, requestId = 'finish-attempt') {
  const current = await status(runtime);
  return {
    action: 'finish',
    request_id: requestId,
    binding: current.binding,
    semantic_verdict: {
      original_goal_covered: true,
      unresolved_findings: [],
      evidence_refs: current.evidence_refs.map((reference) => reference.id),
    },
  };
}

async function completionEvidence(runtime) {
  const directory = path.join(runtime.store.directory, 'evidence');
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return []; throw error; }
  const records = [];
  for (const name of names.filter((entry) => entry.endsWith('.json'))) {
    const record = JSON.parse(await readFile(path.join(directory, name), 'utf8'));
    if (record.kind === 'completion') records.push(record);
  }
  return records;
}

test('strict status inspection leaves a fresh workspace without persistent store state', async (t) => {
  const root = await temporaryRoot(t, 'engineering-cycle-inspect-');
  const runtime = await createRuntime({ workspaceRoot: root });

  assert.equal(existsSync(path.join(root, '.codex')), false);
  const inspected = await status(runtime);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.status, 'unbound');
  assert.equal(inspected.configured, false);
  assert.equal(runtime.store.current(), null);
  assert.equal(existsSync(path.join(root, '.codex')), false);
});

test('begin refuses user-sourced and missing grants without persisting a cycle', async (t) => {
  await t.test('a user source cannot mint an accepted begin grant', async (t) => {
    const context = await fixture(t);
    const grant = await authorize(context.runtime, { sourceAdapter: 'user' });
    const begun = await beginCycle(context.runtime, { grantId: grant.id });

    assert.equal(begun.ok, false);
    assert.equal(begun.error.code, 'DECISION_UNVERIFIED');
    assert.equal(context.runtime.store.current(), null);
    assert.equal(existsSync(context.runtime.store.file('current.json')), false);
  });

  await t.test('begin without any grant leaves no current cycle record', async (t) => {
    const context = await fixture(t);
    const begun = await beginCycle(context.runtime);

    assert.equal(begun.ok, false);
    assert.equal(begun.error.code, 'DECISION_UNVERIFIED');
    assert.equal(context.runtime.store.current(), null);
    assert.equal(existsSync(context.runtime.store.file('current.json')), false);
  });
});

test('begin, R/D/I attach, managed write, and fixed verify form an active cycle, not completion', async (t) => {
  const context = await authorizedFixture(t);

  for (const [kind, relativePath] of [
    ['R', PATHS.requirements],
    ['D', PATHS.design],
    ['I', PATHS.implementation],
  ]) {
    const attached = await attachArtifact(context.runtime, kind, relativePath);
    assert.equal(attached.ok, true);
    assert.equal(attached.result.accepted, true);
    assert.equal(attached.result.semantic_verified, false);
    const intermediate = await status(context.runtime);
    assert.equal(intermediate.lifecycle, 'active');
    assert.equal(intermediate.current_complete, false);
  }

  const applied = await applyFile(context.runtime, PATHS.subject, 'export const value = "after";\n');
  assert.equal(applied.ok, true);
  assert.deepEqual(applied.result.changed_paths, [PATHS.subject]);
  assert.equal(await readFile(path.join(context.root, ...PATHS.subject.split('/')), 'utf8'), 'export const value = "after";\n');

  const verified = await verifyFixed(context.runtime);
  assert.equal(verified.ok, true);
  assert.equal(verified.result.passed, true);
  assert.equal(verified.result.results.length, defaultChecks().length);

  const final = await status(context.runtime);
  assert.equal(final.lifecycle, 'active');
  assert.equal(final.current_complete, false);
  assert.equal(final.blockers.some((blocker) => blocker.kind === 'independent_qa'), true);
});

test('the same request writes once, while changed parameters under that ID conflict', async (t) => {
  const context = await authorizedFixture(t);
  const args = await applyArgs(context.runtime, PATHS.subject, 'export const value = "once";\n', { requestId: 'write-once' });
  const first = await context.runtime.invoke('cycle_apply', args);
  assert.equal(first.ok, true);

  const file = path.join(context.root, ...PATHS.subject.split('/'));
  const afterFirstStat = await stat(file, { bigint: true });
  const afterFirstStatus = await status(context.runtime);
  const duplicate = await context.runtime.invoke('cycle_apply', args);
  const afterDuplicateStat = await stat(file, { bigint: true });

  assert.equal(duplicate.ok, true);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.binding.revision, afterFirstStatus.binding.revision);
  assert.equal(afterDuplicateStat.ino, afterFirstStat.ino);
  assert.equal(afterDuplicateStat.mtimeNs, afterFirstStat.mtimeNs);
  assert.equal(await readFile(file, 'utf8'), 'export const value = "once";\n');

  const conflict = await context.runtime.invoke('cycle_apply', {
    ...args,
    targets: [{ ...args.targets[0], content: 'export const value = "changed parameters";\n' }],
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'REQUEST_CONFLICT');
  assert.equal((await status(context.runtime)).binding.revision, afterFirstStatus.binding.revision);
  assert.equal(await readFile(file, 'utf8'), 'export const value = "once";\n');
});

test('write permission rejects docs-mode code, cross-scope, and stale-binding attempts without file effects', async (t) => {
  await t.test('docs permission cannot write a code file inside the declared scope', async (t) => {
    const context = await authorizedFixture(t, { mode: 'docs' });
    const result = await applyFile(context.runtime, PATHS.subject, 'export const value = "forbidden";\n');

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SCOPE_DENIED');
    assert.equal(await readFile(path.join(context.root, ...PATHS.subject.split('/')), 'utf8'), INITIAL_FILES[PATHS.subject]);
  });

  await t.test('a target outside both exact path scopes is not created', async (t) => {
    const context = await authorizedFixture(t);
    const result = await applyFile(context.runtime, PATHS.outside, 'must not exist\n');

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'SCOPE_DENIED');
    assert.equal(existsSync(path.join(context.root, ...PATHS.outside.split('/'))), false);
  });

  await t.test('a binding captured before an attach cannot write after the revision changes', async (t) => {
    const context = await authorizedFixture(t);
    const oldBinding = (await status(context.runtime)).binding;
    await attachArtifact(context.runtime, 'R', PATHS.requirements);
    const result = await context.runtime.invoke('cycle_apply', await applyArgs(
      context.runtime,
      PATHS.requirements,
      '# Requirements\nStale request must not land.\n',
      { requestId: 'stale-write', binding: oldBinding },
    ));

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BINDING_STALE');
    assert.equal(await readFile(path.join(context.root, ...PATHS.requirements.split('/')), 'utf8'), INITIAL_FILES[PATHS.requirements]);
  });
});

test('saved outcomes recover without replay after the file effect already happened', async (t) => {
  let fileEffectCount = 0;
  let injectOnce = true;
  const context = await authorizedFixture(t, {
    faultInjector: async (point, { op }) => {
      if (point === 'after_file_effect') fileEffectCount += 1;
      if (point === 'after_outcome' && op.tool === 'cycle_apply' && injectOnce) {
        injectOnce = false;
        throw new Error('one-shot failure after durable outcome');
      }
    },
  });
  const args = await applyArgs(context.runtime, PATHS.subject, 'export const value = "persisted";\n', { requestId: 'apply-with-saved-outcome' });
  const interrupted = await context.runtime.invoke('cycle_apply', args);
  assert.equal(interrupted.ok, false);
  assert.equal(fileEffectCount, 1);
  assert.equal(await readFile(path.join(context.root, ...PATHS.subject.split('/')), 'utf8'), 'export const value = "persisted";\n');

  const duplicate = await context.runtime.invoke('cycle_apply', args);
  assert.equal(duplicate.ok, false);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.operation.phase, 'outcome_saved');
  assert.equal(duplicate.error.code, 'OPERATION_PENDING');
  assert.equal(fileEffectCount, 1);

  const resumed = await context.runtime.invoke('cycle_control', {
    action: 'resume',
    request_id: 'resume-saved-outcome',
    binding: duplicate.binding,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.result.runner_replayed, false);
  assert.equal(resumed.lifecycle, 'active');
  assert.equal(context.runtime.store.operation('apply-with-saved-outcome').phase, 'settled');
  assert.equal(fileEffectCount, 1);
  assert.equal(await readFile(path.join(context.root, ...PATHS.subject.split('/')), 'utf8'), 'export const value = "persisted";\n');
});

test('a QA configuration change makes prior checks and Q non-current but retains their evidence', async (t) => {
  const context = await verifiedFixture(t);
  const reportRef = await simulateProtectedStoreQa(context.runtime);
  const before = await status(context.runtime);
  const state = context.runtime.store.current();
  const expectedBasis = (await context.runtime.core.basis(state, context.runtime.core.config(), { qa: true })).digest;
  const persistedJob = context.runtime.store.read(`jobs/${state.qa_job}.json`);
  assert.ok(before.qa.current, `simulated Q basis mismatch: ${JSON.stringify({ qa: before.qa, expectedBasis, jobBasis: persistedJob.basis_digest })}`);
  assert.equal(before.qa.passed, true);
  const oldVerification = before.evidence_refs.find((reference) => reference.kind === 'verification');
  assert.ok(oldVerification);
  assert.ok(before.evidence_refs.some((reference) => reference.id === reportRef.id));
  const subjectBefore = await readFile(path.join(context.root, ...PATHS.subject.split('/')));

  const configPath = path.join(context.root, '.codex', 'engineering-cycle.json');
  const config = JSON.parse(await readFile(configPath, 'utf8'));
  config.qa = { executable: 'fixture-only', model: 'never-run', timeout_ms: 1_000 };
  await writeConfig(context.root, config);

  const after = await status(context.runtime);
  assert.equal(after.qa.current, false);
  assert.equal(after.qa.passed, false);
  assert.equal(after.blockers.some((blocker) => blocker.kind === 'checks'), true);
  assert.equal(after.blockers.some((blocker) => blocker.kind === 'independent_qa'), true);
  assert.equal(after.evidence_refs.some((reference) => reference.id === oldVerification.id), true);
  assert.equal(after.evidence_refs.some((reference) => reference.id === reportRef.id), true);
  assert.deepEqual(await readFile(path.join(context.root, ...PATHS.subject.split('/'))), subjectBefore);
  // The Q above was written directly into the protected test store; no QA driver or real QA ran.
});

test('Delta approval requires a verified decision for this exact cycle and digest, without widening docs access', async (t) => {
  await t.test('a proposed Delta without a decision remains unapproved', async (t) => {
    const context = await authorizedFixture(t, { mode: 'docs' });
    const delta = await proposeDelta(context.runtime, 'delta-no-decision');
    const current = await status(context.runtime);
    const result = await context.runtime.invoke('cycle_reconcile', {
      action: 'approve',
      delta_id: delta.id,
      request_id: 'approve-without-decision',
      binding: current.binding,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DECISION_UNVERIFIED');
    assert.equal(context.runtime.store.current().deltas[delta.id].status, 'proposed');
    assert.notEqual(context.runtime.store.current().lifecycle, 'completed');
  });

  await t.test('a decision for another cycle cannot approve this Delta', async (t) => {
    const context = await authorizedFixture(t, { mode: 'docs' });
    const delta = await proposeDelta(context.runtime, 'delta-wrong-cycle');
    const decision = await issueRequirementDecision(context.runtime, delta, { cycleId: 'another-cycle' });
    const current = await status(context.runtime);
    const result = await context.runtime.invoke('cycle_reconcile', {
      action: 'approve',
      delta_id: delta.id,
      decision_id: decision.id,
      request_id: 'approve-wrong-cycle',
      binding: current.binding,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DECISION_UNVERIFIED');
    assert.equal(context.runtime.store.current().deltas[delta.id].status, 'proposed');
  });

  await t.test('a decision for a different Delta digest cannot approve this revision', async (t) => {
    const context = await authorizedFixture(t, { mode: 'docs' });
    const delta = await proposeDelta(context.runtime, 'delta-wrong-digest');
    const decision = await issueRequirementDecision(context.runtime, delta, { deltaDigest: '0'.repeat(64) });
    const current = await status(context.runtime);
    const result = await context.runtime.invoke('cycle_reconcile', {
      action: 'approve',
      delta_id: delta.id,
      decision_id: decision.id,
      request_id: 'approve-wrong-digest',
      binding: current.binding,
    });

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'DECISION_UNVERIFIED');
    assert.equal(context.runtime.store.current().deltas[delta.id].status, 'proposed');
  });

  await t.test('an exact requirement decision approves only the Delta and does not grant code writes', async (t) => {
    const context = await authorizedFixture(t, { mode: 'docs' });
    const delta = await proposeDelta(context.runtime, 'delta-exact');
    const decision = await issueRequirementDecision(context.runtime, delta);
    const current = await status(context.runtime);
    const approved = await context.runtime.invoke('cycle_reconcile', {
      action: 'approve',
      delta_id: delta.id,
      decision_id: decision.id,
      request_id: 'approve-exact-delta',
      binding: current.binding,
    });
    assert.equal(approved.ok, true);
    assert.equal(approved.result.delta.status, 'approved');

    const codeWrite = await applyFile(context.runtime, PATHS.subject, 'export const value = "still forbidden";\n');
    assert.equal(codeWrite.ok, false);
    assert.equal(codeWrite.error.code, 'SCOPE_DENIED');
    assert.equal(context.runtime.store.current().deltas[delta.id].status, 'approved');
    assert.equal(await readFile(path.join(context.root, ...PATHS.subject.split('/')), 'utf8'), INITIAL_FILES[PATHS.subject]);
  });
});

test('multi-file settle distinguishes before, after, and third states without overwriting external changes', async (t) => {
  const context = await plannedSync(t, 'delta-boundaries');

  const before = await settle(context.runtime, 'delta-boundaries', 'settle-all-before');
  assert.equal(before.ok, false);
  assert.equal(before.result.delta.status, 'partial');
  assert.deepEqual(before.result.observations.map((entry) => entry.state), ['before', 'before']);

  const first = context.targets[0];
  const applied = await applyFile(context.runtime, first.path, first.content);
  assert.equal(applied.ok, true);
  const mixed = await settle(context.runtime, 'delta-boundaries', 'settle-after-before');
  assert.equal(mixed.ok, false);
  assert.equal(mixed.result.delta.status, 'partial');
  assert.deepEqual(mixed.result.observations.map((entry) => entry.state), ['after', 'before']);

  const thirdState = '# Design\nAn external edit happened here.\n';
  await writeFile(path.join(context.root, ...PATHS.design.split('/')), thirdState, 'utf8');
  const conflict = await settle(context.runtime, 'delta-boundaries', 'settle-third-state');
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'AUTHORITY_CONFLICT');
  assert.equal(await readFile(path.join(context.root, ...PATHS.requirements.split('/')), 'utf8'), first.content);
  assert.equal(await readFile(path.join(context.root, ...PATHS.design.split('/')), 'utf8'), thirdState);
  assert.notEqual(context.runtime.store.current().lifecycle, 'completed');
});

test('incorporated authority sync records that implementation is still unverified', async (t) => {
  const context = await plannedSync(t, 'delta-incorporated');
  for (const target of context.targets) {
    const applied = await applyFile(context.runtime, target.path, target.content);
    assert.equal(applied.ok, true);
  }

  const settled = await settle(context.runtime, 'delta-incorporated', 'settle-incorporated');
  assert.equal(settled.ok, true);
  assert.equal(settled.result.delta.status, 'incorporated');
  const sync = context.runtime.store.evidence(settled.result.delta.sync_evidence.id);
  assert.equal(sync.payload.implemented, false);
  assert.equal(context.runtime.store.current().artifacts.I, undefined);
  assert.equal((await status(context.runtime)).current_complete, false);
});

test('finish needs independent QA and external source drift cannot publish a current completion', async (t) => {
  await t.test('fixed checks and R/D/I without Q cannot complete', async (t) => {
    const context = await verifiedFixture(t);
    const before = await status(context.runtime);
    assert.equal(before.qa, null);
    const completionsBefore = await completionEvidence(context.runtime);
    const result = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-without-qa'));

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EVIDENCE_INVALID');
    assert.equal(result.error.details.blockers.some((blocker) => blocker.kind === 'independent_qa'), true);
    assert.equal((await status(context.runtime)).current_complete, false);
    assert.equal((await completionEvidence(context.runtime)).length, completionsBefore.length);
  });

  await t.test('source drift before finish leaves no completion archive', async (t) => {
    const context = await verifiedFixture(t);
    await simulateProtectedStoreQa(context.runtime);
    const completionsBefore = await completionEvidence(context.runtime);
    await writeFile(path.join(context.root, ...PATHS.subject.split('/')), 'export const value = "external-before-finish";\n', 'utf8');
    const stale = await status(context.runtime);
    assert.equal(stale.current_complete, false);
    assert.equal(stale.blockers.some((blocker) => blocker.code === 'BINDING_STALE'), true);
    const result = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-after-pre-drift'));

    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EVIDENCE_INVALID');
    assert.equal((await status(context.runtime)).current_complete, false);
    assert.equal((await completionEvidence(context.runtime)).length, completionsBefore.length);
    assert.equal(await readFile(path.join(context.root, ...PATHS.subject.split('/')), 'utf8'), 'export const value = "external-before-finish";\n');
  });

  await t.test('source drift after completion archival still prevents publication as complete', async (t) => {
    let root;
    let injected = false;
    const context = await verifiedFixture(t, {
      faultInjector: async (point) => {
        if (point === 'before_finish_publish' && !injected) {
          injected = true;
          await writeFile(path.join(root, ...PATHS.subject.split('/')), 'export const value = "external-after-archive";\n', 'utf8');
        }
      },
    });
    root = context.root;
    await simulateProtectedStoreQa(context.runtime);
    const completionsBefore = await completionEvidence(context.runtime);
    const result = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-after-post-archive-drift'));

    assert.equal(injected, true);
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'BINDING_STALE');
    assert.equal((await status(context.runtime)).current_complete, false);
    assert.notEqual((await status(context.runtime)).lifecycle, 'completed');
    assert.equal((await completionEvidence(context.runtime)).length, completionsBefore.length + 1);
    assert.equal(await readFile(path.join(root, ...PATHS.subject.split('/')), 'utf8'), 'export const value = "external-after-archive";\n');
  });
});
