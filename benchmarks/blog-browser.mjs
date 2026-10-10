import { access, lstat, realpath, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { constants } from 'node:fs';
import { runCheck } from '../src/local/check-runner.mjs';

// browser-check.mjs records completed steps as ordered string IDs, without per-item status fields.
const REQUIRED_BROWSER_CHECKS = Object.freeze([
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
]);

function normalizeExpectedScriptSha256(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{64}$/iu.test(value)) {
    throw new TypeError('expectedScriptSha256 must be a 64-character hexadecimal SHA-256.');
  }
  return value.toLowerCase();
}

async function sha256File(file) {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}

function requirePath(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new TypeError(`${name} must be a non-empty path string.`);
  }
  return path.resolve(value);
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

async function statPath(file, label, { directory = false, regular = false } = {}) {
  let info;
  try {
    info = await lstat(file);
  } catch (error) {
    if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
      throw new Error(`${label} does not exist: ${file}`);
    }
    throw error;
  }
  if (info.isSymbolicLink() || (directory ? !info.isDirectory() : !info.isFile()) || (regular && !info.isFile())) {
    const expected = directory ? 'regular directory' : 'regular file';
    throw new Error(`${label} must be an existing ${expected}: ${file}`);
  }
  return info;
}

async function validateOptions({ projectRoot, packages, browser, out }) {
  const root = requirePath(projectRoot, 'projectRoot');
  const packageRoot = requirePath(packages, 'packages');
  const browserExecutable = requirePath(browser, 'browser');
  const output = requirePath(out, 'out');

  await statPath(root, 'projectRoot', { directory: true });
  const canonicalRoot = await realpath(root);

  const script = path.join(root, 'scripts', 'browser-check.mjs');
  await statPath(script, 'scripts/browser-check.mjs', { regular: true });
  const canonicalScript = await realpath(script);
  if (!isWithin(canonicalRoot, canonicalScript)) {
    throw new Error('scripts/browser-check.mjs must resolve inside projectRoot.');
  }

  await statPath(packageRoot, 'packages', { directory: true });
  let playwrightModule;
  try {
    playwrightModule = createRequire(path.join(packageRoot, 'runtime.cjs')).resolve('playwright');
  } catch (error) {
    throw new Error(`packages must resolve the Playwright module: ${error.message}`);
  }

  await statPath(browserExecutable, 'browser', { regular: true });
  await access(browserExecutable, constants.X_OK);

  const slop = path.join(root, 'slop');
  await statPath(slop, 'projectRoot/slop', { directory: true });
  const canonicalSlop = await realpath(slop);
  if (!isWithin(canonicalRoot, canonicalSlop) || canonicalRoot === canonicalSlop) {
    throw new Error('projectRoot/slop must be a directory inside projectRoot.');
  }

  const relativeOutput = path.relative(slop, output);
  if (!relativeOutput || relativeOutput === '..' || relativeOutput.startsWith(`..${path.sep}`) || path.isAbsolute(relativeOutput)) {
    throw new Error('out must be a new path inside projectRoot/slop.');
  }

  let outputInfo;
  try {
    outputInfo = await lstat(output);
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  if (outputInfo) throw new Error(`out must be new; the path already exists: ${output}`);

  const outputParent = path.dirname(output);
  await statPath(outputParent, 'out parent', { directory: true });
  const canonicalOutputParent = await realpath(outputParent);
  if (!isWithin(canonicalSlop, canonicalOutputParent)) {
    throw new Error('out parent must resolve inside projectRoot/slop.');
  }

  return { root, packageRoot, browserExecutable, output, script, playwrightModule };
}

/**
 * Run the demo project's existing real-browser acceptance script.
 * The script owns browser/server/store cleanup and writes browser-evidence.json.
 */
export async function runBlogBrowser({ projectRoot, packages, browser, out, expectedScriptSha256, timeoutMs = 120_000 } = {}) {
  const expectedHash = normalizeExpectedScriptSha256(expectedScriptSha256);
  const paths = await validateOptions({ projectRoot, packages, browser, out });
  const scriptHashBefore = await sha256File(paths.script);
  if (scriptHashBefore !== expectedHash) {
    throw new Error(`scripts/browser-check.mjs SHA-256 does not match expectedScriptSha256 (expected ${expectedHash}, found ${scriptHashBefore}).`);
  }

  const facts = await runCheck({
    id: 'blog-browser',
    argv: [
      process.execPath,
      paths.script,
      '--packages', paths.packageRoot,
      '--browser', paths.browserExecutable,
      '--out', paths.output,
    ],
  }, { cwd: paths.root, timeoutMs, maxOutputBytes: 4 * 1024 * 1024 });

  let scriptHashAfter = null;
  let scriptIntegrityError = null;
  try {
    scriptHashAfter = await sha256File(paths.script);
  } catch (error) {
    scriptIntegrityError = `scripts/browser-check.mjs could not be hashed after execution: ${error.message}`;
  }

  const evidencePath = path.join(paths.output, 'browser-evidence.json');
  let evidence = null;
  let evidenceError = null;
  try {
    evidence = JSON.parse(await readFile(evidencePath, 'utf8'));
  } catch (error) {
    evidenceError = error instanceof SyntaxError
      ? `browser-evidence.json is not valid JSON: ${error.message}`
      : `browser-evidence.json is unavailable: ${error.message}`;
  }

  const passed = facts.passed === true
    && scriptHashAfter === expectedHash
    && evidence?.status === 'passed'
    && Array.isArray(evidence.checks)
    && evidence.checks.length === REQUIRED_BROWSER_CHECKS.length
    && REQUIRED_BROWSER_CHECKS.every((check, index) => evidence.checks[index] === check)
    && Array.isArray(evidence.page_errors)
    && evidence.page_errors.length === 0;

  return {
    status: passed ? 'passed' : 'failed',
    passed,
    out: paths.output,
    evidence_path: evidencePath,
    script_integrity: {
      expected_sha256: expectedHash,
      before_sha256: scriptHashBefore,
      after_sha256: scriptHashAfter,
      unchanged: scriptHashAfter === scriptHashBefore,
    },
    script_integrity_error: scriptIntegrityError,
    facts,
    evidence,
    evidence_error: evidenceError,
  };
}
