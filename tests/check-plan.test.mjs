import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest } from '../src/core/contracts.mjs';
import { createCheckPlan, detectCheckCandidates } from '../src/local/check-plan.mjs';
import { WorkspaceAdapter } from '../src/local/workspace.mjs';

async function fixture(t, packageJson = { name: 'fixture', scripts: {} }) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'check-plan-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, 'package.json'), JSON.stringify(packageJson));
  const node = path.join(root, 'node.exe');
  await writeFile(node, 'node-runtime-fixture');
  const previous = process.execPath;
  process.execPath = node;
  t.after(() => { process.execPath = previous; });
  const workspace = new WorkspaceAdapter(root);
  return { root, node, workspace };
}

function rev3(checks = [{ id: 'source-integrity', kind: 'source-integrity' }]) {
  return { schema_revision: 3, checks, component_reuse: { budgets: { timeout_ms: 4_000 } } };
}

async function installNpmFixture(root, sentinel) {
  const npmCli = path.join(root, 'node_modules', 'npm', 'bin', 'npm-cli.js');
  await mkdir(path.dirname(npmCli), { recursive: true });
  await writeFile(npmCli, `await import('node:fs/promises').then(fs => fs.writeFile(${JSON.stringify(sentinel)}, 'ran'));\n`);
  return npmCli;
}

