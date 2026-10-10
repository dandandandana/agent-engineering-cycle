import test from 'node:test';
import assert from 'node:assert/strict';
import { digest, REPOSITORY_PROTOCOL } from '../src/core/contracts.mjs';
import { inspectRepositoryDecision, validateRepositoryQuery } from '../src/local/repository-reuse.mjs';

const WORKSPACE_ID = 'a'.repeat(64);
const SCOPE_DIGEST = 'b'.repeat(64);
const HASH_SHARED = '1'.repeat(64);
const HASH_CALLER = '2'.repeat(64);
const HASH_CONSUMER = '3'.repeat(64);
const HASH_EMPTY = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

function source(path, sha256, bytes = 32) { return { path, sha256, bytes }; }
function candidate(path, sha256, symbols = ['normalize']) {
  return { kind: 'source-file', candidate_id: digest({ workspace_id: WORKSPACE_ID, path }), path, sha256,
    line_count: 8, symbol_status: symbols === null ? 'unknown' : 'parsed', ...(symbols === null ? {} : { symbols }) };
}
function sortLex(left, right) { return left < right ? -1 : left > right ? 1 : 0; }
function inventoryEntries(q) {
  return [
    ...q.sources.map(item => ({ kind: 'source', path: item.path, sha256: item.sha256, bytes: item.bytes })),
    ...q.exclusions.map(item => ({ kind: 'excluded', ...item })),
    ...q.unresolved.filter(item => item.kind !== 'relation').map(({ kind: unresolved_kind, ...details }) => ({ kind: 'unresolved', unresolved_kind, ...details })),
  ].sort((left, right) => sortLex(left.path, right.path) || sortLex(left.kind, right.kind)
    || sortLex(JSON.stringify(left), JSON.stringify(right)));
}
function query({ candidates = [], relations = [], unresolved = [], enumerationStatus = 'complete', candidateStatus = 'complete', relationStatus = 'complete_static', exclusions = [], capability = '' } = {}) {
  const sources = candidates.map(item => source(item.path, item.sha256));
  const regularFileExclusions = new Set(['authority-document', 'implementation-verdict', 'secret_file', 'binary_resource', 'binary_content']);
  const skippedDirectoryExclusions = new Set(['control_directory', 'secret_directory', 'excluded_directory']);
  const pathInventory = {
    files: [...candidates.map(item => item.path), ...exclusions.filter(item => regularFileExclusions.has(item.reason)).map(item => item.path),
      ...unresolved.filter(item => item.kind === 'source').map(item => item.path)].sort(sortLex),
    skipped_directories: exclusions.filter(item => skippedDirectoryExclusions.has(item.reason)).map(item => item.path).sort(sortLex),
  };
  const q = {
    schema_version: 2, kind: 'repository_query_v2', protocol: REPOSITORY_PROTOCOL, mode: 'repository',
    workspace_id: WORKSPACE_ID, scope_digest: SCOPE_DIGEST, inventory_digest: '0'.repeat(64),
    exclusion_digest: 'f'.repeat(64), path_inventory_digest: digest(pathInventory), path_inventory: pathInventory,
    collection_stable: enumerationStatus === 'complete' && candidateStatus === 'complete',
    sources, versions: sources.map(({ path, sha256 }) => ({ path, sha256 })), candidates,
    exclusions, relations, unresolved,
    coverage: {
      enumeration: { status: enumerationStatus, count: pathInventory.files.length, reasons: enumerationStatus === 'complete' ? [] : [{ code: 'scan_budget' }] },
      candidates: { status: candidateStatus, count: candidates.length, reasons: candidateStatus === 'complete' ? [] : [{ code: 'candidate_budget' }] },
      relations: { status: relationStatus, count: relations.length, reasons: relationStatus === 'complete_static' ? [] : [{ code: 'unsupported_language' }] },
    },
    query: { paths: [], capability },
  };
  q.inventory_digest = digest({ scope_digest: q.scope_digest, entries: inventoryEntries(q) });
  return q;
}
function read(evidence_id, path, raw_sha256, start_line = 1, end_line = 8) {
  return { evidence_id, path, raw_sha256, raw_text: 'captured source', line_ranges: [{ start_line, end_line }] };
}
function readRanges(evidence_id, path, raw_sha256, ranges, raw_text = 'captured source') {
  return { evidence_id, path, raw_sha256, raw_text,
    line_ranges: ranges.map(([start_line, end_line]) => ({ start_line, end_line })) };
}
function decision({ kind = 'new', target_paths = ['src/consumer.mjs'], selected_sources = [], read_evidence_ids = [], candidate_assessments = [] } = {}) {
  return { id: 'decision-1', decision: kind, target_paths, selected_sources, read_evidence_ids, candidate_assessments };
}
async function inspect(q, d, reads) {
  const issues = [];
  const assignments = [];
  await inspectRepositoryDecision({ decision: d, q, reads, state: { scope: d.target_paths }, scope: { roots: ['src'], files: [] },
    assign: (path, role) => assignments.push({ path, role }), addIssue: issue => issues.push(issue), assertDiagnosticPath: async () => {} });
  return { issues, assignments };
}

