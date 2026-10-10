import { canonical, digest, fault, reuseDecisionSchema, repositoryReuseDecisionSchema, REUSE_ERRORS, REUSE_PATH_ROLES, sha256 } from '../core/contracts.mjs';
import { workspacePathKey } from './workspace.mjs';
import { implementationVerdictExclusions } from './implementation-notes.mjs';
import { validateRepositoryQuery, inspectRepositoryDecision } from './repository-reuse.mjs';
import { collectRepositoryPaths } from './repository-inventory.mjs';

const key = workspacePathKey;
const document = p => /\.(?:md|txt|rst|adoc)$/i.test(p);
const rank = { dependency: -1, consumer: 0, caller: 2, candidate: 3, registry: 4 };
const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

/** Operator read scope is independent of write scope; query filters never grant access. */
export function discoveryAllows(scope, p) {
  return typeof p === 'string' && scope.files.some(f => key(f) === key(p)) || typeof p === 'string' && scope.roots.some(r => r === '.' || key(p) === key(r) || key(p).startsWith(key(r) + '/'));
}
export function reusePolicyConflict(state, config) {
  if (!state) return false;
  const revision = state.contract_revision ?? 1;
  if (revision !== config.schema_revision) return true;
  return revision >= 2 && state.reuse_policy_digest !== digest(config.component_reuse ?? null);
}
export function requiredReuseTargets(state, config, mode) {
  if (!config.component_reuse || mode === 'docs') return [];
  const exempt = new Set(config.component_reuse.documentation_paths.map(key));
  return state.scope.filter(p => !document(p) || !exempt.has(key(p)));
}

/**
 * D files own one canonical JSON block. JSON.parse -> canonical -> stringify round-trip
 * rejects duplicate keys and textual ambiguity without another JSON/Markdown parser.
 * Workspace owns path/alias/UTF-8 protection; this function never publishes a record.
 */
export async function parseReuseDecisions(workspace, paths, { repository = false } = {}) {
  const blocks = [];
  for (const p of paths) {
    const source = await workspace.readSource(p);
    const lines = source.content.split(/\r\n|\n|\r/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i] !== (repository ? '```cycle-reuse-v2' : '```cycle-reuse-v1')) continue;
      const start = i; const body = [];
      while (++i < lines.length && lines[i] !== '```') body.push(lines[i]);
      if (i === lines.length) throw fault('EVIDENCE_INVALID', 'Reuse block must be closed.');
      const text = body.join('\n').trim();
      if (Buffer.byteLength(text) > 65536) throw fault('EVIDENCE_INVALID', 'Reuse block exceeds 64 KiB.');
      let value;
      try { value = JSON.parse(text); if (JSON.stringify(canonical(value), null, 2) !== text) throw new Error('noncanonical'); }
      catch { throw fault('EVIDENCE_INVALID', 'Reuse block needs canonical JSON without duplicate keys.'); }
      const parsed = (repository ? repositoryReuseDecisionSchema : reuseDecisionSchema).array().min(1).max(16).safeParse(value);
      if (!parsed.success) throw fault('EVIDENCE_INVALID', 'Reuse decisions do not satisfy the public contract.', {
        fields: parsed.error.issues.slice(0, 8).map(issue => ({
          field: issue.path.map(p => typeof p === 'number' ? p : /^[a-z_]+$/.test(p) ? p : 'field').join('.'),
          code: issue.code,
        })), allowed_path_roles: REUSE_PATH_ROLES,
      });
      blocks.push({ documentation: { path: p, sha256: source.sha256, start_line: start + 1, end_line: i + 1 }, decisions: parsed.data });
    }
  }
  if (blocks.length !== 1) throw fault(REUSE_ERRORS.required, 'Source work requires exactly one complete D reuse block.');
  const block = blocks[0]; const ids = block.decisions.map(d => d.id);
  const targets = block.decisions.flatMap(d => d.target_paths.map(key));
  if (new Set(ids).size !== ids.length || new Set(targets).size !== targets.length || targets.length > 64) throw fault('EVIDENCE_INVALID', 'Reuse decisions and target coverage must be unique and bounded.');
  for (const d of block.decisions) {
    if (new Set(d.read_evidence_ids).size !== d.read_evidence_ids.length || new Set(d.path_roles.map(r => key(r.path))).size !== d.path_roles.length) throw fault('EVIDENCE_INVALID', 'Reuse references and path roles must be unique.');
  }
  return { ...block, digest: digest(block) };
}

