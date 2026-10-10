import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hashRegularFile } from './check-plan.mjs';

const JSON_LIMIT = 1024 * 1024;
const EXECUTABLE_LIMIT = 512 * 1024 * 1024;

const PLATFORM_PACKAGE = Object.freeze({
  'win32:x64': { package: '@openai/codex-win32-x64', triple: 'x86_64-pc-windows-msvc', file: 'codex.exe' },
  'win32:arm64': { package: '@openai/codex-win32-arm64', triple: 'aarch64-pc-windows-msvc', file: 'codex.exe' },
  'darwin:x64': { package: '@openai/codex-darwin-x64', triple: 'x86_64-apple-darwin', file: 'codex' },
  'darwin:arm64': { package: '@openai/codex-darwin-arm64', triple: 'aarch64-apple-darwin', file: 'codex' },
  'linux:x64': { package: '@openai/codex-linux-x64', triple: 'x86_64-unknown-linux-musl', file: 'codex' },
  'linux:arm64': { package: '@openai/codex-linux-arm64', triple: 'aarch64-unknown-linux-musl', file: 'codex' },
});

function regularParents(file) {
  let cursor = path.dirname(path.resolve(file));
  while (true) {
    let stat;
    try { stat = fs.lstatSync(cursor); }
    catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Known npm package parents must be regular directories.');
    const parent = path.dirname(cursor);
    if (parent === cursor) return true;
    cursor = parent;
  }
}

function readRegularJson(file) {
  if (!regularParents(file)) return null;
  let before;
  try { before = fs.lstatSync(file); }
  catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size > JSON_LIMIT) throw new Error('Known npm package metadata must be a bounded regular file.');
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) throw new Error('Known npm metadata identity changed before read.');
    const buffer = Buffer.alloc(JSON_LIMIT + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const after = fs.lstatSync(file);
    if (size > JSON_LIMIT || after.isSymbolicLink() || !after.isFile() || after.dev !== opened.dev || after.ino !== opened.ino
      || after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) throw new Error('Known npm metadata changed while read.');
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size));
    const value = JSON.parse(text);
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } finally {
    fs.closeSync(fd);
  }
}

function knownCodexPackageRoots(env) {
  const nodeDirectory = path.dirname(path.resolve(process.execPath));
  const roots = [
    path.join(nodeDirectory, 'node_modules', '@openai', 'codex'),
    path.resolve(nodeDirectory, '..', 'lib', 'node_modules', '@openai', 'codex'),
    path.resolve(nodeDirectory, '..', 'lib', 'nodejs', '@openai', 'codex'),
    path.resolve(nodeDirectory, '..', 'share', 'nodejs', '@openai', 'codex'),
  ];
  if (process.platform === 'win32' && typeof env.APPDATA === 'string' && path.isAbsolute(env.APPDATA)) {
    roots.unshift(path.join(env.APPDATA, 'npm', 'node_modules', '@openai', 'codex'));
  }
  if (process.platform !== 'win32') {
    roots.push(path.join(os.homedir(), '.npm-global', 'lib', 'node_modules', '@openai', 'codex'));
  }
  return [...new Set(roots.map(root => path.resolve(root)))];
}

function nativeMagicMatches(file) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size < 4) return false;
    const bytes = Buffer.alloc(4);
    const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count < 4) return false;
    if (process.platform === 'win32') {
      if (path.extname(file).toLowerCase() !== '.exe' || bytes[0] !== 0x4d || bytes[1] !== 0x5a || stat.size < 64) return false;
      const dosHeader = Buffer.alloc(64);
      if (fs.readSync(fd, dosHeader, 0, dosHeader.length, 0) !== dosHeader.length) return false;
      const peOffset = dosHeader.readUInt32LE(0x3c);
      if (peOffset < 64 || peOffset > 1024 * 1024 || stat.size < peOffset + 4) return false;
      const signature = Buffer.alloc(4);
      return fs.readSync(fd, signature, 0, signature.length, peOffset) === signature.length && signature.equals(Buffer.from([0x50, 0x45, 0, 0]));
    }
    if (process.platform === 'linux') return bytes[0] === 0x7f && bytes.toString('ascii', 1, 4) === 'ELF';
    if (process.platform === 'darwin') return ['cffaedfe', 'feedfacf', 'cafebabe', 'bebafeca'].includes(bytes.toString('hex'));
    return false;
  } finally {
    fs.closeSync(fd);
  }
}

