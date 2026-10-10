import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gradeBlog, prepareBlog, projectForGrade } from '../benchmarks/blog-score.mjs';

async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-blog-score-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function writeFixture(root, files) {
  for (const [relativePath, content] of Object.entries(files)) {
    const target = path.join(root, ...relativePath.split('/'));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
  }
}

async function gradingRun(root, caseId = 'B03') {
  const run = path.join(root, 'grading-run');
  const caseDirectory = path.join(run, caseId);
  await fs.mkdir(path.join(run, 'baseline'), { recursive: true });
  await fs.mkdir(caseDirectory, { recursive: true });
  await fs.writeFile(path.join(run, 'run.json'), JSON.stringify({
    schema_version: 1,
    benchmark_id: 'blog-eval-v1',
    case_ids: [caseId],
  }));
  await fs.writeFile(path.join(caseDirectory, 'TASK.md'), 'fixture task');
  return { run, destination: path.join(caseDirectory, 'workspace') };
}

async function fakeEvaluator(root) {
  const blogRoot = path.join(root, 'blog-eval');
  const evals = path.join(blogRoot, 'evals');
  await fs.mkdir(evals, { recursive: true });
  await fs.mkdir(path.join(blogRoot, 'slop'), { recursive: true });
  await fs.writeFile(path.join(evals, 'runner.mjs'), `
    import { fileURLToPath } from 'node:url';
    export const ROOT = fileURLToPath(new URL('../', import.meta.url));
    export async function prepareRun(args) { return { operation: 'prepareRun', args }; }
    export async function gradeRun(args) { return { operation: 'gradeRun', metrics: { success: 3 }, args }; }
  `);
  return blogRoot;
}

test('projects every product file while excluding only declared protocol fields and snapshot-ignored paths', async t => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'mcp-candidate');
  const { destination } = await gradingRun(root);
  await writeFixture(path.join(root, 'grading-run', 'baseline'), {
    'src/domain/protected.mjs': 'baseline protected file',
  });
  await writeFixture(source, {
    'src/domain/changed.mjs': 'export const changed = true;\n',
    '.codex/engineering-cycle.json': 'managed host state',
    '.codex/engineering-cycle/session.json': 'managed host state',
    '.codex/extra.mjs': 'export const userFile = true;\n',
    'docs/cycle/requirements.md': 'managed cycle document',
    'docs/cycle/design.md': 'managed cycle document',
    'docs/cycle/implementation.md': 'managed cycle document',
    'docs/cycle/notes.md': 'managed cycle document',
    'docs/cycle/extra.mjs': 'export const productFile = true;\n',
    '.git/config': 'ignored repository metadata',
    'slop/experiment.mjs': 'ignored evaluator path',
  });

  const projected = await projectForGrade({ source, destination });
  assert.equal(projected, destination);
  assert.equal(await fs.readFile(path.join(destination, 'src/domain/changed.mjs'), 'utf8'), 'export const changed = true;\n');
  assert.equal(await fs.readFile(path.join(destination, '.codex/extra.mjs'), 'utf8'), 'export const userFile = true;\n');
  assert.equal(await fs.readFile(path.join(destination, 'docs/cycle/extra.mjs'), 'utf8'), 'export const productFile = true;\n');
  for (const relativePath of [
    '.codex/engineering-cycle.json',
    '.codex/engineering-cycle/session.json',
    'docs/cycle/requirements.md',
    'docs/cycle/design.md',
    'docs/cycle/implementation.md',
    'docs/cycle/notes.md',
    '.git/config',
    'slop/experiment.mjs',
    'src/domain/protected.mjs',
  ]) {
    await assert.rejects(fs.access(path.join(destination, ...relativePath.split('/'))), { code: 'ENOENT' });
  }
  assert.equal(await fs.readFile(path.join(root, 'grading-run/baseline/src/domain/protected.mjs'), 'utf8'), 'baseline protected file');
});

test('refuses to replace an existing grading workspace', async t => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'candidate');
  const { destination } = await gradingRun(root, 'B01');
  await fs.mkdir(source);
  await fs.mkdir(destination);
  await fs.writeFile(path.join(destination, 'user-seed.mjs'), 'keep me');
  await assert.rejects(projectForGrade({ source, destination }), /destination must not already exist/u);
  assert.equal(await fs.readFile(path.join(destination, 'user-seed.mjs'), 'utf8'), 'keep me');
});

test('rejects symbolic links in the candidate source before creating a destination', async t => {
  const root = await temporaryRoot(t);
  const source = path.join(root, 'candidate');
  const { destination } = await gradingRun(root, 'B02');
  const target = path.join(source, 'target');
  const link = path.join(source, 'link');
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, 'module.mjs'), 'export const value = true;\n');
  try {
    await fs.symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) {
      t.skip(`This host cannot create a directory symbolic link: ${error.code}`);
      return;
    }
    throw error;
  }
  await assert.rejects(projectForGrade({ source, destination }), /symbolic link/u);
  await assert.rejects(fs.lstat(destination), { code: 'ENOENT' });
});

test('prepareBlog and gradeBlog return the original evaluator results', async t => {
  const root = await temporaryRoot(t);
  const blogRoot = await fakeEvaluator(root);
  const canonicalBlogRoot = await fs.realpath(blogRoot);
  const solRoot = path.join(root, 'sol-root');
  const prepareOut = path.join(blogRoot, 'slop', 'prepared');
  const prepared = await prepareBlog({ blogRoot, solRoot, out: prepareOut });
  assert.deepEqual(prepared, { operation: 'prepareRun', args: { out: path.join(canonicalBlogRoot, 'slop', 'prepared'), solRoot } });

  const run = path.join(blogRoot, 'slop', 'prepared');
  await fs.mkdir(run);
  const gradeOut = path.join(blogRoot, 'slop', 'graded');
  const graded = await gradeBlog({ blogRoot, solRoot, run, out: gradeOut, label: 'candidate' });
  assert.deepEqual(graded, {
    operation: 'gradeRun',
    metrics: { success: 3 },
    args: { run: path.join(canonicalBlogRoot, 'slop', 'prepared'), out: path.join(canonicalBlogRoot, 'slop', 'graded'), label: 'candidate', solRoot },
  });
});

test('prepareBlog confines new runs to blogRoot/slop', async t => {
  const root = await temporaryRoot(t);
  const blogRoot = await fakeEvaluator(root);
  await assert.rejects(
    prepareBlog({ blogRoot, solRoot: path.join(root, 'sol-root'), out: path.join(root, 'outside') }),
    /inside blogRoot\/slop/u,
  );
});