/** Accept only actual gateway archives of this cycle, never model-authored receipts. */
export function capturedReuseRecord(store, state, id, kind) {
  const record = store.evidence(id);
  const p = record.payload;
  if (record.kind !== kind || p.cycle_id !== state.id || p.workspace_id !== state.workspace_id || p.provider_workspace_id !== state.provider_workspace_id || p.policy_digest !== state.reuse_policy_digest || p.provider_identity !== state.provider_identity || p.source_capture_complete !== true || sha256(Buffer.from(p.raw_text, 'utf8')) !== p.raw_sha256) throw fault('EVIDENCE_INVALID', 'Reuse source evidence is incomplete or belongs to another cycle/policy/provider.');
  if (!(state.discovery_records ?? []).some(r => r.id === id && r.digest === record.digest)) throw fault('EVIDENCE_INVALID', 'Reuse evidence was not attached by this cycle gateway.');
  return p;
}

async function currentFact(workspace, p) {
  try { const f = await workspace.readSource(p); return { path: p, sha256: f.sha256, size: f.size }; }
  catch (error) { if (error.code === 'SOURCE_UNAVAILABLE') return { path: p, sha256: null, size: 0 }; throw error; }
}

/** Include captured input drift in bindings even before a D block is attached. */
export async function reuseInputFacts(workspace, store, state) {
  const paths = new Map();
  for (const ref of state.discovery_records ?? []) {
    const record = store.evidence(ref.id);
    if (record.digest !== ref.digest || record.payload.cycle_id !== state.id) throw fault('EVIDENCE_INVALID', 'Discovery archive pointer is corrupt.');
    const p = record.payload;
    const entries = record.kind === 'reuse-query' ? JSON.parse(p.raw_text).versions : [{ path: p.path }];
    for (const e of entries ?? []) paths.set(key(e.path), e.path);
  }
  if (paths.size > 256) throw fault('SNAPSHOT_INCOMPLETE', 'Discovery inputs exceed 256 files.');
  const facts = []; let bytes = 0;
  for (const p of paths.values()) { const fact = await currentFact(workspace, p); bytes += fact.size; facts.push(fact); }
  if (bytes > 16 * 1024 * 1024) throw fault('SNAPSHOT_INCOMPLETE', 'Discovery inputs exceed 16 MiB.');
  return facts.sort((a, b) => key(a.path).localeCompare(key(b.path)));
}

async function currentRepositoryInventory(workspace, q, policy) {
  const actual = await collectRepositoryPaths({ workspaceRoot: workspace.root, scope: policy.discovery_scope,
    skippedDirectories: q.path_inventory.skipped_directories });
  const docs = new Set(policy.documentation_paths.map(key));
  return { files: actual.files.filter(p => !docs.has(key(p))), file_facts: actual.file_facts.filter(f => !docs.has(key(f.path))) };
}

/** Read-only metadata joins byte facts in bindings, including newly added paths. */
export async function repositoryInventoryFacts(workspace, store, state, config) {
  if (config.component_reuse?.mode !== 'repository') return [];
  const facts = [];
  for (const ref of state.discovery_records ?? []) {
    const record = store.evidence(ref.id);
    if (record.kind !== 'reuse-query') continue;
    const q = JSON.parse(capturedReuseRecord(store, state, ref.id, 'reuse-query').raw_text);
    validateRepositoryQuery(q, { workspaceId: state.provider_workspace_id, scopeDigest: digest(config.component_reuse.discovery_scope) });
    try { facts.push({ query_id: ref.id, ...await currentRepositoryInventory(workspace, q, config.component_reuse) }); }
    catch (error) { facts.push({ query_id: ref.id, unavailable: error.code ?? 'SOURCE_UNAVAILABLE' }); }
  }
  return facts;
}

