import assert from 'node:assert/strict';
import { link, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { implementationPaths, inspectImplementationNotes } from '../src/local/implementation-notes.mjs';
import {
  ACTIONS,
  EXACT_PATHS,
  GOAL,
  INITIAL_FILES,
  PATHS,
  authorize,
  fixture,
  simulateProtectedStoreQa,
  status,
  verifyFixed,
} from './helpers.mjs';

const SOURCE = PATHS.subject;
const DOC = 'docs/compute-flow.md';
const RELATED = 'src/scaler.mjs';
const LINKED = 'linked/source.mjs';
const REF_HASH = '0'.repeat(64);

const baseFiles = Object.freeze({
  ...INITIAL_FILES,
  [SOURCE]: 'export function compute(value, factor) {\n  return scale(value, factor);\n}\n',
  [DOC]: '# Parameter flow\n`compute(value, factor)` receives the caller value and factor.\nIt forwards both arguments to `scale(value, factor)`.\nThe helper result becomes the returned value.\n',
  [RELATED]: 'export function scale(value, factor) { return value * factor; }\n',
});

function ref(pathValue, hash = REF_HASH) {
  return { path: pathValue, sha256: hash };
}

async function currentRef(runtime, pathValue) {
  const { sha256: hash } = await runtime.workspace.readSource(pathValue);
  return ref(pathValue, hash);
}

async function currentNote(runtime, {
  sourcePath = SOURCE,
  symbol = 'compute',
  documentationPath = DOC,
  startLine = 2,
  endLine = 4,
  relatedPaths = [RELATED],
} = {}) {
  const source = { ...await currentRef(runtime, sourcePath), symbol };
  const documentation = { ...await currentRef(runtime, documentationPath), start_line: startLine, end_line: endLine };
  const related_sources = await Promise.all(relatedPaths.map(p => currentRef(runtime, p)));
  return { source, documentation, related_sources };
}

function codeIs(code) {
  return error => error?.code === code;
}

async function attachArtifact(runtime, kind, artifactPath, notes, requestId) {
  const input = { action: 'prepare', kind, paths: [artifactPath] };
  if (notes !== undefined) input.implementation_notes = notes;
  const prepared = await runtime.invoke('cycle_artifact', input);
  assert.equal(prepared.ok, true, JSON.stringify(prepared.error));
  const attach = {
    action: 'attach', kind, paths: [artifactPath],
    binding: prepared.binding,
    prepared_handle: prepared.prepared_handle,
    request_id: requestId,
  };
  if (notes !== undefined) attach.implementation_notes = notes;
  const result = await runtime.invoke('cycle_artifact', attach);
  assert.equal(result.ok, true, JSON.stringify(result.error));
  return { prepared, result };
}

async function targetCycle(t, {
  qa = undefined,
  deferCleanup = false,
  requestedScope,
  requestedInputs,
  beforeBegin,
} = {}) {
  const defaults = [...new Set([...EXACT_PATHS, DOC, RELATED])];
  const scope = [...(requestedScope ?? defaults)];
  const inputs = [...(requestedInputs ?? defaults)];
  const allowed = [...new Set([...scope, ...inputs])];
  let cleanupFixture;
  const fixtureContext = deferCleanup ? { after: callback => { cleanupFixture = callback; } } : t;
  const context = await fixture(fixtureContext, { files: baseFiles, ...(qa ? { qa } : {}) });
  await beforeBegin?.(context);
  const grant = await authorize(context.runtime, { goal: GOAL, mode: 'implement', paths: allowed, actions: ACTIONS });
  const begun = await context.runtime.invoke('cycle_control', {
    action: 'begin',
    request_id: 'begin-implementation-notes',
    goal: GOAL,
    grant_id: grant.id,
    scope,
    inputs,
    acceptance_ids: ['AC-03', 'AC-04', 'AC-06'],
    implementation_targets: [{ path: SOURCE, symbol: 'compute' }],
  });
  assert.equal(begun.ok, true, JSON.stringify(begun.error));
  return { ...context, grant, allowed, scope, inputs, ...(deferCleanup ? { cleanupFixture } : {}) };
}

async function attachAuthorityWithoutNotes(runtime) {
  await attachArtifact(runtime, 'R', PATHS.requirements, undefined, 'attach-notes-test-R');
  await attachArtifact(runtime, 'D', PATHS.design, undefined, 'attach-notes-test-D');
  await attachArtifact(runtime, 'I', PATHS.implementation, undefined, 'attach-notes-test-I');
}

async function evidenceCount(runtime) {
  const directory = path.join(runtime.store.directory, 'evidence');
  let names;
  try { names = await readdir(directory); }
  catch (error) { if (error?.code === 'ENOENT') return 0; throw error; }
  return names.filter(name => name.endsWith('.json')).length;
}

function qaWorkerExited(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if (error?.code === 'ESRCH') return true;
    if (error?.code === 'EPERM') return false;
    throw error;
  }
}

