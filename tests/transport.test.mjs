import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { TOOL_NAMES } from '../src/core/contracts.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const HOOK_PATH = join(ROOT, 'src', 'hook.mjs');
const SERVER_PATH = join(ROOT, 'src', 'server.mjs');

function receiveJsonRpc(child) {
  const readers = new Map();
  const outstanding = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      for (const { reject, timer } of outstanding.values()) {
        clearTimeout(timer);
        reject(new Error('MCP server emitted invalid JSON on stdout.'));
      }
      outstanding.clear();
      return;
    }
    if (message.id === undefined) return;
    const key = String(message.id);
    const waiter = outstanding.get(key);
    if (waiter) {
      outstanding.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else {
      readers.set(key, message);
    }
  });
  child.once('exit', (code, signal) => {
    for (const { reject, timer } of outstanding.values()) {
      clearTimeout(timer);
      reject(new Error(`MCP server exited before replying (code=${code}, signal=${signal}).`));
    }
    outstanding.clear();
  });

  return {
    close() { lines.close(); },
    request(id, method, params = {}) {
      const key = String(id);
      return new Promise((resolveResponse, reject) => {
        const buffered = readers.get(key);
        if (buffered) {
          readers.delete(key);
          resolveResponse(buffered);
          return;
        }
        const timer = setTimeout(() => {
          outstanding.delete(key);
          reject(new Error(`Timed out waiting for MCP ${method}.`));
        }, 10_000);
        outstanding.set(key, { resolve: resolveResponse, reject, timer });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params = {}) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

async function closeChild(child, reader) {
  reader.close();
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  const timer = setTimeout(() => child.kill(), 3_000);
  await new Promise((resolveExit) => child.once('exit', resolveExit));
  clearTimeout(timer);
}

test('portable plugin manifests point at the local MCP server and packaged hooks', async () => {
  const plugin = JSON.parse(await readFile(join(ROOT, 'plugin.json'), 'utf8'));
  const mcp = JSON.parse(await readFile(join(ROOT, 'mcp.json'), 'utf8'));
  const hooks = JSON.parse(await readFile(join(ROOT, 'hooks', 'hooks.json'), 'utf8'));

  assert.equal(plugin.$schema, 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json');
  assert.equal(plugin.name, 'agent-engineering-cycle');
  assert.equal(plugin.version, '0.1.0');
  assert.equal(plugin.extensions['com.openai'].hooks, './hooks/hooks.json');
  assert.equal(mcp.$schema, 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json');
  assert.deepEqual(Object.keys(mcp.mcpServers), ['agent-engineering-cycle']);
  assert.deepEqual(mcp.mcpServers['agent-engineering-cycle'], {
    type: 'stdio',
    command: 'node',
    args: ['${PLUGIN_ROOT}/src/server.mjs', '--auto-workspace'],
    cwd: '${PLUGIN_ROOT}',
  });
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.equal(hooks.hooks.PreToolUse[0].matcher, '^(apply_patch|Edit|Write)$');
  for (const event of Object.values(hooks.hooks)) {
    for (const group of event) {
      for (const handler of group.hooks) {
        assert.equal(handler.type, 'command');
        assert.equal(handler.command, 'node "${PLUGIN_ROOT}/src/hook.mjs"');
        assert.equal(handler.timeout, 30);
      }
    }
  }
});

test('hook rejects malformed, unknown, and oversized input without producing output', () => {
  const malformed = spawnSync(process.execPath, [HOOK_PATH], { input: '{', encoding: 'utf8' });
  assert.equal(malformed.status, 1);
  assert.equal(malformed.stdout, '');
  assert.equal(malformed.stderr, 'Hook input must be valid JSON.\n');

  const unknown = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: 'UnrecognizedEvent' }),
    encoding: 'utf8',
  });
  assert.equal(unknown.status, 1);
  assert.equal(unknown.stdout, '');
  assert.equal(unknown.stderr, 'Hook event is unsupported.\n');

  const oversized = spawnSync(process.execPath, [HOOK_PATH], {
    input: Buffer.alloc(64 * 1024 + 1, 0x61),
    encoding: 'utf8',
    maxBuffer: 1024,
  });
  assert.equal(oversized.status, 1);
  assert.equal(oversized.stdout, '');
  assert.equal(oversized.stderr, 'Hook input exceeds 64 KiB.\n');
});

test('hook requires host cwd and rejects a conflicting explicit workspace before loading runtime', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'cycle-hook-scope-'));
  t.after(async () => rm(workspace, { recursive: true, force: true }));

  const missingCwd = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: 'SessionStart' }),
    cwd: workspace,
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'CYCLE_WORKSPACE')),
    encoding: 'utf8',
  });
  assert.equal(missingCwd.status, 1);
  assert.equal(missingCwd.stdout, '');
  assert.equal(missingCwd.stderr, 'Hook event must include an absolute cwd.\n');

  const mismatch = spawnSync(process.execPath, [HOOK_PATH], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: workspace }),
    cwd: workspace,
    env: { ...process.env, CYCLE_WORKSPACE: resolve(workspace, 'other-project') },
    encoding: 'utf8',
  });
  assert.equal(mismatch.status, 1);
  assert.equal(mismatch.stdout, '');
  assert.equal(mismatch.stderr, 'CYCLE_WORKSPACE does not match the hook event workspace.\n');
  assert.deepEqual(await readdir(workspace), []);
});

test('MCP stdio initializes, lists seven tools, and calls read-only status without creating state', async (t) => {
  const workspace = await mkdtemp(join(tmpdir(), 'cycle-mcp-transport-'));

  const child = spawn(process.execPath, [SERVER_PATH], {
    cwd: workspace,
    env: { ...process.env, CYCLE_WORKSPACE: workspace },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const reader = receiveJsonRpc(child);
  t.after(async () => {
    await closeChild(child, reader);
    await rm(workspace, { recursive: true, force: true });
  });

  const initialized = await reader.request(1, 'initialize', {
    protocolVersion: '2025-11-25',
    capabilities: {},
    clientInfo: { name: 'agent-engineering-cycle-transport-test', version: '0.1.0' },
  });
  assert.equal(initialized.error, undefined, stderr);
  assert.equal(initialized.result.protocolVersion, '2025-11-25');
  reader.notify('notifications/initialized');

  const listed = await reader.request(2, 'tools/list');
  assert.equal(listed.error, undefined, stderr);
  assert.deepEqual(listed.result.tools.map(({ name }) => name).sort(), [...TOOL_NAMES].sort());

  const called = await reader.request(3, 'tools/call', { name: 'cycle_status', arguments: {} });
  assert.equal(called.error, undefined, stderr);
  assert.ok(called.result.structuredContent && typeof called.result.structuredContent === 'object');
  assert.deepEqual(JSON.parse(called.result.content[0].text), called.result.structuredContent);
  assert.equal(called.result.isError, called.result.structuredContent.ok === false);
  assert.deepEqual(await readdir(workspace), []);
});