test('detects only existing recognized scripts with fixed npm argv and never runs package scripts or npm launcher', async t => {
  const { root, node, workspace } = await fixture(t, {
    name: 'fixture',
    scripts: { test: 'node -e "process.exit(0)"', lint: 'sentinel-command', custom: 'ignored' },
  });
  const sentinel = path.join(root, 'executed.txt');
  const npmCli = await installNpmFixture(root, sentinel);

  const result = await detectCheckCandidates({ workspace, config: rev3(), env: {} });

  assert.deepEqual(result.candidates.map(candidate => candidate.id), ['npm:test', 'npm:lint']);
  assert.deepEqual(result.candidates[0].argv, [node, npmCli, 'run', 'test']);
  assert.equal(result.candidates[0].timeout_ms, 30_000);
  assert.equal(result.candidates[0].source.path, 'package.json');
  assert.match(result.candidates[0].source.sha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(result.toolchain_facts.map(fact => fact.path), [node, npmCli]);
  assert.ok(result.toolchain_facts.every(fact => /^[a-f0-9]{64}$/.test(fact.sha256)));
  await assert.rejects(readFile(sentinel));
});

test('reports scripts unavailable when known npm is missing and leaves legacy check probing untouched', async t => {
  const { workspace } = await fixture(t, { name: 'fixture', scripts: { test: 'test-command' } });
  const result = await detectCheckCandidates({ workspace, config: rev3(), env: {} });
  assert.equal(result.candidates.length, 0);
  assert.equal(result.unavailable.some(item => item.id === 'npm:test' && item.executable === false), true);
  assert.equal(result.toolchain.npm_cli, null);
  const legacy = await detectCheckCandidates({ workspace, config: { schema_revision: 2, checks: [{ id: 'old' }] }, env: {} });
  assert.deepEqual(legacy, { candidates: [], unavailable: [], toolchain: null, toolchain_facts: [] });
});

test('creates a deterministic plan with exact scoped missing test facts and behavioral state', async t => {
  const { node, root, workspace } = await fixture(t, { name: 'fixture', scripts: { test: 'not-executed' } });
  const npmCli = await installNpmFixture(root, path.join(root, 'sentinel.txt'));
  const plannedPath = 'tests/new.test.mjs';
  const config = rev3();
  const plan = await createCheckPlan({
    workspace,
    config,
    scope: ['tests/new.test.mjs'],
    input: { planned_node_tests: [{ id: 'planned:new-test', path: plannedPath }] },
    env: {},
  });

  assert.deepEqual(plan.checks.map(check => check.id), ['source-integrity', 'npm:test', 'planned:new-test']);
  assert.deepEqual(plan.checks.at(-1).argv, [node, '--test', plannedPath]);
  assert.equal(plan.checks[1].argv[1], npmCli);
  assert.deepEqual(plan.source_facts.find(fact => fact.path === plannedPath), { path: plannedPath, sha256: null });
  assert.deepEqual(plan.behavioral, { status: 'required', reason: 'The plan contains behavioral command checks.' });
  const { digest: actualDigest, ...digestInput } = plan;
  assert.equal(actualDigest, digest(digestInput));
});

test('requires dynamic candidate exclusions to be reasoned and rejects unsafe path, duplicate ID, and selected-excluded conflict', async t => {
  const { root, workspace } = await fixture(t, { name: 'fixture', scripts: { test: 'test-command' } });
  await installNpmFixture(root, path.join(root, 'sentinel.txt'));
  const base = { workspace, config: rev3(), scope: ['tests/target.test.mjs'], env: {} };
  await assert.rejects(createCheckPlan({ ...base, input: { selected_ids: [] } }), /must be selected or excluded/);
  await assert.rejects(createCheckPlan({ ...base, input: { planned_node_tests: [{ id: 'unsafe', path: '../outside.mjs' }] } }), /safe ID and workspace-relative path/);
  await assert.rejects(createCheckPlan({ ...base, input: { planned_node_tests: [{ id: 'outside-scope', path: 'tests/other.test.mjs' }] } }), /exact path already present/);
  await assert.rejects(createCheckPlan({ ...base, input: { planned_node_tests: [{ id: 'source-integrity', path: 'tests/target.test.mjs' }] } }), /duplicates another check ID/);
  await assert.rejects(createCheckPlan({ ...base, input: { selected_ids: ['npm:test'], exclusions: [{ id: 'npm:test', reason: 'not applicable' }] } }), /cannot be selected and excluded/);
  const excluded = await createCheckPlan({ ...base, input: { selected_ids: [], exclusions: [{ id: 'npm:test', reason: 'The project has no behavioral acceptance in the approved task.' }], behavioral_applicability: { status: 'not_applicable', reason: 'Only documentation is changing and independent QA will confirm that boundary.' } } });
  assert.deepEqual(excluded.checks.map(check => check.id), ['source-integrity']);
  assert.deepEqual(excluded.exclusions, [{ id: 'npm:test', reason: 'The project has no behavioral acceptance in the approved task.' }]);
  assert.equal(excluded.behavioral.status, 'not_applicable');
  const reportOnly = await createCheckPlan({ ...base, input: { behavioral_applicability: { status: 'not_applicable', reason: 'QA must independently confirm the documentation-only boundary.' } } });
  assert.deepEqual(reportOnly.checks.map(check => check.id), ['source-integrity', 'npm:test']);
  assert.deepEqual(reportOnly.behavioral, { status: 'not_applicable', reason: 'QA must independently confirm the documentation-only boundary.' });
});

test('preserves configured checks exactly and does not permit excluding them', async t => {
  const { root, workspace } = await fixture(t, { name: 'fixture', scripts: {} });
  const configured = { id: 'fixed', kind: 'command', argv: ['node', '--version'], timeout_ms: 1000 };
  const plan = await createCheckPlan({ workspace, config: rev3([configured]), scope: [], input: { behavioral_applicability: { status: 'required', reason: 'Configured behavioral check remains required.' } }, env: {} });
  assert.equal(plan.checks[0], configured);
  assert.deepEqual(plan.behavioral, { status: 'required', reason: 'Configured behavioral check remains required.' });
  const reportOnly = await createCheckPlan({
    workspace,
    config: rev3([configured]),
    scope: [],
    input: { behavioral_applicability: { status: 'not_applicable', reason: 'QA must confirm there is no behavioral acceptance.' } },
    env: {},
  });
  assert.equal(reportOnly.checks[0], configured);
  assert.deepEqual(reportOnly.behavioral, { status: 'not_applicable', reason: 'QA must confirm there is no behavioral acceptance.' });
  await assert.rejects(createCheckPlan({
    workspace,
    config: rev3([configured]),
    scope: [],
    input: { exclusions: [{ id: 'fixed', reason: 'try to omit configured check' }] },
    env: {},
  }), /Only currently detected dynamic candidates can be excluded/);
});

test('a declared required applicability without a behavioral check remains missing coverage', async t => {
  const { workspace } = await fixture(t, { name: 'fixture', scripts: {} });
  const plan = await createCheckPlan({
    workspace,
    config: rev3(),
    scope: [],
    input: { behavioral_applicability: { status: 'required', reason: 'The acceptance changes runtime behavior.' } },
    env: {},
  });
  assert.deepEqual(plan.behavioral, { status: 'missing', reason: 'The acceptance changes runtime behavior.', applicability: 'required' });
});

test('legacy plans return their original checks without probing workspace sources', async () => {
  const checks = [{ id: 'legacy', kind: 'source-integrity' }];
  let probes = 0;
  const plan = await createCheckPlan({
    workspace: { readSource: async () => { probes += 1; throw new Error('must not probe'); } },
    config: { schema_revision: 1, checks },
    scope: [],
  });
  assert.equal(plan.checks, checks);
  assert.equal(probes, 0);
});