async function waitForQaOutcomeAndWorkerExit(runtime, requestId, jobId, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let outcome = null;
  let operation = null;
  while (Date.now() < deadline) {
    operation = runtime.store.operation(requestId);
    outcome = runtime.store.read(`jobs/${jobId}.outcome.json`, true);
    const pid = operation?.launch?.pid;
    if (outcome && Number.isInteger(pid) && qaWorkerExited(pid)) return { outcome, operation, pid };
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`QA worker did not finish with a saved outcome within ${timeoutMs} ms (pid=${operation?.launch?.pid ?? 'unknown'}, outcome=${outcome?.status ?? 'missing'}).`);
}

test('implementation note returns its selected prose and source identities without claiming semantic verification', async t => {
  const { runtime } = await fixture(t, { files: baseFiles });
  const note = await currentNote(runtime);

  assert.deepEqual(implementationPaths([note]), [SOURCE, DOC, RELATED]);
  const inspection = await inspectImplementationNotes(runtime.workspace, {
    notes: [note],
    targets: [{ path: SOURCE, symbol: 'compute' }],
    allowedPaths: [...EXACT_PATHS, DOC, RELATED],
  });

  assert.equal(inspection.status, 'current');
  assert.deepEqual(inspection.summary, { required: 1, attached: 1, current: 1, stale: 0, missing: 0, invalid: 0 });
  assert.equal(inspection.entries[0].status, 'current');
  assert.equal(inspection.entries[0].content, [
    '`compute(value, factor)` receives the caller value and factor.',
    'It forwards both arguments to `scale(value, factor)`.',
    'The helper result becomes the returned value.',
  ].join('\n'));
  assert.deepEqual(inspection.entries[0].inputs.map(input => input.path), [SOURCE, DOC, RELATED]);
  assert.ok(inspection.entries[0].inputs.every(input => input.expected_sha256 === input.actual_sha256));
  assert.equal(inspection.entries[0].symbol_verified, false);
  assert.equal(inspection.entries[0].semantic_verified, false);
  assert.equal(inspection.semantic_verified, false);
  assert.match(inspection.coverage, /symbol\/call\/dataflow meaning is not parsed/u);
});

test('changing the source, selected prose, or a related source makes its note stale', async t => {
  const { runtime, root } = await fixture(t, { files: baseFiles });
  const note = await currentNote(runtime);
  const original = new Map([[SOURCE, baseFiles[SOURCE]], [DOC, baseFiles[DOC]], [RELATED, baseFiles[RELATED]]]);

  for (const changedPath of [SOURCE, DOC, RELATED]) {
    await t.test(changedPath, async () => {
      await writeFile(path.join(root, ...changedPath.split('/')), `${original.get(changedPath)}// changed\n`, 'utf8');
      const inspection = await inspectImplementationNotes(runtime.workspace, {
        notes: [note], targets: [{ path: SOURCE, symbol: 'compute' }],
        allowedPaths: [...EXACT_PATHS, DOC, RELATED],
      });
      assert.equal(inspection.status, 'needs-update');
      assert.equal(inspection.entries[0].status, 'stale');
      assert.deepEqual(inspection.entries[0].inputs.filter(input => input.expected_sha256 !== input.actual_sha256).map(input => input.path), [changedPath]);
      await writeFile(path.join(root, ...changedPath.split('/')), original.get(changedPath), 'utf8');
    });
  }
});

