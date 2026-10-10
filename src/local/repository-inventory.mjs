import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import { digest, fault } from '../core/contracts.mjs';
import { workspacePathKey } from './workspace.mjs';

// Keep only the provider's control/generated/credential directory skip policy here;
// source classification, parsing, and candidate discovery remain provider-owned.
const MAX_PATH_ITEMS = 8192;
const MAX_SCOPE_ROOTS = 64;
const MAX_SCOPE_FILES = 256;
const CONTROL_AND_GENERATED_DIRECTORIES = new Set([
  '.git', '.codex', '.hg', '.svn', 'node_modules', 'slop', '.cache', 'cache', 'build', 'dist', 'out', 'target',
  'coverage', '.next', '.nuxt', '.turbo', '.vite', '.pytest_cache', '.mypy_cache', '.ruff_cache', '__pycache__',
]);
const SECRET_DIRECTORIES = new Set(['.aws', '.azure', '.docker', '.gnupg', '.kube', '.ssh', 'keyrings']);
const key = workspacePathKey;
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;
const isSameFile = (left, right) => left.dev === right.dev && left.ino === right.ino;

function fail(code, message, details = {}) {
  throw fault(code, message, details);
}

function validateRelativePath(value, field, { allowRoot = false } = {}) {
  if (allowRoot && value === '.') return [];
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.startsWith('/') || value.startsWith('\\') || path.posix.isAbsolute(value)
    || path.win32.isAbsolute(value) || value.includes('\\') || value.includes(':')
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('SCOPE_DENIED', 'Repository inventory paths must be safe workspace-relative paths.', { field });
  }
  const segments = value.split('/');
  if (segments.some(segment => segment.length === 0 || segment === '.' || segment === '..'
    || segment.endsWith('.') || segment.endsWith(' ')
    || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(segment))) {
    fail('SCOPE_DENIED', 'Repository inventory paths contain an unsafe segment.', { field });
  }
  return segments;
}

function validateScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)
    || Object.keys(scope).some(name => !['roots', 'files'].includes(name))
    || !Array.isArray(scope.roots) || !Array.isArray(scope.files)
    || scope.roots.length > MAX_SCOPE_ROOTS || scope.files.length > MAX_SCOPE_FILES
    || scope.roots.length + scope.files.length === 0) {
    fail('SCOPE_DENIED', 'Repository inventory needs a bounded explicit roots/files scope.');
  }
  const normalizeList = (values, field, allowRoot = false) => {
    const seen = new Set();
    const result = values.map((value, index) => {
      const segments = validateRelativePath(value, `${field}.${index}`, { allowRoot });
      const pathValue = value;
      const pathKey = key(pathValue);
      if (seen.has(pathKey)) fail('SCOPE_DENIED', 'Repository inventory scope paths must be unique.', { field, path: pathValue });
      seen.add(pathKey);
      return { path: pathValue, segments };
    });
    return result.sort((left, right) => lexical(left.path, right.path));
  };
  return {
    roots: normalizeList(scope.roots, 'scope.roots', true),
    files: normalizeList(scope.files, 'scope.files'),
  };
}

function validateSkippedDirectories(values) {
  if (!Array.isArray(values) || values.length > MAX_PATH_ITEMS) {
    fail('EVIDENCE_INVALID', 'Captured skipped directories must be a bounded path list.');
  }
  const seen = new Set();
  return values.map((value, index) => {
    validateRelativePath(value, `skippedDirectories.${index}`);
    const pathKey = key(value);
    if (seen.has(pathKey)) fail('EVIDENCE_INVALID', 'Captured skipped-directory paths must be unique.', { path: value });
    seen.add(pathKey);
    return pathKey;
  });
}

function isPolicySkippedDirectory(relative, extraSkippedKeys) {
  if (extraSkippedKeys.has(key(relative))) return true;
  return relative.split('/').some(segment => {
    const normalized = segment.toLowerCase();
    return CONTROL_AND_GENERATED_DIRECTORIES.has(normalized) || SECRET_DIRECTORIES.has(normalized);
  });
}

function ioFailure(error, relative, operation) {
  fail('SOURCE_UNAVAILABLE', 'Repository path inventory is incomplete.', {
    path: relative || '.', operation, reason: error?.code ?? error?.name ?? 'io_error',
  });
}

