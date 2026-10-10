import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { digest, fault } from '../core/contracts.mjs';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_CHECKS = 32;
const CHECK_ID = /^[A-Za-z0-9_.:-]{1,128}$/u;
const SAFE_PATH = value => typeof value === 'string'
  && value.length > 0
  && value.length <= 1024
  && !value.includes('\\')
  && !value.includes(':')
  && !value.startsWith('/')
  && !/[\u0000-\u001f\u007f]/u.test(value)
  && value.split('/').every(part => part && part !== '.' && part !== '..' && !part.endsWith('.') && !part.endsWith(' ')
    && !['.codex', '.git', 'node_modules', 'slop'].includes(part.toLowerCase()));
const SCRIPT_NAMES = ['test', 'lint', 'typecheck', 'check', 'build'];
const HASH_LIMIT = 512 * 1024 * 1024;

function invalid(message, details = {}) {
  return fault('EVIDENCE_INVALID', message, details);
}

export function hashRegularFile(file, maxBytes = HASH_LIMIT) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw invalid('Toolchain files must use absolute paths.');
  const absolute = path.resolve(file);
  let cursor = path.parse(absolute).root;
  const parts = absolute.slice(cursor.length).split(path.sep).filter(Boolean);
  for (const part of parts.slice(0, -1)) {
    cursor = path.join(cursor, part);
    const parent = fs.lstatSync(cursor);
    if (!parent.isDirectory() || parent.isSymbolicLink()) throw invalid('Toolchain paths must have regular directory parents.');
  }
  const before = fs.lstatSync(absolute);
  if (!before.isFile() || before.isSymbolicLink() || before.size > maxBytes) throw invalid('Toolchain identity must be a bounded regular file.');
  const fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw invalid('Toolchain identity changed before it was read.');
    }
    const hash = createHash('sha256');
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < opened.size) {
      const count = fs.readSync(fd, buffer, 0, Math.min(buffer.length, opened.size - position), position);
      if (count === 0) throw invalid('Toolchain identity ended before its declared size.');
      hash.update(buffer.subarray(0, count));
      position += count;
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(absolute);
    if (afterFd.size !== opened.size || afterFd.mtimeMs !== opened.mtimeMs || afterFd.ctimeMs !== opened.ctimeMs
      || afterPath.isSymbolicLink() || afterPath.dev !== opened.dev || afterPath.ino !== opened.ino
      || afterPath.size !== opened.size || afterPath.mtimeMs !== opened.mtimeMs || afterPath.ctimeMs !== opened.ctimeMs) {
      throw invalid('Toolchain identity changed while it was read.');
    }
    return hash.digest('hex');
  } finally {
    fs.closeSync(fd);
  }
}

