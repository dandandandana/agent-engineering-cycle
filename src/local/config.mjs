import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { readJson } from './store.mjs';
import { resolvePluginDataDirectory } from './plugin-data.mjs';
import {
  createStandardProfile,
  DEFAULT_REPOSITORY_BUDGETS,
  STANDARD_PROFILE_ID,
  STANDARD_PROFILE_REVISION,
} from './default-profile.mjs';
import { DEFAULT_ARCHITECTURE_PATH, inspectRegisteredArchitecture } from './registered-default.mjs';
import { digest, fault, QA_POLICY, REPOSITORY_PROTOCOL, REUSE_PROTOCOL } from '../core/contracts.mjs';

const check = z.object({ id: z.string().regex(/^[A-Za-z0-9_.:-]+$/), kind: z.enum(['command','source-integrity']).default('command'), argv: z.array(z.string().min(1).max(4096)).min(1).max(64).optional(), timeout_ms: z.number().int().min(100).max(600000).default(30000) }).strict().refine(c => c.kind === 'source-integrity' ? c.argv === undefined : c.argv !== undefined, 'Command checks need argv; source-integrity checks never execute commands');
const settings = { checks: z.array(check).max(32).default([]), qa: z.object({ executable: z.string().min(1), model: z.string().min(1), windows_sandbox: z.enum(['elevated', 'unelevated']).optional(), timeout_ms: z.number().int().min(1000).max(600000).default(180000), capability_receipt: z.string().min(1).optional() }).strict().optional() };
const safePath = z.string().min(1).max(1024).refine(p => !p.includes('\\') && !p.includes(':') && !p.startsWith('/') && !/[\u0000-\u001f\u007f]/u.test(p) && p.split('/').every(s => s && s !== '.' && s !== '..' && !s.endsWith('.') && !s.endsWith(' ') && !['.codex','.git','node_modules','slop'].includes(s.toLowerCase())), 'Use a safe workspace-relative path');
export const discoveryScopeSchema = z.object({ roots: z.array(safePath).max(64), files: z.array(safePath).max(256) }).strict().refine(s => s.roots.length + s.files.length > 0, 'Discovery needs an explicit read scope');
const reuseConfig = z.object({ required: z.literal(true).default(true), architecture_path: safePath, discovery_scope: discoveryScopeSchema, documentation_paths: z.array(safePath).max(64).default([]), provider: z.object({ executable: z.string().min(1).max(4096), args: z.array(z.string().min(1).max(4096)).max(32).default([]), manifest: z.string().min(1).max(4096), manifest_sha256: z.string().regex(/^[a-f0-9]{64}$/), protocol: z.literal(REUSE_PROTOCOL).default(REUSE_PROTOCOL), timeout_ms: z.number().int().min(100).max(600000).default(30000) }).strict() }).strict();

const repositoryPath = z.union([z.literal('.'), safePath]);
const repositoryDiscoveryScope = z.object({
  roots: z.array(repositoryPath).max(64),
  files: z.array(safePath).max(256),
}).strict().refine(scope => scope.roots.length + scope.files.length > 0, 'Discovery needs an explicit read scope');
const budgetPatch = z.object({
  max_sources: z.number().int().min(1).max(DEFAULT_REPOSITORY_BUDGETS.max_sources).optional(),
  max_file_bytes: z.number().int().min(1).max(DEFAULT_REPOSITORY_BUDGETS.max_file_bytes).optional(),
  max_total_bytes: z.number().int().min(1).max(DEFAULT_REPOSITORY_BUDGETS.max_total_bytes).optional(),
  timeout_ms: z.number().int().min(1).max(DEFAULT_REPOSITORY_BUDGETS.timeout_ms).optional(),
}).strict().refine(value => Object.keys(value).length > 0, 'At least one discovery budget must be selected');
const repositoryPatch = z.object({
  mode: z.enum(['repository', 'registered']).optional(),
  discovery_scope: repositoryDiscoveryScope.optional(),
  documentation_paths: z.array(safePath).max(64).optional(),
  budgets: budgetPatch.optional(),
}).strict();
const modelSelection = z.object({ model: z.string().trim().min(1).max(256) }).strict();
const sparseStandardConfig = z.object({
  schema_revision: z.literal(3),
  profile: z.literal(STANDARD_PROFILE_ID),
  checks: z.array(check).max(32).optional(),
  qa: modelSelection.optional(),
  component_reuse: repositoryPatch.optional(),
}).strict();

