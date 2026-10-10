import fs from 'node:fs';
import path from 'node:path';
import { sha256 } from '../core/contracts.mjs';

export const DEFAULT_ARCHITECTURE_PATH = 'architecture.json';
const MAX_DECLARATION_BYTES = 256 * 1024;
const MAX_JSON_NODES = 20_000;
const MAX_JSON_DEPTH = 20;

function candidate(reason, sourceFact = null) {
  return {
    status: 'candidate',
    architecture_path: DEFAULT_ARCHITECTURE_PATH,
    source_fact: sourceFact,
    reason,
  };
}

function sameFileVersion(left, right) {
  return left.isFile() && right.isFile()
    && left.dev === right.dev && left.ino === right.ino
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function readDeclarationBytes(workspaceRoot) {
  const root = path.resolve(workspaceRoot);
  let rootStat;
  try { rootStat = fs.lstatSync(root); }
  catch { return { status: 'candidate', reason: 'workspace_root_unavailable' }; }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return { status: 'candidate', reason: 'workspace_root_unavailable' };

  const file = path.join(root, DEFAULT_ARCHITECTURE_PATH);
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return { status: 'missing' };
    return { status: 'candidate', reason: 'declaration_unavailable' };
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > MAX_DECLARATION_BYTES) {
    return { status: 'candidate', reason: 'declaration_not_bounded_regular_file' };
  }

  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const opened = fs.fstatSync(fd);
    if (!sameFileVersion(before, opened)) return { status: 'candidate', reason: 'declaration_changed_before_read' };
    const buffer = Buffer.alloc(MAX_DECLARATION_BYTES + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.fstatSync(fd);
    const current = fs.lstatSync(file);
    if (size !== opened.size || size > MAX_DECLARATION_BYTES
      || !sameFileVersion(opened, after) || !sameFileVersion(after, current)) {
      return { status: 'candidate', reason: 'declaration_changed_during_read' };
    }
    const bytes = buffer.subarray(0, size);
    return {
      status: 'read',
      bytes,
      source_fact: { path: DEFAULT_ARCHITECTURE_PATH, sha256: sha256(bytes) },
    };
  } catch {
    return { status: 'candidate', reason: 'declaration_unavailable' };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function withinJsonBudget(value) {
  const pending = [[value, 0]];
  let visited = 0;
  while (pending.length) {
    const [current, depth] = pending.pop();
    if (++visited > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
    if (current && typeof current === 'object') {
      for (const child of Object.values(current)) pending.push([child, depth + 1]);
    }
  }
  return true;
}

/**
 * Recognize the fixed root architecture declaration using the provider's pure
 * validator supplied by the verified bundled provider. This does not load the
 * ArchitectureIndex, compile the graph, read declared sources, or run a child
 * process. The resulting status means declaration_valid, not graph_ready.
 */
export function inspectRegisteredArchitecture(workspaceRoot, { validateRegisteredDeclaration } = {}) {
  const read = readDeclarationBytes(workspaceRoot);
  if (read.status === 'missing') return { status: 'missing', architecture_path: DEFAULT_ARCHITECTURE_PATH, source_fact: null };
  if (read.status === 'candidate') return candidate(read.reason);

  let declaration;
  try { declaration = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read.bytes)); }
  catch { return candidate('declaration_is_not_bounded_utf8_json', read.source_fact); }
  if (!withinJsonBudget(declaration)) return candidate('declaration_exceeds_complexity_budget', read.source_fact);
  if (typeof validateRegisteredDeclaration !== 'function') {
    return candidate('declaration_validator_unavailable', read.source_fact);
  }

  let normalized;
  try { normalized = validateRegisteredDeclaration(declaration); }
  catch { return candidate('declaration_invalid', read.source_fact); }
  if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)
    || normalized.schema_version !== 1 || !Array.isArray(normalized.modules)) {
    return candidate('declaration_validator_returned_invalid_result', read.source_fact);
  }
  const sourcePaths = [];
  for (const module of normalized.modules) {
    if (!module || typeof module !== 'object' || Array.isArray(module) || !Array.isArray(module.source)) {
      return candidate('declaration_validator_returned_invalid_result', read.source_fact);
    }
    for (const source of module.source) {
      if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.path !== 'string') {
        return candidate('declaration_validator_returned_invalid_result', read.source_fact);
      }
      sourcePaths.push(source.path);
    }
  }

  return {
    status: 'declaration_valid',
    architecture_path: DEFAULT_ARCHITECTURE_PATH,
    source_fact: read.source_fact,
    source_paths: [...new Set(sourcePaths)].sort((left, right) => left < right ? -1 : left > right ? 1 : 0),
  };
}
