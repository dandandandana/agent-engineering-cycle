#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';
import { createRuntime } from './runtime.mjs';
import { readJson } from './local/store.mjs';
import { validateConfig } from './local/config.mjs';
import { calibrateCLI } from './adapters/calibrate.mjs';
import { digest, sha256, fault, safeError } from './core/contracts.mjs';
import { discoverQaCandidate } from './local/qa-candidates.mjs';
import { binaryIdentity } from './adapters/qa-cli.mjs';

export async function main(argv = process.argv.slice(2)) {
  const command = argv[0] ?? 'doctor';
  const value = flag => { const at = argv.indexOf(flag); return at === -1 ? null : argv[at + 1]; };
  const root = path.resolve(value('--workspace') ?? process.cwd());
  const runtime = await createRuntime({ workspaceRoot: root });
  if (command === 'doctor' || command === 'status') return runtime.invoke('cycle_status', {});
  if (command === 'init') {
    const supplied = value('--config'); if (!supplied) throw fault('EVIDENCE_INVALID', 'init --config requires a project-check JSON file.');
    const config = validateConfig(readJson(path.resolve(supplied), { limit: 65536 }));
    const directory = path.join(root, '.codex');
    if (fs.existsSync(directory) && (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory())) throw fault('SCOPE_DENIED', 'Configuration ancestor is not a regular directory.');
    fs.mkdirSync(directory, { recursive: true });
    const file = path.join(directory, 'engineering-cycle.json'); fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    return { ok: true, initialized: true, configured_checks: (config.checks ?? []).map(c => c.id), authority: 'not granted; authorize separately' };
  }
  if (command === 'authorize') {
    if (!process.stdin.isTTY || !process.stdout.isTTY) throw fault('DECISION_UNVERIFIED', 'Authorization requires the interactive operator terminal; stdin JSON/model fields cannot confirm it.');
    const specFile = value('--spec'); if (!specFile) throw fault('EVIDENCE_INVALID', 'authorize --spec needs the exact action/requirement decision JSON.');
    const spec = readJson(path.resolve(specFile), { limit: 65536 });
    if (spec.kind === 'action') {
      if (typeof spec.goal !== 'string' || !['docs', 'implement'].includes(spec.mode) || !Array.isArray(spec.paths) || !spec.paths.length || !Array.isArray(spec.actions) || spec.actions.some(a => !['control','artifact','apply','verify','qa','reconcile'].includes(a))) throw fault('EVIDENCE_INVALID', 'Action spec needs goal, docs/implement mode, exact paths and allowed actions.');
      for (const p of spec.paths) { try { await runtime.workspace.readSource(p); } catch (error) { if (error.code !== 'SOURCE_UNAVAILABLE') throw error; } }
      if (spec.documentation_paths !== undefined && (!Array.isArray(spec.documentation_paths) || spec.documentation_paths.length > 64
        || new Set(spec.documentation_paths).size !== spec.documentation_paths.length
        || spec.documentation_paths.some(p => typeof p !== 'string' || !/\.(?:md|txt|rst|adoc)$/i.test(p) || !spec.paths.includes(p)))) throw fault('EVIDENCE_INVALID', 'Authority documents must be unique exact document targets within the requested action scope.');
    } else if (spec.kind !== 'requirement' || !spec.cycle_id || !spec.delta_id || !/^[a-f0-9]{64}$/.test(spec.delta_digest ?? '')) throw fault('EVIDENCE_INVALID', 'Requirement decision must bind cycle_id, delta_id and delta_digest.');
    const identity = digest(spec); process.stdout.write(JSON.stringify({ requested_scope: spec, decision_digest: identity }, null, 2) + '\n');
    const terminal = createInterface({ input: process.stdin, output: process.stdout }); let answer;
    try { answer = await terminal.question(`Type approve ${identity.slice(0, 12)} to authorize this exact scope: `); } finally { terminal.close(); }
    if (answer !== `approve ${identity.slice(0, 12)}`) throw fault('DECISION_UNVERIFIED', 'Operator did not approve the exact scope.');
    const { goal, ...fields } = spec;
    const payload = { ...fields, ...(goal ? { goal_digest: sha256(goal) } : {}), workspace_id: runtime.store.workspaceId, source: { adapter: 'interactive-operator', scope_digest: identity, terminal_observed: true, human_identity_verified: false }, created_at: new Date().toISOString() };
    const receipt = await runtime.store.withLease(() => runtime.authority.issue(payload, { operatorConfirmed: true }));
    return { ok: true, grant_id: receipt.id, source: payload.source, note: 'Local operator channel; same-OS peers are outside this trust boundary.' };
  }
  if (command === 'calibrate-qa') {
    const cfg = runtime.core.config(); let driver = cfg.qa;
    if (cfg.schema_revision === 3) {
      const declaredModel = value('--model') ?? cfg.qa?.model;
      const declaredExecutable = value('--executable') ?? cfg.qa?.executable;
      const sandbox = value('--windows-sandbox') ?? cfg.qa?.windows_sandbox;
      if (sandbox && !['elevated','unelevated'].includes(sandbox)) throw fault('EVIDENCE_INVALID', 'QA Windows sandbox must be explicitly elevated or unelevated.');
      const candidate = await discoverQaCandidate({ config: { ...cfg, qa: { model: declaredModel, ...(declaredExecutable ? { executable: declaredExecutable } : {}), ...(sandbox ? { windows_sandbox: sandbox } : {}) } } });
      if (!candidate.model || !candidate.executable || !candidate.executable_sha256) throw fault('QA_VERIFICATION_UNAVAILABLE', 'Select a QA model/native executable once through the explicit calibration command; no project JSON is needed.', { candidate });
      driver = { executable: candidate.executable, model: candidate.model, timeout_ms: cfg.qa?.timeout_ms ?? 180000, ...(sandbox ? { windows_sandbox: sandbox } : {}) };
      const state = runtime.store.current();
      if (state && ['active','interrupted'].includes(state.lifecycle)) {
        const planned = state.configuration_snapshot?.config.qa;
        if (!planned || planned.executable !== driver.executable || planned.model !== driver.model || (planned.windows_sandbox ?? null) !== (driver.windows_sandbox ?? null)
          || state.qa_plan?.executable_sha256 !== candidate.executable_sha256) throw fault('POLICY_CONFLICT', 'Live calibration cannot silently change the driver fixed by this active cycle.');
        runtime.core.grant(state, 'qa');
      }
    }
    if (!driver?.executable || !driver?.model) throw fault('QA_VERIFICATION_UNAVAILABLE', 'Select qa.executable/model before calibration.');
    const result = await calibrateCLI({ store: runtime.store, authority: runtime.authority, driver, live: argv.includes('--live') });
    if (cfg.schema_revision === 3 && result.passed) {
      const { capability_receipt, ...fixed } = driver;
      const payload = { workspace_id: runtime.store.workspaceId, source: 'explicit-live-calibration', driver: fixed, binary_digest: binaryIdentity(fixed.executable) };
      await runtime.store.withLease(() => runtime.store.write('defaults/qa-selection.json', { payload, digest: digest(payload), signature: runtime.authority.mac(payload) }));
    }
    return result;
  }
  if (command === 'call') {
    const name = argv[1]; const input = value('--input'); if (!input) throw fault('EVIDENCE_INVALID', 'call requires a tool name and --input JSON file.');
    return runtime.invoke(name, readJson(path.resolve(input)));
  }
  throw fault('EVIDENCE_INVALID', 'Commands: doctor/status, init --config, authorize --spec, calibrate-qa --live, call TOOL --input. All support --workspace.');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const result = await main(); process.stdout.write(JSON.stringify(result) + '\n'); if (result.ok === false || result.passed === false) process.exitCode = 1; }
  catch (error) { process.stderr.write(JSON.stringify({ ok: false, error: safeError(error) }) + '\n'); process.exitCode = 1; }
}