test('missing files and out-of-bounds documentation ranges are distinguished', async t => {
  const { runtime } = await fixture(t, { files: baseFiles });
  const source = await currentRef(runtime, SOURCE);
  const missingPath = 'docs/missing-mechanism.md';
  const missing = {
    source: { ...source, symbol: 'compute' },
    documentation: { ...ref(missingPath), start_line: 1, end_line: 1 },
    related_sources: [],
  };
  const missingResult = await inspectImplementationNotes(runtime.workspace, {
    notes: [missing], targets: [{ path: SOURCE, symbol: 'compute' }],
    allowedPaths: [...EXACT_PATHS, missingPath],
  });
  assert.equal(missingResult.entries[0].status, 'missing');
  assert.equal(missingResult.entries[0].content, null);
  assert.equal(missingResult.summary.missing, 1);

  const doc = await currentRef(runtime, DOC);
  const outOfBounds = {
    source: { ...source, symbol: 'compute' },
    documentation: { ...doc, start_line: 6, end_line: 6 },
    related_sources: [],
  };
  const invalidResult = await inspectImplementationNotes(runtime.workspace, {
    notes: [outOfBounds], targets: [{ path: SOURCE, symbol: 'compute' }],
    allowedPaths: [...EXACT_PATHS, DOC],
  });
  assert.equal(invalidResult.entries[0].status, 'invalid');
  assert.equal(invalidResult.entries[0].content, null);
  assert.equal(invalidResult.summary.invalid, 1);
  await assert.rejects(inspectImplementationNotes(runtime.workspace, {
    notes: [{ ...outOfBounds, documentation: { ...outOfBounds.documentation, start_line: 1, end_line: 129 } }],
    targets: [{ path: SOURCE, symbol: 'compute' }], allowedPaths: [...EXACT_PATHS, DOC],
  }), codeIs('EVIDENCE_INVALID'));
});

