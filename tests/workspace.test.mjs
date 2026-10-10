import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { WorkspaceAdapter } from '../src/local/workspace.mjs';

async function temporaryDirectory(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

async function makeWritable(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
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

async function workspace(t) {
  const root = await temporaryDirectory('cycle-workspace-');
  t.after(() => dispose(root));
  return { root, adapter: new WorkspaceAdapter(root) };
}

async function outsideDirectory(t) {
  const directory = await temporaryDirectory('cycle-snapshots-');
  t.after(() => dispose(directory));
  return directory;
}

function codeIs(code) {
  return (error) => error?.code === code;
}

test('constructor pins a real workspace root and exposes readonly identity', async (t) => {
  const { root, adapter } = await workspace(t);
  assert.equal(adapter.root, root);
  assert.match(adapter.workspaceId, /^[a-f0-9]{64}$/u);
  assert.equal(Object.getOwnPropertyDescriptor(adapter, 'root').writable, false);
  assert.equal(Object.getOwnPropertyDescriptor(adapter, 'workspaceId').writable, false);
  assert.throws(() => new WorkspaceAdapter(path.join(root, 'missing')), codeIs('SOURCE_UNAVAILABLE'));
});

test('reads only explicit UTF-8 files and enforces path and secret boundaries', async (t) => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'src.txt'), 'hello 世界');
  await writeFile(path.join(root, '.env.example'), 'PUBLIC_VALUE=example');
  const source = await adapter.readSource('src.txt');
  assert.equal(source.content, 'hello 世界');
  assert.equal(source.size, Buffer.byteLength('hello 世界'));
  const manifest = await adapter.readManifest(['src.txt', '.env.example']);
  assert.equal(manifest.entries.length, 2);
  assert.match(manifest.digest, /^[a-f0-9]{64}$/u);
  assert.equal(manifest.entries.find((item) => item.path === '.env.example').size, Buffer.byteLength('PUBLIC_VALUE=example'));

  await assert.rejects(adapter.readSource('../outside.txt'), codeIs('SCOPE_DENIED'));
  await assert.rejects(adapter.readSource(path.resolve(root, 'src.txt')), codeIs('SCOPE_DENIED'));
  await assert.rejects(adapter.readSource('.env.local'), codeIs('SCOPE_DENIED'));
  await assert.rejects(adapter.readSource('private.pem'), codeIs('SCOPE_DENIED'));
  await assert.rejects(adapter.readManifest(['.git/config']), codeIs('SCOPE_DENIED'));
  await assert.rejects(adapter.readSource('missing.txt'), codeIs('SOURCE_UNAVAILABLE'));
});

test('rejects symlink ancestors before reading or applying', async (t) => {
  const { root, adapter } = await workspace(t);
  const outside = await outsideDirectory(t);
  await writeFile(path.join(outside, 'source.txt'), 'outside');
  try {
    await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error?.code)) return t.skip(`symlink creation is unavailable: ${error.code}`);
    throw error;
  }
  await assert.rejects(adapter.readSource('linked/source.txt'), codeIs('SCOPE_DENIED'));
  await assert.rejects(adapter.apply([
    { path: 'linked/source.txt', action: 'write', expected_sha256: null, content: 'changed' },
  ]), codeIs('SCOPE_DENIED'));
  assert.equal(await readFile(path.join(outside, 'source.txt'), 'utf8'), 'outside');
});

test('enforces per-file, aggregate, and explicit-file limits', async (t) => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'large.txt'), Buffer.alloc(1024 * 1024 + 1, 0x61));
  await assert.rejects(adapter.readSource('large.txt'), codeIs('SNAPSHOT_INCOMPLETE'));

  const paths = [];
  for (let index = 0; index < 17; index += 1) {
    const name = `part-${index}.txt`;
    await writeFile(path.join(root, name), Buffer.alloc(1024 * 1024, 0x62));
    paths.push(name);
  }
  await assert.rejects(adapter.readManifest(paths), codeIs('SNAPSHOT_INCOMPLETE'));
  await assert.rejects(adapter.readManifest(Array.from({ length: 257 }, (_, index) => `file-${index}.txt`)), codeIs('SNAPSHOT_INCOMPLETE'));
});

