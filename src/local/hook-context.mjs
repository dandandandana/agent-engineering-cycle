import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../core/contracts.mjs';

const MAX_HOOK_BYTES = 2048;
const MAX_LEDGER_BYTES = 64 * 1024;
const MAX_SESSIONS = 64;
const MAX_SUPPRESSED_PROMPTS = 3;
const SESSION_ID = /^[A-Za-z0-9._:-]{1,256}$/;
const CYCLE_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const HASH = /^[a-f0-9]{64}$/;
const EVIDENCE_ID = /^[a-z][a-z0-9_-]*-[a-f0-9]{64}$/;
const SOURCES = new Set(['startup', 'resume', 'clear', 'compact']);
const LEDGER_EVENTS = new Set(['SessionStart', 'UserPromptSubmit']);
const REUSE_STATUSES = new Set([
  'disabled', 'missing', 'ready_before_write', 'in_progress', 'needs_refresh',
  'unknown', 'verified', 'unavailable', 'not-requested',
]);
const STAGES = new Set(['requirements', 'design', 'implementation', 'qa', 'reconciliation', 'ready']);
const LIFECYCLES = new Set(['active', 'interrupted', 'completed', 'abandoned']);
const BLOCKER_PRIORITY = [
  'OUTCOME_UNKNOWN', 'OPERATION_PENDING', 'BINDING_STALE', 'REUSE_STALE',
  'REUSE_PLAN_REQUIRED', 'PROVIDER_UNAVAILABLE', 'EVIDENCE_INVALID',
  'DECISION_UNVERIFIED', 'SOURCE_UNAVAILABLE', 'QA_VERIFICATION_UNAVAILABLE',
  'AUTHORITY_CONFLICT', 'SCOPE_DENIED', 'CAPABILITY_UNAVAILABLE',
];
const TOOL_NAMES = new Set([
  'cycle_control', 'cycle_status', 'cycle_artifact', 'cycle_apply',
  'cycle_verify', 'cycle_qa', 'cycle_reconcile',
]);

class LedgerFailure extends Error {
  constructor(diagnostic) {
    super(diagnostic);
    this.diagnostic = diagnostic;
  }
}

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isValidHostSessionId(value) {
  return typeof value === 'string' && SESSION_ID.test(value);
}

function safeCycleId(value) {
  return typeof value === 'string' && CYCLE_ID.test(value) ? value : null;
}

function safeEvidenceId(value) {
  return typeof value === 'string' && value.length <= 96 && EVIDENCE_ID.test(value) ? value : null;
}

function safeBasisDigest(value) {
  return typeof value === 'string' && HASH.test(value) ? value : null;
}

function safeReuse(response) {
  const reuse = record(response?.reuse) ? response.reuse : null;
  const status = reuse && REUSE_STATUSES.has(reuse.status) ? reuse.status : 'not-requested';
  const source = record(reuse?.summary) ? reuse.summary : {};
  const summary = {};
  for (const key of ['required_targets', 'covered_targets', 'decisions', 'reads', 'stale', 'missing']) {
    const value = source[key];
    if (Number.isInteger(value) && value >= 0 && value <= 256) summary[key] = value;
  }
  const evidenceIds = [];
  for (const item of [...(Array.isArray(reuse?.evidence_refs) ? reuse.evidence_refs : []), ...(Array.isArray(response?.evidence_refs) ? response.evidence_refs : [])]) {
    const id = safeEvidenceId(record(item) ? item.id : null);
    if (id && !evidenceIds.includes(id)) evidenceIds.push(id);
    if (evidenceIds.length === 4) break;
  }
  return { status, summary, evidence_ids: evidenceIds };
}

function safeImplementationNotes(response) {
  const source = record(response?.implementation_notes?.summary) ? response.implementation_notes.summary : null;
  if (!source) return null;
  const summary = {};
  for (const key of ['required', 'attached', 'current', 'stale', 'missing', 'invalid']) {
    const value = source[key];
    if (Number.isInteger(value) && value >= 0 && value <= 256) summary[key] = value;
  }
  return Object.keys(summary).length ? summary : null;
}

function safeBlocker(response) {
  const blockers = Array.isArray(response?.blockers) ? response.blockers.filter(record) : [];
  for (const code of BLOCKER_PRIORITY) {
    if (blockers.some(blocker => blocker.code === code)) return code;
  }
  return null;
}