test('validates empty complete inventory and allows an evidence-free empty new decision', async () => {
  const q = query();
  const valid = validateRepositoryQuery(q, { workspaceId: WORKSPACE_ID, scopeDigest: SCOPE_DIGEST });
  const d = decision();
  const result = await inspect(valid, d, []);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.assignments, []);
});

test('preserves valid blocked enumeration as captured evidence and refuses a new decision', async () => {
  const q = query({enumerationStatus:'blocked'});
  assert.equal(validateRepositoryQuery(q,{workspaceId:WORKSPACE_ID,scopeDigest:SCOPE_DIGEST}),q);
  const result=await inspect(q,decision(),[]);
  assert.ok(result.issues.some(issue=>issue.code==='COMPLETE_INVENTORY_REQUIRED'));
  assert.equal(q.collection_stable,false);
});

test('a regular worktree control file stays metadata-only rather than becoming a skipped directory', () => {
  const q=query({exclusions:[{path:'.git',reason:'control_directory'}]});
  q.path_inventory={files:['.git'],skipped_directories:[]};q.path_inventory_digest=digest(q.path_inventory);q.coverage.enumeration.count=1;
  assert.equal(validateRepositoryQuery(q,{workspaceId:WORKSPACE_ID,scopeDigest:SCOPE_DIGEST}),q);
  assert.equal(q.sources.length,0);
});

test('accepts an empty source only with its real empty-text 1..1 capture', async () => {
  const item = candidate('src/empty.mjs', HASH_EMPTY, []);
  item.line_count = 0;
  const q = query({ candidates: [item] });
  q.sources[0].bytes = 0;
  q.inventory_digest = digest({ scope_digest: q.scope_digest, entries: inventoryEntries(q) });
  assert.equal(validateRepositoryQuery(q), q);
  const captured = readRanges('read-empty', item.path, HASH_EMPTY, [[1, 1]], '');
  const d = decision({ read_evidence_ids: [captured.evidence_id], candidate_assessments: [
    { candidate_id: item.candidate_id, conclusion: 'not_applicable', read_evidence_ids: [captured.evidence_id], rationale: 'The empty source was captured.' },
  ] });
  assert.deepEqual((await inspect(q, d, [captured])).issues, []);
});

test('allows a fully read new decision only after every candidate has a real not_applicable assessment', async () => {
  const q = query({ candidates: [candidate('src/shared.mjs', HASH_SHARED)] });
  const captured = read('read-shared', 'src/shared.mjs', HASH_SHARED);
  const d = decision({ read_evidence_ids: [captured.evidence_id], candidate_assessments: [
    { candidate_id: q.candidates[0].candidate_id, conclusion: 'not_applicable', read_evidence_ids: [captured.evidence_id], rationale: 'The source was read and does not fit this acceptance.' },
  ] });
  const result = await inspect(q, d, [captured]);
  assert.deepEqual(result.issues, []);
});

test('validates shared-source reuse, requires the caller relation line, and assigns candidate/caller floors', async () => {
  const shared = candidate('src/shared.mjs', HASH_SHARED);
  const caller = candidate('src/caller.mjs', HASH_CALLER, ['legacy']);
  const consumer = candidate('src/consumer.mjs', HASH_CONSUMER, ['consume']);
  const q = query({ candidates: [shared, caller, consumer], relations: [
    { kind: 'static', source: { path: caller.path, sha256: caller.sha256, line_start: 2, line_end: 4 },
      target: { path: shared.path, specifier: './shared.mjs' } },
  ] });
  const reads = [read('read-shared', shared.path, shared.sha256), read('read-caller', caller.path, caller.sha256, 1, 4),
    read('read-consumer', consumer.path, consumer.sha256)];
  const d = decision({ kind: 'reuse', selected_sources: [{ candidate_id: shared.candidate_id, path: shared.path, sha256: shared.sha256 }],
    read_evidence_ids: reads.map(item => item.evidence_id), candidate_assessments: [
      { candidate_id: shared.candidate_id, conclusion: 'selected', read_evidence_ids: ['read-shared'], rationale: 'The inspected source matches the requested behavior.' },
    ] });
  const result = await inspect(q, d, reads);
  assert.deepEqual(result.issues, []);
  assert.ok(result.assignments.some(item => item.path === shared.path && item.role === 'candidate'));
  assert.ok(result.assignments.some(item => item.path === caller.path && item.role === 'caller'));
});

