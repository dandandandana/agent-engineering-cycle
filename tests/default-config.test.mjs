import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { digest, sha256 } from '../src/core/contracts.mjs';
import { readConfig, validateConfig } from '../src/local/config.mjs';
import { LocalStore } from '../src/local/store.mjs';

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cycle-default-config-'));
  const codexHome = path.join(root, 'codex-home');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = { CODEX_HOME: codexHome };
  return { root, codexHome, env, store: new LocalStore(root) };
}

function providerManifest(root) {
  const providerDirectory = path.join(root, 'provider');
  mkdirSync(providerDirectory, { recursive: true });
  const entry = 'index.mjs';
  const entryBytes = Buffer.from('export {};\n');
  writeFileSync(path.join(providerDirectory, entry), entryBytes);
  const manifest = {
    schema_revision: 1,
    protocol: 'sol-component-discovery/1',
    protocols: ['sol-component-discovery/1', 'sol-component-discovery/2'],
    modes: ['registered', 'repository'],
    entry,
    files: [{ path: entry, bytes: entryBytes.length, sha256: sha256(entryBytes) }],
  };
  const manifestPath = path.join(providerDirectory, 'provider-manifest.json');
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifestPath, bytes: Buffer.from(JSON.stringify(manifest)) };
}

function registeredDeclaration() {
  return {
    schema_version: 1,
    modules: [{ id: 'shared-module', source: [{ path: 'src/shared.mjs' }] }],
    policy: {},
  };
}

function registeredValidator(expected = registeredDeclaration()) {
  return input => {
    assert.deepEqual(input, expected);
    return {
      schema_version: 1,
      modules: input.modules.map(module => ({ ...module, source: module.source.map(source => ({ ...source })) })),
      policy: input.policy,
    };
  };
}

function writeProjectConfig(root, value) {
  const codex = path.join(root, '.codex');
  mkdirSync(codex, { recursive: true });
  writeFileSync(path.join(codex, 'engineering-cycle.json'), JSON.stringify(value));
}

test('missing project configuration uses an effective in-memory standard profile without writes', (t) => {
  const { root, codexHome, env, store } = fixture(t);
  const manifestPath = path.join(root, 'missing-provider', 'provider-manifest.json');

  const config = readConfig(store, { env, providerManifest: manifestPath });

  assert.equal(config.configured, false);
  assert.equal(config.configuration.source, 'builtin');
  assert.equal(config.configuration.effective, true);
  assert.equal(config.configuration.profile_id, 'standard');
  assert.equal(config.configuration.profile_revision, 1);
  assert.equal(config.configuration.digest, config.digest);
  assert.equal(config.configuration.inputs_digest, digest({ project: null, user: null }));
  assert.deepEqual(config.checks, [{ id: 'source-integrity', kind: 'source-integrity' }]);
  assert.equal(config.qa, null);
  assert.equal(config.component_reuse.mode, 'repository');
  assert.equal(config.component_reuse.protocol, 'sol-component-discovery/2');
  assert.deepEqual(config.component_reuse.discovery_scope, { roots: ['.'], files: [] });
  assert.deepEqual(config.component_reuse.budgets, {
    max_sources: 128,
    max_file_bytes: 262144,
    max_total_bytes: 1048576,
    timeout_ms: 30000,
  });
  assert.equal(config.component_reuse.provider.executable, process.execPath);
  assert.equal(config.component_reuse.provider.manifest, manifestPath);
  assert.equal(config.component_reuse.provider.manifest_sha256, null);
  assert.equal(config.component_reuse.provider.available, false);
  assert.deepEqual(config.missing_capabilities, ['component-provider']);
  assert.equal(existsSync(path.join(root, '.codex')), false);
  assert.equal(existsSync(codexHome), false);
});

test('default provider digest comes from the bounded installed manifest bytes', (t) => {
  const { root, env, store } = fixture(t);
  const installed = providerManifest(root);

  const config = readConfig(store, { env, providerManifest: installed.manifestPath });

  assert.equal(config.component_reuse.provider.available, true);
  assert.equal(config.component_reuse.provider.manifest_sha256, sha256(installed.bytes));
  assert.deepEqual(config.missing_capabilities, []);
});

