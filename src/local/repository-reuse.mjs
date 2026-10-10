import { digest, fault, REPOSITORY_PROTOCOL } from '../core/contracts.mjs';
import { workspacePathKey } from './workspace.mjs';

const MAX_ITEMS = 128;
const MAX_QUERY_ITEMS = 8192;
const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_EXCLUSION_REASONS = new Set([
  'authority-document', 'implementation-verdict', 'control_directory', 'secret_directory',
  'secret_file', 'excluded_directory', 'symbolic_link_parent', 'special_file',
  'symbolic_link', 'binary_resource', 'binary_content',
]);
const SAFE_ENV_EXAMPLES = new Set(['.env.example', '.env.sample', '.env.template', '.env.test.example']);
const key = workspacePathKey;
const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const own = (value, name) => Object.prototype.hasOwnProperty.call(value, name);
const lexical = (left, right) => left < right ? -1 : left > right ? 1 : 0;

function invalid(field, message = 'Repository query does not satisfy the captured v2 contract.') {
  throw fault('EVIDENCE_INVALID', message, { field });
}

function safePath(value, field, { allowWorkspaceRoot = false, allowExcluded = false } = {}) {
  if (allowWorkspaceRoot && value === '.') return value;
  if (typeof value !== 'string' || value.length === 0 || value.length > 1024
    || value.startsWith('/') || value.startsWith('\\') || value.includes('\\') || value.includes(':')
    || /[\u0000-\u001f\u007f]/u.test(value)) invalid(field);
  const parts = value.split('/');
  if (parts.some(part => part.length === 0 || part === '.' || part === '..'
    || part.endsWith('.') || part.endsWith(' '))) invalid(field);
  if (!allowExcluded && parts.some(part => ['.codex', '.git', 'node_modules', 'slop'].includes(part.toLowerCase()))) invalid(field);
  if (parts.some(part => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu.test(part))) invalid(field);
  if (!allowExcluded && parts.some(part => {
    const normalized = part.toLowerCase();
    return (normalized === '.env' || normalized.startsWith('.env.')) && !SAFE_ENV_EXAMPLES.has(normalized);
  })) invalid(field);
  return value;
}

function hash(value, field) {
  if (typeof value !== 'string' || !HASH.test(value)) invalid(field);
  return value;
}

function boundedArray(value, field, limit = MAX_ITEMS) {
  if (!Array.isArray(value) || value.length > limit) invalid(field);
  return value;
}

function rejectLegacyIdentityFields(value, field = 'query') {
  if (Array.isArray(value)) {
    for (const item of value) rejectLegacyIdentityFields(item, field);
    return;
  }
  if (!isRecord(value)) return;
  for (const [name, child] of Object.entries(value)) {
    if (name === 'uid' || name === 'module_uid' || name === 'selected_capabilities' || name === 'symbol') {
      invalid(`${field}.${name}`, 'Repository v2 cannot contain registered UID or singular-symbol identity fields.');
    }
    rejectLegacyIdentityFields(child, `${field}.${name}`);
  }
}

function exactKeys(value, allowed, field) {
  if (!isRecord(value) || Object.keys(value).some(name => !allowed.includes(name))) invalid(field);
}

function validateSource(source, index) {
  const field = `sources.${index}`;
  exactKeys(source, ['path', 'sha256', 'bytes'], field);
  safePath(source.path, `${field}.path`);
  hash(source.sha256, `${field}.sha256`);
  if (!Number.isSafeInteger(source.bytes) || source.bytes < 0 || source.bytes > 16 * 1024 * 1024) invalid(`${field}.bytes`);
}

