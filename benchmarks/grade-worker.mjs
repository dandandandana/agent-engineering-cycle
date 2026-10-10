import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { ZodError } from 'zod';
import { CASES } from './cases.mjs';

function errorFact(error) {
  return { name: error?.name ?? 'Error', code: error?.code ?? null, message: String(error?.message ?? error).slice(0, 400) };
}

async function gradeRecord(subject, check) {
  const { decodeRecord, recordSchema } = subject;
  await check('public-api', () => {
    assert.equal(typeof decodeRecord, 'function');
    assert.equal(typeof recordSchema?.safeParse, 'function');
  });
  const success = (input, factor, expected) => {
    const before = structuredClone(input);
    const output = factor === undefined ? decodeRecord(input) : decodeRecord(input, factor);
    assert.deepEqual(output, { ok: true, value: expected });
    assert.deepEqual(input, before);
  };
  await check('original-valid-inputs', () => {
    success({ id: ' item ', quantity: 3 }, undefined, { id: 'item', quantity: 3, total: 6 });
    success({ id: 'zero', quantity: 0 }, 0, { id: 'zero', quantity: 0, total: 0 });
    success({ id: 'max', quantity: 1000 }, 1.5, { id: 'max', quantity: 1000, total: 1500 });
  });
  await check('maintenance-numeric-strings', () => {
    for (const [quantity, numeric] of [['0', 0], [' 12 ', 12], ['0012', 12], ['1000', 1000]]) {
      success(Object.freeze({ id: ' item ', quantity }), 3, { id: 'item', quantity: numeric, total: numeric * 3 });
    }
  });
  const invalid = (input, factor) => {
    const before = structuredClone(input);
    const expected = recordSchema.safeParse(input);
    assert.equal(expected.success, false, 'public schema must reject this input');
    const actual = decodeRecord(input, factor);
    assert.equal(actual?.ok, false);
    assert.ok(actual.error instanceof ZodError, 'return the ZodError, not a replacement string/array/Error');
    assert.deepEqual(actual.error.issues, expected.error.issues);
    assert.deepEqual(input, before);
  };
  await check('rejected-quantities', () => {
    for (const quantity of ['', '  ', '+2', '-2', '1.5', '1e2', '0x10', 'Infinity', '1001', '9'.repeat(400), true, false, null, [], {}, -1, 1001, 1.5, Infinity, NaN]) {
      invalid({ id: 'x', quantity }, 2);
    }
  });
  await check('strict-record-errors', () => {
    for (const input of [null, [], {}, { id: 'x' }, { id: 'x', quantity: undefined }, { quantity: 2 }, { id: ' ', quantity: 2 }, { id: 2, quantity: 2 }, { id: 'x', quantity: 2, extra: 1 }]) invalid(input, 2);
  });
  await check('factor-errors-and-ordering', () => {
    for (const factor of [-1, Infinity, NaN, '2', null]) {
      assert.throws(() => decodeRecord({ id: 'x', quantity: 2 }, factor), RangeError);
    }
    invalid({ id: '', quantity: 2 }, -1);
  });
  await check('input-remains-unchanged', () => {
    success(Object.freeze({ id: ' trimmed ', quantity: 7 }), 4, { id: 'trimmed', quantity: 7, total: 28 });
    invalid(Object.freeze({ id: 'x', quantity: 'not a number' }), 2);
  });
}

