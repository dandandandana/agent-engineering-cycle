import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, link, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { packageProvider } from '../../codex-sol/scripts/package-provider.mjs';
import { fingerprintOf } from '../../codex-sol/vendor/normify/engine/store.js';
import { createRuntime } from '../src/runtime.mjs';
import { canonical, sha256 } from '../src/core/contracts.mjs';
import { reuseSelectionView } from '../src/local/reuse-evidence.mjs';
import { ACTIONS, authorize, defaultChecks, temporaryRoot, writeConfig } from './helpers.mjs';

const GOAL = 'Update the consumer using verified shared component evidence.';
const DOCS = ['docs/requirements.md', 'docs/design.md', 'docs/implementation.md'];
const CONSUMER = 'src/consumer.mjs';
const SHARED = 'src/shared.mjs';
const CALLER = 'src/caller.mjs';
const ARCH = 'architecture.json';
const ACCEPTANCE = ['AC-REUSE-01'];

let sharedProvider;
let providerParent;
before(async () => {
  providerParent = await mkdtemp(path.join(os.tmpdir(), 'cycle-component-provider-'));
  const out = path.join(providerParent, 'provider');
  const packaged = await packageProvider({ out });
  assert.equal(packaged, await realpath(out));
  const manifest = path.join(packaged, 'provider-manifest.json');
  const manifestBytes = await readFile(manifest);
  const value = JSON.parse(manifestBytes.toString('utf8'));
  assert.equal(value.protocol, 'sol-component-discovery/1');
  assert.equal(value.entry, 'src/provider-server.mjs');
  assert.ok(value.files.some((file) => file.path === 'package-lock.json'));
  sharedProvider = { manifest, manifest_sha256: sha256(manifestBytes) };
});
after(async () => {
  if (providerParent) await rm(providerParent, { recursive: true, force: true });
});

async function packagedProvider() { return sharedProvider; }

function configFor(provider, { readRoots = ['src'], readFiles = [ARCH] } = {}) {
  return {
    schema_revision: 2,
    checks: defaultChecks(),
    component_reuse: {
      required: true,
      architecture_path: ARCH,
      discovery_scope: { roots: readRoots, files: readFiles },
      documentation_paths: [...DOCS],
      provider: {
        executable: process.execPath,
        args: [],
        manifest: provider.manifest,
        manifest_sha256: provider.manifest_sha256,
        protocol: 'sol-component-discovery/1',
        timeout_ms: 30000,
      },
    },
  };
}

async function createWorkspace(t, provider, options = {}) {
  const root = await temporaryRoot(t, 'cycle-component-reuse-');
  const shared = 'export function normalize(value) { return String(value).trim(); }\n';
  const consumer = 'import { normalize } from "./shared.mjs";\nexport function consume(value) { return normalize(value); }\n';
  const caller = 'import { normalize } from "./shared.mjs";\nexport function legacy(value) { return normalize(value); }\n';
  const files = {
    [DOCS[0]]: '# Requirements\nUpdate the consumer with an explicit component decision.\n',
    [DOCS[1]]: '# Design\nComponent decision follows.\n',
    [DOCS[2]]: '# Implementation\nEvidence is attached separately.\n',
    [CONSUMER]: consumer,
    [SHARED]: shared,
    [CALLER]: caller,
    ...(options.extraFiles ?? {}),
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, ...relative.split('/'));
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }
  const modules = await Promise.all([
    moduleRecord(root, 'shared', '00000001', [SHARED], [
      { protocol: 'rpc', path: 'normalize', description: { zh: '规范化文本', en: 'Normalize text' } },
    ]),
    moduleRecord(root, 'consumer', '00000002', [CONSUMER]),
    moduleRecord(root, 'legacy-caller', '00000003', [CALLER]),
  ]);
  await writeFile(path.join(root, ARCH), JSON.stringify({
    schema_version: 1,
    modules,
    policy: { schema_version: 1, updated_at: '2026-10-08T00:00:00Z', rules: [] },
  }), 'utf8');
  const { targets = [CONSUMER], implementationTargets = targets, scopeTargets = targets, mode = 'implement' } = options;
  const cycleScope = [...DOCS, ...scopeTargets];
  await writeConfig(root, configFor(provider, options));
  const runtime = await createRuntime({ workspaceRoot: root });
  const grant = await authorize(runtime, { goal: GOAL, mode, paths: cycleScope, actions: ACTIONS });
  const begun = await runtime.invoke('cycle_control', {
    action: 'begin', request_id: `begin-${randomUUID()}`, goal: GOAL, grant_id: grant.id,
    scope: cycleScope, inputs: cycleScope.filter(p => !(options.absentTargets ?? []).includes(p)), acceptance_ids: ACCEPTANCE,
    implementation_targets: implementationTargets.map((target) => ({ path: target, symbol: target === SHARED ? 'normalize' : 'consume' })),
  });
  assert.equal(begun.ok, true, JSON.stringify(begun));
  return { root, runtime, grant, files, targets, implementationTargets, cycleScope };
}

function moduleRecord(root, id, uid, sources, apis = []) {
  const module = {
    id, uid, parent: null,
    name: { zh: `模块 ${id}`, en: `Module ${id}` },
    description: { zh: `负责 ${id}`, en: `Responsible for ${id}` },
    source: sources.map((path) => ({ path })),
    revision: '0'.repeat(40), updated_at: '2026-10-08T00:00:00Z',
    fingerprint: '0'.repeat(64), apis,
  };
  return fingerprintOf(root, module.source).then(({ hash }) => ({ ...module, fingerprint: hash }));
}

