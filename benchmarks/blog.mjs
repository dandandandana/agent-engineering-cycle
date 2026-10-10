import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createRuntime } from '../src/runtime.mjs';
import { sha256, digest } from '../src/core/contracts.mjs';
import { discoveryAllows } from '../src/local/reuse-evidence.mjs';
import { setupLive, removeAuthLinks, model, judgeNotes } from './live.mjs';
import { mcpCalls } from './metrics.mjs';
import { prepareBlog, gradeBlog, projectForGrade } from './blog-score.mjs';
import { runBlogBrowser } from './blog-browser.mjs';
import { freezeBlogReuseV2, probeReuseContribution, scoreBlogReuseV2, blogReuseV2Plan } from './blog-reuse-v2.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const DOCS = ['docs/cycle/requirements.md', 'docs/cycle/design.md', 'docs/cycle/implementation.md', 'docs/cycle/notes.md'];
const normalized = value => path.resolve(value).toLowerCase();
const json = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + '\n');
const readMaybe = async file => fs.readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });

/** A run-bound freeze differs by path; paired runs compare actual input/rule bytes. */
export function reuseComparisonDigest(freeze) {
  return digest({ benchmark_id: freeze.benchmark_id, source_benchmark_id: freeze.source_benchmark_id,
    denominator: freeze.denominator, eligible: freeze.eligible_opportunity_ids, plan: freeze.plan_sha256,
    implementation: freeze.implementation_sha256, bundle: freeze.v1.bundle_sha256,
    baseline: freeze.v1.baseline.sha256, inputs: freeze.v1.input_files.sha256, tasks: freeze.v1.task_bytes_sha256 });
}

async function sourcePaths(root, directory = 'src') {
  const files = [];
  for (const name of (await fs.readdir(path.join(root, directory))).sort()) {
    const relative = `${directory}/${name}`;
    const info = await fs.lstat(path.join(root, relative));
    if (info.isSymbolicLink()) throw new Error('Blog source contains a link.');
    if (info.isDirectory()) files.push(...await sourcePaths(root, relative));
    else if (info.isFile()) files.push(relative);
    else throw new Error('Blog source contains a non-regular file.');
  }
  return files;
}

async function attach(runtime, kind, relative) {
  const prepared = await runtime.invoke('cycle_artifact', { action: 'prepare', kind, paths: [relative] });
  if (!prepared.ok) throw new Error(`Fixture prepare ${kind}: ${prepared.error?.code}`);
  const result = await runtime.invoke('cycle_artifact', { action: 'attach', kind, paths: [relative], binding: prepared.binding,
    prepared_handle: prepared.prepared_handle, request_id: `fixture-${randomUUID()}` });
  if (!result.ok) throw new Error(`Fixture attach ${kind}: ${result.error?.code}`);
}