function validatePathInventory(pathInventory) {
  exactKeys(pathInventory, ['files', 'skipped_directories'], 'path_inventory');
  const files = boundedArray(pathInventory.files, 'path_inventory.files', MAX_QUERY_ITEMS);
  const directories = boundedArray(pathInventory.skipped_directories, 'path_inventory.skipped_directories', MAX_QUERY_ITEMS);
  if (files.length + directories.length > MAX_QUERY_ITEMS) invalid('path_inventory');

  const validateSortedUniquePaths = (paths, field) => {
    const seen = new Set();
    let previous;
    for (const [index, pathValue] of paths.entries()) {
      safePath(pathValue, `${field}.${index}`, { allowExcluded: true });
      const pathKey = key(pathValue);
      if (seen.has(pathKey) || (previous !== undefined && lexical(previous, pathValue) >= 0)) invalid(field, 'Path inventory arrays must be unique and UTF-16 lexically sorted.');
      seen.add(pathKey);
      previous = pathValue;
    }
    return seen;
  };
  const fileKeys = validateSortedUniquePaths(files, 'path_inventory.files');
  const directoryKeys = validateSortedUniquePaths(directories, 'path_inventory.skipped_directories');
  for (const filePath of files) {
    const parts = filePath.split('/');
    for (let length = 1; length <= parts.length; length += 1) {
      if (directoryKeys.has(key(parts.slice(0, length).join('/')))) {
        invalid('path_inventory', 'A regular file cannot be equal to or below a skipped directory.');
      }
    }
  }
  return {
    fileKeys,
    directoryKeys,
    filePathsByKey: new Map(files.map(pathValue => [key(pathValue), pathValue])),
    directoryPathsByKey: new Map(directories.map(pathValue => [key(pathValue), pathValue])),
  };
}

function validateCandidate(candidate, index, workspaceId) {
  const field = `candidates.${index}`;
  if (!isRecord(candidate)) invalid(field);
  const allowed = ['kind', 'candidate_id', 'path', 'sha256', 'line_count', 'symbol_status', 'symbols'];
  exactKeys(candidate, allowed, field);
  if (candidate.kind !== 'source-file') invalid(`${field}.kind`);
  safePath(candidate.path, `${field}.path`);
  hash(candidate.candidate_id, `${field}.candidate_id`);
  if (candidate.candidate_id !== digest({ workspace_id: workspaceId, path: candidate.path })) invalid(`${field}.candidate_id`);
  hash(candidate.sha256, `${field}.sha256`);
  if (!Number.isSafeInteger(candidate.line_count) || candidate.line_count < 0 || candidate.line_count > 16 * 1024 * 1024) invalid(`${field}.line_count`);
  if (!['parsed', 'partial', 'unknown'].includes(candidate.symbol_status)) invalid(`${field}.symbol_status`);
  if (candidate.symbol_status === 'unknown') {
    if (own(candidate, 'symbols')) invalid(`${field}.symbols`);
  } else {
    const symbols = boundedArray(candidate.symbols, `${field}.symbols`, 4096);
    if (symbols.some(symbol => typeof symbol !== 'string' || symbol.length === 0 || symbol.length > 256)
      || symbols.some((symbol, i) => i > 0 && lexical(symbols[i - 1], symbol) >= 0)) invalid(`${field}.symbols`);
  }
}

function validateCoveragePart(value, field, statuses) {
  exactKeys(value, ['status', 'count', 'reasons'], field);
  if (!statuses.includes(value.status)) invalid(`${field}.status`);
  const maxCount = field === 'coverage.candidates' ? MAX_ITEMS : MAX_QUERY_ITEMS;
  if (!Number.isSafeInteger(value.count) || value.count < 0 || value.count > maxCount) invalid(`${field}.count`);
  const reasons = boundedArray(value.reasons, `${field}.reasons`, MAX_QUERY_ITEMS);
  for (const [index, reason] of reasons.entries()) {
    exactKeys(reason, ['code', 'path'], `${field}.reasons.${index}`);
    if (typeof reason.code !== 'string' || reason.code.length === 0 || reason.code.length > 128) invalid(`${field}.reasons.${index}.code`);
    if (own(reason, 'path')) safePath(reason.path, `${field}.reasons.${index}.path`, { allowExcluded: true, allowWorkspaceRoot: true });
  }
}

function validateSourceReference(reference, sourceByPath, field) {
  if (!isRecord(reference)) invalid(field);
  exactKeys(reference, ['path', 'sha256', 'line_start', 'line_end'], field);
  safePath(reference.path, `${field}.path`);
  hash(reference.sha256, `${field}.sha256`);
  const source = sourceByPath.get(key(reference.path));
  if (!source || source.path !== reference.path || source.sha256 !== reference.sha256) invalid(field, 'Repository relation does not point to the exact captured source version.');
  const start = reference.line_start;
  const end = reference.line_end;
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 1 || end < start) invalid(`${field}.line_start`);
  return source;
}

function validateRelation(relation, index, sourceByPath) {
  const field = `relations.${index}`;
  exactKeys(relation, ['kind', 'source', 'target'], field);
  if (!['static', 'inferred'].includes(relation.kind)) invalid(`${field}.kind`);
  const source = validateSourceReference(relation.source, sourceByPath, `${field}.source`);
  if (relation.source.line_end > source.line_count) invalid(`${field}.source.line_end`);
  exactKeys(relation.target, ['path', 'specifier'], `${field}.target`);
  safePath(relation.target.path, `${field}.target.path`);
  if (typeof relation.target.specifier !== 'string' || relation.target.specifier.length > 1024) invalid(`${field}.target.specifier`);
}

