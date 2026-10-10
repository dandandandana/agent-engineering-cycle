import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, rm, symlink, unlink, writeFile, lstat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { digest } from '../src/core/contracts.mjs';
import { collectRepositoryPaths } from '../src/local/repository-inventory.mjs';

async function makeRoot(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'repository-inventory-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function put(root, relative, content = 'fixture') {
  const target = path.join(root, ...relative.split('/'));
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
  return target;
}

const sortText = (left, right) => left < right ? -1 : left > right ? 1 : 0;

test('metadata facts match the real provider bigint DTO for an unchanged binary and worktree control file', async t => {
  const root=await makeRoot(t); const binary=await put(root,'image.png'); await put(root,'.git','gitdir: /never-follow\n');
  const result=await collectRepositoryPaths({workspaceRoot:root,scope:{roots:['.'],files:[]}});
  const s=await lstat(binary,{bigint:true});
  assert.deepEqual(result.file_facts.find(f=>f.path==='image.png'),{path:'image.png',size:Number(s.size),mtime_ms:Number(s.mtimeMs),ctime_ms:Number(s.ctimeMs),dev:String(s.dev),ino:String(s.ino)});
  assert.ok(result.files.includes('.git')); assert.ok(!result.skipped_directories.includes('.git'));
});

test('collects scoped metadata, includes secret-file names, and skips control/security/generated directories', async t => {
  const root = await makeRoot(t);
  await put(root, 'src/index.mjs');
  await put(root, '.env');
  await put(root, 'src/.env');
  await put(root, 'README.md');
  await put(root, 'docs/guide.md');
  await put(root, '.git/config');
  await put(root, '.ssh/id_rsa');
  await put(root, 'src/node_modules/pkg/index.js');
  await put(root, 'build/cache/out.js');
  await put(root, 'vendor/hidden.txt');

  const result = await collectRepositoryPaths({
    workspaceRoot: root,
    scope: { roots: ['.'], files: [] },
    skippedDirectories: ['vendor'],
  });

  assert.deepEqual(result.files, ['.env', 'README.md', 'docs/guide.md', 'src/.env', 'src/index.mjs']);
  assert.deepEqual(result.skipped_directories, ['.git', '.ssh', 'build', 'src/node_modules', 'vendor']);
  assert.deepEqual(result.file_facts.map(fact => fact.path), result.files);
  assert.deepEqual(Object.keys(result.file_facts[0]), ['path', 'size', 'mtime_ms', 'ctime_ms', 'dev', 'ino']);
  assert.equal(typeof result.file_facts[0].dev, 'string');
  assert.equal(typeof result.file_facts[0].ino, 'string');
  assert.equal(result.digest, digest({ files: result.files, skipped_directories: result.skipped_directories }));
  assert.deepEqual((await readdir(root)).sort(sortText), ['.env', '.git', '.ssh', 'README.md', 'build', 'docs', 'src', 'vendor']);
});

test('observes source additions and deletions by enumerating names rather than trusting directory timestamps', async t => {
  const root = await makeRoot(t);
  await put(root, 'src/one.mjs');
  const scope = { roots: ['src'], files: [] };
  const first = await collectRepositoryPaths({ workspaceRoot: root, scope });
  await put(root, 'src/two.mjs');
  const second = await collectRepositoryPaths({ workspaceRoot: root, scope });
  await unlink(path.join(root, 'src', 'one.mjs'));
  const third = await collectRepositoryPaths({ workspaceRoot: root, scope });

  assert.deepEqual(first.files, ['src/one.mjs']);
  assert.deepEqual(second.files, ['src/one.mjs', 'src/two.mjs']);
  assert.deepEqual(third.files, ['src/two.mjs']);
  assert.notEqual(first.digest, second.digest);
  assert.notEqual(second.digest, third.digest);
});

test('file facts expose same-path metadata changes while the path-set digest remains unchanged', async t => {
  const root = await makeRoot(t);
  const target = await put(root, 'assets/logo.bin', 'abc');
  const scope = { roots: ['.'], files: [] };
  const before = await collectRepositoryPaths({ workspaceRoot: root, scope });
  await writeFile(target, 'a longer replacement', 'utf8');
  const after = await collectRepositoryPaths({ workspaceRoot: root, scope });

  assert.deepEqual(after.files, before.files);
  assert.equal(after.digest, before.digest);
  assert.notDeepEqual(
    after.file_facts.find(fact => fact.path === 'assets/logo.bin'),
    before.file_facts.find(fact => fact.path === 'assets/logo.bin'),
  );
});

test('honors separate roots, explicit files, and the dot root sentinel', async t => {
  const root = await makeRoot(t);
  await put(root, 'src/in-scope.js');
  await put(root, 'docs/out-of-scope.md');
  await put(root, 'README.md');

  const restricted = await collectRepositoryPaths({
    workspaceRoot: root,
    scope: { roots: ['src'], files: ['README.md'] },
  });
  const wholeRoot = await collectRepositoryPaths({ workspaceRoot: root, scope: { roots: ['.'], files: [] } });

  assert.deepEqual(restricted.files, ['README.md', 'src/in-scope.js']);
  assert.deepEqual(wholeRoot.files, ['README.md', 'docs/out-of-scope.md', 'src/in-scope.js']);
});

test('fails closed on a directory symlink or junction without exposing its target', async t => {
  const root = await makeRoot(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'repository-inventory-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await put(root, 'src/alias/inside.js');
  await put(outside, 'outside-secret.js');
  const alias = path.join(root, 'src', 'alias');
  const scope = { roots: ['src'], files: [] };
  const before = await collectRepositoryPaths({ workspaceRoot: root, scope });
  await rm(alias, { recursive: true, force: true });
  try {
    await symlink(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) {
      t.skip(`This host cannot create a directory link for the no-follow probe (${error.code}).`);
      return;
    }
    throw error;
  }
  assert.deepEqual(before.files, ['src/alias/inside.js']);
  await assert.rejects(
    collectRepositoryPaths({ workspaceRoot: root, scope }),
    error => error.code === 'SOURCE_UNAVAILABLE'
      && error.details?.path === 'src/alias'
      && !JSON.stringify(error.details).includes(outside),
  );
});

test('rejects a symlink workspace root and reports missing scoped paths as incomplete', async t => {
  const root = await makeRoot(t);
  const alias = `${root}-alias`;
  t.after(() => rm(alias, { recursive: true, force: true }));
  try {
    await symlink(root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP', 'UNKNOWN'].includes(error?.code)) throw error;
    t.skip(`This host cannot create a workspace-root link (${error.code}).`);
    return;
  }

  await assert.rejects(
    collectRepositoryPaths({ workspaceRoot: alias, scope: { roots: ['.'], files: [] } }),
    error => error.code === 'SCOPE_DENIED',
  );
  await assert.rejects(
    collectRepositoryPaths({ workspaceRoot: root, scope: { roots: [], files: ['missing/file.js'] } }),
    error => error.code === 'SOURCE_UNAVAILABLE',
  );
});