async function gradePublish(subject, root, check) {
  const { publishText } = subject;
  await check('public-api', () => assert.equal(typeof publishText, 'function'));
  const directory = await mkdtemp(join(root, '.hidden-publish-'));
  const retained = new Set();
  const noTemps = async () => assert.deepEqual((await readdir(directory)).sort(), [...retained].sort(), 'only the intended targets may remain after cleanup');
  try {
    await check('default-publication-and-replacement', async () => {
      const target = join(directory, 'default.txt');
      retained.add('default.txt');
      for (const text of ['before', '中文🌌']) {
        assert.deepEqual(await publishText(target, text), { path: target, bytes: Buffer.byteLength(text, 'utf8') });
        assert.equal(await readFile(target, 'utf8'), text);
        await noTemps();
      }
    });
    await check('create-only-existing', async () => {
      const target = join(directory, 'existing.txt');
      await writeFile(target, 'PRESERVE_EXISTING');
      retained.add('existing.txt');
      await assert.rejects(publishText(target, 'unexpected replacement', { createOnly: true }), error => error?.code === 'EEXIST');
      assert.equal(await readFile(target, 'utf8'), 'PRESERVE_EXISTING');
      await noTemps();
    });
    await check('create-only-new', async () => {
      const target = join(directory, 'create.txt');
      retained.add('create.txt');
      const text = 'new🌌';
      assert.deepEqual(await publishText(target, text, { createOnly: true }), { path: target, bytes: Buffer.byteLength(text, 'utf8') });
      assert.equal(await readFile(target, 'utf8'), text);
      await noTemps();
    });
    await check('concurrent-create-only', async () => {
      const target = join(directory, 'winner.txt');
      retained.add('winner.txt');
      const texts = Array.from({ length: 8 }, (_, index) => `writer-${index}`);
      const outcomes = await Promise.allSettled(texts.map(text => publishText(target, text, { createOnly: true })));
      const winners = outcomes.flatMap((outcome, index) => outcome.status === 'fulfilled' ? [index] : []);
      assert.equal(winners.length, 1, 'exactly one concurrent publisher may create the target');
      for (const outcome of outcomes) if (outcome.status === 'rejected') assert.equal(outcome.reason?.code, 'EEXIST');
      assert.equal(await readFile(target, 'utf8'), texts[winners[0]]);
      await noTemps();
    });
    await check('argument-errors-before-effects', async () => {
      const before = await readdir(directory);
      for (const [destination, text, options] of [[null, 'x'], ['', 'x'], [join(directory, 'invalid.txt'), null], [join(directory, 'invalid.txt'), 'x', { createOnly: 'true' }], [join(directory, 'invalid.txt'), 'x', { createOnly: 1 }]]) {
        await assert.rejects(Promise.resolve().then(() => publishText(destination, text, options)), TypeError);
      }
      assert.deepEqual(await readdir(directory), before);
    });
    await check('missing-parent-error-no-mkdir', async () => {
      const parent = join(directory, 'missing');
      await assert.rejects(publishText(join(parent, 'text.txt'), 'x'), error => error?.code === 'ENOENT');
      assert.equal((await readdir(directory)).includes('missing'), false);
      await noTemps();
    });
    await check('publication-failure-cleanup', async () => {
      const target = join(directory, 'target-directory');
      await mkdir(target);
      retained.add('target-directory');
      await assert.rejects(publishText(target, 'x'), error => ['EISDIR', 'EPERM', 'EACCES', 'ENOTEMPTY', 'EEXIST'].includes(error?.code));
      assert.deepEqual(await readdir(target), []);
      await noTemps();
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** Execute hidden behavioral assertions only against the standalone grading fixture. */
export async function gradeCase(caseId, root) {
  const selected = CASES.find(candidate => candidate.id === caseId);
  if (!selected) return { status: 'fail', checks: [{ id: 'case-id', pass: false, actual: 'Unknown benchmark case' }] };
  const checks = [];
  const check = async (id, probe) => {
    try { await probe(); checks.push({ id, pass: true }); }
    catch (error) { checks.push({ id, pass: false, actual: errorFact(error) }); }
  };
  try {
    const subject = await import(`${pathToFileURL(join(resolve(root), selected.target.path)).href}?grade=${randomUUID()}`);
    if (caseId === 'decode-record') await gradeRecord(subject, check);
    else await gradePublish(subject, resolve(root), check);
  } catch (error) {
    checks.push({ id: 'grading-execution', pass: false, actual: errorFact(error) });
  }
  return { status: checks.length && checks.every(result => result.pass) ? 'pass' : 'fail', checks };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let result;
  try {
    const args = process.argv.slice(2);
    const flags = new Map();
    for (let index = 0; index < args.length; index += 2) {
      if (!['--case', '--workspace'].includes(args[index]) || !args[index + 1] || flags.has(args[index])) throw new TypeError('Use --case ID --workspace ROOT once each');
      flags.set(args[index], args[index + 1]);
    }
    if (flags.size !== 2) throw new TypeError('Both --case and --workspace are required');
    result = await gradeCase(flags.get('--case'), flags.get('--workspace'));
  } catch (error) { result = { status: 'fail', checks: [{ id: 'grader-input', pass: false, actual: errorFact(error) }] }; }
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'pass') process.exitCode = 1;
}