function fixedNext(response, blocker) {
  const lifecycle = LIFECYCLES.has(response?.lifecycle) ? response.lifecycle : 'unknown';
  const stage = STAGES.has(response?.stage) ? response.stage : 'unknown';
  const blockerRecord = Array.isArray(response?.blockers)
    ? response.blockers.find(item => record(item) && item.code === blocker)
    : null;
  let next;
  if (blocker === 'OUTCOME_UNKNOWN' || blocker === 'OPERATION_PENDING' || response?.pending_operation) {
    next = { tool: 'cycle_status', action: 'inspect-operation' };
  } else if (lifecycle === 'interrupted') {
    next = { tool: 'cycle_control', action: 'resume-explicitly' };
  } else if (blocker === 'REUSE_PLAN_REQUIRED' || blocker === 'REUSE_STALE') {
    next = { tool: 'cycle_artifact', action: 'review-reuse-evidence' };
  } else if (blocker === 'PROVIDER_UNAVAILABLE') {
    next = { tool: 'cycle_status', action: 'inspect-reuse-status' };
  } else if (['R', 'D', 'I', 'implementation_notes'].includes(blockerRecord?.kind)) {
    next = { tool: 'cycle_artifact', action: 'prepare-or-attach' };
  } else if (blockerRecord?.kind === 'checks') {
    next = { tool: 'cycle_verify', action: 'run-configured-checks' };
  } else if (blockerRecord?.kind === 'independent_qa') {
    next = { tool: 'cycle_qa', action: 'inspect-independent-qa' };
  } else if (stage === 'requirements' || stage === 'design') {
    next = { tool: 'cycle_artifact', action: 'prepare-current-authority' };
  } else if (stage === 'implementation') {
    next = { tool: 'cycle_apply', action: 'apply-authorized-changes' };
  } else if (stage === 'qa') {
    next = { tool: 'cycle_verify', action: 'run-configured-checks' };
  } else {
    next = { tool: 'cycle_status', action: 'inspect-current-cycle' };
  }
  if (!TOOL_NAMES.has(next.tool)) next = { tool: 'cycle_status', action: 'inspect-current-cycle' };
  const evidenceId = safeReuse(response).evidence_ids[0] ?? null;
  return { ...next, evidence_id: evidenceId };
}

/** Produces a fixed, non-prose projection and the semantic facts used for dedupe. */
export function projectHookContext(response, { sessionHash } = {}) {
  const cycleId = safeCycleId(response?.binding?.cycle_id);
  if (!cycleId) return null;
  const stage = STAGES.has(response.stage) ? response.stage : 'unknown';
  const lifecycle = LIFECYCLES.has(response.lifecycle) ? response.lifecycle : 'unknown';
  const reuse = safeReuse(response);
  const implementationNotes = safeImplementationNotes(response);
  const blocker = safeBlocker(response);
  const next = fixedNext(response, blocker);
  const pendingOperation = typeof response.pending_operation === 'string'
    && /^[A-Za-z0-9_.:-]{1,128}$/.test(response.pending_operation)
    ? response.pending_operation
    : null;
  const display = {
    cycle: cycleId.slice(0, 8),
    stage,
    lifecycle,
    reuse: { status: reuse.status, ...reuse.summary },
    ...(implementationNotes ? { implementation_notes: implementationNotes } : {}),
    blocker,
    next,
  };
  const semantic = {
    // The scope and source/dependency identity are covered by basis_digest.
    session_hash: typeof sessionHash === 'string' && HASH.test(sessionHash) ? sessionHash : null,
    cycle_id: cycleId,
    stage,
    lifecycle,
    basis_digest: safeBasisDigest(response.binding.basis_digest),
    reuse,
    implementation_notes: implementationNotes,
    blocker,
    pending_operation: pendingOperation,
    next,
  };
  return { display, semantic };
}

function pointer(diagnostic) {
  return {
    tool: 'cycle_status',
    action: 'inspect-current-cycle',
    ...(diagnostic ? { diagnostic } : {}),
  };
}

function responseFor(eventName, context) {
  return { hookSpecificOutput: { hookEventName: eventName, additionalContext: JSON.stringify(context) } };
}

export function boundedHookResponse(eventName, context, diagnostic = null) {
  const candidate = responseFor(eventName, context);
  if (Buffer.byteLength(JSON.stringify(candidate), 'utf8') <= MAX_HOOK_BYTES) return candidate;
  const fallback = responseFor(eventName, pointer(diagnostic ?? 'HOOK_CONTEXT_BUDGET'));
  if (Buffer.byteLength(JSON.stringify(fallback), 'utf8') <= MAX_HOOK_BYTES) return fallback;
  // The fixed envelope is far below the limit; retain a valid JSON pointer if a caller changes it.
  return responseFor(eventName, { tool: 'cycle_status' });
}

function emptyLedger() {
  return { schema_revision: 1, sessions: [] };
}