test('snapshot copies actual bytes, survives source A to B to A, and detects tampering', async (t) => {
  const { root, adapter } = await workspace(t);
  const destination = await outsideDirectory(t);
  const source = path.join(root, 'app.txt');
  await writeFile(source, 'A');

  const snapshot = await adapter.snapshot(['app.txt'], destination);
  assert.equal(Object.isFrozen(snapshot), true);
  assert.equal(Object.isFrozen(snapshot.manifest), true);
  assert.equal(Object.isFrozen(snapshot.manifest.entries[0]), true);
  const alteredReference = { ...snapshot, manifest: { ...snapshot.manifest, digest: '0'.repeat(64) } };
  await assert.rejects(adapter.verifySnapshot(alteredReference), codeIs('SNAPSHOT_INCOMPLETE'));
  await writeFile(source, 'B');
  await writeFile(source, 'A');
  assert.equal(await readFile(path.join(snapshot.input_dir, 'app.txt'), 'utf8'), 'A');
  assert.deepEqual(await adapter.verifySnapshot(snapshot), { valid: true, manifest: snapshot.manifest });
  const restoredAdapter = new WorkspaceAdapter(root);
  const persistedSnapshot = JSON.parse(JSON.stringify(snapshot));
  assert.deepEqual(await restoredAdapter.verifySnapshot(persistedSnapshot), { valid: true, manifest: snapshot.manifest });

  const internalDestination = path.join(root, '.codex', 'engineering-cycle', 'snapshots');
  await mkdir(internalDestination, { recursive: true });
  const internalSnapshot = await adapter.snapshot(['app.txt'], internalDestination);
  assert.deepEqual(await adapter.verifySnapshot(internalSnapshot), { valid: true, manifest: internalSnapshot.manifest });
  const productDestination = path.join(root, 'dist');
  await mkdir(productDestination);
  await assert.rejects(adapter.snapshot(['app.txt'], productDestination), codeIs('SCOPE_DENIED'));

  if (process.platform !== 'win32') {
    const frozenFile = await stat(path.join(snapshot.input_dir, 'app.txt'));
    assert.equal(frozenFile.mode & 0o222, 0, 'published snapshot files are readonly on POSIX');
  }
  const snapshotRoot = path.dirname(snapshot.input_dir);
  await chmod(snapshotRoot, 0o755).catch(() => {});
  await chmod(snapshot.input_dir, 0o755).catch(() => {});
  await chmod(path.join(snapshot.input_dir, 'app.txt'), 0o644).catch(() => {});
  await writeFile(path.join(snapshot.input_dir, 'app.txt'), 'tampered');
  await assert.rejects(adapter.verifySnapshot(snapshot), codeIs('SNAPSHOT_INCOMPLETE'));
});

test('apply preflights all expected hashes before making any change', async (t) => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'first.txt'), 'before');
  await writeFile(path.join(root, 'second.txt'), 'unchanged');
  await assert.rejects(adapter.apply([
    { path: 'first.txt', action: 'write', expected_sha256: (await adapter.readSource('first.txt')).sha256, content: 'after' },
    { path: 'second.txt', action: 'delete', expected_sha256: '0'.repeat(64) },
  ]), (error) => error?.code === 'BINDING_STALE' && error.details?.effects_known === true && error.details.effects.length === 0);
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'before');
  assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'unchanged');
  await assert.rejects(adapter.apply(Array.from({ length: 65 }, (_, index) => ({
    path: `part-${index}.txt`, action: 'delete', expected_sha256: null,
  }))), codeIs('SCOPE_DENIED'));
});

test('new-contract bootstrap records necessary parent effects and keeps the legacy default', async t => {
  const { root, adapter } = await workspace(t);
  const target = { path: 'docs/design/plan.md', action: 'write', expected_sha256: null, content: '# Actual plan\n' };
  await assert.rejects(adapter.apply([target]), codeIs('SOURCE_UNAVAILABLE'));
  assert.deepEqual(await readdir(root), []);
  const observed = [];
  const result = await adapter.apply([target], { createParents: true, onEffect: async e => observed.push(e) });
  assert.deepEqual(result.changed_paths, ['docs', 'docs/design', target.path]);
  assert.deepEqual(observed.map(e => e.kind ?? 'file'), ['directory', 'directory', 'file']);
  assert.equal(observed[0].parent_of, target.path);
  assert.equal(await readFile(path.join(root, target.path), 'utf8'), target.content);
});

test('bootstrap validates all file pre-states before creating any directory', async t => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'existing.txt'), 'unchanged');
  await assert.rejects(adapter.apply([
    { path: 'new/plan.md', action: 'write', expected_sha256: null, content: 'new' },
    { path: 'existing.txt', action: 'write', expected_sha256: '0'.repeat(64), content: 'wrong' },
  ], { createParents: true }), codeIs('BINDING_STALE'));
  assert.deepEqual(await readdir(root), ['existing.txt']);
});

