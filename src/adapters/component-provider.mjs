import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/client/stdio';
import { digest, fault, sha256, REUSE_PROTOCOL, REPOSITORY_PROTOCOL, CycleError } from '../core/contracts.mjs';
import { killProcessTree } from '../local/check-runner.mjs';
import { discoveryAllows, readCapturedUtf8, assertRepositoryInventoryCurrent } from '../local/reuse-evidence.mjs';
import { implementationVerdictExclusions } from '../local/implementation-notes.mjs';
import { validateRepositoryQuery } from '../local/repository-reuse.mjs';

const TOOL_SET = ['sol_architecture_query', 'sol_read_file', 'sol_recall'];
const MAX_CAPTURE = 3 * 1024 * 1024;
const safeRelative = p => typeof p === 'string' && p.length > 0 && !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && p.split('/').every(s => s && s !== '..' && s !== '.');
const timeout = (ms, value) => { let timer; return { promise: new Promise(resolve => { timer = setTimeout(() => resolve(value), ms); }), stop: () => clearTimeout(timer) }; };

/** Preserve legacy cycle IDs; SoL hashes async native realpath (expands Windows 8.3). */
export async function providerWorkspaceIdentity(root) {
  const canonical = await fs.realpath(root);
  const [original, normalized] = await Promise.all([fs.stat(root), fs.stat(canonical)]);
  if (!original.isDirectory() || original.dev !== normalized.dev || original.ino !== normalized.ino) throw fault('PROVIDER_UNAVAILABLE','Provider workspace normalization changed physical identity.');
  return sha256(process.platform === 'win32' ? canonical.toLowerCase() : canonical);
}

