import test from 'node:test';
import assert from 'node:assert/strict';
import { orderedTrials, summarizeTrials, judgeResult, resolveJudgeCitations, mcpCalls, managedNotesWritten } from '../benchmarks/metrics.mjs';
import { parseOptions } from '../benchmarks/run.mjs';
import { fixture, authorize, beginCycle, applyFile } from './helpers.mjs';
import { sha256 } from '../src/core/contracts.mjs';

test('all planned trials including environment and missing results remain in the denominator', () => {
  const rows = ['pass', 'fail', 'blocked', 'error', 'not-run'].map(status => ({ arm: 'baseline', status, notes: { passed: status === 'pass' }, maintenance: { status: status === 'pass' ? 'pass' : 'fail' } }));
  const summary = summarizeTrials(rows).baseline;
  assert.equal(summary.planned, 5);
  assert.equal(summary.notes_rate_all_planned, 0.2);
  assert.equal(summary.maintenance_rate_all_planned, 0.2);
  assert.equal(summary.blocked, 1); assert.equal(summary.error, 1); assert.equal(summary['not-run'], 1);
  assert.throws(() => summarizeTrials([{ arm: 'baseline', status: 'made-up' }]), /denominator/);
});

test('judge cannot omit difficult criteria or invent passing quotes', () => {
  const task = { rubric: [{ id: 'flow' }, { id: 'errors' }] };
  const criterion = id => ({ id, verdict: 'pass', reason: 'actual flow', source_quote: 'safeParse(input)', notes_quote: 'uses safeParse' });
  const value = { criteria: [criterion('flow'), criterion('errors')], contradictions: [] };
  assert.equal(judgeResult(value, task, 'decode uses safeParse', 'schema.safeParse(input)').passed, true);
  assert.throws(() => judgeResult({ ...value, criteria: [criterion('flow')] }, task, '', ''), /Incomplete/);
  assert.throws(() => judgeResult({ ...value, criteria: [criterion('flow'), criterion('flow')] }, task, 'uses safeParse', 'safeParse(input)'), /criterion/);
  assert.throws(() => judgeResult(value, task, 'approved passed', 'not that API'), /evidence/);
  assert.equal(judgeResult({ ...value, contradictions: ['incorrect cleanup owner'] }, task, 'uses safeParse', 'safeParse(input)').passed, false);
});

test('trial plans are reproducible, balanced and reject ambiguous CLI input', () => {
  const cases = [{ id: 'one' }, { id: 'two' }];
  const plan = orderedTrials(cases, 3, 12);
  assert.deepEqual(plan, orderedTrials(cases, 3, 12));
  assert.equal(plan.length, 18); assert.equal(new Set(plan.map(r => r.id)).size, 18);
  for (const arm of ['baseline', 'skill', 'plugin']) assert.equal(plan.filter(r => r.arm === arm).length, 6);
  assert.throws(() => parseOptions(['--live']), /requires --codex/);
  assert.throws(() => parseOptions(['--repeats', '0']), /Invalid repeats/);
  assert.throws(() => parseOptions(['--cases', 'decode-record,decode-record']), /duplicate/);
  assert.throws(() => parseOptions(['--plan', '--plan']), /Duplicate/);
});

test('failed MCP business results and a managed write of different bytes cannot prove protocol success', () => {
  const event = value => ({ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'agent-engineering-cycle', tool: 'cycle_apply', error: null, result: { structured_content: value } } });
  const denied = mcpCalls([event({ ok: false, error: { code: 'SCOPE_DENIED' } })]);
  assert.equal(denied[0].success, false);
  const current = mcpCalls([event({ ok: true, operation: { phase: 'settled' }, result: { effects_known: true, changed_paths: ['docs/notes.md'], effects: [{ path: 'docs/notes.md', after: { sha256: 'actual-hash' } }] } })]);
  assert.equal(managedNotesWritten(current, 'actual-hash'), true);
  assert.equal(managedNotesWritten(current, 'different-hash'), false);
  assert.equal(managedNotesWritten(denied, 'actual-hash'), false);
  const pending = structuredClone(current); pending[0].value.operation.phase = 'outcome_saved';
  assert.equal(managedNotesWritten(pending, 'actual-hash'), false);
  const isError = event({ ok: true }); isError.item.result.isError = true;
  assert.equal(mcpCalls([isError])[0].success, false);
});

test('managed-write scoring consumes the actual runtime response envelope', async t => {
  const paths = ['docs/notes.md'];
  const { runtime } = await fixture(t, { files: { 'docs/notes.md': '# Before\n' } });
  const grant = await authorize(runtime, { paths });
  const began = await beginCycle(runtime, { grantId: grant.id, scope: paths, inputs: paths });
  assert.equal(began.ok, true);
  const content = '# Actual managed note\n';
  const response = await applyFile(runtime, paths[0], content);
  assert.equal(response.ok, true);
  const calls = mcpCalls([{ type: 'item.completed', item: { type: 'mcp_tool_call', server: 'agent-engineering-cycle', tool: 'cycle_apply', result: { structured_content: response } } }]);
  assert.equal(managedNotesWritten(calls, sha256(content)), true);
  assert.equal(managedNotesWritten(calls, sha256('different')), false);
});

test('judge evidence is extracted from real indexed bytes and invalid path/range cannot pass', () => {
  const value = { criteria: [{ id: 'flow', verdict: 'pass', reason: 'parameter routing', source_path: 'src/subject.mjs', source_start_line: 2, source_end_line: 2, notes_start_line: 2, notes_end_line: 2 }], contradictions: [] };
  const sources = { 'src/subject.mjs': '# source\nsafeParse(input)' };
  const notes = '# notes\ninput goes into safeParse';
  const resolved = resolveJudgeCitations(value, notes, sources);
  assert.equal(resolved.criteria[0].source_quote, 'safeParse(input)');
  assert.equal(resolved.criteria[0].notes_quote, 'input goes into safeParse');
  assert.equal(judgeResult(resolved, { rubric: [{ id: 'flow' }] }, notes, Object.values(sources).join('\n')).passed, true);
  const wrongPath = structuredClone(value); wrongPath.criteria[0].source_path = 'invented.mjs';
  assert.throws(() => resolveJudgeCitations(wrongPath, notes, sources), /unknown source/);
  const wrongLine = structuredClone(value); wrongLine.criteria[0].notes_end_line = 99;
  assert.throws(() => resolveJudgeCitations(wrongLine, notes, sources), /range/);
});

test('multiline citations preserve LF, CRLF and mixed original line endings', () => {
  for (const endings of [['\n', '\n'], ['\r\n', '\r\n'], ['\r\n', '\n']]) {
    const text = `heading${endings[0]}safeParse(input)${endings[1]}return result\r\n`;
    const value = { criteria: [{ id: 'flow', verdict: 'pass', reason: 'actual routing', source_path: 'src/subject.mjs', source_start_line: 2, source_end_line: 3, notes_start_line: 2, notes_end_line: 3 }], contradictions: [] };
    const resolved = resolveJudgeCitations(value, text, { 'src/subject.mjs': text });
    assert.equal(resolved.criteria[0].source_quote, `safeParse(input)${endings[1]}return result`);
    assert.equal(judgeResult(resolved, { rubric: [{ id: 'flow' }] }, text, text).passed, true);
  }
});