async function binding(runtime) {
  const current = await runtime.invoke('cycle_status', {});
  assert.equal(current.ok, true, JSON.stringify(current));
  return current.binding;
}

async function invoke(runtime, name, args) {
  const result = await runtime.invoke(name, args);
  const attemptRef = result.result?.attempt_ref;
  const attempt = attemptRef ? runtime.store.evidence(attemptRef.id).payload : null;
  const diagnostic = attempt ? { error: attempt.error, receipt: attempt.receipt, cache_inventory: attempt.cache_inventory } : null;
  assert.equal(result.ok, true, JSON.stringify({ result, diagnostic }));
  return result;
}

function errorCode(result) {
  return result.error?.code ?? result.result?.error?.code ?? null;
}

async function capture(runtime, action, input) {
  const currentBinding = await binding(runtime);
  const args = {
    action, kind: 'D', binding: currentBinding,
    request_id: `${action}-${randomUUID()}`,
    ...(action === 'discover' ? { query: input } : { path: input.path, line_ranges: input.line_ranges }),
  };
  const response = await invoke(runtime, 'cycle_artifact', args);
  assert.ok(response.result?.evidence?.id, JSON.stringify(response));
  const record = runtime.store.evidence(response.result.evidence.id);
  assert.equal(record.id, response.result.evidence.id);
  assert.equal(record.payload.source_capture_complete, true);
  const cycleState = runtime.store.current();
  assert.equal(record.payload.workspace_id, cycleState.workspace_id, 'gateway evidence retains the cycle/store identity');
  assert.equal(record.payload.provider_workspace_id, cycleState.provider_workspace_id, 'gateway evidence separately retains the provider physical-root identity');
  assert.equal(sha256(Buffer.from(record.payload.raw_text, 'utf8')), record.payload.raw_sha256);
  assert.equal(record.payload.raw_bytes, Buffer.byteLength(record.payload.raw_text, 'utf8'));
  assert.equal(record.payload.provider_raw.complete, true, 'gateway must recall the complete provider observation');
  assert.ok(typeof record.payload.provider_raw.handle === 'string' && record.payload.provider_raw.handle.length > 0);
  assert.equal(record.payload.provider_raw.sha256, record.payload.raw_sha256);
  assert.equal(record.payload.provider_raw.bytes, Buffer.byteLength(record.payload.raw_text, 'utf8'));
  if (action === 'read') {
    assert.equal(record.payload.raw_text, await readFile(path.join(runtime.store.root, ...input.path.split('/')), 'utf8'));
  }
  const attempt = runtime.store.evidence(record.payload.attempt_ref.id).payload;
  assert.equal(attempt.receipt.launch_status, 'started');
  assert.equal(attempt.receipt.request_completed, true);
  assert.equal(attempt.receipt.terminal_observed, true);
  assert.equal(attempt.receipt.cleanup_error, null);
  return { evidence: response.result.evidence, payload: record.payload, attempt, view_text: response.result.view_text, result: response.result };
}

async function prepare(runtime, kind, relativePath) {
  return runtime.invoke('cycle_artifact', {
    action: 'prepare', kind, paths: [relativePath], binding: await binding(runtime),
  });
}

async function attach(runtime, kind, relativePath) {
  const prepared = await prepare(runtime, kind, relativePath);
  assert.equal(prepared.ok, true, JSON.stringify(prepared));
  const attached = await runtime.invoke('cycle_artifact', {
    action: 'attach', kind, paths: [relativePath], binding: prepared.binding,
    prepared_handle: prepared.prepared_handle, request_id: `attach-${kind}-${randomUUID()}`,
  });
  assert.equal(attached.ok, true, JSON.stringify(attached));
  return attached;
}

function decisionFromCaptures({ targetPaths, query, reads }) {
  const raw = JSON.parse(query.payload.raw_text);
  const selected = raw.selected.candidates.find((candidate) => candidate.symbol === 'normalize');
  assert.ok(selected, JSON.stringify(raw.selected));
  assert.equal(selected.verification, 'static_export');
  const callers = raw.selected.impact.filter((edge) => edge.to_uid === selected.uid).map((edge) => edge.source.path);
  assert.deepEqual(new Set(callers), new Set([CONSUMER, CALLER]));
  for (const path of [SHARED, ...callers]) assert.ok(reads.some((record) => record.payload.path === path), `missing read evidence for ${path}`);
  return {
    id: `reuse-${randomUUID()}`,
    target_paths: [...targetPaths],
    acceptance_ids: [...ACCEPTANCE],
    decision: 'reuse',
    selected_capabilities: [{ uid: selected.uid, symbol: selected.symbol }],
    query_evidence_id: query.evidence.id,
    read_evidence_ids: reads.map((record) => record.evidence.id),
    rationale: 'The existing normalize export matches the consumer requirement; its implementation and static callers were read from captured source bytes.',
    path_roles: [
      ...targetPaths.map((path) => ({ path, role: path === SHARED ? 'candidate' : 'consumer' })),
      ...(targetPaths.includes(SHARED) ? [] : [{ path: SHARED, role: 'candidate' }]),
      { path: CALLER, role: 'caller' },
      { path: ARCH, role: 'registry' },
    ],
  };
}

