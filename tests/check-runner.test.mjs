import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CycleError, digest, sha256 } from '../src/core/contracts.mjs';
import { runCheck } from '../src/local/check-runner.mjs';

function nodeCheck(script, extra = {}) {
  return {
    id: 'runner-test',
    argv: [process.execPath, '-e', script],
    ...extra,
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForPidToExit(pid, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error?.code === 'ESRCH') return true;
      throw error;
    }
    await delay(25);
  }
  return false;
}

test('runCheck records a successful child and captures bounded stdout and stderr', async () => {
  const argv = [process.execPath, '-e', "process.stdout.write('ok; literal');process.stderr.write('warning')"];
  const result = await runCheck({ id: 'ok', argv });

  assert.equal(result.check_id, 'ok');
  assert.equal(result.argv_digest, digest(argv));
  assert.equal(result.launch_status, 'started');
  assert.equal(Number.isInteger(result.pid), true);
  assert.equal(result.terminal_observed, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.cancel_requested, false);
  assert.equal(result.timed_out, false);
  assert.equal(result.launch_error, null);
  assert.equal(result.capture_error, null);
  assert.equal(result.cleanup_error, null);
  assert.equal(result.output_complete, true);
  assert.equal(result.stdout, 'ok; literal');
  assert.equal(result.stderr, 'warning');
  assert.equal(result.input_bytes, 0);
  assert.equal(result.input_digest, null);
  assert.equal(result.input_delivered, true);
  assert.equal(result.passed, true);
});

test('runCheck delivers exact UTF-8 stdin and reports only its byte count and digest', async () => {
  const prompt = '检查 exact prompt 🙂\nsecond line';
  const result = await runCheck(nodeCheck("const chunks=[];process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>chunks.push(chunk));process.stdin.on('end',()=>process.stdout.write(chunks.join('')))"), {
    stdinText: prompt,
  });

  assert.equal(result.terminal_observed, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.stdout, prompt);
  assert.equal(result.input_bytes, Buffer.byteLength(prompt, 'utf8'));
  assert.equal(result.input_digest, sha256(Buffer.from(prompt, 'utf8')));
  assert.equal(result.input_delivered, true);
  assert.equal(result.capture_error, null);
  assert.equal(result.passed, true);
});

test('runCheck rejects stdin above the UTF-8 byte limit before launching', async () => {
  let started = false;
  await assert.rejects(runCheck(nodeCheck('process.stdin.resume()'), {
    stdinText: '🙂'.repeat(16_385),
    onStarted: () => { started = true; },
  }), CycleError);

  assert.equal(started, false);
});

test('runCheck records a closed-child stdin write failure without exposing input text', async () => {
  const secretPrompt = 'private QA prompt must never appear in an error';
  const result = await runCheck(nodeCheck('process.exit(0)'), {
    stdinText: secretPrompt,
    onStarted: () => delay(100),
  });

  assert.equal(result.launch_status, 'started');
  assert.equal(result.terminal_observed, true);
  assert.equal(result.exit_code, 0);
  assert.equal(result.input_bytes, Buffer.byteLength(secretPrompt, 'utf8'));
  assert.equal(result.input_digest, sha256(Buffer.from(secretPrompt, 'utf8')));
  assert.equal(result.input_delivered, false);
  assert.ok(result.capture_error);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(secretPrompt, 'u'));
  assert.equal(result.passed, false);
});

test('runCheck records a nonzero exit as a completed failure', async () => {
  const result = await runCheck(nodeCheck("process.stdout.write('failed');process.exitCode=7"));

  assert.equal(result.launch_status, 'started');
  assert.equal(result.terminal_observed, true);
  assert.equal(result.exit_code, 7);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, 'failed');
  assert.equal(result.passed, false);
});

test('runCheck distinguishes a missing executable from a launched command', async () => {
  const missingExecutable = join(tmpdir(), `missing-check-${randomUUID()}.exe`);
  const result = await runCheck({ id: 'missing-executable', argv: [missingExecutable] });

  assert.equal(result.launch_status, 'not_started');
  assert.equal(result.pid, null);
  assert.equal(result.terminal_observed, false);
  assert.equal(result.exit_code, null);
  assert.deepEqual(result.launch_error, { code: 'ENOENT' });
  assert.equal(result.capture_error, null);
  assert.equal(result.cleanup_error, null);
  assert.equal(result.output_complete, true);
  assert.equal(result.passed, false);
});