test('rejects registered UID/singular-symbol identity and mismatched source-to-candidate inventory', () => {
  const q = query({ candidates: [candidate('src/shared.mjs', HASH_SHARED)] });
  q.candidates[0].uid = '00000001';
  assert.throws(() => validateRepositoryQuery(q), error => error.code === 'EVIDENCE_INVALID');

  const filtered = query({ candidates: [], capability: 'no-match-keyword' });
  filtered.sources.push(source('src/shared.mjs', HASH_SHARED));
  filtered.versions.push({ path: 'src/shared.mjs', sha256: HASH_SHARED });
  filtered.path_inventory.files.push('src/shared.mjs');
  filtered.path_inventory.files.sort(sortLex);
  filtered.path_inventory_digest = digest(filtered.path_inventory);
  filtered.coverage.enumeration.count = filtered.path_inventory.files.length;
  filtered.inventory_digest = digest({ scope_digest: filtered.scope_digest, entries: inventoryEntries(filtered) });
  assert.throws(() => validateRepositoryQuery(filtered), error => error.code === 'EVIDENCE_INVALID');
});

test('validates path-inventory digest, canonical sets, and file classification', () => {
  const q = query({ candidates: [candidate('src/shared.mjs', HASH_SHARED)] });
  assert.equal(validateRepositoryQuery(q), q);

  const badDigest = JSON.parse(JSON.stringify(q));
  badDigest.path_inventory.files.push('src/z.mjs');
  badDigest.path_inventory.files.sort(sortLex);
  badDigest.coverage.enumeration.count += 1;
  assert.throws(() => validateRepositoryQuery(badDigest), error => error.code === 'EVIDENCE_INVALID');

  const unclassified = JSON.parse(JSON.stringify(q));
  unclassified.path_inventory.files.push('src/z.mjs');
  unclassified.path_inventory.files.sort(sortLex);
  unclassified.path_inventory_digest = digest(unclassified.path_inventory);
  unclassified.coverage.enumeration.count += 1;
  assert.throws(() => validateRepositoryQuery(unclassified), error => error.code === 'EVIDENCE_INVALID');

  const overlap = JSON.parse(JSON.stringify(q));
  overlap.path_inventory.skipped_directories = ['src'];
  overlap.path_inventory_digest = digest(overlap.path_inventory);
  assert.throws(() => validateRepositoryQuery(overlap), error => error.code === 'EVIDENCE_INVALID');

  const duplicate = JSON.parse(JSON.stringify(q));
  duplicate.path_inventory.files.push('src/shared.mjs');
  duplicate.path_inventory.files.sort(sortLex);
  duplicate.path_inventory_digest = digest(duplicate.path_inventory);
  duplicate.coverage.enumeration.count += 1;
  assert.throws(() => validateRepositoryQuery(duplicate), error => error.code === 'EVIDENCE_INVALID');
});

test('recomputes the inventory digest with excluded paths and source failures while keeping I exclusion separate', () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  const q = query({ candidates: [item], enumerationStatus: 'partial', candidateStatus: 'partial', exclusions: [
    { path: '.git', reason: 'control_directory' },
    { path: 'assets/logo.bin', reason: 'binary_resource', stat: { size: 4, mtime_ms: 2, ctime_ms: 3, dev: '1', ino: '7' } },
  ], unresolved: [
    { kind: 'source', path: 'src/blocked.js', reason: 'max_sources', bytes: 64,
      stat: { size: 64, mtime_ms: 2, ctime_ms: 3, dev: '1', ino: '8' } },
  ] });
  assert.equal(validateRepositoryQuery(q), q);
  const original = q.inventory_digest;
  q.sources[0].bytes += 1;
  assert.notEqual(digest({ scope_digest: q.scope_digest, entries: inventoryEntries(q) }), original);
  assert.throws(() => validateRepositoryQuery(q), error => error.code === 'EVIDENCE_INVALID');
});

test('does not let a zero-match keyword erase the full candidate set for a new decision', async () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  const q = query({ candidates: [item], capability: 'no-match-keyword' });
  const captured = read('read-shared', item.path, item.sha256);
  const d = decision({ read_evidence_ids: [captured.evidence_id], candidate_assessments: [
    { candidate_id: item.candidate_id, conclusion: 'not_applicable', read_evidence_ids: [captured.evidence_id], rationale: 'Candidate assessed after a source read.' },
  ] });
  assert.deepEqual((await inspect(q, d, [captured])).issues, []);
});