test('an installed but malformed provider manifest is reported as an error', (t) => {
  const { root, env, store } = fixture(t);
  const providerDirectory = path.join(root, 'provider');
  mkdirSync(providerDirectory);
  const manifestPath = path.join(providerDirectory, 'provider-manifest.json');
  writeFileSync(manifestPath, '{invalid json');

  assert.throws(() => readConfig(store, { env, providerManifest: manifestPath }), error => error?.code === 'PROVIDER_UNAVAILABLE');
});

test('rev1 and rev2 validation keep their explicit configuration semantics', (t) => {
  const { root, env, store } = fixture(t);
  const raw = { schema_revision: 1, checks: [{ id: 'unit', argv: ['node', '--test'] }] };
  const validated = validateConfig(raw);
  assert.equal(validated.checks[0].timeout_ms, 30000);
  assert.equal(validated.qa, undefined);

  const codex = path.join(root, '.codex');
  mkdirSync(codex);
  writeFileSync(path.join(codex, 'engineering-cycle.json'), JSON.stringify(raw));
  const config = readConfig(store, { env });

  assert.equal(config.configured, true);
  assert.equal(config.schema_revision, 1);
  assert.deepEqual(config.checks, validated.checks);
  assert.equal(config.component_reuse, undefined);
  assert.equal(config.configuration.source, 'legacy');
  assert.equal(config.configuration.profile_id, 'legacy-v1');
  assert.equal(config.configuration.digest, digest({ config: validated, policy: config.policy }));
  assert.equal(config.configuration.inputs_digest, digest({ project: raw, user: null }));
});

test('rev2 remains an explicit registered configuration without profile merge', (t) => {
  const { root, env, store } = fixture(t);
  const raw = {
    schema_revision: 2,
    checks: [],
    component_reuse: {
      architecture_path: 'architecture.json',
      discovery_scope: { roots: ['src'], files: [] },
      provider: {
        executable: 'node',
        manifest: 'provider/provider-manifest.json',
        manifest_sha256: 'a'.repeat(64),
      },
    },
  };
  const codex = path.join(root, '.codex');
  mkdirSync(codex);
  writeFileSync(path.join(codex, 'engineering-cycle.json'), JSON.stringify(raw));

  const config = readConfig(store, { env });

  assert.equal(config.configured, true);
  assert.equal(config.schema_revision, 2);
  assert.equal(config.component_reuse.required, true);
  assert.equal(config.component_reuse.provider.protocol, 'sol-component-discovery/1');
  assert.deepEqual(config.checks, []);
  assert.equal(config.configuration.profile_id, 'legacy-v2');
  assert.equal(config.policy.revision, 2);
  assert.equal(config.missing_capabilities, undefined);
});

test('rev3 applies user then project sparse overrides with atomic QA and replacement arrays', (t) => {
  const { root, codexHome, env, store } = fixture(t);
  const preferencesDirectory = path.join(codexHome, 'plugins', 'data', 'agent-engineering-cycle');
  mkdirSync(preferencesDirectory, { recursive: true });
  const userPatch = {
    schema_revision: 3,
    profile: 'standard',
    qa: { model: 'user-selected-model' },
    checks: [{ id: 'user-check', kind: 'source-integrity' }],
    component_reuse: { budgets: { max_sources: 64 } },
  };
  writeFileSync(path.join(preferencesDirectory, 'preferences.json'), JSON.stringify(userPatch));
  mkdirSync(path.join(root, '.codex'));
  const projectPatch = {
    schema_revision: 3,
    profile: 'standard',
    qa: { model: 'project-selected-model' },
    checks: [{ id: 'project-check', kind: 'source-integrity' }],
    component_reuse: {
      discovery_scope: { roots: ['.'], files: ['src'] },
      documentation_paths: ['docs/design/current.md'],
    },
  };
  writeFileSync(path.join(root, '.codex', 'engineering-cycle.json'), JSON.stringify(projectPatch));

  const config = readConfig(store, { env, providerManifest: path.join(root, 'missing-provider.json') });

  assert.equal(config.configured, true);
  assert.equal(config.configuration.source, 'project');
  assert.deepEqual(config.configuration.sources, ['builtin', 'user', 'project']);
  assert.deepEqual(config.qa, { model: 'project-selected-model' });
  assert.deepEqual(config.checks, [{ id: 'project-check', kind: 'source-integrity', timeout_ms: 30000 }]);
  assert.deepEqual(config.component_reuse.discovery_scope, { roots: ['.'], files: ['src'] });
  assert.deepEqual(config.component_reuse.documentation_paths, ['docs/design/current.md']);
  assert.deepEqual(config.component_reuse.budgets, {
    max_sources: 64,
    max_file_bytes: 262144,
    max_total_bytes: 1048576,
    timeout_ms: 30000,
  });
  assert.equal(config.configuration.inputs_digest, digest({ project: projectPatch, user: userPatch }));
});

