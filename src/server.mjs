import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { TOOL_NAMES, TOOL_SCHEMAS, safeError, fault } from './core/contracts.mjs';
import { createRuntime } from './runtime.mjs';
import { HostContextStore, hostContextFromMetadata } from './local/host-context.mjs';

const TOOL_DESCRIPTIONS = {
  cycle_control: 'Begin, resume, abandon, or finish the current engineering cycle. Decision and grant references are checked by the runtime; they are not authorization by themselves.',
  cycle_status: 'Inspect the current cycle, evidence freshness, pending operations, blockers, and next safe action without starting checks or replaying work.',
  cycle_artifact: 'Prepare or attach a bounded R, D, I, or Delta source reference. Enabled D discover returns verified reuse_selection candidates, caller paths/import hints and source line counts; D read returns source_view snippets. Consume complete structured views for normal selection; raw archives are for explicit audit, not repeated reconstruction. Prepare failures include bounded diagnostic causes and missing source paths. I may link implementation notes; source identities, permissions and semantic QA remain required.',
  cycle_apply: 'Apply only exact, runtime-validated workspace targets and report observed effects. A failed response does not imply that nothing changed.',
  cycle_verify: 'Run configured fixed checks by check ID. This tool does not accept arbitrary shell commands or mark the engineering cycle complete.',
  cycle_qa: 'Start, inspect, or cancel a controlled QA job. Report only the assurance and execution facts returned by the runtime.',
  cycle_reconcile: 'Record Delta, decision-reference, and authority-writeback progress. Model-supplied approval fields do not establish approval or action permission.',
};

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asToolResult(value) {
  if (!isRecord(value) || typeof value.ok !== 'boolean') {
    throw new TypeError('The cycle runtime returned an invalid tool result.');
  }

  const text = JSON.stringify(value);
  if (typeof text !== 'string') throw new TypeError('The cycle runtime returned a non-JSON result.');
  const structuredContent = JSON.parse(text);
  return {
    content: [{ type: 'text', text }],
    structuredContent,
    isError: structuredContent.ok === false,
  };
}

function safeFailure(error) {
  return {
    ok: false,
    error: error?.name === 'CycleError' ? safeError(error) : {
      code: 'RUNTIME_FAILURE',
      message: 'The cycle runtime could not complete this request safely.',
    },
  };
}

function assertToolContracts() {
  if (!Array.isArray(TOOL_NAMES) || TOOL_NAMES.length !== 7 || new Set(TOOL_NAMES).size !== 7) {
    throw new TypeError('The cycle tool contract must contain exactly seven unique names.');
  }
  for (const name of TOOL_NAMES) {
    if (!Object.hasOwn(TOOL_DESCRIPTIONS, name) || !TOOL_SCHEMAS[name]) {
      throw new TypeError('The cycle tool contract is missing a schema or description.');
    }
  }
  if (Object.keys(TOOL_DESCRIPTIONS).length !== 7) {
    throw new TypeError('The cycle server contains an unexpected tool description.');
  }
}

/** Codex transport metadata routes a task; it never mints operator authority. */
export function hostSessionFromMetadata(metadata) {
  return hostContextFromMetadata(metadata)?.session_id ?? null;
}