async function writeDecision(root, decision) {
  const file = path.join(root, DOCS[1]);
  const block = `# Design\n\n\`\`\`cycle-reuse-v1\n${JSON.stringify(canonical([decision]), null, 2)}\n\`\`\`\n`;
  await writeFile(file, block, 'utf8');
  return block;
}

async function writeTarget(runtime, root, relative, content, requestId = `apply-${randomUUID()}`) {
  const existing = await readFile(path.join(root, ...relative.split('/')));
  const response = await runtime.invoke('cycle_apply', {
    binding: await binding(runtime), request_id: requestId,
    targets: [{ path: relative, action: 'write', expected_sha256: sha256(existing), content }],
  });
  return response;
}

async function assertDeniedBeforePending(runtime, relative, content, expectedCode) {
  const requestId = `denied-${randomUUID()}`;
  const result = await writeTarget(runtime, runtime.store.root, relative, content, requestId);
  assert.equal(result.ok, false, JSON.stringify(result));
  if (expectedCode) assert.equal(errorCode(result), expectedCode, JSON.stringify(result));
  assert.equal(runtime.store.operation(requestId), null, 'denied operation must not be archived as pending');
}

async function assertFileDoesNotExist(file) {
  await assert.rejects(access(file));
}

test('selection projection is bounded and rejects changed, out-of-scope and physical I aliases', async t => {
  const { root, runtime } = await createWorkspace(t, await packagedProvider(), { implementationTargets: [] });
  const state = runtime.store.current();
  const config = configFor(await packagedProvider());
  const query = { selected: { status: 'ready', candidates: [{ uid: '00000001', symbol: 'normalize', state: 'active', verification: 'static_export', locations: [{ path: SHARED, line: 1 }] }],
    impact: [{ to_uid: '00000001', source: { path: CALLER, line: 1 } }] },
    versions: await Promise.all([SHARED, CALLER].map(async p => ({ path: p, sha256: sha256(await readFile(path.join(root, p))) }))) };
  const view = (value = query, current = state, policy = config) => reuseSelectionView(runtime.workspace, current, policy, { raw_text: JSON.stringify(value) });
  const ready = await view();
  assert.equal(ready.complete, true);
  const blockedQuery = await view({ ...query, selected: { ...query.selected, status: 'blocked' } });
  assert.equal(blockedQuery.code, 'QUERY_NOT_READY');
  assert.match(blockedQuery.next, /unusable for D/);
  assert.equal(ready.freshness, 'checked_at_capture');
  assert.equal(ready.semantic_verified, false);
  assert.deepEqual(ready.callers[0].imports, [{ path: CALLER, line: 1 }]);
  assert.equal(ready.callers[0].required_coverage, 'read_each_path');
  const oversized = structuredClone(query);
  oversized.selected.candidates = Array.from({ length: 150 }, (_, i) => ({ ...query.selected.candidates[0], uid: i.toString(16).padStart(8, '0'), symbol: `capability_${i}_${'x'.repeat(70)}` }));
  const tooLarge = await view(oversized);
  assert.equal(tooLarge.complete, false);
  assert.equal(tooLarge.code, 'SELECTION_VIEW_TOO_LARGE');
  assert.equal(tooLarge.candidates, undefined, 'Budget failure cannot publish an incomplete candidate/caller set');
  assert.ok(Buffer.byteLength(JSON.stringify(tooLarge)) < 16384);
  const denied = await view(query, state, { ...config, component_reuse: { ...config.component_reuse, discovery_scope: { roots: [], files: [SHARED] } } });
  assert.equal(denied.code, 'SCOPE_DENIED');
  assert.equal(denied.sources, undefined);
  assert.match(denied.next, /Preserve the blocker/);
  const protectedPath = '.env';
  const fixtureOnly = 'PUBLIC_TEST_DATA=synthetic-fixture\n';
  await writeFile(path.join(root, protectedPath), fixtureOnly);
  const protectedQuery = { selected: { status: 'ready', candidates: [{ ...query.selected.candidates[0], locations: [{ path: protectedPath, line: 1 }] }], impact: [] }, versions: [{ path: protectedPath, sha256: sha256(fixtureOnly) }] };
  const protectedView = await view(protectedQuery, state, { ...config, component_reuse: { ...config.component_reuse, discovery_scope: { roots: [], files: [protectedPath] } } });
  assert.equal(protectedView.code, 'SCOPE_DENIED', 'Workspace path protection cannot degrade to a generic view fallback');
  assert.equal(protectedView.candidates, undefined);
  const before = await readFile(path.join(root, SHARED));
  await writeFile(path.join(root, SHARED), `${before}\n// changed\n`);
  assert.equal((await view()).code, 'REUSE_STALE');
  await writeFile(path.join(root, SHARED), before);
  await rm(path.join(root, CALLER));
  await link(path.join(root, DOCS[2]), path.join(root, CALLER));
  const aliasQuery = structuredClone(query);
  aliasQuery.versions.find(v => v.path === CALLER).sha256 = sha256(await readFile(path.join(root, CALLER)));
  const frozenI = await runtime.workspace.readSource(DOCS[2]);
  const artifactI = { paths: [DOCS[2]], manifest: { entries: [{ path: DOCS[2], sha256: frozenI.sha256 }] }, verdict_sources: [{ file_id: frozenI.file_id, sha256: frozenI.sha256 }] };
  const alias = await view(aliasQuery, { ...state, artifacts: { ...state.artifacts, I: artifactI } });
  assert.equal(alias.code, 'SCOPE_DENIED');
  assert.equal(alias.callers, undefined);
  assert.equal(alias.sources, undefined);
  await rm(path.join(root, DOCS[2]));
  await writeFile(path.join(root, DOCS[2]), '# I replaced\n');
  const renamed = await view(aliasQuery, { ...state, artifacts: { ...state.artifacts, I: artifactI } });
  assert.equal(renamed.code, 'SCOPE_DENIED', 'Frozen I identity survives removal or replacement of the original path');
  const legacyI = { ...artifactI }; delete legacyI.verdict_sources;
  assert.equal((await view(aliasQuery, { ...state, artifacts: { ...state.artifacts, I: legacyI } })).code, 'SCOPE_DENIED', 'Legacy captured manifest bytes remain excluded');
  const noSelection = { ...aliasQuery, selected: { ...aliasQuery.selected, candidates: [], impact: [] } };
  assert.equal((await view(noSelection, { ...state, artifacts: { ...state.artifacts, I: artifactI } })).code, 'SCOPE_DENIED', 'An empty selection cannot hide protected inventory sources');
});

