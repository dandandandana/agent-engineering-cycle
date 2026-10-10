import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { digest, sha256 } from '../src/core/contracts.mjs';
import { OperatorAuthority } from '../src/local/authority.mjs';
import { readConfig } from '../src/local/config.mjs';
import { LocalStore } from '../src/local/store.mjs';

const storeModuleUrl = pathToFileURL(path.resolve('src/local/store.mjs')).href;

async function workspace(t, prefix = 'cycle-store-') {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, store: new LocalStore(root) };
}

function codeIs(code) {
  return (error) => error?.code === code;
}

function startLineProcess(args, cwd) {
  const child = spawn(process.execPath, args, {
    cwd,
    shell: false,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  let closed = false;
  child.stderr.on('data', (chunk) => { stderr += chunk.toString('utf8'); });
  const closedPromise = new Promise((resolve) => {
    child.once('close', (code, signal) => {
      closed = true;
      resolve({ code, signal });
    });
  });

  function nextLine(timeoutMs = 5_000) {
    return new Promise((resolve, reject) => {
      let timer;
      const cleanup = () => {
        clearTimeout(timer);
        lines.removeListener('line', onLine);
        lines.removeListener('close', onClose);
        child.removeListener('error', onError);
      };
      const onLine = (line) => { cleanup(); resolve(line); };
      const onClose = () => { cleanup(); reject(new Error(`helper closed before its next line; stderr=${stderr}`)); };
      const onError = (error) => { cleanup(); reject(error); };
      lines.once('line', onLine);
      lines.once('close', onClose);
      child.once('error', onError);
      timer = setTimeout(() => {
        cleanup();
        reject(new Error(`helper output timed out; stderr=${stderr}`));
      }, timeoutMs);
    });
  }

  return { child, lines, closedPromise, nextLine, stderr: () => stderr, isClosed: () => closed };
}

async function stopChild(helper) {
  if (!helper.isClosed()) helper.child.kill('SIGKILL');
  let timer;
  await Promise.race([
    helper.closedPromise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`helper did not stop; stderr=${helper.stderr()}`)), 5_000);
    }),
  ]).finally(() => clearTimeout(timer));
  helper.lines.close();
}

function operatorPayload(store, adapter = 'interactive-operator') {
  return {
    workspace_id: store.workspaceId,
    source: { adapter },
    mode: 'implement',
    operations: ['cycle_verify'],
  };
}

test('read-only LocalStore inspection leaves a missing .codex directory absent', async (t) => {
  const { root, store } = await workspace(t);
  const controlDirectory = path.join(root, '.codex');

  assert.equal(existsSync(controlDirectory), false);
  store.file('current.json');
  assert.equal(store.current(), null);
  assert.equal(store.leaseStatus(), null);
  assert.equal(store.operation('inspect-request'), null);
  assert.equal(readConfig(store).configured, false);
  assert.equal(existsSync(controlDirectory), false);
});

test('two independent Node processes contend on one workspace lease after a barrier', async (t) => {
  const { root, store } = await workspace(t);
  const script = `
    import { LocalStore } from ${JSON.stringify(storeModuleUrl)};
    const store = new LocalStore(process.argv[1]);
    process.stdin.once('data', async () => {
      try {
        await store.withLease(async () => new Promise(resolve => setTimeout(resolve, 400)));
        process.stdout.write('LEASE_ACQUIRED\\n');
      } catch (error) {
        process.stdout.write(String(error.code ?? 'UNKNOWN_ERROR') + '\\n');
      }
    });
    process.stdout.write('READY\\n');
  `;
  const first = startLineProcess(['--input-type=module', '-e', script, root], root);
  const second = startLineProcess(['--input-type=module', '-e', script, root], root);

  try {
    assert.deepEqual(await Promise.all([first.nextLine(), second.nextLine()]), ['READY', 'READY']);
    first.child.stdin.end('go\n');
    second.child.stdin.end('go\n');
    const outcomes = await Promise.all([first.nextLine(), second.nextLine()]);
    assert.deepEqual([...outcomes].sort(), ['LEASE_ACQUIRED', 'LEASE_BUSY']);
    await Promise.all([first.closedPromise, second.closedPromise]);
    assert.equal(store.leaseStatus(), null);
  } finally {
    await Promise.all([stopChild(first), stopChild(second)]);
  }
});

