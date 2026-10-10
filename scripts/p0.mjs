import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createRuntime } from '../src/runtime.mjs';
import { calibrateCLI } from '../src/adapters/calibrate.mjs';

const args = process.argv.slice(2);
const get = key => { const at = args.indexOf(key); return at < 0 ? null : args[at + 1]; };
const project = fileURLToPath(new URL('../', import.meta.url));
if (!args.includes('--live')) {
  process.stdout.write(JSON.stringify({ phase: 'P0', status: 'not_attempted', next: 'Run npm test for local contracts. Explicit live QA: npm run p0 -- --live --executable ABSOLUTE_CODEX_BINARY --model CONFIGURED_MODEL. No automatic model/Host configuration changes.' }) + '\n');
} else {
  const executable = get('--executable'); const model = get('--model');
  if (!executable || !model) throw new Error('Explicit native executable and model are required');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engineering-cycle-p0-control-'));
  fs.mkdirSync(path.join(root, '.codex'));
  const driver = { executable, model, timeout_ms: 180000 };
  fs.writeFileSync(path.join(root, '.codex', 'engineering-cycle.json'), JSON.stringify({ schema_revision: 1, checks: [], qa: driver }));
  const runtime = await createRuntime({ workspaceRoot: root });
  const started = new Date().toISOString(); let result;
  try { result = await calibrateCLI({ store: runtime.store, authority: runtime.authority, driver, live: true }); }
  catch (e) { result = { passed: false, error: { code: e.code ?? 'P0_ERROR', message: e.code ? e.message : 'P0 failed; inspect local control records.' } }; }
  const report = { phase: 'P0', platform: process.platform, node: process.version, started_at: started, finished_at: new Date().toISOString(), control_root: root, result, native_subagent: 'not_attempted; no supported runtime observer implemented', host_plugin_install: 'not_attempted; no global install', human_decision_channel: 'interactive operator entry implemented; not authenticated human identity' };
  const directory = path.join(project, 'docs', 'evidence'); fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'p0-cli.json'), JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify(report) + '\n');
  if (!result.passed) process.exitCode = 1;
}