/** Only proven, settled own consumer effects can change the captured file set. */
export async function assertRepositoryInventoryCurrent(workspace, q, policy, consumerChanges = []) {
  const docs = new Set(policy.documentation_paths.map(key));
  const expected = new Set(q.path_inventory.files.filter(p => !docs.has(key(p))).map(key));
  for (const change of consumerChanges) {
    if (!discoveryAllows(policy.discovery_scope, change.path)) continue;
    if (change.sha256 === null) expected.delete(key(change.path)); else expected.add(key(change.path));
  }
  const actual = await currentRepositoryInventory(workspace, q, policy);
  if (digest([...expected].sort()) !== digest(actual.files.map(key).sort())) {
    throw fault(REUSE_ERRORS.stale, 'Repository file paths changed after discovery; capture current inventory before using D.');
  }
  const facts = new Map(actual.file_facts.map(f => [key(f.path), f]));
  for (const e of [...q.exclusions, ...q.unresolved]) {
    if (!e.stat || docs.has(key(e.path))) continue;
    const observed = facts.get(key(e.path));
    if (!observed) throw fault(REUSE_ERRORS.stale, 'An excluded or unresolved file disappeared after discovery.');
    const { path: ignored, ...stat } = observed;
    if (digest(stat) !== digest(e.stat)) throw fault(REUSE_ERRORS.stale, 'An excluded or unresolved file changed after discovery.');
  }
  return actual;
}

/**
 * Derive current reuse from D + immutable captures + settled consumer cursors.
 * Capability/caller membership comes from the actual query, never a prose claim.
 * Source SHA / role precedence prove freshness only; semantic fit stays reported.
 */
