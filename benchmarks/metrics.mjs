export function summarizeTrials(trials) {
  const result = {};
  for (const arm of ['baseline', 'skill', 'plugin']) {
    const rows = trials.filter(t => t.arm === arm);
    const counts = Object.fromEntries(['pass', 'fail', 'blocked', 'error', 'not-run'].map(s => [s, rows.filter(r => r.status === s).length]));
    const measured = rows.filter(r => r.status !== 'not-run' && r.status !== 'blocked');
    result[arm] = {
      planned: rows.length, ...counts,
      notes_pass: rows.filter(r => r.notes?.passed === true).length,
      maintenance_pass: rows.filter(r => r.maintenance?.status === 'pass').length,
      maintenance_notes_pass: rows.filter(r => r.maintenance_notes?.passed === true).length,
      notes_rate_all_planned: rows.length ? rows.filter(r => r.notes?.passed === true).length / rows.length : null,
      maintenance_rate_all_planned: rows.length ? rows.filter(r => r.maintenance?.status === 'pass').length / rows.length : null,
      measured: measured.length,
      total_duration_ms: rows.reduce((n, r) => n + (r.duration_ms ?? 0), 0),
    };
    if (Object.values(counts).reduce((a, b) => a + b, 0) !== rows.length) throw new Error('Invalid trial denominator.');
  }
  return result;
}

export function judgeResult(value, task, notes, sources) {
  const ids = task.rubric.map(r => r.id);
  if (!value || !Array.isArray(value.criteria) || value.criteria.length !== ids.length || !Array.isArray(value.contradictions)) throw new Error('Incomplete judge result.');
  const seen = new Set();
  for (const item of value.criteria) {
    if (!ids.includes(item.id) || seen.has(item.id) || !['pass', 'fail', 'unknown'].includes(item.verdict) || typeof item.reason !== 'string') throw new Error('Invalid judge criterion.');
    seen.add(item.id);
    if (item.verdict === 'pass' && (typeof item.notes_quote !== 'string' || item.notes_quote.length < 4 || !notes.includes(item.notes_quote) || typeof item.source_quote !== 'string' || item.source_quote.length < 4 || !sources.includes(item.source_quote))) throw new Error('Passing judgment lacks literal source/notes evidence.');
  }
  return { ...value, passed: value.criteria.every(c => c.verdict === 'pass') && value.contradictions.length === 0,
    accuracy: value.criteria.filter(c => c.verdict === 'pass').length / ids.length,
    assurance: 'Fresh reference-guided model judgment; control-calibrated, not human-validated.' };
}

export function resolveJudgeCitations(value, notes, sources) {
  const span = (text, start, end) => {
    const starts = [0];
    for (let at = text.indexOf('\n'); at !== -1; at = text.indexOf('\n', at + 1)) starts.push(at + 1);
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > starts.length || end - start >= 128) throw new Error('Judge citation range is invalid.');
    let until = end < starts.length ? starts[end] - 1 : text.length;
    if (end < starts.length && text[until - 1] === '\r') until--;
    return text.slice(starts[start - 1], until);
  };
  if (!value || !Array.isArray(value.criteria)) throw new Error('Missing judge criteria.');
  return { ...value, criteria: value.criteria.map(item => {
    if (item.verdict !== 'pass') return { ...item, source_quote: '', notes_quote: '' };
    if (!Object.hasOwn(sources, item.source_path)) throw new Error('Judge cited an unknown source path.');
    return { ...item, source_quote: span(sources[item.source_path], item.source_start_line, item.source_end_line),
      notes_quote: span(notes, item.notes_start_line, item.notes_end_line) };
  }) };
}

export function orderedTrials(cases, repeats, seed = 42) {
  let state = seed >>> 0;
  const random = () => { state = (Math.imul(state, 1664525) + 1013904223) >>> 0; return state / 4294967296; };
  const rows = [];
  for (let repeat = 1; repeat <= repeats; repeat++) for (const task of cases) {
    const arms = ['baseline', 'skill', 'plugin'];
    for (let i = arms.length - 1; i > 0; i--) { const j = Math.floor(random() * (i + 1)); [arms[i], arms[j]] = [arms[j], arms[i]]; }
    for (const arm of arms) rows.push({ id: `${task.id}-${arm}-${repeat}`, case_id: task.id, arm, repeat, status: 'not-run' });
  }
  return rows;
}

export function mcpCalls(events) {
  return events.filter(e => e.type === 'item.completed' && e.item?.type === 'mcp_tool_call').map(({ item }) => {
    let value = item.result?.structured_content ?? item.result?.structuredContent;
    if (!value) { try { value = JSON.parse(item.result?.content?.find(c => c.type === 'text')?.text); } catch {} }
    return { server: item.server, tool: item.tool, error: item.error ?? null, value: value ?? null,
      success: !item.error && item.result?.isError !== true && item.result?.is_error !== true && value?.ok === true };
  });
}

export function managedNotesWritten(calls, notesHash) {
  return calls.some(c => c.tool === 'cycle_apply' && c.success && c.value.operation?.phase === 'settled'
    && c.value.result?.effects_known === true && c.value.result.changed_paths?.includes('docs/notes.md')
    && c.value.result.effects?.some(e => e.path === 'docs/notes.md' && e.after?.sha256 === notesHash));
}
