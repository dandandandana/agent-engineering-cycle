import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { prepareJudgeInput, execute } from '../benchmarks/live.mjs';

async function fixture(t) {
  const output = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-judge-input-'));
  t.after(() => fs.rm(output, { recursive: true, force: true }));
  await fs.mkdir(path.join(output, 'raw'));
  return { output, timeoutMs: 1000, invocations: [] };
}

test('large source/registry inputs become exact frozen files without expanding the stdin budget', async t => {
  const ctx = await fixture(t);
  const source = '// source\r\n'.repeat(8000);
  const notes = 'Actual notes\r\nSecond line';
  const input = await prepareJudgeInput(ctx, { rubric: [{ id: 'flow', criterion: 'Explain the code' }] }, notes, 'large', {
    'src/main.mjs': source, 'components.json': '{"modules":[]}', 'docs/cycle/implementation.md': 'DO NOT DELIVER I VERDICT',
  });
  assert.equal(input.mode, 'frozen-files');
  assert.ok(Buffer.byteLength(input.prompt, 'utf8') <= 65536);
  assert.equal(await fs.readFile(path.join(input.workspace, 'src/main.mjs'), 'utf8'), source);
  assert.equal(await fs.readFile(path.join(input.workspace, 'notes.md'), 'utf8'), notes);
  const manifest = JSON.parse(await fs.readFile(path.join(input.workspace, 'judge-inputs.json'), 'utf8'));
  assert.deepEqual(manifest.sources.map(value => value.path), ['src/main.mjs', 'components.json']);
  assert.equal(Object.hasOwn(input.sources, 'docs/cycle/implementation.md'), false);
});

test('frozen judge sources cannot escape their workspace', async t => {
  const ctx = await fixture(t);
  await assert.rejects(() => prepareJudgeInput(ctx, { rubric: [] }, 'notes', 'escape', { 'src/../../outside.mjs': '// big\n'.repeat(15000) }), /Invalid judge source path/);
});

test('oversized stdin is a known non-launch rather than unknown native effects', async t => {
  const ctx = await fixture(t);
  const marker = path.join(ctx.output, 'should-not-exist');
  const result = await execute(ctx, 'too-big', [process.execPath, '-e', 'require("node:fs").writeFileSync(process.argv[1],"ran")', marker], { prompt: 'x'.repeat(65537), cwd: ctx.output });
  assert.equal(result.facts.launch_status, 'not_started');
  assert.equal(result.facts.passed, false);
  assert.equal(result.facts.launch_error.code, 'CHECK_CONFIG_INVALID');
  assert.equal(ctx.invocations[0].attempted, false);
  assert.equal(ctx.invocations[0].execution_status, 'not-started');
  assert.equal(ctx.executionUnknown, undefined);
  await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});