function validGeneratedEvent(value) {
  if (value === null) return true;
  if (!record(value) || !LEDGER_EVENTS.has(value.name) || !Number.isSafeInteger(value.epoch) || value.epoch < 0 || value.delivery !== 'unknown') return false;
  if (Object.keys(value).some(key => !['name', 'epoch', 'delivery', 'source'].includes(key))) return false;
  return value.source === undefined || SOURCES.has(value.source);
}

function validateLedger(value) {
  if (!record(value) || value.schema_revision !== 1 || !Array.isArray(value.sessions) || value.sessions.length > MAX_SESSIONS) {
    throw new LedgerFailure('HOOK_LEDGER_CORRUPT');
  }
  if (Object.keys(value).some(key => !['schema_revision', 'sessions'].includes(key))) throw new LedgerFailure('HOOK_LEDGER_CORRUPT');
  const seen = new Set();
  for (const entry of value.sessions) {
    if (!record(entry)
      || Object.keys(entry).some(key => !['session_hash', 'cycle_id', 'fingerprint', 'generated_event', 'suppressed_user_prompts'].includes(key))
      || !HASH.test(entry.session_hash ?? '')
      || seen.has(entry.session_hash)
      || !safeCycleId(entry.cycle_id)
      || !(entry.fingerprint === null || HASH.test(entry.fingerprint ?? ''))
      || !validGeneratedEvent(entry.generated_event)
      || !Number.isInteger(entry.suppressed_user_prompts)
      || entry.suppressed_user_prompts < 0
      || entry.suppressed_user_prompts > MAX_SUPPRESSED_PROMPTS) {
      throw new LedgerFailure('HOOK_LEDGER_CORRUPT');
    }
    seen.add(entry.session_hash);
  }
  return value;
}

function validateDirectory(root, directory) {
  const relative = path.relative(root, directory);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
  let cursor = root;
  for (const part of relative.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
  }
  return true;
}

