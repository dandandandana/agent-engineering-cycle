import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runCheck } from '../src/local/check-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLAN_FILE = path.join(HERE, 'data', 'blog-reuse-v2.json');
const PLAN_BYTES = await fs.readFile(PLAN_FILE);
const PLAN = JSON.parse(PLAN_BYTES.toString('utf8'));
const PLAN_SHA256 = sha(PLAN_BYTES);
const freezeObjects = new WeakSet();
const evidenceObjects = new WeakSet();
const CHECK_TIMEOUT_MS = 30_000;
const MAX_CHECK_OUTPUT_BYTES = 1024 * 1024;

function sha(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function samePath(left, right) {
  const normalize = value => {
    let result = path.resolve(value);
    if (process.platform === 'win32') result = result.replace(/^\\\\\?\\UNC\\/iu, '\\\\').replace(/^\\\\\?\\/u, '').toLowerCase();
    return result;
  };
  return normalize(left) === normalize(right);
}

async function regularDirectory(value, label) {
  const info = await fs.lstat(value);
  assert.ok(info.isDirectory() && !info.isSymbolicLink(), `${label} must be a regular directory`);
  const real = await fs.realpath(value);
  const canonicalFromParent = path.join(await fs.realpath(path.dirname(value)), path.basename(value));
  assert.ok(samePath(canonicalFromParent, real), `${label} must not traverse a link`);
  return real;
}

async function regularFile(value, label) {
  const info = await fs.lstat(value);
  assert.ok(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  return fs.readFile(value);
}

async function hashTree(root) {
  const files = [];
  async function walk(directory, prefix = '') {
    for (const name of (await fs.readdir(directory)).sort()) {
      const relative = prefix ? `${prefix}/${name}` : name;
      const absolute = path.join(directory, name);
      const info = await fs.lstat(absolute);
      assert.ok(!info.isSymbolicLink(), `Tree contains a symbolic link: ${relative}`);
      if (info.isDirectory()) await walk(absolute, relative);
      else {
        assert.ok(info.isFile(), `Tree contains a non-regular entry: ${relative}`);
        files.push({ path: relative, sha256: sha(await fs.readFile(absolute)) });
      }
    }
  }
  await walk(root);
  return { files, sha256: sha(JSON.stringify(files)) };
}

async function copyTree(source, destination) {
  const sourceRoot = await regularDirectory(source, 'copy source');
  await fs.mkdir(destination, { recursive: true });
  for (const name of (await fs.readdir(sourceRoot)).sort()) {
    const input = path.join(sourceRoot, name);
    const output = path.join(destination, name);
    const info = await fs.lstat(input);
    assert.ok(!info.isSymbolicLink(), `Source contains a symbolic link: ${name}`);
    if (info.isDirectory()) await copyTree(input, output);
    else {
      assert.ok(info.isFile(), `Source contains a non-regular entry: ${name}`);
      await fs.copyFile(input, output);
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

async function evaluatorAt(blogRoot) {
  const root = await regularDirectory(path.resolve(blogRoot), 'blogRoot');
  const evals = await regularDirectory(path.join(root, 'evals'), 'blogRoot/evals');
  const runnerPath = path.join(evals, 'runner.mjs');
  await regularFile(runnerPath, 'blog-eval runner');
  const runner = await import(`${pathToFileURL(runnerPath).href}?blog-reuse-v2=${randomUUID()}`);
  assert.equal(typeof runner.ROOT, 'string');
  assert.ok(samePath(await fs.realpath(runner.ROOT), root), 'Selected runner does not belong to blogRoot');
  assert.equal(typeof runner.installReference, 'function', 'Original evaluator must export installReference');
  return { root, evals, runner };
}

async function readTasks(evals) {
  const bytes = await regularFile(path.join(evals, 'tasks.json'), 'blog-eval tasks');
  const tasks = JSON.parse(bytes.toString('utf8'));
  assert.equal(tasks.schema_version, 1);
  assert.equal(tasks.benchmark_id, PLAN.source_benchmark_id);
  assert.deepEqual(tasks.cases.map(task => task.id), PLAN.case_ids);
  const source = tasks.cases.flatMap(task => task.reuse.map(opportunity => ({
    id: `${task.id}/${opportunity.id}.${opportunity.export_name}`,
    case_id: task.id,
    path: opportunity.path,
    export_name: opportunity.export_name,
    kind: opportunity.kind,
  })));
  const expected = PLAN.opportunities.map(({ id, case_id, path: file, export_name, kind }) => ({
    id, case_id, path: file, export_name, kind,
  }));
  assert.deepEqual(source, expected, 'The v1 reuse opportunities changed; freeze a new benchmark explicitly.');
  for (const opportunity of PLAN.opportunities) {
    assert.ok(opportunity.consumer_checks.length > 0, `${opportunity.id} needs task-consumer checks`);
    assert.ok(opportunity.consumer_checks.every(check => PLAN.check_ids[opportunity.case_id].includes(check)), `${opportunity.id} references a non-task check`);
    assert.ok(opportunity.compatibility_checks?.every(check => PLAN.check_ids[opportunity.case_id].includes(check)) ?? true);
    assert.equal(typeof opportunity.sentinel_id, 'string', `${opportunity.id} needs a frozen deterministic sentinel`);
    if (opportunity.kind === 'extend') {
      const moduleId = opportunity.id.slice(opportunity.case_id.length + 1).split('.').slice(0, 2).join('.');
      const extension = tasks.cases.find(task => task.id === opportunity.case_id)?.extensions?.find(value => value.module_id === moduleId);
      assert.ok(extension?.options_add.includes(opportunity.compatibility?.option), `${opportunity.id} extension compatibility does not match v1 task metadata`);
      assert.ok(opportunity.compatibility_checks?.length, `${opportunity.id} needs fixed compatibility checks`);
    } else {
      assert.equal(opportunity.compatibility, undefined);
    }
  }
  assert.equal(PLAN.opportunities.length, PLAN.denominator);
  assert.equal(new Set(PLAN.opportunities.map(value => value.id)).size, PLAN.denominator);
  return { tasks, bytes };
}

async function inputIdentity(root, evals) {
  const paths = [
    'tasks.json', 'rubric.mjs', 'runner.mjs', 'verify.mjs', 'sol.mjs',
  ];
  const inputs = [];
  for (const relative of paths) {
    const bytes = await regularFile(path.join(evals, relative), `blog-eval/${relative}`);
    inputs.push({ path: `evals/${relative}`, sha256: sha(bytes) });
  }
  const references = path.join(evals, 'reference');
  const referenceInfo = await fs.lstat(references);
  assert.ok(referenceInfo.isDirectory() && !referenceInfo.isSymbolicLink(), 'blog-eval/reference must be a regular directory');
  const reference = await hashTree(references);
  inputs.push({ path: 'evals/reference', sha256: reference.sha256, files: reference.files });
  return { files: inputs, sha256: sha(JSON.stringify(inputs)) };
}

async function buildFreeze({ blogRoot, preparedRun }) {
  assert.equal(typeof preparedRun, 'string', 'preparedRun must be a path returned by the original v1 evaluator');
  assert.equal(sha(await regularFile(PLAN_FILE, 'blog-reuse-v2 freeze data')), PLAN_SHA256, 'The v2 freeze data changed after scorer load.');
  const { root, evals } = await evaluatorAt(blogRoot);
  const { bytes: taskBytes } = await readTasks(evals);
  const runRoot = await regularDirectory(path.resolve(preparedRun), 'preparedRun');
  const slopRoot = await regularDirectory(path.join(root, 'slop'), 'blog-eval/slop');
  assert.ok(isWithin(slopRoot, runRoot) && !samePath(slopRoot, runRoot), 'preparedRun must be a child of blog-eval/slop');
  const runBytes = await regularFile(path.join(runRoot, 'run.json'), 'prepared v1 run metadata');
  const run = JSON.parse(runBytes.toString('utf8'));
  assert.equal(run.schema_version, 1);
  assert.equal(run.benchmark_id, PLAN.source_benchmark_id);
  assert.deepEqual(run.case_ids, PLAN.case_ids, 'v2 freezes the complete eight-task v1 run');
  assert.match(run.bundle_sha256, /^[a-f0-9]{64}$/u);
  const baseline = await regularDirectory(path.join(runRoot, 'baseline'), 'prepared v1 baseline');
  const baselineIdentity = await hashTree(baseline);
  const inputs = await inputIdentity(root, evals);
  const codeBytes = await regularFile(fileURLToPath(import.meta.url), 'blog-reuse-v2 implementation');
  const data = {
    schema_version: PLAN.schema_version,
    benchmark_id: PLAN.benchmark_id,
    source_benchmark_id: PLAN.source_benchmark_id,
    blog_root: root,
    prepared_run: runRoot,
    denominator: PLAN.denominator,
    eligible_opportunity_ids: PLAN.opportunities.map(value => value.id),
    eligible_count: PLAN.opportunities.length,
    plan_sha256: PLAN_SHA256,
    implementation_sha256: sha(codeBytes),
    v1: {
      bundle_sha256: run.bundle_sha256,
      run_json_sha256: sha(runBytes),
      baseline: baselineIdentity,
      input_files: inputs,
      task_bytes_sha256: sha(taskBytes),
    },
  };
  const freeze = { ...data, freeze_sha256: sha(JSON.stringify(data)) };
  deepFreeze(freeze);
  freezeObjects.add(freeze);
  return freeze;
}

/** Freeze the full v1 corpus identity and the 25 predeclared opportunities before candidate grading. */
export async function freezeBlogReuseV2({ blogRoot, preparedRun } = {}) {
  return buildFreeze({ blogRoot, preparedRun });
}

async function validateFreeze(freeze, options) {
  assert.ok(freezeObjects.has(freeze), 'Use the live result of freezeBlogReuseV2; serialized or caller-built freezes cannot score.');
  const current = await buildFreeze(options);
  assert.deepEqual(freeze, current, 'Frozen v1 inputs or the v2 scorer changed after freeze.');
  return current;
}

function exportDeclaration(ast, exportName) {
  const matches = [];
  for (const statement of ast.body) {
    if (statement.type !== 'ExportNamedDeclaration') continue;
    const declaration = statement.declaration;
    if (declaration?.type === 'FunctionDeclaration' && declaration.id?.name === exportName) {
      matches.push({ statement, declaration });
      continue;
    }
    if (declaration?.type === 'VariableDeclaration') {
      for (const item of declaration.declarations) if (item.id?.name === exportName) matches.push({ statement, declaration: item.init });
    }
    for (const specifier of statement.specifiers ?? []) {
      if ((specifier.exported?.name ?? specifier.exported?.value) === exportName) matches.push({ statement, declaration: null });
    }
  }
  assert.equal(matches.length, 1, `Expected exactly one named export ${exportName}`);
  return matches[0];
}

function visit(node, callback, parent = null, key = '') {
  if (!node || typeof node !== 'object') return;
  if (node.type) callback(node, parent, key);
  for (const [name, value] of Object.entries(node)) {
    if (Array.isArray(value)) for (const child of value) visit(child, callback, node, name);
    else if (value && typeof value === 'object') visit(value, callback, node, name);
  }
}

function shape(node, parent, key) {
  if (Array.isArray(node)) return node.map(value => shape(value, parent, key));
  if (!node || typeof node !== 'object') return node;
  if (node.type === 'Identifier') {
    return { type: node.type, name: (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed
      || parent?.type === 'Property' && key === 'key' && !parent.computed) ? node.name : '<binding>' };
  }
  return Object.fromEntries(Object.entries(node)
    .filter(([name]) => !['start', 'end', 'loc', 'raw'].includes(name))
    .map(([name, value]) => [name, shape(value, node, name)]));
}

function bodyDescriptors(ast, parse) {
  const result = [];
  visit(ast, (node, parent, key) => {
    if (!['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.type)) return;
    if (!node.body || node.body.end - node.body.start < 80) return;
    let name = node.id?.name ?? null;
    if (!name && parent?.type === 'VariableDeclarator' && key === 'init') name = parent.id?.name ?? null;
    result.push({ name, fingerprint: sha(JSON.stringify(shape(node.body, null, ''))), start: node.start, end: node.end });
  });
  return result;
}

function originalRubricFingerprint(targetSource, exportName, parse) {
  const ast = parse(targetSource, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
  const { declaration } = exportDeclaration(ast, exportName);
  if (!declaration || !['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(declaration.type) || !declaration.body) return null;
  if (declaration.body.end - declaration.body.start < 80) return null;
  return sha(JSON.stringify(shape(declaration.body, null, '')));
}

function cloneDiagnostic({ baselineTarget, candidateEntry, exportName, parse }) {
  try {
    const targetFingerprint = originalRubricFingerprint(baselineTarget, exportName, parse);
    if (!targetFingerprint) return { status: 'unknown', reason: 'UNSUPPORTED_OR_SHORT_TARGET_BODY', matches: [] };
    const entry = parse(candidateEntry, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const matches = bodyDescriptors(entry, parse).filter(value => value.fingerprint === targetFingerprint);
    return {
      status: matches.length ? 'match' : 'not_detected',
      algorithm: 'blog-eval-v1/rubric.mjs:bodies-shape-v1',
      target_fingerprint: targetFingerprint,
      matches,
    };
  } catch (error) {
    return { status: 'unknown', reason: 'FINGERPRINT_PARSE_FAILED', message: String(error.message).slice(0, 300), matches: [] };
  }
}

function importCallDiagnostic(candidateEntry, opportunity, parse) {
  try {
    const ast = parse(candidateEntry, { ecmaVersion: 'latest', sourceType: 'module', locations: true });
    const imports = new Map();
    const targetSuffix = opportunity.path.replace(/^src\//u, './');
    for (const statement of ast.body) {
      if (statement.type !== 'ImportDeclaration' || statement.source.value !== targetSuffix) continue;
      for (const specifier of statement.specifiers) {
        if (specifier.type === 'ImportSpecifier'
          && (specifier.imported.name ?? specifier.imported.value) === opportunity.export_name) {
          imports.set(specifier.local.name, { kind: 'named', source: statement.source.value });
        } else if (specifier.type === 'ImportNamespaceSpecifier') {
          imports.set(specifier.local.name, { kind: 'namespace', source: statement.source.value });
        }
      }
    }
    const calls = [];
    visit(ast, (node, parent) => {
      if (node.type !== 'CallExpression') return;
      const callee = node.callee;
      if (callee.type === 'Identifier' && imports.has(callee.name) && imports.get(callee.name).kind === 'named') {
        calls.push({ line: node.loc?.start.line ?? null, local: callee.name, result_discarded: parent?.type === 'ExpressionStatement' || parent?.type === 'UnaryExpression' && parent.operator === 'void' });
      } else if (callee.type === 'MemberExpression' && callee.object.type === 'Identifier'
        && imports.get(callee.object.name)?.kind === 'namespace'
        && (callee.property.name ?? callee.property.value) === opportunity.export_name) {
        calls.push({ line: node.loc?.start.line ?? null, local: callee.object.name, result_discarded: parent?.type === 'ExpressionStatement' });
      }
    });
    return { status: 'observed_or_not_observed', import_count: imports.size, calls };
  } catch (error) {
    return { status: 'unknown', reason: 'CALL_DIAGNOSTIC_PARSE_FAILED', message: String(error.message).slice(0, 300), calls: [] };
  }
}

function sentinelBody(sentinelId) {
  const bodies = {
    empty_array: 'return [];',
    missing_post: 'const posts = Array.isArray(args[0]) ? args[0] : []; const id = args[1]; return posts.find(post => post?.id !== id) ?? posts[0] ?? null;',
    empty_rating: 'const distribution = [1, 2, 3, 4, 5].map(rating => ({ rating, count: 0 })); return { count: 0, average: null, distribution };',
    empty_page: 'const options = args[1] ?? {}; const page = options.page ?? 1; const pageSize = options.pageSize ?? 6; return { items: [], total: 0, page, pageSize, pageCount: 0 };',
    reversed_array: 'return Array.isArray(args[0]) ? [...args[0]].reverse() : [];',
    poison_excerpt: "return '__BLOG_REUSE_V2_POISON__';",
    poison_review: "return args[0] && typeof args[0] === 'object' ? { ...args[0], author: '__BLOG_REUSE_V2_POISON__' } : null;",
    poison_review_status: "return args[0] && typeof args[0] === 'object' ? { ...args[0], status: 'pending', updatedAt: args[2] ?? args[0].updatedAt } : null;",
    skip_callback: 'const options = args[1] ?? {}; return { status: "completed", nextIndex: options.start ?? 0, results: [] };',
  };
  return bodies[sentinelId] ?? null;
}

async function poisonExport({ workspace, opportunity, sentinelId, parse }) {
  const target = path.join(workspace, ...opportunity.path.split('/'));
  const bytes = await regularFile(target, `candidate dependency ${opportunity.path}`);
  const source = bytes.toString('utf8');
  const ast = parse(source, { ecmaVersion: 'latest', sourceType: 'module' });
  const exported = exportDeclaration(ast, opportunity.export_name);
  const declaration = exported.declaration;
  const body = sentinelBody(sentinelId);
  if (!body || declaration?.type !== 'FunctionDeclaration' || !declaration.id?.name) {
    return { applied: false, reason: 'UNSUPPORTED_EXPORT_OR_SENTINEL', before_sha256: sha(bytes), after_sha256: null };
  }
  const prefix = declaration.async ? 'async ' : '';
  const replacement = `export ${prefix}function ${opportunity.export_name}(...args) { ${body} }`;
  const changed = `${source.slice(0, exported.statement.start)}${replacement}${source.slice(exported.statement.end)}`;
  parse(changed, { ecmaVersion: 'latest', sourceType: 'module' });
  await fs.writeFile(target, changed);
  return { applied: true, sentinel_id: sentinelId, before_sha256: sha(bytes), after_sha256: sha(changed), replacement_sha256: sha(replacement) };
}

async function runVerifier({ blogRoot, root, taskId, exportName, phase, timeoutMs }) {
  const verifier = path.join(blogRoot, 'evals', 'verify.mjs');
  const sourceBefore = await hashTree(await regularDirectory(path.join(root, 'src'), `${phase} task source`));
  const facts = await runCheck({
    id: `blog-reuse-v2-${taskId}-${phase}`,
    argv: [process.execPath, verifier, taskId, root, exportName],
  }, { cwd: root, timeoutMs, maxOutputBytes: MAX_CHECK_OUTPUT_BYTES });
  const sourceAfter = await hashTree(await regularDirectory(path.join(root, 'src'), `${phase} task source after check`));
  const result = parseVerifierOutput(facts, taskId);
  const sourceStability = { unchanged: sourceBefore.sha256 === sourceAfter.sha256, before_sha256: sourceBefore.sha256, after_sha256: sourceAfter.sha256, file_count: sourceBefore.files.length };
  if (!sourceStability.unchanged) {
    result.status = 'unknown';
    result.reason = 'SOURCE_CHANGED_DURING_CHECK';
  }
  return { facts, result, source_stability: sourceStability };
}

function parseVerifierOutput(facts, taskId) {
  if (!facts.passed || !facts.output_complete || facts.capture_error || facts.cleanup_error) {
    return { status: 'unknown', reason: 'CHECK_PROCESS_NOT_VERIFIED', checks: null };
  }
  const lines = facts.stdout.replace(/\r?\n$/u, '').split(/\r?\n/u);
  if (lines.length !== 1 || !lines[0].startsWith('BLOG_EVAL_RESULT=')) {
    return { status: 'unknown', reason: 'BLOG_EVAL_RESULT_MISSING_OR_AMBIGUOUS', checks: null };
  }
  let value;
  try { value = JSON.parse(lines[0].slice('BLOG_EVAL_RESULT='.length)); }
  catch { return { status: 'unknown', reason: 'BLOG_EVAL_RESULT_INVALID_JSON', checks: null }; }
  if (value?.case_id !== taskId || !Array.isArray(value.checks)) {
    return { status: 'unknown', reason: 'BLOG_EVAL_RESULT_SHAPE_INVALID', checks: null };
  }
  const expected = PLAN.check_ids[taskId];
  if (!Array.isArray(expected) || value.checks.length !== expected.length
    || value.checks.some((check, index) => check.id !== expected[index] || !['passed', 'failed'].includes(check.status))) {
    return { status: 'unknown', reason: 'BLOG_EVAL_CHECK_SET_DRIFT', checks: null };
  }
  return { status: value.checks.every(check => check.status === 'passed') ? 'passed' : 'failed', checks: value.checks };
}

function passingChecks(output) {
  return new Set((output?.checks ?? []).filter(check => check.status === 'passed').map(check => check.id));
}

function observedConsumerFailures(before, after, opportunity) {
  const beforeChecks = new Map((before?.checks ?? []).map(check => [check.id, check.status]));
  const afterChecks = new Map((after?.checks ?? []).map(check => [check.id, check]));
  return opportunity.consumer_checks
    .filter(id => beforeChecks.get(id) === 'passed' && afterChecks.get(id)?.status === 'failed')
    .map(id => ({ id, message: afterChecks.get(id)?.message ?? null }));
}

function isTaskAssertionFailure(message) {
  if (typeof message !== 'string') return false;
  return [
    /^Expected values to be strictly (?:deep-)?equal:/u,
    /^The expression evaluated to a falsy value:/u,
    /^The validation function is expected to return /u,
    /^Missing expected (?:exception|rejection)/u,
    /^Expected input to match /u,
  ].some(pattern => pattern.test(message));
}

function changedConsumerChecks(before, after, opportunity) {
  return observedConsumerFailures(before, after, opportunity)
    .filter(check => isTaskAssertionFailure(check.message))
    .map(check => check.id);
}

async function removeTemporaryDirectory(temporary) {
  const fact = {
    path: path.basename(temporary),
    remove_attempted: true,
    remove_error: null,
    inspection_error: null,
    exists_after: null,
    removed: false,
  };
  try { await fs.rm(temporary, { recursive: true, force: true }); }
  catch (error) { fact.remove_error = { code: error.code ?? 'CLEANUP_FAILED' }; }
  try {
    await fs.lstat(temporary);
    fact.exists_after = true;
  } catch (error) {
    if (error.code === 'ENOENT') fact.exists_after = false;
    else fact.inspection_error = { code: error.code ?? 'CLEANUP_INSPECTION_FAILED' };
  }
  fact.removed = fact.exists_after === false;
  return fact;
}

async function stageReference({ blogRoot, preparedRun, taskId, solRoot, evaluator }) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'blog-reuse-v2-reference-'));
  try {
    const workspace = path.join(temporary, taskId, 'workspace');
    await copyTree(path.join(preparedRun, 'baseline'), workspace);
    await evaluator.installReference(temporary, taskId, solRoot);
    return { temporary, workspace };
  } catch (error) {
    const wrapped = new Error(error?.message ?? String(error), { cause: error });
    wrapped.blogReuseV2Cleanup = await removeTemporaryDirectory(temporary);
    throw wrapped;
  }
}

async function stagedCopy(source, prefix) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  try {
    await copyTree(source, temporary);
    return { temporary, workspace: temporary };
  } catch (error) {
    const wrapped = new Error(error?.message ?? String(error), { cause: error });
    wrapped.blogReuseV2Cleanup = await removeTemporaryDirectory(temporary);
    throw wrapped;
  }
}

function checkIdsPassing(output, ids) {
  const checks = new Map((output?.checks ?? []).map(check => [check.id, check.status]));
  return ids.every(id => checks.get(id) === 'passed');
}

/**
 * Prove one opportunity against the original task consumer checks. The source mutation and both
 * verifier executions occur only in disposable copies; raw runCheck facts and verifier output are returned.
 */
export async function probeReuseContribution({
  blogRoot, solRoot, preparedRun, freeze, taskId, opportunityId, candidateRoot, timeoutMs = CHECK_TIMEOUT_MS,
} = {}) {
  const activeFreeze = await validateFreeze(freeze, { blogRoot, preparedRun });
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 180_000, 'Invalid verifier timeout.');
  const { root, runner: evaluator } = await evaluatorAt(blogRoot);
  const opportunity = PLAN.opportunities.find(value => value.id === opportunityId && value.case_id === taskId);
  assert.ok(opportunity, 'Opportunity is not part of the frozen v2 plan.');
  const taskWorkspace = path.resolve(candidateRoot);
  const preparedTaskWorkspace = path.join(activeFreeze.prepared_run, taskId, 'workspace');
  assert.ok(samePath(taskWorkspace, preparedTaskWorkspace), 'Candidate must be the exact workspace in the frozen v1 run.');
  await regularDirectory(taskWorkspace, 'candidateRoot');
  const task = JSON.parse((await regularFile(path.join(root, 'evals', 'tasks.json'), 'blog-eval tasks')).toString('utf8'))
    .cases.find(value => value.id === taskId);
  assert.ok(task);
  const candidateEntryPath = path.join(taskWorkspace, ...task.entry.split('/'));
  const candidateEntryBytes = await regularFile(candidateEntryPath, 'candidate task entry');
  const candidateTargetBytes = await regularFile(path.join(taskWorkspace, ...opportunity.path.split('/')), 'candidate target module');
  const baselineTargetBytes = await regularFile(path.join(activeFreeze.prepared_run, 'baseline', ...opportunity.path.split('/')), 'v1 baseline target module');
  const solModule = await import(pathToFileURL(path.join(root, 'evals', 'sol.mjs')).href);
  const sol = await solModule.loadSol(solRoot);
  const staticCalls = importCallDiagnostic(candidateEntryBytes.toString('utf8'), opportunity, sol.parse);
  const clone = cloneDiagnostic({
    baselineTarget: baselineTargetBytes.toString('utf8'),
    candidateEntry: candidateEntryBytes.toString('utf8'),
    exportName: opportunity.export_name,
    parse: sol.parse,
  });
  const evidence = {
    schema_version: 1,
    kind: 'blog_reuse_v2_contribution_probe',
    freeze_sha256: activeFreeze.freeze_sha256,
    opportunity_id: opportunity.id,
    case_id: taskId,
    effect_kind: opportunity.effect_kind,
    status: 'unknown',
    reason: null,
    clone_diagnostic: clone,
    static_call_diagnostic: staticCalls,
    hashes: {
      candidate_entry_sha256: sha(candidateEntryBytes),
      candidate_target_sha256: sha(candidateTargetBytes),
      baseline_target_sha256: sha(baselineTargetBytes),
    },
    reference: null,
    candidate: null,
  };

  let referenceStage;
  let referencePerturbStage;
  let candidatePerturbStage;
  try {
    referenceStage = await stageReference({ blogRoot: root, preparedRun: activeFreeze.prepared_run, taskId, solRoot, evaluator });
    const referenceBaseline = await runVerifier({ blogRoot: root, root: referenceStage.workspace, taskId, exportName: task.export_name, phase: 'reference', timeoutMs });
    const referenceFilesPass = referenceBaseline.result.status === 'passed';
    evidence.reference = {
      baseline: referenceBaseline, perturbed: null, sentinel: null, calibrated: false,
      observed_consumer_failures: [], changed_consumer_checks: [], unqualified_consumer_checks: [],
    };
    if (!referenceFilesPass) {
      evidence.reason = referenceBaseline.result.status === 'unknown' ? 'REFERENCE_BASELINE_UNVERIFIED' : 'REFERENCE_BASELINE_NOT_PASSING';
    } else {
      referencePerturbStage = await stagedCopy(referenceStage.workspace, 'blog-reuse-v2-reference-perturbed-');
      evidence.reference.sentinel = await poisonExport({
        workspace: referencePerturbStage.workspace,
        opportunity,
        sentinelId: opportunity.sentinel_id,
        parse: sol.parse,
      });
      if (!evidence.reference.sentinel.applied) {
        evidence.reason = evidence.reference.sentinel.reason;
      } else {
        const referencePerturbed = await runVerifier({ blogRoot: root, root: referencePerturbStage.workspace, taskId, exportName: task.export_name, phase: 'reference-perturbed', timeoutMs });
        evidence.reference.perturbed = referencePerturbed;
        evidence.reference.observed_consumer_failures = observedConsumerFailures(referenceBaseline.result, referencePerturbed.result, opportunity);
        evidence.reference.changed_consumer_checks = evidence.reference.observed_consumer_failures
          .filter(check => isTaskAssertionFailure(check.message)).map(check => check.id);
        evidence.reference.unqualified_consumer_checks = evidence.reference.observed_consumer_failures
          .filter(check => !isTaskAssertionFailure(check.message)).map(check => check.id);
        evidence.reference.calibrated = referencePerturbed.result.status !== 'unknown'
          && evidence.reference.changed_consumer_checks.length > 0;
        if (!evidence.reference.calibrated) evidence.reason = referencePerturbed.result.status === 'unknown'
          ? 'REFERENCE_PERTURBATION_UNVERIFIED'
          : evidence.reference.observed_consumer_failures.length
            ? 'REFERENCE_FAILURE_NOT_ASSERTION' : 'REFERENCE_SENTINEL_DID_NOT_CHANGE_MAPPED_TASK_CHECK';
      }
    }

    if (!evidence.reference.calibrated) return evidence;

    const candidateBaseline = await runVerifier({ blogRoot: root, root: taskWorkspace, taskId, exportName: task.export_name, phase: 'candidate', timeoutMs });
    evidence.candidate = {
      baseline: candidateBaseline, perturbed: null, sentinel: null,
      observed_consumer_failures: [], changed_consumer_checks: [], unqualified_consumer_checks: [],
    };
    if (candidateBaseline.result.status !== 'passed') {
      evidence.reason = candidateBaseline.result.status === 'unknown' ? 'CANDIDATE_BASELINE_UNVERIFIED' : 'CANDIDATE_TASK_BEHAVIOR_NOT_PASSING';
      return evidence;
    }

    candidatePerturbStage = await stagedCopy(taskWorkspace, 'blog-reuse-v2-candidate-perturbed-');
    evidence.candidate.sentinel = await poisonExport({
      workspace: candidatePerturbStage.workspace,
      opportunity,
      sentinelId: opportunity.sentinel_id,
      parse: sol.parse,
    });
    if (!evidence.candidate.sentinel.applied) {
      evidence.reason = evidence.candidate.sentinel.reason;
      return evidence;
    }
    const candidatePerturbed = await runVerifier({ blogRoot: root, root: candidatePerturbStage.workspace, taskId, exportName: task.export_name, phase: 'candidate-perturbed', timeoutMs });
    evidence.candidate.perturbed = candidatePerturbed;
    evidence.candidate.observed_consumer_failures = observedConsumerFailures(candidateBaseline.result, candidatePerturbed.result, opportunity);
    evidence.candidate.changed_consumer_checks = evidence.candidate.observed_consumer_failures
      .filter(check => isTaskAssertionFailure(check.message)).map(check => check.id);
    evidence.candidate.unqualified_consumer_checks = evidence.candidate.observed_consumer_failures
      .filter(check => !isTaskAssertionFailure(check.message)).map(check => check.id);
    if (candidatePerturbed.result.status === 'unknown') {
      evidence.reason = 'CANDIDATE_PERTURBATION_UNVERIFIED';
    } else if (clone.status === 'match') {
      evidence.reason = 'CANDIDATE_ENTRY_CLONES_TARGET_BODY';
    } else if (evidence.candidate.changed_consumer_checks.length) {
      evidence.status = 'contributed';
      evidence.reason = null;
    } else {
      evidence.reason = evidence.candidate.observed_consumer_failures.length
        ? 'CANDIDATE_FAILURE_NOT_ASSERTION' : 'NO_MAPPED_TASK_CONSUMER_CHECK_DIFFERENCE';
    }
    return evidence;
  } catch (error) {
    evidence.reason = 'PROBE_EXECUTION_UNVERIFIED';
    evidence.error = { name: error.name ?? 'Error', code: error.code ?? null, message: String(error.message ?? error).slice(0, 400) };
    if (error.blogReuseV2Cleanup) {
      evidence.temporary_cleanup = {
        attempted: [error.blogReuseV2Cleanup],
        errors: error.blogReuseV2Cleanup.removed ? [] : [error.blogReuseV2Cleanup],
      };
    }
    return evidence;
  } finally {
    const cleanupFacts = evidence.temporary_cleanup?.attempted ?? [];
    for (const staged of [candidatePerturbStage, referencePerturbStage, referenceStage]) {
      if (!staged?.temporary) continue;
      cleanupFacts.push(await removeTemporaryDirectory(staged.temporary));
    }
    const cleanupErrors = cleanupFacts.filter(fact => !fact.removed);
    evidence.temporary_cleanup = { attempted: cleanupFacts, errors: cleanupErrors };
    if (cleanupErrors.length) {
      evidence.status = 'unknown';
      evidence.reason = 'TEMPORARY_DIRECTORY_CLEANUP_FAILED';
      evidence.cleanup_errors = cleanupErrors;
    }
    deepFreeze(evidence);
    evidenceObjects.add(evidence);
  }
}

/** Aggregate only live evidence objects returned by this module in this process. */
export async function scoreBlogReuseV2({ blogRoot, preparedRun, freeze, evidence = [] } = {}) {
  assert.ok(freezeObjects.has(freeze), 'A live freezeBlogReuseV2 result is required.');
  await validateFreeze(freeze, { blogRoot, preparedRun });
  assert.ok(Array.isArray(evidence), 'evidence must be an array returned by probeReuseContribution.');
  const eligible = new Set(freeze.eligible_opportunity_ids);
  const byId = new Map();
  for (const item of evidence) {
    assert.ok(evidenceObjects.has(item), 'Caller-created evidence cannot score; use probeReuseContribution.');
    assert.equal(item.freeze_sha256, freeze.freeze_sha256, 'Evidence belongs to a different freeze.');
    assert.ok(eligible.has(item.opportunity_id), 'Evidence opportunity is outside the frozen eligible set.');
    assert.ok(!byId.has(item.opportunity_id), 'Duplicate opportunity evidence is ambiguous.');
    byId.set(item.opportunity_id, item);
  }
  const m = [...byId.values()].filter(item => item.status === 'contributed'
    && item.reference?.calibrated === true
    && item.reference.changed_consumer_checks.length > 0
    && item.candidate?.baseline?.result?.status === 'passed'
    && item.candidate?.changed_consumer_checks?.length > 0).length;
  const e = freeze.eligible_count;
  const probedIds = PLAN.opportunities.map(value => value.id).filter(id => byId.has(id));
  const referenceCalibratedIds = PLAN.opportunities.map(value => value.id).filter(id => byId.get(id)?.reference?.calibrated === true);
  return {
    benchmark_id: PLAN.benchmark_id,
    M: m,
    denominator: PLAN.denominator,
    M_over_25: m / PLAN.denominator,
    E: e,
    M_over_E: e === 0 ? null : m / e,
    M_over_E_display: e === 0 ? 'N/A' : `${(m / e * 100).toFixed(1)}%`,
    coverage_limits: {
      probed_opportunity_ids: probedIds,
      unprobed_opportunity_ids: PLAN.opportunities.map(value => value.id).filter(id => !byId.has(id)),
      reference_control_calibrated_opportunity_ids: referenceCalibratedIds,
      reference_control_unverified_opportunity_ids: PLAN.opportunities.map(value => value.id).filter(id => !referenceCalibratedIds.includes(id)),
      reference_control_coverage: referenceCalibratedIds.length === e ? 'complete' : referenceCalibratedIds.length === 0 ? 'none' : 'partial',
      reference_control_calibrated_count: referenceCalibratedIds.length,
      eligible_count: e,
      interpretation: 'Calibration and contribution are per opportunity; an unprobed or uncalibrated opportunity is unknown and must not inherit another opportunity\'s result.',
    },
    necessary_new: {
      status: 'not_assessed',
      reported_separately_by: 'D/QA',
      counted_in_M: false,
    },
    unknown_opportunity_ids: PLAN.opportunities.map(value => value.id).filter(id => !byId.has(id) || byId.get(id).status !== 'contributed'),
    opportunities: PLAN.opportunities.map(value => ({
      id: value.id,
      status: byId.get(value.id)?.status ?? 'unknown',
      reason: byId.get(value.id)?.reason ?? 'NO_PROBE_EVIDENCE',
      clone_diagnostic: byId.get(value.id)?.clone_diagnostic ?? { status: 'unknown', reason: 'NO_PROBE_EVIDENCE' },
    })),
  };
}

export const blogReuseV2Plan = deepFreeze(PLAN);

const CALIBRATION_FAILURE_REASONS = new Set([
  'REFERENCE_BASELINE_NOT_PASSING',
  'REFERENCE_SENTINEL_DID_NOT_CHANGE_MAPPED_TASK_CHECK',
  'REFERENCE_FAILURE_NOT_ASSERTION',
  'UNSUPPORTED_EXPORT_OR_SENTINEL',
  'CANDIDATE_TASK_BEHAVIOR_NOT_PASSING',
  'CANDIDATE_ENTRY_CLONES_TARGET_BODY',
  'CANDIDATE_FAILURE_NOT_ASSERTION',
  'NO_MAPPED_TASK_CONSUMER_CHECK_DIFFERENCE',
]);

function calibrationStatus(evidence) {
  if (evidence.status === 'contributed') return 'passed';
  return CALIBRATION_FAILURE_REASONS.has(evidence.reason) ? 'failed' : 'unknown';
}

function processFactsFor(evidence) {
  const values = [];
  for (const side of ['reference', 'candidate']) {
    for (const phase of ['baseline', 'perturbed']) {
      const facts = evidence[side]?.[phase]?.facts;
      if (facts) values.push({ side, phase, facts });
    }
  }
  return values;
}

function calibrationRow(evidence, capturePath) {
  const facts = processFactsFor(evidence);
  const sourceStability = {};
  for (const side of ['reference', 'candidate']) {
    sourceStability[side] = {};
    for (const phase of ['baseline', 'perturbed']) {
      sourceStability[side][phase] = evidence[side]?.[phase]?.source_stability ?? null;
    }
  }
  const observedSourceFacts = Object.values(sourceStability).flatMap(value => Object.values(value)).filter(Boolean);
  const temporaryCleanup = evidence.temporary_cleanup;
  const cleanupErrors = temporaryCleanup?.errors ?? evidence.cleanup_errors ?? [];
  const processCleanupErrors = facts.filter(value => value.facts.cleanup_error).map(value => ({
    side: value.side,
    phase: value.phase,
    error: value.facts.cleanup_error,
  }));
  return {
    opportunity_id: evidence.opportunity_id,
    case_id: evidence.case_id,
    status: calibrationStatus(evidence),
    reason: evidence.reason,
    reference_calibrated: evidence.reference?.calibrated ?? false,
    reference_changed_consumer_checks: evidence.reference?.changed_consumer_checks ?? [],
    candidate_baseline_status: evidence.candidate?.baseline?.result?.status ?? null,
    candidate_changed_consumer_checks: evidence.candidate?.changed_consumer_checks ?? [],
    clone_diagnostic: evidence.clone_diagnostic ?? { status: 'unknown', reason: 'NO_PROBE_EVIDENCE' },
    static_call_diagnostic: evidence.static_call_diagnostic ?? { status: 'unknown', reason: 'NO_PROBE_EVIDENCE' },
    process_facts: {
      count: facts.length,
      all_terminal_observed: facts.length > 0 && facts.every(value => value.facts.terminal_observed === true),
      all_exit_zero: facts.length > 0 && facts.every(value => value.facts.exit_code === 0),
      all_output_complete: facts.length > 0 && facts.every(value => value.facts.output_complete === true),
      failed_capture_or_cleanup: processCleanupErrors,
    },
    source_stability: {
      checks: sourceStability,
      all_observed_unchanged: observedSourceFacts.length > 0 && observedSourceFacts.every(value => value.unchanged === true),
    },
    temporary_cleanup: {
      observed: temporaryCleanup !== undefined,
      attempted_count: temporaryCleanup?.attempted?.length ?? 0,
      all_removed: temporaryCleanup === undefined ? null : cleanupErrors.length === 0
        && temporaryCleanup.attempted.every(fact => fact.removed === true),
      attempts: temporaryCleanup?.attempted ?? [],
      errors: cleanupErrors,
    },
    raw_capture_path: capturePath,
  };
}

function parseCalibrationArgs(argv) {
  const [command, ...args] = argv;
  if (command === '--help' || command === '-h' || command === 'help') return { help: true };
  assert.equal(command, 'reference-calibrate', 'Expected the reference-calibrate command.');
  const values = new Map();
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    assert.match(key, /^--[a-z][a-z-]*$/u, `Unexpected argument: ${key}`);
    assert.ok(!values.has(key), `Duplicate argument: ${key}`);
    const value = args[++index];
    assert.ok(value && !value.startsWith('--'), `Missing value for ${key}`);
    values.set(key, value);
  }
  for (const required of ['--blog-root', '--sol-root', '--out']) assert.ok(values.has(required), `${required} is required.`);
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : CHECK_TIMEOUT_MS;
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 180_000, 'Invalid --timeout-ms.');
  const unexpected = [...values.keys()].filter(key => !['--blog-root', '--sol-root', '--out', '--timeout-ms'].includes(key));
  assert.equal(unexpected.length, 0, `Unsupported argument: ${unexpected[0]}`);
  return {
    help: false,
    blogRoot: path.resolve(values.get('--blog-root')),
    solRoot: path.resolve(values.get('--sol-root')),
    out: path.resolve(values.get('--blog-root'), values.get('--out')),
    timeoutMs,
  };
}

function calibrationUsage() {
  return [
    'Usage:',
    '  node benchmarks/blog-reuse-v2.mjs reference-calibrate --blog-root <blog-eval-root> --sol-root <codex-sol-root> --out <new-path-under-blog-eval-slop> [--timeout-ms 30000]',
    '',
    'Runs only the frozen blog-eval-v1 reference positive controls for all 25 blog-reuse-v2 opportunities.',
    'Does not run a model, browser, or old-v1 grading.',
    'Writes one summary and per-opportunity raw runCheck captures under <out>/v2-reference-calibration/.',
  ].join('\n');
}

/** Run all 25 frozen reference controls without model, browser, or old-v1 grading. */
export async function calibrateBlogReuseV2Reference({ blogRoot, solRoot, out, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  assert.equal(typeof out, 'string', 'A fresh --out path is required.');
  assert.ok(Number.isSafeInteger(timeoutMs) && timeoutMs >= 100 && timeoutMs <= 180_000, 'Invalid calibration timeout.');
  const { root, runner } = await evaluatorAt(blogRoot);
  assert.equal(typeof runner.prepareRun, 'function', 'Original evaluator must export prepareRun.');
  assert.equal(typeof runner.installReference, 'function', 'Original evaluator must export installReference.');
  const output = path.isAbsolute(out) ? path.resolve(out) : path.resolve(root, out);
  const prepared = await runner.prepareRun({ out: output, solRoot });
  const freeze = await freezeBlogReuseV2({ blogRoot: root, preparedRun: prepared.out });
  const reportRoot = path.join(prepared.out, 'v2-reference-calibration');
  const capturesRoot = path.join(reportRoot, 'captures');
  await fs.mkdir(reportRoot, { recursive: false });
  await fs.mkdir(capturesRoot, { recursive: false });

  const rows = [];
  const evidenceByOpportunity = [];
  for (const taskId of PLAN.case_ids) {
    let installError = null;
    try { await runner.installReference(prepared.out, taskId, solRoot); }
    catch (error) { installError = { name: error.name ?? 'Error', code: error.code ?? null, message: String(error.message ?? error).slice(0, 400) }; }
    const opportunities = PLAN.opportunities.filter(value => value.case_id === taskId);
    for (const opportunity of opportunities) {
      let evidence;
      if (installError) {
        evidence = {
          schema_version: 1,
          kind: 'blog_reuse_v2_contribution_probe',
          freeze_sha256: freeze.freeze_sha256,
          opportunity_id: opportunity.id,
          case_id: taskId,
          effect_kind: opportunity.effect_kind,
          status: 'unknown',
          reason: 'REFERENCE_INSTALL_FAILED',
          setup_error: installError,
          reference: null,
          candidate: null,
        };
      } else {
        try {
          evidence = await probeReuseContribution({
            blogRoot: root,
            solRoot,
            preparedRun: prepared.out,
            freeze,
            taskId,
            opportunityId: opportunity.id,
            candidateRoot: path.join(prepared.out, taskId, 'workspace'),
            timeoutMs,
          });
        } catch (error) {
          evidence = {
            schema_version: 1,
            kind: 'blog_reuse_v2_contribution_probe',
            freeze_sha256: freeze.freeze_sha256,
            opportunity_id: opportunity.id,
            case_id: taskId,
            effect_kind: opportunity.effect_kind,
            status: 'unknown',
            reason: 'PROBE_SETUP_UNVERIFIED',
            setup_error: { name: error.name ?? 'Error', code: error.code ?? null, message: String(error.message ?? error).slice(0, 400) },
            reference: null,
            candidate: null,
          };
        }
      }
      const fileName = `${opportunity.id.replaceAll('/', '__').replaceAll('.', '_')}.json`;
      const relativeCapture = path.join('v2-reference-calibration', 'captures', fileName).split(path.sep).join('/');
      const capturePath = path.join(reportRoot, 'captures', fileName);
      await fs.writeFile(capturePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
      rows.push(calibrationRow(evidence, relativeCapture));
      evidenceByOpportunity.push(evidence);
    }
  }

  assert.equal(rows.length, PLAN.denominator, 'Reference calibration must retain all 25 frozen opportunities.');
  const passed = rows.filter(row => row.status === 'passed').length;
  const failed = rows.filter(row => row.status === 'failed').length;
  const unknown = rows.filter(row => row.status === 'unknown').length;
  const report = {
    schema_version: 1,
    kind: 'blog_reuse_v2_reference_positive_control_calibration',
    status: failed ? 'failed' : unknown ? 'unknown' : 'passed',
    model_or_browser_run: false,
    old_v1_grading_run: false,
    calibration_only: true,
    prepared_run: prepared.out,
    freeze,
    denominator: PLAN.denominator,
    E: freeze.eligible_count,
    counts: { passed, unknown, failed, total: rows.length },
    opportunities: rows,
    interpretation: 'This calibrates the per-opportunity reference positive controls only; it is not a candidate score or model result.',
  };
  const reportPath = path.join(reportRoot, 'report.json');
  await fs.writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: 'wx' });
  return { report, reportPath, evidence: evidenceByOpportunity };
}

async function runCli() {
  const options = parseCalibrationArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${calibrationUsage()}\n`);
    return;
  }
  const { report, reportPath } = await calibrateBlogReuseV2Reference(options);
  process.stdout.write(`${JSON.stringify({
    status: report.status,
    prepared_run: report.prepared_run,
    report_path: reportPath,
    denominator: report.denominator,
    E: report.E,
    counts: report.counts,
  }, null, 2)}\n`);
  if (report.status === 'failed') process.exitCode = 1;
  else if (report.status === 'unknown') process.exitCode = 2;
}

if (process.argv[1] && samePath(process.argv[1], fileURLToPath(import.meta.url))) {
  runCli().catch(error => {
    process.stderr.write(`blog-reuse-v2: ${error.message ?? error}\n`);
    process.exitCode = 1;
  });
}
