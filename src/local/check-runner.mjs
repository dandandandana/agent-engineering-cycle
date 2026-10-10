import { spawn } from 'node:child_process';
import { digest, fault, sha256 } from '../core/contracts.mjs';

const MAX_ID_LENGTH = 128;
const MAX_ARG_COUNT = 256;
const MAX_ARG_LENGTH = 8192;
const MAX_ARGV_LENGTH = 30_000;
const MAX_TIMEOUT_MS = 2_147_000_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_INPUT_BYTES = 64 * 1024;
const CLEANUP_TIMEOUT_MS = 2_000;
const TASKKILL_TIMEOUT_MS = 1_500;

function invalidCheck(message, details = {}) {
  return fault('CHECK_CONFIG_INVALID', message, details);
}

function validateCheck(check, { cwd, signal, timeoutMs, maxOutputBytes, onStarted, stdinText }) {
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    throw invalidCheck('Check must be an object.');
  }
  if (typeof check.id !== 'string' || check.id.trim().length === 0 || check.id.length > MAX_ID_LENGTH) {
    throw invalidCheck('Check id must be a non-empty string within the supported length.');
  }
  if (!Array.isArray(check.argv) || check.argv.length === 0 || check.argv.length > MAX_ARG_COUNT) {
    throw invalidCheck('Check argv must be a non-empty array within the supported length.');
  }

  let argvLength = 0;
  for (let index = 0; index < check.argv.length; index += 1) {
    const argument = check.argv[index];
    if (typeof argument !== 'string' || argument.length === 0) {
      throw invalidCheck('Every argv entry must be a non-empty string.', { argument_index: index });
    }
    if (argument.length > MAX_ARG_LENGTH) {
      throw invalidCheck('An argv entry exceeds the supported length.', { argument_index: index });
    }
    argvLength += argument.length + 1;
  }
  if (argvLength > MAX_ARGV_LENGTH) {
    throw invalidCheck('The combined argv exceeds the supported length.');
  }

  if (check.timeout_ms !== undefined && (!Number.isSafeInteger(check.timeout_ms) || check.timeout_ms < 1 || check.timeout_ms > MAX_TIMEOUT_MS)) {
    throw invalidCheck('Check timeout_ms must be a positive integer within the supported range.');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) {
    throw invalidCheck('timeoutMs must be a positive integer within the supported range.');
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 0 || maxOutputBytes > MAX_OUTPUT_BYTES) {
    throw invalidCheck('maxOutputBytes must be a non-negative integer within the supported range.');
  }
  if (typeof cwd !== 'string' || cwd.length === 0 || cwd.length > MAX_ARG_LENGTH) {
    throw invalidCheck('cwd must be a non-empty path within the supported length.');
  }
  if (signal !== undefined && (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' || typeof signal.removeEventListener !== 'function')) {
    throw invalidCheck('signal must be an AbortSignal.');
  }
  if (onStarted !== undefined && typeof onStarted !== 'function') {
    throw invalidCheck('onStarted must be a function.');
  }
  let stdinBuffer = null;
  if (stdinText !== undefined) {
    if (typeof stdinText !== 'string') {
      throw invalidCheck('stdinText must be a string when provided.');
    }
    stdinBuffer = Buffer.from(stdinText, 'utf8');
    if (stdinBuffer.toString('utf8') !== stdinText) {
      throw invalidCheck('stdinText must be valid UTF-8 text.');
    }
    if (stdinBuffer.byteLength > MAX_INPUT_BYTES) {
      throw invalidCheck('stdinText exceeds the supported UTF-8 byte limit.', {
        input_bytes: stdinBuffer.byteLength,
        max_input_bytes: MAX_INPUT_BYTES,
      });
    }
  }

  return {
    id: check.id,
    argv: [...check.argv],
    timeoutMs: Math.min(check.timeout_ms ?? timeoutMs, timeoutMs),
    stdinBuffer,
  };
}

function safeCode(error, fallback) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Za-z0-9_.-]{1,64}$/u.test(code) ? code.toUpperCase() : fallback;
}

