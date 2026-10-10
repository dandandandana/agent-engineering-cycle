import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { sha256 } from '../src/core/contracts.mjs';
import { discoverQaCandidate } from '../src/local/qa-candidates.mjs';

async function fakeOfficialInstall(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qa-candidate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousExecPath = process.execPath;
  const fakeNode = path.join(root, 'node.exe');
  await writeFile(fakeNode, 'node-runtime-fixture');
  process.execPath = fakeNode;
  t.after(() => { process.execPath = previousExecPath; });

  const appData = path.join(root, 'appdata');
  const codexRoot = path.join(appData, 'npm', 'node_modules', '@openai', 'codex');
  const platformRoot = path.join(appData, 'npm', 'node_modules', '@openai', 'codex-win32-x64');
  await mkdir(codexRoot, { recursive: true });
  const vendorRoot = path.join(platformRoot, 'vendor', 'x86_64-pc-windows-msvc');
  await mkdir(path.join(vendorRoot, 'bin'), { recursive: true });
  await writeFile(path.join(codexRoot, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '1.0.0', optionalDependencies: { '@openai/codex-win32-x64': 'npm:@openai/codex@1.0.0' } }));
  await writeFile(path.join(platformRoot, 'package.json'), JSON.stringify({ name: '@openai/codex-win32-x64', version: '1.0.0' }));
  await writeFile(path.join(vendorRoot, 'codex-package.json'), '{"component":"codex-package"}');
  const executable = path.join(vendorRoot, 'bin', 'codex.exe');
  const bytes = Buffer.alloc(68, 0x01);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0, 0], 64);
  await writeFile(executable, bytes);
  return { appData, executable, bytes };
}

test('finds only native Codex under the known official npm vendor layout and remains unavailable without calibration', async t => {
  const { appData, executable, bytes } = await fakeOfficialInstall(t);
  const result = await discoverQaCandidate({
    config: { schema_revision: 3, qa: { model: 'operator-model' } },
    env: { APPDATA: appData },
    hostModel: 'host-model',
  });

  assert.equal(result.model, 'operator-model');
  assert.equal(result.source, 'configuration');
  assert.equal(result.executable, executable);
  assert.equal(result.executable_sha256, sha256(bytes));
  assert.equal(result.executable_source, 'official-npm-package');
  assert.equal(result.configured, true);
  assert.equal(result.calibrated, false);
  assert.equal(result.available, false);
  assert.match(result.reason, /calibrated capability receipt/);
  assert.deepEqual(await readFile(executable), bytes);
});

test('uses a host model only as a candidate and does not invent a Codex executable', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qa-candidate-missing-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const previousExecPath = process.execPath;
  process.execPath = path.join(root, 'node.exe');
  await writeFile(process.execPath, 'node-runtime-fixture');
  t.after(() => { process.execPath = previousExecPath; });

  const result = await discoverQaCandidate({ config: { schema_revision: 3, qa: null }, env: { APPDATA: path.join(root, 'empty') }, hostModel: 'host-model' });

  assert.equal(result.source, 'host');
  assert.equal(result.model, 'host-model');
  assert.equal(result.executable, null);
  assert.equal(result.executable_sha256, null);
  assert.equal(result.configured, false);
  assert.equal(result.calibrated, false);
  assert.equal(result.available, false);
  assert.match(result.reason, /not found in a known official npm package layout/);
});

test('a declared receipt or configured executable cannot make the discovery candidate calibrated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'qa-candidate-configured-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const executable = path.join(root, 'codex.exe');
  const bytes = Buffer.alloc(68, 0x01);
  bytes[0] = 0x4d;
  bytes[1] = 0x5a;
  bytes.writeUInt32LE(64, 0x3c);
  bytes.set([0x50, 0x45, 0, 0], 64);
  await writeFile(executable, bytes);
  const result = await discoverQaCandidate({
    config: { qa: { executable, model: 'declared-model', capability_receipt: 'receipt-ref', windows_sandbox: 'unelevated' } },
    env: {},
    hostModel: 'host-model',
  });

  assert.equal(result.source, 'configuration');
  assert.equal(result.model, 'declared-model');
  assert.equal(result.executable, executable);
  assert.equal(result.executable_source, 'configuration');
  assert.equal(result.declared.capability_receipt, 'receipt-ref');
  assert.equal(result.windows_sandbox, 'unelevated');
  assert.equal(result.calibrated, false);
  assert.equal(result.available, false);
  assert.match(result.reason, /receipt validation and live calibration are owned by the core/);
});