export function createCycleServer({ runtime } = {}) {
  assertToolContracts();
  if (!runtime || typeof runtime.invoke !== 'function') {
    throw new TypeError('createCycleServer requires a runtime with invoke().');
  }

  const server = new McpServer({ name: 'agent-engineering-cycle', version: '0.1.0' }, {
    instructions: 'Use cycle_status to inspect the current program facts before resuming interrupted work. Runtime errors are not proof of zero side effects; query the same operation before any retry. Tool availability, Hook configuration, and successful schema validation do not establish user approval, QA independence, or host coverage.',
  });

  for (const name of TOOL_NAMES) {
    server.registerTool(name, {
      title: name,
      description: TOOL_DESCRIPTIONS[name],
      inputSchema: TOOL_SCHEMAS[name],
      annotations: name === 'cycle_status'
        ? { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
        : { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
    }, async (input, context) => {
      try {
        const hostContext = hostContextFromMetadata(context?.mcpReq?._meta);
        return asToolResult(await runtime.invoke(name, input, { signal: context?.mcpReq?.signal, hostSessionId: hostContext?.session_id ?? null, hostContext }));
      } catch (error) {
        return asToolResult(safeFailure(error));
      }
    });
  }

  return server;
}

function parseWorkspaceArgument(argv) {
  let selected; let automatic = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    let value;
    if (argument === '--auto-workspace') {
      if (automatic) throw new TypeError('--auto-workspace must be provided once.');
      automatic = true;
      continue;
    } else if (argument === '--workspace') {
      value = argv[index + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new TypeError('--workspace requires a path.');
      }
      index += 1;
    } else if (argument.startsWith('--workspace=')) {
      value = argument.slice('--workspace='.length);
    } else {
      throw new TypeError('The cycle MCP server received an unsupported option.');
    }
    if (!value.trim() || selected !== undefined) {
      throw new TypeError('--workspace must be provided once with a non-empty path.');
    }
    selected = value;
  }
  return { selected, automatic };
}

function samePath(left, right) {
  const normalizedLeft = realpathSync.native(resolve(left));
  const normalizedRight = realpathSync.native(resolve(right));
  return process.platform === 'win32'
    ? normalizedLeft.toLocaleLowerCase('en-US') === normalizedRight.toLocaleLowerCase('en-US')
    : normalizedLeft === normalizedRight;
}

function configuredWorkspaceRoot(env, argv, cwd) {
  const configured = env.CYCLE_WORKSPACE;
  if (configured !== undefined && configured.trim() === '') {
    throw new TypeError('CYCLE_WORKSPACE must be a non-empty path when set.');
  }
  const { selected: argument, automatic } = parseWorkspaceArgument(argv);
  if (configured !== undefined && argument !== undefined && !samePath(configured, argument)) {
    throw new TypeError('CYCLE_WORKSPACE conflicts with --workspace.');
  }
  return { workspaceRoot: argument !== undefined || configured !== undefined ? resolve(argument ?? configured) : automatic ? null : resolve(cwd), automatic };
}

/** Current-turn addresses select runtimes; no project, grant or current-cycle state is copied. */
export function createWorkspaceRouter({ workspaceRoot = null, env = process.env, runtimeFactory = createRuntime } = {}) {
  return {
    async invoke(name, input, options = {}) {
      let address = null;
      let routeError = null;
      if (options.hostContext) {
        try { address = new HostContextStore({ env }).lookup(options.hostContext); }
        catch (error) { routeError = error; }
      }
      if (routeError && routeError.code !== 'CONTEXT_REQUIRED') throw routeError;
      if (workspaceRoot && address && !samePath(workspaceRoot, address.root)) throw fault('WORKSPACE_CONFLICT', 'The explicit workspace conflicts with current-turn Hook context.');
      const root = workspaceRoot ?? address?.root;
      if (!root) {
        if (name !== 'cycle_status') throw routeError ?? fault('CONTEXT_REQUIRED', 'Select the current project before using the engineering cycle.');
        return { ok: true, status: 'context_required', binding: null, configured: false,
          project: { status: 'context_required', automatic: true },
          configuration: { source: 'builtin', profile_id: 'standard', profile_revision: 1, effective: false },
          next: ['Enable current-turn Hook context, or select this project through --workspace/CYCLE_WORKSPACE once.'],
          coverage_limits: ['No project was guessed from the plugin directory or a previous turn.'] };
      }
      const runtime = await runtimeFactory({ workspaceRoot: root, env, hostModel: address?.model ?? null });
      const value = await runtime.invoke(name, input, options);
      return { ...value, project: { status: 'located', root: runtime.store?.root ?? root, source: workspaceRoot ? 'explicit' : address.source } };
    },
  };
}

export async function startCycleServer({ env = process.env, argv = process.argv.slice(2), cwd = process.cwd() } = {}) {
  const { workspaceRoot } = configuredWorkspaceRoot(env, argv, cwd);
  return createCycleServer({ runtime: createWorkspaceRouter({ workspaceRoot, env }) });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  try {
    const server = await startCycleServer();
    await serveStdio(() => server, { onerror: () => process.stderr.write('Cycle MCP transport error.\n') });
  } catch {
    process.stderr.write('Cycle MCP server startup failed. Check the local runtime configuration.\n');
    process.exitCode = 1;
  }
}