function validateUnresolved(item, index, sourceByPath) {
  const field = `unresolved.${index}`;
  if (!isRecord(item)) invalid(field);
  if (item.kind === 'relation') {
    if (own(item, 'source')) {
      exactKeys(item, ['kind', 'source', 'specifier', 'reason'], field);
      const source = validateSourceReference(item.source, sourceByPath, `${field}.source`);
      if (item.source.line_end > source.line_count) invalid(`${field}.source.line_end`);
      if (typeof item.specifier !== 'string' || item.specifier.length > 1024) invalid(`${field}.specifier`);
    } else {
      exactKeys(item, ['kind', 'path', 'sha256', 'line', 'reason'], field);
      safePath(item.path, `${field}.path`);
      hash(item.sha256, `${field}.sha256`);
      const source = sourceByPath.get(key(item.path));
      if (!source || source.path !== item.path || source.sha256 !== item.sha256) invalid(`${field}.path`);
      if (own(item, 'line') && item.line !== null && (!Number.isSafeInteger(item.line) || item.line < 1 || item.line > source.line_count)) invalid(`${field}.line`);
    }
  } else {
    if (!['enumeration', 'source', 'collection'].includes(item.kind)) invalid(`${field}.kind`);
    const allowedByKind = {
      enumeration: ['kind', 'path', 'reason', 'code', 'limit'],
      source: ['kind', 'path', 'reason', 'code', 'bytes', 'sha256', 'stat'],
      collection: ['kind', 'path', 'reason', 'code'],
    };
    exactKeys(item, allowedByKind[item.kind], field);
    if (!own(item, 'path') || typeof item.path !== 'string') invalid(`${field}.path`);
    safePath(item.path, `${field}.path`, { allowWorkspaceRoot: true, allowExcluded: true });
    if (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length === 0 || item.reason.length > 256)) invalid(`${field}.reason`);
    if (item.code !== undefined && (typeof item.code !== 'string' || item.code.length === 0 || item.code.length > 128)) invalid(`${field}.code`);
    if (item.reason === undefined && item.code === undefined) invalid(`${field}.reason`);
    if (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || item.bytes < 0)) invalid(`${field}.bytes`);
    if (item.sha256 !== undefined) hash(item.sha256, `${field}.sha256`);
    if (item.limit !== undefined && (!Number.isSafeInteger(item.limit) || item.limit < 0 || item.limit > 8192)) invalid(`${field}.limit`);
    if (item.stat !== undefined) {
      exactKeys(item.stat, ['size', 'mtime_ms', 'ctime_ms', 'dev', 'ino'], `${field}.stat`);
      if (!Number.isSafeInteger(item.stat.size) || item.stat.size < 0) invalid(`${field}.stat.size`);
      for (const name of ['mtime_ms', 'ctime_ms']) if (!Number.isFinite(item.stat[name]) || item.stat[name] < 0) invalid(`${field}.stat.${name}`);
      for (const name of ['dev', 'ino']) if (typeof item.stat[name] !== 'string' || item.stat[name].length > 128) invalid(`${field}.stat.${name}`);
    }
  }
  if (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length === 0 || item.reason.length > 256)) invalid(`${field}.reason`);
}

function validateExclusion(exclusion, index) {
  const field = `exclusions.${index}`;
  if (!isRecord(exclusion) || typeof exclusion.reason !== 'string' || !SOURCE_EXCLUSION_REASONS.has(exclusion.reason)) invalid(`${field}.reason`);
  safePath(exclusion.path, `${field}.path`, { allowExcluded: true });
  const base = ['path', 'reason'];
  const reason = exclusion.reason;
  if (reason === 'symbolic_link') {
    exactKeys(exclusion, [...base, 'size'], field);
    if (!Number.isSafeInteger(exclusion.size) || exclusion.size < 0) invalid(`${field}.size`);
  } else if (reason === 'binary_resource') {
    exactKeys(exclusion, [...base, 'stat'], field);
    exactKeys(exclusion.stat, ['size', 'mtime_ms', 'ctime_ms', 'dev', 'ino'], `${field}.stat`);
    if (!Number.isSafeInteger(exclusion.stat.size) || exclusion.stat.size < 0) invalid(`${field}.stat.size`);
    for (const name of ['mtime_ms', 'ctime_ms']) if (!Number.isFinite(exclusion.stat[name]) || exclusion.stat[name] < 0) invalid(`${field}.stat.${name}`);
    for (const name of ['dev', 'ino']) if (typeof exclusion.stat[name] !== 'string' || exclusion.stat[name].length > 128) invalid(`${field}.stat.${name}`);
  } else if (reason === 'binary_content') {
    exactKeys(exclusion, [...base, 'bytes', 'sha256'], field);
    if (!Number.isSafeInteger(exclusion.bytes) || exclusion.bytes < 0) invalid(`${field}.bytes`);
    hash(exclusion.sha256, `${field}.sha256`);
  } else exactKeys(exclusion, base, field);
}

