import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONTENTS = ['src', 'hooks', 'skills', 'node_modules', 'package.json', 'package-lock.json', 'mcp.json'];

function assertRegularTree(entry) {
  const stat = fs.lstatSync(entry);
  if (stat.isSymbolicLink() || !(stat.isFile() || stat.isDirectory())) throw new Error(`Package input is not a regular file/directory: ${entry}`);
  if (stat.isDirectory()) for (const child of fs.readdirSync(entry)) assertRegularTree(path.join(entry, child));
}

function assertProviderSource(sourceRoot) {
  const cursor = path.resolve(sourceRoot);
  const sourceStat = fs.lstatSync(cursor);
  if (sourceStat.isSymbolicLink() || !sourceStat.isDirectory()) throw new Error('Provider source must be an existing regular directory.');
  const builder = path.join(cursor, 'scripts', 'package-provider.mjs');
  const builderStat = fs.lstatSync(builder);
  if (builderStat.isSymbolicLink() || !builderStat.isFile()) throw new Error('Provider source must contain scripts/package-provider.mjs as a regular file.');
  return { sourceRoot: cursor, builder };
}

function safeProviderPath(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024
    && !value.includes('\\') && !value.includes(':') && !value.startsWith('/')
    && value.split('/').every(part => part && part !== '.' && part !== '..');
}

function collectProviderFiles(root, current = '', files = []) {
  const directory = current ? path.join(root, ...current.split('/')) : root;
  for (const child of fs.readdirSync(directory).sort((a, b) => a.localeCompare(b))) {
    const relative = current ? `${current}/${child}` : child;
    const absolute = path.join(root, ...relative.split('/'));
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) throw new Error(`Provider package unexpectedly contains a symbolic link: ${relative}`);
    if (stat.isDirectory()) collectProviderFiles(root, relative, files);
    else if (stat.isFile()) files.push(relative);
    else throw new Error(`Provider package contains a non-regular entry: ${relative}`);
  }
  return files;
}

