import path from 'node:path';
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { digest, sha256, fault, safeError, textPage, TOOL_SCHEMAS, QA_ASSURANCE_KEYS, CHECK_APPLICABILITY_ID } from './contracts.mjs';
import { readConfig } from '../local/config.mjs';
import { runCheck } from '../local/check-runner.mjs';
import { inspectImplementationNotes, implementationPaths, implementationVerdictExclusions } from '../local/implementation-notes.mjs';
import { workspacePathKey } from '../local/workspace.mjs';
import { inspectReuse, assertReuseReady, reusePolicyConflict, requiredReuseTargets, reuseInputFacts, repositoryInventoryFacts, discoveryAllows, reuseSelectionView } from '../local/reuse-evidence.mjs';
import { providerIdentity, captureComponent, providerWorkspaceIdentity } from '../adapters/component-provider.mjs';
import { reuseQaContext, assertQaDeliveryBudget } from '../local/qa-evidence.mjs';
import { createCheckPlan, detectCheckCandidates } from '../local/check-plan.mjs';
import { discoverQaCandidate } from '../local/qa-candidates.mjs';
import { readDefaultQaSelection, withDefaultQaReceipt } from '../local/qa-defaults.mjs';
import { qaCapability } from '../adapters/qa-cli.mjs';

const mutationKinds = new Set(['cycle_control', 'cycle_apply', 'cycle_verify', 'cycle_reconcile']);
const document = p => /\.(?:md|txt|rst|adoc)$/i.test(p);
const workerFile = fileURLToPath(new URL('../adapters/qa-worker.mjs', import.meta.url));
const artifactHandle = (args, manifest, binding, reuse) => digest({ kind: args.kind, manifest, binding, ...(args.implementation_notes !== undefined ? { implementation_notes: args.implementation_notes } : {}), ...(reuse ? { reuse_projection: reuse.digest } : {}) });