test('reports missing candidate reads and missing new-decision assessments', async () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  const q = query({ candidates: [item] });
  const missingRead = await inspect(q, decision(), []);
  assert.ok(missingRead.issues.some(issue => issue.code === 'CANDIDATE_READ_REQUIRED' && issue.path === item.path));

  const captured = read('read-shared', item.path, item.sha256);
  const missingAssessment = await inspect(q, decision({ read_evidence_ids: [captured.evidence_id] }), [captured]);
  assert.ok(missingAssessment.issues.some(issue => issue.code === 'CANDIDATE_ASSESSMENT_REQUIRED' && issue.candidate_id === item.candidate_id));
});

test('keeps unknown TS relations blocking for extend and new even when rationale says otherwise', async () => {
  const item = candidate('src/feature.tsx', HASH_SHARED, null);
  const q = query({ candidates: [item], relationStatus: 'unknown', unresolved: [
    { kind: 'relation', path: item.path, sha256: item.sha256, line: 3, reason: 'unsupported_language' },
  ] });
  const captured = read('read-feature', item.path, item.sha256);
  const extend = decision({ kind: 'extend', selected_sources: [{ candidate_id: item.candidate_id, path: item.path, sha256: item.sha256 }],
    read_evidence_ids: [captured.evidence_id] });
  extend.rationale = 'There are no callers; this text cannot clear the unknown relation.';
  const extendResult = await inspect(q, extend, [captured]);
  assert.ok(extendResult.issues.some(issue => issue.code === 'UNRESOLVED_RELATIONS'));

  const newDecision = decision({ read_evidence_ids: [captured.evidence_id], candidate_assessments: [
    { candidate_id: item.candidate_id, conclusion: 'not_applicable', read_evidence_ids: [captured.evidence_id], rationale: 'Not applicable.' },
  ] });
  const newResult = await inspect(q, newDecision, [captured]);
  assert.ok(newResult.issues.some(issue => issue.code === 'UNRESOLVED_RELATIONS'));
});

test('rejects reuse when the selected source is also a consumer target', async () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  const q = query({ candidates: [item] });
  const captured = read('read-shared', item.path, item.sha256);
  const d = decision({ kind: 'reuse', target_paths: [item.path], selected_sources: [
    { candidate_id: item.candidate_id, path: item.path, sha256: item.sha256 },
  ], read_evidence_ids: [captured.evidence_id] });
  const result = await inspect(q, d, [captured]);
  assert.ok(result.issues.some(issue => issue.code === 'SELECTED_SOURCE_TARGET_CONFLICT' && issue.path === item.path));
});

test('requires selected-source read ranges to cover the entire source, including a missing middle', async () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  item.line_count = 5;
  const q = query({ candidates: [item] });
  const reads = [readRanges('read-head', item.path, item.sha256, [[1, 2]]),
    readRanges('read-tail', item.path, item.sha256, [[4, 5]])];
  const d = decision({ kind: 'reuse', selected_sources: [
    { candidate_id: item.candidate_id, path: item.path, sha256: item.sha256 },
  ], read_evidence_ids: reads.map(entry => entry.evidence_id) });
  const result = await inspect(q, d, reads);
  assert.ok(result.issues.some(issue => issue.code === 'CANDIDATE_READ_REQUIRED'
    && issue.path === item.path && issue.reason === 'incomplete_source_coverage'));
});

test('does not accept a selected source header-only read as full-source coverage', async () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  const q = query({ candidates: [item] });
  const captured = readRanges('read-header', item.path, item.sha256, [[1, 1]]);
  const d = decision({ kind: 'reuse', selected_sources: [
    { candidate_id: item.candidate_id, path: item.path, sha256: item.sha256 },
  ], read_evidence_ids: [captured.evidence_id] });
  const result = await inspect(q, d, [captured]);
  assert.ok(result.issues.some(issue => issue.code === 'CANDIDATE_READ_REQUIRED'
    && issue.path === item.path && issue.reason === 'incomplete_source_coverage'));
});

test('requires a new-decision not_applicable assessment to cite reads covering the whole source', async () => {
  const item = candidate('src/shared.mjs', HASH_SHARED);
  const q = query({ candidates: [item] });
  const captured = readRanges('read-header', item.path, item.sha256, [[1, 1]]);
  const d = decision({ read_evidence_ids: [captured.evidence_id], candidate_assessments: [
    { candidate_id: item.candidate_id, conclusion: 'not_applicable', read_evidence_ids: [captured.evidence_id], rationale: 'Not applicable after review.' },
  ] });
  const result = await inspect(q, d, [captured]);
  assert.ok(result.issues.some(issue => issue.code === 'CANDIDATE_READ_REQUIRED'
    && issue.path === item.path && issue.reason === 'incomplete_assessment_source_coverage'));
});