function verifyProviderBundle(directory) {
  assertRegularTree(directory);
  const manifestPath = path.join(directory, 'provider-manifest.json');
  const manifestStat = fs.lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > 4 * 1024 * 1024) throw new Error('Provider manifest must be a bounded regular file.');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifestKeys = ['schema_revision', 'protocol', 'protocols', 'modes', 'entry', 'files'];
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
    || Object.keys(manifest).sort().join(',') !== [...manifestKeys].sort().join(',')
    || manifest.schema_revision !== 1
    || manifest.protocol !== 'sol-component-discovery/1'
    || JSON.stringify(manifest.protocols) !== JSON.stringify(['sol-component-discovery/1', 'sol-component-discovery/2'])
    || JSON.stringify(manifest.modes) !== JSON.stringify(['registered', 'repository'])
    || manifest.entry !== 'src/provider-server.mjs'
    || !Array.isArray(manifest.files) || manifest.files.length === 0 || manifest.files.length > 20_000) {
    throw new Error('Provider manifest does not identify the fixed public read-only provider contract.');
  }
  const seen = new Set();
  let totalBytes = 0;
  for (const item of manifest.files) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).sort().join(',') !== 'bytes,path,sha256'
      || !safeProviderPath(item.path) || item.path === 'provider-manifest.json' || seen.has(item.path)
      || !Number.isSafeInteger(item.bytes) || item.bytes < 0 || item.bytes > 64 * 1024 * 1024
      || !/^[a-f0-9]{64}$/u.test(item.sha256 ?? '')) {
      throw new Error('Provider manifest contains an invalid file identity.');
    }
    seen.add(item.path);
    totalBytes += item.bytes;
    if (totalBytes > 512 * 1024 * 1024) throw new Error('Provider package exceeds the verification byte budget.');
    const absolute = path.join(directory, ...item.path.split('/'));
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== item.bytes) throw new Error(`Provider manifest file is missing or changed: ${item.path}`);
    const bytes = fs.readFileSync(absolute);
    if (createHash('sha256').update(bytes).digest('hex') !== item.sha256) throw new Error(`Provider manifest SHA-256 mismatch: ${item.path}`);
  }
  const actual = collectProviderFiles(directory).filter(file => file !== 'provider-manifest.json').sort();
  const listed = [...seen].sort();
  if (actual.length !== listed.length || actual.some((file, index) => file !== listed[index])) throw new Error('Provider manifest does not cover the complete packaged file closure.');
  for (const required of ['package.json', 'package-lock.json', 'runtime.schema.json', manifest.entry]) {
    if (!seen.has(required)) throw new Error(`Provider manifest does not include required runtime file ${required}.`);
  }
  const prohibited = /^(?:src\/(?:server|runtime|managed-write|patch|plugin-launcher|workspace|apply|write|cycle)\.mjs|hooks?\/|skills?\/|\.codex-plugin\/)/iu;
  if ([...seen].some(file => prohibited.test(file))) throw new Error('Provider bundle contains a plugin/controller or write-entry file.');
  const packageJson = JSON.parse(fs.readFileSync(path.join(directory, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(fs.readFileSync(path.join(directory, 'package-lock.json'), 'utf8'));
  if (packageJson.name !== 'codex-sol-provider' || packageJson.private !== true
    || packageLock.packages?.['']?.name !== 'codex-sol-provider') throw new Error('Provider package metadata does not identify the independent provider artifact.');
  return manifest;
}

function buildProvider(sourceRoot, target) {
  const { sourceRoot: root, builder } = assertProviderSource(sourceRoot);
  const result = spawnSync(process.execPath, [builder, '--out', path.join(target, 'provider')], {
    cwd: root,
    shell: false,
    windowsHide: true,
    timeout: 120_000,
    maxBuffer: 4 * 1024 * 1024,
    encoding: 'utf8',
  });
  if (result.error) throw new Error(`Provider bundle build failed to start or timed out: ${result.error.message}`);
  if (result.status !== 0 || result.signal !== null) {
    const diagnostic = [result.stderr, result.stdout].filter(Boolean).join('\n').trim();
    throw new Error(`Provider bundle build failed (status=${result.status}, signal=${result.signal ?? 'none'}).${diagnostic ? ` ${diagnostic}` : ''}`);
  }
  let report;
  try { report = JSON.parse(result.stdout.trim()); }
  catch { throw new Error('Provider bundle builder did not return its expected JSON completion record.'); }
  let reportedOutput = null;
  let expectedOutput = null;
  if (typeof report.out === 'string') {
    try {
      reportedOutput = fs.realpathSync.native(path.resolve(report.out));
      expectedOutput = fs.realpathSync.native(path.join(target, 'provider'));
    } catch { /* A successful record must refer to an existing output directory. */ }
  }
  const sameOutput = reportedOutput !== null && expectedOutput !== null && (process.platform === 'win32'
    ? reportedOutput.toLowerCase() === expectedOutput.toLowerCase()
    : reportedOutput === expectedOutput);
  if (report.status !== 'packaged' || !sameOutput) throw new Error(`Provider bundle builder completion record does not match the requested output (reported=${String(report.out)}, expected=${path.join(target, 'provider')}).`);
  return verifyProviderBundle(path.join(target, 'provider'));
}

/** Package the same runtime for portable clients or Codex's native hook loader. Never overwrite an existing destination. */
export function packagePlugin(destination, { format = 'codex', providerSource } = {}) {
  if (!['codex', 'portable'].includes(format)) throw new Error('Package format must be codex or portable.');
  if (providerSource !== undefined && (typeof providerSource !== 'string' || !providerSource.trim())) throw new Error('providerSource must name a provider source directory.');
  const providerRoot = path.resolve(providerSource ?? path.resolve(ROOT, '..', 'codex-sol'));
  assertProviderSource(providerRoot);
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new Error('Package destination already exists; choose a new directory.');
  let ancestor = path.dirname(target);
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (!fs.lstatSync(ancestor).isDirectory() || fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Package destination ancestor must be a regular directory.');
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'plugin.json'), 'utf8'));
  for (const name of CONTENTS) assertRegularTree(path.join(ROOT, name));
  fs.mkdirSync(target, { recursive: true });
  for (const name of CONTENTS) fs.cpSync(path.join(ROOT, name), path.join(target, name), { recursive: true, errorOnExist: true, force: false });
  buildProvider(providerRoot, target);
  if (format === 'codex') {
    // Codex 0.158.0 deliberately skips AgentPlugin hook sources. A root
    // plugin.json also takes precedence over the native manifest, so this
    // distribution contains only the generated native manifest.
    const directory = path.join(target, '.codex-plugin');
    fs.mkdirSync(directory);
    fs.writeFileSync(path.join(directory, 'plugin.json'), JSON.stringify({
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      hooks: manifest.extensions['com.openai'].hooks,
      mcpServers: './.mcp.json',
    }, null, 2) + '\n', { flag: 'wx' });
    const portable = JSON.parse(fs.readFileSync(path.join(ROOT, 'mcp.json'), 'utf8'));
    const server = portable.mcpServers['agent-engineering-cycle'];
    fs.writeFileSync(path.join(target, '.mcp.json'), JSON.stringify({ mcpServers: {
      'agent-engineering-cycle': {
        command: server.command,
        args: server.args.map(arg => arg.replace(/^\$\{PLUGIN_ROOT\}\//, '')),
        cwd: '.',
        env_vars: ['CODEX_HOME', 'CYCLE_WORKSPACE'],
      },
    } }, null, 2) + '\n', { flag: 'wx' });
  } else fs.copyFileSync(path.join(ROOT, 'plugin.json'), path.join(target, 'plugin.json'), fs.constants.COPYFILE_EXCL);
  return { format, destination: target, name: manifest.name, version: manifest.version };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const parsed = {};
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const key = flag === '--out' ? 'out' : flag === '--format' ? 'format' : flag === '--provider-source' ? 'providerSource' : null;
    const value = args[index + 1];
    if (!key || Object.hasOwn(parsed, key) || typeof value !== 'string' || !value.trim() || value.startsWith('--')) {
      throw new Error('Use --out <new-directory> [--format codex|portable] [--provider-source <source-root>]. Run npm ci first.');
    }
    parsed[key] = value;
    index += 1;
  }
  if (!parsed.out) throw new Error('Use --out <new-directory> [--format codex|portable] [--provider-source <source-root>]. Run npm ci first.');
  console.log(JSON.stringify(packagePlugin(parsed.out, {
    format: parsed.format ?? 'codex',
    ...(parsed.providerSource === undefined ? {} : { providerSource: parsed.providerSource }),
  })));
}
