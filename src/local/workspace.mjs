import { constants as fsConstants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  unlink,
} from 'node:fs/promises';
import {
  lstatSync,
  realpathSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { digest, fault, sha256 } from '../core/contracts.mjs';

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 256;
const MAX_TARGETS = 64;
const HEX_SHA256 = /^[a-f0-9]{64}$/iu;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const UTF8 = new TextDecoder('utf-8', { fatal: true });

function raise(code, message, details = {}) {
  throw fault(code, message, details);
}

function codeOf(error) {
  return typeof error?.code === 'string' ? error.code : 'OPERATION_FAILED';
}

function safeCause(error) {
  return {
    code: codeOf(error),
    message: typeof error?.message === 'string' ? error.message : String(error),
  };
}

function validateRelativePath(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096
    || value.startsWith('/') || value.startsWith('\\') || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value) || value.includes('\\') || value.includes(':')
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    raise('SCOPE_DENIED', 'A workspace path must be a safe, explicit relative path.', { path: value });
  }

  const segments = value.split('/');
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..'
    || segment.endsWith('.') || segment.endsWith(' '))) {
    raise('SCOPE_DENIED', 'A workspace path contains an unsafe segment.', { path: value });
  }

  for (const segment of segments) {
    const normalized = segment.toLowerCase();
    if (['.codex', '.git', 'node_modules', 'slop'].includes(normalized)) {
      raise('SCOPE_DENIED', 'Workspace control and generated directories are excluded.', { path: value, segment });
    }
    if ((normalized === '.env' || normalized.startsWith('.env.')) && normalized !== '.env.example') {
      raise('SCOPE_DENIED', 'Environment secret files are excluded from workspace inputs and writes.', { path: value });
    }
    if (/\.(?:pem|key|p8|p12|pfx|p7b|p7c|jks|keystore)$/iu.test(normalized)
      || /^(?:id_rsa|id_ed25519|id_ecdsa|id_dsa|private_key)$/iu.test(normalized)) {
      raise('SCOPE_DENIED', 'Private key and certificate material is excluded.', { path: value });
    }
    const deviceName = normalized.split('.')[0];
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/u.test(deviceName)) {
      raise('SCOPE_DENIED', 'A workspace path contains a reserved device name.', { path: value, segment });
    }
  }
  return { path: value, segments };
}

/** Platform path comparison only; physical identity and write authorization are checked separately. */
export function workspacePathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}
const compareKey = workspacePathKey;

async function relativeWithinRoot(rootStat, candidate) {
  let current = path.resolve(candidate);
  const segments = [];
  while (true) {
    let stat;
    try {
      stat = await lstat(current, { bigint: true });
    } catch {
      return null;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return null;
    if (isSameFile(rootStat, stat)) return segments;
    const parent = path.dirname(current);
    if (parent === current) return null;
    segments.unshift(path.basename(current));
    current = parent;
  }
}

async function isAllowedSnapshotLocation(rootStat, candidate) {
  const relative = await relativeWithinRoot(rootStat, candidate);
  if (relative === null) return true;
  const normalized = relative.join('/').toLowerCase();
  return normalized === '.codex/engineering-cycle/snapshots'
    || normalized.startsWith('.codex/engineering-cycle/snapshots/');
}

function isSameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileVersion(left, right) {
  return isSameFile(left, right) && left.size === right.size
    && left.mtimeNs === right.mtimeNs && left.ctimeNs === right.ctimeNs;
}

function modeOf(stat) {
  return Number(stat.mode & 0o777n);
}

function pathStatError(error, pathValue, code = 'SOURCE_UNAVAILABLE') {
  if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') {
    raise(code, 'A requested workspace file is unavailable.', { path: pathValue, reason: error.code });
  }
  raise(code, 'A requested workspace file could not be inspected.', { path: pathValue, reason: error?.code ?? 'unknown' });
}

function makeManifest(entries) {
  const sorted = [...entries].sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return { entries: sorted, digest: digest(sorted) };
}

function validatePathList(paths) {
  if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_FILES) {
    raise('SNAPSHOT_INCOMPLETE', `An explicit file list must contain 1 to ${MAX_FILES} paths.`, {
      count: Array.isArray(paths) ? paths.length : null,
      max_files: MAX_FILES,
    });
  }
  const seen = new Set();
  return paths.map((value) => {
    const parsed = validateRelativePath(value);
    const key = compareKey(parsed.path);
    if (seen.has(key)) raise('SCOPE_DENIED', 'A file may appear only once in an explicit path list.', { path: parsed.path });
    seen.add(key);
    return parsed;
  });
}

function assertUtf8(buffer, pathValue, code = 'SOURCE_UNAVAILABLE') {
  try {
    return UTF8.decode(buffer);
  } catch (error) {
    raise(code, 'A requested file is not valid UTF-8 text.', { path: pathValue, reason: error?.name ?? 'decode_error' });
  }
}