test('public selection and D diagnostics guide missing caller repair without reading private archives', { timeout: 180000 }, async t => {
  const { root, runtime } = await createWorkspace(t, await packagedProvider(), { implementationTargets: [], scopeTargets: [CONSUMER, ARCH] });
  const query = await capture(runtime, 'discover', { paths: [], capability: '' });
  const selection = query.result.reuse_selection;
  assert.equal(selection.complete, true);
  const selected = selection.candidates.find(c => c.symbol === 'normalize');
  assert.equal(selected.verification, 'static_export');
  assert.deepEqual(new Set(selection.callers.find(c => c.uid === selected.uid).paths), new Set([CONSUMER, CALLER]));
  assert.ok(selection.sources.every(s => s.line_count > 0 && /^[a-f0-9]{64}$/.test(s.sha256)));
  const reads = [];
  for (const relative of [SHARED, CONSUMER, CALLER]) {
    const count = selection.sources.find(s => s.path === relative).line_count;
    const read = await capture(runtime, 'read', { path: relative, line_ranges: [{ start_line: 1, end_line: count }] });
    assert.equal(read.result.source_view.complete, true);
    reads.push(read);
  }
  const decision = { id: 'public-decision', target_paths: [CONSUMER, ARCH], acceptance_ids: ACCEPTANCE, decision: 'reuse',
    selected_capabilities: [{ uid: selected.uid, symbol: selected.symbol }], query_evidence_id: query.evidence.id,
    read_evidence_ids: reads.filter(r => r.result.source_view.path !== CALLER).map(r => r.evidence.id),
    rationale: 'Use the verified export and preserve its contracts.', path_roles: [] };
  await writeDecision(root, { ...decision, path_roles: [{ path: SHARED, role: 'shared' }] });
  const invalidRole = await prepare(runtime, 'D', DOCS[1]);
  const schemaDiagnostic = invalidRole.error.details.reuse.diagnostic;
  assert.equal(schemaDiagnostic.code, 'EVIDENCE_INVALID');
  assert.equal(schemaDiagnostic.category, 'syntax');
  assert.deepEqual(schemaDiagnostic.fields, [{ field: '0.path_roles.0.role', code: 'invalid_value' }]);
  assert.deepEqual(schemaDiagnostic.allowed_path_roles, selection.allowed_path_roles);
  assert.equal(runtime.store.current().pending_operation ?? null, null);
  await writeDecision(root, decision);
  const denied = await prepare(runtime, 'D', DOCS[1]);
  assert.equal(denied.ok, false);
  const detail = denied.error.details.reuse;
  assert.equal(detail.summary.reads, 2, 'Only validated references in D count, not all captures');
  assert.equal(detail.summary.covered_targets, 2);
  assert.equal(detail.summary.missing, 0);
  assert.ok(detail.diagnostic.issues.some(i => i.code === 'CALLER_READ_REQUIRED' && i.path === CALLER));
  await assertDeniedBeforePending(runtime, CONSUMER, 'export const bypass = true;', 'REUSE_PLAN_REQUIRED');
  decision.read_evidence_ids.push(reads.find(r => r.result.source_view.path === CALLER).evidence.id);
  await writeDecision(root, decision);
  await attach(runtime, 'D', DOCS[1]);
  await attach(runtime, 'I', DOCS[2]);
  const iSource = await runtime.workspace.readSource(DOCS[2]);
  assert.ok(runtime.store.current().artifacts.I.verdict_sources.some(s => s.file_id === iSource.file_id && s.sha256 === iSource.sha256));
  const originalCaller = await readFile(path.join(root, CALLER));
  const originalI = await readFile(path.join(root, DOCS[2]));
  await rm(path.join(root, CALLER));
  await link(path.join(root, DOCS[2]), path.join(root, CALLER));
  await rm(path.join(root, DOCS[2]));
  await writeFile(path.join(root, DOCS[2]), '# Replacement I\n');
  assert.notEqual((await runtime.workspace.readSource(DOCS[2])).file_id, iSource.file_id);
  await writeDecision(root, { ...decision, decision: 'new', selected_capabilities: [], rationale: 'A new decision must not absorb archived I aliases through unfiltered inventory.' });
  const aliasDiagnostic = await prepare(runtime, 'D', DOCS[1]);
  assert.equal(aliasDiagnostic.ok, false);
  assert.equal(aliasDiagnostic.error.details.reuse.diagnostic.code, 'SCOPE_DENIED');
  assert.deepEqual(aliasDiagnostic.error.details.reuse.diagnostic.issues, [], 'Protected aliases cannot supply path-level diagnostic metadata');
  assert.equal(runtime.store.current().pending_operation ?? null, null);
  const readId = `alias-read-${randomUUID()}`;
  const deniedRead = await runtime.invoke('cycle_artifact', { action: 'read', kind: 'D', binding: await binding(runtime), request_id: readId, path: CALLER, line_ranges: [{ start_line: 1, end_line: 1 }] });
  assert.equal(deniedRead.error.code, 'SCOPE_DENIED');
  assert.equal(runtime.store.operation(readId), null);
  assert.equal(deniedRead.result?.evidence, undefined);
  assert.equal(deniedRead.result?.view_text, undefined);
  const blockedView = await reuseSelectionView(runtime.workspace, runtime.store.current(), configFor(await packagedProvider()), query.payload);
  assert.equal(blockedView.code, 'SCOPE_DENIED');
  assert.equal(blockedView.sources, undefined);
  await rm(path.join(root, CALLER));
  await writeFile(path.join(root, CALLER), originalCaller);
  await writeFile(path.join(root, DOCS[2]), originalI);
  await writeDecision(root, decision);
  await attach(runtime, 'D', DOCS[1]);
  const wrote = await writeTarget(runtime, root, CONSUMER, 'import { normalize } from "./shared.mjs";\nexport function consume(value) { return normalize(value).toUpperCase(); }\n');
  assert.equal(wrote.ok, true);
  assert.equal(wrote.operation.phase, 'settled');
  const index = JSON.parse(await readFile(path.join(root, ARCH), 'utf8'));
  for (const module of index.modules) module.fingerprint = (await fingerprintOf(root, module.source)).hash;
  const synced = await writeTarget(runtime, root, ARCH, JSON.stringify(index));
  assert.equal(synced.ok, true, JSON.stringify(synced));
  const refreshedQuery = await capture(runtime, 'discover', { paths: [], capability: 'normalize' });
  assert.equal(refreshedQuery.result.reuse_selection.complete, true, JSON.stringify(refreshedQuery.result.reuse_selection));
  const refreshedConsumer = await capture(runtime, 'read', { path: CONSUMER, line_ranges: [{ start_line: 1, end_line: 2 }] });
  const stableReads = reads.filter(r => [SHARED, CALLER].includes(r.result.source_view.path));
  await writeDecision(root, { ...decision, query_evidence_id: refreshedQuery.evidence.id,
    read_evidence_ids: [...stableReads.map(r => r.evidence.id), refreshedConsumer.evidence.id],
    rationale: 'Refresh the changed consumer; preserve the actual unchanged implementation and caller captures.' });
  await attach(runtime, 'D', DOCS[1]);
  const references = (await runtime.invoke('cycle_status', {})).reuse.evidence_refs;
  for (const read of stableReads) assert.ok(references.some(ref => ref.id === read.evidence.id));
  const second = await writeTarget(runtime, root, CONSUMER, 'import { normalize } from "./shared.mjs";\nexport function consume(value) { return normalize(value).toLowerCase(); }\n');
  assert.equal(second.operation.phase, 'settled');
  assert.equal(second.ok, true, JSON.stringify(second));
});

