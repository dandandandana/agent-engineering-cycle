import fs from 'node:fs';
import path from 'node:path';
import { digest, fault, sha256 } from '../core/contracts.mjs';
import { LocalStore } from './store.mjs';
import { pluginStorageNamespace, resolvePluginDataDirectory, ROUTE_CONTRACT } from './plugin-data.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const MAX_ROUTES = 128;
const MAX_RECORD_BYTES = 8192;
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
const MODEL = /^[A-Za-z0-9_.:/-]{1,160}$/;

export function hostContextFromMetadata(metadata) {
  const value = metadata?.['x-codex-turn-metadata'];
  if (!UUID.test(value?.thread_id ?? '') || !UUID.test(value?.turn_id ?? '')) return null;
  return { session_id: value.thread_id.toLowerCase(), turn_id: value.turn_id.toLowerCase() };
}

function physicalRoot(selected) {
  if (typeof selected !== 'string' || !path.isAbsolute(selected)) throw fault('CONTEXT_REQUIRED', 'Project context must identify an absolute directory.');
  const stat = fs.lstatSync(selected);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('CONTEXT_REQUIRED', 'Project context must identify a regular directory.');
  const root = fs.realpathSync.native(selected);
  const actual = fs.statSync(root);
  if (stat.dev !== actual.dev || stat.ino !== actual.ino) throw fault('WORKSPACE_CONFLICT', 'Project directory identity changed.');
  return { root, workspace_id: sha256(process.platform === 'win32' ? root.toLowerCase() : root), device: actual.dev, inode: actual.ino };
}

/** Reuses Store's regular paths, atomic publication and short cross-process lease for addresses only. */
export class HostContextStore {
  constructor({ env = process.env, now = () => Date.now() } = {}) {
    this.namespace = pluginStorageNamespace({ env });
    this.now = now;
    const directory = resolvePluginDataDirectory({ env });
    this.store = new LocalStore(path.resolve(directory, '../../..'));
    this.store.directory = path.join(directory, `routes-${this.namespace}`);
    this.store.lockFile = path.join(this.store.directory, 'lease.json');
  }
  key(context) {
    if (!UUID.test(context?.session_id ?? '') || !UUID.test(context?.turn_id ?? '')) throw fault('CONTEXT_REQUIRED', 'Current session and turn metadata are required.');
    return digest({ namespace: this.namespace, session_id: context.session_id.toLowerCase(), turn_id: context.turn_id.toLowerCase() });
  }
  read(key) {
    const file = this.store.file(`records/${key}.json`);
    if (!fs.existsSync(file)) return null;
    if (fs.lstatSync(file).size > MAX_RECORD_BYTES) throw fault('CONTEXT_REQUIRED', 'Project context exceeds the address budget.');
    const record = this.store.read(`records/${key}.json`);
    if (!record || record.schema_revision !== ROUTE_CONTRACT || record.namespace !== this.namespace || record.key !== key || record.digest !== digest(record.payload)
      || !Number.isSafeInteger(record.payload?.observed_at) || record.payload.observed_at > this.now() + 5000) throw fault('CONTEXT_REQUIRED', 'Project context record is invalid.');
    return record.payload;
  }
  async publish(event) {
    if (event?.hook_event_name !== 'UserPromptSubmit' || !UUID.test(event.session_id ?? '') || !UUID.test(event.turn_id ?? '')) return { published: false, reason: 'CURRENT_TURN_REQUIRED' };
    const context = { session_id: event.session_id.toLowerCase(), turn_id: event.turn_id.toLowerCase() };
    const key = this.key(context);
    const identity = physicalRoot(event.cwd);
    const model = MODEL.test(event.model ?? '') ? event.model : null;
    return this.store.withLease(async () => {
      const old = this.read(key);
      const conflict = old?.ambiguous === true || old && (old.workspace_id !== identity.workspace_id || old.device !== identity.device || old.inode !== identity.inode);
      const payload = conflict
        ? { ...context, observed_at: this.now(), ambiguous: true }
        : { ...context, ...identity, model, observed_at: this.now(), ambiguous: false };
      this.prune(key);
      this.store.write(`records/${key}.json`, { schema_revision: ROUTE_CONTRACT, namespace: this.namespace, key, payload, digest: digest(payload) });
      return { published: true, ambiguous: conflict === true };
    });
  }
  prune(keep) {
    const directory = this.store.file('records/placeholder.json');
    if (!fs.existsSync(path.dirname(directory))) return;
    const entries = fs.readdirSync(path.dirname(directory)).filter(name => /^[a-f0-9]{64}\.json$/.test(name));
    const candidates = [];
    for (const name of entries) {
      const key = name.slice(0, -5);
      if (key === keep) continue;
      const record = this.read(key);
      if (this.now() - record.observed_at > MAX_AGE_MS) fs.unlinkSync(this.store.file(`records/${name}`));
      else candidates.push({ key, time: record.observed_at });
    }
    candidates.sort((a, b) => a.time - b.time);
    for (const old of candidates.slice(0, Math.max(0, candidates.length - MAX_ROUTES + 1))) fs.unlinkSync(this.store.file(`records/${old.key}.json`));
  }
  lookup(context) {
    const record = this.read(this.key(context));
    if (!record || this.now() - record.observed_at > MAX_AGE_MS) throw fault('CONTEXT_REQUIRED', 'A current-turn Hook address is unavailable; select this project explicitly.');
    if (record.ambiguous) throw fault('WORKSPACE_CONFLICT', 'The current turn identifies conflicting projects; select an unambiguous workspace.');
    if (record.session_id !== context.session_id.toLowerCase() || record.turn_id !== context.turn_id.toLowerCase() || !HASH.test(record.workspace_id ?? '')) throw fault('CONTEXT_REQUIRED', 'Project context does not match this request.');
    const identity = physicalRoot(record.root);
    if (identity.workspace_id !== record.workspace_id || identity.device !== record.device || identity.inode !== record.inode) throw fault('WORKSPACE_CONFLICT', 'The paired project directory was replaced.');
    return { ...identity, model: record.model, source: 'current-turn-hook', namespace: this.namespace };
  }
}

/** Decoder for the actual matched native input shapes; unknown shapes make no path claim. */
export function nativeWriteTargets(event) {
  const input = event?.tool_input;
  if (event?.tool_name === 'Write' || event?.tool_name === 'Edit') {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
    const p = input.file_path ?? input.path;
    if (input.file_path && input.path && input.file_path !== input.path) return null;
    return typeof p === 'string' && p && !/[\u0000-\u001f\u007f]/u.test(p) ? [p] : null;
  }
  if (event?.tool_name !== 'apply_patch') return null;
  const patch = typeof input === 'string' ? input : input?.command ?? input?.patch;
  if (typeof patch !== 'string' || Buffer.byteLength(patch) > 65536) return null;
  const lines = patch.replaceAll('\r\n', '\n').trimEnd().split('\n');
  if (lines.shift() !== '*** Begin Patch' || lines.pop() !== '*** End Patch') return null;
  const targets = [];
  let inOperation = false;
  for (const line of lines) {
    const header = /^\*\*\* (Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (header) {
      if (header[1] === 'Move to' && !inOperation) return null;
      if (/[\u0000-\u001f\u007f]/u.test(header[2])) return null;
      targets.push(header[2]);
      inOperation = true;
    } else if (!inOperation || !(line.startsWith('+') || line.startsWith('-') || line.startsWith(' ') || line.startsWith('@@') || line === '*** End of File')) return null;
  }
  return targets.length && targets.length <= 128 ? [...new Set(targets)] : null;
}
