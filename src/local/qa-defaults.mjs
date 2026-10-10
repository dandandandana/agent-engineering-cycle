import { timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import { digest, fault } from '../core/contracts.mjs';
import { binaryIdentity, DRIVER_REVISION } from '../adapters/qa-cli.mjs';

/** An explicit live calibration chooses a driver locally; this is not an action grant. */
export function readDefaultQaSelection(store, authority) {
  if (!fs.existsSync(store.file('defaults/qa-selection.json'))) return null;
  const record = store.read('defaults/qa-selection.json');
  if (!record || typeof record !== 'object' || !record.payload) throw fault('QA_VERIFICATION_UNAVAILABLE', 'Default QA selection is invalid.');
  const payload = record.payload;
  const expected = Buffer.from(authority.mac(payload), 'hex');
  const actual = Buffer.from(record.signature ?? '', 'hex');
  if (record.digest !== digest(payload) || expected.length !== actual.length || !timingSafeEqual(expected, actual)
    || payload.workspace_id !== store.workspaceId || payload.source !== 'explicit-live-calibration'
    || !payload.driver?.executable || !payload.driver?.model || !/^[a-f0-9]{64}$/.test(payload.binary_digest ?? '')) throw fault('QA_VERIFICATION_UNAVAILABLE', 'Default QA selection is invalid.');
  return payload;
}

/** Receipts are capability facts: the original driver identity remains fixed in the cycle plan. */
export function withDefaultQaReceipt(config, store) {
  if (config.schema_revision !== 3 || !config.qa?.executable || !config.qa?.model) return config;
  const record = store.read('qa-capability.json', true);
  const p = record?.payload;
  if (!p || p.driver_revision !== DRIVER_REVISION || p.platform !== process.platform || p.model !== config.qa.model
    || (p.windows_sandbox ?? null) !== (config.qa.windows_sandbox ?? null)) return config;
  try { if (binaryIdentity(config.qa.executable) !== p.binary_digest) return config; }
  catch { return config; }
  // qaCapability separately authenticates this signature and all real probe archives.
  return { ...config, qa: { ...config.qa, capability_receipt: digest(p) } };
}