test('a bootstrap interruption preserves known directory effects without publishing a file', async t => {
  const { root, adapter } = await workspace(t);
  const target = { path: 'docs/nested/plan.md', action: 'write', expected_sha256: null, content: 'never published' };
  await assert.rejects(adapter.apply([target], { createParents: true, onEffect: async () => { throw new Error('ledger unavailable'); } }), error => {
    assert.equal(error.code, 'OPERATION_PARTIAL'); assert.equal(error.details.effects_known, true);
    assert.deepEqual(error.details.changed_paths, ['docs']); assert.equal(error.details.effects[0].kind, 'directory');
    return true;
  });
  assert.deepEqual(await readdir(path.join(root, 'docs')), []);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.apply([target], { createParents: true, signal: controller.signal }), codeIs('OPERATION_FAILED'));
  assert.deepEqual(await readdir(path.join(root, 'docs')), []);
});

test('bootstrap cannot follow a linked target parent', async t => {
  const { root, adapter } = await workspace(t); const outside = await outsideDirectory(t);
  await symlink(outside, path.join(root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(adapter.apply([{ path: 'linked/new/plan.md', action: 'write', expected_sha256: null, content: 'denied' }], { createParents: true }), codeIs('SCOPE_DENIED'));
  assert.deepEqual(await readdir(outside), []);
});

test('apply writes atomically, records ordered effects, and preserves POSIX mode', async (t) => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'first.txt'), 'one');
  await chmod(path.join(root, 'first.txt'), 0o666);
  const first = await adapter.readSource('first.txt');
  const events = [];
  const result = await adapter.apply([
    { path: 'first.txt', action: 'write', expected_sha256: first.sha256, content: 'updated' },
    { path: 'second.txt', action: 'write', expected_sha256: null, content: 'new' },
  ], { onEffect: async (effect) => events.push(effect.path) });
  assert.deepEqual(result.changed_paths, ['first.txt', 'second.txt']);
  assert.deepEqual(events, ['first.txt', 'second.txt']);
  assert.equal(result.effects_known, true);
  assert.equal(result.effects.length, 2);
  if (process.platform !== 'win32') {
    assert.equal(result.effects[0].before.mode, 0o666);
    assert.equal(result.effects[0].after.mode, 0o666);
  }
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'updated');
  assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'new');
  if (process.platform !== 'win32') assert.equal((await stat(path.join(root, 'first.txt'))).mode & 0o777, 0o666);

  const second = await adapter.readSource('second.txt');
  const deleted = await adapter.apply([{ path: 'second.txt', action: 'delete', expected_sha256: second.sha256 }]);
  assert.deepEqual(deleted.changed_paths, ['second.txt']);
  await assert.rejects(adapter.readSource('second.txt'), codeIs('SOURCE_UNAVAILABLE'));
});

test('effect persistence failure reports the already published effect without rollback', async (t) => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'first.txt'), 'before');
  await writeFile(path.join(root, 'second.txt'), 'before');
  const first = await adapter.readSource('first.txt');
  const second = await adapter.readSource('second.txt');
  const failure = await adapter.apply([
    { path: 'first.txt', action: 'write', expected_sha256: first.sha256, content: 'published' },
    { path: 'second.txt', action: 'write', expected_sha256: second.sha256, content: 'never attempted' },
  ], { onEffect: async () => { throw new Error('ledger unavailable'); } }).then(() => null, (error) => error);
  assert.equal(failure?.code, 'OPERATION_PARTIAL');
  assert.equal(failure.details.effects_known, true);
  assert.deepEqual(failure.details.changed_paths, ['first.txt']);
  assert.equal(failure.details.effects[0].after.sha256, (await adapter.readSource('first.txt')).sha256);
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'published');
  assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'before');
});

test('apply detects an external third state between ordered targets and preserves known effects', async (t) => {
  const { root, adapter } = await workspace(t);
  await writeFile(path.join(root, 'first.txt'), 'one');
  await writeFile(path.join(root, 'second.txt'), 'two');
  const first = await adapter.readSource('first.txt');
  const second = await adapter.readSource('second.txt');
  await assert.rejects(adapter.apply([
    { path: 'first.txt', action: 'write', expected_sha256: first.sha256, content: 'first changed' },
    { path: 'second.txt', action: 'write', expected_sha256: second.sha256, content: 'agent desired' },
  ], { onEffect: async (effect) => {
    if (effect.path === 'first.txt') await writeFile(path.join(root, 'second.txt'), 'external third state');
  } }), (error) => {
    assert.equal(error.code, 'OPERATION_PARTIAL');
    assert.equal(error.details.effects_known, true);
    assert.deepEqual(error.details.changed_paths, ['first.txt']);
    assert.equal(error.details.conflict_path, 'second.txt');
    return true;
  });
  assert.equal(await readFile(path.join(root, 'first.txt'), 'utf8'), 'first changed');
  assert.equal(await readFile(path.join(root, 'second.txt'), 'utf8'), 'external third state');
});
