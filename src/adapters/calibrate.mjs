import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceAdapter } from '../local/workspace.mjs';
import { runCheck } from '../local/check-runner.mjs';
import { runCliQA, binaryIdentity, DRIVER_REVISION, sandboxArgs } from './qa-cli.mjs';
import { digest, fault } from '../core/contracts.mjs';

/** Explicit program probe; never called by MCP or on ordinary status. */
export async function calibrateCLI({ store, authority, driver, live = false }) {
  if (!live) throw fault('QA_VERIFICATION_UNAVAILABLE', 'Live CLI calibration must be explicitly requested.');
  const binary = binaryIdentity(driver.executable);
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-cycle-p0-'));
  fs.writeFileSync(path.join(fixture, 'requirements.md'), 'AC-BOUNDARY: isAdult(age) must return true at 18 and above, and false below 18. Identify the boundary defect with the exact input.\n');
  fs.writeFileSync(path.join(fixture, 'subject.mjs'), 'export const isAdult = age => age > 18;\n');
  fs.writeFileSync(path.join(fixture, 'sentinel.txt'), 'P0_UNCHANGED');
  const sandbox = await runCheck({ id: 'sandbox-write-probe', argv: [driver.executable, ...sandboxArgs(driver), 'sandbox', '-P', ':read-only', '-C', fixture, '--', process.execPath, '-e', "require('node:fs').writeFileSync('sentinel.txt','UNEXPECTED_WRITE')"] }, { cwd: fixture, timeoutMs: 30000 });
  const denied = sandbox.launch_status === 'started' && sandbox.terminal_observed && sandbox.exit_code !== 0 && /EACCES|EPERM|permission denied|access.*denied|拒绝访问/i.test(sandbox.stderr + sandbox.stdout) && fs.readFileSync(path.join(fixture, 'sentinel.txt'), 'utf8') === 'P0_UNCHANGED';
  const sandboxRef = await store.withLease(() => store.archive('p0-sandbox', { fixture, receipt: sandbox, denied, proof_scope: 'fixed Node filesystem write under explicit :read-only profile' }));
  if (!denied) return { passed: false, stage: 'sandbox', sandbox_probe: { denied, raw_ref: sandboxRef }, fixture, reason: 'No observed denial from the expected readonly sandbox; live inference was not started.' };
  const workspace = new WorkspaceAdapter(fixture);
  const snapshotDirectory = path.join(fixture, '.codex', 'engineering-cycle', 'snapshots'); fs.mkdirSync(snapshotDirectory, { recursive: true });
  const snapshot = await workspace.snapshot(['requirements.md', 'subject.mjs', 'sentinel.txt'], snapshotDirectory);
  const result = await runCliQA({ driver, snapshot, acceptanceIds: ['AC-BOUNDARY'], workspace });
  const detected = result.report_complete && result.report?.verdict === 'fail' && result.report.acceptance.some(a => a.id === 'AC-BOUNDARY' && a.status === 'fail' && /18/.test(a.evidence)) && result.assurance.distinct_execution && result.assurance.fresh_session && result.assurance.frozen_input_delivery && result.assurance.terminal_observed;
  const liveRef = await store.withLease(() => store.archive('p0-live-qa', { result, detected_boundary_defect: Boolean(detected) }));
  const payload = { driver_revision: DRIVER_REVISION, binary_digest: binary, model: driver.model, windows_sandbox: driver.windows_sandbox ?? null, platform: process.platform, node: process.version, sandbox_probe: { denied, raw_ref: sandboxRef }, live_probe: { passed: Boolean(detected), raw_ref: liveRef }, assurance: { distinct_execution: Boolean(detected), fresh_session: Boolean(detected), frozen_input_delivery: Boolean(detected), permission_observed: denied, terminal_observed: Boolean(detected) }, proof_scope: 'fresh CLI exec and fixed readonly filesystem probe; no hidden prompt/model identity or all-tool coverage proof', recorded_at: new Date().toISOString() };
  if (detected) await store.withLease(() => { authority.key({ create: true }); store.write('qa-capability.json', { payload, signature: authority.mac(payload) }); });
  return { passed: Boolean(detected), capability_receipt: detected ? digest(payload) : null, fixture, sandbox_probe: payload.sandbox_probe, live_probe: payload.live_probe, coverage_limits: payload.proof_scope };
}
