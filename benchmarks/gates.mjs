import { mkdir, mkdtemp, readFile, realpath, lstat, rm, rmdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { createRuntime } from '../src/runtime.mjs';
import { sha256 } from '../src/core/contracts.mjs';

const GOAL = 'Check implementation-note currentness and scoped backend gates.';
const FILES = {
  requirements: 'docs/requirements.md',
  design: 'docs/design.md',
  implementation: 'docs/implementation.md',
  source: 'src/subject.mjs',
  documentation: 'docs/compute-flow.md',
  related: 'src/scaler.mjs',
};
const INITIAL_FILES = {
  [FILES.requirements]: '# Requirements\nKeep compute(value, factor) multiplying its inputs.\n',
  [FILES.design]: '# Design\ncompute forwards both arguments to the scale helper.\n',
  [FILES.implementation]: '# Implementation\nThis state summary links to the original mechanism notes.\n',
  [FILES.source]: "import { scale } from './scaler.mjs';\nexport function compute(value, factor) { return scale(value, factor); }\n",
  [FILES.documentation]: '# Parameter flow\ncompute receives value and factor.\nIt calls scale(value, factor) in src/scaler.mjs.\nscale multiplies both inputs and its result is returned.\nThere is no file or network I/O or owned resource.\n',
  [FILES.related]: 'export function scale(value, factor) { return value * factor; }\n',
};
const WRONG_PROSE = 'compute adds both inputs, writes a file, and returns undefined.';

function fixturePath(context, relative) {
  return path.join(context.root, ...relative.split('/'));
}

function requireOk(response, action) {
  if (!response.ok) {
    const error = new Error(`${action}: ${response.error?.message ?? 'Backend did not return success.'}`);
    error.code = response.error?.code ?? 'BACKEND_ERROR';
    throw error;
  }
  return response;
}

async function status(context) {
  return requireOk(await context.runtime.invoke('cycle_status', {}), 'cycle_status');
}

async function sourceIdentity(context, relative) {
  const source = await context.runtime.workspace.readSource(relative);
  return { path: relative, sha256: source.sha256 };
}

async function note(context, { startLine = 2, endLine = 5 } = {}) {
  return {
    source: { ...await sourceIdentity(context, FILES.source), symbol: 'compute' },
    documentation: { ...await sourceIdentity(context, FILES.documentation), start_line: startLine, end_line: endLine },
    related_sources: [await sourceIdentity(context, FILES.related)],
  };
}

async function productHashes(context) {
  const entries = [];
  for (const relative of Object.values(FILES)) entries.push([relative, sha256(await readFile(fixturePath(context, relative)))]);
  return Object.fromEntries(entries);
}

async function attach(context, kind, relative, notes) {
  const input = { action: 'prepare', kind, paths: [relative], ...(notes !== undefined ? { implementation_notes: notes } : {}) };
  const prepared = requireOk(await context.runtime.invoke('cycle_artifact', input), `${kind} prepare`);
  const result = requireOk(await context.runtime.invoke('cycle_artifact', {
    ...input, action: 'attach', binding: prepared.binding, prepared_handle: prepared.prepared_handle,
    request_id: `attach-${kind}-${++context.requestIndex}`,
  }), `${kind} attach`);
  return { prepared, result };
}

async function attachRDI(context, notes) {
  await attach(context, 'R', FILES.requirements);
  await attach(context, 'D', FILES.design);
  await attach(context, 'I', FILES.implementation, notes);
}

async function setup(context, mode = 'implement') {
  for (const [relative, content] of Object.entries(INITIAL_FILES)) {
    await mkdir(path.dirname(fixturePath(context, relative)), { recursive: true });
    await writeFile(fixturePath(context, relative), content, 'utf8');
  }
  await mkdir(path.join(context.root, '.codex'));
  await writeFile(path.join(context.root, '.codex', 'engineering-cycle.json'), JSON.stringify({
    schema_revision: 1, checks: [{ id: 'source-integrity', kind: 'source-integrity' }],
  }), 'utf8');
  context.runtime = await createRuntime({ workspaceRoot: context.root });
  // This is a synthetic operator fixture, never proof of a human event or a calibrated QA driver.
  const grant = context.runtime.authority.issue({
    kind: 'action', workspace_id: context.runtime.store.workspaceId, goal_digest: sha256(GOAL), mode,
    paths: Object.values(FILES), actions: ['control', 'artifact', 'apply', 'verify', 'qa'],
    source: { adapter: 'interactive-operator' },
  }, { operatorConfirmed: true });
  requireOk(await context.runtime.invoke('cycle_control', {
    action: 'begin', request_id: 'begin', goal: GOAL, grant_id: grant.id,
    scope: Object.values(FILES), inputs: Object.values(FILES), acceptance_ids: ['GATE-NOTES'],
    implementation_targets: [{ path: FILES.source, symbol: 'compute' }],
  }), 'cycle begin');
}

function driftCase(id, relative) {
  return {
    id,
    expected: { before: 'current', after: 'needs-update', entry: 'stale', notes_blocker: true, binding_stale: true, source_hash_changed: true },
    async exercise(context) {
      await attachRDI(context, [await note(context)]);
      const before = await status(context);
      const oldHash = (await sourceIdentity(context, relative)).sha256;
      await writeFile(fixturePath(context, relative), `${await readFile(fixturePath(context, relative), 'utf8')}\n// External fixture edit\n`, 'utf8');
      const after = await status(context);
      return {
        before: before.implementation_notes.status, after: after.implementation_notes.status,
        entry: after.implementation_notes.entries[0].status,
        notes_blocker: after.blockers.some(blocker => blocker.kind === 'implementation_notes'),
        binding_stale: after.blockers.some(blocker => blocker.code === 'BINDING_STALE'),
        source_hash_changed: oldHash !== (await sourceIdentity(context, relative)).sha256,
        changed_path: relative, inspection: after.implementation_notes,
      };
    },
  };
}

const SCENARIOS = [
  {
    id: 'missing-notes',
    expected: { required: 1, missing: 1, notes_blocker: true, finish_ok: false, finish_code: 'EVIDENCE_INVALID', finish_notes_blocker: true, finish_operation_created: false, qa_ok: false, qa_code: 'QA_VERIFICATION_UNAVAILABLE', qa_operation_created: false, qa_job_created: false, product_bytes_unchanged: true },
    async exercise(context) {
      await attachRDI(context);
      const before = await status(context);
      requireOk(await context.runtime.invoke('cycle_verify', {
        binding: before.binding, request_id: 'verify', check_ids: ['source-integrity'],
      }), 'source-integrity check');
      const ready = await status(context);
      const hashes = await productHashes(context);
      const finish = await context.runtime.invoke('cycle_control', {
        action: 'finish', request_id: 'finish-missing-notes', binding: ready.binding,
        semantic_verdict: { original_goal_covered: true, unresolved_findings: [], evidence_refs: ready.evidence_refs.map(ref => ref.id) },
      });
      const qa = await context.runtime.invoke('cycle_qa', {
        action: 'start', request_id: 'qa-missing-notes', binding: (await status(context)).binding,
      });
      const final = await status(context);
      return {
        required: ready.implementation_notes.summary.required, missing: ready.implementation_notes.summary.missing,
        notes_blocker: ready.blockers.some(blocker => blocker.kind === 'implementation_notes'),
        finish_ok: finish.ok, finish_code: finish.error?.code,
        finish_notes_blocker: finish.error?.details?.blockers?.some(blocker => blocker.kind === 'implementation_notes') === true,
        finish_operation_created: context.runtime.store.operation('finish-missing-notes') !== null,
        qa_ok: qa.ok, qa_code: qa.error?.code,
        qa_operation_created: context.runtime.store.operation('qa-missing-notes') !== null,
        qa_job_created: final.qa !== null,
        product_bytes_unchanged: isDeepStrictEqual(hashes, await productHashes(context)),
        qa_note_guard_observed: false,
        coverage: 'Finish exposes the missing-note blocker. QA rejects its unavailable driver before its note guard; that guard and closed-loop QA are not verified.',
      };
    },
  },
  {
    id: 'current-notes',
    expected: { status: 'current', required: 1, current: 1, missing: 0, notes_blocker: false, prose_returned: true, symbol_verified: false, semantic_verified: false },
    async exercise(context) {
      await attachRDI(context, [await note(context)]);
      const current = await status(context);
      const entry = current.implementation_notes.entries[0];
      return {
        status: current.implementation_notes.status, required: current.implementation_notes.summary.required,
        current: current.implementation_notes.summary.current, missing: current.implementation_notes.summary.missing,
        notes_blocker: current.blockers.some(blocker => blocker.kind === 'implementation_notes'),
        prose_returned: entry.content === INITIAL_FILES[FILES.documentation].split('\n').slice(1, 5).join('\n'),
        symbol_verified: entry.symbol_verified, semantic_verified: current.implementation_notes.semantic_verified,
        inspection: current.implementation_notes,
      };
    },
  },
  driftCase('source-drift', FILES.source),
  driftCase('documentation-drift', FILES.documentation),
  driftCase('related-source-drift', FILES.related),
  {
    id: 'wrong-prose-is-not-semantic-proof',
    expected: { status: 'current', returned_prose: WRONG_PROSE, symbol_verified: false, semantic_verified: false, product_source_unchanged: true },
    async exercise(context) {
      const before = await sourceIdentity(context, FILES.source);
      await writeFile(fixturePath(context, FILES.documentation), `${WRONG_PROSE}\n`, 'utf8');
      await attachRDI(context, [await note(context, { startLine: 1, endLine: 1 })]);
      const current = await status(context);
      return {
        status: current.implementation_notes.status, returned_prose: current.implementation_notes.entries[0].content,
        symbol_verified: current.implementation_notes.entries[0].symbol_verified,
        semantic_verified: current.implementation_notes.semantic_verified,
        product_source_unchanged: before.sha256 === (await sourceIdentity(context, FILES.source)).sha256,
        coverage: 'A deliberately false description has current byte identities. This observes the structural/semantic boundary; no semantic judge is run.',
      };
    },
  },
  {
    id: 'prepared-reference-tampering',
    expected: { ok: false, code: 'BINDING_STALE', operation_created: false, product_bytes_unchanged: true, note_attached: false },
    async exercise(context) {
      const original = await note(context);
      const prepared = requireOk(await context.runtime.invoke('cycle_artifact', {
        action: 'prepare', kind: 'I', paths: [FILES.implementation], implementation_notes: [original],
      }), 'I prepare');
      const hashes = await productHashes(context);
      const tampered = { ...original, documentation: { ...original.documentation, end_line: original.documentation.end_line - 1 } };
      const result = await context.runtime.invoke('cycle_artifact', {
        action: 'attach', kind: 'I', paths: [FILES.implementation], implementation_notes: [tampered],
        binding: prepared.binding, prepared_handle: prepared.prepared_handle, request_id: 'attach-tampered',
      });
      return {
        ok: result.ok, code: result.error?.code, operation_created: context.runtime.store.operation('attach-tampered') !== null,
        product_bytes_unchanged: isDeepStrictEqual(hashes, await productHashes(context)),
        note_attached: (await status(context)).implementation_notes.summary.attached > 0,
        original_reference: original, attempted_reference: tampered,
      };
    },
  },
  {
    id: 'docs-mode-code-write', mode: 'docs',
    expected: { ok: false, code: 'SCOPE_DENIED', operation_created: false, product_bytes_unchanged: true },
    async exercise(context) {
      const before = await sourceIdentity(context, FILES.source);
      const hashes = await productHashes(context);
      const result = await context.runtime.invoke('cycle_apply', {
        binding: (await status(context)).binding, request_id: 'docs-write-code',
        targets: [{ path: FILES.source, action: 'write', expected_sha256: before.sha256, content: 'export const changed = true;\n' }],
      });
      return {
        ok: result.ok, code: result.error?.code,
        operation_created: context.runtime.store.operation('docs-write-code') !== null,
        product_bytes_unchanged: isDeepStrictEqual(hashes, await productHashes(context)),
      };
    },
  },
  {
    id: 'hook-and-external-drift',
    expected: { matched_write: 'deny', stop_continues: false, before: 'current', after: 'needs-update', notes_blocker: true, binding_stale: true, external_bytes_observed: true },
    async exercise(context) {
      await attachRDI(context, [await note(context)]);
      const before = await status(context);
      const sessionId = 'benchmark-hook-session';
      requireOk(await context.runtime.invoke('cycle_control', {
        action: 'resume', request_id: 'benchmark-hook-session-join', binding: before.binding,
      }, { hostSessionId: sessionId }), 'Hook session join');
      const patch = `*** Begin Patch\n*** Update File: ${FILES.source}\n@@\n-export function compute(value, factor) { return scale(value, factor); }\n+export function compute(value, factor) { return scale(value, factor) }\n*** End Patch`;
      const hook = await context.runtime.handleHook({
        hook_event_name: 'PreToolUse', tool_name: 'apply_patch', cwd: context.root, session_id: sessionId,
        tool_input: { command: patch },
      });
      const stop = await context.runtime.handleHook({ hook_event_name: 'Stop', cwd: context.root });
      const externalBytes = 'export function compute(value, factor) { return value + factor; }\n';
      // Simulates an unmatched Shell/editor write; it is not evidence of a real Host hook event.
      await writeFile(fixturePath(context, FILES.source), externalBytes, 'utf8');
      const after = await status(context);
      return {
        matched_write: hook.hookSpecificOutput?.permissionDecision,
        stop_continues: !isDeepStrictEqual(stop, {}),
        before: before.implementation_notes.status, after: after.implementation_notes.status,
        notes_blocker: after.blockers.some(blocker => blocker.kind === 'implementation_notes'),
        binding_stale: after.blockers.some(blocker => blocker.code === 'BINDING_STALE'),
        external_bytes_observed: (await sourceIdentity(context, FILES.source)).sha256 === sha256(externalBytes),
        hook_response: hook, stop_response: stop,
        coverage: 'Runtime hook handler plus direct external filesystem edit; real Host delivery and Shell interception are not verified.',
      };
    },
  },
];

async function removeOwnedDirectory(directory, parent) {
  const [resolvedDirectory, resolvedParent, info] = await Promise.all([realpath(directory), realpath(parent), lstat(directory)]);
  const relative = path.relative(resolvedParent, resolvedDirectory);
  if (!info.isDirectory() || info.isSymbolicLink() || !relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Refusing cleanup outside the benchmark-owned directory.');
  }
  await rm(resolvedDirectory, { recursive: true, force: false });
}

async function settleFixture(context, preserve, runRoot) {
  let lifecycle = 'unbound';
  if (context.runtime) {
    const current = await context.runtime.invoke('cycle_status', {});
    if (!current.ok || current.pending_operation || current.blockers?.some(blocker => blocker.code === 'OUTCOME_UNKNOWN')) {
      return { status: 'preserved-unknown', fixture_directory: context.root, reason: 'State is unknown or has a pending operation; no abandon or replay was attempted.' };
    }
    if (current.binding && !['abandoned', 'completed'].includes(current.lifecycle)) {
      const result = await context.runtime.invoke('cycle_control', {
        action: 'abandon', request_id: 'benchmark-abandon', binding: current.binding, reason: 'Backend benchmark fixture ended without running closed-loop QA.',
      });
      if (!result.ok) return { status: 'preserved-cleanup-error', fixture_directory: context.root, error: result.error };
      lifecycle = result.lifecycle;
    } else if (current.binding) {
      lifecycle = current.lifecycle;
    }
  }
  if (preserve) return { status: `${lifecycle}-and-preserved`, fixture_directory: context.root };
  await removeOwnedDirectory(context.root, runRoot);
  return { status: 'removed', fixture_directory: context.root };
}

/**
 * Executes real backend entry points against independent synthetic workspaces.
 * outputDirectory retains fixture files/evidence; otherwise only unknown outcomes are retained.
 * Grants are synthetic. No QA capability/result or human identity is forged; no model or closed-loop QA is run.
 */
export async function runGates({ outputDirectory } = {}) {
  if (outputDirectory !== undefined && (typeof outputDirectory !== 'string' || !outputDirectory.trim())) throw new TypeError('outputDirectory must be a nonempty directory path.');
  const preserve = outputDirectory !== undefined;
  const parent = path.resolve(outputDirectory ?? os.tmpdir());
  await mkdir(parent, { recursive: true });
  const runRoot = await mkdtemp(path.join(await realpath(parent), 'cycle-backend-gates-'));
  const cases = [];
  for (const scenario of SCENARIOS) {
    const started = performance.now();
    const context = { root: path.join(runRoot, scenario.id), requestIndex: 0, runtime: null };
    const result = { id: scenario.id, status: 'error', expected: scenario.expected, observed: {}, duration_ms: 0 };
    try {
      await mkdir(context.root);
      await setup(context, scenario.mode);
      result.observed = await scenario.exercise(context);
      result.status = Object.entries(scenario.expected).every(([key, value]) => isDeepStrictEqual(result.observed[key], value)) ? 'pass' : 'fail';
    } catch (error) {
      result.observed.error = { code: error.code ?? 'BENCHMARK_ERROR', message: error.message };
    }
    try {
      const cleanup = await settleFixture(context, preserve, runRoot);
      result.observed.cleanup = cleanup;
      if (cleanup.status.startsWith('preserved-')) result.status = 'error';
    } catch (error) {
      result.status = 'error';
      result.observed.cleanup = { status: 'preserved-cleanup-error', fixture_directory: context.root, error: { code: error.code ?? 'CLEANUP_ERROR', message: error.message } };
    }
    result.duration_ms = performance.now() - started;
    cases.push(result);
    if (preserve) {
      try { await writeFile(path.join(context.root, 'benchmark-case.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8'); }
      catch (error) {
        result.status = 'error';
        result.observed.reporting_error = { code: error.code ?? 'REPORTING_ERROR', message: error.message };
      }
    }
  }
  if (!preserve && cases.every(result => result.observed.cleanup?.status === 'removed')) await rmdir(runRoot);
  const summary = { planned: SCENARIOS.length, pass: 0, fail: 0, error: 0 };
  for (const result of cases) summary[result.status] += 1;
  return { layer: 'backend-contract', authorization: 'synthetic fixture; no human identity proof', cases, summary };
}
