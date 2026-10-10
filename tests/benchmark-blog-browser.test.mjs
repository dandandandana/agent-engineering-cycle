import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runBlogBrowser } from '../benchmarks/blog-browser.mjs';

// These temporary scripts exercise runner plumbing only; they do not launch a browser.
const STUB_CHECKS = [
  'real-list-pagination',
  'real-search',
  'real-review-pending-not-public',
  'real-bulk-approval',
  'real-moderation-and-safe-text',
  'real-hidden-review-removed',
  'real-draft-edit-and-publish',
  'empty-result',
  'injected-failure-retry-to-real-api',
  'mobile-no-horizontal-overflow',
  'keyboard-navigation',
];

async function fixture(t, evidence, { modifyScriptDuringRun = false } = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'blog-browser-wrapper-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await Promise.all([
    mkdir(path.join(root, 'scripts'), { recursive: true }),
    mkdir(path.join(root, 'slop'), { recursive: true }),
    mkdir(path.join(root, 'node_modules', 'playwright'), { recursive: true }),
  ]);
  const output = path.join(root, 'slop', 'browser-run');
  await writeFile(path.join(root, 'node_modules', 'playwright', 'package.json'), '{"name":"playwright","main":"index.js"}');
  await writeFile(path.join(root, 'node_modules', 'playwright', 'index.js'), '');
  await writeFile(path.join(root, 'browser.exe'), 'test executable', { mode: 0o755 });
  const script = `
    import { mkdir, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    const args = process.argv.slice(2);
    const options = Object.fromEntries(args.reduce((pairs, value, index) => {
      if (value.startsWith('--')) pairs.push([value, args[index + 1]]);
      return pairs;
    }, []));
    const output = options['--out'];
    await mkdir(output);
    await writeFile(path.join(output, 'browser-evidence.json'), ${JSON.stringify(JSON.stringify(evidence))});
    ${modifyScriptDuringRun ? "await writeFile(new URL(import.meta.url), '// changed during test\\n');" : ''}
  `;
  const scriptPath = path.join(root, 'scripts', 'browser-check.mjs');
  await writeFile(scriptPath, script);
  const expectedScriptSha256 = createHash('sha256').update(await readFile(scriptPath)).digest('hex');
  return {
    root,
    projectRoot: root,
    output,
    packages: path.join(root, 'node_modules'),
    browser: path.join(root, 'browser.exe'),
    scriptPath,
    expectedScriptSha256,
  };
}

test('stub runner plumbing requires passed facts and complete evidence fields', async (t) => {
  const good = await fixture(t, { status: 'passed', checks: STUB_CHECKS, page_errors: [] });
  const passed = await runBlogBrowser({ ...good, out: good.output });
  assert.equal(passed.facts.passed, true);
  assert.equal(passed.script_integrity.unchanged, true);
  assert.equal(passed.evidence.status, 'passed');
  assert.deepEqual(passed.evidence.checks, STUB_CHECKS);
  assert.deepEqual(passed.evidence.page_errors, []);
  assert.equal(passed.passed, true);
  assert.equal(passed.status, 'passed');

  const pageError = await fixture(t, { status: 'passed', checks: STUB_CHECKS, page_errors: ['page crashed'] });
  const failedEvidence = await runBlogBrowser({ ...pageError, out: pageError.output });
  assert.equal(failedEvidence.facts.passed, true);
  assert.equal(failedEvidence.passed, false);

  const failedStatus = await fixture(t, { status: 'failed', checks: STUB_CHECKS, page_errors: [] });
  const failedRun = await runBlogBrowser({ ...failedStatus, out: failedStatus.output });
  assert.equal(failedRun.facts.passed, true);
  assert.equal(failedRun.passed, false);

  const noChecks = await fixture(t, { status: 'passed', checks: [], page_errors: [] });
  const incomplete = await runBlogBrowser({ ...noChecks, out: noChecks.output });
  assert.equal(incomplete.facts.passed, true);
  assert.equal(incomplete.passed, false);
});

test('a changed browser script hash is rejected before the stub runner can start', async (t) => {
  const context = await fixture(t, { status: 'passed', checks: STUB_CHECKS, page_errors: [] });
  const marker = path.join(context.root, 'runner-started');
  await assert.rejects(
    runBlogBrowser({ ...context, expectedScriptSha256: 'invalid', out: context.output }),
    /64-character hexadecimal SHA-256/,
  );
  await writeFile(context.scriptPath, `
    import { writeFile } from 'node:fs/promises';
    await writeFile(${JSON.stringify(marker)}, 'started');
  `);

  await assert.rejects(
    runBlogBrowser({ ...context, out: context.output }),
    /SHA-256 does not match expectedScriptSha256/,
  );
  await assert.rejects(readFile(marker), { code: 'ENOENT' });
  await assert.rejects(lstat(context.output), { code: 'ENOENT' });
});

test('a browser script changed during execution cannot return a pass', async (t) => {
  const context = await fixture(t, { status: 'passed', checks: STUB_CHECKS, page_errors: [] }, { modifyScriptDuringRun: true });
  const result = await runBlogBrowser({ ...context, out: context.output });

  assert.equal(result.facts.passed, true);
  assert.equal(result.evidence.status, 'passed');
  assert.equal(result.script_integrity.unchanged, false);
  assert.notEqual(result.script_integrity.after_sha256, context.expectedScriptSha256);
  assert.equal(result.passed, false);
});

test('output must be a new child of projectRoot/slop', async (t) => {
  const context = await fixture(t, { status: 'passed', checks: STUB_CHECKS, page_errors: [] });
  await assert.rejects(
    runBlogBrowser({ ...context, out: path.join(context.root, 'outside') }),
    /inside projectRoot\/slop/,
  );
  await mkdir(context.output);
  await assert.rejects(
    runBlogBrowser({ ...context, out: context.output }),
    /out must be new/,
  );
});