export async function prepareCycle(task, workspace, taskText, reuseProvider) {
  // The declaration indexes browser sources too. Read access is independent of
  // the task's product-write grant; reject fixture mistakes before model calls.
  const discoveryScope = { roots: ['src', 'public'], files: ['components.json', 'architecture.json'] };
  if (reuseProvider) {
    const index = JSON.parse(await fs.readFile(path.join(workspace, 'architecture.json'), 'utf8'));
    if (!Array.isArray(index.modules)) throw new Error('Blog fixture architecture must declare modules.');
    const indexedPaths = index.modules.flatMap(module => (module.source ?? []).map(source => source.path));
    const denied = indexedPaths.filter(relative => !discoveryAllows(discoveryScope, relative));
    if (denied.length) throw new Error(`Blog fixture discovery scope excludes indexed sources: ${denied.join(', ')}`);
  }
  await fs.mkdir(path.join(workspace, '.codex'), { recursive: true });
  await fs.mkdir(path.join(workspace, 'docs/cycle'), { recursive: true });
  const checks = [
    { id: 'blog-static', kind: 'command', argv: [process.execPath, 'scripts/check.mjs'], timeout_ms: 30000 },
    { id: 'blog-tests', kind: 'command', argv: [process.execPath, '--test', '--test-concurrency=2', 'tests/domain.test.mjs', 'tests/application.test.mjs', 'tests/architecture.test.mjs'], timeout_ms: 60000 },
  ];
  await json(path.join(workspace, '.codex/engineering-cycle.json'), reuseProvider ? { schema_revision: 2, checks, component_reuse: {
    architecture_path: 'architecture.json', discovery_scope: discoveryScope, documentation_paths: DOCS,
    provider: reuseProvider,
  } } : { schema_revision: 1, checks });
  await fs.writeFile(path.join(workspace, DOCS[0]), taskText + '\n\nThis run tests agent-engineering-cycle, not the SoL plugin. The original blog task and protected baseline remain authoritative. The four docs/cycle files are additional host protocol sidecars.\n');
  await fs.writeFile(path.join(workspace, DOCS[1]), '# Design constraints\n\nReuse the existing domain functions and public component registry. Keep whole-input validation, publication/moderation boundaries and compatibility specified by the task. Only task product paths and four cycle documents may change. Derive architecture.json using the existing scripts/architecture.mjs. Register current implementation notes and run the two existing project checks. Independent hidden grading follows a frozen candidate; no model may read the grader or reference answers.\n');
  await fs.writeFile(path.join(workspace, DOCS[2]), '# Implementation state\n\nNot implemented; real model output and checks pending.\n');
  await fs.writeFile(path.join(workspace, DOCS[3]), '# Implementation notes\n\nPending actual implementation.\n');
  const runtime = await createRuntime({ workspaceRoot: workspace });
  const scope = [...task.allowed_paths, ...DOCS];
  const inputs = [...await sourcePaths(workspace), 'package.json', 'package-lock.json', 'components.json', 'architecture.json', ...DOCS];
  const goal = `${task.id}: ${task.title}. Implement the fixed blog task and leave source-grounded maintenance notes.`;
  const grant = runtime.authority.issue({ kind: 'action', workspace_id: runtime.store.workspaceId, goal_digest: sha256(goal), mode: 'implement', paths: scope,
    actions: ['control', 'artifact', 'apply', 'verify'], source: { adapter: 'interactive-operator', fixture: true, human_identity_verified: false } }, { operatorConfirmed: true });
  const targets = [{ path: task.entry, symbol: task.export_name }];
  for (const opportunity of task.reuse.filter(value => value.kind === 'extend')) targets.push({ path: opportunity.path, symbol: opportunity.export_name });
  const began = await runtime.invoke('cycle_control', { action: 'begin', request_id: `fixture-${task.id}`, goal, grant_id: grant.id,
    scope, inputs: [...new Set(inputs)], acceptance_ids: [task.id], implementation_targets: targets });
  if (!began.ok) throw new Error(`Fixture begin: ${began.error?.code}`);
  await attach(runtime, 'R', DOCS[0]);
  if (!reuseProvider) await attach(runtime, 'D', DOCS[1]);
  return { runtime, targets, reuse_enabled: Boolean(reuseProvider) };
}

export function notesRubric(task) {
  return [
    { id: `${task.id}-flow`, critical: true, criterion: `Explain ${task.export_name}'s real purpose, inputs/output and implementation sequence, including its important filtering, grouping, ordering or state branches; agree with the actual source.` },
    { id: `${task.id}-dependencies`, critical: true, criterion: 'Name the actual project dependency functions and module paths, and explain which input/intermediate values are passed to them and what their results do. Distinguish local modules from installed external packages; do not invent package APIs.' },
    { id: `${task.id}-failures`, critical: true, criterion: 'Explain the real input-validation and error paths, mutation/side-effect boundaries, and cancellation/save behavior when applicable. Do not claim runtime proof from static declarations.' },
    { id: `${task.id}-maintenance`, critical: true, criterion: 'Identify concrete behavior or compatibility invariants to preserve during future changes; include actual changed public helpers when the task extends a domain module. Do not invent implementation reasons or unsupported guarantees.' },
  ];
}

