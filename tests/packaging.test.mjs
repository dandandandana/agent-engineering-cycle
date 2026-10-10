import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { packagePlugin } from '../scripts/package-plugin.mjs';

test('Codex package bundles the verified public provider and routes through the auto-workspace server', { timeout: 120_000 }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-package-'));
  const clients = [];
  t.after(async () => {
    for (const client of clients) await client.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  });
  const bundle = path.join(root, 'bundle');
  packagePlugin(bundle);
  assert.equal(fs.existsSync(path.join(bundle, 'plugin.json')), false);
  const native = JSON.parse(fs.readFileSync(path.join(bundle, '.codex-plugin', 'plugin.json'), 'utf8'));
  const hooks = JSON.parse(fs.readFileSync(path.join(bundle, native.hooks), 'utf8'));
  const mcp = JSON.parse(fs.readFileSync(path.join(bundle, native.mcpServers), 'utf8'));
  assert.deepEqual(Object.keys(hooks.hooks).sort(), ['PreToolUse', 'SessionStart', 'Stop', 'UserPromptSubmit']);
  assert.deepEqual(Object.keys(mcp.mcpServers), ['agent-engineering-cycle']);
  assert.deepEqual(mcp.mcpServers['agent-engineering-cycle'].args, ['src/server.mjs', '--auto-workspace']);
  assert.equal(mcp.mcpServers['agent-engineering-cycle'].cwd, '.');
  assert.deepEqual(mcp.mcpServers['agent-engineering-cycle'].env_vars, ['CODEX_HOME', 'CYCLE_WORKSPACE']);
  const portable = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../mcp.json', import.meta.url)), 'utf8'));
  assert.deepEqual(portable.mcpServers['agent-engineering-cycle'].args, ['${PLUGIN_ROOT}/src/server.mjs', '--auto-workspace']);
  assert.ok(fs.existsSync(path.join(bundle, 'node_modules', 'zod', 'package.json')));
  assert.equal(fs.existsSync(path.join(bundle, '.codex')), false);
  assert.equal(fs.existsSync(path.join(bundle, 'slop')), false);
  assert.deepEqual(fs.readdirSync(path.join(bundle, 'skills')).sort(), fs.readdirSync(fileURLToPath(new URL('../skills/', import.meta.url))).sort());

  const manifestPath = path.join(bundle, 'provider', 'provider-manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  assert.deepEqual(Object.keys(manifest).sort(), ['entry', 'files', 'modes', 'protocol', 'protocols', 'schema_revision'].sort());
  assert.equal(manifest.schema_revision, 1);
  assert.equal(manifest.protocol, 'sol-component-discovery/1');
  assert.deepEqual(manifest.protocols, ['sol-component-discovery/1', 'sol-component-discovery/2']);
  assert.deepEqual(manifest.modes, ['registered', 'repository']);
  assert.equal(manifest.entry, 'src/provider-server.mjs');
  const providerFiles = new Set(manifest.files.map(file => file.path));
  assert.ok(providerFiles.has('package.json'));
  assert.ok(providerFiles.has('package-lock.json'));
  assert.ok(providerFiles.has('runtime.schema.json'));
  assert.ok(providerFiles.has(manifest.entry));
  assert.equal(providerFiles.has('provider-manifest.json'), false);
  assert.equal([...providerFiles].some(file => /(?:^|\/)(?:server|runtime|managed-write|patch|plugin-launcher|workspace|apply|write|cycle)\.mjs$/iu.test(file)), false);
  for (const file of manifest.files) {
    const bytes = fs.readFileSync(path.join(bundle, 'provider', ...file.path.split('/')));
    assert.equal(bytes.length, file.bytes, file.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, file.path);
  }

  // The packaged provider serves only SoL's three read tools over its native MCP transport.
  const workspace = fs.mkdtempSync(path.join(root, 'provider-workspace-'));
  const cache = fs.mkdtempSync(path.join(root, 'provider-cache-'));
  fs.mkdirSync(path.join(workspace, 'src'));
  fs.writeFileSync(path.join(workspace, 'architecture.json'), '{}\n');
  const providerConfig = path.join(root, 'provider-config.json');
  fs.writeFileSync(providerConfig, JSON.stringify({ architecture_path: 'architecture.json', discovery_scope: { roots: ['src'], files: ['architecture.json'] } }));
  const providerTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(bundle, 'provider', manifest.entry), '--workspace', workspace, '--config', providerConfig, '--cache-root', cache],
    cwd: workspace,
    env: { ...process.env },
    stderr: 'pipe',
  });
  const providerClient = new Client({ name: 'packaged-provider-test', version: '1' });
  clients.push(providerClient);
  await providerClient.connect(providerTransport);
  const tools = await providerClient.listTools();
  assert.deepEqual(tools.tools.map(tool => tool.name).sort(), ['sol_architecture_query', 'sol_read_file', 'sol_recall']);

  // Inspect a packaged no-config plugin against an explicitly selected empty project.
  const project = fs.mkdtempSync(path.join(root, 'empty-project-'));
  const codexHome = path.join(root, 'codex-home');
  const cycleTransport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(bundle, 'src', 'server.mjs'), '--workspace', project],
    cwd: bundle,
    env: { ...process.env, CODEX_HOME: codexHome },
    stderr: 'pipe',
  });
  const cycleClient = new Client({ name: 'packaged-default-profile-test', version: '1' });
  clients.push(cycleClient);
  await cycleClient.connect(cycleTransport);
  const statusResult = await cycleClient.callTool({ name: 'cycle_status', arguments: {} });
  const status = statusResult.structuredContent ?? JSON.parse(statusResult.content[0].text);
  assert.equal(statusResult.isError, false);
  assert.equal(status.configured, false);
  assert.equal(status.configuration.effective, true);
  assert.equal(status.configuration.profile_id, 'standard');
  assert.equal(status.configuration.profile_revision, 1);
  assert.equal(fs.existsSync(path.join(project, '.codex')), false);
  assert.equal(fs.existsSync(codexHome), false);

  const original = fs.readFileSync(path.join(bundle, native.hooks));
  assert.throws(() => packagePlugin(bundle), /already exists/);
  assert.deepEqual(fs.readFileSync(path.join(bundle, native.hooks)), original);

  const portableBundle = path.join(root, 'portable-bundle');
  packagePlugin(portableBundle, { format: 'portable' });
  assert.equal(fs.existsSync(path.join(portableBundle, 'plugin.json')), true);
  assert.equal(fs.existsSync(path.join(portableBundle, '.codex-plugin')), false);
  const portableManifest = JSON.parse(fs.readFileSync(path.join(portableBundle, 'mcp.json'), 'utf8'));
  assert.deepEqual(portableManifest.mcpServers['agent-engineering-cycle'].args, ['${PLUGIN_ROOT}/src/server.mjs', '--auto-workspace']);
  assert.equal(fs.existsSync(path.join(portableBundle, 'provider', 'provider-manifest.json')), true);
});