function factFromBuffer(pathValue, buffer) {
  return { path: pathValue, sha256: sha256(buffer), size: buffer.byteLength };
}

function publicFact(state) {
  if (!state.exists) return null;
  return {
    sha256: state.sha256,
    size: state.size,
    mode: process.platform === 'win32' ? null : state.mode,
  };
}

function statesEqual(left, right) {
  if (left.exists !== right.exists) return false;
  if (!left.exists) return true;
  return left.sha256 === right.sha256 && left.size === right.size
    && (process.platform === 'win32' || left.mode === right.mode);
}

function effectChanged(effect) {
  if (effect.before === null || effect.after === null) return effect.before !== effect.after;
  return effect.before.sha256 !== effect.after.sha256 || effect.before.size !== effect.after.size
    || (process.platform !== 'win32' && effect.before.mode !== effect.after.mode);
}

function validateManifestShape(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || !Array.isArray(manifest.entries) || manifest.entries.length === 0 || manifest.entries.length > MAX_FILES
    || typeof manifest.digest !== 'string' || !HEX_SHA256.test(manifest.digest)) {
    raise('SNAPSHOT_INCOMPLETE', 'The snapshot manifest is malformed.');
  }
  const seen = new Set();
  let total = 0;
  const entries = manifest.entries.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)
      || typeof entry.path !== 'string' || typeof entry.sha256 !== 'string' || !HEX_SHA256.test(entry.sha256)
      || !Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
      raise('SNAPSHOT_INCOMPLETE', 'The snapshot manifest contains an invalid entry.');
    }
    validateRelativePath(entry.path);
    const key = compareKey(entry.path);
    if (seen.has(key)) raise('SNAPSHOT_INCOMPLETE', 'The snapshot manifest contains duplicate paths.', { path: entry.path });
    seen.add(key);
    total += entry.size;
    if (total > MAX_TOTAL_BYTES) raise('SNAPSHOT_INCOMPLETE', 'The snapshot exceeds the total byte limit.', { total, max_total_bytes: MAX_TOTAL_BYTES });
    return { path: entry.path, sha256: entry.sha256.toLowerCase(), size: entry.size };
  });
  const canonical = makeManifest(entries);
  if (canonical.digest !== manifest.digest.toLowerCase()) {
    raise('SNAPSHOT_INCOMPLETE', 'The snapshot manifest digest does not match its entries.');
  }
  return canonical;
}

async function readFromRoot(root, segments, relative, { limitCode = 'SNAPSHOT_INCOMPLETE' } = {}) {
  let current = root;
  const beforeStats = [];
  let targetStat;
  for (let index = 0; index < segments.length; index += 1) {
    current = path.join(current, segments[index]);
    let stat;
    try {
      stat = await lstat(current, { bigint: true });
    } catch (error) {
      pathStatError(error, relative);
    }
    if (stat.isSymbolicLink()) {
      raise('SCOPE_DENIED', 'Symbolic links are not accepted in workspace paths.', { path: relative, segment: segments[index] });
    }
    if (index < segments.length - 1) {
      if (!stat.isDirectory()) raise('SOURCE_UNAVAILABLE', 'A workspace path ancestor is not a directory.', { path: relative, segment: segments[index] });
      beforeStats.push(stat);
      continue;
    }
    if (!stat.isFile()) raise('SOURCE_UNAVAILABLE', 'Only regular files can be read.', { path: relative });
    if (stat.size > BigInt(MAX_FILE_BYTES)) {
      raise(limitCode, 'A requested file exceeds the 1 MiB limit.', { path: relative, size: Number(stat.size), max_file_bytes: MAX_FILE_BYTES });
    }
    targetStat = stat;
  }

  const absolute = path.join(root, ...segments);
  let handle;
  let bytes;
  let openStat;
  let finalHandleStat;
  try {
    const flags = fsConstants.O_RDONLY | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
    handle = await open(absolute, flags);
    openStat = await handle.stat({ bigint: true });
    if (!openStat.isFile() || !isSameFile(targetStat, openStat)) {
      raise('SOURCE_UNAVAILABLE', 'The workspace file changed while it was being opened.', { path: relative });
    }
    bytes = await handle.readFile();
    finalHandleStat = await handle.stat({ bigint: true });
  } catch (error) {
    if (error?.code === 'SOURCE_UNAVAILABLE') throw error;
    raise('SOURCE_UNAVAILABLE', 'A requested workspace file could not be read.', { path: relative, reason: error?.code ?? error?.name ?? 'read_error' });
  } finally {
    await handle?.close().catch(() => {});
  }

  if (!sameFileVersion(openStat, finalHandleStat) || bytes.byteLength !== Number(targetStat.size)) {
    raise('SOURCE_UNAVAILABLE', 'The workspace file changed while it was being read.', { path: relative });
  }
  let currentAfter = root;
  for (let index = 0; index < segments.length; index += 1) {
    currentAfter = path.join(currentAfter, segments[index]);
    let after;
    try {
      after = await lstat(currentAfter, { bigint: true });
    } catch (error) {
      pathStatError(error, relative);
    }
    if (after.isSymbolicLink()) raise('SCOPE_DENIED', 'A symbolic link appeared during a workspace read.', { path: relative });
    if (index < segments.length - 1) {
      if (!after.isDirectory() || !isSameFile(beforeStats[index], after)) {
        raise('SOURCE_UNAVAILABLE', 'A workspace directory changed while a file was being read.', { path: relative });
      }
    } else if (!sameFileVersion(openStat, after)) {
      raise('SOURCE_UNAVAILABLE', 'The workspace file changed while it was being read.', { path: relative });
    }
  }

  const content = assertUtf8(bytes, relative);
  return {
    bytes,
    content,
    file_id: `${openStat.dev}:${openStat.ino}`,
    state: { exists: true, sha256: sha256(bytes), size: bytes.byteLength, mode: modeOf(openStat) },
  };
}