export function protocolObserved({ workspace, current, hooks, calls, notesHash }) {
  const probes = hooks.filter(hook => hook.cwd && normalized(hook.cwd) === normalized(workspace) && hook.tool === 'apply_patch');
  const managedNotes = calls.some(call => call.tool === 'cycle_apply' && call.success && call.value?.operation?.phase === 'settled'
    && call.value?.result?.effects_known === true && call.value.result.effects?.some(effect => effect.path === 'docs/cycle/notes.md' && effect.after?.sha256 === notesHash));
  return current.ok === true && current.implementation_notes?.status === 'current'
    && !current.blockers?.some(blocker => blocker.kind === 'checks')
    && hooks.some(hook => hook.cwd && normalized(hook.cwd) === normalized(workspace) && hook.output?.hookSpecificOutput?.additionalContext)
    && probes.length === 1 && probes[0].patch_comment_only === true
    && probes[0].patch_paths?.length === 1 && normalized(path.resolve(workspace, probes[0].patch_paths[0])) === normalized(path.join(workspace, 'src/features.mjs'))
    && probes[0].output?.hookSpecificOutput?.permissionDecision === 'deny'
    && ['cycle_status', 'cycle_apply', 'cycle_artifact', 'cycle_verify'].every(tool => calls.some(call => call.tool === tool && call.success))
    && managedNotes;
}

/** Deliver actual transitive helper implementations, not just required reuse names. */
export async function collectNoteSources(workspace) {
  return Object.fromEntries(await Promise.all([...await sourcePaths(workspace), 'package.json', 'components.json', 'architecture.json'].map(async relative => [relative, await fs.readFile(path.join(workspace, relative), 'utf8')])));
}