async function regularBytes(file, limit) {
  const parent = path.dirname(file); let cursor = parent;
  while (true) { const stat = await fs.lstat(cursor); if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('PROVIDER_UNAVAILABLE', 'Provider location must use regular directories.'); const next = path.dirname(cursor); if (next === cursor) break; cursor = next; }
  const stat = await fs.lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw fault('PROVIDER_UNAVAILABLE', 'Provider input is not a bounded regular file.');
  const fd = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try { const opened = await fd.stat(); const bytes = await fd.readFile(); const after = await fs.lstat(file); if (opened.dev !== stat.dev || opened.ino !== stat.ino || after.dev !== opened.dev || after.ino !== opened.ino || bytes.length > limit || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw fault('PROVIDER_UNAVAILABLE', 'Provider input changed while reading.'); return bytes; }
  finally { await fd.close(); }
}

/** Hash fixed local distribution and executable; model arguments cannot launch a command. */
export async function providerIdentity(config, { verifyFiles = false } = {}) {
  try {
    const p = config.component_reuse.provider;
    if (!path.isAbsolute(p.manifest) || !path.isAbsolute(p.executable)) throw new Error('absolute paths required');
    const manifestBytes = await regularBytes(p.manifest, 4 * 1024 * 1024);
    if (sha256(manifestBytes) !== p.manifest_sha256) throw new Error('manifest drift');
    const manifest = JSON.parse(readCapturedUtf8(manifestBytes));
    const protocol = p.protocol ?? REUSE_PROTOCOL;
    if (![REUSE_PROTOCOL, REPOSITORY_PROTOCOL].includes(protocol) || manifest.schema_revision !== 1
      || !(manifest.protocol === protocol || manifest.protocols?.includes(protocol))
      || protocol === REPOSITORY_PROTOCOL && !manifest.modes?.includes('repository')
      || !safeRelative(manifest.entry) || !Array.isArray(manifest.files) || manifest.files.length > 20000) throw new Error('manifest contract');
    const packageRoot = path.dirname(p.manifest); const seen = new Set();
    for (const item of manifest.files) {
      if (!safeRelative(item.path) || seen.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('manifest path');
      seen.add(item.path);
    }
    if (!seen.has(manifest.entry) || !seen.has('package-lock.json')) throw new Error('incomplete package');
    if (verifyFiles) {
      // Independent pinned files can be checked together with a bounded number
      // of open descriptors. Every file still receives all regular-path checks.
      for (let start = 0; start < manifest.files.length; start += 8) {
        const results = await Promise.allSettled(manifest.files.slice(start, start + 8).map(async item => {
          const bytes = await regularBytes(path.join(packageRoot, item.path), 64 * 1024 * 1024);
          if (bytes.length !== item.bytes || sha256(bytes) !== item.sha256) throw new Error('package drift');
        }));
        const failed = results.find(result => result.status === 'rejected'); if (failed) throw failed.reason;
      }
      const actual = [];
      const visit = async (dir, prefix = '') => { for (const item of await fs.readdir(dir, { withFileTypes: true })) { const rel = prefix + item.name; if (item.isSymbolicLink()) throw new Error('package link'); if (item.isDirectory()) await visit(path.join(dir,item.name), rel + '/'); else if (item.isFile()) actual.push(rel); else throw new Error('package special file'); } };
      await visit(packageRoot);
      if (actual.some(p => p !== path.basename(config.component_reuse.provider.manifest) && !seen.has(p)) || actual.length !== seen.size + 1) throw new Error('unlisted distribution input');
    }
    const executable_sha256 = sha256(await regularBytes(p.executable, 256 * 1024 * 1024));
    return { identity: digest({ protocol, manifest_sha256: p.manifest_sha256, executable_sha256, args: p.args }), entry: path.join(packageRoot, manifest.entry), executable_sha256, manifest_sha256: p.manifest_sha256 };
  } catch (error) { throw fault('PROVIDER_UNAVAILABLE', 'Configured component provider distribution or executable cannot be verified.', { cause_code: typeof error.code === 'string' ? error.code : 'IDENTITY_INVALID' }); }
}

function toolValue(result) {
  let value;
  try { value = result.structuredContent ?? JSON.parse(result.content.find(c => c.type === 'text').text); }
  catch { throw fault('PROVIDER_UNAVAILABLE', 'Provider returned malformed data.'); }
  if (result.isError || value.tool_status === 'error') throw fault('PROVIDER_UNAVAILABLE', 'Provider operation did not produce complete evidence.', { provider_code: typeof value.error?.code === 'string' ? value.error.code : 'TOOL_FAILED' });
  return value;
}

async function recallAll(client, raw, options) {
  if (!raw?.complete || !Number.isSafeInteger(raw.bytes) || raw.bytes < 0 || raw.bytes > MAX_CAPTURE || !/^[a-f0-9]{64}$/.test(raw.sha256)) throw fault('EVIDENCE_INVALID', 'Provider raw capture is absent or exceeds the evidence budget.');
  if (raw.bytes === 0) { if (raw.sha256 !== sha256(Buffer.alloc(0))) throw fault('EVIDENCE_INVALID', 'Empty capture digest differs.'); return Buffer.alloc(0); }
  const selector = { kind: 'bytes', start: 0, end: raw.bytes }; let cursor; let offset = 0; const buffers = []; const cursors = new Set();
  do {
    const value = toolValue(await client.callTool({ name: 'sol_recall', arguments: { handle: raw.handle, selector, ...(cursor ? { cursor } : {}) } }, options));
    if (value.handle !== raw.handle || value.sha256 !== raw.sha256 || !Array.isArray(value.chunks)) throw fault('EVIDENCE_INVALID', 'Recall returned another observation.');
    for (const chunk of value.chunks) {
      const bytes = chunk.base64 !== undefined ? Buffer.from(chunk.base64, 'base64') : Buffer.from(chunk.text ?? '', 'utf8');
      if (chunk.start_byte !== offset || chunk.end_byte !== offset + bytes.length || !bytes.length || offset + bytes.length > raw.bytes) throw fault('EVIDENCE_INVALID', 'Recall byte range is incomplete or overlaps.');
      buffers.push(bytes); offset += bytes.length;
    }
    cursor = value.next_cursor;
    if (cursor && cursors.has(cursor)) throw fault('EVIDENCE_INVALID', 'Recall cursor made no progress.');
    if (cursor) cursors.add(cursor);
    if (!cursor && (value.truncated || offset !== raw.bytes)) throw fault('EVIDENCE_INVALID', 'Recall ended before complete evidence.');
  } while (cursor);
  const bytes = Buffer.concat(buffers); if (sha256(bytes) !== raw.sha256) throw fault('EVIDENCE_INVALID', 'Recall SHA differs from captured bytes.'); return bytes;
}

async function cacheInventory(root) {
  const entries = []; let total = 0;
  const visit = async (dir, prefix = '') => {
    for (const item of await fs.readdir(dir, { withFileTypes: true })) {
      const rel = prefix + item.name; const full = path.join(dir,item.name);
      if (item.isSymbolicLink()) throw fault('EVIDENCE_INVALID', 'Provider cache contains a link.');
      if (item.isDirectory()) await visit(full, rel + '/');
      else if (item.isFile()) { const bytes = await regularBytes(full, 8 * 1024 * 1024); total += bytes.length; if (total > 16 * 1024 * 1024 || entries.length >= 512) throw fault('EVIDENCE_INVALID', 'Provider cache exceeds bounded observation storage.'); entries.push({ path: rel, bytes: bytes.length, sha256: sha256(bytes) }); }
      else throw fault('EVIDENCE_INVALID', 'Provider cache contains a special file.');
    }
  }; await visit(root); return entries;
}

/** Official MCP protocol client; public transport callbacks observe real peer closure. */
export async function captureComponent({ store, workspace, state, config, args, operation, signal, onStarted }) {
  const policy = config.component_reuse; const verified = await providerIdentity(config, { verifyFiles: true });
  if (verified.identity !== state.provider_identity) throw fault('PROVIDER_UNAVAILABLE', 'Provider identity changed after begin.', { effects_known: true });
  const cacheRoot = store.ensureDirectory('provider-cache/' + operation.operation_id);
  const configFile = store.file('provider-cache/' + operation.operation_id + '/provider-config.json');
  const repository = policy.mode === 'repository';
  const excluded_paths = repository ? policy.documentation_paths : [];
  const excluded_sha256 = repository ? [...implementationVerdictExclusions(state.artifacts.I).hashes] : [];
  const scope_digest = digest(policy.discovery_scope);
  const exclusion_digest = digest({ excluded_paths, excluded_sha256 });
  const privateConfig = repository ? { protocol: REPOSITORY_PROTOCOL, mode: 'repository', workspace_root: await fs.realpath(store.root), workspace_id: state.provider_workspace_id,
    discovery_scope: policy.discovery_scope, scope_digest, budgets: policy.budgets, excluded_paths, excluded_sha256 }
    : { architecture_path: policy.architecture_path, discovery_scope: policy.discovery_scope };
  await fs.writeFile(configFile, JSON.stringify(privateConfig), { flag: 'wx' });
  const env = getDefaultEnvironment(); delete env.NODE_OPTIONS; delete env.CODEX_SOL_CONTEXT_RULES; delete env.CODEX_SOL_RULES;
  const delegate = new StdioClientTransport({ command: policy.provider.executable, args: [...policy.provider.args, verified.entry, '--workspace', store.root, '--config', configFile, '--cache-root', path.join(cacheRoot,'observations')], cwd: store.root, env, stderr: 'pipe', maxBufferSize: 8 * 1024 * 1024 });
  const receipt = { launch_status: 'not_started', pid: null, terminal_observed: false, cleanup_error: null, capture_error: null, timed_out: false, cancel_requested: false, request_completed: false, stderr_sha256: null };
  let resolveClosed; const closed = new Promise(resolve => { resolveClosed = resolve; }); const stderr = []; let stderrBytes = 0;
  const transport = {
    async start() { delegate.onmessage = message => transport.onmessage?.(message); delegate.onerror = error => transport.onerror?.(error); delegate.onclose = () => { receipt.terminal_observed = true; resolveClosed(); transport.onclose?.(); }; await delegate.start(); receipt.launch_status = 'started'; receipt.pid = delegate.pid; delegate.stderr?.on('data', bytes => { const kept = Buffer.from(bytes).subarray(0,Math.max(0,8192-stderrBytes)); if(kept.length){stderr.push(kept);stderrBytes+=kept.length;} }); await onStarted?.({ ...receipt }); },
    send: message => delegate.send(message), close: () => delegate.close(),
  };
  const client = new Client({ name: 'engineering-cycle-component-gateway', version: '0.1.0' }, { capabilities: {} });
  const abort = new AbortController(); let timer = setTimeout(() => { receipt.timed_out = true; abort.abort(); }, policy.provider.timeout_ms);
  const onAbort = () => { receipt.cancel_requested = true; abort.abort(); };
  signal?.addEventListener('abort', onAbort, { once: true }); if (signal?.aborted) onAbort();
  let data = null; let failure = null; let phase = 'launch';
  try {
    if (abort.signal.aborted) throw fault('INTERRUPTED','Component capture was cancelled before launch.');
    await client.connect(transport, { signal: abort.signal, timeout: policy.provider.timeout_ms });
    phase = 'handshake';
    const cap = client.getServerCapabilities()?.experimental?.['sol-component-discovery'];
    const declaration = repository ? null : await workspace.readSource(policy.architecture_path);
    const matching = {protocol:cap?.protocol===policy.provider.protocol,workspace_id:cap?.workspace_id===state.provider_workspace_id,product_write:cap?.product_write===false,observation_cache:cap?.observation_cache===true,
      ...(repository ? {mode:cap?.mode==='repository',scope_digest:cap?.scope_digest===scope_digest,exclusion_digest:cap?.exclusion_digest===exclusion_digest}
        : {declaration_path:cap?.declaration?.path===policy.architecture_path,declaration_sha256:cap?.declaration?.sha256===declaration.sha256})};
    if (Object.values(matching).some(v=>!v)) throw fault('PROVIDER_UNAVAILABLE', 'Provider capability handshake differs from the fixed workspace/distribution.',{matching});
    const options = { signal: abort.signal, timeout: policy.provider.timeout_ms };
    phase = 'tool-list'; const listed = await client.listTools({}, options);
    if (listed.nextCursor || JSON.stringify(listed.tools.map(t=>t.name).sort()) !== JSON.stringify([...TOOL_SET].sort())) throw fault('PROVIDER_UNAVAILABLE', 'Provider exposes a competing or unsupported tool surface.');
    const tool = args.action === 'discover' ? 'sol_architecture_query' : 'sol_read_file';
    const input = args.action === 'discover' ? args.query : { path: args.path };
    phase = 'query-read'; const value = toolValue(await client.callTool({ name: tool, arguments: input }, options));
    const raw = Array.isArray(value.observation?.raw) ? value.observation.raw[0] : Array.isArray(value.raw) ? value.raw[0] : value.raw;
    phase = 'recall'; const bytes = await recallAll(client, raw, options); const raw_text = readCapturedUtf8(bytes);
    data = { raw_text, raw_sha256: sha256(bytes), raw_bytes: bytes.length, source_capture_complete: true, provider_raw: raw, provider_identity: verified.identity,provider_workspace_id:state.provider_workspace_id,
      ...(repository ? {protocol:REPOSITORY_PROTOCOL,mode:'repository',scope_digest,exclusion_digest} : {}) };
    phase = 'source-identity'; if (args.action === 'discover') {
      const query = JSON.parse(raw_text);
        if (repository) {
          validateRepositoryQuery(query, { workspaceId: state.provider_workspace_id, scopeDigest: scope_digest });
          await assertRepositoryInventoryCurrent(workspace, query, policy);
        if (query.exclusion_digest !== exclusion_digest || query.versions.some(v=>excluded_paths.includes(v.path)||excluded_sha256.includes(v.sha256))) throw fault('SCOPE_DENIED','Repository query violated its fixed authority/verdict exclusion.');
      }
      if (query.protocol !== policy.provider.protocol || query.workspace_id !== state.provider_workspace_id || digest(query.query) !== digest(args.query) || !Array.isArray(query.versions) || query.versions.length > 256) throw fault('EVIDENCE_INVALID', 'Provider query identity or source manifest differs.');
      for (const e of query.versions) { if (!discoveryAllows(policy.discovery_scope,e.path)) throw fault('SCOPE_DENIED','Query input is outside read scope.'); let actual = null; try { actual = (await workspace.readSource(e.path)).sha256; } catch (error) { if(error.code !== 'SOURCE_UNAVAILABLE') throw error; } if (actual !== e.sha256) throw fault('REUSE_STALE','Query source changed while capturing.'); }
    } else {
      if (repository && (excluded_paths.includes(args.path) || excluded_sha256.includes(data.raw_sha256))) throw fault('SCOPE_DENIED', 'Repository read violated its fixed authority/verdict exclusion.');
      if ((await workspace.readSource(args.path)).sha256 !== data.raw_sha256) throw fault('REUSE_STALE', 'Read source changed during capture.');
    }
    receipt.request_completed = true;
  } catch (error) { failure = { code: typeof error.code === 'string' ? error.code : 'PROVIDER_UNAVAILABLE', message: error instanceof CycleError ? error.message : 'Component evidence capture did not complete.', failure_phase:phase,...(error instanceof CycleError ? {details:error.details} : {}) }; data = null; receipt.capture_error = failure.code; }
  finally {
    clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    try { await client.close(); await delegate.close(); } catch { receipt.cleanup_error = 'PROVIDER_CLOSE_FAILED'; }
    if (!receipt.terminal_observed && receipt.pid) {
      receipt.cleanup_error = await killProcessTree(receipt.pid) ?? receipt.cleanup_error;
      const wait = timeout(2000, false); try { await Promise.race([closed, wait.promise]); } finally { wait.stop(); }
      if (!receipt.terminal_observed) receipt.cleanup_error = 'PROVIDER_TERMINAL_UNKNOWN';
    }
    if (receipt.launch_status === 'not_started' && !receipt.pid) receipt.terminal_observed = true;
    receipt.stderr_sha256 = sha256(Buffer.concat(stderr));
  }
  let cache;
  try { if (!receipt.terminal_observed || receipt.cleanup_error) throw new Error('peer remains unknown'); cache = await cacheInventory(cacheRoot); }
  catch { receipt.cleanup_error ??= 'CACHE_EFFECTS_UNKNOWN'; }
  return { ok: Boolean(data && !receipt.cleanup_error && !receipt.cancel_requested && !receipt.timed_out), data, receipt, cache_inventory: cache ?? null, error: failure, effects_known: Boolean(cache && receipt.terminal_observed && !receipt.cleanup_error) };
}
