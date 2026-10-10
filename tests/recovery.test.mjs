import assert from 'node:assert/strict';
import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { PATHS, simulateProtectedStoreQa, status, verifiedFixture } from './helpers.mjs';

const qaConfig = Object.freeze({
  executable: 'not-a-real-codex-fixture',
  model: 'never-run-fixture',
  timeout_ms: 1_000,
});

function countedChecks() {
  return [{
    id: 'fixed-check',
    argv: [process.execPath, '-e', "require('node:fs').appendFileSync('check-counter.log','x');process.stdout.write('fixed-check-passed')"],
    timeout_ms: 5_000,
  }];
}

async function completionRecords(runtime) {
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

async function finishArgs(runtime, requestId) {
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

async function finishableCycle(t, options = {}) {
  const context = await verifiedFixture(t, { checks: countedChecks(), ...options });
  const reportRef = await simulateProtectedStoreQa(context.runtime);
  return { ...context, reportRef };
}

async function completedCycle(t) {
  const context = await finishableCycle(t);
  const finished = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-successfully'));
  assert.equal(finished.ok, true);
  const completed = await status(context.runtime);
  assert.equal(completed.lifecycle, 'completed');
  assert.equal(completed.current_complete, true);
  return { ...context, completed, state: context.runtime.store.current() };
}

async function installUnknownQaOutcome(runtime) {
  const state = runtime.store.current();
  const config = runtime.core.config();
  const basis = await runtime.core.basis(state, config, { qa: true });
  const id = 'qa-unknown-fixture';
  runtime.store.write(`jobs/${id}.json`, {
    id,
    cycle_id: state.id,
    workspace_id: state.workspace_id,
    basis_digest: basis.digest,
    config_digest: config.digest,
    status: 'unknown',
    cancel_requested: false,
    driver: { simulated_fixture: true },
  }, { immutable: true });
  runtime.store.write(`jobs/${id}.outcome.json`, {
    job_id: id,
    status: 'unknown',
    passed: false,
    assurance: {},
    terminal_observed: false,
    launch_status: 'started',
    receipt: { simulated_fixture: true, terminal_observed: false, cleanup_error: null },
  }, { immutable: true });
  state.qa_job = id;
  runtime.store.write('current.json', state);
  return id;
}

async function corruptEvidence(runtime, id, mutatePayload) {
  const file = runtime.store.file(`evidence/${id}.json`);
  const record = JSON.parse(await readFile(file, 'utf8'));
  mutatePayload(record.payload);
  await writeFile(file, JSON.stringify(record), 'utf8');
}

test('unknown QA outcome remains non-terminal, blocks abandon and new start, and cancellation preserves uncertainty', async (t) => {
  const context = await verifiedFixture(t, { checks: countedChecks(), qa: qaConfig });
  // The private capability fixture exercises the program gate only. qaAction is stubbed below so no driver/model can launch.
  context.runtime.core.capabilities.qa_driver = true;
  const jobId = await installUnknownQaOutcome(context.runtime);

  const beforeAbandon = await status(context.runtime);
  const abandon = await context.runtime.invoke('cycle_control', {
    action: 'abandon',
    reason: 'Unknown QA is not quiescent.',
    request_id: 'abandon-with-unknown-qa',
    binding: beforeAbandon.binding,
  });
  assert.equal(abandon.ok, false);
  assert.equal(abandon.error.code, 'OPERATION_PENDING');
  assert.equal(context.runtime.store.operation('abandon-with-unknown-qa'), null);
  assert.equal(context.runtime.store.current().lifecycle, 'active');

  const beforeCancel = await status(context.runtime);
  const cancelled = await context.runtime.invoke('cycle_qa', {
    action: 'cancel',
    request_id: 'cancel-unknown-qa',
    binding: beforeCancel.binding,
  });
  assert.equal(cancelled.ok, false);
  assert.equal(cancelled.result.error.code, 'OUTCOME_UNKNOWN');
  assert.equal(cancelled.result.cancel_requested, true);
  assert.equal(cancelled.result.terminal_observed, false);
  const afterCancel = await status(context.runtime);
  assert.equal(afterCancel.qa.job_id, jobId);
  assert.equal(afterCancel.qa.status, 'unknown');
  assert.equal(afterCancel.qa.terminal_observed, false);
  assert.equal(afterCancel.qa.quiescent, false);
  assert.equal(context.runtime.store.read(`jobs/${jobId}.json`).cancel_requested, true);

  const jobFilesBeforeStart = (await readdir(path.join(context.runtime.store.directory, 'jobs'))).sort();
  let qaActionCalls = 0;
  context.runtime.core.qaAction = async () => {
    qaActionCalls += 1;
    return { status: 'unexpected launch', effects_known: true };
  };
  const start = await context.runtime.invoke('cycle_qa', {
    action: 'start',
    request_id: 'start-after-unknown-qa',
    binding: afterCancel.binding,
  });
  assert.equal(start.ok, false);
  assert.equal(start.error.code, 'OPERATION_PENDING');
  assert.equal(qaActionCalls, 0);
  assert.deepEqual((await readdir(path.join(context.runtime.store.directory, 'jobs'))).sort(), jobFilesBeforeStart);
  assert.equal(context.runtime.store.operation('start-after-unknown-qa'), null);
});

test('finish archive recovery settles the same completion without rerunning checks or replacing Q', async (t) => {
  let injected = false;
  const context = await finishableCycle(t, {
    faultInjector: async (point) => {
      if (point === 'before_finish_publish' && !injected) {
        injected = true;
        throw new Error('one-shot interruption after completion archive');
      }
    },
  });
  const beforeFinish = await status(context.runtime);
  const checkRef = context.runtime.store.current().checks.evidence.id;
  const qaJobId = beforeFinish.qa.job_id;
  const reportRefId = beforeFinish.qa.report_ref.id;
  const checkCounter = await readFile(path.join(context.root, 'check-counter.log'), 'utf8');
  const completionCountBefore = (await completionRecords(context.runtime)).length;

  const interrupted = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-cut-after-archive'));
  assert.equal(injected, true);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.error.code, 'IO_ERROR');
  assert.equal(interrupted.lifecycle, 'interrupted');
  assert.equal(interrupted.current_complete, false);

  const pendingFinish = context.runtime.store.operation('finish-cut-after-archive');
  assert.equal(pendingFinish.phase, 'unknown');
  assert.ok(pendingFinish.completion_expected_ref);
  const expectedCompletion = context.runtime.store.evidence(pendingFinish.completion_expected_ref.id);
  assert.equal(expectedCompletion.kind, 'completion');
  assert.equal((await completionRecords(context.runtime)).length, completionCountBefore + 1);

  const beforeResume = await status(context.runtime);
  const resumed = await context.runtime.invoke('cycle_control', {
    action: 'resume',
    request_id: 'resume-finish-cut',
    binding: beforeResume.binding,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.result.runner_replayed, false);
  assert.equal(resumed.lifecycle, 'completed');
  assert.equal(resumed.current_complete, true);
  assert.equal(context.runtime.store.current().completion_ref.id, pendingFinish.completion_expected_ref.id);
  assert.equal(context.runtime.store.operation('finish-cut-after-archive').phase, 'settled');
  assert.equal(context.runtime.store.operation('finish-cut-after-archive').result.completion_ref.id, pendingFinish.completion_expected_ref.id);
  assert.equal(context.runtime.store.current().checks.evidence.id, checkRef);
  assert.equal(resumed.qa.job_id, qaJobId);
  assert.equal(resumed.qa.report_ref.id, reportRefId);
  assert.equal(await readFile(path.join(context.root, 'check-counter.log'), 'utf8'), checkCounter);
  assert.equal((await completionRecords(context.runtime)).length, completionCountBefore + 1);
});

test('source drift at the finish archive cut keeps resume active with stale evidence', async (t) => {
  let root;
  let injected = false;
  const context = await finishableCycle(t, {
    faultInjector: async (point) => {
      if (point === 'before_finish_publish' && !injected) {
        injected = true;
        await writeFile(path.join(root, ...PATHS.subject.split('/')), 'export const value = "drift-at-archive-cut";\n', 'utf8');
      }
    },
  });
  root = context.root;
  const beforeFinish = await status(context.runtime);
  const checkRef = context.runtime.store.current().checks.evidence.id;
  const qaJobId = beforeFinish.qa.job_id;
  const reportRefId = beforeFinish.qa.report_ref.id;
  const checkCounter = await readFile(path.join(root, 'check-counter.log'), 'utf8');
  const completionCountBefore = (await completionRecords(context.runtime)).length;

  const interrupted = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-cut-with-source-drift'));
  assert.equal(injected, true);
  assert.equal(interrupted.ok, false);
  assert.equal(interrupted.error.code, 'BINDING_STALE');
  assert.equal(interrupted.lifecycle, 'interrupted');
  assert.equal(interrupted.current_complete, false);
  const pendingFinish = context.runtime.store.operation('finish-cut-with-source-drift');
  assert.ok(pendingFinish.completion_expected_ref);

  const beforeResume = await status(context.runtime);
  const resumed = await context.runtime.invoke('cycle_control', {
    action: 'resume',
    request_id: 'resume-stale-finish-candidate',
    binding: beforeResume.binding,
  });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.result.runner_replayed, false);
  assert.equal(resumed.lifecycle, 'active');
  assert.equal(resumed.current_complete, false);
  assert.equal(resumed.blockers.some((blocker) => blocker.kind === 'checks' || blocker.kind === 'independent_qa'), true);
  assert.equal(context.runtime.store.current().completion_ref, undefined);
  assert.equal(context.runtime.store.current().completion_candidate_stale.id, pendingFinish.completion_expected_ref.id);
  assert.equal(context.runtime.store.operation('finish-cut-with-source-drift').result.publication_current, false);
  assert.equal(context.runtime.store.current().checks.evidence.id, checkRef);
  assert.equal(resumed.qa.job_id, qaJobId);
  assert.equal(resumed.qa.report_ref.id, reportRefId);
  assert.equal(await readFile(path.join(root, 'check-counter.log'), 'utf8'), checkCounter);
  assert.equal((await completionRecords(context.runtime)).length, completionCountBefore + 1);
});

test('a deleted or tampered completion archive invalidates current completion but preserves history', async (t) => {
  await t.test('deleting the archive', async (t) => {
    const context = await completedCycle(t);
    const archivePath = context.runtime.store.file(`evidence/${context.state.completion_ref.id}.json`);
    await unlink(archivePath);

    const current = await status(context.runtime);
    assert.equal(current.lifecycle, 'completed');
    assert.equal(current.current_complete, false);
    assert.equal(current.blockers.some((blocker) => blocker.kind === 'completion'), true);
  });

  await t.test('tampering with the archived cycle identity', async (t) => {
    const context = await completedCycle(t);
    await corruptEvidence(context.runtime, context.state.completion_ref.id, (payload) => {
      payload.cycle_id = 'different-cycle';
    });

    const current = await status(context.runtime);
    assert.equal(current.lifecycle, 'completed');
    assert.equal(current.current_complete, false);
    assert.equal(current.blockers.some((blocker) => blocker.kind === 'completion'), true);
  });
});

test('damaged original check or verification evidence blocks finish', async (t) => {
  await t.test('a changed check-runner archive', async (t) => {
    const context = await finishableCycle(t);
    const verification = context.runtime.store.evidence(context.runtime.store.current().checks.evidence.id).payload;
    const rawRef = verification.results[0].raw_ref;
    await corruptEvidence(context.runtime, rawRef.id, (payload) => {
      payload.receipt.exit_code = 17;
    });
    const completionsBefore = (await completionRecords(context.runtime)).length;

    const result = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-with-damaged-check'));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EVIDENCE_INVALID');
    assert.equal(result.error.details.blockers.some((blocker) => blocker.kind === 'checks'), true);
    assert.equal((await status(context.runtime)).current_complete, false);
    assert.equal((await completionRecords(context.runtime)).length, completionsBefore);
  });

  await t.test('a changed verification archive', async (t) => {
    const context = await finishableCycle(t);
    const verificationRef = context.runtime.store.current().checks.evidence;
    await corruptEvidence(context.runtime, verificationRef.id, (payload) => {
      payload.passed = false;
    });
    const completionsBefore = (await completionRecords(context.runtime)).length;

    const result = await context.runtime.invoke('cycle_control', await finishArgs(context.runtime, 'finish-with-damaged-verification'));
    assert.equal(result.ok, false);
    assert.equal(result.error.code, 'EVIDENCE_INVALID');
    assert.equal(result.error.details.blockers.some((blocker) => blocker.kind === 'checks'), true);
    assert.equal((await status(context.runtime)).current_complete, false);
    assert.equal((await completionRecords(context.runtime)).length, completionsBefore);
  });
});
