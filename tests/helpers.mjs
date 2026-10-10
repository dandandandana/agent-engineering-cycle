import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createRuntime } from '../src/runtime.mjs';
import { sha256 } from '../src/core/contracts.mjs';

export const GOAL = 'Implement the scoped subject change and verify the fixed project check.';
export const PATHS = Object.freeze({
  requirements: 'docs/requirements.md',
  design: 'docs/design.md',
  implementation: 'docs/implementation.md',
  subject: 'src/subject.mjs',
  outside: 'docs/outside.md',
});
export const EXACT_PATHS = Object.freeze([
  PATHS.requirements,
  PATHS.design,
  PATHS.implementation,
  PATHS.subject,
]);
export const ACTIONS = Object.freeze(['control', 'artifact', 'apply', 'verify', 'qa', 'reconcile']);
export const INITIAL_FILES = Object.freeze({
  [PATHS.requirements]: '# Requirements\nThe approved goal is to update the subject module.\n',
  [PATHS.design]: '# Design\nKeep the change inside the scoped subject module.\n',
  [PATHS.implementation]: '# Implementation\nImplementation evidence is attached separately.\n',
  [PATHS.subject]: 'export const value = "before";\n',
});

export async function temporaryRoot(t, prefix = 'engineering-cycle-core-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

export function defaultChecks() {
  return [{
    id: 'fixed-check',
    argv: [process.execPath, '-e', 'process.stdout.write("fixed-check-passed")'],
    timeout_ms: 5_000,
  }];
}

export async function writeConfig(root, config = { schema_revision: 1, checks: defaultChecks() }) {
  const directory = path.join(root, '.codex');
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, 'engineering-cycle.json'), `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

export async function fixture(t, { files = INITIAL_FILES, checks = defaultChecks(), qa, faultInjector } = {}) {
  const root = await temporaryRoot(t);
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  await writeConfig(root, { schema_revision: 1, checks, ...(qa ? { qa } : {}) });
  const runtime = await createRuntime({ workspaceRoot: root, faultInjector });
  return { root, runtime };
}

export async function authorize(runtime, {
  goal = GOAL,
  mode = 'implement',
  paths = EXACT_PATHS,
  actions = ACTIONS,
  sourceAdapter = 'interactive-operator',
} = {}) {
  // This explicitly simulates the operator adapter in a test. It is not evidence of a real human event.
  return runtime.authority.issue({
    kind: 'action',
    workspace_id: runtime.store.workspaceId,
    goal_digest: sha256(goal),
    mode,
    paths: [...paths],
    actions: [...actions],
    source: { adapter: sourceAdapter },
  }, { operatorConfirmed: true });
}

export async function beginCycle(runtime, {
  grantId,
  goal = GOAL,
  scope = EXACT_PATHS,
  inputs = EXACT_PATHS,
  requestId = `begin-${randomUUID()}`,
} = {}) {
  const args = {
    action: 'begin',
    request_id: requestId,
    goal,
    scope: [...scope],
    inputs: [...inputs],
    acceptance_ids: ['AC-03', 'AC-04', 'AC-06'],
  };
  if (grantId) args.grant_id = grantId;
  return runtime.invoke('cycle_control', args);
}

export async function status(runtime) {
  return runtime.invoke('cycle_status', {});
}

export async function attachArtifact(runtime, kind, relativePath, requestId = `attach-${kind}-${randomUUID()}`) {
  const prepared = await runtime.invoke('cycle_artifact', { action: 'prepare', kind, paths: [relativePath] });
  return runtime.invoke('cycle_artifact', {
    action: 'attach',
    kind,
    paths: [relativePath],
    binding: prepared.binding,
    prepared_handle: prepared.prepared_handle,
    request_id: requestId,
  });
}

export async function attachRDI(runtime) {
  const attached = [];
  for (const [kind, relativePath] of [
    ['R', PATHS.requirements],
    ['D', PATHS.design],
    ['I', PATHS.implementation],
  ]) attached.push(await attachArtifact(runtime, kind, relativePath));
  return attached;
}

export async function applyArgs(runtime, relativePath, content, {
  requestId = `apply-${randomUUID()}`,
  binding,
} = {}) {
  let expected = null;
  try { expected = sha256(await readFile(path.join(runtime.store.root, ...relativePath.split('/')))); }
  catch (error) { if (error?.code !== 'ENOENT') throw error; }
  const current = binding ? null : await status(runtime);
  return {
    request_id: requestId,
    binding: binding ?? current.binding,
    targets: [{ path: relativePath, action: 'write', expected_sha256: expected, content }],
  };
}

export async function applyFile(runtime, relativePath, content, options = {}) {
  return runtime.invoke('cycle_apply', await applyArgs(runtime, relativePath, content, options));
}

export async function verifyFixed(runtime, requestId = `verify-${randomUUID()}`) {
  const current = await status(runtime);
  return runtime.invoke('cycle_verify', {
    binding: current.binding,
    request_id: requestId,
    check_ids: ['fixed-check'],
  });
}

export async function issueRequirementDecision(runtime, delta, {
  cycleId,
  deltaId = delta.id,
  deltaDigest = delta.digest,
} = {}) {
  const current = await status(runtime);
  // As above, operatorConfirmed is a test fixture control, not a real approval channel.
  return runtime.authority.issue({
    kind: 'requirement',
    workspace_id: runtime.store.workspaceId,
    cycle_id: cycleId ?? current.binding.cycle_id,
    delta_id: deltaId,
    delta_digest: deltaDigest,
    source: { adapter: 'interactive-operator' },
  }, { operatorConfirmed: true });
}

export async function simulateProtectedStoreQa(runtime) {
  // This deliberately bypasses a real QA driver. It tests status freshness and lifecycle handling only.
  const state = runtime.store.current();
  const config = runtime.core.config();
  const { digest: basisDigest } = await runtime.core.basis(state, config, { qa: true });
  const id = `qa-fixture-${randomUUID()}`;
  const assurance = {
    distinct_execution: true,
    fresh_session: true,
    frozen_input_delivery: true,
    permission_observed: true,
    terminal_observed: true,
  };
  const rawRef = runtime.store.archive('qa-raw', {
    job_id: id,
    result: {
      passed: true,
      assurance,
      receipt: {
        simulated_fixture: true,
        terminal_observed: true,
        cleanup_error: null,
      },
    },
  });
  const reportRef = runtime.store.archive('qa-report', {
    job_id: id,
    source: 'simulated-test-fixture',
    report: { verdict: 'pass', simulated_fixture: true },
    raw_ref: rawRef,
  });
  runtime.store.write(`jobs/${id}.json`, {
    id,
    cycle_id: state.id,
    workspace_id: state.workspace_id,
    basis_digest: basisDigest,
    config_digest: config.digest,
    status: 'completed',
    driver: { simulated_in_test: true },
  }, { immutable: true });
  runtime.store.write(`jobs/${id}.outcome.json`, {
    job_id: id,
    status: 'completed',
    passed: true,
    report_ref: reportRef,
    raw_ref: rawRef,
    assurance,
    terminal_observed: true,
  }, { immutable: true });
  state.qa_job = id;
  runtime.store.write('current.json', state);
  return reportRef;
}

export async function verifiedFixture(t, options = {}) {
  const context = await fixture(t, options);
  const grant = await authorize(context.runtime, { mode: options.mode ?? 'implement' });
  const begun = await beginCycle(context.runtime, { grantId: grant.id });
  const artifacts = await attachRDI(context.runtime);
  const applied = await applyFile(context.runtime, PATHS.subject, 'export const value = "after";\n');
  const verification = await verifyFixed(context.runtime);
  return { ...context, grant, begun, artifacts, applied, verification };
}