function errorFact(code) {
  return { code };
}

function waitFor(promise, milliseconds, timeoutValue) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => {
      timer = setTimeout(() => resolve(timeoutValue), milliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

export async function killProcessTree(pid) {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      let settled = false;
      let killer;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };
      const timer = setTimeout(() => {
        try { killer?.kill('SIGKILL'); } catch { /* The cleanup result below records the timeout. */ }
        finish(errorFact('TASKKILL_TIMEOUT'));
      }, TASKKILL_TIMEOUT_MS);
      try {
        killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
          shell: false,
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.once('error', (error) => finish(errorFact(safeCode(error, 'TASKKILL_FAILED'))));
        killer.once('close', (code, signal) => {
          finish(code === 0 && signal === null ? null : errorFact('TASKKILL_FAILED'));
        });
      } catch (error) {
        finish(errorFact(safeCode(error, 'TASKKILL_FAILED')));
      }
    });
  }

  try {
    process.kill(-pid, 'SIGKILL');
    return null;
  } catch (error) {
    if (error?.code === 'ESRCH') return null;
    return errorFact(safeCode(error, 'PROCESS_TREE_KILL_FAILED'));
  }
}

/**
 * Run one already-validated project check without shell parsing.
 * The returned facts come only from the child-process and output-stream events.
 */
