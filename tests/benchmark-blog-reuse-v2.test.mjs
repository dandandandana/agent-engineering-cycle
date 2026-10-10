import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { blogReuseV2Plan, freezeBlogReuseV2, scoreBlogReuseV2 } from '../benchmarks/blog-reuse-v2.mjs';

const PROJECT_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const V2_CLI = path.join(PROJECT_ROOT, 'benchmarks', 'blog-reuse-v2.mjs');

async function fixtureRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-blog-reuse-v2-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const evals = path.join(root, 'evals');
  const refs = path.join(evals, 'reference');
  const run = path.join(root, 'slop', 'prepared-v1');
  await fs.mkdir(refs, { recursive: true });
  await fs.mkdir(path.join(run, 'baseline'), { recursive: true });
  await fs.writeFile(path.join(evals, 'runner.mjs'), `
    import { fileURLToPath } from 'node:url';
    export const ROOT = fileURLToPath(new URL('../', import.meta.url));
    export async function installReference() {}
  `);
  for (const file of ['rubric.mjs', 'verify.mjs', 'sol.mjs']) await fs.writeFile(path.join(evals, file), `// fixture ${file}\n`);
  const cases = blogReuseV2Plan.case_ids.map(caseId => {
    const opportunities = blogReuseV2Plan.opportunities.filter(value => value.case_id === caseId);
    const reuse = opportunities.map(value => ({
      id: value.id.slice(caseId.length + 1).split('.').slice(0, 2).join('.'),
      path: value.path,
      export_name: value.export_name,
      min_calls: 1,
      kind: value.kind,
    }));
    const extensions = opportunities.filter(value => value.kind === 'extend').map(value => ({
      module_id: value.id.slice(caseId.length + 1).split('.').slice(0, 2).join('.'),
      options_add: [value.compatibility.option],
    }));
    return { id: caseId, title: caseId, prompt: 'fixture', entry: 'src/features.mjs', export_name: 'fixture', reuse, extensions };
  });
  await fs.writeFile(path.join(evals, 'tasks.json'), JSON.stringify({ schema_version: 1, benchmark_id: 'blog-eval-v1', cases }));
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({
    schema_version: 1,
    benchmark_id: 'blog-eval-v1',
    case_ids: blogReuseV2Plan.case_ids,
    bundle_sha256: 'a'.repeat(64),
  }));
  await fs.writeFile(path.join(run, 'baseline', 'source.mjs'), 'export const fixture = true;\n');
  return { root, run };
}

test('the v2 plan keeps eight tasks, all 25 opportunities, and per-opportunity task-consumer checks', () => {
  assert.equal(blogReuseV2Plan.case_ids.length, 8);
  assert.equal(blogReuseV2Plan.denominator, 25);
  assert.equal(blogReuseV2Plan.opportunities.length, 25);
  assert.ok(blogReuseV2Plan.opportunities.every(value => value.consumer_checks.length > 0));
  assert.equal(blogReuseV2Plan.opportunities.filter(value => value.effect_kind === 'callback_effect').length, 1);
});

test('the independent v2 reference calibration CLI exposes a bounded help entry', () => {
  const result = spawnSync(process.execPath, [V2_CLI, '--help'], { cwd: PROJECT_ROOT, encoding: 'utf8', timeout: 5_000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reference-calibrate/u);
  assert.match(result.stdout, /all 25/u);
  assert.match(result.stdout, /model, browser, or old-v1 grading/u);
});

test('M stays 0/25 with no probe output and caller-built reported evidence is rejected', async t => {
  const { root, run } = await fixtureRoot(t);
  const freeze = await freezeBlogReuseV2({ blogRoot: root, preparedRun: run });
  const score = await scoreBlogReuseV2({ blogRoot: root, preparedRun: run, freeze, evidence: [] });
  assert.equal(score.M, 0);
  assert.equal(score.denominator, 25);
  assert.equal(score.E, 25);
  assert.equal(score.M_over_E_display, '0.0%');
  assert.equal(score.coverage_limits.reference_control_coverage, 'none');
  assert.equal(score.coverage_limits.reference_control_calibrated_count, 0);
  assert.equal(score.coverage_limits.unprobed_opportunity_ids.length, 25);
  assert.deepEqual(score.necessary_new, {
    status: 'not_assessed',
    reported_separately_by: 'D/QA',
    counted_in_M: false,
  });
  await assert.rejects(scoreBlogReuseV2({
    blogRoot: root,
    preparedRun: run,
    freeze,
    evidence: [{ opportunity_id: blogReuseV2Plan.opportunities[0].id, status: 'contributed', reported: true }],
  }), /Caller-created evidence cannot score/u);
});

test('a source or v1 rule change after freeze invalidates v2 scoring', async t => {
  const { root, run } = await fixtureRoot(t);
  const freeze = await freezeBlogReuseV2({ blogRoot: root, preparedRun: run });
  await fs.appendFile(path.join(root, 'evals', 'verify.mjs'), '// changed after freeze\n');
  await assert.rejects(scoreBlogReuseV2({ blogRoot: root, preparedRun: run, freeze, evidence: [] }), /changed after freeze/u);
});

test('the freeze rejects altered denominator metadata and does not edit the prepared run', async t => {
  const { root, run } = await fixtureRoot(t);
  const metadataPath = path.join(run, 'run.json');
  const original = await fs.readFile(metadataPath, 'utf8');
  const metadata = JSON.parse(original);
  metadata.case_ids.pop();
  await fs.writeFile(metadataPath, JSON.stringify(metadata));
  await assert.rejects(freezeBlogReuseV2({ blogRoot: root, preparedRun: run }), /complete eight-task/u);
  assert.equal(JSON.parse(await fs.readFile(metadataPath, 'utf8')).case_ids.length, 7);
});