async function rootSnapshot(workspaceRoot) {
  if (typeof workspaceRoot !== 'string' || workspaceRoot.trim() === '') {
    fail('SOURCE_UNAVAILABLE', 'A real workspace root is required for path inventory.');
  }
  const supplied = path.resolve(workspaceRoot);
  let suppliedStat;
  let canonical;
  let canonicalStat;
  try {
    suppliedStat = await lstat(supplied, { bigint: true });
  } catch (error) {
    ioFailure(error, '.', 'root_identity');
  }
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()) {
    fail('SCOPE_DENIED', 'The repository workspace root must be a real directory.');
  }
  try {
    canonical = await realpath(supplied);
    canonicalStat = await lstat(canonical, { bigint: true });
  } catch (error) {
    ioFailure(error, '.', 'root_identity');
  }
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()
    || canonicalStat.isSymbolicLink() || !canonicalStat.isDirectory() || !isSameFile(suppliedStat, canonicalStat)) {
    fail('SCOPE_DENIED', 'The repository workspace root must be a real directory.');
  }
  return { supplied, canonical, stat: canonicalStat };
}

async function assertRootUnchanged(snapshot) {
  let suppliedStat;
  let canonical;
  let canonicalStat;
  try {
    suppliedStat = await lstat(snapshot.supplied, { bigint: true });
  } catch (error) {
    ioFailure(error, '.', 'root_identity');
  }
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory()) {
    fail('SOURCE_UNAVAILABLE', 'The repository workspace root changed during path inventory.');
  }
  try {
    canonical = await realpath(snapshot.supplied);
    canonicalStat = await lstat(canonical, { bigint: true });
  } catch (error) {
    ioFailure(error, '.', 'root_identity');
  }
  if (suppliedStat.isSymbolicLink() || !suppliedStat.isDirectory() || canonicalStat.isSymbolicLink()
    || !canonicalStat.isDirectory() || key(canonical) !== key(snapshot.canonical)
    || !isSameFile(snapshot.stat, suppliedStat) || !isSameFile(snapshot.stat, canonicalStat)) {
    fail('SOURCE_UNAVAILABLE', 'The repository workspace root changed during path inventory.');
  }
}

function safeErrorPath(relative) {
  return relative || '.';
}

function fileFact(relative, info) {
  const size = Number(info.size);
  const mtime_ms = Number(info.mtimeMs);
  const ctime_ms = Number(info.ctimeMs);
  if (!Number.isSafeInteger(size) || size < 0 || !Number.isFinite(mtime_ms) || mtime_ms < 0
    || !Number.isFinite(ctime_ms) || ctime_ms < 0) {
    fail('SOURCE_UNAVAILABLE', 'A regular file has metadata that cannot be represented safely.', { path: relative });
  }
  // Match the provider's bigint Stats DTO exactly, including its millisecond
  // resolution and lossless string filesystem IDs; source bytes are checked separately.
  return { path: relative, size, mtime_ms, ctime_ms, dev: String(info.dev), ino: String(info.ino) };
}

