import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { removeAuthLinks } from '../benchmarks/live.mjs';

test('absent or failed first credential link does not prevent cleanup of later owned links', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cycle-cleanup-test-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = ['plain', 'skill', 'plugin'].map(p => path.join(root, p, 'auth.json'));
  for (const file of files) await fs.mkdir(path.dirname(file));
  for (const file of files.slice(1)) await fs.writeFile(file, 'dummy fixture; no credentials');
  await removeAuthLinks({ homeRoot: root, authLinks: files });
  for (const file of files) await assert.rejects(fs.access(file), { code: 'ENOENT' });
  await fs.mkdir(files[0]);
  for (const file of files.slice(1)) await fs.writeFile(file, 'dummy fixture; no credentials');
  await assert.rejects(removeAuthLinks({ homeRoot: root, authLinks: files }), /cleanup failed/);
  for (const file of files.slice(1)) await assert.rejects(fs.access(file), { code: 'ENOENT' });
});