async function statPath(root, parsed, { allowMissing = false } = {}) {
  let current = root;
  for (let index = 0; index < parsed.segments.length; index += 1) {
    current = path.join(current, parsed.segments[index]);
    let stat;
    try {
      stat = await lstat(current, { bigint: true });
    } catch (error) {
      if (allowMissing && (error?.code === 'ENOENT' || error?.code === 'ENOTDIR')) {
        return { exists: false, missingAncestor: index < parsed.segments.length - 1, absolute: current };
      }
      pathStatError(error, parsed.path);
    }
    if (stat.isSymbolicLink()) raise('SCOPE_DENIED', 'Symbolic links are not accepted in workspace paths.', { path: parsed.path, segment: parsed.segments[index] });
    if (index < parsed.segments.length - 1) {
      if (!stat.isDirectory()) raise('SOURCE_UNAVAILABLE', 'A workspace path ancestor is not a directory.', { path: parsed.path, segment: parsed.segments[index] });
    } else if (!stat.isFile()) {
      raise('SOURCE_UNAVAILABLE', 'Only regular files may be modified.', { path: parsed.path });
    }
    if (index === parsed.segments.length - 1) return { exists: true, stat, absolute: current };
  }
  return { exists: false, missingAncestor: false, absolute: current };
}

async function readApplyState(root, parsed, target) {
  const statResult = await statPath(root, parsed, { allowMissing: true });
  if (!statResult.exists) {
    if (statResult.missingAncestor) {
      raise('SOURCE_UNAVAILABLE', 'A write target parent directory does not exist.', { path: parsed.path });
    }
    return { exists: false, sha256: null, size: 0, mode: null };
  }
  const file = await readFromRoot(root, parsed.segments, parsed.path, { limitCode: 'SCOPE_DENIED' });
  return file.state;
}

async function observeApplyState(root, parsed) {
  const statResult = await statPath(root, parsed, { allowMissing: true });
  if (!statResult.exists) {
    return statResult.missingAncestor
      ? { exists: false, sha256: null, size: 0, mode: null, missingAncestor: true }
      : { exists: false, sha256: null, size: 0, mode: null };
  }
  return (await readFromRoot(root, parsed.segments, parsed.path, { limitCode: 'SCOPE_DENIED' })).state;
}