async function trial(ctx, task, run) {
  const row = { id: task.id, title: task.title, status: 'pending' };
  const workspace = path.join(run, task.id, 'workspace');
  const taskFile = path.join(run, task.id, 'TASK.md');
  const trace = path.join(ctx.output, 'raw', `${task.id}-hooks.jsonl`);
  let runtime;
  let result;
  const start = Date.now();
  try {
    const taskText = await fs.readFile(taskFile, 'utf8');
    const fixture = await prepareCycle(task, workspace, taskText, ctx.reuseProvider);
    runtime = fixture.runtime;
    const prompt = `Implement this fixed blog task in the current workspace:\n${taskText}\n
The tested plugin is agent-engineering-cycle. Read the installed Skill at ${ctx.pluginSkill} and its references/implementation-notes.md with a file/shell tool. Those exact plugin Skill files are authorized reads outside this workspace. Do not read parent folders, credentials, benchmark runners, evals/reference, graders, other candidates or hidden tests. The only extra authorized external file is this task's ${taskFile}; its full content is above.
An active synthetic implement-mode fixture has R attached${fixture.reuse_enabled ? '; D must be completed using actual component discovery' : ' and D attached'}. Use cycle_status first; do not begin another cycle. Fixed implementation targets: ${JSON.stringify(fixture.targets)}.
After the first status, call cycle_control action=resume with its current binding and a unique request_id to bind this actual Host session to the existing fixture. This does not authorize another goal or replay work.
${fixture.reuse_enabled ? `Read the installed Skill references/component-reuse.md. Before source writes, use cycle_artifact D discover/read for actual interfaces/implementations/direct callers, then write exactly one canonical cycle-reuse-v1 block into docs/cycle/design.md covering every allowed product path (${JSON.stringify(task.allowed_paths)}), acceptance_ids=["${task.id}"], using actual returned evidence IDs and candidate UID/symbol. Preserve the original design constraints. Prepare/attach D with its latest binding. Shared/registry changes require renewed discovery/read and D attachment; consumer cursors cover only fully settled managed writes. Do not disable this policy or bypass blocked source writes.\n` : ''}
As a real host Hook probe, attempt exactly once to apply_patch a harmless comment into src/features.mjs. The Hook should deny it; continue with MCP cycle_apply. Use cycle_apply for source, registry and document writes with actual full-file SHA-256 expected_sha256 and latest binding; never invoke a shell to write product or cycle files. Do not add dependencies or modify baseline tests, scripts, configs, instructions or evals. The four docs/cycle/*.md files are explicitly permitted host sidecars in addition to the task's allowed product paths.
Read actual existing helper contracts before coding. Sync the features export/options registry. Derive architecture via its existing architectureFor(root) function; read/compute the JSON with node, then write it through cycle_apply, rather than running its mutating CLI. Keep its revision/updatedAt behavior. For dependent registry outputs, prepare the planned components.json and architecture.json in a disposable copy under this workspace's slop directory, using the existing read-only generator and current product source bytes. These scratch copies are authorized planning data. Apply the two actual registry files together with one cycle_apply while the old D remains current; do not write one registry and then discover against an inconsistent fingerprint. After synchronization, refresh discovery and replace reads only for changed sources or new callers; preserve unchanged same-cycle read evidence IDs and let prepare validate them.
Write at most 120 lines of accurate Chinese maintenance notes in docs/cycle/notes.md: explain implementation steps, parameter/intermediate values passed to concrete helper functions and module paths, dependency kind, errors, side effects/cancellation and compatibility invariants. Describe the changed public helper too for extension tasks. Update docs/cycle/implementation.md with what actually changed and what checks ran.
Attach I using cycle_artifact prepare/attach with paths=["docs/cycle/implementation.md"] and implementation_notes for every fixed target. The documentation path is docs/cycle/notes.md, hashes are whole-file SHA-256, related_sources are actually used local source files already in inputs, line spans must be accurate. Prepare and attach must have identical paths/notes, current binding, prepared_handle and a unique request_id. Source or docs changes make old references stale; reattach the final I.
Run registered cycle_verify check_ids=["blog-static","blog-tests"] on the final binding, fix within scope as needed, then inspect cycle_status. This benchmark ends at verified implementation handoff. Do not call cycle_qa or finish, because this fixture has no calibrated QA/finish authority. Independent graders and browser acceptance will run afterward. Complete autonomously.\n`;
    result = await model(ctx, `${task.id}-implement`, workspace, prompt, { plugin: true, home: ctx.pluginHome, trace });
    row.status = 'model-completed';
  } catch (error) {
    row.status = 'error'; row.reason = error.message;
  } finally {
    if (runtime) {
      const current = await runtime.invoke('cycle_status', {});
      const hooks = (await readMaybe(trace)).split(/\r?\n/).filter(Boolean).map(JSON.parse);
      const calls = mcpCalls(result?.events ?? []);
      const notes = await readMaybe(path.join(workspace, DOCS[3]));
      row.notes_sha256 = sha256(notes);
      row.protocol = { observed: protocolObserved({ workspace, current, hooks, calls, notesHash: row.notes_sha256 }), current, hooks, mcp_calls: calls,
        authority: 'synthetic operator fixture; not a human authorization test', full_cycle_qa: 'not evaluated; verified implementation handoff only' };
      row.source_hashes = Object.fromEntries(await Promise.all(task.allowed_paths.map(async relative => [relative, sha256(await readMaybe(path.join(workspace, relative)))])));
      if (current.binding && !current.pending_operation) {
        row.fixture_closeout = await runtime.invoke('cycle_control', { action: 'abandon', request_id: `closeout-${task.id}`, binding: current.binding,
          reason: 'Fixed blog implementation stage ended; independent grading follows, no full-cycle QA/finish claim.' });
        if (!row.fixture_closeout.ok || row.fixture_closeout.lifecycle !== 'abandoned' || row.fixture_closeout.operation?.phase !== 'settled') {
          row.status = 'error'; row.closeout_error = row.fixture_closeout.error?.code ?? 'CLOSEOUT_NOT_SETTLED';
          if (row.fixture_closeout.pending_operation) ctx.executionUnknown = true;
        }
      } else { row.status = 'error'; row.reason = 'Fixture operation unresolved; retained without replay.'; ctx.executionUnknown = true; }
      if (result && !ctx.executionUnknown) {
        const sources = await collectNoteSources(workspace);
        try {
          row.notes = await judgeNotes(ctx, { rubric: notesRubric(task) }, notes, `${task.id}-notes-judge`, sources);
          row.notes.assurance = 'Fresh source-guided model judgment with verified literal citations; this blog rubric is not human-validated or control-calibrated.';
        }
        catch (error) { row.notes = { passed: false, error: error.message }; }
      }
    }
    row.duration_ms = Date.now() - start;
  }
  await json(path.join(ctx.output, `${task.id}.json`), row);
  return row;
}

