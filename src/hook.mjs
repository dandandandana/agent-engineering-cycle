import { isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { HostContextStore } from './local/host-context.mjs';

const MAX_HOOK_INPUT_BYTES = 64 * 1024;
const SUPPORTED_EVENTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop']);

class HookInputError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'HookInputError';
    this.code = code;
  }
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readBoundedInput(stream) {
  const chunks = [];
  let byteLength = 0;

  for await (const value of stream) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    byteLength += chunk.byteLength;
    if (byteLength > MAX_HOOK_INPUT_BYTES) {
      throw new HookInputError('Hook input exceeds 64 KiB.', 'TOO_LARGE');
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, byteLength);
}

async function parseHookEvent(stdin) {
  const bytes = await readBoundedInput(stdin);
  let input;
  try {
    input = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new HookInputError('Hook input must be UTF-8 JSON.', 'INVALID_UTF8');
  }

  let event;
  try {
    event = JSON.parse(input);
  } catch {
    throw new HookInputError('Hook input must be valid JSON.', 'INVALID_JSON');
  }

  if (!isRecord(event)) throw new HookInputError('Hook input must be a JSON object.', 'INVALID_SHAPE');
  if (typeof event.hook_event_name !== 'string' || !SUPPORTED_EVENTS.has(event.hook_event_name)) {
    throw new HookInputError('Hook event is unsupported.', 'UNKNOWN_EVENT');
  }
  return event;
}

function workspaceRootFor(event, env) {
  const eventCwd = event.cwd;
  if (typeof eventCwd !== 'string' || !eventCwd.trim() || !isAbsolute(eventCwd)) {
    throw new HookInputError('Hook event must include an absolute cwd.', 'INVALID_EVENT_CWD');
  }

  const configured = env.CYCLE_WORKSPACE;
  if (configured !== undefined && configured.trim() === '') {
    throw new HookInputError('CYCLE_WORKSPACE must be a non-empty path when set.', 'INVALID_WORKSPACE');
  }

  const workspaceRoot = resolve(eventCwd);
  if (configured !== undefined && !samePath(workspaceRoot, resolve(workspaceRoot, configured))) {
    throw new HookInputError('CYCLE_WORKSPACE does not match the hook event workspace.', 'WORKSPACE_MISMATCH');
  }
  return workspaceRoot;
}

function samePath(left, right) {
  try {
    const normalizedLeft = realpathSync.native(resolve(left));
    const normalizedRight = realpathSync.native(resolve(right));
    return process.platform === 'win32'
      ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
      : normalizedLeft === normalizedRight;
  } catch { return false; }
}

export async function runHook({ stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let event;
  let workspaceRoot;
  try {
    event = await parseHookEvent(stdin);
    workspaceRoot = workspaceRootFor(event, env);
  } catch (error) {
    const reason = error instanceof HookInputError ? error.message : 'Hook input could not be read.';
    stderr.write(`${reason}\n`);
    return 1;
  }

  try {
    if (event.hook_event_name === 'UserPromptSubmit' && event.turn_id && event.session_id) {
      await new HostContextStore({ env }).publish(event);
    }
    const { createRuntime } = await import('./runtime.mjs');
    const runtime = await createRuntime({ workspaceRoot, env, hostModel: event.model ?? null });
    const output = await runtime.handleHook(event);
    if (!isRecord(output)) throw new TypeError('Hook runtime returned a non-object response.');
    const serialized = JSON.stringify(output);
    if (typeof serialized !== 'string') throw new TypeError('Hook runtime returned a non-JSON response.');
    stdout.write(`${serialized}\n`);
    return 0;
  } catch {
    stderr.write('Cycle hook could not complete this event safely.\n');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  process.exitCode = await runHook();
}
