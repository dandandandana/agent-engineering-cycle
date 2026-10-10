import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runGates } from '../benchmarks/gates.mjs';

async function removeTestDirectory(directory) {
  const resolved = await realpath(directory);
  const parent = await realpath(os.tmpdir());
  const relative = path.relative(parent, resolved);
  assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  assert.equal((await lstat(directory)).isSymbolicLink(), false);
  await rm(resolved, { recursive: true });
}

test('backend benchmark reports every planned case and removes its temporary fixtures', async () => {
  const result = await runGates();
  assert.equal(result.layer, 'backend-contract');
  assert.equal(result.authorization, 'synthetic fixture; no human identity proof');
  assert.equal(result.cases.length, 9);
  assert.equal(new Set(result.cases.map(item => item.id)).size, 9);
  assert.equal(result.summary.planned, 9);
  assert.equal(result.summary.pass + result.summary.fail + result.summary.error, 9);
  for (const status of ['pass', 'fail', 'error']) assert.equal(result.summary[status], result.cases.filter(item => item.status === status).length);
  if (process.platform !== 'win32') {
    assert.equal(result.summary.pass, 0, 'Unsupported local-store platforms cannot claim backend gate acceptance.');
    assert.equal(result.summary.error, 9);
    for (const item of result.cases) assert.equal(item.observed.error.code, 'CAPABILITY_UNAVAILABLE');
  } else {
    assert.deepEqual(result.summary, { planned: 9, pass: 9, fail: 0, error: 0 });
  }
  for (const item of result.cases) {
    assert.ok(Number.isFinite(item.duration_ms) && item.duration_ms >= 0);
    assert.equal(item.observed.cleanup.status, 'removed');
    await assert.rejects(lstat(item.observed.cleanup.fixture_directory), { code: 'ENOENT' });
    await assert.rejects(lstat(path.dirname(item.observed.cleanup.fixture_directory)), { code: 'ENOENT' });
  }
});

test('saved backend evidence distinguishes wrong prose, stale inputs, and denied effects', async t => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), 'cycle-gates-test-'));
  t.after(() => removeTestDirectory(outputDirectory));
  const sentinel = path.join(outputDirectory, 'keep.txt');
  await writeFile(sentinel, 'existing output must survive', 'utf8');
  const result = await runGates({ outputDirectory });
  assert.equal(await readFile(sentinel, 'utf8'), 'existing output must survive');
  assert.equal((await readdir(outputDirectory)).filter(name => name.startsWith('cycle-backend-gates-')).length, 1);
  if (process.platform !== 'win32') {
    assert.equal(result.summary.error, 9);
    return;
  }
  const byId = Object.fromEntries(result.cases.map(item => [item.id, item]));
  const wrong = byId['wrong-prose-is-not-semantic-proof'];
  assert.equal(wrong.observed.status, 'current');
  assert.equal(wrong.observed.semantic_verified, false, 'Current hashes must not become semantic acceptance.');
  const wrongRoot = wrong.observed.cleanup.fixture_directory;
  assert.match(await readFile(path.join(wrongRoot, 'docs', 'compute-flow.md'), 'utf8'), /adds both inputs, writes a file/);
  assert.match(await readFile(path.join(wrongRoot, 'src', 'scaler.mjs'), 'utf8'), /return value \* factor/);
  assert.match(await readFile(path.join(wrongRoot, 'src', 'subject.mjs'), 'utf8'), /return scale\(value, factor\)/);

  const missing = byId['missing-notes'].observed;
  assert.equal(missing.finish_ok, false);
  assert.equal(missing.finish_notes_blocker, true);
  assert.equal(missing.finish_operation_created, false);
  assert.equal(missing.qa_note_guard_observed, false, 'An unavailable driver must not be reported as testing the later QA note guard.');
  assert.equal(missing.qa_job_created, false);
  for (const id of ['source-drift', 'documentation-drift', 'related-source-drift']) {
    assert.equal(byId[id].observed.before, 'current');
    assert.equal(byId[id].observed.entry, 'stale');
    assert.equal(byId[id].observed.notes_blocker, true);
  }
  assert.equal(byId['prepared-reference-tampering'].observed.operation_created, false);
  assert.equal(byId['prepared-reference-tampering'].observed.product_bytes_unchanged, true);
  assert.equal(byId['docs-mode-code-write'].observed.code, 'SCOPE_DENIED');
  assert.equal(byId['docs-mode-code-write'].observed.product_bytes_unchanged, true);
  const docsRoot = byId['docs-mode-code-write'].observed.cleanup.fixture_directory;
  assert.match(await readFile(path.join(docsRoot, 'src', 'subject.mjs'), 'utf8'), /return scale\(value, factor\)/);
  const hook = byId['hook-and-external-drift'].observed;
  assert.equal(hook.matched_write, 'deny');
  assert.deepEqual(hook.stop_response, {});
  assert.equal(hook.external_bytes_observed, true);
  assert.equal(hook.notes_blocker, true);

  for (const item of result.cases) {
    assert.equal(item.status, 'pass');
    assert.equal(item.observed.cleanup.status, 'abandoned-and-preserved');
    const fixtureDirectory = item.observed.cleanup.fixture_directory;
    assert.ok((await lstat(fixtureDirectory)).isDirectory());
    const current = JSON.parse(await readFile(path.join(fixtureDirectory, '.codex', 'engineering-cycle', 'current.json'), 'utf8'));
    assert.equal(current.lifecycle, 'abandoned');
    assert.equal(current.pending_operation, null);
    assert.equal(current.qa_job, null);
    const saved = JSON.parse(await readFile(path.join(fixtureDirectory, 'benchmark-case.json'), 'utf8'));
    assert.equal(saved.id, item.id);
    assert.equal(saved.status, item.status);
  }
});