async function replaceOwnedProjection(source, destination, preparedRun) {
  const expected = path.join(preparedRun, path.basename(path.dirname(destination)), 'workspace');
  if (normalized(destination) !== normalized(expected) || !/^B0[1-8]$/.test(path.basename(path.dirname(destination)))) throw new Error('Unexpected grading workspace.');
  const info = await fs.lstat(destination);
  if (!info.isDirectory() || info.isSymbolicLink() || normalized(await fs.realpath(destination)) !== normalized(destination)) throw new Error('Unsafe grading destination.');
  await fs.rm(destination, { recursive: true });
  await projectForGrade({ source, destination });
}

/** Drain both independent scopes before the caller removes shared auth links. */
export async function runBlogTrials(ctx, tasks, candidateRun, executeTrial = trial) {
  let next = 0;
  const workers = await Promise.allSettled(Array.from({ length: 2 }, async () => {
    while (next < tasks.length) {
      const task = tasks[next++];
      if (ctx.executionUnknown) ctx.rows.push({ id: task.id, title: task.title, status: 'not-run', reason: 'Earlier execution facts unknown; no automatic replay.' });
      else {
        // model() updates its final call; invocation arrays belong to one scope.
        const isolated = { ...ctx, invocations: [], executionUnknown: false };
        try { ctx.rows.push(await executeTrial(isolated, task, candidateRun)); }
        catch (error) {
          ctx.rows.push({ id: task.id, title: task.title, status: 'error', reason: `Trial evidence/closeout failure: ${error.message}` });
          isolated.executionUnknown = true;
        } finally {
          ctx.invocations.push(...isolated.invocations);
          ctx.executionUnknown ||= isolated.executionUnknown;
        }
      }
    }
  }));
  return workers.filter(value => value.status === 'rejected').map(value => value.reason?.message ?? 'Worker rejected');
}

async function removeOwnedHome(ctx) {
  if (!ctx.homeRoot) return { removed: false, reason: 'No temporary home was created.' };
  if (ctx.executionUnknown || ctx.invocations.some(value => value.execution_status === 'unknown')) return { removed: false, reason: 'Execution effects unknown; retain home for process reconciliation, auth links removed separately.' };
  const relative = path.relative(os.tmpdir(), ctx.homeRoot);
  const canonical = await fs.realpath(ctx.homeRoot);
  const canonicalRelative = path.relative(await fs.realpath(os.tmpdir()), canonical);
  if (!/^cycle-bench-homes-[A-Za-z0-9]+$/.test(relative) || canonicalRelative !== relative) throw new Error('Unexpected temporary home target.');
  const info = await fs.lstat(ctx.homeRoot);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Temporary home is not a regular owned directory.');
  await fs.rm(canonical, { recursive: true });
  return { removed: true };
}