test('existing null, falsy, empty, unknown, and unsupported configuration values are rejected', (t) => {
  const { root, env, store } = fixture(t);
  const codex = path.join(root, '.codex');
  mkdirSync(codex);
  const file = path.join(codex, 'engineering-cycle.json');
  for (const raw of [null, false, 0, '', { schema_revision: 99 }, { schema_revision: 3, profile: 'standard', extra: true }, { schema_revision: 3, profile: 'standard', qa: null }, { schema_revision: 3, profile: 'standard', qa: { model: '' } }, { schema_revision: 3, profile: 'standard', component_reuse: { budgets: { max_sources: 0 } } }]) {
    writeFileSync(file, JSON.stringify(raw));
    assert.throws(() => readConfig(store, { env, providerManifest: path.join(root, 'missing-provider.json') }), error => error?.code === 'EVIDENCE_INVALID');
  }
});

test('malformed preferences are rejected and never created by inspection', (t) => {
  const { root, codexHome, env, store } = fixture(t);
  const preferencesDirectory = path.join(codexHome, 'plugins', 'data', 'agent-engineering-cycle');
  mkdirSync(preferencesDirectory, { recursive: true });
  writeFileSync(path.join(preferencesDirectory, 'preferences.json'), 'null');

  assert.throws(() => readConfig(store, { env, providerManifest: path.join(root, 'missing-provider.json') }), error => error?.code === 'EVIDENCE_INVALID');
  assert.equal(existsSync(path.join(root, '.codex')), false);
});

test('a present but unreadable project config path is never treated as missing', (t) => {
  const { root, env, store } = fixture(t);
  const codex = path.join(root, '.codex');
  mkdirSync(codex);
  mkdirSync(path.join(codex, 'engineering-cycle.json'));

  assert.throws(() => readConfig(store, { env, providerManifest: path.join(root, 'missing-provider.json') }), error => error?.code === 'EVIDENCE_INVALID');
});

test('a provider-validated root architecture declaration derives an exact registered v1 profile', (t) => {
  const { root, env, store } = fixture(t);
  const declaration = registeredDeclaration();
  const declarationBytes = Buffer.from(JSON.stringify(declaration));
  writeFileSync(path.join(root, 'architecture.json'), declarationBytes);
  const installed = providerManifest(root);

  const config = readConfig(store, {
    env,
    providerManifest: installed.manifestPath,
    validateRegisteredDeclaration: registeredValidator(declaration),
  });

  assert.equal(config.configured, false);
  assert.equal(config.component_reuse.mode, 'registered');
  assert.equal(config.component_reuse.protocol, 'sol-component-discovery/1');
  assert.equal(config.component_reuse.architecture_path, 'architecture.json');
  assert.deepEqual(config.component_reuse.discovery_scope, {
    roots: [],
    files: ['architecture.json', 'src/shared.mjs'],
  });
  assert.equal(config.component_reuse.provider.protocol, 'sol-component-discovery/1');
  assert.deepEqual(config.registration_source_fact, {
    path: 'architecture.json',
    sha256: sha256(declarationBytes),
  });
  const effective = {
    schema_revision: config.schema_revision,
    profile: config.profile,
    checks: config.checks,
    qa: config.qa,
    component_reuse: config.component_reuse,
  };
  assert.equal(config.digest, digest({
    config: effective,
    policy: config.policy,
    registration_source_fact: config.registration_source_fact,
  }));
  assert.equal(config.configuration.digest, config.digest);
});

