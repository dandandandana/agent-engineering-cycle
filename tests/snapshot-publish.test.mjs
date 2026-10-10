import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const moduleUrl = new URL('../src/local/workspace.mjs', import.meta.url).href;
function probe(t, mode) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-publish-probe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'subject.mjs'), 'export const value = 18;\n');
  fs.mkdirSync(path.join(root, '.codex', 'engineering-cycle', 'snapshots'), { recursive: true });
  const script = `
    import fs from 'node:fs';
    import { syncBuiltinESMExports } from 'node:module';
    import path from 'node:path';
    const original = fs.promises.rename;
    let attempts = 0;
    fs.promises.rename = async (source, target) => {
      if (path.basename(source).startsWith('.cycle-snapshot-')) {
        attempts++;
        if (${JSON.stringify(mode)} === 'occupied' && attempts === 1) fs.mkdirSync(target);
        if (${JSON.stringify(mode)} !== 'transient' || attempts < 3) throw Object.assign(new Error('Injected directory publish denial'), { code: 'EPERM' });
      }
      return original(source, target);
    };
    syncBuiltinESMExports();
    const { WorkspaceAdapter } = await import(${JSON.stringify(moduleUrl)});
    const root = process.argv[1];
    const adapter = new WorkspaceAdapter(root);
    try {
      const snapshot = await adapter.snapshot(['subject.mjs'], path.join(root, '.codex', 'engineering-cycle', 'snapshots'));
      const verified = await adapter.verifySnapshot(snapshot);
      console.log(JSON.stringify({ ok: true, attempts, verified: verified.valid, content: fs.readFileSync(path.join(snapshot.input_dir, 'subject.mjs'), 'utf8') }));
    } catch (e) { console.log(JSON.stringify({ ok: false, attempts, code: e.code, phase: e.details?.phase })); }
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, root], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(path.join(root, 'subject.mjs'), 'utf8'), 'export const value = 18;\n');
  return JSON.parse(result.stdout);
}

test('Windows snapshot publishing survives two injected denials and preserves frozen bytes', { skip: process.platform !== 'win32' }, t => {
  assert.deepEqual(probe(t, 'transient'), { ok: true, attempts: 3, verified: true, content: 'export const value = 18;\n' });
});
test('persistent Windows publish denial is bounded and remains a failure', { skip: process.platform !== 'win32' }, t => {
  assert.deepEqual(probe(t, 'persistent'), { ok: false, attempts: 3, code: 'SNAPSHOT_INCOMPLETE', phase: 'publish' });
});
test('snapshot publish retry never replaces an occupied destination', { skip: process.platform !== 'win32' }, t => {
  assert.deepEqual(probe(t, 'occupied'), { ok: false, attempts: 1, code: 'SNAPSHOT_INCOMPLETE', phase: 'publish' });
});