export async function inspectReuse({ workspace, store, state, config, mode, paths }) {
  const required = requiredReuseTargets(state, config, mode);
  const summary = { required_targets: required.length, covered_targets: 0, decisions: 0, reads: 0, stale: 0, missing: required.length };
  const basic = { summary, evidence_refs: [], semantic_verified: false, delivery: 'unknown' };
  const issues = []; let issueCount = 0;
  const addIssue = issue => { issueCount++; if (issues.length < 16 && Buffer.byteLength(JSON.stringify([...issues, issue])) <= 4096) issues.push(issue); };
  let category = 'syntax';
  if (reusePolicyConflict(state, config)) return { ...basic, status: 'needs_refresh', blocker: { kind: 'reuse', code: REUSE_ERRORS.policy } };
  if (!required.length) return { ...basic, status: 'disabled' };
  if (state.pending_operation && state.lifecycle === 'interrupted') return { ...basic, status: 'unknown', blocker: { kind: 'reuse', code: 'OPERATION_PENDING' } };
  try {
    const repository = config.component_reuse.mode === 'repository';
    const parsed = await parseReuseDecisions(workspace, paths ?? state.artifacts.D?.paths ?? [], { repository });
    category = 'scope';
    const attached = state.artifacts.D?.reuse_projection;
    if (parsed.decisions.some(d => d.acceptance_ids.some(id => !state.acceptance_ids.includes(id)) || d.target_paths.some(p => !state.scope.includes(p)))) throw fault('SCOPE_DENIED', 'Reuse targets and acceptance must remain in the original cycle.');
    summary.decisions = parsed.decisions.length;
    const declaredTargets = new Set(parsed.decisions.flatMap(d => d.target_paths.map(key)));
    summary.covered_targets = required.filter(p => declaredTargets.has(key(p))).length;
    summary.missing = required.length - summary.covered_targets;
    category = 'freshness';
    // Every target needs a fixed before-state, even when the component index
    // omits it or the file is absent. Inspecting must never recapture that state.
    if (!paths && attached?.document_digest !== parsed.digest) throw fault(REUSE_ERRORS.stale, 'D reuse projection has changed or has not been attached.');
    const targetPaths = parsed.decisions.flatMap(d => d.target_paths);
    const target_baseline = !paths || attached?.document_digest === parsed.digest ? attached.target_baseline : await Promise.all(targetPaths.map(p => currentFact(workspace, p)));
    if (!Array.isArray(target_baseline) || target_baseline.length !== targetPaths.length || targetPaths.some((p,i) => key(p) !== key(target_baseline[i]?.path))) throw fault(REUSE_ERRORS.stale, 'D lacks a fixed before-state for every target.');
    const projection = { ...parsed, document_digest: parsed.digest, target_baseline, digest: digest({ document_digest: parsed.digest, target_baseline }) };
    if (!paths && attached.digest !== projection.digest) throw fault(REUSE_ERRORS.stale, 'D target baseline identity changed.');
    const excluded = implementationVerdictExclusions(state.artifacts.I);
    // New path-level feedback obeys the same scope and physical I exclusion as discovery.
    const assertDiagnosticPath = async p => {
      if (!discoveryAllows(config.component_reuse.discovery_scope, p) && !state.scope.includes(p)) throw fault('SCOPE_DENIED', 'Diagnostic source is outside authorized scope.');
      try { const source = await workspace.readSource(p); if (excluded.hashes.has(source.sha256)) throw fault('SCOPE_DENIED', 'Reuse diagnostics cannot deliver captured bytes of the I verdict.'); }
      catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; }
    };
    const expected = new Map(); const roles = new Map(); const readPaths = new Set(); const indexedPaths = new Set(); const refs = new Map(); const repositoryQueries = new Map();
    for (const fact of target_baseline) expected.set(key(fact.path), fact);
    const assign = (p, role) => { const k = key(p); if ((rank[roles.get(k)] ?? -2) < rank[role]) roles.set(k, role); };
    category = 'evidence';
    for (const d of projection.decisions) {
      for (const p of d.target_paths) { declaredTargets.add(key(p)); assign(p, 'consumer'); }
      const captured = capturedReuseRecord(store, state, d.query_evidence_id, 'reuse-query');
      const q = JSON.parse(captured.raw_text);
      if (repository) { validateRepositoryQuery(q, { workspaceId: state.provider_workspace_id, scopeDigest: digest(config.component_reuse.discovery_scope) }); repositoryQueries.set(d.query_evidence_id, q); }
      else if (q.protocol !== config.component_reuse.provider.protocol || q.workspace_id !== state.provider_workspace_id || q.selected?.status !== 'ready' || !Array.isArray(q.versions)) throw fault(REUSE_ERRORS.stale, 'Query coverage is blocked or incomplete.');
      refs.set(d.query_evidence_id, store.evidence(d.query_evidence_id));
      for (const e of q.versions) {
        if (excluded.hashes.has(e.sha256)) throw fault('SCOPE_DENIED', 'Captured query sources include implementation-verdict bytes.');
        if (!discoveryAllows(config.component_reuse.discovery_scope, e.path)) throw fault('SCOPE_DENIED', 'Query source is outside operator discovery scope.');
        await assertDiagnosticPath(e.path);
        const previous = expected.get(key(e.path));
        if (previous && previous.sha256 !== e.sha256) throw fault(REUSE_ERRORS.stale, 'D mixes incompatible query source versions.');
        expected.set(key(e.path), e); assign(e.path, 'dependency');
        indexedPaths.add(key(e.path));
      }
      if (!repository) assign(q.declaration.path, 'registry');
      const reads = [];
      for (const id of d.read_evidence_ids) {
        const p = capturedReuseRecord(store, state, id, 'reuse-source'); refs.set(id, store.evidence(id));
        if (excluded.hashes.has(p.raw_sha256)) throw fault('SCOPE_DENIED', 'Captured reads include implementation-verdict bytes.');
        const e = expected.get(key(p.path));
        if (e && e.sha256 !== p.raw_sha256) throw fault(REUSE_ERRORS.stale, 'Read evidence and query refer to different source versions.');
        if (!discoveryAllows(config.component_reuse.discovery_scope, p.path)) throw fault('SCOPE_DENIED', 'Read evidence is outside discovery scope.');
        await assertDiagnosticPath(p.path);
        if (!e) expected.set(key(p.path), { path: p.path, sha256: p.raw_sha256 });
        readPaths.add(key(p.path)); summary.reads = readPaths.size;
        reads.push({ ...p, evidence_id: id });
      }
      if (repository) await inspectRepositoryDecision({ decision: d, q, reads, state, scope: config.component_reuse.discovery_scope, assign, addIssue, assertDiagnosticPath });
      for (const selected of repository ? [] : d.selected_capabilities) {
        const candidate = q.selected.candidates.find(c => c.uid === selected.uid && c.symbol === selected.symbol && c.verification === 'static_export' && c.state === 'active');
        if (!candidate?.locations?.length) throw fault('EVIDENCE_INVALID', 'Selected capability is not a verified queried export.');
        for (const location of candidate.locations) {
          assign(location.path, 'candidate');
          if (!discoveryAllows(config.component_reuse.discovery_scope, location.path)) throw fault('SCOPE_DENIED', 'Selected location is outside discovery scope.');
          await assertDiagnosticPath(location.path);
          if (!reads.some(r => key(r.path) === key(location.path) && r.line_ranges.some(l => l.start_line <= location.line && l.end_line >= location.line))) addIssue({ code: 'INTERFACE_READ_REQUIRED', decision_id: d.id, uid: selected.uid, symbol: selected.symbol, path: location.path, line: location.line });
        }
        for (const edge of q.selected.impact ?? []) if (edge.to_uid === selected.uid && edge.source?.path) {
          const p = edge.source.path;
          if (!discoveryAllows(config.component_reuse.discovery_scope, p)) throw fault('SCOPE_DENIED', 'Direct caller is outside discovery scope.');
          await assertDiagnosticPath(p);
          if (!d.target_paths.some(t => key(t) === key(p))) assign(p, 'caller');
          if (!reads.some(r => key(r.path) === key(p))) addIssue({ code: 'CALLER_READ_REQUIRED', decision_id: d.id, uid: selected.uid, symbol: selected.symbol, path: p });
        }
      }
      if (!repository && d.decision === 'new' && q.query.capability !== '') addIssue({ code: 'FULL_INVENTORY_REQUIRED', decision_id: d.id });
      for (const r of d.path_roles) {
        if (!expected.has(key(r.path)) && !d.target_paths.some(p => key(p) === key(r.path))) throw fault('EVIDENCE_INVALID', 'Declared role is not a captured source or target.');
        if (r.role === 'consumer' && !d.target_paths.some(p => key(p) === key(r.path))) throw fault('EVIDENCE_INVALID', 'Only an explicit target can be a consumer cursor.');
        assign(r.path, r.role);
      }
    }
    summary.covered_targets = required.filter(p => declaredTargets.has(key(p))).length;
    summary.missing = required.length - summary.covered_targets; summary.reads = readPaths.size;
    category = 'coverage';
    for (const p of required.filter(p => !declaredTargets.has(key(p)))) { await assertDiagnosticPath(p); addIssue({ code: 'TARGET_COVERAGE_REQUIRED', path: p }); }
    for (const fact of target_baseline.filter(f => f.sha256 !== null && !indexedPaths.has(key(f.path)) && !readPaths.has(key(f.path)))) {
      if (!discoveryAllows(config.component_reuse.discovery_scope, fact.path)) throw fault('SCOPE_DENIED', 'Existing target needs an operator-authorized discovery read; write scope cannot grant read access.');
      await assertDiagnosticPath(fact.path); addIssue({ code: 'TARGET_READ_REQUIRED', path: fact.path });
    }
    if (issueCount) throw fault(REUSE_ERRORS.required, 'D is missing specific source reads or target coverage; inspect diagnostic.');
    if (summary.missing) throw fault(REUSE_ERRORS.required, 'Every actual source target needs D coverage, including undeclared mechanism targets.');
    category = 'freshness';
    const consumerChanges = [];
    for (const [k, e] of expected) {
      const actual = await currentFact(workspace, e.path);
      const cursor = state.reuse_cursor?.[k]; let wanted = e.sha256;
      if (roles.get(k) === 'consumer' && cursor && cursor.projection_digest === projection.digest) {
        const op = store.operation(cursor.request_id);
        if (op?.phase !== 'settled' || !op.effects_known || op.cycle_id !== state.id || !op.effects?.some(effect => effect.kind !== 'directory' && key(effect.path) === k && (effect.after?.sha256 ?? null) === cursor.sha256)) throw fault('EVIDENCE_INVALID', 'Consumer cursor has no fully settled write effect.');
        wanted = cursor.sha256;
        consumerChanges.push({ path: e.path, sha256: wanted });
      }
      if (actual.sha256 !== wanted) { summary.stale++; await assertDiagnosticPath(e.path); addIssue({ code: 'SOURCE_CHANGED', path: e.path }); }
    }
    if (summary.stale) throw fault(REUSE_ERRORS.stale, 'Captured sources, registry or shared interfaces changed; refresh D.');
    for (const q of repositoryQueries.values()) await assertRepositoryInventoryCurrent(workspace, q, config.component_reuse, consumerChanges);
    const evidence_refs = [...refs.values()].map(r => ({ id: r.id, digest: r.digest, kind: r.kind }));
    return { ...basic, summary, evidence_refs, projection, roles: Object.fromEntries(roles), expected: [...expected.values()], status: Object.keys(state.reuse_cursor ?? {}).length ? 'in_progress' : 'ready_before_write' };
  } catch (error) {
    if (error.code === 'SCOPE_DENIED') { issues.length = 0; issueCount = 0; }
    const diagnostic = { code: error.code ?? 'EVIDENCE_INVALID', category: error.code === 'SCOPE_DENIED' ? 'scope' : error.code === REUSE_ERRORS.stale ? 'freshness' : category,
      message: error.name === 'CycleError' ? error.message : 'Reuse evidence validation failed; inspect the original authorized evidence.',
      issues, total_issues: issueCount, truncated: issueCount > issues.length,
      ...(error.details?.fields ? { fields: error.details.fields, allowed_path_roles: REUSE_PATH_ROLES } : {}) };
    return { ...basic, summary, diagnostic, status: error.code === REUSE_ERRORS.required ? 'missing' : 'needs_refresh', blocker: { kind: 'reuse', code: error.code === REUSE_ERRORS.required ? REUSE_ERRORS.required : REUSE_ERRORS.stale }, error_code: error.code ?? 'EVIDENCE_INVALID' };
  }
}