function findNativeCodex(env) {
  const target = PLATFORM_PACKAGE[`${process.platform}:${process.arch}`];
  if (!target) return { executable: null, executable_sha256: null, reason: `No official npm Codex package mapping exists for ${process.platform}/${process.arch}.` };

  const matches = [];
  for (const root of knownCodexPackageRoots(env)) {
    let codexPackage;
    try { codexPackage = readRegularJson(path.join(root, 'package.json')); }
    catch { continue; }
    if (!codexPackage || codexPackage.name !== '@openai/codex') continue;
    const declaredVersion = codexPackage.optionalDependencies?.[target.package];
    if (typeof declaredVersion !== 'string' || !declaredVersion) continue;
    const nativeVersion = declaredVersion.startsWith('npm:@openai/codex@')
      ? declaredVersion.slice('npm:@openai/codex@'.length)
      : declaredVersion;
    const packageName = target.package.slice('@openai/'.length);
    const nativeRoot = path.join(path.dirname(root), packageName);
    let nativePackage;
    try { nativePackage = readRegularJson(path.join(nativeRoot, 'package.json')); }
    catch { continue; }
    if (!nativePackage || nativePackage.name !== target.package || nativePackage.version !== nativeVersion) continue;
    const relativeBase = path.join(nativeRoot, 'vendor', target.triple);
    const possible = [
      { executable: path.join(relativeBase, 'bin', target.file), marker: path.join(relativeBase, 'codex-package.json') },
      { executable: path.join(relativeBase, 'codex', target.file), marker: null },
    ];
    for (const candidate of possible) {
      const { executable, marker } = candidate;
      let executable_sha256;
      try {
        if (marker) hashRegularFile(marker, 64 * 1024);
        executable_sha256 = hashRegularFile(executable, EXECUTABLE_LIMIT);
        if (!nativeMagicMatches(executable)) continue;
      } catch { continue; }
      matches.push({ executable, executable_sha256 });
    }
  }
  const unique = new Map(matches.map(match => [`${match.executable}\0${match.executable_sha256}`, match]));
  if (unique.size === 1) return { ...[...unique.values()][0], reason: null };
  if (unique.size > 1) return { executable: null, executable_sha256: null, reason: 'More than one known official npm Codex executable matched; selection is ambiguous.' };
  return { executable: null, executable_sha256: null, reason: 'Native Codex executable was not found in a known official npm package layout.' };
}

/** Discover a native Codex executable and model candidate; calibration remains a separate core-owned gate. */
export async function discoverQaCandidate({ config, env = process.env, hostModel = null }) {
  if (env === null || typeof env !== 'object' || Array.isArray(env)) throw new TypeError('QA candidate env must be an object.');
  const qa = config?.qa && typeof config.qa === 'object' && !Array.isArray(config.qa) ? config.qa : null;
  const configured = Boolean(qa);
  const selectedModel = typeof qa?.model === 'string' && qa.model.trim()
    ? qa.model
    : typeof hostModel === 'string' && hostModel.trim() ? hostModel : null;
  const modelSource = qa?.model ? 'configuration' : selectedModel ? 'host' : 'none';
  const declared = qa ? { model: qa.model ?? null, executable: qa.executable ?? null, capability_receipt: qa.capability_receipt ?? null } : null;

  let binary;
  let executableSource;
  if (typeof qa?.executable === 'string' && qa.executable.length > 0) {
    executableSource = 'configuration';
    let executable_sha256 = null;
    try {
      executable_sha256 = hashRegularFile(qa.executable, EXECUTABLE_LIMIT);
      if (!nativeMagicMatches(qa.executable)) executable_sha256 = null;
    } catch { /* Keep the declared path visible; the core will report it unavailable. */ }
    binary = { executable: qa.executable, executable_sha256, reason: executable_sha256 ? null : 'Configured QA executable is not a readable native binary.' };
  } else {
    executableSource = 'official-npm-package';
    binary = findNativeCodex(env);
  }

  let reason;
  if (!selectedModel) reason = 'No explicit QA model or host model candidate is available.';
  else if (!binary.executable || !binary.executable_sha256) reason = binary.reason ?? 'No matching native executable candidate is available.';
  else if (qa?.capability_receipt) reason = 'A capability receipt is declared, but matching receipt validation and live calibration are owned by the core.';
  else reason = 'No matching calibrated capability receipt exists; QA is not available.';

  return {
    source: modelSource,
    configuration_source: config?.configuration?.source ?? null,
    model: selectedModel,
    executable: binary.executable,
    executable_sha256: binary.executable_sha256,
    windows_sandbox: qa?.windows_sandbox ?? null,
    configured,
    declared,
    executable_source: executableSource,
    calibrated: false,
    available: false,
    reason,
  };
}
