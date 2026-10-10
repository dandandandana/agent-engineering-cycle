import { LocalStore } from './store.mjs';
import { canonical, sha256, fault } from '../core/contracts.mjs';

const MAX_BYTES = 16 * 1024 * 1024;
export const QA_CAPTURE_BYTES = 1024 * 1024;
const encode = record => JSON.stringify(canonical(record));

/** Freeze immutable gateway archives by exact serialized identity, not I verdicts. */
export function reuseQaContext(store, reuse, state) {
  if (!reuse.projection) return undefined;
  let bytes = 0;
  const evidence_refs = reuse.evidence_refs.map(ref => {
    const record = store.evidence(ref.id); const text = encode(record);
    bytes += Buffer.byteLength(text);
    return { ...ref, path: `reuse-evidence:${ref.id}`, sha256: sha256(text), size: Buffer.byteLength(text) };
  });
  if (evidence_refs.length > 128 || bytes > MAX_BYTES) throw fault('SNAPSHOT_INCOMPLETE', 'Frozen reuse evidence exceeds the QA capture bound.');
  return { projection: reuse.projection, semantic_verified: false, source_capture_complete: true, evidence_refs,
    archive_workspace: store.root, cursor: state.reuse_cursor,
    coverage_limits: ['Declared static ESM relationships only; model comprehension and dynamic caller coverage are not proved.'] };
}

/** Private input paths stay server-side. Public list contains only fixed page references. */
export function publicQaContext(context) {
  if (!context?.component_reuse) return context;
  const { archive_workspace, ...component_reuse } = context.component_reuse;
  return { ...context, component_reuse };
}

export function readQaEvidence(context, entry) {
  const reuse = context?.component_reuse;
  if (!reuse || !reuse.evidence_refs.some(ref => ref.path === entry.path)) throw fault('SCOPE_DENIED', 'Only frozen reuse evidence references may be read.');
  const record = new LocalStore(reuse.archive_workspace).evidence(entry.id);
  const text = encode(record);
  if (record.digest !== entry.digest || record.kind !== entry.kind || sha256(text) !== entry.sha256 || Buffer.byteLength(text) !== entry.size) throw fault('SNAPSHOT_INCOMPLETE', 'Frozen reuse archive changed.');
  return { content: text, sha256: entry.sha256, size: entry.size };
}

export function verifyQaEvidence(context) {
  for (const entry of context?.component_reuse?.evidence_refs ?? []) readQaEvidence(context, entry);
  return true;
}

/** Conservative allowance for duplicated JSON tool events, pages and final output. */
export function assertQaDeliveryBudget(manifest, context) {
  const entries = [...manifest.entries, ...(context?.component_reuse?.evidence_refs ?? [])];
  const present = entries.filter(e => e.missing !== true);
  if (present.some(e => !Number.isSafeInteger(e.size) || e.size < 0)) throw fault('EVIDENCE_INVALID', 'Frozen QA entries require finite byte sizes.', { effects_known: true });
  const bytes = present.reduce((n,e) => n + e.size, 0);
  const pages = present.reduce((n,e) => n + Math.max(1, Math.ceil(e.size / 8192)), 0);
  const metadata = Buffer.byteLength(JSON.stringify(publicQaContext(context) ?? {})) + Buffer.byteLength(JSON.stringify(manifest));
  const estimated = bytes * 12 + pages * 8192 + metadata * 12 + 128 * 1024;
  if (estimated > QA_CAPTURE_BYTES) throw fault('SNAPSHOT_INCOMPLETE', 'Frozen QA input exceeds the bounded CLI delivery capture; use a smaller authorized cycle.', { effects_known: true, estimated_capture_bytes: estimated, capture_limit: QA_CAPTURE_BYTES });
}
