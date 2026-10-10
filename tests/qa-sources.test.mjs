import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { WorkspaceAdapter } from '../src/local/workspace.mjs';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const QA_SOURCE_PATH = join(ROOT, 'src', 'adapters', 'qa-sources.mjs');
const PROTOCOL_VERSION = '2025-11-25';

function receiveJsonRpc(child) {
  const buffered = new Map();
  const outstanding = new Map();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });

  lines.on('line', (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      for (const { reject, timer } of outstanding.values()) {
        clearTimeout(timer);
        reject(new Error('QA source server emitted invalid JSON on stdout.'));
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
      buffered.set(key, message);
    }
  });

  child.once('exit', (code, signal) => {
    for (const { reject, timer } of outstanding.values()) {
      clearTimeout(timer);
      reject(new Error(`QA source server exited before replying (code=${code}, signal=${signal}).`));
    }
    outstanding.clear();
  });

  return {
    close() { lines.close(); },
    request(id, method, params = {}) {
      const key = String(id);
      return new Promise((resolveResponse, reject) => {
        const prior = buffered.get(key);
        if (prior) {
          buffered.delete(key);
          resolveResponse(prior);
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

async function makeWritable(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(target, 0o755).catch(() => {});
      await makeWritable(target);
    } else {
      await chmod(target, 0o644).catch(() => {});
    }
  }
  await chmod(directory, 0o755).catch(() => {});
}

async function dispose(directory) {
  await makeWritable(directory);
  await rm(directory, { recursive: true, force: true });
}

function toolValue(response, stderr) {
  assert.equal(response.error, undefined, stderr);
  assert.ok(response.result, stderr);
  const parsed = JSON.parse(response.result.content[0].text);
  assert.deepEqual(parsed, response.result.structuredContent);
  return { result: response.result, value: parsed };
}

test('frozen QA source MCP exposes only read-only manifest reads and rejects drift', async (t) => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'cycle QA sources '));
  let child;
  let reader;
  t.after(async () => {
    if (child && reader) await closeChild(child, reader);
    await dispose(workspaceRoot);
  });

  assert.ok(workspaceRoot.includes(' '), 'test workspace path must exercise Windows argument paths with spaces');
  const sourcePath = 'src/large source.txt';
  const originalText = 'x🌌abc'.repeat(2_000);
  await mkdir(join(workspaceRoot, 'src'), { recursive: true });
  await writeFile(join(workspaceRoot, sourcePath), originalText, 'utf8');
  await writeFile(join(workspaceRoot, 'unlisted.txt'), 'outside the frozen manifest', 'utf8');

  const adapter = new WorkspaceAdapter(workspaceRoot);
  const snapshotsDirectory = join(workspaceRoot, '.codex', 'engineering-cycle', 'snapshots');
  await mkdir(snapshotsDirectory, { recursive: true });
  const snapshot = await adapter.snapshot([sourcePath], snapshotsDirectory);
  const snapshotFileName = 'program snapshot.json';
  await writeFile(join(workspaceRoot, snapshotFileName), JSON.stringify(snapshot), 'utf8');

  child = spawn(process.execPath, [QA_SOURCE_PATH, snapshotFileName], {
    cwd: workspaceRoot,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  reader = receiveJsonRpc(child);

  const initialized = await reader.request(1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'qa-source-transport-test', version: '0.1.0' },
  });
  assert.equal(initialized.error, undefined, stderr);
  assert.equal(initialized.result.protocolVersion, PROTOCOL_VERSION);
  reader.notify('notifications/initialized');

  const listed = await reader.request(2, 'tools/list');
  assert.equal(listed.error, undefined, stderr);
  assert.deepEqual(listed.result.tools.map(({ name }) => name).sort(), ['qa_source_list', 'qa_source_read']);
  for (const tool of listed.result.tools) {
    assert.equal(tool.annotations.readOnlyHint, true);
    assert.equal(tool.annotations.destructiveHint, false);
  }

  const manifestCall = toolValue(await reader.request(3, 'tools/call', {
    name: 'qa_source_list',
    arguments: {},
  }), stderr);
  assert.equal(manifestCall.result.isError, false);
  assert.equal(manifestCall.value.ok, true);
  assert.deepEqual(manifestCall.value.manifest, snapshot.manifest);

  const entry = snapshot.manifest.entries.find((item) => item.path === sourcePath);
  assert.ok(entry);
  assert.equal(entry.sha256, createHash('sha256').update(originalText, 'utf8').digest('hex'));
  assert.equal(entry.size, Buffer.byteLength(originalText, 'utf8'));

  const firstPage = toolValue(await reader.request(4, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath, offset: 0, limit: 8192 },
  }), stderr);
  assert.equal(firstPage.result.isError, false);
  assert.equal(firstPage.value.ok, true);
  assert.equal(firstPage.value.sha256, entry.sha256);
  assert.equal(firstPage.value.content.length, 8191, 'the page backs off before splitting the surrogate pair');
  assert.equal(firstPage.value.next_offset, firstPage.value.content.length);

  const secondPage = toolValue(await reader.request(5, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath, offset: firstPage.value.next_offset, limit: 8192 },
  }), stderr);
  assert.equal(secondPage.result.isError, false);
  assert.equal(secondPage.value.ok, true);
  assert.equal(secondPage.value.sha256, entry.sha256);
  assert.equal(secondPage.value.next_offset, null);
  assert.equal(firstPage.value.content + secondPage.value.content, originalText);
  for (const page of [firstPage, secondPage]) assert.equal(Array.from(page.value.content).some(character => /^[\uD800-\uDFFF]$/u.test(character)), false, 'each page must contain complete Unicode characters');

  const outsideManifest = toolValue(await reader.request(6, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: 'unlisted.txt' },
  }), stderr);
  assert.equal(outsideManifest.result.isError, true);
  assert.equal(outsideManifest.value.ok, false);
  assert.equal(outsideManifest.value.error.code, 'SCOPE_DENIED');

  const frozenFile = join(snapshot.input_dir, ...sourcePath.split('/'));
  await chmod(frozenFile, 0o644);
  await writeFile(frozenFile, 'tampered snapshot content', 'utf8');
  const changedSnapshot = toolValue(await reader.request(7, 'tools/call', {
    name: 'qa_source_read',
    arguments: { path: sourcePath },
  }), stderr);
  assert.equal(changedSnapshot.result.isError, true);
  assert.equal(changedSnapshot.value.ok, false);
  assert.equal(changedSnapshot.value.error.code, 'SNAPSHOT_INCOMPLETE');

  assert.equal(await readFile(join(workspaceRoot, sourcePath), 'utf8'), originalText);
  assert.equal(await readFile(join(workspaceRoot, 'unlisted.txt'), 'utf8'), 'outside the frozen manifest');
  assert.deepEqual(await readdir(join(workspaceRoot, '.codex', 'engineering-cycle')), ['snapshots']);
  assert.deepEqual(await readdir(snapshotsDirectory), [snapshot.snapshot_id]);
  assert.deepEqual(await readdir(join(snapshotsDirectory, snapshot.snapshot_id)), ['input']);
});