/** The only owner of cycle transitions. Transports cannot mint facts or approvals. */
export class CycleCore {
  constructor({ store, workspace, authority, capabilities, faultInjector, configurationOptions = {}, hostModel = null }) {
    Object.assign(this, { store, workspace, authority, capabilities, faultInjector, configurationOptions, hostModel });
  }
  config(state = this.store.current()) {
    const current = readConfig(this.store, this.configurationOptions);
    if ((state?.contract_revision ?? 1) !== 3 || !state.configuration_snapshot) {
      if (current.schema_revision !== 3) return current;
      const selection = readDefaultQaSelection(this.store, this.authority);
      const qa = selection && (!current.qa?.model || current.qa.model === selection.driver.model) ? selection.driver : current.qa;
      return withDefaultQaReceipt({ ...current, qa }, this.store);
    }
    const snapshot = state.configuration_snapshot;
    if (digest(snapshot.config) !== snapshot.digest) throw fault('EVIDENCE_INVALID', 'Frozen default configuration identity is invalid.');
    const fixed = structuredClone(snapshot.config);
    fixed.configuration_override_conflict = current.schema_revision !== 3 || current.configuration.inputs_digest !== snapshot.inputs_digest;
    return withDefaultQaReceipt(fixed, this.store);
  }
  async freezeDefaultPlan(state, args, config) {
    const grant = this.authority.load(state.grant_id).payload;
    const authorityPaths = args.authority_paths ?? {};
    const requested = Object.values(authorityPaths).flat();
    const permitted = [...new Set([...(config.component_reuse.documentation_paths ?? []).filter(p => grant.paths.includes(p) && state.scope.includes(p)), ...(grant.documentation_paths ?? [])])];
    if (permitted.length > 64 || permitted.some(p => !document(p) || !grant.paths.includes(p) || !state.scope.includes(p))
      || requested.some(p => !document(p) || !permitted.includes(p))) throw fault('SCOPE_DENIED', 'Authority document paths require exact signed document permission within this scope.');
    for (const p of permitted) { try { await this.workspace.readSource(p); } catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; } }
    state.authority_paths = authorityPaths;
    const fixed = structuredClone(config);
    fixed.component_reuse.documentation_paths = permitted;
    const mode = this.grant(state, 'control').mode;
    state.execution_plan = mode === 'docs'
      ? { checks: fixed.checks.filter(c => c.kind === 'source-integrity'), source_facts: [], toolchain_facts: [], exclusions: [], behavioral: { status: 'not_applicable', reason: 'Signed docs-only scope cannot execute code or arbitrary checks.' } }
      : await createCheckPlan({ workspace: this.workspace, config: fixed, scope: state.scope, input: args.check_plan ?? {}, env: this.configurationOptions.env });
    if (!state.execution_plan.digest) state.execution_plan.digest = digest(state.execution_plan);
    state.inputs = [...new Set([...state.inputs, ...state.execution_plan.source_facts.map(f => f.path), ...(config.registration_source_fact ? [config.registration_source_fact.path] : [])])];
    fixed.checks = state.execution_plan.checks;
    state.qa_plan = await discoverQaCandidate({ config: fixed, env: this.configurationOptions.env, hostModel: this.hostModel });
    if (state.qa_plan.executable && state.qa_plan.executable_sha256 && state.qa_plan.model) {
      fixed.qa = { executable: state.qa_plan.executable, model: state.qa_plan.model, timeout_ms: config.qa?.timeout_ms ?? 180000,
        ...(state.qa_plan.windows_sandbox ? { windows_sandbox: state.qa_plan.windows_sandbox } : {}) };
    } else fixed.qa = null;
    fixed.digest = digest({ profile_digest: config.digest, execution_plan: state.execution_plan.digest, documentation_paths: permitted,
      qa: fixed.qa, qa_binary: state.qa_plan.executable_sha256 });
    fixed.configuration.digest = fixed.digest;
    state.configuration_snapshot = { config: fixed, digest: digest(fixed), inputs_digest: config.configuration.inputs_digest };
    return withDefaultQaReceipt(fixed, this.store);
  }
  async reuse(state, config = this.config(), paths) {
    const mode = this.authority.load(state.grant_id).payload.mode;
    return inspectReuse({ workspace: this.workspace, store: this.store, state, config, mode, paths });
  }
  async prepareReuse(state, config, paths) {
    if (!state || !requiredReuseTargets(state, config, this.authority.load(state.grant_id).payload.mode).length) return null;
    const result = await this.reuse(state, config, paths); assertReuseReady(result); return result.projection;
  }
  qaContext(state, config, reuse) {
    const verification = this.store.evidence(state.checks.evidence.id).payload;
    const checkFacts = verification.results.map(result => { const receipt = this.store.evidence(result.raw_ref.id).payload.receipt; const { stdout, stderr, ...facts } = receipt; return { ...facts, stdout_excerpt: (stdout ?? '').slice(0, 1024), stderr_excerpt: (stderr ?? '').slice(0, 1024), display_truncated: (stdout?.length ?? 0) > 1024 || (stderr?.length ?? 0) > 1024, raw_ref: result.raw_ref }; });
    const mechanisms = state.implementation_targets?.length ? { implementation_notes: { targets: state.implementation_targets, references: state.artifacts.I?.implementation_notes ?? [], symbol_verified: false, semantic_verified: false } } : {};
    const component_reuse = reuseQaContext(this.store, reuse, state);
    const applicability = state.contract_revision === 3 && this.grant(state, 'qa').mode === 'implement' && state.execution_plan?.behavioral.status === 'not_applicable'
      ? { check_applicability: { acceptance_id: CHECK_APPLICABILITY_ID, declaration: state.execution_plan.behavioral, requirement: 'Independently inspect the actual changed sources. Pass this acceptance only if no executable behavior changed; integrity checks alone do not verify code behavior.' } } : {};
    return { original_goal: state.goal, action_mode: this.grant(state, 'qa').mode, checks: checkFacts,
      ...(state.execution_plan ? { execution_plan: state.execution_plan } : {}), ...applicability, ...mechanisms, ...(component_reuse ? { component_reuse } : {}) };
  }
  async implementationNotes(state, notes = state?.artifacts.I?.implementation_notes ?? [], excludedPaths = state?.artifacts.I?.paths ?? [], { preparing = false } = {}) {
    const excluded = implementationVerdictExclusions(state?.artifacts.I);
    // Explicit paths in prepare/attach describe the prospective I, so protect those bytes too.
    if (preparing) for (const p of excludedPaths) {
      try { excluded.hashes.add((await this.workspace.readSource(p)).sha256); }
      catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; }
    }
    return inspectImplementationNotes(this.workspace, { notes, targets: state?.implementation_targets ?? [], allowedPaths: state ? [...state.scope, ...state.inputs] : undefined, excludedPaths, excludedHashes: excluded.hashes });
  }
  async manifest(state, { qa = false } = {}) {
    const excludedPaths = qa ? (state.artifacts.I?.paths ?? []) : [];
    const excluded = new Set(excludedPaths.map(workspacePathKey));
    const verdict = qa ? implementationVerdictExclusions(state.artifacts.I) : { hashes: new Set() };
    const allPaths = [...(state.inputs ?? []), ...(state.scope ?? []), ...Object.values(state.artifacts ?? {}).flatMap(a => a.paths)];
    const paths = [...new Map(allPaths.map(p => [workspacePathKey(p), p])).values()].filter(p => !excluded.has(workspacePathKey(p))).sort();
    const entries = [];
    for (const p of paths) {
      try { const { sha256: hash, size } = await this.workspace.readSource(p); if (!qa || !verdict.hashes.has(hash)) entries.push({ path: p, sha256: hash, size }); }
      catch (e) { if (e.code === 'SOURCE_UNAVAILABLE') entries.push({ path: p, missing: true }); else throw e; }
    }
    return { entries, digest: digest(entries) };
  }
  async basis(state, config = this.config(), { qa = false } = {}) {
    const manifest = await this.manifest(state, { qa });
    const notes = state.artifacts.I?.implementation_notes ?? [];
    const mechanisms = { ...(state.implementation_targets?.length || notes.length ? { implementation_targets: state.implementation_targets ?? [], implementation_notes: notes } : {}),
      ...(state.artifacts.I?.verdict_sources ? { verdict_sources: state.artifacts.I.verdict_sources } : {}) };
    const reuse = (state.contract_revision ?? 1) >= 2 ? { contract_revision: state.contract_revision, reuse_policy_digest: state.reuse_policy_digest, provider_identity: state.provider_identity,provider_workspace_id:state.provider_workspace_id, discovery_records: state.discovery_records, reuse_projection: state.artifacts.D?.reuse_projection?.digest ?? null, reuse_cursor: state.reuse_cursor ?? {}, discovery_inputs: await reuseInputFacts(this.workspace, this.store, state), ...(config.component_reuse?.mode === 'repository' ? { repository_inventory: await repositoryInventoryFacts(this.workspace, this.store, state, config) } : {}) } : {};
    const plan = state.contract_revision === 3 ? { configuration_snapshot: state.configuration_snapshot?.digest, execution_plan: state.execution_plan?.digest, qa_plan: state.qa_plan, toolchain: (state.execution_plan?.toolchain_facts ?? []).map(f => {
      let current = null; try { const s = fs.lstatSync(f.path); if (s.isFile() && !s.isSymbolicLink() && s.size <= 256 * 1024 * 1024) current = sha256(fs.readFileSync(f.path)); } catch {}
      return { ...f, current_sha256: current };
    }) } : {};
    return { manifest, digest: digest({ goal: state.goal, scope: state.scope, grant_id: state.grant_id, acceptance_ids: state.acceptance_ids, manifest: manifest.digest, config: config.digest, policy: config.policy, ...mechanisms, ...reuse, ...plan, environment: { node: process.version, platform: process.platform, arch: process.arch } }) };
  }
  async view(state = this.store.current()) {
    const config = this.config(state);
    if (config.schema_revision === 3) { const qa = qaCapability(this.store, this.authority, config); this.capabilities.qa_driver = qa.available; this.capabilities.qa = qa; }
    if (!state) {
      const detected = config.schema_revision === 3 ? await detectCheckCandidates({ workspace: this.workspace, config, env: this.configurationOptions.env }) : null;
      const qaCandidate = await discoverQaCandidate({ config, env: this.configurationOptions.env, hostModel: this.hostModel });
      return { ok: true, status: 'unbound', binding: null, configured: config.configured, configuration: config.configuration,
        missing_capabilities: config.missing_capabilities ?? [], check_candidates: detected, qa_candidate: qaCandidate, capabilities: this.capabilities,
        ...(config.registration_source_fact ? { registration_source_fact: config.registration_source_fact } : {}), ...(config.registration_candidate ? { registration_candidate: config.registration_candidate } : {}),
        next: [config.schema_revision === 3 ? 'Inspect existing sources and authority; prepare exact scope/check plan and reuse valid permission before begin. No project config file is required.' : 'Inspect sources and reuse or request exact operator permission before begin.'], coverage_limits: ['No cycle is active.'] };
    }
    const basis = await this.basis(state, config); const blockers = [];
    if (config.configuration_override_conflict) blockers.push({ code: 'POLICY_CONFLICT', reason: 'Explicit default overrides changed; the active profile is not silently migrated.' });
    let mode = null;
    try { mode = this.authority.load(state.grant_id).payload.mode; }
    catch { blockers.push({ code: 'DECISION_UNVERIFIED', reason: 'Current operator grant is missing, invalid or revoked.' }); }
    let reuse;
    try {
      reuse = await this.reuse(state, config);
      if (requiredReuseTargets(state, config, mode).length && (await providerIdentity(config)).identity !== state.provider_identity) throw fault('PROVIDER_UNAVAILABLE', 'Provider identity changed.');
    } catch { reuse = { status: 'unavailable', summary: { required_targets: 0, covered_targets: 0, decisions: 0, reads: 0, stale: 0, missing: 1 }, blocker: { kind: 'reuse', code: 'PROVIDER_UNAVAILABLE' }, evidence_refs: [] }; }
    if (reuse.blocker) blockers.push(reuse.blocker);
    const requiredChecks = config.checks.filter(c => mode !== 'docs' || c.kind === 'source-integrity');
    if (state.basis_digest !== basis.digest) blockers.push({ code: 'BINDING_STALE', reason: 'Relevant sources or policy changed; historical evidence is not current.' });
    if (state.pending_operation) {
      const op = this.store.operation(state.pending_request_id);
      blockers.push({ code: op?.phase === 'outcome_saved' && op.effects_known ? 'OPERATION_PENDING' : 'OUTCOME_UNKNOWN', operation_id: state.pending_operation });
    }
    for (const kind of ['R', 'D', 'I']) {
      const artifact = state.artifacts[kind];
      if (!artifact) { blockers.push({ code: 'SOURCE_UNAVAILABLE', kind }); continue; }
      const current = await this.workspace.readManifest(artifact.paths).catch(() => null);
      if (!current || current.digest !== artifact.manifest.digest) blockers.push({ code: 'EVIDENCE_INVALID', kind, reason: 'Attached authority record is missing or stale.' });
      try { const record = this.store.evidence(artifact.evidence.id).payload; if (record.cycle_id !== state.id || record.manifest.digest !== artifact.manifest.digest || digest(record.implementation_notes ?? []) !== digest(artifact.implementation_notes ?? [])) throw new Error('identity'); await this.workspace.verifySnapshot(record.snapshot); }
      catch { blockers.push({ code: 'EVIDENCE_INVALID', kind, reason: 'Archived authority evidence is incomplete or corrupt.' }); }
    }
    let implementationNotes;
    try { implementationNotes = await this.implementationNotes(state); }
    catch (error) { implementationNotes = { status: 'needs-update', summary: { invalid: 1 }, entries: [], semantic_verified: false, error: safeError(error) }; }
    if (implementationNotes.status === 'needs-update') blockers.push({ code: 'EVIDENCE_INVALID', kind: 'implementation_notes', reason: 'Declared mechanism notes are missing, stale or invalid; refresh their original sources and references.' });
    const qaBasis = await this.basis(state, config, { qa: true });
    let checksCurrent = state.checks?.basis_digest === qaBasis.digest && state.checks?.passed === true;
    if (checksCurrent) {
      try {
        const verification = this.store.evidence(state.checks.evidence.id).payload;
        if (!verification.passed || verification.basis_digest !== qaBasis.digest || verification.config_digest !== config.digest || verification.results.length !== requiredChecks.length || !requiredChecks.length) throw new Error('verification identity');
        for (const check of requiredChecks) {
          const summary = verification.results.find(r => r.check_id === check.id);
          if (!summary?.raw_ref) throw new Error('missing check');
          const original = this.store.evidence(summary.raw_ref.id).payload; const receipt = original.receipt;
          if (original.cycle_id !== state.id || original.input_basis !== qaBasis.digest || receipt.check_id !== check.id || !receipt.passed) throw new Error('invalid check facts');
          if (check.kind === 'source-integrity') { if (receipt.execution_kind !== 'source-integrity' || receipt.manifest_digest !== qaBasis.manifest.digest) throw new Error('source check identity'); }
          else if (receipt.argv_digest !== digest(check.argv) || receipt.launch_status !== 'started' || !receipt.terminal_observed || receipt.exit_code !== 0 || receipt.capture_error || receipt.cleanup_error || !receipt.output_complete || receipt.cancel_requested || receipt.timed_out) throw new Error('invalid execution facts');
        }
      } catch { checksCurrent = false; }
    }
    if (!checksCurrent) blockers.push({ code: 'EVIDENCE_INVALID', kind: 'checks' });
    if (state.contract_revision === 3 && mode === 'implement' && state.execution_plan?.behavioral.status === 'missing') blockers.push({ code: 'BEHAVIORAL_CHECKS_MISSING', kind: 'checks', reason: 'Executable behavior needs a real fixed behavioral check; source integrity is insufficient.' });
    let qa = null;
    if (state.qa_job) {
      const job = this.readJob(state.qa_job);
      if (job) {
        if (job.cycle_id !== state.id || job.workspace_id !== state.workspace_id) throw fault('BINDING_STALE', 'QA job belongs to another cycle/workspace.');
        const outcome = this.jobOutcome(job);
        qa = { job_id: job.id, status: outcome ? outcome.status : job.status, report_ref: outcome?.report_ref ?? null, assurance: outcome?.assurance ?? {}, terminal_observed: outcome?.terminal_observed === true, quiescent: outcome?.quiescent === true, current: job.basis_digest === qaBasis.digest, passed: outcome?.passed === true && outcome?.quiescent === true && job.basis_digest === qaBasis.digest };
      }
    }
    if (!qa?.passed) blockers.push({ code: qa?.status === 'running' ? 'OPERATION_PENDING' : 'QA_VERIFICATION_UNAVAILABLE', kind: 'independent_qa' });
    if (state.contract_revision === 3 && mode === 'implement' && state.execution_plan?.behavioral.status === 'not_applicable') {
      const report = qa?.passed && qa.report_ref ? this.store.evidence(qa.report_ref.id).payload.report : null;
      if (!report?.acceptance?.some(a => a.id === CHECK_APPLICABILITY_ID && a.status === 'pass')) blockers.push({ code: 'BEHAVIORAL_APPLICABILITY_UNVERIFIED', kind: 'check_applicability', reason: 'Independent QA must verify the actual diff does not change executable behavior.' });
    }
    for (const delta of Object.values(state.deltas ?? {})) if (['approved', 'sync_planned', 'partial'].includes(delta.status)) blockers.push({ code: 'AUTHORITY_CONFLICT', delta_id: delta.id, reason: 'Approved authority update remains unreconciled.' });
    if (state.lifecycle === 'interrupted') blockers.push({ code: 'OPERATION_PENDING', reason: 'Explicit resume is required.' });
    if (state.lifecycle === 'completed') {
      try {
        if (!state.completion_ref) throw new Error('missing completion');
        const complete = this.store.evidence(state.completion_ref.id).payload;
        if (complete.cycle_id !== state.id || complete.basis_digest !== basis.digest) throw new Error('completion binding');
        for (const ref of complete.evidence_refs) this.store.evidence(ref.id);
      } catch { blockers.push({ code: 'EVIDENCE_INVALID', kind: 'completion', reason: 'Historical completion archive is missing, corrupt or bound to old inputs.' }); }
    }
    const reuseView = { status: !reuse.blocker && qa?.passed && checksCurrent && reuse.status !== 'disabled' ? 'verified' : reuse.status, summary: reuse.summary, evidence_refs: (reuse.evidence_refs ?? []).slice(0, 8), ...(reuse.diagnostic ? { diagnostic: reuse.diagnostic } : {}), semantic_verified: false, delivery: 'unknown' };
    return { ok: true, binding: { workspace_id: this.store.workspaceId, cycle_id: state.id, revision: state.revision, basis_digest: basis.digest }, stage: qa?.passed && checksCurrent && implementationNotes.status !== 'needs-update' && !reuse.blocker ? 'ready' : state.stage, lifecycle: state.lifecycle, current_complete: state.lifecycle === 'completed' && blockers.length === 0, blockers, configured: config.configured, configuration: config.configuration, execution_plan: state.execution_plan ?? null, qa_candidate: state.qa_plan ?? null, pending_operation: state.pending_operation ?? null, required_check_ids: requiredChecks.map(c => c.id), implementation_notes: implementationNotes, reuse: reuseView, qa, evidence_refs: [...Object.values(state.artifacts).map(a => a.evidence), ...(state.checks ? [state.checks.evidence] : []), ...(qa?.report_ref ? [qa.report_ref] : []), ...(state.completion_ref ? [state.completion_ref] : [])], capabilities: this.capabilities, next: this.next(state, blockers), coverage_limits: ['Managed entry points only; external edits and unmatched Shell tools are detected, not prevented.', 'Semantic verdicts remain reported judgments.', config.component_reuse?.mode === 'repository' ? 'Repository inventory and supported static relationships only; unknown relations are retained and do not prove absence.' : 'Component discovery covers declared static ESM sources; captured bytes and returned views do not prove model comprehension.'] };
  }
  next(state, blockers) {
    if (state.pending_operation) return ['Inspect the existing operation; explicitly resume only known saved outcome. Never replay it.'];
    if (state.lifecycle === 'completed' || state.lifecycle === 'abandoned') return ['Keep the historical cycle; begin a new already-authorized goal if needed.'];
    if (blockers.some(b => b.kind === 'reuse')) return ['Inspect component reuse evidence/policy; discover/read current sources and prepare/attach the original D before source writes.'];
    if (blockers.some(b => b.kind && ['R', 'D', 'I'].includes(b.kind))) return ['Prepare and attach the missing/stale authority record.'];
    if (blockers.some(b => b.kind === 'implementation_notes')) return ['Update the original mechanism notes and their source identities; reattach I references before QA/finish.'];
    if (blockers.some(b => b.kind === 'checks')) return ['Run the configured checks with current binding.'];
    if (blockers.some(b => b.kind === 'independent_qa')) return ['Inspect QA capabilities/job; start only a verified driver on frozen inputs.'];
    return ['Reconcile approved authority updates, then submit the reported original-goal verdict to finish.'];
  }
  readJob(id) { if (!/^[a-z0-9-]+$/i.test(id)) throw fault('EVIDENCE_INVALID', 'Invalid job identity.'); return this.store.read(`jobs/${id}.json`, true); }
  jobOutcome(job) {
    const outcome = this.store.read(`jobs/${job.id}.outcome.json`, true);
    if (!outcome) return null;
    if (outcome.raw_ref) {
      const raw = this.store.evidence(outcome.raw_ref.id).payload;
      const reported = outcome.report_ref ? this.store.evidence(outcome.report_ref.id).payload : null;
      if (raw.job_id !== job.id || reported?.job_id !== job.id) throw fault('EVIDENCE_INVALID', 'QA result identity differs from the job.');
      const terminal = outcome.terminal_observed === true && raw.result.assurance.terminal_observed === true;
      const quiescent = raw.result.receipt?.launch_status === 'not_started' || terminal && !raw.result.receipt?.cleanup_error;
      return { ...outcome, terminal_observed: terminal, quiescent, passed: outcome.passed === true && raw.result.passed === true && quiescent && QA_ASSURANCE_KEYS.every(k => raw.result.assurance[k] === true), assurance: raw.result.assurance };
    }
    return { ...outcome, passed: false, quiescent: outcome.terminal_observed === true && outcome.launch_status === 'not_started' };
  }
  async assertBinding(state, binding) {
    if (!state || !binding) throw fault('BINDING_STALE', 'Explicit current cycle binding is required.');
    const view = await this.view(state);
    if (digest(binding) !== digest(view.binding)) throw fault('BINDING_STALE', 'Binding is stale or belongs to another cycle/workspace.', { current_binding: view.binding });
    return view;
  }
  grant(state, action, paths = []) {
    const record = this.authority.load(state.grant_id); const grant = record.payload;
    if (grant.kind !== 'action' || grant.goal_digest !== sha256(state.goal) || !grant.actions?.includes(action) || grant.mode === 'inspect') throw fault('SCOPE_DENIED', 'Operator grant does not permit this cycle action.');
    if (paths.some(p => !grant.paths.includes(p) || !state.scope.includes(p))) throw fault('SCOPE_DENIED', 'Every exact target must be within both cycle and operator scope.');
    if (action === 'apply' && grant.mode === 'docs' && paths.some(p => !document(p))) throw fault('SCOPE_DENIED', 'Docs-only permission cannot change code or configuration.');
    return grant;
  }
  async invoke(name, raw, { signal } = {}) {
    let args;
    try {
      const schema = TOOL_SCHEMAS[name]; if (!schema) throw fault('EVIDENCE_INVALID', 'Unknown cycle tool.');
      const parsed = schema.safeParse(raw); if (!parsed.success) throw fault('EVIDENCE_INVALID', 'Input does not satisfy the cycle contract.'); args = parsed.data;
      if (args.implementation_targets !== undefined && !(name === 'cycle_control' && args.action === 'begin')) throw fault('EVIDENCE_INVALID', 'Implementation targets are fixed at cycle begin.');
      if ((args.authority_paths !== undefined || args.check_plan !== undefined) && !(name === 'cycle_control' && args.action === 'begin')) throw fault('EVIDENCE_INVALID', 'Default authority and execution plans are fixed at cycle begin.');
      if (args.implementation_notes !== undefined && !(name === 'cycle_artifact' && args.kind === 'I')) throw fault('EVIDENCE_INVALID', 'Implementation-note references belong to the I artifact.');
      if (name === 'cycle_status') {
        if (args.evidence_id) { const record = this.store.evidence(args.evidence_id); const text = JSON.stringify(record); const page = textPage(text, args.offset, args.limit); if (page.next_offset === args.offset) throw fault('EVIDENCE_INVALID', 'Use a page limit of at least 2 for this Unicode character.'); return { ok: true, evidence_id: record.id, digest: record.digest, text: page.text, next_offset: page.next_offset }; }
        const state = this.store.current(); if (args.cycle_id && args.cycle_id !== state?.id) throw fault('BINDING_STALE', 'Only the explicit current cycle is available from status.');
        return await this.view(state);
      }
      if (name === 'cycle_artifact' && args.action === 'prepare') {
        const manifest = await this.workspace.readManifest(args.paths); const state = this.store.current(); const binding = state ? (await this.view(state)).binding : null;
        let remaining = 8192; const sources = [];
        for (const p of args.paths) { const src = await this.workspace.readSource(p); const content = textPage(src.content, 0, remaining).text; remaining -= content.length; sources.push({ path: p, sha256: src.sha256, content, truncated: src.content.length > content.length }); }
        const notes = args.implementation_notes === undefined ? null : await this.implementationNotes(state, args.implementation_notes, args.paths, { preparing: true });
        const reuse = args.kind === 'D' ? await this.prepareReuse(state, this.config(), args.paths) : null;
        return { ok: true, kind: args.kind, manifest, prepared_handle: artifactHandle(args, manifest, binding, reuse), binding, sources, ...(notes ? { implementation_notes: notes } : {}), ...(reuse ? { reuse_projection: reuse } : {}), omitted_sources_action: 'Read the original authorized source file or prepare a smaller paths set; this view creates no archive.' };
      }
      if (name === 'cycle_qa' && args.action === 'status') {
        const state = this.store.current(); const id = args.job_id ?? state?.qa_job; const job = id ? this.readJob(id) : null;
        if (!job || job.cycle_id !== state?.id) throw fault('BINDING_STALE', 'Job is not attached to this current cycle.');
        return { ...(await this.view(state)), job: { ...job, outcome: this.jobOutcome(job) } };
      }
      return await this.mutate(name, args, { signal });
    } catch (error) {
      const op = args?.request_id ? this.store.operation(args.request_id) : null;
      let state = null; try { state = await this.view(); } catch {}
      return { ...(state ?? {}), ok: false, error: safeError(error), ...(op ? { operation: op } : {}) };
    }
  }
  async mutate(name, args, { signal }) {
    let config = this.config(); if (!config.configuration?.effective || !this.capabilities.local_store) throw fault('CAPABILITY_UNAVAILABLE', 'A valid effective configuration and tested local-store platform are required before mutation.');
    if (!args.request_id) throw fault('EVIDENCE_INVALID', 'Persistent mutation requires request_id.');
    // Denied initialization is readonly. The same grant is rechecked inside the lease.
    if (name === 'cycle_control' && args.action === 'begin') this.authority.load(args.grant_id);
    else {
      const current = this.store.current();
      if (!current) throw fault('BINDING_STALE', 'Begin an authorized cycle before persistent work.');
      this.grant(current, name.replace('cycle_', ''), name === 'cycle_apply' ? args.targets.map(t => t.path) : []);
    }
    return this.store.withLease(async () => {
      const requestDigest = digest({ tool: name, args }); const previous = this.store.operation(args.request_id);
      if (previous) {
        if (previous.request_digest !== requestDigest) throw fault('REQUEST_CONFLICT', 'Request ID was reused with different parameters.');
        return { ...(await this.view()), ok: previous.phase === 'settled' && previous.result?.ok === true, duplicate: true, operation: this.operationSummary(previous), result: previous.result ?? null, ...(previous.phase !== 'settled' ? { error: { code: previous.phase === 'outcome_saved' ? 'OPERATION_PENDING' : 'OUTCOME_UNKNOWN', message: 'Existing request has not been settled; it will not run again.' } } : {}) };
      }
      let state = this.store.current();
      if (name === 'cycle_control' && args.action === 'begin') {
        if (state && ['active', 'interrupted'].includes(state.lifecycle)) throw fault('OPERATION_PENDING', 'One writable cycle already exists.');
        if (!args.goal || !args.grant_id || !args.scope || !args.inputs || !args.acceptance_ids?.length) throw fault('EVIDENCE_INVALID', 'Begin needs goal, grant_id, exact scope, inputs and acceptance IDs.');
        const scope = [...new Set(args.scope)]; const inputs = [...new Set(args.inputs)];
        if (config.schema_revision === 3) {
          const grant = this.authority.load(args.grant_id).payload;
          for (const p of inputs) {
            try { await this.workspace.readSource(p); }
            catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE' || !scope.includes(p) || !grant.paths?.includes(p)) throw error; }
          }
        } else await this.workspace.readManifest(inputs);
        state = { id: randomUUID(), workspace_id: this.store.workspaceId, goal: args.goal, grant_id: args.grant_id, scope, inputs, acceptance_ids: args.acceptance_ids, revision: 0, stage: 'requirements', lifecycle: 'active', artifacts: {}, deltas: {}, checks: null, qa_job: null, predecessor: state?.id ?? null };
        state.contract_revision = config.schema_revision;
        if (config.schema_revision === 3) config = await this.freezeDefaultPlan(state, args, config);
        else if (args.authority_paths !== undefined || args.check_plan !== undefined) throw fault('EVIDENCE_INVALID', 'Default plans require the new rev3 contract; legacy policy is not upgraded.');
        if (config.schema_revision >= 2) {
          state.reuse_policy_digest = digest(config.component_reuse ?? null); state.discovery_records = []; state.reuse_cursor = {}; state.provider_identity = null; state.provider_workspace_id = await providerWorkspaceIdentity(this.store.root);
          if (requiredReuseTargets(state, config, this.authority.load(state.grant_id).payload.mode).length) state.provider_identity = (await providerIdentity(config, { verifyFiles: true })).identity;
        }
        if (args.implementation_targets?.length) { state.implementation_targets = args.implementation_targets; await this.implementationNotes(state); }
        this.grant(state, 'control');
      } else {
        await this.assertBinding(state, args.binding);
        if (['completed', 'abandoned'].includes(state.lifecycle)) throw fault('SCOPE_DENIED', 'Terminal cycles are historical; begin a new cycle for current work.');
        this.grant(state, name.replace('cycle_', ''));
        if (state.pending_operation && !(name === 'cycle_control' && args.action === 'resume')) throw fault('OUTCOME_UNKNOWN', 'An existing pending operation requires explicit recovery; no new execution is allowed.');
      }
      await this.preflight(name, args, state, config);
      const op = { operation_id: randomUUID(), request_id: args.request_id, request_digest: requestDigest, tool: name, input_binding: args.binding ?? null, cycle_id: state.id, phase: 'pending', effects_known: false, started_at: new Date().toISOString() };
      this.store.saveOperation(op);
      if (name === 'cycle_control' && args.action === 'resume' && state.pending_operation) {
        // Retain the old pending identity until its immutable outcome proves recovery.
      } else {
        state.pending_operation = op.operation_id; state.pending_request_id = op.request_id; this.store.write('current.json', state);
      }
      try {
        const result = await this.perform(name, args, state, op, config, signal);
        const afterBasis = await this.basis(state, this.config());
        state.basis_digest = afterBasis.digest; state.revision += 1;
        if (result.effects_known === false) state.lifecycle = 'interrupted';
        else { state.pending_operation = null; state.pending_request_id = null; }
        const ref = this.store.archive('outcome', { operation_id: op.operation_id, result, state });
        op.phase = 'outcome_saved'; op.effects_known = result.effects_known ?? true; op.outcome_ref = ref; op.result = { ok: result.ok !== false, ...result }; this.store.saveOperation(op);
        await this.faultInjector?.('after_outcome', { state, op });
        this.store.write('current.json', state);
        if (result.effects_known !== false) { op.phase = 'settled'; this.store.saveOperation(op); }
        return { ...(await this.view(state)), ok: result.ok !== false, operation: this.operationSummary(op), result };
      } catch (error) {
        const known = this.store.operation(args.request_id);
        if (known?.phase !== 'outcome_saved' && known?.phase !== 'settled') {
          op.failure = safeError(error); op.effects_known = error.details?.effects_known ?? false; state.lifecycle = 'interrupted';
          if (op.effects_known) {
            try {
              state.pending_operation = null; state.pending_request_id = null; state.revision += 1; state.basis_digest = (await this.basis(state)).digest;
              const result = { ok: false, error: op.failure, effects_known: true, ...(error.details?.effects ? { effects: error.details.effects, changed_paths: error.details.changed_paths ?? [] } : {}) };
              op.outcome_ref = this.store.archive('outcome', { operation_id: op.operation_id, result, state }); op.result = result; op.phase = 'outcome_saved'; this.store.saveOperation(op);
              this.store.write('current.json', state); op.phase = 'settled'; this.store.saveOperation(op);
            } catch { op.phase = 'unknown'; try { this.store.saveOperation(op); } catch {} }
          } else { op.phase = 'unknown'; try { this.store.saveOperation(op); this.store.write('current.json', state); } catch {} }
        }
        throw error;
      }
    }, { signal });
  }
  operationSummary(op) { return { operation_id: op.operation_id, request_id: op.request_id, phase: op.phase, effects_known: op.effects_known, outcome_ref: op.outcome_ref ?? null }; }
  async preflight(name, args, state, config) {
    if (config.configuration_override_conflict && !(name === 'cycle_control' && args.action === 'abandon')) throw fault('POLICY_CONFLICT', 'Explicit project/user overrides changed; restore them or abandon this frozen profile before migration.');
    if (reusePolicyConflict(state, config) && !(name === 'cycle_control' && args.action === 'abandon')) throw fault('POLICY_CONFLICT', 'Restore the fixed cycle configuration or explicitly abandon it before migration.');
    if (name === 'cycle_control' && args.action === 'abandon') {
      const job = state.qa_job ? this.readJob(state.qa_job) : null;
      if (job && !this.jobOutcome(job)?.quiescent) throw fault('OPERATION_PENDING', 'Observe QA cancellation before abandoning this cycle.');
    }
    if (name === 'cycle_control' && args.action === 'finish') {
      const view = await this.view(state);
      if (view.blockers.length) throw fault('EVIDENCE_INVALID', 'Finish prerequisites are unmet.', { blockers: view.blockers, effects_known: true });
      const v = args.semantic_verdict;
      if (!v?.original_goal_covered || v.unresolved_findings.length || !v.evidence_refs.length) throw fault('EVIDENCE_INVALID', 'Original-goal verdict is missing or has unresolved findings.');
    }
    if (name === 'cycle_control' && args.action === 'resume' && state.pending_operation) {
      const old = this.store.operation(state.pending_request_id);
      if (old?.completion_expected_ref) this.store.evidence(old.completion_expected_ref.id);
      else {
        if (!old?.outcome_ref || !old.effects_known || !['outcome_saved','settled'].includes(old.phase)) throw fault('OUTCOME_UNKNOWN', 'The existing action has no verifiable saved outcome; resume cannot replay it.');
        this.store.evidence(old.outcome_ref.id);
      }
    }
    if (name === 'cycle_artifact' && ['discover','read'].includes(args.action)) {
      if (!config.component_reuse || this.grant(state,'artifact').mode === 'docs') throw fault('SCOPE_DENIED', 'Component discovery requires an enabled implement cycle and its independent read scope.');
      if ((state.discovery_records ?? []).length >= 256) throw fault('SNAPSHOT_INCOMPLETE', 'This cycle has reached its bounded discovery evidence limit.');
      if ((await providerIdentity(config, { verifyFiles: true })).identity !== state.provider_identity) throw fault('PROVIDER_UNAVAILABLE', 'Provider changed after begin.');
      const policy = config.component_reuse;
      if (policy.mode === 'repository') {
        const requested = args.action === 'read' ? [args.path] : args.query.paths;
        if (requested.some(p => !discoveryAllows(policy.discovery_scope, p))) throw fault('SCOPE_DENIED', 'Requested paths are outside the independent discovery scope.');
        const excluded = implementationVerdictExclusions(state.artifacts.I);
        for (const p of requested) {
          if (policy.documentation_paths.includes(p)) throw fault('SCOPE_DENIED', 'Authority documents are outside repository source discovery.');
          try { const source = await this.workspace.readSource(p); if (excluded.hashes.has(source.sha256)) throw fault('SCOPE_DENIED', 'Discovery cannot deliver implementation-verdict bytes.'); }
          catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; }
        }
        return;
      }
      if (!discoveryAllows(policy.discovery_scope,policy.architecture_path)) throw fault('SCOPE_DENIED','Declaration is outside discovery scope.');
      const declaration = await this.workspace.readSource(policy.architecture_path);
      let index; try { index = JSON.parse(declaration.content); } catch { throw fault('EVIDENCE_INVALID','Architecture declaration is malformed.'); }
      if (!Array.isArray(index.modules) || index.modules.length > 100) throw fault('EVIDENCE_INVALID','Architecture declaration has no bounded module list.');
      const p = [...new Set([policy.architecture_path, ...index.modules.flatMap(m => (m.source ?? []).map(s => s.path)), ...(args.action === 'read' ? [args.path] : args.query.paths)])];
      if (p.length > 256 || p.some(p => !discoveryAllows(policy.discovery_scope,p))) throw fault('SCOPE_DENIED','All indexed sources must be inside independent discovery scope before the provider reads them.');
      const excluded = implementationVerdictExclusions(state.artifacts.I);
      for (const path of p) { try { const source = await this.workspace.readSource(path); if (excluded.hashes.has(source.sha256)) throw fault('SCOPE_DENIED','Discovery cannot deliver captured bytes of the I verdict.'); } catch (e) { if (e.code !== 'SOURCE_UNAVAILABLE') throw e; } }
      return;
    }
    if (name === 'cycle_artifact') {
      if (state.contract_revision === 3 && ['R','D','I'].includes(args.kind) && state.authority_paths?.[args.kind]
        && digest(args.paths) !== digest(state.authority_paths[args.kind])) throw fault('SCOPE_DENIED', 'Attach the planned original authority paths for this artifact kind.');
      const manifest = await this.workspace.readManifest(args.paths);
      const reuse = args.kind === 'D' ? await this.prepareReuse(state,config,args.paths) : null;
      if (!args.prepared_handle || artifactHandle(args, manifest, args.binding,reuse) !== args.prepared_handle) throw fault('BINDING_STALE', 'Prepare current authority inputs before attaching them.');
      if (args.kind === 'I') {
        const notes = args.implementation_notes ?? [];
        const targetKeys = new Set([...(state.implementation_targets ?? []).map(t => JSON.stringify([t.path, t.symbol])), ...notes.map(n => JSON.stringify([n.source.path, n.source.symbol]))]);
        if (targetKeys.size > 16) throw fault('EVIDENCE_INVALID', 'This cycle can track at most 16 declared implementation targets.');
        const inspection = await this.implementationNotes(state, notes, args.paths, { preparing: true });
        if (inspection.entries.some(e => e.documentation && e.status !== 'current')) throw fault('BINDING_STALE', 'Implementation-note source or prose changed before attachment.');
      }
    }
    if (name === 'cycle_apply') {
      this.grant(state, 'apply', args.targets.map(t => t.path));
      const required = requiredReuseTargets(state,config,this.grant(state,'apply').mode);
      if (args.targets.some(t => required.includes(t.path))) {
        assertReuseReady(await this.reuse(state,config));
        if ((await providerIdentity(config,{verifyFiles:true})).identity !== state.provider_identity) throw fault('PROVIDER_UNAVAILABLE','Provider changed before source write.');
      }
      for (const target of args.targets) {
        let actual = null; try { actual = (await this.workspace.readSource(target.path)).sha256; } catch (e) { if (e.code !== 'SOURCE_UNAVAILABLE') throw e; }
        if (actual !== target.expected_sha256) throw fault('AUTHORITY_CONFLICT', 'A target’s expected before-state changed.', { path: target.path });
      }
    }
    if (name === 'cycle_verify' && (args.check_ids.some(id => !config.checks.some(c => c.id === id)) || new Set(args.check_ids).size !== args.check_ids.length)) throw fault('EVIDENCE_INVALID', 'Every selected check must be registered once.');
    if (name === 'cycle_verify' && state.contract_revision === 3) for (const fact of state.execution_plan.toolchain_facts) {
      const stat = fs.lstatSync(fact.path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024 * 1024 || sha256(fs.readFileSync(fact.path)) !== fact.sha256) throw fault('POLICY_CONFLICT', 'A fixed check executable or npm CLI changed before verification.');
    }
    if (name === 'cycle_verify' && this.grant(state, 'verify').mode === 'docs' && args.check_ids.some(id => config.checks.find(c => c.id === id).kind !== 'source-integrity')) throw fault('SCOPE_DENIED', 'Docs-only cycles may only run the builtin readonly source-integrity check, not arbitrary configured commands.');
    if (name === 'cycle_qa') {
      if (args.action === 'start') {
        assertReuseReady(await this.reuse(state,config));
        if (!config.qa || !this.capabilities.qa_driver) throw fault('QA_VERIFICATION_UNAVAILABLE', 'No calibrated QA driver is available.');
        const view = await this.view(state); if (view.blockers.some(b => ['R','D','I','checks','implementation_notes'].includes(b.kind))) throw fault('EVIDENCE_INVALID', 'Current authority records, mechanism notes and checks are required before QA.');
        assertQaDeliveryBudget((await this.basis(state, config, {qa:true})).manifest, this.qaContext(state, config, await this.reuse(state, config)));
        const job = state.qa_job ? this.readJob(state.qa_job) : null; if (job && !this.jobOutcome(job)?.quiescent) throw fault('OPERATION_PENDING', 'A QA job is still active or unknown.');
      } else {
        const job = this.readJob(args.job_id ?? state.qa_job ?? ''); if (!job || job.cycle_id !== state.id) throw fault('BINDING_STALE', 'Cancel requires this cycle’s job.');
      }
    }
    if (name === 'cycle_reconcile' && args.action === 'approve') {
      const delta = state.deltas[args.delta_id]; const decision = this.authority.load(args.decision_id).payload;
      if (!delta || decision.kind !== 'requirement' || decision.cycle_id !== state.id || decision.delta_id !== delta.id || decision.delta_digest !== delta.digest) throw fault('DECISION_UNVERIFIED', 'Decision must match this exact Delta revision.');
    }
    if (name === 'cycle_reconcile' && args.action === 'plan') {
      const delta = state.deltas[args.delta_id];
      if (!delta || !['approved','sync_planned','partial'].includes(delta.status) || !args.targets?.length) throw fault('DECISION_UNVERIFIED', 'Approve the exact Delta before planning sync.');
      this.grant(state, 'apply', args.targets.map(t => t.path));
      const authority = new Set(['R','D'].flatMap(k => state.artifacts[k]?.paths ?? []));
      if (args.targets.some(t => !authority.has(t.path))) throw fault('SCOPE_DENIED', 'Writeback targets must be mapped original authority.');
    }
  }
  async perform(name, args, state, op, config, signal) {
    if (name === 'cycle_artifact' && ['discover','read'].includes(args.action)) {
      const captured = await captureComponent({ store:this.store, workspace:this.workspace, state, config, args, operation:op, signal, onStarted: async facts => { op.launch = facts; this.store.saveOperation(op); } });
      const attempt = this.store.archive('reuse-attempt',{cycle_id:state.id,operation_id:op.operation_id,receipt:captured.receipt,cache_inventory:captured.cache_inventory,error:captured.error});
      if (!captured.ok) return { ok:false,error:captured.error ?? {code:'PROVIDER_UNAVAILABLE',message:'Component evidence capture or cleanup was incomplete.'},receipt:captured.receipt,attempt_ref:attempt,effects_known:captured.effects_known };
      const payload = {cycle_id:state.id,workspace_id:state.workspace_id,operation_id:op.operation_id,policy_digest:state.reuse_policy_digest,...captured.data,...(args.action==='read'?{path:args.path,line_ranges:args.line_ranges}:{query:args.query}),attempt_ref:attempt};
      if (Buffer.byteLength(JSON.stringify(payload)) > 3 * 1024 * 1024) throw fault('SNAPSHOT_INCOMPLETE','Component evidence exceeds the bounded Store record.',{effects_known:true});
      const kind = args.action === 'read' ? 'reuse-source' : 'reuse-query';
      let view;
      if (args.action === 'read') {
        const lines = payload.raw_text.split(/\r\n|\n|\r/);
        if (args.line_ranges.some(r => r.end_line > lines.length)) throw fault('EVIDENCE_INVALID','Requested source lines are out of range.',{effects_known:true,available_lines:lines.length,path:args.path});
        view = args.line_ranges.map(r=>({ ...r,content:lines.slice(r.start_line-1,r.end_line).join('\n') }));
        state.inputs = [...new Set([...state.inputs,args.path])];
      } else {
        const query = JSON.parse(payload.raw_text);
        view = config.component_reuse.mode === 'repository' ? { coverage: query.coverage, collection_stable: query.collection_stable, candidates: query.candidates, relations: query.relations, unresolved: query.unresolved } : query.selected;
        if (config.component_reuse.architecture_path) state.inputs = [...new Set([...state.inputs,config.component_reuse.architecture_path])];
      }
      const selection = args.action === 'discover' ? await reuseSelectionView(this.workspace,state,config,payload) : null;
      if (selection?.code === 'SCOPE_DENIED') throw fault('SCOPE_DENIED','Discovery view is blocked by the independent read scope or I exclusion.',{effects_known:true});
      const ref = this.store.archive(kind,payload); state.discovery_records.push(ref);
      const text = JSON.stringify(view); const page = textPage(text,0,8192);
      const sourceView = args.action === 'read' ? { complete:true,path:args.path,sha256:payload.raw_sha256,line_count:payload.raw_text.split(/\r\n|\n|\r/).length,snippets:view } : null;
      const structured = args.action === 'discover' ? { reuse_selection: selection }
        : { source_view: Buffer.byteLength(JSON.stringify(sourceView)) <= 16384 ? sourceView
          : {complete:false,path:args.path,code:'SOURCE_VIEW_TOO_LARGE',next:'Read a smaller line range; use the original archive only for explicit audit.'} };
      return {ok:true,evidence:ref,source_capture_complete:true,view_text:page.text,view_complete:page.next_offset===null,truncated:page.next_offset!==null,...structured,delivery:'unknown',receipt:captured.receipt,attempt_ref:attempt,effects_known:true};
    }
    if (signal?.aborted) throw fault('OPERATION_FAILED', 'Cancelled before execution.', { effects_known: true });
    if (name === 'cycle_control') {
      if (args.action === 'begin') return { effects_known: true, registered: state.id };
      if (args.action === 'resume') {
        if (state.pending_operation && state.pending_operation !== op.operation_id) {
          const previous = this.store.operation(state.pending_request_id);
          if (previous?.completion_expected_ref) {
            const candidate = this.store.evidence(previous.completion_expected_ref.id).payload;
            if (candidate.operation_id !== previous.operation_id || candidate.cycle_id !== state.id) throw fault('EVIDENCE_INVALID', 'Completion candidate belongs to another operation.');
            const current = await this.basis(state, this.config());
            const view = await this.view(state);
            const requiredBlockers = view.blockers.filter(b => b.operation_id !== state.pending_operation && b.reason !== 'Explicit resume is required.');
            if (current.digest === candidate.basis_digest && !requiredBlockers.length) { state.completion_ref = previous.completion_expected_ref; state.lifecycle = 'completed'; state.stage = 'ready'; }
            else { state.lifecycle = 'active'; state.completion_candidate_stale = previous.completion_expected_ref; }
            previous.result = { ok: state.lifecycle === 'completed', effects_known: true, completion_ref: previous.completion_expected_ref, publication_current: state.lifecycle === 'completed' };
            previous.phase = 'settled'; previous.effects_known = true; this.store.saveOperation(previous);
          } else {
            if (!previous?.outcome_ref || !previous.effects_known || !['outcome_saved', 'settled'].includes(previous.phase)) throw fault('OUTCOME_UNKNOWN', 'No verified saved outcome exists; resume will not replay the original action.');
            const saved = this.store.evidence(previous.outcome_ref.id).payload;
            if (saved.operation_id !== previous.operation_id || saved.state.id !== state.id) throw fault('EVIDENCE_INVALID', 'Recovery evidence belongs to another operation.');
            Object.assign(state, saved.state); previous.phase = 'settled'; this.store.saveOperation(previous);
          }
        }
        if (state.lifecycle === 'interrupted') state.lifecycle = 'active';
        return { resumed: true, effects_known: true, runner_replayed: false };
      }
      if (args.action === 'abandon') {
        const job = state.qa_job ? this.readJob(state.qa_job) : null;
        if (job && !this.jobOutcome(job)?.quiescent) throw fault('OPERATION_PENDING', 'Cancel and observe the active QA job before abandon.');
        state.lifecycle = 'abandoned'; state.abandon_reason = args.reason ?? ''; return { abandoned: true, effects_known: true };
      }
      const before = await this.view(state);
      const blockers = before.blockers.filter(b => b.operation_id !== op.operation_id);
      if (blockers.length) throw fault('EVIDENCE_INVALID', 'Finish prerequisites are unmet.', { blockers, effects_known: true });
      const verdict = args.semantic_verdict;
      if (!verdict?.original_goal_covered || verdict.unresolved_findings.length || !verdict.evidence_refs.length) throw fault('EVIDENCE_INVALID', 'A reported original-goal verdict with valid evidence and no unresolved findings is required.', { effects_known: true });
      for (const id of verdict.evidence_refs) this.store.evidence(id);
      const requiredRefs = new Set(before.evidence_refs.map(r => r.id));
      if (verdict.evidence_refs.some(id => !requiredRefs.has(id))) throw fault('EVIDENCE_INVALID', 'Semantic verdict must refer to this cycle’s current evidence.');
      const basis = (await this.basis(state, config)).digest;
      const completionPayload = { operation_id: op.operation_id, cycle_id: state.id, basis_digest: basis, evidence_refs: before.evidence_refs, semantic_verdict: { reported: verdict, correctness_verified: false }, completed_at: new Date().toISOString() };
      const completionDigest = digest(completionPayload);
      op.completion_expected_ref = { id: `completion-${completionDigest}`, digest: completionDigest, kind: 'completion', schema_revision: 1 }; this.store.saveOperation(op);
      const completion = this.store.archive('completion', completionPayload);
      await this.faultInjector?.('before_finish_publish', { state, op });
      if ((await this.basis(state, this.config())).digest !== basis) throw fault('BINDING_STALE', 'Sources or policy changed before completion publication.');
      state.completion_ref = completion; state.lifecycle = 'completed'; state.stage = 'ready';
      return { completion_ref: completion, effects_known: true };
    }
    if (name === 'cycle_artifact') {
      if (!args.prepared_handle) throw fault('EVIDENCE_INVALID', 'Attach needs a prepared handle.');
      const manifest = await this.workspace.readManifest(args.paths);
      const reuse = args.kind === 'D' ? await this.prepareReuse(state,config,args.paths) : null;
      if (artifactHandle(args, manifest, args.binding,reuse) !== args.prepared_handle) throw fault('BINDING_STALE', 'Prepared authority inputs changed.');
      const notes = args.implementation_notes ?? [];
      if (args.kind === 'I') {
        const inspection = await this.implementationNotes(state, notes, args.paths);
        if (inspection.entries.some(e => e.documentation && e.status !== 'current')) throw fault('BINDING_STALE', 'Implementation notes changed before evidence capture.', { effects_known: true });
      }
      const snapshot = await this.workspace.snapshot(args.paths, this.store.ensureDirectory('snapshots'));
      if (snapshot.manifest.digest !== manifest.digest || (await this.workspace.readManifest(args.paths)).digest !== manifest.digest) throw fault('BINDING_STALE', 'Authority changed during evidence capture.');
      let verdict_sources;
      if (args.kind === 'I') {
        const observed = await Promise.all(args.paths.map(async p => {
          const source = await this.workspace.readSource(p);
          if (manifest.entries.find(e => e.path === p)?.sha256 !== source.sha256) throw fault('BINDING_STALE','I bytes changed while capturing physical identity.',{effects_known:true});
          return { file_id: source.file_id, sha256: source.sha256 };
        }));
        const prior = [...(state.artifacts.I?.verdict_sources ?? []), ...(state.artifacts.I?.manifest.entries ?? []).map(e => ({file_id:null,sha256:e.sha256}))];
        verdict_sources = [...new Map([...prior,...observed].map(s => [JSON.stringify(s),s])).values()];
        if (verdict_sources.length > 256) throw fault('SNAPSHOT_INCOMPLETE','I exclusion history exceeds this cycle bound; use a new authorized cycle.',{effects_known:true});
      }
      const metadata = { ...(args.implementation_notes !== undefined ? { implementation_notes: notes } : {}), ...(reuse ? {reuse_projection:reuse} : {}), ...(verdict_sources ? {verdict_sources} : {}) };
      if (reuse && reuse.digest !== state.artifacts.D?.reuse_projection?.digest) state.reuse_cursor = {};
      const ref = this.store.archive('artifact', { kind: args.kind, paths: args.paths, manifest, snapshot, cycle_id: state.id, source: 'observed_bytes', semantic_status: 'reported', ...metadata });
      state.artifacts[args.kind] = { paths: args.paths, manifest, evidence: ref, ...metadata }; state.inputs = [...new Set([...state.inputs, ...args.paths, ...implementationPaths(notes)])];
      if (notes.length) {
        const targets = [...(state.implementation_targets ?? []), ...notes.map(n => ({ path: n.source.path, symbol: n.source.symbol }))];
        state.implementation_targets = [...new Map(targets.map(t => [JSON.stringify([t.path, t.symbol]), t])).values()];
      }
      state.stage = args.kind === 'R' ? 'design' : args.kind === 'D' ? 'implementation' : args.kind === 'I' ? 'qa' : 'reconciliation';
      return { accepted: true, semantic_verified: false, evidence: ref, effects_known: true };
    }
    if (name === 'cycle_apply') {
      this.grant(state, 'apply', args.targets.map(t => t.path));
      const reuse = await this.reuse(state,config);
      if (args.targets.some(t => requiredReuseTargets(state,config,this.grant(state,'apply').mode).includes(t.path))) {
        try { assertReuseReady(reuse); } catch (error) { throw fault(error.code,'Component source drifted before the managed write.',{effects_known:true}); }
      }
      const result = await this.workspace.apply(args.targets, { signal, createParents: state.contract_revision === 3, onEffect: async effect => { op.effects = [...(op.effects ?? []), effect]; op.effects_known = true; this.store.saveOperation(op); await this.faultInjector?.(effect.kind === 'directory' ? 'after_directory_effect' : 'after_file_effect', { state, op, effect }); } });
      if (reuse.projection && result.effects_known !== false) for (const effect of op.effects ?? []) {
        const k = workspacePathKey(effect.path);
        if (effect.kind !== 'directory' && reuse.roles[k] === 'consumer') state.reuse_cursor[k] = {sha256:effect.after?.sha256 ?? null,request_id:op.request_id,projection_digest:reuse.projection.digest};
      }
      state.inputs = [...new Set([...state.inputs, ...args.targets.map(t => t.path)])]; state.stage = 'implementation';
      return result;
    }
    if (name === 'cycle_verify') {
      const selected = args.check_ids.map(id => config.checks.find(c => c.id === id));
      if (selected.some(c => !c) || !selected.length) throw fault('EVIDENCE_INVALID', 'Checks must be registered in project config.');
      if (new Set(args.check_ids).size !== args.check_ids.length) throw fault('EVIDENCE_INVALID', 'Duplicate checks are not a second validation.');
      const before = await this.basis(state, config, { qa: true }); const results = [];
      for (const check of selected) {
        const receipt = check.kind === 'source-integrity'
          ? { check_id: check.id, execution_kind: 'source-integrity', manifest_digest: before.manifest.digest, passed: true, launch_status: 'not_started', terminal_observed: false, exit_code: null, stdout: '', stderr: '', output_complete: true, capture_error: null, cleanup_error: null }
          : await runCheck(check, { cwd: this.store.root, signal, timeoutMs: check.timeout_ms, onStarted: async started => { op.launch = started; this.store.saveOperation(op); } });
        const raw = this.store.archive('check', { cycle_id: state.id, input_basis: before.digest, receipt });
        const { stdout, stderr, ...facts } = receipt;
        results.push({ ...facts, raw_ref: raw });
        if (!receipt.passed) break;
      }
      const after = await this.basis(state, this.config(), { qa: true });
      const required = config.checks.filter(c => this.grant(state, 'verify').mode !== 'docs' || c.kind === 'source-integrity').map(c => c.id);
      const passed = required.length > 0 && before.digest === after.digest && results.length === required.length && required.every(id => results.some(r => r.check_id === id && r.passed));
      const ref = this.store.archive('verification', { basis_digest: before.digest, config_digest: config.digest, required, results, passed });
      state.checks = { evidence: ref, basis_digest: before.digest, passed }; state.stage = 'qa';
      return { ok: passed, effects_known: results.every(r => r.terminal_observed || r.launch_status === 'not_started'), passed, results, evidence: ref, ...(passed ? {} : { error: { code: before.digest !== after.digest ? 'BINDING_STALE' : 'OPERATION_FAILED', message: 'Required checks did not pass on current inputs.' } }) };
    }
    if (name === 'cycle_reconcile') return this.reconcile(args, state);
    if (name === 'cycle_qa') return this.qaAction(args, state, op, config);
    throw fault('EVIDENCE_INVALID', 'Unknown cycle action.');
  }
  async reconcile(args, state) {
    if (args.action === 'propose') {
      if (!args.description || state.deltas[args.delta_id]) throw fault('EVIDENCE_INVALID', 'A new Delta needs a description and unique identity.');
      state.deltas[args.delta_id] = { id: args.delta_id, description: args.description, digest: digest({ delta_id: args.delta_id, description: args.description }), status: 'proposed' };
    } else {
      const delta = state.deltas[args.delta_id]; if (!delta) throw fault('EVIDENCE_INVALID', 'Delta was not proposed.');
      if (args.action === 'approve') {
        const decision = this.authority.load(args.decision_id).payload;
        if (decision.kind !== 'requirement' || decision.cycle_id !== state.id || decision.delta_id !== delta.id || decision.delta_digest !== delta.digest) throw fault('DECISION_UNVERIFIED', 'Decision does not approve this exact Delta revision.');
        delta.status = 'approved'; delta.decision_id = args.decision_id;
      } else if (args.action === 'plan') {
        if (!['approved', 'sync_planned', 'partial'].includes(delta.status) || !args.targets?.length) throw fault('DECISION_UNVERIFIED', 'Approve the Delta before authority synchronization.');
        this.grant(state, 'apply', args.targets.map(t => t.path));
        const authorityPaths = new Set(['R', 'D'].flatMap(k => state.artifacts[k]?.paths ?? []));
        if (args.targets.some(t => !authorityPaths.has(t.path))) throw fault('SCOPE_DENIED', 'Sync targets must be mapped original R/D authority files.');
        delta.plan = args.targets.map(t => ({ path: t.path, before: t.expected_sha256, after: t.action === 'delete' ? null : sha256(t.content) })); delta.status = 'sync_planned';
      } else {
        if (!delta.plan) throw fault('AUTHORITY_CONFLICT', 'Delta has no authority sync plan.');
        const observations = [];
        for (const target of delta.plan) {
          let actual = null; try { actual = (await this.workspace.readSource(target.path)).sha256; } catch (e) { if (e.code !== 'SOURCE_UNAVAILABLE') throw e; }
          observations.push({ path: target.path, state: actual === target.after ? 'after' : actual === target.before ? 'before' : 'conflict', actual });
        }
        if (observations.some(o => o.state === 'conflict')) throw fault('AUTHORITY_CONFLICT', 'Original authority has an external third state; it will not be overwritten.', { observations, effects_known: true });
        if (observations.some(o => o.state !== 'after')) { delta.status = 'partial'; return { ok: false, effects_known: true, delta, observations, error: { code: 'OPERATION_PARTIAL', message: 'Authority sync is incomplete; explicitly apply remaining before-state targets under current permission.' } }; }
        delta.status = 'incorporated'; delta.sync_evidence = this.store.archive('sync', { cycle_id: state.id, delta_id: delta.id, observations, implemented: false });
      }
    }
    state.stage = 'reconciliation'; return { delta: state.deltas[args.delta_id], effects_known: true };
  }
  async qaAction(args, state, op, config) {
    if (args.action === 'cancel') {
      const job = this.readJob(args.job_id ?? state.qa_job ?? '');
      if (!job || job.cycle_id !== state.id) throw fault('BINDING_STALE', 'Cancel only this cycle’s existing QA job.');
      const outcome = this.jobOutcome(job);
      if (outcome?.quiescent) return { job_id: job.id, cancel_requested: false, terminal_observed: outcome.terminal_observed === true, effects_known: true };
      job.cancel_requested = true; this.store.write(`jobs/${job.id}.json`, job);
      return { ...(outcome ? { ok: false, error: { code: 'OUTCOME_UNKNOWN', message: 'Cancellation was requested, but the prior QA terminal/cleanup is unverified.' } } : {}), job_id: job.id, cancel_requested: true, terminal_observed: false, effects_known: true };
    }
    if (!config.qa || !this.capabilities.qa_driver) throw fault('QA_VERIFICATION_UNAVAILABLE', 'No calibrated CLI QA driver is configured. Native subagent observation is unavailable.');
    const existing = state.qa_job ? this.readJob(state.qa_job) : null;
    if (existing && !this.jobOutcome(existing)?.quiescent) throw fault('OPERATION_PENDING', 'The existing QA job has no verified terminal result.');
    const view = await this.view(state);
    if (view.blockers.some(b => ['R', 'D', 'I', 'checks', 'implementation_notes', 'reuse'].includes(b.kind))) throw fault('EVIDENCE_INVALID', 'Current R/D/I, component evidence, mechanism notes and configured checks are required before QA.');
    const basis = await this.basis(state, config, { qa: true });
    if (basis.manifest.entries.some(e => e.missing && ['R', 'D'].some(k => state.artifacts[k]?.paths.includes(e.path)))) throw fault('SNAPSHOT_INCOMPLETE', 'Required authority input is missing.');
    const paths = basis.manifest.entries.filter(e => !e.missing).map(e => e.path);
    const snapshot = await this.workspace.snapshot(paths, this.store.ensureDirectory('snapshots'));
    if (snapshot.manifest.entries.some(e => !basis.manifest.entries.some(expected => expected.path === e.path && expected.sha256 === e.sha256 && expected.size === e.size))) throw fault('BINDING_STALE', 'Frozen QA bytes differ from the intended basis.');
    if ((await this.basis(state, this.config(), { qa: true })).digest !== basis.digest) throw fault('BINDING_STALE', 'Inputs changed while freezing QA.');
    const reuse = await this.reuse(state,config);
    const qa_context = this.qaContext(state, config, reuse); assertQaDeliveryBudget(snapshot.manifest, qa_context);
    const snapshotRef = this.store.archive('snapshot', { snapshot, cycle_id: state.id, basis_digest: basis.digest, qa_context });
    const acceptance = [...state.acceptance_ids, ...(state.contract_revision === 3 && this.grant(state,'qa').mode === 'implement' && state.execution_plan.behavioral.status === 'not_applicable' ? [CHECK_APPLICABILITY_ID] : [])];
    if (acceptance.length > 128 || new Set(acceptance).size !== acceptance.length) throw fault('EVIDENCE_INVALID', 'QA acceptance IDs must remain unique and within the report budget.');
    const job = { id: randomUUID(), cycle_id: state.id, workspace_id: state.workspace_id, basis_digest: basis.digest, config_digest: config.digest, snapshot_ref: snapshotRef, acceptance_ids: acceptance, status: 'pending', cancel_requested: false, created_at: new Date().toISOString(), worker_pid: null, driver: config.qa };
    this.store.write(`jobs/${job.id}.json`, job, { immutable: true });
    const child = spawn(process.execPath, [workerFile, this.store.root, job.id], { stdio: 'ignore', windowsHide: true, detached: true });
    await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', () => reject(fault('DRIVER_UNAVAILABLE', 'QA worker did not start.'))); });
    op.launch = { launch_status: 'started', pid: child.pid }; this.store.saveOperation(op); child.unref();
    state.qa_job = job.id; state.stage = 'qa';
    return { job_id: job.id, status: 'started', snapshot_ref: snapshotRef, effects_known: true, terminal_observed: false };
  }
}
