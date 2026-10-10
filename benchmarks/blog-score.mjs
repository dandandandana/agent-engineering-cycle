import assert from 'node:assert/strict';
import { copyFile, lstat, mkdir, readFile, readdir, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const EXCLUDED_FILES = new Set([
  '.codex/engineering-cycle.json',
  'docs/cycle/requirements.md',
  'docs/cycle/design.md',
  'docs/cycle/implementation.md',
  'docs/cycle/notes.md',
]);
const PROTOCOL_DIRECTORY = '.codex/engineering-cycle';

function samePath(left, right) {
  const normalize = value => {
    let absolute = path.resolve(value);
    if (process.platform === 'win32') {
      absolute = absolute.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase();
    }
    return absolute;
  };
  return normalize(left) === normalize(right);
}

function containsPath(parent, candidate) {
  const value = path.relative(parent, candidate);
  return value === '' || (value !== '..' && !value.startsWith(`..${path.sep}`) && !path.isAbsolute(value));
}

function requireString(value, name) {
  assert.equal(typeof value, 'string', `${name} must be a path string`);
  assert.ok(value.length > 0, `${name} must not be empty`);
}

async function evaluatorAt(blogRoot) {
  requireString(blogRoot, 'blogRoot');
  const requestedRoot = path.resolve(blogRoot);
  const rootInfo = await lstat(requestedRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'blogRoot must be a regular directory');
  const root = await realpath(requestedRoot);

  const evalsDirectory = path.join(root, 'evals');
  const evalsInfo = await lstat(evalsDirectory);
  assert.ok(evalsInfo.isDirectory() && !evalsInfo.isSymbolicLink(), 'blogRoot/evals must be a regular directory');
  const entry = path.join(evalsDirectory, 'runner.mjs');
  const entryInfo = await lstat(entry);
  assert.ok(entryInfo.isFile() && !entryInfo.isSymbolicLink(), 'evals/runner.mjs must be a regular file');

  const evaluator = await import(pathToFileURL(entry).href);
  assert.ok(samePath(await realpath(evaluator.ROOT), root), 'The selected runner does not belong to blogRoot');
  return { root, requestedRoot, evaluator };
}

async function newOutputPath(root, requestedRoot, out) {
  requireString(out, 'out');
  const requestedTarget = path.resolve(out);
  const requestedSlop = path.join(requestedRoot, 'slop');
  const canonicalSlop = path.join(root, 'slop');
  let relativeTarget = path.relative(requestedSlop, requestedTarget);
  if (relativeTarget === '..' || relativeTarget.startsWith(`..${path.sep}`) || path.isAbsolute(relativeTarget)) {
    relativeTarget = path.relative(canonicalSlop, requestedTarget);
  }
  assert.ok(relativeTarget !== '' && relativeTarget !== '..' && !relativeTarget.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeTarget), 'Output must be a new directory inside blogRoot/slop');
  const target = path.resolve(canonicalSlop, relativeTarget);
  try {
    await lstat(target);
    throw new Error('Output directory already exists');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return target;
}

export async function prepareBlog({ blogRoot, solRoot, out } = {}) {
  const { root, requestedRoot, evaluator } = await evaluatorAt(blogRoot);
  assert.equal(typeof evaluator.prepareRun, 'function', 'The original evaluator must export prepareRun');
  const target = await newOutputPath(root, requestedRoot, out);
  return evaluator.prepareRun({ out: target, solRoot });
}

export async function gradeBlog({ blogRoot, solRoot, run, out, label } = {}) {
  const { root, requestedRoot, evaluator } = await evaluatorAt(blogRoot);
  assert.equal(typeof evaluator.gradeRun, 'function', 'The original evaluator must export gradeRun');
  requireString(run, 'run');
  const slop = path.join(root, 'slop');
  const requestedSlop = path.join(requestedRoot, 'slop');
  const requestedRun = path.resolve(run);
  let relativeRun = path.relative(requestedSlop, requestedRun);
  if (relativeRun === '..' || relativeRun.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRun)) {
    relativeRun = path.relative(slop, requestedRun);
  }
  assert.ok(relativeRun !== '' && relativeRun !== '..' && !relativeRun.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeRun), 'run must be a prepared run inside blogRoot/slop');
  const runPath = path.resolve(slop, relativeRun);
  const runInfo = await lstat(runPath);
  assert.ok(runInfo.isDirectory() && !runInfo.isSymbolicLink(), 'run must be a regular prepared run directory');
  const canonicalRun = await realpath(runPath);
  assert.ok(containsPath(slop, canonicalRun), 'run must resolve inside blogRoot/slop');
  const target = await newOutputPath(root, requestedRoot, out);
  return evaluator.gradeRun({ run: canonicalRun, out: target, label, solRoot });
}

function isProtocolPath(relativePath) {
  return EXCLUDED_FILES.has(relativePath)
    || relativePath === PROTOCOL_DIRECTORY
    || relativePath.startsWith(`${PROTOCOL_DIRECTORY}/`);
}