export async function runCheck(check, {
  cwd = process.cwd(),
  signal,
  timeoutMs = 30_000,
  maxOutputBytes = 65_536,
  onStarted,
  stdinText,
} = {}) {
  const input = validateCheck(check, { cwd, signal, timeoutMs, maxOutputBytes, onStarted, stdinText });
  const hasInput = input.stdinBuffer !== null;
  const facts = {
    check_id: input.id,
    argv_digest: digest(input.argv),
    launch_status: 'not_started',
    pid: null,
    terminal_observed: false,
    exit_code: null,
    signal: null,
    cancel_requested: false,
    timed_out: false,
    launch_error: null,
    capture_error: null,
    cleanup_error: null,
    output_complete: true,
    stdout: '',
    stderr: '',
    input_bytes: input.stdinBuffer?.byteLength ?? 0,
    input_digest: input.stdinBuffer === null ? null : sha256(input.stdinBuffer),
    input_delivered: !hasInput,
    passed: false,
  };

  if (signal?.aborted) {
    facts.cancel_requested = true;
    return facts;
  }

  const stdoutParts = [];
  const stderrParts = [];
  let retainedBytes = 0;
  let child = null;
  let spawnSucceeded = false;
  let streamsClosed = false;
  let outputCloseResolve;
  const outputClose = new Promise((resolve) => { outputCloseResolve = resolve; });
  let processDoneResolve;
  const processDone = new Promise((resolve) => { processDoneResolve = resolve; });
  let timeoutTimer;
  let terminationPromise = null;
  let terminationError = null;
  let startedCallbackPromise = Promise.resolve();
  let startedCallbackDeadlineExpired = false;
  let inputDeliveryReady = Promise.resolve();
  let abortResolve;
  const abortRequested = new Promise((resolve) => { abortResolve = resolve; });

  const keepOutput = (parts, chunk) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    const available = Math.max(0, maxOutputBytes - retainedBytes);
    const keepLength = Math.min(available, bytes.length);
    if (keepLength > 0) {
      parts.push(Buffer.from(bytes.subarray(0, keepLength)));
      retainedBytes += keepLength;
    }
    if (keepLength < bytes.length) facts.output_complete = false;
  };

  const requestTermination = () => {
    if (!child?.pid || terminationPromise) return terminationPromise;
    terminationPromise = killProcessTree(child.pid).then((error) => {
      if (error) terminationError ??= error;
    }).catch((error) => {
      terminationError ??= errorFact(safeCode(error, 'PROCESS_TREE_KILL_FAILED'));
    });
    return terminationPromise;
  };

  const deliverInput = () => new Promise((resolve) => {
    let settled = false;
    const finish = (error = null) => {
      if (settled) return;
      settled = true;
      if (error) {
        facts.capture_error ??= errorFact(safeCode(error, 'STDIN_WRITE_FAILED'));
        if (hasInput) facts.input_delivered = false;
        void requestTermination();
      } else if (hasInput) {
        facts.input_delivered = true;
      }
      resolve();
    };

    if (!child?.stdin) {
      finish(Object.assign(new Error('stdin pipe unavailable'), { code: 'STDIN_UNAVAILABLE' }));
      return;
    }
    if (facts.cancel_requested || facts.timed_out) {
      if (hasInput) facts.input_delivered = false;
      resolve();
      return;
    }
    child.stdin.once('error', finish);
    try {
      if (hasInput) child.stdin.end(input.stdinBuffer, (error) => finish(error ?? null));
      else child.stdin.end((error) => finish(error ?? null));
    } catch (error) {
      finish(error);
    }
  });

  const onAbort = () => {
    facts.cancel_requested = true;
    abortResolve('aborted');
    void requestTermination();
  };

  if (signal) signal.addEventListener('abort', onAbort, { once: true });

  try {
    if (signal?.aborted) {
      facts.cancel_requested = true;
      return facts;
    }

    facts.launch_status = 'unknown';
    child = spawn(input.argv[0], input.argv.slice(1), {
      cwd,
      shell: false,
      detached: process.platform !== 'win32',
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    child.once('spawn', () => {
      spawnSucceeded = true;
      facts.launch_status = 'started';
      facts.pid = child.pid ?? null;
      if (onStarted) {
        startedCallbackPromise = Promise.resolve().then(() => onStarted({ pid: facts.pid, launch_status: 'started' })).catch((error) => {
          if (!startedCallbackDeadlineExpired) {
            facts.capture_error ??= errorFact(safeCode(error, 'STARTED_FACT_CALLBACK_FAILED'));
          }
        });
      }
      inputDeliveryReady = startedCallbackPromise.then(() => {
        if (startedCallbackDeadlineExpired) return;
        return deliverInput();
      });
      if (facts.cancel_requested || facts.timed_out) void requestTermination();
    });

    child.once('error', (error) => {
      if (!spawnSucceeded && !child.pid) {
        facts.launch_status = 'not_started';
        facts.launch_error = errorFact(safeCode(error, 'SPAWN_FAILED'));
        processDoneResolve();
      } else {
        facts.cleanup_error ??= errorFact(safeCode(error, 'CHILD_PROCESS_ERROR'));
        if (!facts.terminal_observed) void requestTermination();
        else processDoneResolve();
      }
    });

    child.once('exit', (code, childSignal) => {
      if (spawnSucceeded) {
        facts.terminal_observed = true;
        facts.exit_code = code;
        facts.signal = childSignal;
      }
      processDoneResolve();
    });

    const captureStream = (stream, parts) => {
      if (!stream) return;
      stream.on('data', (chunk) => keepOutput(parts, chunk));
      stream.once('error', (error) => {
        facts.capture_error ??= errorFact(safeCode(error, 'OUTPUT_CAPTURE_FAILED'));
        facts.output_complete = false;
        void requestTermination();
      });
    };
    captureStream(child.stdout, stdoutParts);
    captureStream(child.stderr, stderrParts);
    child.once('close', () => {
      streamsClosed = true;
      outputCloseResolve();
    });

    if (facts.cancel_requested) void requestTermination();
    const firstEvent = await Promise.race([
      processDone,
      outputClose,
      new Promise((resolve) => {
        timeoutTimer = setTimeout(() => {
          facts.timed_out = true;
          void requestTermination();
          resolve('timeout');
        }, input.timeoutMs);
      }),
      abortRequested,
    ]);
    clearTimeout(timeoutTimer);

    if (facts.timed_out || facts.cancel_requested || facts.capture_error) {
      await requestTermination();
      if (!facts.terminal_observed && facts.launch_status !== 'not_started') {
        const terminalResult = await waitFor(processDone, CLEANUP_TIMEOUT_MS, 'deadline');
        if (terminalResult === 'deadline' && !facts.terminal_observed) {
          facts.cleanup_error ??= errorFact('TERMINAL_NOT_OBSERVED');
          facts.output_complete = false;
        }
      }
    } else if (facts.terminal_observed && !streamsClosed) {
      const closeResult = await waitFor(outputClose, Math.min(250, CLEANUP_TIMEOUT_MS), 'deadline');
      if (closeResult === 'deadline') {
        facts.output_complete = false;
        await requestTermination();
      }
    }

    if (!streamsClosed) {
      const closeResult = await waitFor(outputClose, CLEANUP_TIMEOUT_MS, 'deadline');
      if (closeResult === 'deadline') {
        facts.output_complete = false;
        facts.cleanup_error ??= errorFact('OUTPUT_STREAMS_NOT_CLOSED');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    }
    const startedCallbackResult = await waitFor(startedCallbackPromise, CLEANUP_TIMEOUT_MS, 'deadline');
    if (startedCallbackResult === 'deadline') {
      startedCallbackDeadlineExpired = true;
      facts.capture_error ??= errorFact('STARTED_FACT_CALLBACK_TIMEOUT');
      if (hasInput) facts.input_delivered = false;
    } else {
      const inputDeliveryResult = await waitFor(inputDeliveryReady, CLEANUP_TIMEOUT_MS, 'deadline');
      if (inputDeliveryResult === 'deadline') {
        if (hasInput) facts.input_delivered = false;
        facts.capture_error ??= errorFact('STDIN_DELIVERY_TIMEOUT');
        await requestTermination();
        if (!facts.terminal_observed && facts.launch_status === 'started') {
          const terminalResult = await waitFor(processDone, CLEANUP_TIMEOUT_MS, 'deadline');
          if (terminalResult === 'deadline') facts.cleanup_error ??= errorFact('TERMINAL_NOT_OBSERVED');
        }
      }
    }
    if (terminationPromise) await terminationPromise;
    if (terminationError && (!facts.terminal_observed || !streamsClosed)) {
      facts.cleanup_error ??= terminationError;
    }
    if (firstEvent === 'timeout' && !facts.terminal_observed) {
      facts.cleanup_error ??= errorFact('TERMINAL_NOT_OBSERVED');
    }
  } catch (error) {
    if (facts.launch_status === 'unknown' && !child?.pid) {
      facts.launch_status = 'not_started';
      facts.launch_error ??= errorFact(safeCode(error, 'SPAWN_FAILED'));
    } else {
      facts.capture_error ??= errorFact(safeCode(error, 'RUNNER_FAILED'));
      facts.output_complete = false;
      if (child) await requestTermination();
    }
    if (child && !facts.terminal_observed && facts.launch_status === 'started') {
      const terminalResult = await waitFor(processDone, CLEANUP_TIMEOUT_MS, 'deadline');
      if (terminalResult === 'deadline' && !facts.terminal_observed) {
        facts.cleanup_error ??= errorFact('TERMINAL_NOT_OBSERVED');
      }
    }
    if (child && !streamsClosed) {
      const closeResult = await waitFor(outputClose, CLEANUP_TIMEOUT_MS, 'deadline');
      if (closeResult === 'deadline') {
        facts.output_complete = false;
        facts.cleanup_error ??= errorFact('OUTPUT_STREAMS_NOT_CLOSED');
        child.stdout?.destroy();
        child.stderr?.destroy();
      }
    }
  } finally {
    clearTimeout(timeoutTimer);
    signal?.removeEventListener('abort', onAbort);
  }

  facts.stdout = Buffer.concat(stdoutParts).toString('utf8');
  facts.stderr = Buffer.concat(stderrParts).toString('utf8');
  facts.passed = facts.launch_status === 'started'
    && facts.terminal_observed
    && facts.exit_code === 0
    && facts.signal === null
    && !facts.cancel_requested
    && !facts.timed_out
    && facts.capture_error === null
    && facts.cleanup_error === null
    && facts.output_complete
    && facts.input_delivered;
  return facts;
}
