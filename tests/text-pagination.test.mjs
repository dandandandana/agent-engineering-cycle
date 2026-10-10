import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { WorkspaceAdapter } from '../src/local/workspace.mjs';
import { textPage } from '../src/core/contracts.mjs';

const ROOT = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const QA_SOURCE_PATH = path.join(ROOT, 'src', 'adapters', 'qa-sources.mjs');
const PROTOCOL_VERSION = '2025-11-25';

function wellFormedUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xD800 && unit <= 0xDBFF) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xDC00 && next <= 0xDFFF)) return false;
      index += 1;
    } else if (unit >= 0xDC00 && unit <= 0xDFFF) return false;
  }
  return true;
}

function receiveJsonRpc(child) {
  const pending = new Map();
  const buffered = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); }
    catch {
      for (const { reject, timer } of pending.values()) {
        clearTimeout(timer);
        reject(new Error('QA source server emitted invalid JSON on stdout.'));
      }
      pending.clear();
      return;
    }
    if (message.id === undefined) return;
    const key = String(message.id);
    const waiter = pending.get(key);
    if (waiter) {
      pending.delete(key);
      clearTimeout(waiter.timer);
      waiter.resolve(message);
    } else buffered.set(key, message);
  });
  child.once('exit', (code, signal) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error(`QA source server exited before replying (code=${code}, signal=${signal}).`));
    }
    pending.clear();
  });

  return {
    close: () => lines.close(),
    request(id, method, params = {}) {
      const key = String(id);
      return new Promise((resolve, reject) => {
        const prior = buffered.get(key);
        if (prior) {
          buffered.delete(key);
          resolve(prior);
          return;
        }
        const timer = setTimeout(() => {
          pending.delete(key);
          reject(new Error(`Timed out waiting for MCP ${method}.`));
        }, 5_000);
        pending.set(key, { resolve, reject, timer });
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
  await new Promise(resolve => child.once('exit', resolve));
  clearTimeout(timer);
}

async function makeWritable(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(target, 0o755).catch(() => {});
      await makeWritable(target);
    } else await chmod(target, 0o644).catch(() => {});
  }
  await chmod(directory, 0o755).catch(() => {});
}

async function dispose(directory) {
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

function toolValue(response) {
  assert.equal(response.error, undefined);
  assert.ok(response.result);
  const value = JSON.parse(response.result.content[0].text);
  assert.deepEqual(value, response.result.structuredContent);
  assert.equal(response.result.isError, value.ok === false);
  return { result: response.result, value };
}

test('private QA stdio paginates UTF-16 cursors without splitting surrogate pairs', async t => {
  const sourcePath = 'src/unicode-boundary.txt';
  const originalText = `${'x'.repeat(8191)}🌌尾文`;
  const firstExpected = textPage(originalText, 0, 8192);
  assert.equal(firstExpected.text, 'x'.repeat(8191));
  assert.equal(firstExpected.next_offset, 8191);
  assert.equal(wellFormedUnicode(firstExpected.text), true);
  assert.throws(() => textPage(originalText, 8192, 8192), error => error?.code === 'EVIDENCE_INVALID');

  const workspaceRoot = await mkdtemp(path.join(tmpdir(), 'cycle unicode source '));
  let child;
  let reader;
  t.after(async () => {
    if (child && reader) await closeChild(child, reader);
    await dispose(workspaceRoot);
  });
  await mkdir(path.join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(path.join(workspaceRoot, ...sourcePath.split('/')), originalText, 'utf8');

  const workspace = new WorkspaceAdapter(workspaceRoot);
  const snapshotsDirectory = path.join(workspaceRoot, '.codex', 'engineering-cycle', 'snapshots');
  await mkdir(snapshotsDirectory, { recursive: true });
  const snapshot = await workspace.snapshot([sourcePath], snapshotsDirectory);
  const snapshotFileName = 'unicode snapshot.json';
  await writeFile(path.join(workspaceRoot, snapshotFileName), JSON.stringify(snapshot), 'utf8');

  child = spawn(process.execPath, [QA_SOURCE_PATH, snapshotFileName], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
  reader = receiveJsonRpc(child);

  const initialized = await reader.request(1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'text-pagination-regression', version: '0.1.0' },
  });
  assert.equal(initialized.error, undefined, stderr);
  assert.equal(initialized.result.protocolVersion, PROTOCOL_VERSION);
  reader.notify('notifications/initialized');

  const first = toolValue(await reader.request(2, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath, offset: 0, limit: 8192 },
  }));
  assert.equal(first.result.isError, false, stderr);
  assert.equal(first.value.ok, true);
  assert.equal(first.value.content, firstExpected.text);
  assert.equal(first.value.next_offset, firstExpected.next_offset);
  assert.equal(wellFormedUnicode(first.value.content), true);

  const second = toolValue(await reader.request(3, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath, offset: first.value.next_offset, limit: 8192 },
  }));
  assert.equal(second.result.isError, false, stderr);
  assert.equal(second.value.ok, true);
  assert.equal(second.value.content, '🌌尾文');
  assert.equal(second.value.next_offset, null);
  assert.equal(wellFormedUnicode(second.value.content), true);
  assert.equal(first.value.content + second.value.content, originalText);

  const splitOffset = toolValue(await reader.request(4, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath, offset: 8192, limit: 8192 },
  }));
  assert.equal(splitOffset.result.isError, true);
  assert.equal(splitOffset.value.ok, false);
  assert.equal(splitOffset.value.error.code, 'EVIDENCE_INVALID');

  const tooSmall = toolValue(await reader.request(5, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath, offset: 8191, limit: 1 },
  }));
  assert.equal(tooSmall.result.isError, true);
  assert.equal(tooSmall.value.ok, false);
  assert.equal(tooSmall.value.error.code, 'EVIDENCE_INVALID');
  assert.equal(Object.hasOwn(tooSmall.value, 'next_offset'), false);
});
