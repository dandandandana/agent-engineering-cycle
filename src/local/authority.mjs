import fs from 'node:fs';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { digest, fault } from '../core/contracts.mjs';

/** Privileged operator entry creates receipts; model tool inputs can only refer to them. */
export class OperatorAuthority {
  constructor(store) { this.store = store; }
  key({ create = false } = {}) {
    let record = this.store.read('authority/key.json', true);
    if (!record && create) { record = { key: randomBytes(32).toString('hex') }; this.store.write('authority/key.json', record, { immutable: true }); }
    if (!record || !/^[a-f0-9]{64}$/.test(record.key)) throw fault('DECISION_UNVERIFIED', 'Workspace has no operator authority. Run the interactive authorize entry.');
    return Buffer.from(record.key, 'hex');
  }
  mac(payload, key = this.key()) { return createHmac('sha256', key).update(digest(payload)).digest('hex'); }
  issue(payload, { operatorConfirmed = false } = {}) {
    if (!operatorConfirmed) throw fault('DECISION_UNVERIFIED', 'Only the operator adapter can issue authorization.');
    const key = this.key({ create: true }); const id = `grant-${digest(payload)}`;
    const receipt = { id, payload, signature: this.mac(payload, key) };
    const old = this.store.read(`authority/${id}.json`, true);
    if (old) return this.load(id);
    this.store.write(`authority/${id}.json`, receipt, { immutable: true }); return receipt;
  }
  load(id) {
    if (!/^grant-[a-f0-9]{64}$/.test(id ?? '')) throw fault('DECISION_UNVERIFIED', 'A verified operator grant reference is required.');
    const record = this.store.read(`authority/${id}.json`, true);
    if (!record || record.id !== id || digest(record.payload) !== id.slice(6)) throw fault('DECISION_UNVERIFIED', 'Grant is missing or has changed.');
    const expected = Buffer.from(this.mac(record.payload), 'hex'); const actual = Buffer.from(record.signature ?? '', 'hex');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw fault('DECISION_UNVERIFIED', 'Grant signature did not verify.');
    if (record.payload.workspace_id !== this.store.workspaceId || record.payload.source?.adapter !== 'interactive-operator') throw fault('DECISION_UNVERIFIED', 'Grant is not bound to this workspace/operator source.');
    if (this.store.read(`authority/revoked-${id}.json`, true)) throw fault('DECISION_UNVERIFIED', 'Operator grant was revoked.');
    return record;
  }
}
