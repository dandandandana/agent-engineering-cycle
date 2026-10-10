#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { CASES } from './cases.mjs';
import { runGates } from './gates.mjs';
import { orderedTrials, summarizeTrials } from './metrics.mjs';
import { writeFiles, setupLive, removeAuthLinks, gradeMaintenance, judgeNotes, runTrial } from './live.mjs';
import { runCheck } from '../src/local/check-runner.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const HELP = `Engineering Cycle benchmark
  npm run bench                         backend gates + executable oracle/no-op controls; no model calls
  npm run bench:live -- --codex <native executable> --cases decode-record --repeats 1
  node benchmarks/run.mjs --plan --cases decode-record --repeats 3

Options: --out <NEW directory> --cases <comma-separated IDs> --repeats <1..20>
         --seed <uint32> --model <model> --effort <low|medium|high|xhigh|max>
         --timeout-ms <10000..1800000> --windows-sandbox <unelevated|elevated>
Live defaults: both cases, 3 repeats, gpt-6-luna, low, 180000ms per model invocation.
Live makes 4 model calls per trial plus 2 judge controls per selected case.
Cases: decode-record, publish-text. No task/answer/result cache is reused.
`;

export function parseOptions(args) {
  const options = { live: false, plan: false, repeats: 3, seed: 42, model: 'gpt-6-luna', effort: 'low', timeoutMs: 180000, windowsSandbox: 'unelevated' };
  const fields = { '--out': 'output', '--codex': 'codex', '--cases': 'caseIds', '--repeats': 'repeats', '--seed': 'seed', '--model': 'model', '--effort': 'effort', '--timeout-ms': 'timeoutMs', '--windows-sandbox': 'windowsSandbox' };
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`); seen.add(flag);
    if (flag === '--help' || flag === '-h') { options.help = true; continue; }
    if (flag === '--live' || flag === '--plan') { options[flag.slice(2)] = true; continue; }
    if (!fields[flag] || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Unknown/incomplete option: ${flag}`);
    options[fields[flag]] = args[++i];
  }
  for (const [key, min, max] of [['repeats', 1, 20], ['seed', 0, 0xffffffff], ['timeoutMs', 10000, 1800000]]) {
    options[key] = Number(options[key]);
    if (!Number.isInteger(options[key]) || options[key] < min || options[key] > max) throw new Error(`Invalid ${key}.`);
  }
  if (!['low', 'medium', 'high', 'xhigh', 'max'].includes(options.effort) || !['unelevated', 'elevated'].includes(options.windowsSandbox)) throw new Error('Invalid effort or sandbox mode.');
  const ids = options.caseIds?.split(',') ?? CASES.map(c => c.id);
  if (!ids.length || new Set(ids).size !== ids.length || ids.some(id => !CASES.some(c => c.id === id))) throw new Error('Unknown/duplicate case ID.');
  options.cases = CASES.filter(c => ids.includes(c.id));
  if (options.live && !options.plan && !options.codex) throw new Error('Live mode requires --codex with the native executable path.');
  if (options.codex) options.codex = path.resolve(options.codex);
  return options;
}

async function save(ctx, report) {
  report.summary = summarizeTrials(report.trials);
  report.invocations = ctx.invocations;
  report.installation = ctx.installation ?? null;
  report.codex_version = ctx.codexVersion ?? null;
  report.updated_at = new Date().toISOString();
  await fs.writeFile(path.join(ctx.output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  const lines = [
    '# Engineering Cycle benchmark', '', `Mode: ${report.mode}. Dataset: \`${report.dataset_sha256}\`.`, '',
    `Environment: ${process.platform}/${process.arch}, Node ${process.version}; ${report.codex_version ?? 'model execution not requested'}.`, '',
    `Backend gates: ${report.gates?.summary.pass ?? 0}/${report.gates?.summary.planned ?? 0}. Oracle/no-op controls: ${report.controls.filter(c => c.passed).length}/${report.controls.length}.`, '',
    '| Arm | Planned | Pass | Fail | Blocked | Error | Not run | Notes pass | Maintenance pass | Updated notes pass |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...Object.entries(report.summary).map(([arm, s]) => `| ${arm} | ${s.planned} | ${s.pass} | ${s.fail} | ${s.blocked} | ${s.error} | ${s['not-run']} | ${s.notes_pass} | ${s.maintenance_pass} | ${s.maintenance_notes_pass} |`), '',
    `Judge controls: ${report.judge_controls?.filter(c => c.passed).length ?? 0}/${report.judge_controls?.length ?? 0}. Model invocations: ${report.invocations.length}.`, '',
    ...report.trials.filter(t => t.status !== 'pass' && t.status !== 'not-run').map(t => `- ${t.id}: ${t.status}; ${t.reason ?? 'see criterion/behavior/protocol details in report.json'}`), '',
    ...report.limits.map(l => `- ${l}`), '',
    'Raw process facts, prompts, CLI JSONL, snapshots and candidate bytes are retained alongside report.json. Statuses retain the planned denominator. Token fields are client-reported usage, not a billing estimate.', '',
  ];
  await fs.writeFile(path.join(ctx.output, 'report.md'), lines.join('\n'));
}