const configSchema = z.discriminatedUnion('schema_revision', [
  z.object({ schema_revision: z.literal(1), ...settings }).strict(),
  z.object({ schema_revision: z.literal(2), ...settings, component_reuse: reuseConfig.optional() }).strict(),
  sparseStandardConfig,
]);

const MISSING = Symbol('missing-config-file');
const CONFIG_LIMIT = 65536;

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function assertRegularParents(file, code = 'EVIDENCE_INVALID') {
  let cursor = path.dirname(path.resolve(file));
  while (true) {
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error.code === 'ENOENT') return false;
      throw fault(code === 'EVIDENCE_INVALID' ? 'STORE_UNAVAILABLE' : code, 'Configuration directory is unavailable.', { io_code: error.code ?? 'IO_ERROR' });
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fault('SCOPE_DENIED', 'Configuration parents must be regular directories.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return true;
    cursor = parent;
  }
}

function readOptionalJson(file, limit = CONFIG_LIMIT) {
  if (!assertRegularParents(file)) return MISSING;
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === 'ENOENT') return MISSING;
    throw fault('STORE_UNAVAILABLE', 'Configuration file is unavailable.', { io_code: error.code ?? 'IO_ERROR' });
  }
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > limit) throw fault('EVIDENCE_INVALID', 'Configuration must be a bounded regular file.');
  return readJson(file, { limit });
}

function parseConfig(raw) {
  const result = configSchema.safeParse(raw);
  if (!result.success) throw fault('EVIDENCE_INVALID', 'Project cycle config has an invalid schema or unsupported field.');
  const config = result.data;
  const checks = config.checks ?? [];
  if (new Set(checks.map(item => item.id)).size !== checks.length) throw fault('EVIDENCE_INVALID', 'Project cycle config has a duplicated check contract.');
  return config;
}

/** Validate a full legacy config or preserve the sparse rev3 override as entered. */
export function validateConfig(raw) {
  return parseConfig(raw);
}

function mergeStandardConfig(base, patch) {
  const result = { ...base };
  if (patch.checks !== undefined) result.checks = patch.checks;
  // QA is an atomic operator selection. It never inherits a model or receipt.
  if (patch.qa !== undefined) result.qa = patch.qa;
  if (patch.component_reuse !== undefined) {
    const selection = patch.component_reuse;
    const reuse = { ...result.component_reuse, ...selection };
    if (selection.discovery_scope !== undefined) reuse.discovery_scope = selection.discovery_scope;
    if (selection.documentation_paths !== undefined) reuse.documentation_paths = selection.documentation_paths;
    if (selection.budgets !== undefined) reuse.budgets = { ...result.component_reuse.budgets, ...selection.budgets };
    // Bundled provider identity is fixed by the installed profile.
    reuse.provider = result.component_reuse.provider;
    reuse.protocol = REPOSITORY_PROTOCOL;
    result.component_reuse = reuse;
  }
  return result;
}

function profileConfig(options) {
  const profile = createStandardProfile({ providerManifest: options.providerManifest });
  const { missing_capabilities: missingCapabilities, ...config } = profile;
  return { config, missingCapabilities };
}

function scopePathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function registeredScope(registration) {
  const seen = new Set();
  const files = [];
  for (const file of [DEFAULT_ARCHITECTURE_PATH, ...registration.source_paths]) {
    const key = scopePathKey(file);
    if (seen.has(key)) continue;
    seen.add(key);
    files.push(file);
  }
  files.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const parsed = discoveryScopeSchema.safeParse({ roots: [], files });
  return parsed.success ? parsed.data : null;
}