async function collectOnce(root, parsedScope, extraSkippedKeys) {
  const files = new Map();
  const skipped = new Map();
  const fileFacts = new Map();
  let visited = 0;

  const addPath = (kind, relative) => {
    const target = kind === 'file' ? files : skipped;
    const other = kind === 'file' ? skipped : files;
    const pathKey = key(relative);
    const prior = target.get(pathKey) ?? other.get(pathKey);
    if (prior !== undefined) {
      if (prior !== relative || other.has(pathKey)) {
        fail('SOURCE_UNAVAILABLE', 'Repository path inventory contains a path or file/directory identity collision.', { path: relative });
      }
      return;
    }
    if (kind === 'file') {
      const parts = relative.split('/');
      for (let length = 1; length <= parts.length; length += 1) {
        if (skipped.has(key(parts.slice(0, length).join('/')))) {
          fail('SOURCE_UNAVAILABLE', 'Repository file inventory overlaps a skipped directory.', { path: relative });
        }
      }
    }
    if (files.size + skipped.size >= MAX_PATH_ITEMS) {
      fail('SOURCE_UNAVAILABLE', 'Repository path inventory exceeds its bounded entry limit.', { max_items: MAX_PATH_ITEMS });
    }
    target.set(pathKey, relative);
  };

  const lstatRelative = async (relative, segments) => {
    if (segments.length === 0) return { symlink: false, stat: root.stat, absolute: root.canonical };
    let absolute = root.canonical;
    let lastStat;
    for (let index = 0; index < segments.length; index += 1) {
      absolute = path.join(absolute, segments[index]);
      try { lastStat = await lstat(absolute, { bigint: true }); }
      catch (error) { ioFailure(error, safeErrorPath(relative), 'lstat'); }
      if (lastStat.isSymbolicLink()) {
        fail('SOURCE_UNAVAILABLE', 'A symbolic link or directory alias appeared inside the repository inventory scope.', {
          path: relative, segment: segments[index],
        });
      }
      if (index < segments.length - 1 && !lastStat.isDirectory()) {
        fail('SOURCE_UNAVAILABLE', 'A repository inventory path ancestor is not a directory.', { path: relative, segment: segments[index] });
      }
    }
    return { symlink: false, stat: lastStat, absolute };
  };

  const visit = async (relative, segments, { exactFile = false, rootPath = false } = {}) => {
    if (segments.length > 0) {
      for (let length = 1; length < segments.length; length += 1) {
        const ancestor = segments.slice(0, length).join('/');
        const inspected = await lstatRelative(ancestor, segments.slice(0, length));
        if (!inspected.stat.isDirectory()) {
          fail('SOURCE_UNAVAILABLE', 'A repository inventory path ancestor is not a directory.', { path: relative, segment: segments[length - 1] });
        }
        if (isPolicySkippedDirectory(ancestor, extraSkippedKeys)) {
          addPath('directory', ancestor);
          return;
        }
      }
    }

    const inspected = await lstatRelative(relative, segments);
    const info = inspected.stat;
    if (info.isDirectory()) {
      if (exactFile) fail('SOURCE_UNAVAILABLE', 'A scoped file path now refers to a directory.', { path: relative });
      if (relative && isPolicySkippedDirectory(relative, extraSkippedKeys)) {
        addPath('directory', relative);
        return;
      }
      let names;
      try { names = await readdir(inspected.absolute); }
      catch (error) { ioFailure(error, safeErrorPath(relative), 'readdir'); }
      const after = await lstatRelative(relative, segments);
      if (!after.stat.isDirectory() || !isSameFile(info, after.stat)) {
        fail('SOURCE_UNAVAILABLE', 'A repository directory changed during path inventory.', { path: safeErrorPath(relative) });
      }
      for (const name of names) {
        visited += 1;
        if (visited > MAX_PATH_ITEMS) fail('SOURCE_UNAVAILABLE', 'Repository enumeration exceeds its bounded entry limit.', { max_items: MAX_PATH_ITEMS });
        const childSegments = [...segments, name];
        const child = childSegments.join('/');
        validateRelativePath(child, 'filesystem_entry');
        await visit(child, childSegments);
      }
      return;
    }
    if (info.isFile()) {
      if (rootPath) fail('SOURCE_UNAVAILABLE', 'A scoped root path now refers to a regular file.', { path: relative });
      addPath('file', relative);
      const fact = fileFact(relative, info);
      const prior = fileFacts.get(key(relative));
      if (prior && JSON.stringify(prior) !== JSON.stringify(fact)) {
        fail('SOURCE_UNAVAILABLE', 'A regular file changed during path inventory.', { path: relative });
      }
      fileFacts.set(key(relative), fact);
    }
    // Symlinks and non-regular special entries are excluded without following or opening them.
  };

  await assertRootUnchanged(root);
  for (const configuredRoot of parsedScope.roots) {
    if (configuredRoot.path === '.') await visit('', [], { rootPath: true });
    else await visit(configuredRoot.path, configuredRoot.segments, { rootPath: true });
  }
  for (const configuredFile of parsedScope.files) await visit(configuredFile.path, configuredFile.segments, { exactFile: true });
  await assertRootUnchanged(root);

  const inventory = {
    files: [...files.values()].sort(lexical),
    skipped_directories: [...skipped.values()].sort(lexical),
    file_facts: [...fileFacts.values()].sort((left, right) => lexical(left.path, right.path)),
  };
  return inventory;
}

/**
 * Collect current regular-file metadata inside an explicit discovery scope.
 * This is a bounded, metadata-only double observation: it opens no file contents and writes nothing.
 * A thrown availability fault means the result is incomplete and must block currentness acceptance.
 * The observations are not an atomic filesystem snapshot; changes reverted between passes or after
 * the final identity check are outside this API's guarantee. Link checks also retain the host's
 * path-based lstat/readdir race window, though any observed link or directory identity change fails.
 */
export async function collectRepositoryPaths({ workspaceRoot, scope, skippedDirectories = [] } = {}) {
  const parsedScope = validateScope(scope);
  const extraSkippedKeys = new Set(validateSkippedDirectories(skippedDirectories));
  const root = await rootSnapshot(workspaceRoot);
  await assertRootUnchanged(root);
  const first = await collectOnce(root, parsedScope, extraSkippedKeys);
  await assertRootUnchanged(root);
  const second = await collectOnce(root, parsedScope, extraSkippedKeys);
  await assertRootUnchanged(root);
  if (JSON.stringify(first) !== JSON.stringify(second)) {
    fail('SOURCE_UNAVAILABLE', 'Repository paths or file metadata changed during path inventory.');
  }
  const pathInventory = { files: second.files, skipped_directories: second.skipped_directories };
  return { ...second, digest: digest(pathInventory) };
}
