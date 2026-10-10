import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { canonical, digest, sha256, fault } from '../core/contracts.mjs';

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const EVIDENCE_KIND = /^[a-z][a-z0-9_-]*$/;
const EVIDENCE_ID = /^[a-z][a-z0-9_-]*-[a-f0-9]{64}$/;
function verifyEvidence(record, id) {
  if (!record || record.schema_revision !== 1 || typeof record.kind !== 'string' || !EVIDENCE_KIND.test(record.kind) || record.id !== id || id !== `${record.kind}-${record.digest}` || digest(record.payload) !== record.digest) throw fault('EVIDENCE_INVALID', 'Evidence identity mismatch.');
  return record;
}
export function readJson(file, { optional = false, limit = 4 * 1024 * 1024 } = {}) {
  let stat;
  try { stat = fs.lstatSync(file); } catch (e) { if (e.code === 'ENOENT' && optional) return null; throw fault('STORE_UNAVAILABLE', 'Required local record is unavailable.'); }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw fault('EVIDENCE_INVALID', 'Record must be a bounded regular file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const bytes = Buffer.alloc(limit + 1); const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > limit || !fs.fstatSync(fd).isFile()) throw fault('EVIDENCE_INVALID', 'Record exceeded its bound.');
    return JSON.parse(UTF8.decode(bytes.subarray(0, size)));
  } catch (e) { if (e.code && e.name === 'CycleError') throw e; throw fault('EVIDENCE_INVALID', 'Record is not valid UTF-8 JSON.'); }
  finally { fs.closeSync(fd); }
}

function regularDirectories(root, target, create = false) {
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw fault('SCOPE_DENIED', 'Store path escaped the workspace.');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (create && !fs.existsSync(cursor)) { try { fs.mkdirSync(cursor, { mode: 0o700 }); } catch (e) { if (e.code !== 'EEXIST') throw e; } }
    if (!fs.existsSync(cursor)) return false;
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('SCOPE_DENIED', 'Store ancestors must be regular directories.');
  }
  return true;
}

/** One local filesystem namespace. No initialization on inspect. */
export class LocalStore {
  constructor(workspaceRoot) {
    this.root = fs.realpathSync(workspaceRoot); this.workspaceId = sha256(process.platform === 'win32' ? this.root.toLowerCase() : this.root);
    this.directory = path.join(this.root, '.codex', 'engineering-cycle');
    this.lockFile = path.join(this.directory, 'lease.json');
  }
  file(relative) {
    if (!/^[A-Za-z0-9_./-]+$/.test(relative) || relative.split('/').includes('..')) throw fault('EVIDENCE_INVALID', 'Invalid record identity.');
    const resolved = path.join(this.directory, relative);
    regularDirectories(this.root, path.dirname(resolved));
    return resolved;
  }
  read(relative, optional = false) { const file = this.file(relative); return readJson(file, { optional }); }
  ensureDirectory(relative) { const directory = this.file(relative); regularDirectories(this.root, directory, true); return directory; }
  write(relative, value, { immutable = false } = {}) {
    const file = this.file(relative); regularDirectories(this.root, path.dirname(file), true);
    if (fs.existsSync(file) && fs.lstatSync(file).isSymbolicLink()) throw fault('SCOPE_DENIED', 'Linked record refused.');
    const text = JSON.stringify(canonical(value)); const temp = `${file}.${randomUUID()}.tmp`;
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    try {
      if (immutable) { fs.linkSync(temp, file); fs.unlinkSync(temp); }
      else fs.renameSync(temp, file);
      // Best-effort directory fsync is a durability fact, not a second write.
      if (process.platform !== 'win32') { const parent = fs.openSync(path.dirname(file), 'r'); try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); } }
    } catch (e) { try { fs.unlinkSync(temp); } catch {} throw fault('STORE_UNAVAILABLE', 'Record publication failed.', { io_code: e.code ?? 'IO_ERROR' }); }
    return value;
  }
  /**
   * 保存内容寻址的证据，返回 {id,digest,kind,schema_revision}；value 的领域校验由调用方负责。
   * kind 校验后与内容摘要构成文件名；旧记录核对封套后复用，新记录经 write 的 immutable 发布。
   * value → contracts.digest → canonical（对象键排序、数组顺序保留）→ JSON.stringify
   *       → sha256 → node:crypto.createHash；证据记录经 write → node:fs 持久化。
   * 不合法 kind/损坏封套抛 EVIDENCE_INVALID；发布阶段失败由 write 报 STORE_UNAVAILABLE。
   * 副作用是创建存储目录和新证据文件；本方法不获取 lease，跨进程协调由调用方承担。
   * 维护约束：不覆盖已有记录；摘要规范化规则影响历史 ID，不可无迁移依据改变。
   * 选择理由与范围：见 docs/design/architecture.md 的 Store/恢复合同；本说明是静态事实。
   */
  archive(kind, value) {
    if (typeof kind !== 'string' || !EVIDENCE_KIND.test(kind)) throw fault('EVIDENCE_INVALID', 'Invalid evidence kind.');
    const hash = digest(value); const id = `${kind}-${hash}`; const file = `evidence/${id}.json`;
    const existing = this.read(file, true);
    if (existing) verifyEvidence(existing, id);
    else this.write(file, { id, digest: hash, schema_revision: 1, kind, payload: value }, { immutable: true });
    return { id, digest: hash, kind, schema_revision: 1 };
  }
  evidence(id) {
    if (typeof id !== 'string' || !EVIDENCE_ID.test(id)) throw fault('EVIDENCE_INVALID', 'Invalid evidence reference.');
    return verifyEvidence(this.read(`evidence/${id}.json`), id);
  }
  current() { return this.read('current.json', true); }
  operation(requestId) { return this.read(`operations/${sha256(requestId)}.json`, true); }
  saveOperation(op) { return this.write(`operations/${sha256(op.request_id)}.json`, op); }
  async withLease(action, { signal } = {}) {
    if (signal?.aborted) throw fault('OPERATION_FAILED', 'Cancelled before lease acquisition.');
    regularDirectories(this.root, this.directory, true);
    const owner = { nonce: randomUUID(), pid: process.pid, started_at: new Date().toISOString() };
    let fd;
    try { fd = fs.openSync(this.lockFile, 'wx', 0o600); fs.writeFileSync(fd, JSON.stringify(owner)); fs.fsyncSync(fd); }
    catch (e) { if (fd !== undefined) fs.closeSync(fd); throw fault(e.code === 'EEXIST' ? 'LEASE_BUSY' : 'STORE_UNAVAILABLE', 'Workspace lease is busy or unavailable; inspect before recovery.'); }
    fs.closeSync(fd);
    let outcome;
    try { outcome = await action(owner); return outcome; }
    finally {
      const current = readJson(this.lockFile, { optional: true });
      if (current?.nonce !== owner.nonce) throw fault('STORE_UNAVAILABLE', 'Lease owner changed; action effects must be inspected.', { effects_known: false });
      fs.unlinkSync(this.lockFile);
    }
  }
  leaseStatus() {
    const owner = this.read('lease.json', true); if (!owner) return null;
    let alive = 'unknown'; try { process.kill(owner.pid, 0); alive = true; } catch (e) { if (e.code === 'ESRCH') alive = false; }
    return { ...owner, owner_alive: alive, automatic_recovery: false };
  }
}
