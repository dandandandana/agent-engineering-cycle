import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { LocalStore } from './local/store.mjs';
import { WorkspaceAdapter } from './local/workspace.mjs';
import { OperatorAuthority } from './local/authority.mjs';
import { readConfig } from './local/config.mjs';
import { qaCapability } from './adapters/qa-cli.mjs';
import { CycleCore } from './core/cycle.mjs';
import { sha256 } from './core/contracts.mjs';
import { nativeWriteTargets } from './local/host-context.mjs';
import { createStandardProfile } from './local/default-profile.mjs';
import { providerIdentity } from './adapters/component-provider.mjs';
import {
  boundedHookResponse,
  HookSessionLedger,
  isValidHostSessionId,
  projectHookContext,
} from './local/hook-context.mjs';

export async function createRuntime({ workspaceRoot = process.cwd(), faultInjector, env = process.env, hostModel = null, configurationOptions = {} } = {}) {
  const options = { env, ...configurationOptions };
  // Only a real declaration candidate needs the bundled pure validator. Import
  // pinned code after checking its complete distribution; never run the index.
  if (!options.validateRegisteredDeclaration && fs.existsSync(path.join(workspaceRoot, 'architecture.json'))) {
    const profile = createStandardProfile({ providerManifest: options.providerManifest });
    if (profile.component_reuse.provider.available) {
      await providerIdentity(profile, { verifyFiles: true });
      const helper = path.join(path.dirname(profile.component_reuse.provider.manifest), 'src/architecture/index.mjs');
      const manifest = JSON.parse(fs.readFileSync(profile.component_reuse.provider.manifest, 'utf8'));
      if (manifest.files.some(f => f.path === 'src/architecture/index.mjs')) {
        const module = await import(pathToFileURL(helper).href);
        if (typeof module.validateArchitectureDeclaration === 'function') options.validateRegisteredDeclaration = module.validateArchitectureDeclaration;
      }
    }
  }
  let store = new LocalStore(workspaceRoot);
  const initial = readConfig(store, options);
  const existing = store.current();
  // New defaults use one physical spelling even when TEMP is an 8.3 alias.
  // Legacy active cycles retain their local namespace; signed grants still verify at this root.
  if (initial.schema_revision === 3 && (!existing || (existing.contract_revision ?? 1) === 3)) store = new LocalStore(fs.realpathSync.native(workspaceRoot));
  if (existing && (existing.contract_revision ?? 1) < 3 && /^[a-f0-9]{64}$/.test(existing.workspace_id ?? '')) store.workspaceId = existing.workspace_id;
  const workspace = new WorkspaceAdapter(store.root); const authority = new OperatorAuthority(store);
  const config = readConfig(store, options); const cli = qaCapability(store, authority, config);
  const capabilities = { local_store: process.platform === 'win32' && !store.root.startsWith('\\\\'), tested_platform: 'win32 local filesystem / Node 24', authority: 'interactive-operator signed receipts; no MCP approval minting', qa_driver: cli.available, qa: cli, native_subagent: false, hook_coverage: 'matched writes only', stop_continuation: false };
  const core = new CycleCore({ store, workspace, authority, capabilities, faultInjector, configurationOptions: options, hostModel });
  const hookLedger = new HookSessionLedger({ workspaceRoot: store.root, directory: store.directory });

  function bindHostSession(hostSessionId, cycleId) {
    return hookLedger.bindHostSession(hostSessionId, cycleId);
  }

  async function invoke(name, args, options) {
    const session = options?.hostSessionId;
    if (isValidHostSessionId(session)) {
      const current = store.current();
      const membership = hookLedger.lookup(session);
      const joined = current && membership.cycle_id === current.id;
      if (current && !joined && name === 'cycle_status' && !args?.cycle_id && !args?.evidence_id) {
        return { ...(await core.view(null)), active_cycle: { cycle_id: current.id, lifecycle: current.lifecycle, writable_binding: false }, next: ['Inspect this cycle explicitly for audit; resume with its current binding and existing permission before joining it.'] };
      }
      const readOnly = name === 'cycle_status' || name === 'cycle_artifact' && args?.action === 'prepare' || name === 'cycle_qa' && args?.action === 'status';
      if (current && !joined && !readOnly && !(name === 'cycle_control' && ['begin', 'resume'].includes(args?.action))) {
        return { ok: false, binding: null, error: { code: 'SESSION_UNBOUND', message: 'Explicitly join this cycle through authorized begin/resume before persistent work.' } };
      }
    }
    // Preserve transport options exactly; the session value remains routing metadata only.
    const response = await core.invoke(name, args, options);
    if (name !== 'cycle_control'
      || !['begin', 'resume'].includes(args?.action)
      || response?.ok !== true
      || response.duplicate === true
      || response.lifecycle !== 'active'
      || !isValidHostSessionId(options?.hostSessionId)) return response;

    const cycleId = response.binding?.cycle_id;
    if (typeof cycleId !== 'string' || !args?.request_id) return response;
    try {
      const operation = store.operation(args.request_id);
      if (operation?.phase === 'settled'
        && operation.effects_known === true
        && operation.request_id === args.request_id
        && operation.tool === name
        && operation.cycle_id === cycleId) {
        bindHostSession(options.hostSessionId, cycleId);
      }
    } catch {
      // Session routing is best-effort and never changes the settled cycle result.
    }
    return response;
  }

  async function handleHook(event) {
    const hookEventName = event?.hook_event_name;
    if (!['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'Stop'].includes(hookEventName)) return {};
    if (event.cwd) {
      try { const eventRoot = fs.realpathSync.native(event.cwd); const currentRoot = fs.realpathSync.native(store.root); if (process.platform === 'win32' ? eventRoot.toLowerCase() !== currentRoot.toLowerCase() : eventRoot !== currentRoot) return {}; }
      catch { return {}; }
    }
    if (hookEventName === 'Stop') return {};

    if (hookEventName === 'PreToolUse') {
      if (!/^(apply_patch|Edit|Write)$/.test(event.tool_name ?? '')) return {};
      const state = store.current();
      if (!state || !['active', 'interrupted'].includes(state.lifecycle)) return {};
      const targets = nativeWriteTargets(event);
      const samePath = (a, b) => process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
      const intersects = targets?.some(target => state.scope.some(p => samePath(path.resolve(store.root, target), path.resolve(store.root, p))));
      const joined = isValidHostSessionId(event.session_id) && hookLedger.lookup(event.session_id).cycle_id === state.id;
      if (intersects || targets === null && joined) {
        return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Use cycle_apply with the current binding; the backend rechecks scope and permission.' } };
      }
      return {};
    }

    if (!isValidHostSessionId(event.session_id)) {
      return {};
    }
    const route = hookLedger.lookup(event.session_id);
    if (!route.cycle_id) {
      return route.diagnostic && route.diagnostic !== 'SESSION_UNBOUND' ? boundedHookResponse(hookEventName, { tool: 'cycle_status', diagnostic: route.diagnostic }) : {};
    }
    const current = store.current();
    if (!current || route.cycle_id !== current.id || !['active', 'interrupted'].includes(current.lifecycle)) return {};

    // Explicitly scope status to the cycle mapped to this host session. If it is no longer
    // current, discard the response entirely so another task's state cannot enter this Hook.
    let state;
    try {
      state = await core.invoke('cycle_status', { cycle_id: route.cycle_id });
    } catch {
      return boundedHookResponse(hookEventName, {
        tool: 'cycle_status', action: 'inspect-current-cycle', diagnostic: 'HOOK_STATUS_UNAVAILABLE',
      });
    }
    if (!state?.ok || state.binding?.cycle_id !== route.cycle_id) {
      return boundedHookResponse(hookEventName, {
        tool: 'cycle_status', action: 'inspect-current-cycle', diagnostic: 'SESSION_UNBOUND',
      });
    }
    const projection = projectHookContext(state, { sessionHash: route.session_hash });
    if (!projection) {
      return boundedHookResponse(hookEventName, {
        tool: 'cycle_status', action: 'inspect-current-cycle', diagnostic: 'SESSION_UNBOUND',
      });
    }
    const semanticFingerprint = sha256(JSON.stringify(projection.semantic));
    const decision = hookLedger.decideEmission(event.session_id, route.cycle_id, semanticFingerprint, {
      eventName: hookEventName,
      source: event.source,
    });
    if (decision.mode === 'fallback') {
      return boundedHookResponse(hookEventName, {
        tool: 'cycle_status', action: 'inspect-current-cycle', diagnostic: decision.diagnostic,
      });
    }
    if (decision.mode === 'suppress') return {};
    if (decision.mode === 'minimal') {
      return boundedHookResponse(hookEventName, { tool: 'cycle_status', action: 'inspect-current-cycle' });
    }
    return boundedHookResponse(hookEventName, projection.display);
  }

  return {
    invoke,
    handleHook,
    bindHostSession,
    core, store, workspace, authority,
  };
}