test('an existing unindexed target outside discovery scope reports operator denial, not an impossible read', { timeout: 180000 }, async t => {
  const target = 'outside/local.mjs';
  const { root, runtime } = await createWorkspace(t, await packagedProvider(), { targets: [target], implementationTargets: [], extraFiles: { [target]: 'export const old = true;\n' } });
  const query = await capture(runtime, 'discover', { paths: [], capability: '' });
  const reads = [];
  for (const path of [SHARED, CONSUMER, CALLER]) reads.push(await capture(runtime, 'read', { path, line_ranges: [{ start_line: 1, end_line: 1 }] }));
  await writeDecision(root, decisionFromCaptures({ targetPaths: [target], query, reads }));
  const result = await prepare(runtime, 'D', DOCS[1]);
  assert.equal(result.ok, false);
  assert.equal(result.error.details.reuse.diagnostic.code, 'SCOPE_DENIED');
  assert.deepEqual(result.error.details.reuse.diagnostic.issues, []);
  assert.match(result.error.details.reuse.diagnostic.message, /write scope cannot grant read access/);
  assert.equal(runtime.store.current().pending_operation ?? null, null);
  await assertDeniedBeforePending(runtime, target, 'export const changed = true;\n', 'REUSE_PLAN_REQUIRED');
});