test('runCheck does not launch after an abort already requested', async () => {
  const controller = new AbortController();
  controller.abort();
  let startedCallbackCalled = false;
  const result = await runCheck(nodeCheck("process.stdout.write('should-not-run')"), {
    signal: controller.signal,
    onStarted: () => { startedCallbackCalled = true; },
  });

  assert.equal(result.launch_status, 'not_started');
  assert.equal(result.pid, null);
  assert.equal(result.terminal_observed, false);
  assert.equal(result.cancel_requested, true);
  assert.equal(result.stdout, '');
  assert.equal(startedCallbackCalled, false);
  assert.equal(result.passed, false);
});

test('runCheck cancels a running process tree and observes the child terminal state', async () => {
  const controller = new AbortController();
  const descendantScript = "process.stdout.write('descendant-ready:'+process.pid+'\\n');setInterval(()=>{},1000)";
  const parentScript = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendantScript)}],{stdio:['ignore','inherit','inherit']});process.stdout.write('parent-ready\\n');setInterval(()=>{},1000)`;
  const result = await runCheck(nodeCheck(parentScript), {
    signal: controller.signal,
    timeoutMs: 5_000,
    onStarted: () => { setTimeout(() => controller.abort(), 400); },
  });

  assert.equal(result.launch_status, 'started');
  assert.equal(result.cancel_requested, true);
  assert.equal(result.timed_out, false);
  assert.equal(result.terminal_observed, true);
  assert.ok(result.exit_code !== 0 || result.signal !== null, 'a canceled process must not be reported as a normal success');
  assert.match(result.stdout, /descendant-ready:\d+/u);
  assert.equal(result.cleanup_error, null);
  assert.equal(result.passed, false);

  const descendantPid = Number(result.stdout.match(/descendant-ready:(\d+)/u)?.[1]);
  assert.ok(Number.isInteger(descendantPid));
  assert.equal(await waitForPidToExit(descendantPid), true, 'the descendant process should be gone after cancellation');
});

test('runCheck enforces a timeout, kills the process, and keeps timeout separate from cancellation', async () => {
  const result = await runCheck(nodeCheck('setInterval(()=>{},1000)'), { timeoutMs: 100 });

  assert.equal(result.launch_status, 'started');
  assert.equal(result.cancel_requested, false);
  assert.equal(result.timed_out, true);
  assert.equal(result.terminal_observed, true);
  assert.ok(result.exit_code !== 0 || result.signal !== null, 'a timed out process must not be reported as a normal success');
  assert.equal(result.passed, false);
});

test('runCheck caps combined stdout and stderr bytes and marks truncated output incomplete', async () => {
  const result = await runCheck(nodeCheck("process.stdout.write('12345');process.stderr.write('abcde')"), { maxOutputBytes: 6 });

  assert.equal(result.terminal_observed, true);
  assert.equal(result.exit_code, 0);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 6);
  assert.equal(result.output_complete, false);
  assert.equal(result.passed, false);
});

test('runCheck retains a started fact when the onStarted callback fails', async () => {
  const result = await runCheck(nodeCheck("process.stdout.write('ran')"), {
    onStarted: async () => { throw new Error('persistence detail must not be returned'); },
  });

  assert.equal(result.launch_status, 'started');
  assert.equal(Number.isInteger(result.pid), true);
  assert.equal(result.terminal_observed, true);
  assert.equal(result.exit_code, 0);
  assert.deepEqual(result.capture_error, { code: 'STARTED_FACT_CALLBACK_FAILED' });
  assert.equal(result.stdout, 'ran');
  assert.equal(result.passed, false);
});

test('runCheck rejects shell command strings and empty or oversized argv entries', async () => {
  await assert.rejects(runCheck({ id: 'shell-string', argv: 'node -e "process.exit(0)"' }), CycleError);
  await assert.rejects(runCheck({ id: 'empty-argument', argv: [process.execPath, ''] }), CycleError);
  await assert.rejects(runCheck({ id: 'oversized-argument', argv: [process.execPath, 'x'.repeat(8193)] }), CycleError);
});