test('provider build failures retain the partial package for diagnosis', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-package-failure-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const providerSource = path.join(root, 'provider-source');
  fs.mkdirSync(path.join(providerSource, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(providerSource, 'scripts', 'package-provider.mjs'), [
    "import fs from 'node:fs';",
    "fs.mkdirSync(process.argv[3], { recursive: true });",
    "fs.writeFileSync(process.argv[3] + '/partial.txt', 'diagnostic');",
    "process.stderr.write('sentinel provider failure\\n');",
    'process.exitCode = 7;',
  ].join('\n'));

  const destination = path.join(root, 'partial-bundle');
  assert.throws(() => packagePlugin(destination, { providerSource }), /Provider bundle build failed \(status=7, signal=none\).*sentinel provider failure/u);
  assert.equal(fs.readFileSync(path.join(destination, 'provider', 'partial.txt'), 'utf8'), 'diagnostic');
  assert.equal(fs.existsSync(path.join(destination, 'provider', 'provider-manifest.json')), false);

  const cliDestination = path.join(root, 'cli-partial-bundle');
  const cli = fileURLToPath(new URL('../scripts/package-plugin.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, '--out', cliDestination, '--provider-source', providerSource], {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    shell: false,
    windowsHide: true,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /sentinel provider failure/u);
  assert.equal(fs.readFileSync(path.join(cliDestination, 'provider', 'partial.txt'), 'utf8'), 'diagnostic');
});