test('component reuse v2 captures real provider evidence and gates managed consumer writes', { timeout: 180000 }, async (t) => {
  const provider = await packagedProvider();
  // A source consumer does not need a per-function implementation note to be
  // eligible for reuse; D coverage is derived from the actual write scope.
  const fixture = await createWorkspace(t, provider, { implementationTargets: [] });
  const { root, runtime } = fixture;
  const cacheRoot = path.join(root, '.codex', 'engineering-cycle', 'provider-cache');

  await assertDeniedBeforePending(runtime, CONSUMER, 'export const attempted = true;\n', 'REUSE_PLAN_REQUIRED');
  assert.equal(await readFile(path.join(root, CONSUMER), 'utf8'), fixture.files[CONSUMER]);

  const invalidScopeId = `bad-scope-${randomUUID()}`;
  const invalidScope = await runtime.invoke('cycle_artifact', {
    action: 'read', kind: 'D', binding: await binding(runtime), request_id: invalidScopeId,
    path: DOCS[0], line_ranges: [{ start_line: 1, end_line: 1 }],
  });
  assert.equal(invalidScope.ok, false, JSON.stringify(invalidScope));
  assert.equal(errorCode(invalidScope), 'SCOPE_DENIED');
  assert.equal(runtime.store.operation(invalidScopeId), null);
  await assertFileDoesNotExist(cacheRoot);

  const query = await capture(runtime, 'discover', { paths: [], capability: 'normalize' });
  const queryRaw = JSON.parse(query.payload.raw_text);
  assert.equal(queryRaw.protocol, 'sol-component-discovery/1');
  assert.equal(queryRaw.workspace_id, runtime.store.current().provider_workspace_id, 'provider query identity uses its physical-root identity');
  assert.equal(query.payload.workspace_id, runtime.store.current().workspace_id, 'cycle evidence keeps the cycle/store identity');
  assert.equal(queryRaw.declaration.path, ARCH);
  assert.deepEqual(queryRaw.query, { paths: [], capability: 'normalize' });
  assert.equal(queryRaw.selected.status, 'ready');
  assert.deepEqual(JSON.parse(query.view_text), queryRaw.selected);
  for (const version of queryRaw.versions) {
    assert.equal(version.sha256, sha256(await readFile(path.join(root, ...version.path.split('/')))), version.path);
  }
  assert.equal(queryRaw.declaration.sha256, queryRaw.versions.find((version) => version.path === ARCH).sha256);

  const reads = [];
  for (const relative of [SHARED, CONSUMER, CALLER]) {
    const content = await readFile(path.join(root, relative));
    reads.push(await capture(runtime, 'read', {
      path: relative,
      line_ranges: [{ start_line: 1, end_line: content.toString('utf8').trimEnd().split(/\r?\n/u).length }],
    }));
  }
  const decision = decisionFromCaptures({ targetPaths: [CONSUMER], query, reads });

  const missingTargetBlock = structuredClone(decision);
  missingTargetBlock.target_paths = [DOCS[1]];
  missingTargetBlock.path_roles = decision.path_roles.map((role) => role.path === CONSUMER ? { path: DOCS[1], role: 'consumer' } : role);
  await writeDecision(root, missingTargetBlock);
  const missingCoverage = await prepare(runtime, 'D', DOCS[1]);
  assert.equal(missingCoverage.ok, false, JSON.stringify(missingCoverage));
  assert.equal(runtime.store.current().pending_operation ?? null, null, 'missing target coverage must fail during prepare, before pending state');

  const forged = structuredClone(decision);
  forged.query_evidence_id = `forged-${randomUUID()}`;
  await writeDecision(root, forged);
  const forgedEvidence = await prepare(runtime, 'D', DOCS[1]);
  assert.equal(forgedEvidence.ok, false, JSON.stringify(forgedEvidence));
  assert.equal(runtime.store.current().pending_operation ?? null, null, 'forged evidence must fail during prepare, before pending state');

  const validBlock = await writeDecision(root, decision);
  const dPrepared = await prepare(runtime, 'D', DOCS[1]);
  assert.equal(dPrepared.ok, true, JSON.stringify(dPrepared));
  const attachedD = await runtime.invoke('cycle_artifact', {
    action: 'attach', kind: 'D', paths: [DOCS[1]], binding: dPrepared.binding,
    prepared_handle: dPrepared.prepared_handle, request_id: `attach-D-${randomUUID()}`,
  });
  assert.equal(attachedD.ok, true, JSON.stringify(attachedD));
  await attach(runtime, 'R', DOCS[0]);
  await attach(runtime, 'I', DOCS[2]);

  const original = new Map();
  for (const relative of [ARCH, SHARED, CALLER]) original.set(relative, await readFile(path.join(root, relative)));
  for (const [relative, label] of [[SHARED, 'candidate'], [CALLER, 'caller'], [ARCH, 'registry']]) {
    await writeFile(path.join(root, relative), `${original.get(relative).toString('utf8')}\n// drift-${label}\n`, 'utf8');
    const requestId = `stale-${label}-${randomUUID()}`;
    const attempted = await writeTarget(runtime, root, CONSUMER, `export const shouldNotWrite = ${JSON.stringify(label)};\n`, requestId);
    assert.equal(attempted.ok, false, `${label} drift should block before a pending operation: ${JSON.stringify(attempted)}`);
    assert.equal(attempted.error.details.reuse.diagnostic.category, 'freshness');
    assert.ok(attempted.error.details.reuse.diagnostic.issues.some(issue => issue.code === 'SOURCE_CHANGED' && issue.path === relative));
    assert.equal(runtime.store.operation(requestId), null);
    assert.equal(runtime.store.current().pending_operation ?? null, null);
    await writeFile(path.join(root, relative), original.get(relative));
  }

  const consumerAfterFirst = 'import { normalize } from "./shared.mjs";\nexport function consume(value) { return normalize(value).toUpperCase(); }\n';
  const first = await writeTarget(runtime, root, CONSUMER, consumerAfterFirst, `consumer-write-${randomUUID()}`);
  assert.equal(first.ok, true, JSON.stringify(first));
  const cursorOne = runtime.store.current().reuse_cursor[CONSUMER];
  assert.ok(cursorOne);
  assert.equal(cursorOne.request_id, first.operation.request_id);
  assert.equal(first.operation.phase, 'settled');
  assert.equal(first.operation.effects_known, true);

  const consumerAfterSecond = 'import { normalize } from "./shared.mjs";\nexport function consume(value) { return normalize(value).toLowerCase(); }\n';
  const second = await writeTarget(runtime, root, CONSUMER, consumerAfterSecond, `consumer-write-${randomUUID()}`);
  assert.equal(second.ok, true, JSON.stringify(second));
  const cursorTwo = runtime.store.current().reuse_cursor[CONSUMER];
  assert.ok(cursorTwo);
  assert.equal(cursorTwo.request_id, second.operation.request_id);
  assert.notEqual(cursorTwo.request_id, cursorOne.request_id);
  assert.equal((await runtime.invoke('cycle_status', {})).reuse.status, 'in_progress');
  assert.equal((await readFile(path.join(root, DOCS[1]), 'utf8')), validBlock);
});