function scopesEqual(actual, expected) {
  if (!actual || actual.roots.length !== 0 || actual.files.length !== expected.files.length) return false;
  const actualFiles = actual.files.map(scopePathKey).sort();
  const expectedFiles = expected.files.map(scopePathKey).sort();
  return actualFiles.every((file, index) => file === expectedFiles[index]);
}

function asRegisteredProfile(config, registration, scopeOverride) {
  const scope = registeredScope(registration);
  if (!scope) return null;
  if (scopeOverride !== undefined && !scopesEqual(scopeOverride, scope)) {
    throw fault('EVIDENCE_INVALID', 'Registered discovery scope must contain only the declaration and its declared source paths.');
  }
  const componentReuse = config.component_reuse;
  return {
    ...config,
    component_reuse: {
      ...componentReuse,
      mode: 'registered',
      protocol: REUSE_PROTOCOL,
      architecture_path: DEFAULT_ARCHITECTURE_PATH,
      discovery_scope: scopeOverride ?? scope,
      provider: { ...componentReuse.provider, protocol: REUSE_PROTOCOL },
    },
  };
}

function inspectRegistration(workspaceRoot, options) {
  return inspectRegisteredArchitecture(workspaceRoot, {
    validateRegisteredDeclaration: options.validateRegisteredDeclaration,
  });
}

function scopeOverrideFrom(user, projectPatch) {
  if (projectPatch?.component_reuse?.discovery_scope !== undefined) return projectPatch.component_reuse.discovery_scope;
  if (user?.patch.component_reuse?.discovery_scope !== undefined) return user.patch.component_reuse.discovery_scope;
  return undefined;
}

function readUserPreferences(options) {
  const directory = resolvePluginDataDirectory({ env: options.env });
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw fault('CONTEXT_REQUIRED', 'Plugin preference directory must be an absolute local path.');
  const raw = readOptionalJson(path.join(directory, 'preferences.json'));
  if (raw === MISSING) return null;
  const patch = parseConfig(raw);
  if (patch.schema_revision !== 3 || patch.profile !== STANDARD_PROFILE_ID) throw fault('EVIDENCE_INVALID', 'User preferences must use the standard rev3 sparse schema.');
  return { patch, raw };
}

function validateReadOptions(options) {
  if (options === undefined) return {};
  if (!isPlainObject(options) || Object.keys(options).some(key => !['env', 'providerManifest', 'validateRegisteredDeclaration'].includes(key))) {
    throw fault('EVIDENCE_INVALID', 'readConfig accepts only non-model environment and bundled-provider options.');
  }
  if (options.validateRegisteredDeclaration !== undefined && typeof options.validateRegisteredDeclaration !== 'function') {
    throw fault('EVIDENCE_INVALID', 'Registered declaration validation must be supplied by the verified bundled provider.');
  }
  return options;
}

function readLegacy(config, rawProject) {
  const policy = config.component_reuse ? { ...QA_POLICY, revision: 2 } : QA_POLICY;
  const configDigest = digest({ config, policy });
  const inputsDigest = digest({ project: rawProject, user: null });
  return {
    ...config,
    configured: true,
    digest: configDigest,
    policy,
    configuration: {
      source: 'legacy',
      sources: ['legacy'],
      effective: true,
      profile_id: `legacy-v${config.schema_revision}`,
      profile_revision: config.schema_revision,
      digest: configDigest,
      inputs_digest: inputsDigest,
    },
  };
}