async function writeAtomically(target, bytes, mode) {
  const parent = path.dirname(target);
  const temporary = path.join(parent, `.cycle-write-${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, 'wx', mode ?? 0o666);
    await handle.writeFile(bytes);
    if (mode !== undefined && process.platform !== 'win32') await handle.chmod(mode);
    await handle.sync();
    await handle.close();
    handle = null;
    await rename(temporary, target);
  } catch (error) {
    await handle?.close().catch(() => {});
    await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function listTreeFiles(inputDir) {
  const files = [];
  const directories = [];
  async function visit(directory, prefix) {
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const parsed = validateRelativePath(relative);
      const absolute = path.join(directory, entry.name);
      const stat = await lstat(absolute, { bigint: true });
      if (stat.isSymbolicLink()) raise('SNAPSHOT_INCOMPLETE', 'A symbolic link was found in the frozen snapshot.', { path: relative });
      if (stat.isDirectory()) {
        directories.push(relative);
        await visit(absolute, relative);
      } else if (stat.isFile()) {
        files.push({ parsed, stat });
        if (files.length > MAX_FILES) raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot exceeds the 256 file limit.', { max_files: MAX_FILES });
      } else {
        raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot contains an unsupported filesystem entry.', { path: relative });
      }
    }
  }
  await visit(inputDir, '');
  return {
    files: files.sort((left, right) => (left.parsed.path < right.parsed.path ? -1 : left.parsed.path > right.parsed.path ? 1 : 0)),
    directories,
  };
}

async function readSnapshotFile(inputDir, parsed) {
  const absolute = path.join(inputDir, ...parsed.segments);
  let before;
  try {
    before = await lstat(absolute, { bigint: true });
  } catch (error) {
    pathStatError(error, parsed.path, 'SNAPSHOT_INCOMPLETE');
  }
  if (before.isSymbolicLink() || !before.isFile()) raise('SNAPSHOT_INCOMPLETE', 'A frozen snapshot entry is not a regular file.', { path: parsed.path });
  if (before.size > BigInt(MAX_FILE_BYTES)) raise('SNAPSHOT_INCOMPLETE', 'A frozen snapshot file exceeds the 1 MiB limit.', { path: parsed.path });
  let bytes;
  try {
    bytes = await readFile(absolute);
  } catch (error) {
    raise('SNAPSHOT_INCOMPLETE', 'A frozen snapshot file could not be read.', { path: parsed.path, reason: error?.code ?? 'read_error' });
  }
  const after = await lstat(absolute, { bigint: true }).catch((error) => pathStatError(error, parsed.path, 'SNAPSHOT_INCOMPLETE'));
  if (!sameFileVersion(before, after) || bytes.byteLength !== Number(before.size)) {
    raise('SNAPSHOT_INCOMPLETE', 'A frozen snapshot file changed while it was verified.', { path: parsed.path });
  }
  assertUtf8(bytes, parsed.path, 'SNAPSHOT_INCOMPLETE');
  return bytes;
}

async function verifyInputContents(inputDir, expectedManifest) {
  const { files: actualFiles, directories: actualDirectories } = await listTreeFiles(inputDir);
  const expectedByPath = new Map(expectedManifest.entries.map((entry) => [compareKey(entry.path), entry]));
  if (actualFiles.length !== expectedByPath.size) {
    raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot file set no longer matches its manifest.', {
      expected_files: expectedByPath.size,
      actual_files: actualFiles.length,
    });
  }
  const expectedDirectories = new Set();
  for (const entry of expectedManifest.entries) {
    const segments = entry.path.split('/');
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join('/'));
    }
  }
  if (actualDirectories.length !== expectedDirectories.size
    || actualDirectories.some((directory) => !expectedDirectories.has(directory))) {
    raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot directory set no longer matches its manifest.', {
      expected_directories: expectedDirectories.size,
      actual_directories: actualDirectories.length,
    });
  }
  const actualEntries = [];
  let total = 0;
  for (const file of actualFiles) {
    const expected = expectedByPath.get(compareKey(file.parsed.path));
    if (!expected || expected.path !== file.parsed.path) {
      raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot contains an unexpected file.', { path: file.parsed.path });
    }
    const bytes = await readSnapshotFile(inputDir, file.parsed);
    total += bytes.byteLength;
    if (total > MAX_TOTAL_BYTES) raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot exceeds the 16 MiB limit.', { max_total_bytes: MAX_TOTAL_BYTES });
    const entry = factFromBuffer(file.parsed.path, bytes);
    if (entry.sha256 !== expected.sha256 || entry.size !== expected.size) {
      raise('SNAPSHOT_INCOMPLETE', 'Frozen snapshot bytes do not match the manifest.', { path: file.parsed.path });
    }
    actualEntries.push(entry);
  }
  return makeManifest(actualEntries);
}

async function freezeTree(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    const stat = await lstat(absolute, { bigint: true });
    if (stat.isSymbolicLink()) raise('SNAPSHOT_INCOMPLETE', 'A symbolic link appeared while publishing the frozen snapshot.', { path: absolute });
    if (stat.isDirectory()) await freezeTree(absolute);
    else if (!stat.isFile()) raise('SNAPSHOT_INCOMPLETE', 'An unsupported entry appeared while publishing the snapshot.', { path: absolute });
    await chmod(absolute, stat.isDirectory() ? 0o555 : 0o444);
  }
  await chmod(directory, 0o555);
}

async function makeWritableForCleanup(directory) {
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await chmod(absolute, 0o755).catch(() => {});
      await makeWritableForCleanup(absolute);
    } else {
      await chmod(absolute, 0o644).catch(() => {});
    }
  }
  await chmod(directory, 0o755).catch(() => {});
}

/** Retry only an unpublished, verified snapshot tree. Persistent denials remain failures; QA launch is outside this operation. */
async function publishSnapshotDirectory(staging, published, manifest) {
  const attempts = process.platform === 'win32' ? 3 : 1;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { await rename(staging, published); return; }
    catch (error) {
      if (attempt + 1 === attempts || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      const target = await lstat(published).catch(e => { if (e.code === 'ENOENT') return null; throw e; });
      const source = await lstat(staging);
      if (target || !source.isDirectory() || source.isSymbolicLink()) throw error;
      await verifyInputContents(path.join(staging, 'input'), manifest);
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

export class WorkspaceAdapter {
  #rootStat;

  constructor(root) {
    if (typeof root !== 'string' || root.trim() === '') {
      raise('SOURCE_UNAVAILABLE', 'A real workspace root directory is required.');
    }
    const absolute = path.resolve(root);
    let suppliedStat;
    let canonical;
    let canonicalStat;
    try {
      suppliedStat = lstatSync(absolute, { bigint: true });
      canonical = realpathSync(absolute);
      canonicalStat = lstatSync(canonical, { bigint: true });
    } catch (error) {
      raise('SOURCE_UNAVAILABLE', 'The workspace root does not exist or cannot be resolved.', { reason: error?.code ?? error?.name ?? 'root_error' });
    }
    if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory() || canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory()) {
      raise('SCOPE_DENIED', 'The workspace root must be a real directory, not a symbolic link or file.', { root: absolute });
    }
    const idPath = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    Object.defineProperties(this, {
      root: { value: canonical, enumerable: true, writable: false, configurable: false },
      workspaceId: { value: digest(idPath), enumerable: true, writable: false, configurable: false },
    });
    this.#rootStat = canonicalStat;
  }

  async #assertRoot() {
    let current;
    try {
      current = await lstat(this.root, { bigint: true });
    } catch (error) {
      pathStatError(error, this.root);
    }
    if (!current.isDirectory() || current.isSymbolicLink() || !isSameFile(this.#rootStat, current)) {
      raise('SOURCE_UNAVAILABLE', 'The workspace root changed after this adapter was created.', { workspace_id: this.workspaceId });
    }
  }

  async #capture(paths) {
    await this.#assertRoot();
    const parsedPaths = validatePathList(paths);
    const captured = [];
    let total = 0;
    for (const parsed of parsedPaths) {
      const result = await readFromRoot(this.root, parsed.segments, parsed.path);
      total += result.bytes.byteLength;
      if (total > MAX_TOTAL_BYTES) {
        raise('SNAPSHOT_INCOMPLETE', 'The explicit input set exceeds the 16 MiB limit.', {
          total_bytes: total,
          max_total_bytes: MAX_TOTAL_BYTES,
        });
      }
      captured.push({ entry: factFromBuffer(parsed.path, result.bytes), bytes: result.bytes });
    }
    await this.#assertRoot();
    return captured;
  }

  async readManifest(paths) {
    const captured = await this.#capture(paths);
    return makeManifest(captured.map(({ entry }) => entry));
  }

  async readSource(pathValue) {
    await this.#assertRoot();
    const parsed = validateRelativePath(pathValue);
    const result = await readFromRoot(this.root, parsed.segments, parsed.path);
    await this.#assertRoot();
    return { path: parsed.path, sha256: result.state.sha256, size: result.state.size, content: result.content, file_id: result.file_id };
  }

  async snapshot(paths, destination) {
    const captured = await this.#capture(paths);
    if (typeof destination !== 'string' || destination.trim() === '') {
      raise('SNAPSHOT_INCOMPLETE', 'A destination directory is required for the frozen snapshot.');
    }
    const destinationAbsolute = path.resolve(destination);
    let destinationStat;
    let destinationReal;
    try {
      destinationStat = await lstat(destinationAbsolute, { bigint: true });
      destinationReal = await realpath(destinationAbsolute);
    } catch (error) {
      raise('SNAPSHOT_INCOMPLETE', 'The snapshot destination must be an existing real directory.', { reason: error?.code ?? 'destination_error' });
    }
    if (!destinationStat.isDirectory() || destinationStat.isSymbolicLink()) {
      raise('SNAPSHOT_INCOMPLETE', 'The snapshot destination must be a real directory.', { destination: destinationAbsolute });
    }
    if (!await isAllowedSnapshotLocation(this.#rootStat, destinationReal)) {
      raise('SCOPE_DENIED', 'Workspace snapshots may be stored only in the engineering-cycle snapshot directory.', { destination: destinationReal });
    }

    const snapshotId = randomUUID();
    const stagingRoot = path.join(destinationReal, `.cycle-snapshot-${snapshotId}.partial`);
    const publishedRoot = path.join(destinationReal, snapshotId);
    const inputDir = path.join(stagingRoot, 'input');
    const manifest = makeManifest(captured.map(({ entry }) => entry));
    let phase = 'create';
    try {
      await mkdir(stagingRoot);
      await mkdir(inputDir);
      for (const { entry, bytes } of captured) {
        const parsed = validateRelativePath(entry.path);
        const target = path.join(inputDir, ...parsed.segments);
        await mkdir(path.dirname(target), { recursive: true });
        await writeFileExclusive(target, bytes);
      }
      phase = 'verify-input';
      await verifyInputContents(inputDir, manifest);
      phase = 'freeze-input';
      await freezeTree(inputDir);
      await chmod(stagingRoot, 0o555);
      phase = 'verify-frozen-input';
      await verifyInputContents(inputDir, manifest);
      phase = 'publish';
      await publishSnapshotDirectory(stagingRoot, publishedRoot, manifest);
      const sealedManifest = Object.freeze({
        entries: Object.freeze(manifest.entries.map((entry) => Object.freeze({ ...entry }))),
        digest: manifest.digest,
      });
      const result = Object.freeze({
        snapshot_id: snapshotId,
        input_dir: path.join(publishedRoot, 'input'),
        manifest: sealedManifest,
      });
      return result;
    } catch (error) {
      await makeWritableForCleanup(stagingRoot);
      await rm(stagingRoot, { recursive: true, force: true }).catch(() => {});
      if (error?.code === 'SNAPSHOT_INCOMPLETE' || error?.code === 'SCOPE_DENIED') throw error;
      raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot could not be published.', {
        snapshot_id: snapshotId,
        phase,
        reason: error?.code ?? error?.name ?? 'snapshot_error',
      });
    }
  }

  async verifySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)
      || typeof snapshot.snapshot_id !== 'string' || !UUID.test(snapshot.snapshot_id)
      || typeof snapshot.input_dir !== 'string') {
      raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot reference is malformed.');
    }
    const manifest = validateManifestShape(snapshot.manifest);
    const inputDir = path.resolve(snapshot.input_dir);
    const snapshotRoot = path.dirname(inputDir);
    if (path.basename(inputDir) !== 'input' || path.basename(snapshotRoot) !== snapshot.snapshot_id
      || !await isAllowedSnapshotLocation(this.#rootStat, inputDir)) {
      raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot reference points outside its published directory.');
    }
    let rootStat;
    let inputStat;
    try {
      rootStat = await lstat(snapshotRoot, { bigint: true });
      inputStat = await lstat(inputDir, { bigint: true });
    } catch (error) {
      pathStatError(error, snapshot.input_dir, 'SNAPSHOT_INCOMPLETE');
    }
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !inputStat.isDirectory() || inputStat.isSymbolicLink()) {
      raise('SNAPSHOT_INCOMPLETE', 'The frozen snapshot directory is not a real directory.');
    }
    const rootReal = await realpath(snapshotRoot).catch((error) => pathStatError(error, snapshot.input_dir, 'SNAPSHOT_INCOMPLETE'));
    const inputReal = await realpath(inputDir).catch((error) => pathStatError(error, snapshot.input_dir, 'SNAPSHOT_INCOMPLETE'));
    if (rootReal !== snapshotRoot || inputReal !== inputDir) {
      raise('SNAPSHOT_INCOMPLETE', 'A symbolic link was found in the frozen snapshot path.');
    }
    const actualManifest = await verifyInputContents(inputDir, manifest);
    return { valid: true, manifest: actualManifest };
  }

  async apply(targets, { signal, onEffect, createParents = false } = {}) {
    if (!Array.isArray(targets) || targets.length === 0 || targets.length > MAX_TARGETS) {
      raise('SCOPE_DENIED', `An apply request must contain 1 to ${MAX_TARGETS} explicit targets.`, {
        count: Array.isArray(targets) ? targets.length : null,
        max_targets: MAX_TARGETS,
      });
    }
    if (onEffect !== undefined && typeof onEffect !== 'function') {
      raise('SCOPE_DENIED', 'onEffect must be an async function when supplied.');
    }

    const seen = new Set();
    const plan = [];
    let totalWriteBytes = 0;
    for (const target of targets) {
      if (!target || typeof target !== 'object' || Array.isArray(target)
        || !['write', 'delete'].includes(target.action)
        || !(target.expected_sha256 === null || (typeof target.expected_sha256 === 'string' && HEX_SHA256.test(target.expected_sha256)))) {
        raise('SCOPE_DENIED', 'Each apply target needs an explicit path, action, and expected SHA-256 or null.');
      }
      const parsed = validateRelativePath(target.path);
      const key = compareKey(parsed.path);
      if (seen.has(key)) raise('SCOPE_DENIED', 'An apply request may target each path only once.', { path: parsed.path });
      seen.add(key);
      if (target.action === 'write') {
        if (typeof target.content !== 'string') raise('SCOPE_DENIED', 'A write target needs UTF-8 string content.', { path: parsed.path });
        const bytes = Buffer.from(target.content, 'utf8');
        if (assertUtf8(bytes, parsed.path) !== target.content) {
          raise('SCOPE_DENIED', 'Write content must be representable as valid UTF-8.', { path: parsed.path });
        }
        if (bytes.byteLength > MAX_FILE_BYTES) raise('SCOPE_DENIED', 'A write target exceeds the 1 MiB file limit.', { path: parsed.path });
        totalWriteBytes += bytes.byteLength;
        if (totalWriteBytes > MAX_TOTAL_BYTES) raise('SCOPE_DENIED', 'The apply request exceeds the 16 MiB total write limit.');
        plan.push({ parsed, action: target.action, expected: target.expected_sha256?.toLowerCase() ?? null, bytes, afterSha: sha256(bytes), afterSize: bytes.byteLength });
      } else {
        if (Object.hasOwn(target, 'content')) raise('SCOPE_DENIED', 'A delete target cannot include content.', { path: parsed.path });
        plan.push({ parsed, action: target.action, expected: target.expected_sha256?.toLowerCase() ?? null, bytes: null, afterSha: null, afterSize: 0 });
      }
      const allowedKeys = target.action === 'write' ? ['path', 'action', 'expected_sha256', 'content'] : ['path', 'action', 'expected_sha256'];
      if (Object.keys(target).some((keyName) => !allowedKeys.includes(keyName))) {
        raise('SCOPE_DENIED', 'An apply target contains unsupported fields.', { path: parsed.path });
      }
    }

    await this.#assertRoot();
    let totalBeforeBytes = 0;
    for (const item of plan) {
      const observed = createParents ? await observeApplyState(this.root, item.parsed) : await readApplyState(this.root, item.parsed, item);
      if (observed.missingAncestor && (item.action !== 'write' || item.expected !== null)) {
        raise('SOURCE_UNAVAILABLE', 'Only a new write may create its missing parent directories.', { path: item.parsed.path });
      }
      const { missingAncestor, ...before } = observed;
      totalBeforeBytes += before.exists ? before.size : 0;
      if (totalBeforeBytes > MAX_TOTAL_BYTES) raise('SCOPE_DENIED', 'The apply request exceeds the 16 MiB total preflight read limit.');
      if (before.exists !== (item.expected !== null) || (before.exists && before.sha256 !== item.expected)) {
        raise('BINDING_STALE', 'An apply target no longer matches its expected pre-state.', {
          path: item.parsed.path,
          expected_sha256: item.expected,
          actual_sha256: before.exists ? before.sha256 : null,
          effects_known: true,
          changed_paths: [],
          effects: [],
        });
      }
      item.before = before;
    }

    const effects = [];
    const changedPaths = [];
    let currentPath = null;
    let currentKnown = true;
    const partial = (error, uncertain = false, extra = {}) => {
      const details = {
        effects_known: !uncertain,
        changed_paths: [...changedPaths],
        effects: [...effects],
        ...extra,
        cause: safeCause(error),
        ...(error?.details && typeof error.details === 'object' ? { cause_details: error.details } : {}),
      };
      const code = effects.length > 0 || uncertain ? 'OPERATION_PARTIAL' : codeOf(error);
      throw fault(code, effects.length > 0 || uncertain ? 'The apply operation stopped after a partial or uncertain effect.' : (error?.message ?? 'The apply operation failed.'), details);
    };

    // Every file pre-state is validated before the first directory or file effect.
    // Create only the exact target's ancestors, one at a time; never follow links.
    const ensureParents = async item => {
      let absolute = this.root;
      for (let index = 0; index < item.parsed.segments.length - 1; index++) {
        const relative = item.parsed.segments.slice(0, index + 1).join('/');
        absolute = path.join(absolute, item.parsed.segments[index]);
        if (signal?.aborted) partial(fault('OPERATION_FAILED', 'The apply operation was interrupted before creating a parent.'));
        let before;
        try {
          await this.#assertRoot();
          before = await lstat(absolute, { bigint: true }).catch(error => {
            if (error.code === 'ENOENT') return null;
            throw error;
          });
          if (before) {
            if (before.isSymbolicLink() || !before.isDirectory()) raise('SCOPE_DENIED', 'A target parent must be a regular directory.', { path: relative });
            if (compareKey(await realpath(absolute)) !== compareKey(path.join(await realpath(this.root), ...relative.split('/')))) raise('SCOPE_DENIED', 'A target parent resolves through an alias.', { path: relative });
            continue;
          }
        } catch (error) { partial(error, effects.length > 0, { conflict_path: relative }); }
        try { await mkdir(absolute); }
        catch (error) { partial(error, false, { conflict_path: relative }); }
        let after;
        try {
          await this.#assertRoot();
          after = await lstat(absolute, { bigint: true });
          if (after.isSymbolicLink() || !after.isDirectory() || compareKey(await realpath(absolute)) !== compareKey(path.join(await realpath(this.root), ...relative.split('/')))) {
            raise('AUTHORITY_CONFLICT', 'A created target parent changed before it was observed.', { path: relative });
          }
        } catch (error) { partial(error, true, { uncertain_path: relative }); }
        const effect = { kind: 'directory', action: 'mkdir', path: relative, parent_of: item.parsed.path,
          before: null, after: { kind: 'directory', file_id: `${after.dev}:${after.ino}` } };
        effects.push(effect); changedPaths.push(relative);
        if (onEffect) {
          try { await onEffect(effect); }
          catch (error) { partial(error, false, { persisted_effect_path: relative }); }
        }
      }
    };

    for (const item of plan) {
      if (signal?.aborted) {
        partial(fault('OPERATION_FAILED', 'The apply operation was interrupted before the next target.'));
      }
      try {
        await this.#assertRoot();
      } catch (error) {
        partial(error, effects.length > 0, effects.length > 0 ? { uncertain_path: item.parsed.path } : {});
      }
      if (createParents && item.action === 'write') await ensureParents(item);
      currentPath = item.parsed.path;
      currentKnown = true;
      let actualBefore;
      try {
        actualBefore = await observeApplyState(this.root, item.parsed);
      } catch (error) {
        partial(error, false, { conflict_path: currentPath });
      }
      if (actualBefore.missingAncestor || !statesEqual(item.before, actualBefore)) {
        partial(fault('AUTHORITY_CONFLICT', 'An apply target changed after preflight.', {
          path: currentPath,
          expected_before: publicFact(item.before),
          actual_before: publicFact(actualBefore),
        }), false, { conflict_path: currentPath });
      }

      try {
        const isNoop = item.action === 'write'
          ? actualBefore.exists && actualBefore.sha256 === item.afterSha && actualBefore.size === item.afterSize
          : !actualBefore.exists;
        let mutationAttempted = false;
        if (!isNoop) {
          mutationAttempted = true;
          if (item.action === 'write') await writeAtomically(path.join(this.root, ...item.parsed.segments), item.bytes, actualBefore.exists ? actualBefore.mode : undefined);
          else await unlink(path.join(this.root, ...item.parsed.segments));
        }
        try {
          await this.#assertRoot();
        } catch (error) {
          partial(error, mutationAttempted || effects.length > 0, { uncertain_path: currentPath });
        }
        const actualAfter = await observeApplyState(this.root, item.parsed);
        if (actualAfter.missingAncestor) {
          partial(fault('AUTHORITY_CONFLICT', 'An apply target parent disappeared during the operation.'), true, { uncertain_path: currentPath });
        }
        if (isNoop && !statesEqual(actualBefore, actualAfter)) {
          partial(fault('AUTHORITY_CONFLICT', 'An apply target changed while a no-op was being confirmed.', {
            path: currentPath,
            expected_after: publicFact(actualBefore),
            actual_after: publicFact(actualAfter),
          }), false, { conflict_path: currentPath });
        }
        const effect = { path: currentPath, before: publicFact(actualBefore), after: publicFact(actualAfter) };
        effects.push(effect);
        if (effectChanged(effect)) changedPaths.push(currentPath);
        if (onEffect) {
          try {
            await onEffect(effect);
          } catch (error) {
            partial(error, false, { persisted_effect_path: currentPath });
          }
        }
        const intended = item.action === 'write'
          ? actualAfter.exists && actualAfter.sha256 === item.afterSha && actualAfter.size === item.afterSize
            && (!actualBefore.exists || process.platform === 'win32' || actualAfter.mode === actualBefore.mode)
          : !actualAfter.exists;
        if (!intended) {
          partial(fault('AUTHORITY_CONFLICT', 'An apply target reached an unexpected post-state.', {
            path: currentPath,
            expected_after: item.action === 'write' ? { sha256: item.afterSha, size: item.afterSize } : null,
            actual_after: publicFact(actualAfter),
          }), false, { conflict_path: currentPath });
        }
      } catch (error) {
        if (error?.code === 'OPERATION_PARTIAL' || error?.code === 'AUTHORITY_CONFLICT') throw error;
        let actualAfter;
        try {
          actualAfter = await observeApplyState(this.root, item.parsed);
        } catch {
          currentKnown = false;
        }
        if (!currentKnown || actualAfter?.missingAncestor) {
          partial(error, true, { uncertain_path: currentPath });
        }
        if (!statesEqual(actualBefore, actualAfter)) {
          const effect = { path: currentPath, before: publicFact(actualBefore), after: publicFact(actualAfter) };
          effects.push(effect);
          if (effectChanged(effect)) changedPaths.push(currentPath);
          if (onEffect) {
            try { await onEffect(effect); } catch (persistError) { partial(persistError, false, { persisted_effect_path: currentPath }); }
          }
        }
        partial(error);
      }
    }

    return { effects_known: true, changed_paths: changedPaths, effects };
  }
}

async function writeFileExclusive(target, bytes) {
  const handle = await open(target, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
