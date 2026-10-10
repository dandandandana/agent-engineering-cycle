import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fault, REPOSITORY_PROTOCOL, sha256 } from '../core/contracts.mjs';

export const STANDARD_PROFILE_ID = 'standard';
export const STANDARD_PROFILE_REVISION = 1;
export const DEFAULT_REPOSITORY_BUDGETS = Object.freeze({
  max_sources: 128,
  max_file_bytes: 262144,
  max_total_bytes: 1048576,
  timeout_ms: 30000,
});

const MANIFEST_LIMIT = 4 * 1024 * 1024;
const REGISTERED_PROTOCOL = 'sol-component-discovery/1';
const SUPPORTED_PROTOCOLS = [REGISTERED_PROTOCOL, REPOSITORY_PROTOCOL];
const SUPPORTED_MODES = ['registered', 'repository'];
const SAFE_RELATIVE = value => typeof value === 'string'
  && value.length > 0
  && !value.includes('\\')
  && !value.includes(':')
  && !value.startsWith('/')
  && value.split('/').every(part => part && part !== '.' && part !== '..');

function regularParents(file) {
  let cursor = path.dirname(path.resolve(file));
  while (true) {
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest parent is unavailable.', { io_code: error.code ?? 'IO_ERROR' });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest parents must be regular directories.');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) return true;
    cursor = parent;
  }
}

function readManifestBytes(file) {
  if (!regularParents(file)) return null;
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return null;
    throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest is unavailable.', { io_code: error.code ?? 'IO_ERROR' });
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MANIFEST_LIMIT) {
    throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest must be a bounded regular file.');
  }

  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest identity changed before it was read.');
    }
    const bytes = Buffer.alloc(MANIFEST_LIMIT + 1);
    const size = fs.readSync(fd, bytes, 0, bytes.length, 0);
    const after = fs.lstatSync(file);
    if (size > MANIFEST_LIMIT
      || after.isSymbolicLink()
      || !after.isFile()
      || after.dev !== opened.dev
      || after.ino !== opened.ino
      || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs
      || after.ctimeMs !== opened.ctimeMs) {
      throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest changed while it was read.');
    }
    return bytes.subarray(0, size);
  } catch (error) {
    if (error?.name === 'CycleError') throw error;
    throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest could not be read safely.', { io_code: error?.code ?? 'IO_ERROR' });
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function validateManifest(bytes) {
  let manifest;
  try { manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
  catch { throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest is not valid UTF-8 JSON.'); }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || manifest.schema_revision !== 1
    || manifest.protocol !== REGISTERED_PROTOCOL
    || !Array.isArray(manifest.protocols)
    || manifest.protocols.length !== SUPPORTED_PROTOCOLS.length
    || SUPPORTED_PROTOCOLS.some(protocol => !manifest.protocols.includes(protocol))
    || !Array.isArray(manifest.modes)
    || manifest.modes.length !== SUPPORTED_MODES.length
    || SUPPORTED_MODES.some(mode => !manifest.modes.includes(mode))
    || !SAFE_RELATIVE(manifest.entry)
    || !Array.isArray(manifest.files)
    || manifest.files.length > 20000) {
    throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest does not match the bundled repository protocol.');
  }
  const seen = new Set();
  for (const file of manifest.files) {
    if (!file || typeof file !== 'object' || Array.isArray(file)
      || !SAFE_RELATIVE(file.path)
      || seen.has(file.path)
      || !Number.isSafeInteger(file.bytes)
      || file.bytes < 0
      || !/^[a-f0-9]{64}$/.test(file.sha256 ?? '')) {
      throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest contains an invalid distribution entry.');
    }
    seen.add(file.path);
  }
  if (!seen.has(manifest.entry)) {
    throw fault('PROVIDER_UNAVAILABLE', 'Provider manifest entry is not listed in its distribution.');
  }
}

function bundledManifestPath() {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const pluginRoot = path.resolve(moduleDirectory, '../..');
  return path.join(pluginRoot, 'provider', 'provider-manifest.json');
}

/** Build the installed standard@1 defaults without creating or modifying files. */
export function createStandardProfile({ providerManifest } = {}) {
  const manifest = providerManifest === undefined ? bundledManifestPath() : providerManifest;
  if (typeof manifest !== 'string' || !path.isAbsolute(manifest)) {
    throw fault('EVIDENCE_INVALID', 'Provider manifest override must be an absolute non-model path.');
  }
  const manifestBytes = readManifestBytes(manifest);
  if (manifestBytes !== null) validateManifest(manifestBytes);

  return {
    schema_revision: 3,
    profile: STANDARD_PROFILE_ID,
    checks: [{ id: 'source-integrity', kind: 'source-integrity' }],
    qa: null,
    component_reuse: {
      required: true,
      mode: 'repository',
      protocol: REPOSITORY_PROTOCOL,
      discovery_scope: { roots: ['.'], files: [] },
      documentation_paths: [],
      budgets: { ...DEFAULT_REPOSITORY_BUDGETS },
      provider: {
        executable: process.execPath,
        args: [],
        manifest,
        manifest_sha256: manifestBytes === null ? null : sha256(manifestBytes),
        protocol: REPOSITORY_PROTOCOL,
        timeout_ms: 30000,
        available: manifestBytes !== null,
      },
    },
    missing_capabilities: manifestBytes === null ? ['component-provider'] : [],
  };
}