test('candidate sources in a mixed shared/consumer target set never inherit a consumer cursor', { timeout: 180000 }, async (t) => {
  const provider = await packagedProvider();
  const fixture = await createWorkspace(t, provider, { targets: [CONSUMER, SHARED], scopeTargets: [CONSUMER, SHARED] });
  const { root, runtime } = fixture;
  const query = await capture(runtime, 'discover', { paths: [], capability: 'normalize' });
  const reads = [];
  for (const relative of [SHARED, CONSUMER, CALLER]) {
    const content = await readFile(path.join(root, relative), 'utf8');
    reads.push(await capture(runtime, 'read', { path: relative, line_ranges: [{ start_line: 1, end_line: content.trimEnd().split(/\r?\n/u).length }] }));
  }
  const decision = decisionFromCaptures({ targetPaths: [CONSUMER, SHARED], query, reads });
  await writeDecision(root, decision);
  await attach(runtime, 'D', DOCS[1]);
  await attach(runtime, 'R', DOCS[0]);
  await attach(runtime, 'I', DOCS[2]);

  const firstConsumer = await writeTarget(runtime, root, CONSUMER, 'import { normalize } from "./shared.mjs";\nexport const consume = value => normalize(value);\n');
  assert.equal(firstConsumer.ok, true, JSON.stringify(firstConsumer));
  assert.ok(runtime.store.current().reuse_cursor[CONSUMER]);

  await writeFile(path.join(root, SHARED), 'export function normalize(value) { return String(value).trim().toLowerCase(); }\n', 'utf8');
  const requestId = `mixed-write-${randomUUID()}`;
  const beforeConsumer = await readFile(path.join(root, CONSUMER));
  const beforeShared = await readFile(path.join(root, SHARED));
  const denied = await runtime.invoke('cycle_apply', {
    binding: await binding(runtime), request_id: requestId,
    targets: [
      { path: CONSUMER, action: 'write', expected_sha256: sha256(beforeConsumer), content: 'import { normalize } from "./shared.mjs";\nexport const changed = value => normalize(value);\n' },
      { path: SHARED, action: 'write', expected_sha256: sha256(beforeShared), content: 'export function normalize(value) { return "not-yet"; }\n' },
    ],
  });
  assert.equal(denied.ok, false, JSON.stringify(denied));
  assert.equal(runtime.store.operation(requestId), null);
  assert.equal(runtime.store.current().reuse_cursor[SHARED], undefined);
  assert.equal(await readFile(path.join(root, CONSUMER), 'utf8'), 'import { normalize } from "./shared.mjs";\nexport const consume = value => normalize(value);\n');
});