function readStandard(rawProject, options, workspaceRoot) {
  const { config: repositoryBase, missingCapabilities } = profileConfig(options);
  const registration = inspectRegistration(workspaceRoot, options);
  let base = repositoryBase;
  let registrationCandidate = null;
  let registrationSourceFact = null;
  if (registration.status === 'declaration_valid') {
    const registeredBase = asRegisteredProfile(repositoryBase, registration);
    if (registeredBase) {
      base = registeredBase;
      registrationSourceFact = registration.source_fact;
    } else {
      registrationCandidate = {
        path: DEFAULT_ARCHITECTURE_PATH,
        reason: 'declaration_scope_incompatible',
        source_fact: registration.source_fact,
      };
    }
  } else if (registration.status === 'candidate') {
    registrationCandidate = {
      path: DEFAULT_ARCHITECTURE_PATH,
      reason: registration.reason,
      ...(registration.source_fact ? { source_fact: registration.source_fact } : {}),
    };
  }

  const sources = ['builtin'];
  let effective = base;
  const user = readUserPreferences(options);
  if (user) {
    effective = mergeStandardConfig(effective, user.patch);
    sources.push('user');
  }
  let projectPatch = null;
  if (rawProject !== MISSING) {
    projectPatch = parseConfig(rawProject);
    if (projectPatch.schema_revision !== 3 || projectPatch.profile !== STANDARD_PROFILE_ID) {
      throw fault('EVIDENCE_INVALID', 'New project defaults require a standard rev3 sparse config.');
    }
    effective = mergeStandardConfig(effective, projectPatch);
    sources.push('project');
  }

  if (effective.component_reuse.mode === 'registered') {
    if (registration.status !== 'declaration_valid') {
      if (registration.reason === 'declaration_validator_unavailable') {
        throw fault('PROVIDER_UNAVAILABLE', 'The bundled SoL declaration validator is unavailable for registered mode.');
      }
      throw fault('EVIDENCE_INVALID', 'Registered mode requires a valid root architecture.json declaration.');
    }
    const registered = asRegisteredProfile(effective, registration, scopeOverrideFrom(user, projectPatch));
    if (!registered) throw fault('EVIDENCE_INVALID', 'The registered declaration exceeds the supported discovery scope.');
    effective = registered;
    registrationSourceFact = registration.source_fact;
    registrationCandidate = null;
  } else {
    // A sparse mode switch back to repository mode must discard the derived v1 path/scope.
    const reuse = { ...effective.component_reuse };
    delete reuse.architecture_path;
    reuse.mode = 'repository';
    reuse.protocol = REPOSITORY_PROTOCOL;
    reuse.provider = { ...reuse.provider, protocol: REPOSITORY_PROTOCOL };
    if (scopeOverrideFrom(user, projectPatch) === undefined) {
      reuse.discovery_scope = repositoryBase.component_reuse.discovery_scope;
    }
    effective = { ...effective, component_reuse: reuse };
    registrationSourceFact = null;
  }

  const policy = { ...QA_POLICY, revision: 3 };
  const configDigest = digest({ config: effective, policy, registration_source_fact: registrationSourceFact });
  const inputsDigest = digest({ project: rawProject === MISSING ? null : rawProject, user: user?.raw ?? null });
  const source = rawProject !== MISSING ? 'project' : user ? 'user' : 'builtin';
  return {
    ...effective,
    configured: rawProject !== MISSING,
    digest: configDigest,
    policy,
    configuration: {
      source,
      sources,
      effective: true,
      profile_id: STANDARD_PROFILE_ID,
      profile_revision: STANDARD_PROFILE_REVISION,
      digest: configDigest,
      inputs_digest: inputsDigest,
    },
    missing_capabilities: missingCapabilities,
    ...(registrationSourceFact ? { registration_source_fact: registrationSourceFact } : {}),
    ...(registrationCandidate ? { registration_candidate: registrationCandidate } : {}),
  };
}

export function readConfig(store, rawOptions) {
  const options = validateReadOptions(rawOptions);
  // Validate .codex and the Store directory with the same path guard used by records.
  store.file('current.json');
  const projectPath = path.join(store.root, '.codex', 'engineering-cycle.json');
  const rawProject = readOptionalJson(projectPath);
  if (rawProject !== MISSING) {
    const parsed = parseConfig(rawProject);
    if (parsed.schema_revision === 1 || parsed.schema_revision === 2) return readLegacy(parsed, rawProject);
    return readStandard(rawProject, options, store.root);
  }
  return readStandard(MISSING, options, store.root);
}
