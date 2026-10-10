import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { CASES } from '../benchmarks/cases.mjs';
import { gradeCase } from '../benchmarks/grade-worker.mjs';
import { runCheck } from '../src/local/check-runner.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));

async function fixture(t, selected, changes = {}) {
  const root = await mkdtemp(join(tmpdir(), 'cycle benchmark grading '));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [path, content] of Object.entries({ ...selected.files, ...changes })) {
    const target = join(root, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, 'utf8');
  }
  if (selected.id === 'decode-record') await symlink(join(project, 'node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  return root;
}

for (const selected of CASES) {
  test(`${selected.id}: original source passes the public check but fails the maintenance gate`, async t => {
    const root = await fixture(t, selected);
    const receipt = await runCheck({ id: 'public-check', argv: [process.execPath, join(root, 'public-check.mjs')] }, { cwd: root });
    assert.equal(receipt.passed, true, JSON.stringify(receipt));
    const result = await gradeCase(selected.id, root);
    assert.equal(result.status, 'fail');
    const maintenanceId = selected.id === 'decode-record' ? 'maintenance-numeric-strings' : 'create-only-existing';
    assert.equal(result.checks.find(check => check.id === maintenanceId)?.pass, false);
  });

  test(`${selected.id}: maintenance oracle passes every hidden check and grader CLI`, async t => {
    const root = await fixture(t, selected, selected.oracle);
    const result = await gradeCase(selected.id, root);
    assert.equal(result.status, 'pass', JSON.stringify(result));
    assert.ok(result.checks.length >= 7);
    assert.ok(result.checks.every(check => check.pass));
    const receipt = await runCheck({ id: 'grade-worker', argv: [process.execPath, join(project, 'benchmarks', 'grade-worker.mjs'), '--case', selected.id, '--workspace', root] }, { cwd: root });
    assert.equal(receipt.passed, true, JSON.stringify(receipt));
    assert.equal(JSON.parse(receipt.stdout).status, 'pass');
  });
}

const record = CASES.find(selected => selected.id === 'decode-record');
const recordOracle = record.oracle['src/record.mjs'];
const recordMutants = [
  ['overbroad coercion', recordOracle.replace(/z\.preprocess\([\s\S]*?\}, z\.number\(\)\.int\(\)\.min\(0\)\.max\(1000\)\)/, 'z.coerce.number().int().min(0).max(1000)'), 'rejected-quantities'],
  ['extra fields accepted', recordOracle.replace('}).strict();', '});'), 'strict-record-errors'],
  ['required quantity defaulted', recordOracle.replace('  quantity,', '  quantity: quantity.default(0),'), 'strict-record-errors'],
  ['ZodError flattened', recordOracle.replace('error: result.error', 'error: result.error.issues'), 'strict-record-errors'],
  ['ZodError replaced in public schema', recordOracle.replace('export const recordSchema = z.object', 'const schema = z.object').replace('}).strict();', "}).strict();\nexport const recordSchema = { safeParse(input) {\n  const result = schema.safeParse(input);\n  return result.success ? result : { ...result, error: Object.assign(new Error('replacement'), { issues: result.error.issues }) };\n} };"), 'strict-record-errors'],
  ['caller input mutated', recordOracle.replace('return { ok: true, value:', 'input.quantity = result.data.quantity;\n  return { ok: true, value:'), 'maintenance-numeric-strings'],
];
for (const [name, source, failedId] of recordMutants) {
  test(`decode-record: rejects ${name}`, async t => {
    assert.notEqual(source, recordOracle, 'mutation must actually alter the candidate');
    const root = await fixture(t, record, { ...record.oracle, 'src/record.mjs': source });
    const result = await gradeCase(record.id, root);
    assert.equal(result.status, 'fail');
    assert.equal(result.checks.find(check => check.id === failedId)?.pass, false, JSON.stringify(result));
  });
}

test('decode-record: detects a helper parameter-flow regression', async t => {
  const root = await fixture(t, record, { ...record.oracle, 'src/order.mjs': record.oracle['src/order.mjs'].replace('record.quantity * factor', 'record.quantity + factor') });
  const result = await gradeCase(record.id, root);
  assert.equal(result.status, 'fail');
  assert.equal(result.checks.find(check => check.id === 'original-valid-inputs')?.pass, false);
});

const publish = CASES.find(selected => selected.id === 'publish-text');
const publishOracle = publish.oracle['src/publish.mjs'];
const publishMutants = [
  ['create-only overwrites', publishOracle.replace('if (createOnly) await link(temporary, destination);', 'if (createOnly) await rename(temporary, destination);'), 'create-only-existing'],
  ['temporary files leaked', publishOracle.replace('await unlink(temporary);', 'void temporary;'), 'create-only-new'],
  ['differently named temporary files leaked', publishOracle.replace('.publish-', '.staging-').replace('await unlink(temporary);', 'void temporary;'), 'create-only-new'],
  ['primary failure swallowed', publishOracle.replace('throw error;', 'return { path: destination, bytes: 0 };'), 'create-only-existing'],
  ['default replacement lost', publishOracle.replace('createOnly = false', 'createOnly = true'), 'default-publication-and-replacement'],
  ['characters counted as bytes', publishOracle.replace("Buffer.byteLength(text, 'utf8')", 'text.length'), 'default-publication-and-replacement'],
];
for (const [name, source, failedId] of publishMutants) {
  test(`publish-text: rejects ${name}`, async t => {
    assert.notEqual(source, publishOracle, 'mutation must actually alter the candidate');
    const root = await fixture(t, publish, { 'src/publish.mjs': source });
    const result = await gradeCase(publish.id, root);
    assert.equal(result.status, 'fail');
    assert.equal(result.checks.find(check => check.id === failedId)?.pass, false, JSON.stringify(result));
  });
}

test('hidden grader rejects an unknown case and broken candidate module', async t => {
  assert.equal((await gradeCase('unknown', tmpdir())).status, 'fail');
  const root = await fixture(t, publish, { 'src/publish.mjs': 'not valid JavaScript' });
  const result = await gradeCase(publish.id, root);
  assert.equal(result.status, 'fail');
  assert.equal(result.checks[0].id, 'grading-execution');
});

test('case data keeps public files separate from the oracle and judge controls', () => {
  assert.equal(new Set(CASES.map(selected => selected.id)).size, CASES.length);
  for (const selected of CASES) {
    assert.equal(selected.rubric.length, 6);
    assert.ok(selected.rubric.some(criterion => criterion.critical));
    assert.notEqual(selected.goldNotes, selected.badNotes);
    assert.ok(selected.files[selected.target.path]);
    assert.ok(selected.oracle[selected.target.path]);
    for (const content of Object.values(selected.files)) {
      assert.notEqual(content, selected.goldNotes);
      assert.notEqual(content, selected.badNotes);
    }
    for (const path of ['docs/notes.md', 'docs/requirements.md', 'docs/design.md', 'docs/implementation.md', 'public-check.mjs', 'package.json']) assert.equal(typeof selected.files[path], 'string');
  }
});
