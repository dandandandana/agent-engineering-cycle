import { LocalStore } from '../local/store.mjs';
import { WorkspaceAdapter } from '../local/workspace.mjs';
import { OperatorAuthority } from '../local/authority.mjs';
import { readConfig } from '../local/config.mjs';
import { qaCapability, runCliQA } from './qa-cli.mjs';
import { safeError, fault } from '../core/contracts.mjs';

const [root, jobId] = process.argv.slice(2);
if (!root || !/^[a-z0-9-]+$/i.test(jobId ?? '')) throw new Error('Explicit QA workspace and job are required');
const store = new LocalStore(root); const workspace = new WorkspaceAdapter(root); const authority = new OperatorAuthority(store);
const controller = new AbortController();
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function publish(action) {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { return await store.withLease(action); }
    catch (e) { if (e.code !== 'LEASE_BUSY' || attempt === 99) throw e; await sleep(50); }
  }
}
let timer;
try {
  const job = store.read(`jobs/${jobId}.json`); const config = readConfig(store); const capability = qaCapability(store, authority, config);
  if (!capability.available || job.config_digest !== config.digest) throw fault('QA_VERIFICATION_UNAVAILABLE', 'QA capability or config changed before launch.');
  const frozen = store.evidence(job.snapshot_ref.id).payload;
  if (frozen.cycle_id !== job.cycle_id || frozen.basis_digest !== job.basis_digest) throw fault('EVIDENCE_INVALID', 'Frozen input belongs to another job.');
  timer = setInterval(() => { try { if (store.read(`jobs/${jobId}.json`).cancel_requested) controller.abort(); } catch { controller.abort(); } }, 100);
  const result = await runCliQA({ driver: job.driver, snapshot: frozen.snapshot, qaContext: frozen.qa_context, acceptanceIds: job.acceptance_ids, workspace, signal: controller.signal, onStarted: async facts => publish(() => { const current = store.read(`jobs/${jobId}.json`); store.write(`jobs/${jobId}.json`, { ...current, status: 'running', launch: facts, worker_pid: process.pid }); }) });
  result.assurance.permission_observed = capability.assurance.permission_observed === true;
  const rawRef = await publish(() => store.archive('qa-raw', { job_id: jobId, result }));
  const reportRef = await publish(() => store.archive('qa-report', { job_id: jobId, source: 'reported', report: result.report, raw_ref: rawRef }));
  const status = result.receipt.launch_status === 'not_started' ? 'failed' : !result.assurance.terminal_observed ? 'unknown' : controller.signal.aborted ? 'cancelled' : result.terminal_event?.type === 'turn.failed' ? 'failed' : 'completed';
  const outcome = { job_id: jobId, status, passed: result.passed && Object.values(result.assurance).every(v => v === true), assurance: result.assurance, raw_ref: rawRef, report_ref: reportRef, terminal_observed: result.assurance.terminal_observed, launch_status: result.receipt.launch_status, finished_at: new Date().toISOString() };
  await publish(() => store.write(`jobs/${jobId}.outcome.json`, outcome, { immutable: true }));
  await publish(() => { const current = store.read(`jobs/${jobId}.json`); store.write(`jobs/${jobId}.json`, { ...current, status, outcome_ref: rawRef }); });
} catch (e) {
  try { await publish(() => { if (!store.read(`jobs/${jobId}.outcome.json`, true)) store.write(`jobs/${jobId}.outcome.json`, { job_id: jobId, status: 'unknown', passed: false, assurance: {}, error: safeError(e), terminal_observed: false }, { immutable: true }); }); } catch {}
  process.exitCode = 1;
} finally { if (timer) clearInterval(timer); }