function readToolchainFacts(env) {
  const executable = process.execPath;
  let executable_sha256;
  try { executable_sha256 = hashRegularFile(executable); }
  catch (error) {
    return { toolchain: { executable, executable_sha256: null, npm_cli: null, npm_cli_sha256: null }, unavailable: [{ id: 'node-runtime', reason: 'The current Node executable could not be identified safely.' }], toolchain_facts: [] };
  }

  const nodeDirectory = path.dirname(path.resolve(executable));
  const npmCandidates = [
    path.join(nodeDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'lib', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(nodeDirectory, '..', 'share', 'nodejs', 'npm', 'bin', 'npm-cli.js'),
  ];
  if (process.platform === 'win32' && typeof env.APPDATA === 'string' && path.isAbsolute(env.APPDATA)) {
    npmCandidates.unshift(path.join(env.APPDATA, 'npm', 'node_modules', 'npm', 'bin', 'npm-cli.js'));
  }
  let npm_cli = null;
  let npm_cli_sha256 = null;
  for (const candidate of [...new Set(npmCandidates)]) {
    try {
      npm_cli_sha256 = hashRegularFile(candidate, 16 * 1024 * 1024);
      npm_cli = path.resolve(candidate);
      break;
    } catch { /* Probe only the fixed Node/npm installation layouts above. */ }
  }
  const toolchain_facts = [{ path: executable, sha256: executable_sha256 }];
  if (npm_cli) toolchain_facts.push({ path: npm_cli, sha256: npm_cli_sha256 });
  return {
    toolchain: { executable, executable_sha256, npm_cli, npm_cli_sha256 },
    unavailable: npm_cli ? [] : [{ id: 'npm-cli', reason: 'No regular npm CLI was found in a known Node installation layout.' }],
    toolchain_facts,
  };
}

function isMissingSource(error) {
  return error?.code === 'SOURCE_UNAVAILABLE' && error?.details?.reason === 'ENOENT';
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function parseScripts(content) {
  let manifest;
  try { manifest = JSON.parse(content); }
  catch { throw invalid('Workspace package.json must contain valid JSON.'); }
  if (!isRecord(manifest) || (manifest.name !== undefined && typeof manifest.name !== 'string')
    || (manifest.scripts !== undefined && !isRecord(manifest.scripts))) {
    throw invalid('Workspace package.json does not have a valid package/scripts shape.');
  }
  return manifest.scripts ?? {};
}

/** Discover executable npm checks without launching npm or reading commands from PATH. */
export async function detectCheckCandidates({ workspace, config, env = process.env }) {
  if (!isRecord(workspace) || typeof workspace.readSource !== 'function') throw invalid('A workspace source reader is required.');
  if (!isRecord(config) || config.schema_revision !== 3) {
    return { candidates: [], unavailable: [], toolchain: null, toolchain_facts: [] };
  }
  if (!isRecord(env)) throw invalid('Candidate environment must be a plain object.');
  const toolchainResult = readToolchainFacts(env);
  const unavailable = [...toolchainResult.unavailable];
  let packageSource;
  try { packageSource = await workspace.readSource('package.json'); }
  catch (error) {
    if (!isMissingSource(error)) throw error;
    unavailable.push({ id: 'npm-scripts', reason: 'Workspace package.json is missing.' });
    return { candidates: [], unavailable, toolchain: toolchainResult.toolchain, toolchain_facts: toolchainResult.toolchain_facts, source_facts: [] };
  }

  const scripts = parseScripts(packageSource.content);
  const candidates = [];
  for (const script of SCRIPT_NAMES) {
    if (!Object.hasOwn(scripts, script)) continue;
    if (typeof scripts[script] !== 'string' || scripts[script].trim() === '') throw invalid(`Workspace npm script ${script} must be a non-empty string.`);
    const source = { path: packageSource.path, sha256: packageSource.sha256 };
    if (!toolchainResult.toolchain.npm_cli) {
      unavailable.push({ id: `npm:${script}`, kind: 'command', source, assurance: 'behavioral', required_candidate: true, executable: false, reason: 'Known npm CLI is unavailable; the script was not claimed as executable.' });
      continue;
    }
    candidates.push({
      id: `npm:${script}`,
      kind: 'command',
      argv: [toolchainResult.toolchain.executable, toolchainResult.toolchain.npm_cli, 'run', script],
      timeout_ms: DEFAULT_TIMEOUT_MS,
      source,
      assurance: 'behavioral',
      required_candidate: true,
    });
  }
  return {
    candidates,
    unavailable,
    toolchain: toolchainResult.toolchain,
    toolchain_facts: toolchainResult.toolchain_facts,
    source_facts: [{ path: packageSource.path, sha256: packageSource.sha256 }],
  };
}

function validateIds(values, field) {
  if (!Array.isArray(values) || values.length > MAX_CHECKS) throw invalid(`${field} must be an array of at most ${MAX_CHECKS} IDs.`);
  const seen = new Set();
  for (const value of values) {
    if (typeof value !== 'string' || !CHECK_ID.test(value) || seen.has(value)) throw invalid(`${field} contains an invalid or duplicate ID.`);
    seen.add(value);
  }
  return seen;
}

function validateInput(input) {
  if (!isRecord(input) || Object.keys(input).some(key => !['selected_ids', 'exclusions', 'planned_node_tests', 'behavioral_applicability'].includes(key))) {
    throw invalid('Check plan input has an unknown field.');
  }
  const selected = input.selected_ids === undefined ? null : validateIds(input.selected_ids, 'selected_ids');
  if (input.exclusions !== undefined && (!Array.isArray(input.exclusions) || input.exclusions.length > MAX_CHECKS)) throw invalid('exclusions must be a bounded array.');
  const exclusions = new Map();
  for (const item of input.exclusions ?? []) {
    if (!isRecord(item) || Object.keys(item).some(key => !['id', 'reason'].includes(key))
      || typeof item.id !== 'string' || !CHECK_ID.test(item.id)
      || typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 512
      || exclusions.has(item.id)) throw invalid('Each exclusion needs a unique candidate ID and a concrete reason.');
    exclusions.set(item.id, item.reason.trim());
  }
  if (input.planned_node_tests !== undefined && (!Array.isArray(input.planned_node_tests) || input.planned_node_tests.length > MAX_CHECKS)) throw invalid('planned_node_tests must be a bounded array.');
  const planned = input.planned_node_tests ?? [];
  for (const item of planned) {
    if (!isRecord(item) || Object.keys(item).some(key => !['id', 'path'].includes(key))
      || typeof item.id !== 'string' || !CHECK_ID.test(item.id) || !SAFE_PATH(item.path)) {
      throw invalid('A planned Node test must have a safe ID and workspace-relative path.');
    }
  }
  if (input.behavioral_applicability !== undefined) {
    const declaration = input.behavioral_applicability;
    if (!isRecord(declaration) || Object.keys(declaration).some(key => !['status', 'reason'].includes(key))
      || !['required', 'not_applicable'].includes(declaration.status)
      || typeof declaration.reason !== 'string' || !declaration.reason.trim() || declaration.reason.length > 512) {
      throw invalid('behavioral_applicability needs an explicit status and reason.');
    }
  }
  return { selected, exclusions, planned };
}

/** Combine configured checks, detected candidates, and fixed-shape planned Node tests. */
export async function createCheckPlan({ workspace, config, scope, input = {}, env = process.env }) {
  if (!isRecord(config) || !Array.isArray(config.checks)) throw invalid('A validated cycle config is required.');
  const configuredChecks = config.checks;
  if (config.schema_revision !== 3) {
    const behavioral = configuredChecks.some(item => item.kind === 'command')
      ? { status: 'required', reason: 'Legacy configured behavioral checks remain unchanged and are not dynamically probed.' }
      : { status: 'missing', reason: 'Legacy checks remain unchanged; applicability was not inferred.' };
    const plan = { configuration_digest: config.digest ?? null, checks: configuredChecks, source_facts: [], toolchain_facts: [], exclusions: [], behavioral };
    return { ...plan, digest: digest(plan) };
  }
  if (!Array.isArray(scope) || scope.some(item => typeof item !== 'string')) throw invalid('Check plan scope must be the exact state.scope path array.');
  const parsedInput = validateInput(input);
  const detection = await detectCheckCandidates({ workspace, config, env });
  const candidateById = new Map(detection.candidates.map(candidate => [candidate.id, candidate]));
  for (const id of parsedInput.exclusions.keys()) {
    if (!candidateById.has(id)) throw invalid('Only currently detected dynamic candidates can be excluded.', { check_id: id });
  }

  const selected = [];
  const excluded = [];
  for (const candidate of detection.candidates) {
    const isSelected = parsedInput.selected === null ? !parsedInput.exclusions.has(candidate.id) : parsedInput.selected.has(candidate.id);
    if (isSelected) {
      if (parsedInput.exclusions.has(candidate.id)) throw invalid('A candidate cannot be selected and excluded.', { check_id: candidate.id });
      selected.push(candidate);
    } else {
      const reason = parsedInput.exclusions.get(candidate.id);
      if (!reason) throw invalid('Every detected behavioral candidate must be selected or excluded with a reason.', { check_id: candidate.id });
      excluded.push({ id: candidate.id, reason });
    }
  }
  if (parsedInput.selected) {
    for (const id of parsedInput.selected) if (!candidateById.has(id)) throw invalid('selected_ids contains an unknown or unavailable candidate.', { check_id: id });
  }

  const configuredIds = validateIds(configuredChecks.map(item => item?.id), 'configured checks');
  const ids = new Set(configuredIds);
  const checks = [...configuredChecks];
  for (const candidate of selected) {
    if (ids.has(candidate.id)) throw invalid('Selected candidate duplicates a configured check ID.', { check_id: candidate.id });
    ids.add(candidate.id);
    checks.push(candidate);
  }

  const sourceFacts = new Map((detection.source_facts ?? []).map(fact => [fact.path, fact.sha256]));
  for (const plannedTest of parsedInput.planned) {
    if (!scope.includes(plannedTest.path)) throw invalid('Planned Node tests must use an exact path already present in state.scope.', { path: plannedTest.path });
    if (ids.has(plannedTest.id)) throw invalid('Planned Node test duplicates another check ID.', { check_id: plannedTest.id });
    ids.add(plannedTest.id);
    let source = null;
    try {
      source = await workspace.readSource(plannedTest.path);
      sourceFacts.set(source.path, source.sha256);
    } catch (error) {
      if (!isMissingSource(error)) throw error;
      sourceFacts.set(plannedTest.path, null);
    }
    checks.push({
      id: plannedTest.id,
      kind: 'command',
      argv: [detection.toolchain?.executable ?? process.execPath, '--test', plannedTest.path],
      timeout_ms: DEFAULT_TIMEOUT_MS,
      source: { path: plannedTest.path, sha256: source?.sha256 ?? null },
      assurance: 'behavioral',
      required_candidate: true,
      planned: true,
    });
  }
  if (checks.length > MAX_CHECKS) throw invalid(`A check plan may contain at most ${MAX_CHECKS} checks.`);

  const declared = input.behavioral_applicability;
  const hasBehavioral = checks.some(item => item.kind === 'command');
  let behavioral;
  if (declared?.status === 'not_applicable') {
    behavioral = { status: 'not_applicable', reason: declared.reason.trim() };
  } else if (hasBehavioral) {
    behavioral = { status: 'required', reason: declared?.reason?.trim() ?? 'The plan contains behavioral command checks.' };
  } else {
    behavioral = {
      status: 'missing',
      reason: declared?.reason?.trim() ?? 'No selected behavioral check or explicit non-applicability declaration exists.',
      ...(declared?.status === 'required' ? { applicability: 'required' } : {}),
    };
  }

  const source_facts = [...sourceFacts].map(([file, sha256]) => ({ path: file, sha256 })).sort((a, b) => a.path.localeCompare(b.path));
  const toolchain_facts = detection.toolchain_facts;
  const plan = { configuration_digest: config.digest ?? null, checks, source_facts, toolchain_facts, exclusions: excluded, unavailable: detection.unavailable, behavioral };
  return { ...plan, digest: digest(plan) };
}