test('archive summaries are content-addressed, API-immutable, and detect direct tampering', async (t) => {
  const { store } = await workspace(t);
  const payload = { check_id: 'lint', exit_code: 0, output_complete: true };
  const reference = store.archive('check-result', payload);
  const recordPath = `evidence/${reference.id}.json`;
  const archivedRecord = store.evidence(reference.id);

  assert.deepEqual(reference, {
    id: `check-result-${digest(payload)}`,
    digest: digest(payload),
    kind: 'check-result',
    schema_revision: 1,
  });
  assert.deepEqual(archivedRecord.payload, payload);
  assert.deepEqual(store.archive('check-result', payload), reference);

  const attemptedReplacement = { ...archivedRecord, payload: { ...payload, exit_code: 9 } };
  assert.throws(
    () => store.write(recordPath, attemptedReplacement, { immutable: true }),
    codeIs('STORE_UNAVAILABLE'),
  );
  assert.deepEqual(store.evidence(reference.id).payload, payload);

  for (const replacement of [attemptedReplacement, { ...archivedRecord, kind: 'outcome' }, { ...archivedRecord, schema_revision: 2 }, { ...archivedRecord, id: `outcome-${digest(payload)}` }]) {
    writeFileSync(store.file(recordPath), JSON.stringify(replacement), 'utf8');
    assert.throws(() => store.evidence(reference.id), codeIs('EVIDENCE_INVALID'));
    assert.throws(() => store.archive('check-result', payload), codeIs('EVIDENCE_INVALID'));
  }
});

test('a live or crashed lease is reported and never automatically removed', async (t) => {
  const { root, store } = await workspace(t);
  const script = `
    import { LocalStore } from ${JSON.stringify(storeModuleUrl)};
    const store = new LocalStore(process.argv[1]);
    await store.withLease(async () => {
      process.stdout.write('LOCK_HELD\\n');
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    });
  `;
  const holder = startLineProcess(['--input-type=module', '-e', script, root], root);

  try {
    assert.equal(await holder.nextLine(), 'LOCK_HELD');
    const liveStatus = store.leaseStatus();
    assert.equal(liveStatus.owner_alive, true);
    assert.equal(liveStatus.automatic_recovery, false);
    await assert.rejects(store.withLease(async () => {}), codeIs('LEASE_BUSY'));
    assert.equal(existsSync(store.lockFile), true);

    await stopChild(holder);
    assert.equal(existsSync(store.lockFile), true);
    assert.equal(store.leaseStatus().automatic_recovery, false);
  } finally {
    if (!holder.isClosed()) await stopChild(holder);
  }
});

test('a crash after persisting pending and an effect leaves both records without replay', async (t) => {
  const { root, store } = await workspace(t);
  const requestId = 'crash-pending-request';
  const marker = path.join(root, 'effect-marker.txt');
  const rawFacts = {
    launch_status: 'started',
    pid: 4321,
    terminal_observed: false,
    exit_code: null,
    signal: null,
    cancel_requested: false,
    timed_out: false,
    capture_error: null,
    cleanup_error: null,
    output_complete: false,
    stdout: 'effect started',
    stderr: '',
    passed: false,
  };
  const operation = { request_id: requestId, status: 'pending', runner_facts: rawFacts };
  const script = `
    import { appendFileSync } from 'node:fs';
    import { LocalStore } from ${JSON.stringify(storeModuleUrl)};
    const store = new LocalStore(process.argv[1]);
    await store.withLease(async () => {
      store.saveOperation(${JSON.stringify(operation)});
      appendFileSync(process.argv[2], 'x');
      process.stdout.write('PENDING_AND_EFFECT_SAVED\\n');
      setInterval(() => {}, 1_000);
      await new Promise(() => {});
    });
  `;
  const writer = startLineProcess(['--input-type=module', '-e', script, root, marker], root);

  try {
    assert.equal(await writer.nextLine(), 'PENDING_AND_EFFECT_SAVED');
    await stopChild(writer);
    assert.deepEqual(store.operation(requestId), operation);
    assert.equal(readFileSync(marker, 'utf8'), 'x');
    assert.equal(existsSync(store.lockFile), true);
    assert.equal(store.leaseStatus().automatic_recovery, false);
  } finally {
    if (!writer.isClosed()) await stopChild(writer);
  }
});