function inventoryEntries(q) {
  const sources = q.sources.map(source => ({ kind: 'source', path: source.path, sha256: source.sha256, bytes: source.bytes }));
  const exclusions = q.exclusions.map(exclusion => ({ kind: 'excluded', ...exclusion }));
  const unresolved = q.unresolved.filter(item => item.kind !== 'relation').map(({ kind: unresolved_kind, ...details }) => ({
    kind: 'unresolved', unresolved_kind, ...details,
  }));
  return [...sources, ...exclusions, ...unresolved].sort((left, right) => lexical(left.path, right.path)
    || lexical(left.kind, right.kind)
    || lexical(JSON.stringify(left), JSON.stringify(right)));
}

/** Validate the immutable repository-mode query and its canonical inventory identity. */
export function validateRepositoryQuery(q, { workspaceId, scopeDigest } = {}) {
  if (!isRecord(q)) invalid('query');
  exactKeys(q, ['schema_version', 'kind', 'protocol', 'mode', 'workspace_id', 'scope_digest', 'inventory_digest',
    'collection_stable', 'query', 'versions', 'sources', 'candidates', 'coverage', 'relations', 'unresolved',
    'exclusions', 'exclusion_digest', 'path_inventory', 'path_inventory_digest'], 'query');
  rejectLegacyIdentityFields(q);
  if (q.schema_version !== 2) invalid('schema_version');
  if (q.kind !== 'repository_query_v2') invalid('kind');
  if (q.protocol !== REPOSITORY_PROTOCOL) invalid('protocol');
  if (q.mode !== 'repository') invalid('mode');
  hash(q.workspace_id, 'workspace_id');
  hash(q.scope_digest, 'scope_digest');
  hash(q.inventory_digest, 'inventory_digest');
  hash(q.exclusion_digest, 'exclusion_digest');
  hash(q.path_inventory_digest, 'path_inventory_digest');
  const { fileKeys: pathInventoryFiles, directoryPathsByKey, filePathsByKey } = validatePathInventory(q.path_inventory);
  if (q.path_inventory_digest !== digest(q.path_inventory)) invalid('path_inventory_digest', 'Path inventory digest does not match its canonical path sets.');
  if (workspaceId !== undefined && q.workspace_id !== workspaceId) invalid('workspace_id');
  if (scopeDigest !== undefined && q.scope_digest !== scopeDigest) invalid('scope_digest');
  if (typeof q.collection_stable !== 'boolean') invalid('collection_stable');
  exactKeys(q.query, ['paths', 'capability'], 'query');
  const requestedPaths = boundedArray(q.query.paths, 'query.paths', 16);
  for (const [index, pathValue] of requestedPaths.entries()) safePath(pathValue, `query.paths.${index}`, { allowWorkspaceRoot: true });
  if (typeof q.query.capability !== 'string' || q.query.capability.length > 256) invalid('query.capability');

  const sources = boundedArray(q.sources, 'sources');
  const candidates = boundedArray(q.candidates, 'candidates');
  const versions = boundedArray(q.versions, 'versions');
  const exclusions = boundedArray(q.exclusions, 'exclusions', MAX_QUERY_ITEMS);
  const relations = boundedArray(q.relations, 'relations', MAX_QUERY_ITEMS);
  const unresolved = boundedArray(q.unresolved, 'unresolved', MAX_QUERY_ITEMS);
  for (const [index, source] of sources.entries()) validateSource(source, index);
  for (const [index, candidate] of candidates.entries()) validateCandidate(candidate, index, q.workspace_id);

  const sourceByPath = new Map();
  for (const source of sources) {
    const sourceKey = key(source.path);
    if (sourceByPath.has(sourceKey)) invalid('sources', 'Repository source paths must be unique under host path rules.');
    sourceByPath.set(sourceKey, source);
  }
  const candidateByPath = new Map();
  const candidateById = new Map();
  for (const candidate of candidates) {
    const candidateKey = key(candidate.path);
    if (candidateByPath.has(candidateKey) || candidateById.has(candidate.candidate_id)) invalid('candidates');
    candidateByPath.set(candidateKey, candidate);
    candidateById.set(candidate.candidate_id, candidate);
  }
  if (sources.length !== candidates.length || sources.length !== versions.length) invalid('sources', 'Sources, versions, and candidates must be a complete one-to-one inventory.');
  const versionByPath = new Map();
  for (const [index, version] of versions.entries()) {
    if (!isRecord(version)) invalid(`versions.${index}`);
    exactKeys(version, ['path', 'sha256'], `versions.${index}`);
    safePath(version.path, `versions.${index}.path`);
    hash(version.sha256, `versions.${index}.sha256`);
    const versionKey = key(version.path);
    if (versionByPath.has(versionKey)) invalid('versions', 'Version paths must be unique.');
    versionByPath.set(versionKey, version);
  }
  for (const source of sources) {
    const candidate = candidateByPath.get(key(source.path));
    const version = versionByPath.get(key(source.path));
    if (!pathInventoryFiles.has(key(source.path)) || !candidate || candidate.path !== source.path || candidate.sha256 !== source.sha256
      || !version || version.path !== source.path || version.sha256 !== source.sha256) invalid('candidates', 'Every source must have one matching candidate and version.');
  }
  if (versions.some(version => !sourceByPath.has(key(version.path)))) invalid('versions');

  exactKeys(q.coverage, ['enumeration', 'candidates', 'relations'], 'coverage');
  validateCoveragePart(q.coverage.enumeration, 'coverage.enumeration', ['complete', 'partial', 'blocked']);
  validateCoveragePart(q.coverage.candidates, 'coverage.candidates', ['complete', 'partial', 'blocked']);
  validateCoveragePart(q.coverage.relations, 'coverage.relations', ['complete_static', 'partial', 'unknown']);
  if (q.coverage.candidates.count !== candidates.length || q.coverage.relations.count !== relations.length) invalid('coverage', 'Coverage counts must match the full returned arrays.');
  if (q.coverage.enumeration.count !== q.path_inventory.files.length || q.coverage.enumeration.count < candidates.length) invalid('coverage.enumeration.count');

  for (const [index, exclusion] of exclusions.entries()) validateExclusion(exclusion, index);
  const exclusionPaths = new Set(exclusions.map(exclusion => key(exclusion.path)));
  if (sources.some(source => exclusionPaths.has(key(source.path)))) invalid('exclusions', 'A path cannot be both captured and excluded.');
  for (const [index, relation] of relations.entries()) validateRelation(relation, index, sourceByPath);
  for (const [index, item] of unresolved.entries()) validateUnresolved(item, index, sourceByPath);
  const classifiedFiles = new Set();
  const classifyFilePath = (pathValue, field) => {
    const pathKey = key(pathValue);
    if (filePathsByKey.get(pathKey) !== pathValue || classifiedFiles.has(pathKey)) invalid(field, 'Every inventoried regular file must have exactly one captured, excluded, or unresolved classification.');
    classifiedFiles.add(pathKey);
  };
  for (const source of sources) classifyFilePath(source.path, 'sources');
  const regularFileExclusionReasons = new Set(['authority-document', 'implementation-verdict', 'secret_file', 'binary_resource', 'binary_content']);
  const skippedDirectoryExclusionReasons = new Set(['control_directory', 'secret_directory', 'excluded_directory']);
  for (const exclusion of exclusions) {
    const excludedRegularFile = filePathsByKey.get(key(exclusion.path)) === exclusion.path;
    if (regularFileExclusionReasons.has(exclusion.reason) || excludedRegularFile && skippedDirectoryExclusionReasons.has(exclusion.reason)) classifyFilePath(exclusion.path, 'exclusions');
    if (skippedDirectoryExclusionReasons.has(exclusion.reason) && !excludedRegularFile && directoryPathsByKey.get(key(exclusion.path)) !== exclusion.path) {
      invalid('exclusions', 'Skipped-directory exclusions must appear in path_inventory.skipped_directories.');
    }
  }
  for (const item of unresolved) if (item.kind === 'source') classifyFilePath(item.path, 'unresolved');
  if (classifiedFiles.size !== pathInventoryFiles.size) invalid('path_inventory.files', 'Every inventoried regular file must have one source, file exclusion, or unresolved source classification.');

  const expectedInventoryDigest = digest({ scope_digest: q.scope_digest, entries: inventoryEntries(q) });
  if (q.inventory_digest !== expectedInventoryDigest) invalid('inventory_digest', 'Repository inventory digest does not match its canonical sources, exclusions, and unresolved inventory.');
  return q;
}