test('same-name but unrecognized architecture files stay repository candidates without the real validator', (t) => {
  const { root, env, store } = fixture(t);
  const declaration = registeredDeclaration();
  const bytes = Buffer.from(JSON.stringify(declaration));
  writeFileSync(path.join(root, 'architecture.json'), bytes);

  const config = readConfig(store, { env, providerManifest: path.join(root, 'missing-provider.json') });

  assert.equal(config.component_reuse.mode, 'repository');
  assert.equal(config.component_reuse.architecture_path, undefined);
  assert.deepEqual(config.component_reuse.discovery_scope, { roots: ['.'], files: [] });
  assert.deepEqual(config.registration_candidate, {
    path: 'architecture.json',
    reason: 'declaration_validator_unavailable',
    source_fact: { path: 'architecture.json', sha256: sha256(bytes) },
  });
  assert.deepEqual(config.missing_capabilities, ['component-provider']);
});

test('invalid automatic declarations remain repository candidates, but explicit registered mode rejects them', (t) => {
  const { root, env, store } = fixture(t);
  const declaration = registeredDeclaration();
  const bytes = Buffer.from(JSON.stringify(declaration));
  writeFileSync(path.join(root, 'architecture.json'), bytes);
  const installed = providerManifest(root);

  const automatic = readConfig(store, {
    env,
    providerManifest: installed.manifestPath,
    validateRegisteredDeclaration: () => { throw new Error('SoL declaration rejected'); },
  });
  assert.equal(automatic.component_reuse.mode, 'repository');
  assert.equal(automatic.component_reuse.architecture_path, undefined);
  assert.equal(automatic.registration_candidate.reason, 'declaration_invalid');
  assert.equal(automatic.registration_candidate.source_fact.sha256, sha256(bytes));

  writeProjectConfig(root, {
    schema_revision: 3,
    profile: 'standard',
    component_reuse: { mode: 'registered' },
  });
  assert.throws(() => readConfig(store, {
    env,
    providerManifest: installed.manifestPath,
    validateRegisteredDeclaration: () => { throw new Error('SoL declaration rejected'); },
  }), error => error?.code === 'EVIDENCE_INVALID');
});

test('explicit registered mode requires the validator and cannot widen source scope', (t) => {
  const { root, env, store } = fixture(t);
  writeFileSync(path.join(root, 'architecture.json'), JSON.stringify(registeredDeclaration()));
  const installed = providerManifest(root);
  writeProjectConfig(root, {
    schema_revision: 3,
    profile: 'standard',
    component_reuse: { mode: 'registered', discovery_scope: { roots: ['src'], files: [] } },
  });

  assert.throws(() => readConfig(store, { env, providerManifest: installed.manifestPath }), error => error?.code === 'PROVIDER_UNAVAILABLE');

  assert.throws(() => readConfig(store, {
    env,
    providerManifest: installed.manifestPath,
    validateRegisteredDeclaration: registeredValidator(),
  }), error => error?.code === 'EVIDENCE_INVALID');
});

test('switching an auto-detected registration to repository mode removes its v1 path and scope', (t) => {
  const { root, env, store } = fixture(t);
  writeFileSync(path.join(root, 'architecture.json'), JSON.stringify(registeredDeclaration()));
  const installed = providerManifest(root);
  writeProjectConfig(root, { schema_revision: 3, profile: 'standard', component_reuse: { mode: 'repository' } });

  const config = readConfig(store, {
    env,
    providerManifest: installed.manifestPath,
    validateRegisteredDeclaration: registeredValidator(),
  });

  assert.equal(config.component_reuse.mode, 'repository');
  assert.equal(config.component_reuse.protocol, 'sol-component-discovery/2');
  assert.equal(config.component_reuse.architecture_path, undefined);
  assert.deepEqual(config.component_reuse.discovery_scope, { roots: ['.'], files: [] });
  assert.equal(config.registration_source_fact, undefined);
});
