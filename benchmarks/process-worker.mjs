import fs from 'node:fs/promises';
import { runCheck } from '../src/local/check-runner.mjs';

// A separate process scopes these environment variables to this invocation.
// Reuse the production runner's launch/capture/timeout/cleanup facts.
const job = JSON.parse(await fs.readFile(process.argv[2], 'utf8'));
for (const [key, value] of Object.entries(job.env ?? {})) {
  if (!['CODEX_HOME', 'CYCLE_WORKSPACE', 'CYCLE_BENCH_TRACE', 'TERM'].includes(key) || typeof value !== 'string') throw new Error('Unsupported benchmark environment entry.');
  process.env[key] = value;
}
const facts = await runCheck({ id: job.id, argv: job.argv }, {
  cwd: job.cwd, timeoutMs: job.timeout_ms, maxOutputBytes: 4 * 1024 * 1024,
  ...(job.prompt !== undefined ? { stdinText: job.prompt } : {}),
});
await fs.writeFile(job.result, JSON.stringify(facts, null, 2) + '\n', { flag: 'wx' });
process.stdout.write(JSON.stringify({ result: job.result, passed: facts.passed }) + '\n');