function lineRangesCover(reads, start, end) {
  if (!Array.isArray(reads) || reads.length === 0) return false;
  const ranges = reads.flatMap(read => Array.isArray(read?.line_ranges) ? read.line_ranges : [])
    .filter(range => Number.isSafeInteger(range?.start_line)
    && Number.isSafeInteger(range?.end_line) && range.start_line >= 1 && range.end_line >= range.start_line)
    .sort((left, right) => left.start_line - right.start_line || left.end_line - right.end_line);
  let next = start;
  for (const range of ranges) {
    if (range.start_line > next) return false;
    if (range.end_line >= next) next = range.end_line + 1;
    if (next > end) return true;
  }
  return false;
}

function hasLineCoverage(read, start, end) {
  return lineRangesCover([read], start, end);
}

function readMatches(read, source) {
  return read?.path === source.path && read?.raw_sha256 === source.sha256
    && Array.isArray(read?.line_ranges) && read.line_ranges.length > 0
    && read.line_ranges.every(range => isRecord(range)
      && Number.isSafeInteger(range.start_line) && Number.isSafeInteger(range.end_line)
      && range.start_line >= 1 && range.end_line >= range.start_line && range.end_line - range.start_line < 128);
}

function hasFullSourceCoverage(reads, source) {
  const matching = reads.filter(read => readMatches(read, source));
  if (source.line_count === 0) {
    return matching.some(read => read.raw_text === '' && hasLineCoverage(read, 1, 1));
  }
  return lineRangesCover(matching, 1, source.line_count);
}