test('implementation notes inherit Workspace traversal, secret, and symlink protections', async t => {
  const { runtime, root } = await fixture(t, { files: baseFiles });
  const source = await currentRef(runtime, SOURCE);
  const doc = await currentRef(runtime, DOC);
  const makePathNote = pathValue => ({
    source: { ...source, symbol: 'compute' },
    documentation: { ...doc, start_line: 2, end_line: 2 },
    related_sources: [ref(pathValue)],
  });

  await assert.rejects(inspectImplementationNotes(runtime.workspace, {
    notes: [makePathNote('../outside.md')], targets: [], allowedPaths: [SOURCE, DOC, '../outside.md'],
  }), codeIs('SCOPE_DENIED'));
  await assert.rejects(inspectImplementationNotes(runtime.workspace, {
    notes: [makePathNote('.env.local')], targets: [], allowedPaths: [SOURCE, DOC, '.env.local'],
  }), codeIs('SCOPE_DENIED'));

  const linkedDirectory = path.join(root, 'linked-target');
  await mkdir(linkedDirectory, { recursive: true });
  await writeFile(path.join(linkedDirectory, 'source.mjs'), 'export const privateValue = true;\n', 'utf8');
  try {
    await symlink(linkedDirectory, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip(`symlink creation is unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(inspectImplementationNotes(runtime.workspace, {
    notes: [makePathNote(LINKED)], targets: [], allowedPaths: [SOURCE, DOC, LINKED],
  }), codeIs('SCOPE_DENIED'));
});

test('note paths and captured prose stay within their aggregate limits', async t => {
  const { runtime } = await fixture(t, { files: {} });
  const manyNotes = Array.from({ length: 7 }, (_, index) => {
    const stem = `src/limit-${index}`;
    return {
      source: { ...ref(`${stem}.mjs`), symbol: `symbol-${index}` },
      documentation: { ...ref(`docs/limit-${index}.md`), start_line: 1, end_line: 1 },
      related_sources: Array.from({ length: 8 }, (__, related) => ref(`src/limit-${index}-related-${related}.mjs`)),
    };
  });
  const tooManyPaths = implementationPaths(manyNotes);
  assert.equal(tooManyPaths.length, 70);
  await assert.rejects(inspectImplementationNotes(runtime.workspace, {
    notes: manyNotes, allowedPaths: tooManyPaths,
  }), codeIs('EVIDENCE_INVALID'));

  const largeFiles = {
    'src/large-one.mjs': 'export const one = true;\n',
    'src/large-two.mjs': 'export const two = true;\n',
    'docs/large-one.md': 'x'.repeat(5_000),
    'docs/large-two.md': 'y'.repeat(5_000),
  };
  const large = await fixture(t, { files: largeFiles });
  const notes = [];
  for (let index = 1; index <= 2; index += 1) {
    notes.push({
      source: { ...await currentRef(large.runtime, `src/large-${index === 1 ? 'one' : 'two'}.mjs`), symbol: `large${index}` },
      documentation: { ...await currentRef(large.runtime, `docs/large-${index === 1 ? 'one' : 'two'}.md`), start_line: 1, end_line: 1 },
      related_sources: [],
    });
  }
  const textLimit = await inspectImplementationNotes(large.runtime.workspace, {
    notes, allowedPaths: implementationPaths(notes),
  });
  assert.equal(textLimit.entries.reduce((total, entry) => total + entry.content.length, 0), 8192);
  assert.equal(textLimit.entries[1].truncated, true);

  const megabyte = 'z'.repeat(1024 * 1024);
  const byteFiles = {};
  const bytePaths = Array.from({ length: 20 }, (_, index) => `src/byte-limit-${index}.txt`);
  for (const filePath of bytePaths) byteFiles[filePath] = megabyte;
  const byteFixture = await fixture(t, { files: byteFiles });
  const byteRefs = bytePaths.map(pathValue => ref(pathValue));
  const byteNotes = [0, 1].map(index => ({
    source: { ...byteRefs[index * 10], symbol: `byte${index}` },
    documentation: { ...byteRefs[index * 10 + 1], start_line: 1, end_line: 1 },
    related_sources: byteRefs.slice(index * 10 + 2, index * 10 + 10),
  }));
  let bytesRead = 0;
  const pathsRead = [];
  const observedWorkspace = {
    readSource: async filePath => {
      const value = await byteFixture.runtime.workspace.readSource(filePath);
      bytesRead += value.size;
      pathsRead.push(filePath);
      return value;
    },
  };
  await assert.rejects(inspectImplementationNotes(observedWorkspace, {
    notes: byteNotes, allowedPaths: bytePaths,
  }), codeIs('EVIDENCE_INVALID'));
  assert.ok(bytesRead <= 17 * 1024 * 1024, `inspector read more than one bounded file past the accepted budget: ${bytesRead}`);
  assert.equal(pathsRead.length, 17, 'inspector must stop immediately after the first file that crosses the aggregate budget');
  assert.ok(pathsRead.every(filePath => bytePaths.includes(filePath)));
});

test('prepared I handles bind note metadata and reject changed or expired notes without effects', async t => {
  await t.test('changed note metadata', async t => {
    const context = await targetCycle(t);
    const note = await currentNote(context.runtime);
    const prepared = await context.runtime.invoke('cycle_artifact', {
      action: 'prepare', kind: 'I', paths: [PATHS.implementation], implementation_notes: [note],
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.error));
    assert.equal(prepared.implementation_notes.status, 'current');
    const beforeState = context.runtime.store.current();
    const beforeEvidence = await evidenceCount(context.runtime);
    const changed = [{ ...note, documentation: { ...note.documentation, start_line: 3 } }];
    const rejected = await context.runtime.invoke('cycle_artifact', {
      action: 'attach', kind: 'I', paths: [PATHS.implementation],
      implementation_notes: changed, binding: prepared.binding, prepared_handle: prepared.prepared_handle,
      request_id: 'attach-tampered-notes',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'BINDING_STALE');
    assert.equal(context.runtime.store.operation('attach-tampered-notes'), null);
    assert.equal(await evidenceCount(context.runtime), beforeEvidence);
    assert.equal(context.runtime.store.current().revision, beforeState.revision);
    assert.equal(context.runtime.store.current().artifacts.I, undefined);
  });

  await t.test('changed referenced prose expires the prepared note', async t => {
    const context = await targetCycle(t);
    const note = await currentNote(context.runtime);
    const prepared = await context.runtime.invoke('cycle_artifact', {
      action: 'prepare', kind: 'I', paths: [PATHS.implementation], implementation_notes: [note],
    });
    assert.equal(prepared.ok, true, JSON.stringify(prepared.error));
    const beforeState = context.runtime.store.current();
    const beforeEvidence = await evidenceCount(context.runtime);
    await writeFile(path.join(context.root, ...DOC.split('/')), `${baseFiles[DOC]}Edited after prepare.\n`, 'utf8');
    const rejected = await context.runtime.invoke('cycle_artifact', {
      action: 'attach', kind: 'I', paths: [PATHS.implementation],
      implementation_notes: [note], binding: prepared.binding, prepared_handle: prepared.prepared_handle,
      request_id: 'attach-expired-notes',
    });
    assert.equal(rejected.ok, false);
    assert.equal(rejected.error.code, 'BINDING_STALE');
    assert.equal(context.runtime.store.operation('attach-expired-notes'), null);
    assert.equal(await evidenceCount(context.runtime), beforeEvidence);
    assert.equal(context.runtime.store.current().revision, beforeState.revision);
    assert.equal(context.runtime.store.current().artifacts.I, undefined);
  });
});

test('declared targets block finish and QA start until I is refreshed with current notes', async t => {
  const context = await targetCycle(t, { qa: { executable: process.execPath, model: 'fixture-only' } });
  await attachAuthorityWithoutNotes(context.runtime);

  const initial = await status(context.runtime);
  assert.equal(initial.implementation_notes.summary.required, 1);
  assert.equal(initial.implementation_notes.summary.attached, 0);
  assert.equal(initial.implementation_notes.summary.missing, 1);
  assert.equal(initial.blockers.some(blocker => blocker.kind === 'implementation_notes'), true);

  const check = await verifyFixed(context.runtime, 'verify-with-missing-implementation-note');
  assert.equal(check.ok, true, JSON.stringify(check.error));
  const qaReady = await status(context.runtime);
  assert.equal(qaReady.blockers.some(blocker => ['R', 'D', 'I', 'checks'].includes(blocker.kind)), false);
  assert.equal(qaReady.blockers.some(blocker => blocker.kind === 'implementation_notes'), true);

  // This test reaches the lifecycle guard only; it does not launch a calibrated or real QA model.
  context.runtime.core.capabilities.qa_driver = true;
  const qaStart = await context.runtime.invoke('cycle_qa', {
    action: 'start', request_id: 'qa-missing-implementation-note', binding: qaReady.binding,
  });
  assert.equal(qaStart.ok, false);
  assert.equal(qaStart.error.code, 'EVIDENCE_INVALID');
  assert.equal(context.runtime.store.operation('qa-missing-implementation-note'), null);
  assert.equal(context.runtime.store.current().qa_job, null);

  await simulateProtectedStoreQa(context.runtime);
  const readyToFinish = await status(context.runtime);
  const finish = await context.runtime.invoke('cycle_control', {
    action: 'finish', request_id: 'finish-missing-implementation-note', binding: readyToFinish.binding,
    semantic_verdict: {
      original_goal_covered: true, unresolved_findings: [],
      evidence_refs: readyToFinish.evidence_refs.map(reference => reference.id),
    },
  });
  assert.equal(finish.ok, false);
  assert.equal(finish.error.code, 'EVIDENCE_INVALID');
  assert.equal(finish.error.details.blockers.some(blocker => blocker.kind === 'implementation_notes'), true);
  assert.equal(context.runtime.store.operation('finish-missing-implementation-note'), null);

  const note = await currentNote(context.runtime);
  const attached = await attachArtifact(context.runtime, 'I', PATHS.implementation, [note], 'refresh-I-with-implementation-note');
  assert.equal(attached.prepared.implementation_notes.status, 'current');
  const refreshed = await status(context.runtime);
  assert.equal(refreshed.implementation_notes.status, 'current');
  assert.equal(refreshed.implementation_notes.summary.missing, 0);
  assert.equal(refreshed.blockers.some(blocker => blocker.kind === 'implementation_notes'), false);

  await attachArtifact(context.runtime, 'I', PATHS.implementation, undefined, 'reattach-I-without-notes');
  const omittedNotes = await status(context.runtime);
  assert.deepEqual(context.runtime.store.current().implementation_targets, [{ path: SOURCE, symbol: 'compute' }]);
  assert.equal(omittedNotes.implementation_notes.summary.required, 1);
  assert.equal(omittedNotes.implementation_notes.summary.attached, 0);
  assert.equal(omittedNotes.implementation_notes.summary.missing, 1);
  assert.equal(omittedNotes.blockers.some(blocker => blocker.kind === 'implementation_notes'), true);

  await attachArtifact(context.runtime, 'I', PATHS.implementation, [note], 'restore-I-notes-after-omission');
  const restoredNotes = await status(context.runtime);
  assert.equal(restoredNotes.implementation_notes.status, 'current');
  assert.equal(restoredNotes.blockers.some(blocker => blocker.kind === 'implementation_notes'), false);

  const refreshedCheck = await verifyFixed(context.runtime, 'verify-after-I-refresh');
  assert.equal(refreshedCheck.ok, true, JSON.stringify(refreshedCheck.error));
  await simulateProtectedStoreQa(context.runtime);
  const current = await status(context.runtime);
  const completed = await context.runtime.invoke('cycle_control', {
    action: 'finish', request_id: 'finish-after-I-refresh', binding: current.binding,
    semantic_verdict: {
      original_goal_covered: true, unresolved_findings: [],
      evidence_refs: current.evidence_refs.map(reference => reference.id),
    },
  });
  assert.equal(completed.ok, true, JSON.stringify(completed.error));
  assert.equal(completed.current_complete, true);
});

test('Hook reports only implementation-note counts and Stop never continues the turn', async t => {
  const context = await targetCycle(t);
  const session = '00000000-0000-0000-0000-000000000001';
  const route = await context.runtime.invoke('cycle_control', {action:'resume',request_id:'notes-hook-session-route',binding:(await context.runtime.invoke('cycle_status',{})).binding}, {hostSessionId:session});
  assert.equal(route.ok,true,JSON.stringify(route.error));
  const prompt = await context.runtime.handleHook({ hook_event_name: 'UserPromptSubmit', cwd: context.root, session_id:session });
  const summary = JSON.parse(prompt.hookSpecificOutput.additionalContext);
  assert.deepEqual(summary.implementation_notes, { required: 1, attached: 0, current: 0, stale: 0, missing: 1, invalid: 0 });
  assert.equal(Object.hasOwn(summary.implementation_notes, 'entries'), false);
  assert.deepEqual(await context.runtime.handleHook({ hook_event_name: 'Stop', cwd: context.root }), {});
});

test('QA freezes implementation-note sources and context while excluding the I summary', async t => {
  let cleanupAllowed = true;
  let cleaned = false;
  const context = await targetCycle(t, {
    qa: { executable: process.execPath, model: 'fixture-only' },
    deferCleanup: true,
  });
  t.after(async () => {
    if (cleanupAllowed && !cleaned) {
      await context.cleanupFixture();
      cleaned = true;
    }
  });

  const note = await currentNote(context.runtime);
  await attachArtifact(context.runtime, 'R', PATHS.requirements, undefined, 'freeze-note-qa-R');
  await attachArtifact(context.runtime, 'D', PATHS.design, undefined, 'freeze-note-qa-D');
  await attachArtifact(context.runtime, 'I', PATHS.implementation, [note], 'freeze-note-qa-I');
  const check = await verifyFixed(context.runtime, 'freeze-note-qa-check');
  assert.equal(check.ok, true, JSON.stringify(check.error));

  const qaReady = await status(context.runtime);
  assert.equal(qaReady.implementation_notes.status, 'current');
  assert.equal(qaReady.blockers.some(blocker => ['R', 'D', 'I', 'checks', 'implementation_notes'].includes(blocker.kind)), false);

  // This opens only the lifecycle guard; the worker retains its real uncalibrated capability result.
  context.runtime.core.capabilities.qa_driver = true;
  const requestId = 'start-frozen-note-qa';
  const started = await context.runtime.invoke('cycle_qa', { action: 'start', request_id: requestId, binding: qaReady.binding });
  if (started.ok) cleanupAllowed = false;
  assert.equal(started.ok, true, JSON.stringify(started.error));
  assert.equal(started.result.status, 'started');

  const jobId = started.result.job_id;
  const frozen = context.runtime.store.evidence(started.result.snapshot_ref.id).payload;
  const manifestPaths = frozen.snapshot.manifest.entries.map(entry => entry.path);
  assert.ok(manifestPaths.includes(SOURCE));
  assert.ok(manifestPaths.includes(DOC));
  assert.ok(manifestPaths.includes(RELATED));
  assert.equal(manifestPaths.includes(PATHS.implementation), false);
  assert.deepEqual(frozen.qa_context.implementation_notes, {
    targets: [{ path: SOURCE, symbol: 'compute' }],
    references: [note],
    symbol_verified: false,
    semantic_verified: false,
  });
  assert.equal(Object.hasOwn(frozen.qa_context, 'semantic_verdict'), false);
  assert.equal(Object.hasOwn(frozen.qa_context, 'implementation_verdict'), false);

  const originalDocumentation = await readFile(path.join(context.root, ...DOC.split('/')));
  const frozenDocumentation = await readFile(path.join(frozen.snapshot.input_dir, ...DOC.split('/')));
  assert.deepEqual(frozenDocumentation, originalDocumentation);
  assert.deepEqual(frozenDocumentation, Buffer.from(baseFiles[DOC], 'utf8'));

  const { outcome, operation, pid } = await waitForQaOutcomeAndWorkerExit(context.runtime, requestId, jobId, 10_000);
  cleanupAllowed = true;
  assert.equal(operation.launch.launch_status, 'started');
  assert.equal(qaWorkerExited(pid), true);
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.passed, false);
  assert.equal(outcome.error.code, 'QA_VERIFICATION_UNAVAILABLE');
  assert.equal(outcome.terminal_observed, false);
  assert.equal(outcome.raw_ref, undefined);
  assert.equal(outcome.report_ref, undefined);
});

test('captured I aliases remain excluded after atomic replacement and reattachment', async t => {
  const alias = 'docs/old-verdict.md';
  const futureAlias = 'docs/future-verdict.md';
  const scope = [...new Set([...EXACT_PATHS, DOC, RELATED, alias, futureAlias])];
  const context = await targetCycle(t, {
    requestedScope: scope, requestedInputs: scope,
    beforeBegin: async ({ root }) => {
      await link(path.join(root, PATHS.implementation), path.join(root, alias));
      await writeFile(path.join(root, futureAlias), '# Independent source before capture\n');
    },
  });
  const { root, runtime } = context;
  const note = await currentNote(runtime);
  await attachArtifact(runtime, 'I', PATHS.implementation, [note], 'frozen-verdict-I');
  const before = await runtime.workspace.readSource(PATHS.implementation);
  await rm(path.join(root, PATHS.implementation));
  await writeFile(path.join(root, PATHS.implementation), '# New observed implementation verdict\n');
  const after = await runtime.workspace.readSource(PATHS.implementation);
  assert.notEqual(before.file_id, after.file_id);
  await rm(path.join(root, futureAlias));
  await link(path.join(root, PATHS.implementation), path.join(root, futureAlias));
  const qaManifest = await runtime.core.manifest(runtime.store.current(), { qa: true });
  assert.equal(qaManifest.entries.some(e => e.path === alias), false);
  assert.equal(qaManifest.entries.some(e => e.path === futureAlias), true, 'Uncaptured replacement bytes must remain in QA inputs');
  const futureNote = { ...note, documentation: { ...await currentRef(runtime, futureAlias), start_line: 1, end_line: 1 } };
  assert.equal((await runtime.core.implementationNotes(runtime.store.current(), [futureNote])).status, 'current');
  const aliasNote = { ...note, documentation: { ...await currentRef(runtime, alias), start_line: 1, end_line: 1 } };
  await assert.rejects(runtime.core.implementationNotes(runtime.store.current(), [aliasNote]), codeIs('EVIDENCE_INVALID'));
  await attachArtifact(runtime, 'I', PATHS.implementation, [note], 'reattach-frozen-verdict-I');
  assert.ok(runtime.store.current().artifacts.I.verdict_sources.some(s => s.file_id === before.file_id && s.sha256 === before.sha256));
  assert.equal((await runtime.core.manifest(runtime.store.current(), { qa: true })).entries.some(e => e.path === alias), false);
  assert.equal((await runtime.core.manifest(runtime.store.current(), { qa: true })).entries.some(e => e.path === futureAlias), false, 'Reattached I now owns the replacement bytes');
  await assert.rejects(runtime.core.implementationNotes(runtime.store.current(), [aliasNote]), codeIs('EVIDENCE_INVALID'));
  await assert.rejects(runtime.core.implementationNotes(runtime.store.current(), [futureNote]), codeIs('EVIDENCE_INVALID'));
  await writeFile(path.join(root, PATHS.implementation), '# Later uncaptured bytes in the same inode\n');
  assert.equal((await runtime.workspace.readSource(PATHS.implementation)).file_id, after.file_id);
  assert.equal((await runtime.core.manifest(runtime.store.current(), { qa: true })).entries.some(e => e.path === futureAlias), true, 'An inode alone cannot hide a later version from QA');
});

test('QA manifest and implementation notes exclude case and hardlink aliases of the I summary', async t => {
  const caseAlias = 'docs/Implementation.md';
  const hardlinkAlias = 'docs/implementation-hardlink.md';
  const aliases = [...(process.platform === 'win32' ? [caseAlias] : []), hardlinkAlias];
  const scope = [...new Set([...EXACT_PATHS, DOC, RELATED, ...aliases])];
  const inputs = [...new Set([...EXACT_PATHS.filter(p => p !== PATHS.implementation), DOC, RELATED, ...aliases])];
  let cleanupAllowed = true;
  let cleaned = false;
  const context = await targetCycle(t, {
    qa: { executable: process.execPath, model: 'fixture-only' },
    deferCleanup: true,
    requestedScope: scope,
    requestedInputs: inputs,
    beforeBegin: async ({ root }) => link(
      path.join(root, ...PATHS.implementation.split('/')),
      path.join(root, ...hardlinkAlias.split('/')),
    ),
  });
  t.after(async () => {
    if (cleanupAllowed && !cleaned) {
      await context.cleanupFixture();
      cleaned = true;
    }
  });

  if (process.platform === 'win32') {
    const canonical = await context.runtime.workspace.readSource(PATHS.implementation);
    const caseVariant = await context.runtime.workspace.readSource(caseAlias);
    assert.equal(caseVariant.file_id, canonical.file_id);
  }
  const canonical = await context.runtime.workspace.readSource(PATHS.implementation);
  const hardlink = await context.runtime.workspace.readSource(hardlinkAlias);
  assert.equal(hardlink.file_id, canonical.file_id);

  const note = await currentNote(context.runtime);
  await attachArtifact(context.runtime, 'R', PATHS.requirements, undefined, 'alias-note-qa-R');
  await attachArtifact(context.runtime, 'D', PATHS.design, undefined, 'alias-note-qa-D');
  await attachArtifact(context.runtime, 'I', PATHS.implementation, [note], 'alias-note-qa-I');

  for (const alias of aliases) {
    const aliasNote = {
      source: { ...await currentRef(context.runtime, SOURCE), symbol: 'compute' },
      documentation: { ...await currentRef(context.runtime, alias), start_line: 1, end_line: 2 },
      related_sources: [],
    };
    await assert.rejects(inspectImplementationNotes(context.runtime.workspace, {
      notes: [aliasNote],
      targets: [{ path: SOURCE, symbol: 'compute' }],
      allowedPaths: context.allowed,
      excludedPaths: [PATHS.implementation],
    }), codeIs('EVIDENCE_INVALID'));

    const prepare = await context.runtime.invoke('cycle_artifact', {
      action: 'prepare', kind: 'I', paths: [PATHS.implementation], implementation_notes: [aliasNote],
    });
    assert.equal(prepare.ok, false);
    assert.equal(prepare.error.code, 'EVIDENCE_INVALID');
    assert.deepEqual(context.runtime.store.current().artifacts.I.implementation_notes, [note]);
  }

  const check = await verifyFixed(context.runtime, 'alias-note-qa-check');
  assert.equal(check.ok, true, JSON.stringify(check.error));
  const current = await status(context.runtime);
  assert.equal(current.blockers.some(blocker => ['R', 'D', 'I', 'checks', 'implementation_notes'].includes(blocker.kind)), false);
  context.runtime.core.capabilities.qa_driver = true;
  const requestId = 'start-alias-filter-qa';
  const started = await context.runtime.invoke('cycle_qa', { action: 'start', request_id: requestId, binding: current.binding });
  if (started.ok) cleanupAllowed = false;
  assert.equal(started.ok, true, JSON.stringify(started.error));

  const frozen = context.runtime.store.evidence(started.result.snapshot_ref.id).payload;
  const manifestPaths = frozen.snapshot.manifest.entries.map(entry => entry.path);
  assert.equal(manifestPaths.includes(PATHS.implementation), false);
  for (const alias of aliases) assert.equal(manifestPaths.includes(alias), false, `QA manifest included I alias ${alias}`);

  const { outcome, operation, pid } = await waitForQaOutcomeAndWorkerExit(context.runtime, requestId, started.result.job_id, 10_000);
  cleanupAllowed = true;
  assert.equal(operation.launch.launch_status, 'started');
  assert.equal(qaWorkerExited(pid), true);
  assert.equal(outcome.status, 'unknown');
  assert.equal(outcome.error.code, 'QA_VERIFICATION_UNAVAILABLE');
  assert.equal(outcome.terminal_observed, false);
  assert.equal(outcome.raw_ref, undefined);
});