export function assertReuseReady(view) {
  if (view.blocker) throw fault(view.blocker.code, 'Current component reuse evidence is required before this action.', { reuse: { status: view.status, summary: view.summary, ...(view.diagnostic ? { diagnostic: view.diagnostic } : {}) } });
}

/**
 * 为 discover 的已验证归档投影候选、调用方和精确行数，不再要求模型重建整份 JSON。
 * 输入是当前 cycle 的完整 raw_text；范围、真实文件和 I 别名由 Workspace 校验。
 * 复用同一候选/impact 数据；不新建权威记录、不授予写权限，写入时仍由 inspectReuse 核验。
 * 整个对象按 UTF-8 16 KiB 限额检查，超限明确拒绝视图而不截断调用方或源码对象。
 */
export async function reuseSelectionView(workspace, state, config, payload) {
  const unavailable = code => ({ complete: false, code, next: code === 'SCOPE_DENIED'
    ? 'Operator discovery scope or I exclusion blocks this view. Preserve the blocker; do not hide required callers or change policy to bypass it.'
    : code === 'REUSE_STALE' ? 'Sources changed after capture. Discover current evidence again before using it in D.'
      : code === 'QUERY_NOT_READY' ? 'Inspect the authorized query blocker and registry/source consistency. This capture is unusable for D until a new query is ready; narrowing the query does not repair stale metadata.'
      : config.component_reuse.mode === 'repository' ? 'Use a smaller authorized discovery scope in a new cycle; the complete original archive remains available for explicit audit.' : 'Narrow the discovery query; the full original archive remains available for explicit audit.' });
  try {
    const q = JSON.parse(payload.raw_text);
    if (config.component_reuse.mode === 'repository') {
      validateRepositoryQuery(q, { workspaceId: state.provider_workspace_id, scopeDigest: digest(config.component_reuse.discovery_scope) });
      const excluded = implementationVerdictExclusions(state.artifacts.I);
      for (const source of q.sources) {
        if (!discoveryAllows(config.component_reuse.discovery_scope, source.path) || excluded.hashes.has(source.sha256)) return unavailable('SCOPE_DENIED');
        const actual = await workspace.readSource(source.path);
        if (excluded.hashes.has(actual.sha256)) return unavailable('SCOPE_DENIED');
        if (actual.sha256 !== source.sha256) return unavailable('REUSE_STALE');
      }
      const result = { complete: true, protocol: q.protocol, mode: q.mode, inventory_digest: q.inventory_digest, collection_stable: q.collection_stable,
        candidates: q.candidates, sources: q.sources, callers: q.relations, unresolved: q.unresolved, coverage: q.coverage,
        allowed_path_roles: REUSE_PATH_ROLES, semantic_verified: false, freshness: 'checked_at_capture',
        next: 'Read real candidate sources and callers, then use cycle-reuse-v2 in the original D. Coverage limits remain blockers for new/extend.' };
      return Buffer.byteLength(JSON.stringify(result)) <= 16384 ? result : unavailable('SELECTION_VIEW_TOO_LARGE');
    }
    if (q.selected?.status !== 'ready') return unavailable('QUERY_NOT_READY');
    const candidates = q.selected.candidates.map(c => ({ uid: c.uid, symbol: c.symbol, state: c.state, verification: c.verification,
      locations: (c.locations ?? []).map(l => ({ path: l.path, line: l.line })) }));
    const callers = [...new Set(candidates.map(c => c.uid))].map(uid => ({ uid,
      paths: [...new Set((q.selected.impact ?? []).filter(e => e.to_uid === uid && e.source?.path).map(e => e.source.path))],
      imports: (q.selected.impact ?? []).filter(e => e.to_uid === uid && e.source?.path).map(e => ({ path: e.source.path, line: e.source.line })),
      required_coverage: 'read_each_path',
    }));
    const paths = [...new Set([...candidates.flatMap(c => c.locations.map(l => l.path)), ...callers.flatMap(c => c.paths)])];
    const excluded = implementationVerdictExclusions(state.artifacts.I);
    const sources = [];
    for (const p of [...new Set([...paths, ...q.versions.map(v => v.path)])]) {
      if (!discoveryAllows(config.component_reuse.discovery_scope, p)) return unavailable('SCOPE_DENIED');
      const source = await workspace.readSource(p);
      if (excluded.hashes.has(source.sha256)) return unavailable('SCOPE_DENIED');
      const version = q.versions.find(v => key(v.path) === key(p));
      if (!version || version.sha256 !== source.sha256) return unavailable('REUSE_STALE');
      if (paths.includes(p)) sources.push({ path: p, sha256: source.sha256, line_count: source.content.split(/\r\n|\n|\r/).length });
    }
    const result = { complete: true, candidates, callers, sources, allowed_path_roles: REUSE_PATH_ROLES,
      freshness: 'checked_at_capture', semantic_verified: false,
      next: 'Read selected implementations and every listed direct caller, then reference the returned evidence IDs in D. Raw archive reconstruction is not needed for normal selection.' };
    return Buffer.byteLength(JSON.stringify(result)) <= 16384 ? result : unavailable('SELECTION_VIEW_TOO_LARGE');
  } catch (error) { return unavailable(error.code === 'SCOPE_DENIED' ? 'SCOPE_DENIED' : 'SELECTION_VIEW_UNAVAILABLE'); }
}

export function readCapturedUtf8(bytes) { return utf8.decode(bytes); }
