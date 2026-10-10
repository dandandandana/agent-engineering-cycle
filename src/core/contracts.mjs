import { createHash } from 'node:crypto';
import { z } from 'zod';

export class CycleError extends Error {
  constructor(code, message, details = {}) { super(message); this.name = 'CycleError'; this.code = code; this.details = details; }
}
export const fault = (code, message, details = {}) => new CycleError(code, message, details);
export const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, canonical(value[k])]));
  return value;
}
export const digest = (value) => sha256(JSON.stringify(canonical(value)));
/**
 * 在调用方校验的非负UTF-16 offset/limit预算内返回完整字符和实际下一游标。
 * charCodeAt判定边界是否落在代理项对中；起点非法拒绝，终点回退一单元，再用String.slice。
 * 不读写/修改输入；不把游标改成字节或码点计数。预算太小时可能返回空页，分页接口须拒绝零进度。
 */
export function textPage(text, offset, limit) {
  const split = at => at > 0 && at < text.length && text.charCodeAt(at - 1) >= 0xD800 && text.charCodeAt(at - 1) <= 0xDBFF && text.charCodeAt(at) >= 0xDC00 && text.charCodeAt(at) <= 0xDFFF;
  if (split(offset)) throw fault('EVIDENCE_INVALID', 'Text offset must begin at a complete Unicode character.');
  let end = Math.min(text.length, offset + limit);
  if (split(end)) end -= 1;
  return { text: text.slice(offset, end), next_offset: end < text.length ? end : null };
}
export const CONTRACT_REVISION = 3;
export const QA_POLICY = { id: 'engineering-cycle-independent', revision: 1 };
export const QA_ASSURANCE_KEYS = Object.freeze(['distinct_execution','fresh_session','frozen_input_delivery','permission_observed','terminal_observed']);
export const TOOL_NAMES = ['cycle_control', 'cycle_status', 'cycle_artifact', 'cycle_apply', 'cycle_verify', 'cycle_qa', 'cycle_reconcile'];