export async function runBlog(ctx) {
  const started = Date.now();
  await fs.mkdir(ctx.output, { recursive: false });
  ctx.invocations = []; ctx.rows = [];
  ctx.httpProvider = true;
  const tag = path.basename(ctx.output);
  const candidateRun = path.join(ctx.blogRoot, 'slop', `${tag}-candidates`);
  const gradingRun = path.join(ctx.blogRoot, 'slop', `${tag}-grading-input`);
  const gradeOut = path.join(ctx.blogRoot, 'slop', `${tag}-scores`);
  const report = { schema_revision: 1, kind: 'engineering_cycle_blog_benchmark', model: ctx.model, effort: ctx.effort,
    arms: ['plugin'], repetitions: 1, concurrency: 2, transport: 'Custom cycle-bench-http provider; existing OpenAI auth, default endpoint, supports_websockets=false; invocation only', full_cycle_qa: 'not measured; synthetic implementation handoff plus independent external grading',
    candidate_run: candidateRun, grading_run: gradingRun, grading_output: gradeOut, rows: ctx.rows, invocations: ctx.invocations };
  try {
    const prepared = await prepareBlog({ blogRoot: ctx.blogRoot, solRoot: ctx.solRoot, out: candidateRun });
    report.corpus = prepared;
    const reuseFreeze = ctx.reuseMode ? await freezeBlogReuseV2({ blogRoot: ctx.blogRoot, preparedRun: candidateRun }) : null;
    if (reuseFreeze) report.component_reuse_v2 = { mode: ctx.reuseMode, freeze: reuseFreeze, comparison_sha256: reuseComparisonDigest(reuseFreeze), score: null, model_comparison: 'Single arm; compare only matching comparison_sha256 and execution parameters.' };
    if (ctx.reuseMode === 'on') {
      const { packageProvider } = await import(pathToFileURL(path.join(ctx.solRoot, 'scripts/package-provider.mjs')).href);
      const provider = await packageProvider({ out: path.join(ctx.output, 'component-provider') });
      const manifest = path.join(provider, 'provider-manifest.json');
      ctx.reuseProvider = { executable: process.execPath, args: [], manifest, manifest_sha256: sha256(await fs.readFile(manifest)), protocol: 'sol-component-discovery/1', timeout_ms: 30000 };
      report.component_reuse_v2.provider_manifest_sha256 = ctx.reuseProvider.manifest_sha256;
    }
    const allTasks = JSON.parse(await fs.readFile(path.join(ctx.blogRoot, 'evals/tasks.json'), 'utf8')).cases;
    const tasks = ctx.smokeCase ? allTasks.filter(task => task.id === ctx.smokeCase) : allTasks;
    if (ctx.smokeCase && tasks.length !== 1) throw new Error('Unknown smoke case.');
    await setupLive(ctx);
    report.installation = ctx.installation; report.codex_version = ctx.codexVersion;
    if (reuseFreeze) {
      const installedRoot = ctx.installation.installed_path;
      const files = [...await sourcePaths(installedRoot,'src'),...await sourcePaths(installedRoot,'hooks'),...await sourcePaths(installedRoot,'skills'),'package.json','package-lock.json'];
      const identities = await Promise.all(files.sort().map(async file => ({path:file,sha256:sha256(await fs.readFile(path.join(installedRoot,file)))})));
      report.component_reuse_v2.runtime_sources = { files: identities, digest: digest(identities) };
      report.component_reuse_v2.pipeline_sha256 = sha256(await fs.readFile(fileURLToPath(import.meta.url)));
    }
    const probe = path.join(ctx.output, 'health-workspace');
    await fs.mkdir(probe);
    await model({ ...ctx, timeoutMs: 120000 }, 'blog-health', probe, 'Return only BLOG_BENCH_READY. Do not use tools.', { readOnly: true });
    report.worker_errors = await runBlogTrials(ctx, tasks, candidateRun);
    ctx.rows.sort((a, b) => a.id.localeCompare(b.id));
    await json(path.join(ctx.output, 'progress.json'), report);
    if (ctx.smokeCase) {
      report.kind = 'engineering_cycle_blog_smoke';
      report.smoke = { case_id: ctx.smokeCase, protocol_passed: ctx.rows[0]?.protocol?.observed === true,
        notes_passed: ctx.rows[0]?.notes?.passed === true, assurance: 'One integration task only; no eight-task or 25-opportunity score.' };
      if (!report.smoke.protocol_passed) process.exitCode = 1;
      return report;
    }
    await prepareBlog({ blogRoot: ctx.blogRoot, solRoot: ctx.solRoot, out: gradingRun });
    for (const task of tasks) await replaceOwnedProjection(path.join(candidateRun, task.id, 'workspace'), path.join(gradingRun, task.id, 'workspace'), gradingRun);
    const graded = await gradeBlog({ blogRoot: ctx.blogRoot, solRoot: ctx.solRoot, run: gradingRun, out: gradeOut, label: `${ctx.model} + agent-engineering-cycle` });
    report.blog_metrics = graded.report.metrics;
    report.blog_report = path.join(gradeOut, 'report.json');
    if (reuseFreeze) {
      const evidence = []; const captures = path.join(ctx.output, 'reuse-contribution'); await fs.mkdir(captures);
      for (const opportunity of blogReuseV2Plan.opportunities) {
        const probe = await probeReuseContribution({ blogRoot: ctx.blogRoot, solRoot: ctx.solRoot, preparedRun: candidateRun, freeze: reuseFreeze,
          taskId: opportunity.case_id, opportunityId: opportunity.id, candidateRoot: path.join(candidateRun, opportunity.case_id, 'workspace') });
        evidence.push(probe); await json(path.join(captures, `${opportunity.id.replaceAll('/','__')}.json`), probe);
      }
      report.component_reuse_v2.score = await scoreBlogReuseV2({ blogRoot: ctx.blogRoot, preparedRun: candidateRun, freeze: reuseFreeze, evidence });
    }
    report.protocol = { numerator: ctx.rows.filter(row => row.protocol?.observed).length, denominator: 8 };
    report.notes = { passed_tasks: ctx.rows.filter(row => row.notes?.passed).length, task_denominator: 8,
      passed_criteria: ctx.rows.reduce((total, row) => total + (row.notes?.criteria?.filter(value => value.verdict === 'pass' && value.source_quote?.length >= 4 && value.notes_quote?.length >= 4).length ?? 0), 0), criterion_denominator: 32 };
    const demoCase = [...graded.report.results].reverse().find(value => value.success)?.id ?? 'B01';
    const demo = path.join(ctx.output, 'demo');
    const candidate = path.join(candidateRun, demoCase, 'workspace');
    await fs.cp(candidate, demo, { recursive: true, errorOnExist: true, force: false,
      filter: source => {
        const relative = path.relative(candidate, source).replaceAll('\\', '/');
        return relative !== '.codex/engineering-cycle' && !relative.startsWith('.codex/engineering-cycle/');
      } });
    report.demo = { path: demo, case_id: demoCase, role: 'One actual candidate blog app; the eight benchmark tasks remain isolated, without reference answers or post-grade repair.' };
    await fs.mkdir(path.join(demo, 'slop'), { recursive: true });
    const browserScriptHash = sha256(await fs.readFile(path.join(gradingRun, 'baseline/scripts/browser-check.mjs')));
    report.browser = await runBlogBrowser({ projectRoot: demo, packages: ctx.packages, browser: ctx.browser,
      expectedScriptSha256: browserScriptHash, out: path.join(demo, 'slop/browser'), timeoutMs: 120000 });
  } catch (error) {
    report.error = error.message;
    process.exitCode = 1;
  } finally {
    for (const id of ctx.smokeCase ? [ctx.smokeCase] : Array.from({length:8},(_,i)=>`B0${i+1}`)) {
      if (!ctx.rows.some(row => row.id === id)) ctx.rows.push({ id, status: 'not-run', reason: report.error ?? 'No complete trial record.' });
    }
    ctx.rows.sort((a, b) => a.id.localeCompare(b.id));
    try { await removeAuthLinks(ctx); report.authentication_links_removed = true; }
    catch (error) { report.cleanup_error = error.message; process.exitCode = 1; }
    try { report.temporary_home = await removeOwnedHome(ctx); }
    catch (error) { report.home_cleanup_error = error.message; process.exitCode = 1; }
    report.duration_ms = Date.now() - started;
    report.usage = ctx.invocations.reduce((total, invocation) => {
      for (const name of ['input_tokens', 'cached_input_tokens', 'output_tokens']) total[name] += invocation.usage?.[name] ?? 0;
      return total;
    }, { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 });
    await json(path.join(ctx.output, 'report.json'), report);
    const rows = (report.rows ?? []).map(row => `| ${row.id} | ${row.status} | ${row.protocol?.observed ? 'passed' : 'failed/unverified'} | ${row.notes?.passed ? 'passed' : 'failed/unverified'} |`).join('\n');
    await fs.writeFile(path.join(ctx.output, 'report.md'), `# 工程循环插件博客 ${ctx.smokeCase ? 'smoke' : 'benchmark'}\n\n模型：${ctx.model} (${ctx.effort})；${ctx.smokeCase ? `单题 ${ctx.smokeCase}，仅测实际协议，不生成八题/25机会成绩` : '一次 plugin-enabled cohort，八项独立固定题'}。\n\n| 任务 | Codex 执行 | Hook/MCP/说明当前性 | 独立说明评估 |\n| --- | --- | --- | --- |\n${rows}\n\n博客原始评分：${report.blog_report ?? '未生成'}\n\n\`\`\`json\n${JSON.stringify(report.blog_metrics ?? {}, null, 2)}\n\`\`\`\n\n浏览器：${report.browser?.status ?? 'not-run'}；demo：${report.demo?.path ?? '未生成'}。\n\n仅排除明示的工程循环协议 sidecar 和原评测器已排除的 slop；其他未知文件/删除保留评分。原任务、参考答案与评分器未修改。实际 CLI usage 单独记录，不改写旧评分器的 not_measured 字段。fixture 使用合成 operator 授权，测量到实现说明、校验和实际 Hook/MCP；未测量插件内校准 QA/finish，也没有关闭插件的 A/B 因果比较。\n${report.error ? `\n运行错误：${report.error}\n` : ''}`);
  }
  console.log(JSON.stringify({ output: ctx.output, metrics: report.blog_metrics, protocol: report.protocol, notes: report.notes, browser: report.browser?.status, error: report.error }));
  return report;
}