test('different request IDs retain separate operations and immutable runner facts', async (t) => {
  const { store } = await workspace(t);
  const firstFacts = {
    launch_status: 'started', terminal_observed: true, exit_code: null, signal: 'SIGTERM',
    capture_error: null, cleanup_error: null, output_complete: false, stdout: 'partial', passed: false,
  };
  const secondFacts = {
    launch_status: 'not_started', terminal_observed: false, exit_code: null, signal: null,
    capture_error: null, cleanup_error: null, output_complete: true, stdout: '', passed: false,
  };
  const firstReference = store.archive('runner-facts', firstFacts);
  const secondReference = store.archive('runner-facts', secondFacts);
  const firstOperation = { request_id: 'request-one', status: 'pending', runner_ref: firstReference.id };
  const secondOperation = { request_id: 'request-two', status: 'pending', runner_ref: secondReference.id };

  store.saveOperation(firstOperation);
  store.saveOperation(secondOperation);
  assert.deepEqual(store.operation('request-one'), firstOperation);
  assert.deepEqual(store.operation('request-two'), secondOperation);
  assert.notEqual(store.file(`operations/${sha256('request-one')}.json`), store.file(`operations/${sha256('request-two')}.json`));

  store.saveOperation({ ...store.operation('request-one'), status: 'settled' });
  assert.equal(store.operation('request-one').status, 'settled');
  assert.deepEqual(store.evidence(firstReference.id).payload, firstFacts);
  assert.deepEqual(store.evidence(secondReference.id).payload, secondFacts);
});

test('OperatorAuthority needs explicit adapter confirmation, and the fixture is not Host human proof', async (t) => {
  const { store } = await workspace(t);
  const authority = new OperatorAuthority(store);
  const payload = operatorPayload(store);
  const missingId = `grant-${digest(payload)}`;

  assert.throws(() => authority.load(missingId), codeIs('DECISION_UNVERIFIED'));
  assert.throws(() => authority.issue(payload), codeIs('DECISION_UNVERIFIED'));

  // This fixture simulates an explicit operator-adapter confirmation only; it does not prove a Host-authenticated human channel.
  const receipt = authority.issue(payload, { operatorConfirmed: true });
  assert.deepEqual(authority.load(receipt.id), receipt);
});

test('OperatorAuthority rejects payload and signature tampering', async (t) => {
  const { store } = await workspace(t);
  const authority = new OperatorAuthority(store);
  const payloadReceipt = authority.issue(operatorPayload(store), { operatorConfirmed: true });
  const payloadPath = store.file(`authority/${payloadReceipt.id}.json`);
  const changedPayload = { ...payloadReceipt, payload: { ...payloadReceipt.payload, operations: ['cycle_apply'] } };
  writeFileSync(payloadPath, JSON.stringify(changedPayload), 'utf8');
  assert.throws(() => authority.load(payloadReceipt.id), codeIs('DECISION_UNVERIFIED'));

  const signatureReceipt = authority.issue({ ...operatorPayload(store), mode: 'docs' }, { operatorConfirmed: true });
  const signaturePath = store.file(`authority/${signatureReceipt.id}.json`);
  const changedSignature = `${signatureReceipt.signature[0] === '0' ? '1' : '0'}${signatureReceipt.signature.slice(1)}`;
  writeFileSync(signaturePath, JSON.stringify({ ...signatureReceipt, signature: changedSignature }), 'utf8');
  assert.throws(() => authority.load(signatureReceipt.id), codeIs('DECISION_UNVERIFIED'));
});

test('user/imported sources and a copied grant from another workspace do not verify', async (t) => {
  const { store: firstStore } = await workspace(t, 'cycle-authority-one-');
  const { store: secondStore } = await workspace(t, 'cycle-authority-two-');
  const authority = new OperatorAuthority(firstStore);

  for (const adapter of ['user', 'imported']) {
    const receipt = authority.issue(operatorPayload(firstStore, adapter), { operatorConfirmed: true });
    assert.throws(() => authority.load(receipt.id), codeIs('DECISION_UNVERIFIED'));
  }

  assert.notEqual(firstStore.workspaceId, secondStore.workspaceId);
  const crossWorkspaceReceipt = authority.issue(operatorPayload(firstStore), { operatorConfirmed: true });
  secondStore.write('authority/key.json', firstStore.read('authority/key.json'), { immutable: true });
  secondStore.write(`authority/${crossWorkspaceReceipt.id}.json`, crossWorkspaceReceipt, { immutable: true });
  const secondAuthority = new OperatorAuthority(secondStore);
  assert.throws(() => secondAuthority.load(crossWorkspaceReceipt.id), codeIs('DECISION_UNVERIFIED'));
});