const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.string().min(1).max(1024);
const paths = z.array(file).min(1).max(256);
export const implementationTargetSchema = z.object({ path: file, symbol: z.string().min(1).max(160) }).strict();
const sourceIdentity = z.object({ path: file, sha256: hash }).strict();
export const implementationNoteSchema = z.object({
  source: implementationTargetSchema.extend({ sha256: hash }).strict(),
  documentation: sourceIdentity.extend({ start_line: z.number().int().min(1), end_line: z.number().int().min(1) }).strict().refine(d => d.end_line >= d.start_line && d.end_line - d.start_line < 128, 'Documentation must select 1 to 128 lines'),
  related_sources: z.array(sourceIdentity).max(8).default([]),
}).strict();
export const bindingSchema = z.object({ workspace_id: hash, cycle_id: id, revision: z.number().int().nonnegative(), basis_digest: hash }).strict();
const optionalBinding = bindingSchema.optional();
const target = z.object({ path: file, action: z.enum(['write', 'delete']), expected_sha256: hash.nullable(), content: z.string().max(1024 * 1024).optional() }).strict().refine(t => t.action !== 'write' || t.content !== undefined, 'Write needs content');
const base = { binding: bindingSchema, request_id: id };
export const REUSE_PROTOCOL = 'sol-component-discovery/1';
export const REPOSITORY_PROTOCOL = 'sol-component-discovery/2';
export const CHECK_APPLICABILITY_ID = 'CYCLE-CHECK-APPLICABILITY';
export const REUSE_ERRORS = Object.freeze({ required: 'REUSE_PLAN_REQUIRED', stale: 'REUSE_STALE', unavailable: 'PROVIDER_UNAVAILABLE', policy: 'POLICY_CONFLICT' });
export const REUSE_PATH_ROLES = Object.freeze(['consumer', 'candidate', 'caller', 'registry', 'dependency']);
export const reuseDecisionSchema = z.object({
  id, target_paths: z.array(file).min(1).max(64), acceptance_ids: z.array(id).min(1).max(128),
  decision: z.enum(['reuse', 'extend', 'new']),
  selected_capabilities: z.array(z.object({ uid: z.string().min(1).max(160), symbol: z.string().min(1).max(160) }).strict()).max(32),
  query_evidence_id: id, read_evidence_ids: z.array(id).max(64), rationale: z.string().trim().min(1).max(2000),
  path_roles: z.array(z.object({ path: file, role: z.enum(REUSE_PATH_ROLES) }).strict()).max(256),
}).strict().refine(d => d.decision === 'new' || d.selected_capabilities.length > 0, 'Reuse/extend needs a selected capability');
export const repositoryReuseDecisionSchema = z.object({
  id, target_paths: z.array(file).min(1).max(64), acceptance_ids: z.array(id).min(1).max(128),
  decision: z.enum(['reuse', 'extend', 'new']), query_evidence_id: id,
  selected_sources: z.array(sourceIdentity.extend({ candidate_id: hash }).strict()).max(32),
  read_evidence_ids: z.array(id).max(128),
  candidate_assessments: z.array(z.object({ candidate_id: hash, conclusion: z.enum(['selected', 'not_applicable']), read_evidence_ids: z.array(id).min(1).max(128), rationale: z.string().trim().min(1).max(512) }).strict()).max(128),
  rationale: z.string().trim().min(1).max(2000), path_roles: z.array(z.object({ path: file, role: z.enum(REUSE_PATH_ROLES) }).strict()).max(256),
}).strict().refine(d => d.decision === 'new' ? d.selected_sources.length === 0 : d.selected_sources.length > 0, 'Select real sources for reuse/extend, and no sources for new');
const checkPlanSchema = z.object({
  selected_ids: z.array(id).max(32).optional(),
  exclusions: z.array(z.object({ id, reason: z.string().trim().min(1).max(512) }).strict()).max(32).optional(),
  planned_node_tests: z.array(z.object({ id, path: file }).strict()).max(16).optional(),
  behavioral_applicability: z.object({ status: z.enum(['required', 'not_applicable']), reason: z.string().trim().min(1).max(512) }).strict().optional(),
}).strict();
const artifactBase = { kind: z.enum(['R', 'D', 'I', 'Delta']), paths, binding: optionalBinding, request_id: id.optional(), prepared_handle: hash.optional(), implementation_notes: z.array(implementationNoteSchema).max(16).optional() };
const lineRange = z.object({ start_line: z.number().int().min(1), end_line: z.number().int().min(1) }).strict().refine(r => r.end_line >= r.start_line && r.end_line - r.start_line < 128, 'Read a complete range of 1 to 128 lines');
const artifactSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('prepare'), ...artifactBase }).strict(),
  z.object({ action: z.literal('attach'), ...artifactBase }).strict(),
  z.object({ action: z.literal('discover'), kind: z.literal('D'), ...base, query: z.object({ paths: z.array(file).max(16).default([]), capability: z.string().max(256).default('') }).strict() }).strict(),
  z.object({ action: z.literal('read'), kind: z.literal('D'), ...base, path: file, line_ranges: z.array(lineRange).min(1).max(8) }).strict(),
]);
export const TOOL_SCHEMAS = {
  cycle_status: z.object({ cycle_id: id.optional(), evidence_id: id.optional(), offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(32768).default(8192) }).strict(),
  cycle_control: z.object({ action: z.enum(['begin', 'resume', 'abandon', 'finish']), request_id: id, binding: optionalBinding, goal: z.string().min(1).max(2000).optional(), grant_id: id.optional(), scope: paths.optional(), inputs: paths.optional(), acceptance_ids: z.array(id).max(128).optional(), implementation_targets: z.array(implementationTargetSchema).max(16).optional(), authority_paths: z.object({ R: paths.optional(), D: paths.optional(), I: paths.optional() }).strict().optional(), check_plan: checkPlanSchema.optional(), semantic_verdict: z.object({ original_goal_covered: z.boolean(), unresolved_findings: z.array(z.string().max(512)).max(64), evidence_refs: z.array(id).max(256) }).strict().optional(), reason: z.string().max(1000).optional() }).strict(),
  cycle_artifact: artifactSchema,
  cycle_apply: z.object({ ...base, targets: z.array(target).min(1).max(64) }).strict(),
  cycle_verify: z.object({ ...base, check_ids: z.array(id).min(1).max(32) }).strict(),
  cycle_qa: z.object({ action: z.enum(['start', 'status', 'cancel']), binding: optionalBinding, request_id: id.optional(), job_id: id.optional() }).strict(),
  cycle_reconcile: z.object({ ...base, action: z.enum(['propose', 'approve', 'plan', 'settle']), delta_id: id, description: z.string().max(2000).optional(), decision_id: id.optional(), targets: z.array(target).max(64).optional() }).strict(),
};

export function safeError(error) {
  return { code: error instanceof CycleError ? error.code : 'IO_ERROR', message: error instanceof CycleError ? error.message : 'Local operation failed; inspect the operation evidence.', ...(error instanceof CycleError ? { details: error.details } : {}) };
}