test('unindexed new targets keep fixed absent and settled delete baselines; lost capture responses are not replayed', { timeout: 180000 }, async t => {
  const target = 'src/new-consumer.mjs';
  const { root, runtime } = await createWorkspace(t, await packagedProvider(), { targets: [target], implementationTargets: [], absentTargets: [target] });
  const queryArgs = { action: 'discover', kind: 'D', binding: await binding(runtime), request_id: 'lost-discover', query: { paths: [SHARED], capability: 'normalize' } };
  runtime.core.faultInjector = async (point, {op}) => { if (point === 'after_outcome' && op.request_id === queryArgs.request_id) throw new Error('lost response after saved capture'); };
  const lost = await runtime.invoke('cycle_artifact', queryArgs); assert.equal(lost.ok, false);
  const saved = runtime.store.operation(queryArgs.request_id);
  assert.equal(saved.phase, 'outcome_saved'); assert.equal(saved.effects_known, true);
  const namespaces = await readFile(runtime.store.file(`evidence/${saved.result.evidence.id}.json`));
  runtime.core.faultInjector = null;
  const duplicate = await runtime.invoke('cycle_artifact', queryArgs); assert.equal(duplicate.duplicate, true);
  assert.deepEqual(await readFile(runtime.store.file(`evidence/${saved.result.evidence.id}.json`)), namespaces);
  const resumed = await runtime.invoke('cycle_control', { action: 'resume', binding: await binding(runtime), request_id: 'resume-lost-capture' });
  assert.equal(resumed.ok, true, JSON.stringify(resumed));
  assert.equal(runtime.store.current().discovery_records.filter(r => r.id === saved.result.evidence.id).length, 1);
  const query = { evidence: saved.result.evidence, payload: runtime.store.evidence(saved.result.evidence.id).payload };
  const reads = [];
  for (const path of [SHARED, CONSUMER, CALLER]) reads.push(await capture(runtime, 'read', { path, line_ranges: [{ start_line: 1, end_line: 1 }] }));
  const decision = decisionFromCaptures({ targetPaths: [target], query, reads });
  await writeDecision(root, decision); await attach(runtime, 'D', DOCS[1]);
  assert.equal(runtime.store.current().artifacts.D.reuse_projection.target_baseline.find(f => f.path === target).sha256, null);
  const apply = async (action, content, request_id) => {
    let before = null; try { before = sha256(await readFile(path.join(root,target))); } catch(e) { if(e.code!=='ENOENT')throw e; }
    return runtime.invoke('cycle_apply', { binding: await binding(runtime), request_id, targets: [{ path: target, action, expected_sha256: before, ...(action === 'write' ? {content} : {}) }] });
  };
  const first = 'import { normalize } from "./shared.mjs";\nexport const next = normalize("one");\n';
  assert.equal((await apply('write',first,'new-create')).ok,true);
  assert.equal((await apply('delete',undefined,'new-delete')).ok,true);
  assert.equal((await runtime.invoke('cycle_status',{})).reuse.status,'in_progress');
  assert.equal((await apply('write',first,'new-recreate')).ok,true);
  await writeFile(path.join(root,target),'// externally changed\n');
  await assertDeniedBeforePending(runtime,target,'replacement','REUSE_STALE');
  const unchangedD = await prepare(runtime,'D',DOCS[1]); assert.equal(unchangedD.ok,false);
  assert.equal(errorCode(unchangedD),'REUSE_STALE');
  await writeDecision(root,{...decision,rationale:'A changed D must read the unindexed existing target rather than absorb external bytes.'});
  const noNewRead = await prepare(runtime,'D',DOCS[1]); assert.equal(noNewRead.ok,false); assert.equal(errorCode(noNewRead),'REUSE_PLAN_REQUIRED');
  assert.ok(noNewRead.error.details.reuse.diagnostic.issues.some(issue => issue.code === 'TARGET_READ_REQUIRED' && issue.path === target));
  const targetRead = await capture(runtime,'read',{path:target,line_ranges:[{start_line:1,end_line:1}]});
  await writeDecision(root,{...decision,read_evidence_ids:[...decision.read_evidence_ids,targetRead.evidence.id],rationale:'The new D decision explicitly uses the newly captured target before-state.'});
  await attach(runtime,'D',DOCS[1]);
  assert.equal((await apply('write',first,'new-explicit-refresh')).ok,true);
});

test('v1 active cycles conflict with v2 policy and docs-only discovery does not launch a provider', { timeout: 45000 }, async (t) => {
  const provider = await packagedProvider();
  const root = await temporaryRoot(t, 'cycle-component-v1-');
  for (const relative of [...DOCS, CONSUMER]) {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, relative.endsWith('.mjs') ? 'export const value = "before";\n' : `# ${relative}\n`, 'utf8');
  }
  await writeConfig(root, { schema_revision: 1, checks: defaultChecks() });
  const v1Runtime = await createRuntime({ workspaceRoot: root });
  const paths = [...DOCS, CONSUMER];
  const grant = await authorize(v1Runtime, { goal: GOAL, paths, actions: ACTIONS });
  const begin = await v1Runtime.invoke('cycle_control', {
    action: 'begin', request_id: `v1-begin-${randomUUID()}`, goal: GOAL, grant_id: grant.id,
    scope: paths, inputs: paths, acceptance_ids: ACCEPTANCE,
  });
  assert.equal(begin.ok, true, JSON.stringify(begin));
  const v2 = configFor(provider);
  await writeConfig(root, v2);
  const policyConflict = await v1Runtime.invoke('cycle_apply', {
    binding: await binding(v1Runtime), request_id: `v1-v2-${randomUUID()}`,
    targets: [{ path: CONSUMER, action: 'write', expected_sha256: sha256(await readFile(path.join(root, CONSUMER))), content: 'export const value = "after";\n' }],
  });
  assert.equal(policyConflict.ok, false, JSON.stringify(policyConflict));
  assert.equal(errorCode(policyConflict), 'POLICY_CONFLICT');
  assert.equal(v1Runtime.store.current().pending_operation ?? null, null);

  const docs = await createWorkspace(t, provider, { mode: 'docs' });
  const docsScope = docs.cycleScope;
  const before = await docs.runtime.invoke('cycle_artifact', {
    action: 'discover', kind: 'D', binding: await binding(docs.runtime), request_id: `docs-discover-${randomUUID()}`,
    query: { paths: [], capability: 'normalize' },
  });
  assert.equal(before.ok, false, JSON.stringify(before));
  assert.equal(errorCode(before), 'SCOPE_DENIED');
  assert.equal(docs.runtime.store.current().pending_operation ?? null, null);
  await assertFileDoesNotExist(path.join(docs.root, '.codex', 'engineering-cycle', 'provider-cache'));
  assert.deepEqual(docsScope, [...DOCS, CONSUMER]);
});