export async function runBenchmark(options) {
  const output = path.resolve(options.output ?? path.join(ROOT, 'slop', `benchmark-${Date.now()}-${randomUUID().slice(0, 8)}`));
  await fs.mkdir(path.dirname(output), { recursive: true });
  await fs.mkdir(output); // A new directory is required, preserving all earlier attempts.
  const ctx = { ...options, output, invocations: [] };
  const report = { schema_revision: 1, mode: options.plan ? 'plan' : options.live ? 'live-handoff-pilot' : 'backend-and-grader-controls',
    dataset_sha256: createHash('sha256').update(JSON.stringify(options.cases)).digest('hex'),
    started_at: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch },
    parameters: { model: options.model, effort: options.effort, timeout_ms: options.timeoutMs, repeats: options.repeats, seed: options.seed, cases: options.cases.map(c => c.id) },
    controls: [], judge_controls: [], trials: options.live || options.plan ? orderedTrials(options.cases, options.repeats, options.seed) : [],
    limits: [
      'Synthetic small cases: results are a local handoff pilot, not general software-engineering productivity evidence.',
      'Baseline/Skill/full-plugin differ during notes production; maintenance uses the same plain fresh CLI and original source plus generated notes in every arm.',
      'Plugin arm evaluates the managed notes stage with synthetic scoped operator grants; complete independent QA/finish, cancellation/recovery and human authorization are not evaluated here.',
      'Stock Hook handler is observed through an instrumented isolated native bundle; trust bypass is invocation-scoped after packaging our own reviewed code.',
      'Hidden rubrics/oracles stay outside the task workspace and prompt. Same-user filesystem isolation is logical, not an adversarial sandbox guarantee.',
      'A fresh control-calibrated model judges prose. No human agreement study or long-conversation drift experiment has been performed.',
      'Recorded client usage/elapsed time do not establish actual billing, provider prompt contents or server-side model identity.',
    ],
  };
  const boundFiles = ['benchmarks/cases.mjs', 'benchmarks/grade-worker.mjs', 'benchmarks/gates.mjs', 'benchmarks/live.mjs', 'benchmarks/run.mjs', 'benchmarks/metrics.mjs', 'benchmarks/process-worker.mjs', 'benchmarks/hook-observer.mjs', 'src/runtime.mjs', 'src/core/cycle.mjs', 'src/core/contracts.mjs', 'src/local/implementation-notes.mjs', 'src/local/workspace.mjs', 'src/local/check-runner.mjs', 'src/hook.mjs', 'src/server.mjs', 'package-lock.json', 'hooks/hooks.json', 'skills/agent-engineering-cycle/SKILL.md', 'skills/agent-engineering-cycle/references/implementation-notes.md'];
  report.inputs = Object.fromEntries(await Promise.all(boundFiles.map(async p => [p, createHash('sha256').update(await fs.readFile(path.join(ROOT, p))).digest('hex')])));
  await save(ctx, report);
  if (options.plan) return { output, report };
  try {
    console.log('Running backend gates and behavioral grader controls.');
    report.gates = await runGates({ outputDirectory: path.join(output, 'gates') });
    for (const task of options.cases) {
      for (const [variant, files] of [['no-op', task.files], ['oracle', { ...task.files, ...task.oracle }]]) {
        const root = path.join(output, 'controls', `${task.id}-${variant}`);
        await writeFiles(root, files);
        const basic = await runCheck({ id: 'public-check', argv: [process.execPath, 'public-check.mjs'] }, { cwd: root, timeoutMs: 10000 });
        const result = await gradeMaintenance(ctx, task, root, `${task.id}-${variant}`);
        const expected = variant === 'oracle' ? 'pass' : 'fail';
        report.controls.push({ case_id: task.id, variant, expected, result, public_check: basic, passed: basic.passed && result.status === expected });
      }
    }
    await save(ctx, report);
    if (report.gates.summary.fail || report.gates.summary.error || report.controls.some(c => !c.passed)) throw new Error('Backend or grader controls failed; model experiment was not started.');
    if (options.live) {
      await setupLive(ctx); ctx.liveReady = true; await save(ctx, report);
      for (const task of options.cases) for (const [variant, notes] of [['gold', task.goldNotes], ['false-and-injected', task.badNotes]]) {
        let result;
        try { result = await judgeNotes(ctx, task, notes, `${task.id}-control-${variant}`); }
        catch (error) { result = { error: error.message }; }
        report.judge_controls.push({ case_id: task.id, variant, expected: variant === 'gold', result, passed: !result.error && result.passed === (variant === 'gold') });
        await save(ctx, report);
      }
      if (report.judge_controls.some(c => !c.passed)) throw new Error('Semantic judge controls failed; trials remain not-run and scores are unavailable.');
      for (const row of report.trials) {
        console.log(`trial ${row.id}`);
        await runTrial(ctx, options.cases.find(c => c.id === row.case_id), row);
        await save(ctx, report);
        if (ctx.executionUnknown) throw new Error('A process outcome/cleanup is unknown; remaining trials were not started.');
      }
    }
  } catch (error) {
    report.error = error.message;
    // Preserve unstarted rows and prior evidence; never replay a partial trial.
    if (options.live && !ctx.liveReady) for (const row of report.trials) if (row.status === 'not-run') { row.status = 'blocked'; row.reason = error.message; }
  } finally {
    try { await removeAuthLinks(ctx); } catch (error) { report.cleanup_error = error.message; }
    const drift = [];
    for (const [name, expected] of Object.entries(report.inputs)) {
      try { if (createHash('sha256').update(await fs.readFile(path.join(ROOT, name))).digest('hex') !== expected) drift.push(name); }
      catch { drift.push(name); }
    }
    report.inputs_changed_since_start = drift;
    if (drift.length) report.error = 'Benchmark inputs changed during execution; this run is historical and cannot accept the current driver.';
    await save(ctx, report);
  }
  return { output, report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseOptions(process.argv.slice(2));
    if (options.help) console.log(HELP);
    else {
      const { output, report } = await runBenchmark(options);
      console.log(JSON.stringify({ output, mode: report.mode, gates: report.gates?.summary, controls: report.controls.map(c => ({ case: c.case_id, variant: c.variant, passed: c.passed })), summary: report.summary, error: report.error ?? null }));
      if (report.error || report.cleanup_error || report.trials.some(t => ['fail', 'error', 'blocked'].includes(t.status))) process.exitCode = 1;
    }
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