function shouldCopy(relativePath) {
  if (isProtocolPath(relativePath)) return false;
  if (relativePath.startsWith('slop/')) return false;
  return true;
}

async function inspectSource(sourceRoot) {
  const entries = [];
  const rootInfo = await lstat(sourceRoot);
  assert.ok(rootInfo.isDirectory() && !rootInfo.isSymbolicLink(), 'source must remain a regular directory');
  async function walk(directory, prefix = '') {
    for (const name of (await readdir(directory)).sort()) {
      const relativePath = prefix ? `${prefix}/${name}` : name;
      const absolutePath = path.join(directory, name);
      const info = await lstat(absolutePath);
      if (info.isSymbolicLink()) throw new Error(`Source contains a symbolic link: ${relativePath}`);
      if (info.isDirectory()) {
        if (relativePath === '.git') continue;
        entries.push({ relativePath, kind: 'directory', copy: shouldCopy(relativePath) });
        await walk(absolutePath, relativePath);
      } else if (info.isFile()) {
        entries.push({ relativePath, kind: 'file', copy: shouldCopy(relativePath) });
      } else {
        throw new Error(`Source contains a non-regular entry: ${relativePath}`);
      }
    }
  }
  await walk(sourceRoot);
  return entries;
}

async function requireGradingDestination(destination) {
  const absolute = path.resolve(destination);
  assert.equal(path.basename(absolute), 'workspace', 'destination must end in B01..B08/workspace');
  const caseId = path.basename(path.dirname(absolute));
  assert.match(caseId, /^B0[1-8]$/u, 'destination must end in B01..B08/workspace');
  const caseDirectory = path.dirname(absolute);
  const caseInfo = await lstat(caseDirectory);
  assert.ok(caseInfo.isDirectory() && !caseInfo.isSymbolicLink(), 'The grading case directory must be a regular directory');

  const runRoot = path.dirname(caseDirectory);
  const runInfo = await lstat(runRoot);
  assert.ok(runInfo.isDirectory() && !runInfo.isSymbolicLink(), 'destination must belong to a regular grading run');
  const baselineInfo = await lstat(path.join(runRoot, 'baseline'));
  assert.ok(baselineInfo.isDirectory() && !baselineInfo.isSymbolicLink(), 'destination must belong to a prepared grading run');
  const metadataPath = path.join(runRoot, 'run.json');
  const metadataInfo = await lstat(metadataPath);
  assert.ok(metadataInfo.isFile() && !metadataInfo.isSymbolicLink(), 'Prepared grading metadata must be a regular file');
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  assert.equal(metadata.schema_version, 1);
  assert.equal(metadata.benchmark_id, 'blog-eval-v1');
  assert.ok(Array.isArray(metadata.case_ids) && metadata.case_ids.includes(caseId), 'The prepared grading run must include destination case');
  return absolute;
}

export async function projectForGrade({ source, destination } = {}) {
  requireString(source, 'source');
  requireString(destination, 'destination');
  const sourcePath = path.resolve(source);
  const sourceInfo = await lstat(sourcePath);
  assert.ok(sourceInfo.isDirectory() && !sourceInfo.isSymbolicLink(), 'source must be a regular directory');
  const sourceRoot = await realpath(sourcePath);
  const destinationPath = await requireGradingDestination(destination);
  const parent = path.dirname(destinationPath);
  const canonicalDestination = path.join(await realpath(parent), path.basename(destinationPath));
  assert.ok(!containsPath(sourceRoot, canonicalDestination) && !containsPath(canonicalDestination, sourceRoot), 'source and destination must not overlap');
  try {
    await lstat(destinationPath);
    throw new Error('destination must not already exist');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const entries = await inspectSource(sourceRoot);
  await mkdir(destinationPath);
  try {
    const rootInfo = await lstat(sourceRoot);
    if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new Error('Source changed after inspection');
    for (const entry of entries) {
      if (!entry.copy) continue;
      const input = path.join(sourceRoot, ...entry.relativePath.split('/'));
      const output = path.join(destinationPath, ...entry.relativePath.split('/'));
      const info = await lstat(input);
      if (info.isSymbolicLink()) throw new Error(`Source contains a symbolic link: ${entry.relativePath}`);
      if (entry.kind === 'directory') {
        if (!info.isDirectory()) throw new Error(`Source entry changed type: ${entry.relativePath}`);
        await mkdir(output);
      } else {
        if (!info.isFile()) throw new Error(`Source entry changed type: ${entry.relativePath}`);
        await copyFile(input, output);
      }
    }
  } catch (error) {
    const created = await lstat(destinationPath).catch(() => null);
    if (created?.isDirectory() && !created.isSymbolicLink()) await rm(destinationPath, { recursive: true, force: true });
    throw error;
  }
  return destinationPath;
}