/**
 * Add mechanical coverage issues and role floors from a validated query plus actual read captures.
 * Source semantics remain reported evidence; this function does not decide readiness or verdicts.
 */
export async function inspectRepositoryDecision({ decision, q, reads, state, scope, assign, addIssue, assertDiagnosticPath }) {
  validateRepositoryQuery(q, { workspaceId: q?.workspace_id, scopeDigest: q?.scope_digest });
  if (!isRecord(decision) || !Array.isArray(decision.target_paths) || !Array.isArray(decision.selected_sources)
    || !Array.isArray(decision.read_evidence_ids) || !Array.isArray(decision.candidate_assessments)) invalid('decision');
  if (!['reuse', 'extend', 'new'].includes(decision.decision)) invalid('decision.decision');
  for (const [index, pathValue] of decision.target_paths.entries()) safePath(pathValue, `decision.target_paths.${index}`);
  if (typeof assign !== 'function' || typeof addIssue !== 'function' || typeof assertDiagnosticPath !== 'function') invalid('callbacks');
  const captures = boundedArray(reads, 'reads');
  const selected = boundedArray(decision.selected_sources, 'decision.selected_sources', 32);
  const decisionReadIds = boundedArray(decision.read_evidence_ids, 'decision.read_evidence_ids');
  const assessments = boundedArray(decision.candidate_assessments, 'decision.candidate_assessments');
  const targetKeys = new Set(decision.target_paths.map(target => key(target)));
  const candidateById = new Map(q.candidates.map(candidate => [candidate.candidate_id, candidate]));
  const candidateByPath = new Map(q.candidates.map(candidate => [key(candidate.path), candidate]));
  const selectedById = new Map();
  const readIds = new Set();
  const readById = new Map();
  const selectedSourcePaths = new Set();
  const checkedPaths = new Set();

  if (new Set(decisionReadIds).size !== decisionReadIds.length) invalid('decision.read_evidence_ids');
  for (const id of decisionReadIds) if (typeof id !== 'string' || id.length === 0 || id.length > 128) invalid('decision.read_evidence_ids');
  for (const read of captures) {
    if (!isRecord(read) || typeof read.evidence_id !== 'string' || read.evidence_id.length === 0 || read.evidence_id.length > 128
      || typeof read.path !== 'string' || typeof read.raw_sha256 !== 'string' || !HASH.test(read.raw_sha256)
      || typeof read.raw_text !== 'string' || !Array.isArray(read.line_ranges) || read.line_ranges.length > 8) invalid('reads');
    for (const [index, range] of read.line_ranges.entries()) {
      exactKeys(range, ['start_line', 'end_line'], `reads.line_ranges.${index}`);
      if (!Number.isSafeInteger(range.start_line) || !Number.isSafeInteger(range.end_line)
        || range.start_line < 1 || range.end_line < range.start_line || range.end_line - range.start_line >= 128) invalid(`reads.line_ranges.${index}`);
    }
    if (readIds.has(read.evidence_id)) invalid('reads.evidence_id');
    readIds.add(read.evidence_id);
    if (decisionReadIds.includes(read.evidence_id)) readById.set(read.evidence_id, read);
  }
  const decisionReads = [...readById.values()];
  const readsFor = source => decisionReads.filter(read => readMatches(read, source));
  const reportPath = async pathValue => {
    const pathKey = key(pathValue);
    if (checkedPaths.has(pathKey)) return;
    checkedPaths.add(pathKey);
    await assertDiagnosticPath(pathValue);
  };

  if (decision.decision === 'new' && selected.length !== 0) invalid('decision.selected_sources');
  if (decision.decision !== 'new' && selected.length === 0) invalid('decision.selected_sources');
  for (const [index, selection] of selected.entries()) {
    exactKeys(selection, ['candidate_id', 'path', 'sha256'], `decision.selected_sources.${index}`);
    hash(selection.candidate_id, `decision.selected_sources.${index}.candidate_id`);
    safePath(selection.path, `decision.selected_sources.${index}.path`);
    hash(selection.sha256, `decision.selected_sources.${index}.sha256`);
    if (selectedById.has(selection.candidate_id)) invalid('decision.selected_sources', 'Selected sources must be unique.');
    const candidate = candidateById.get(selection.candidate_id);
    if (!candidate || candidate.path !== selection.path || candidate.sha256 !== selection.sha256) invalid('decision.selected_sources', 'A selected source must match an actual query candidate path and SHA.');
    selectedById.set(candidate.candidate_id, candidate);
    selectedSourcePaths.add(key(candidate.path));
    assign(candidate.path, 'candidate');
    await reportPath(candidate.path);
    const sourceReads = readsFor(candidate);
    if (sourceReads.length > 0 && !hasFullSourceCoverage(sourceReads, candidate)) {
      addIssue({ code: 'CANDIDATE_READ_REQUIRED', decision_id: decision.id,
        candidate_id: candidate.candidate_id, path: candidate.path, sha256: candidate.sha256,
        line_start: 1, line_end: Math.max(1, candidate.line_count), reason: 'incomplete_source_coverage' });
    }
    if (decision.decision === 'reuse' && targetKeys.has(key(candidate.path))) {
      addIssue({ code: 'SELECTED_SOURCE_TARGET_CONFLICT', decision_id: decision.id, candidate_id: candidate.candidate_id, path: candidate.path });
    }
  }

  for (const [dimension, part] of [['enumeration', q.coverage.enumeration], ['candidates', q.coverage.candidates]]) {
    const complete = part.status === 'complete';
    if (!complete) {
      const reasons = part.reasons.length ? part.reasons.slice(0, 8) : [{ code: `coverage_${part.status}` }];
      for (const reason of reasons) addIssue({ code: 'COMPLETE_INVENTORY_REQUIRED', decision_id: decision.id,
        dimension, status: part.status, count: part.count, reason_code: reason.code, ...(reason.path ? { path: reason.path } : {}) });
    }
  }
  if (q.collection_stable !== true) addIssue({ code: 'COMPLETE_INVENTORY_REQUIRED', decision_id: decision.id,
    dimension: 'collection', status: 'unstable', count: q.sources.length, reason_code: 'collection_not_stable' });

  for (const candidate of q.candidates) {
    const matches = readsFor(candidate);
    if (!matches.length) {
      addIssue({ code: 'CANDIDATE_READ_REQUIRED', decision_id: decision.id,
        candidate_id: candidate.candidate_id, path: candidate.path, sha256: candidate.sha256 });
    }
  }

  const selectedPaths = new Set([...selectedSourcePaths]);
  for (const relation of q.relations) {
    if (!selectedPaths.has(key(relation.target.path))) continue;
    const source = candidateByPath.get(key(relation.source.path));
    if (!source || source.sha256 !== relation.source.sha256) invalid('relations', 'A caller relation must point to a current query candidate.');
    await reportPath(source.path);
    if (!targetKeys.has(key(source.path))) assign(source.path, 'caller');
    if (!readsFor(source).some(read => hasLineCoverage(read, relation.source.line_start, relation.source.line_end))) {
      addIssue({ code: 'CALLER_READ_REQUIRED', decision_id: decision.id, path: source.path,
        sha256: source.sha256, line_start: relation.source.line_start, line_end: relation.source.line_end });
    }
  }

  const assessmentById = new Map();
  for (const [index, assessment] of assessments.entries()) {
    exactKeys(assessment, ['candidate_id', 'conclusion', 'read_evidence_ids', 'rationale'], `decision.candidate_assessments.${index}`);
    hash(assessment.candidate_id, `decision.candidate_assessments.${index}.candidate_id`);
    const candidate = candidateById.get(assessment.candidate_id);
    if (!candidate) invalid('decision.candidate_assessments', 'Assessments must identify actual query candidates.');
    if (assessmentById.has(assessment.candidate_id)) invalid('decision.candidate_assessments', 'Candidate assessments must be unique.');
    if (!['selected', 'not_applicable'].includes(assessment.conclusion)) invalid(`decision.candidate_assessments.${index}.conclusion`);
    if (typeof assessment.rationale !== 'string' || assessment.rationale.trim().length === 0 || assessment.rationale.length > 512) invalid(`decision.candidate_assessments.${index}.rationale`);
    const refs = boundedArray(assessment.read_evidence_ids, `decision.candidate_assessments.${index}.read_evidence_ids`, MAX_ITEMS);
    if (refs.length === 0 || new Set(refs).size !== refs.length) invalid(`decision.candidate_assessments.${index}.read_evidence_ids`);
    const referencedReads = [];
    for (const id of refs) {
      if (typeof id !== 'string' || !decisionReadIds.includes(id) || !readById.has(id)) invalid(`decision.candidate_assessments.${index}.read_evidence_ids`);
      referencedReads.push(readById.get(id));
    }
    const isSelected = selectedById.has(candidate.candidate_id);
    if ((isSelected && assessment.conclusion !== 'selected') || (!isSelected && assessment.conclusion === 'selected')) invalid(`decision.candidate_assessments.${index}.conclusion`);
    const candidateReads = referencedReads.filter(read => readMatches(read, candidate));
    const supportsCandidate = candidateReads.length > 0;
    if (!supportsCandidate && isSelected) {
      addIssue({ code: 'CANDIDATE_READ_REQUIRED', decision_id: decision.id, candidate_id: candidate.candidate_id,
        path: candidate.path, sha256: candidate.sha256 });
    }
    assessmentById.set(candidate.candidate_id, assessment);
  }

  if (decision.decision === 'new') {
    for (const candidate of q.candidates) {
      const assessment = assessmentById.get(candidate.candidate_id);
      if (!assessment || assessment.conclusion !== 'not_applicable') {
        addIssue({ code: 'CANDIDATE_ASSESSMENT_REQUIRED', decision_id: decision.id, candidate_id: candidate.candidate_id, path: candidate.path });
        continue;
      }
      const assessmentReads = assessment.read_evidence_ids.map(id => readById.get(id)).filter(read => readMatches(read, candidate));
      if (!hasFullSourceCoverage(assessmentReads, candidate)) {
        addIssue({ code: 'CANDIDATE_READ_REQUIRED', decision_id: decision.id, candidate_id: candidate.candidate_id,
          path: candidate.path, sha256: candidate.sha256, line_start: 1, line_end: Math.max(1, candidate.line_count),
          reason: assessmentReads.length === 0 ? 'assessment_source_read_required' : 'incomplete_assessment_source_coverage' });
      }
    }
  }

  if (decision.decision === 'extend' || decision.decision === 'new') {
    const unresolved = q.unresolved;
    if (unresolved.length === 0 && q.coverage.relations.status !== 'complete_static') {
      addIssue({ code: 'UNRESOLVED_RELATIONS', decision_id: decision.id, status: q.coverage.relations.status });
    } else {
      for (const item of unresolved.slice(0, 16)) {
        const pathValue = item.source?.path ?? item.path;
        if (pathValue && pathValue !== '.') await reportPath(pathValue);
        addIssue({ code: 'UNRESOLVED_RELATIONS', decision_id: decision.id, kind: item.kind,
          ...(pathValue ? { path: pathValue } : {}) });
      }
    }
  }
  // `state` and `scope` remain parent-owned inputs for lifecycle/scope policy.
  void state;
  void scope;
}