function readBoundedJson(file, limit, missingValue) {
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return missingValue;
    throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw new LedgerFailure('HOOK_LEDGER_CORRUPT');
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const bytes = Buffer.alloc(limit + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (size > limit || !fs.fstatSync(fd).isFile()) throw new LedgerFailure('HOOK_LEDGER_CORRUPT');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)));
  } catch (error) {
    if (error instanceof LedgerFailure) throw error;
    throw new LedgerFailure('HOOK_LEDGER_CORRUPT');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Small independent ledger. It stores only hashed sessions and routing/dedupe metadata.
 * Reads never create directories; writes require the cycle directory already to exist.
 */
export class HookSessionLedger {
  constructor({ workspaceRoot, directory } = {}) {
    this.root = fs.realpathSync(workspaceRoot ?? process.cwd());
    this.directory = directory ?? path.join(this.root, '.codex', 'engineering-cycle');
    this.file = path.join(this.directory, 'hook-context-v1.json');
    this.lockFile = path.join(this.directory, 'hook-context-v1.lock');
  }

  #read() {
    if (!validateDirectory(this.root, this.directory)) return emptyLedger();
    return validateLedger(readBoundedJson(this.file, MAX_LEDGER_BYTES, emptyLedger()));
  }

  #write(ledger) {
    if (!validateDirectory(this.root, this.directory)) throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
    const text = JSON.stringify(ledger);
    if (Buffer.byteLength(text, 'utf8') > MAX_LEDGER_BYTES) throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
    let stat;
    try { stat = fs.lstatSync(this.file); }
    catch (error) { if (error.code !== 'ENOENT') throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE'); }
    if (stat && (!stat.isFile() || stat.isSymbolicLink())) throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
    const temp = `${this.file}.${randomUUID()}.tmp`;
    let fd;
    try {
      fd = fs.openSync(temp, 'wx', 0o600);
      fs.writeFileSync(fd, text);
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temp, this.file);
      if (process.platform !== 'win32') {
        const parent = fs.openSync(this.directory, 'r');
        try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
      }
    } catch {
      if (fd !== undefined) fs.closeSync(fd);
      try { fs.unlinkSync(temp); } catch {}
      throw new LedgerFailure('HOOK_LEDGER_UNAVAILABLE');
    }
  }

  #withLease(action) {
    if (!validateDirectory(this.root, this.directory)) return { ok: false, diagnostic: 'HOOK_LEDGER_UNAVAILABLE' };
    const owner = { nonce: randomUUID(), pid: process.pid };
    let fd;
    let created = false;
    try {
      fd = fs.openSync(this.lockFile, 'wx', 0o600);
      created = true;
      fs.writeFileSync(fd, JSON.stringify(owner));
      fs.fsyncSync(fd);
    } catch (error) {
      if (fd !== undefined) fs.closeSync(fd);
      if (error.code === 'EEXIST') return { ok: false, diagnostic: 'HOOK_LEDGER_BUSY' };
      if (created) try { fs.unlinkSync(this.lockFile); } catch {}
      return { ok: false, diagnostic: 'HOOK_LEDGER_UNAVAILABLE' };
    }
    fs.closeSync(fd);
    try {
      return { ok: true, value: action() };
    } catch (error) {
      return { ok: false, diagnostic: error instanceof LedgerFailure ? error.diagnostic : 'HOOK_LEDGER_UNAVAILABLE' };
    } finally {
      try {
        const current = readBoundedJson(this.lockFile, 1024, null);
        if (current?.nonce === owner.nonce) fs.unlinkSync(this.lockFile);
      } catch {
        // A damaged or replaced lease is left for inspection; hook failure is non-business state.
      }
    }
  }

  lookup(hostSessionId) {
    if (!isValidHostSessionId(hostSessionId)) return { cycle_id: null, diagnostic: 'SESSION_UNBOUND' };
    try {
      const sessionHash = sha256(hostSessionId);
      const entry = this.#read().sessions.find(item => item.session_hash === sessionHash);
      return entry
        ? { cycle_id: entry.cycle_id, session_hash: sessionHash }
        : { cycle_id: null, diagnostic: 'SESSION_UNBOUND' };
    } catch (error) {
      return { cycle_id: null, diagnostic: error instanceof LedgerFailure ? error.diagnostic : 'HOOK_LEDGER_UNAVAILABLE' };
    }
  }

  bindHostSession(hostSessionId, cycleId) {
    if (!isValidHostSessionId(hostSessionId) || !safeCycleId(cycleId)) return { ok: false, diagnostic: 'SESSION_UNBOUND' };
    const sessionHash = sha256(hostSessionId);
    return this.#withLease(() => {
      const ledger = this.#read();
      const existing = ledger.sessions.find(item => item.session_hash === sessionHash);
      const entry = existing?.cycle_id === cycleId
        ? existing
        : { session_hash: sessionHash, cycle_id: cycleId, fingerprint: null, generated_event: null, suppressed_user_prompts: 0 };
      const sessions = ledger.sessions.filter(item => item.session_hash !== sessionHash);
      sessions.push(entry);
      if (sessions.length > MAX_SESSIONS) sessions.splice(0, sessions.length - MAX_SESSIONS);
      this.#write({ schema_revision: 1, sessions });
      return true;
    });
  }

  /**
   * Atomically applies debounce and records an emission attempt. No caller/core work
   * occurs inside this short lease; returned delivery remains unknown without a host ack.
   */
  decideEmission(hostSessionId, cycleId, semanticFingerprint, { eventName, source } = {}) {
    if (!isValidHostSessionId(hostSessionId) || !safeCycleId(cycleId) || !HASH.test(semanticFingerprint ?? '')
      || !LEDGER_EVENTS.has(eventName)) return { mode: 'fallback', diagnostic: 'SESSION_UNBOUND' };
    const sessionHash = sha256(hostSessionId);
    const result = this.#withLease(() => {
      const ledger = this.#read();
      const index = ledger.sessions.findIndex(item => item.session_hash === sessionHash);
      if (index < 0 || ledger.sessions[index].cycle_id !== cycleId) throw new LedgerFailure('SESSION_UNBOUND');
      const entry = { ...ledger.sessions[index] };
      let epoch = entry.generated_event?.epoch ?? 0;
      if (eventName === 'SessionStart') epoch = epoch >= Number.MAX_SAFE_INTEGER ? 0 : epoch + 1;
      const fingerprint = sha256(JSON.stringify({ session_hash: sessionHash, epoch, cycle_id: cycleId, semantic_fingerprint: semanticFingerprint }));
      let mode;
      if (eventName === 'SessionStart' || entry.fingerprint !== fingerprint) {
        mode = 'full';
        entry.fingerprint = fingerprint;
        entry.suppressed_user_prompts = 0;
      } else if (entry.suppressed_user_prompts < MAX_SUPPRESSED_PROMPTS) {
        mode = 'suppress';
        entry.suppressed_user_prompts += 1;
      } else {
        mode = 'minimal';
        entry.suppressed_user_prompts = 0;
      }
      if (mode !== 'suppress') {
        const generatedEvent = { name: eventName, epoch, delivery: 'unknown' };
        if (eventName === 'SessionStart' && SOURCES.has(source)) generatedEvent.source = source;
        entry.generated_event = generatedEvent;
      }
      const sessions = ledger.sessions.filter(item => item.session_hash !== sessionHash);
      sessions.push(entry);
      this.#write({ schema_revision: 1, sessions });
      return { mode, fingerprint };
    });
    return result.ok ? result.value : { mode: 'fallback', diagnostic: result.diagnostic };
  }
}

export const HOOK_CONTEXT_MAX_BYTES = MAX_HOOK_BYTES;