function options(argv) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!/^--[a-z-]+$/.test(argv[i] ?? '') || !argv[i + 1] || Object.hasOwn(values, argv[i])) throw new Error('Use unique --key value arguments.');
    values[argv[i]] = argv[i + 1];
  }
  const known = ['--out', '--blog-root', '--sol-root', '--codex', '--model', '--effort', '--timeout-ms', '--windows-sandbox', '--packages', '--browser', '--reuse-mode', '--smoke-case'];
  if (Object.keys(values).some(key => !known.includes(key))) throw new Error('Unknown blog benchmark option.');
  for (const key of ['--out', '--blog-root', '--sol-root', '--codex', '--model', '--packages', '--browser']) if (!values[key]) throw new Error(`Required: ${key}`);
  const output = path.resolve(values['--out']);
  const relative = path.relative(path.join(ROOT, 'slop'), output);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Output must be new inside this plugin slop directory.');
  const timeoutMs = Number(values['--timeout-ms'] ?? 600000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3600000) throw new Error('Invalid timeout.');
  const effort = values['--effort'] ?? 'max';
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) throw new Error('Invalid effort.');
  const windowsSandbox = values['--windows-sandbox'] ?? 'unelevated';
  if (!['unelevated', 'elevated', 'disabled'].includes(windowsSandbox)) throw new Error('Invalid Windows sandbox.');
  const reuseMode = values['--reuse-mode'] ?? null;
  const smokeCase = values['--smoke-case'] ?? null;
  if (smokeCase && !/^B0[1-8]$/.test(smokeCase)) throw new Error('Smoke case must be B01 through B08.');
  if (reuseMode !== null && !['off','on'].includes(reuseMode)) throw new Error('Reuse mode must be off or on.');
  return { output, blogRoot: path.resolve(values['--blog-root']), solRoot: path.resolve(values['--sol-root']), codex: path.resolve(values['--codex']), model: values['--model'], effort, timeoutMs, windowsSandbox,
    packages: path.resolve(values['--packages']), browser: path.resolve(values['--browser']), reuseMode, smokeCase };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBlog(options(process.argv.slice(2)));
}
