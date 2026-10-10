import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { digest, fault } from '../core/contracts.mjs';

export const PLUGIN_IDENTITY = 'agent-engineering-cycle@engineering-cycle-local';
export const ROUTE_CONTRACT = 1;

/** Plugin-owned preferences/transport data; calling this never creates files. */
export function resolvePluginDataDirectory({ env = process.env } = {}) {
  const selected = env.CODEX_HOME;
  if (selected !== undefined && (typeof selected !== 'string' || !selected.trim())) {
    throw fault('CONTEXT_REQUIRED', 'CODEX_HOME must identify a non-empty local directory.');
  }
  return path.join(path.resolve(selected ?? path.join(os.homedir(), '.codex')), 'plugins', 'data', 'agent-engineering-cycle');
}

/** Address namespace is a local identity, never permission or a host field. */
export function pluginStorageNamespace({ env = process.env } = {}) {
  const data = resolvePluginDataDirectory({ env });
  const home = path.resolve(data, '../../..');
  let physical;
  try {
    const stat = fs.lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('not a regular directory');
    physical = fs.realpathSync.native(home);
  } catch {
    throw fault('CONTEXT_REQUIRED', 'The Codex data directory is unavailable for project routing.');
  }
  const stat = fs.statSync(physical);
  return digest({ home: process.platform === 'win32' ? physical.toLowerCase() : physical, device: stat.dev, inode: stat.ino, plugin: PLUGIN_IDENTITY, route_contract: ROUTE_CONTRACT });
}
