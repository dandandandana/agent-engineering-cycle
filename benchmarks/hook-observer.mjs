import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export function patchEvidence(event) {
  const value = typeof event.tool_input === 'string' ? event.tool_input
    : event.tool_input?.patch ?? event.tool_input?.input ?? event.tool_input?.patch_text ?? event.tool_input?.command ?? '';
  if (event.tool_name !== 'apply_patch' || typeof value !== 'string') return { patch_paths: [], patch_comment_only: false };
  const lines = value.split(/\r?\n/);
  const added = lines.filter(line => line.startsWith('+')).map(line => line.slice(1));
  return {
    patch_paths: [...value.matchAll(/^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm)].map(match => match[1].trim()).slice(0, 64),
    patch_comment_only: !/\r(?!\n)|[\u2028\u2029]/u.test(value) && !/^\*\*\* (?:Add|Delete) File:|^\*\*\* Move to:/m.test(value)
      && !lines.some(line => line.startsWith('-')) && added.length > 0
      && added.every(line => !line.trim() || line.trim().startsWith('//')),
  };
}

// Distributed only in the isolated benchmark package. The stock handler bytes
// are unchanged; stdout, stderr and exit status are forwarded to the real host.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
let input = '';
for await (const chunk of process.stdin) input += chunk;
const directory = path.dirname(fileURLToPath(import.meta.url));
const result = spawnSync(process.execPath, [path.join(directory, 'src/hook.mjs')], {
  input, encoding: 'utf8', timeout: 35000, maxBuffer: 1024 * 1024,
});
try {
  const event = JSON.parse(input);
  const output = result.stdout?.trim() ? JSON.parse(result.stdout) : {};
  if (process.env.CYCLE_BENCH_TRACE) fs.appendFileSync(process.env.CYCLE_BENCH_TRACE, JSON.stringify({
    event: event.hook_event_name, cwd: event.cwd, tool: event.tool_name ?? null,
    ...patchEvidence(event),
    input_shape: { event_keys: Object.keys(event), type: typeof event.tool_input,
      keys: event.tool_input && typeof event.tool_input === 'object' ? Object.keys(event.tool_input) : [] },
    tool_input_sha256: event.tool_input === undefined ? null : createHash('sha256').update(JSON.stringify(event.tool_input)).digest('hex'),
    exit_code: result.status, output, handler_sha256: createHash('sha256').update(fs.readFileSync(path.join(directory, 'src/hook.mjs'))).digest('hex'),
  }) + '\n');
} catch (error) { process.stderr.write(`Benchmark hook observation failed: ${error.code ?? error.name}\n`); }
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');
process.exitCode = result.status ?? 1;
}
