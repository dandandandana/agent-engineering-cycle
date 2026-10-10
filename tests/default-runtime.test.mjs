import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { packageProvider } from '../../codex-sol/scripts/package-provider.mjs';
import { createRuntime } from '../src/runtime.mjs';
import { canonical, sha256 } from '../src/core/contracts.mjs';

const DOCS = ['docs/requirements.md','docs/design.md','docs/implementation.md'];
const GOAL = 'Produce blog links using the existing shared slug function and verify actual results.';
let providerParent; let providerManifest;
before(async () => { providerParent = await mkdtemp(path.join(os.tmpdir(), 'default-runtime-provider-')); const bundle = await packageProvider({ out: path.join(providerParent,'provider') }); providerManifest = path.join(bundle,'provider-manifest.json'); });
after(async () => { if (providerParent) await rm(providerParent,{recursive:true,force:true}); });
async function fixture(t, files = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(),'default-cycle-runtime-')); t.after(()=>rm(root,{recursive:true,force:true}));
  const home = await mkdtemp(path.join(os.tmpdir(),'default-cycle-home-')); t.after(()=>rm(home,{recursive:true,force:true}));
  for(const [p,text] of Object.entries(files)){await mkdir(path.dirname(path.join(root,p)),{recursive:true}); await writeFile(path.join(root,p),text);}
  const runtime = await createRuntime({workspaceRoot:root,env:{CODEX_HOME:home},hostModel:'gpt-6-luna',configurationOptions:{providerManifest}});
  return {root,home,runtime};
}
async function grant(runtime, scope, mode='implement') {
  return runtime.authority.issue({kind:'action',workspace_id:runtime.store.workspaceId,goal_digest:sha256(GOAL),mode,paths:scope,documentation_paths:DOCS.filter(p=>scope.includes(p)),actions:['control','artifact','apply','verify','qa','reconcile'],source:{adapter:'interactive-operator',fixture:true}}, {operatorConfirmed:true});
}
async function status(runtime){return runtime.invoke('cycle_status',{});}
async function call(runtime,name,args){const response=await runtime.invoke(name,{...args,binding:(await status(runtime)).binding,request_id:`req-${randomUUID()}`});assert.equal(response.ok,true,JSON.stringify(response.error ?? response.result));return {...response,...response.result};}
async function apply(runtime,root,pathValue,text){let before=null;try{before=sha256(await readFile(path.join(root,pathValue)));}catch{}return call(runtime,'cycle_apply',{targets:[{path:pathValue,action:'write',expected_sha256:before,content:text}]});}
async function attach(runtime,kind,p){const prepared=await runtime.invoke('cycle_artifact',{action:'prepare',kind,paths:[p]});assert.equal(prepared.ok,true,JSON.stringify(prepared.error));return call(runtime,'cycle_artifact',{action:'attach',kind,paths:[p],prepared_handle:prepared.prepared_handle});}

test('no configuration still has standard defaults; status and unauthorized work create no project records', async t=>{
  const {root,runtime}=await fixture(t);const initial=await status(runtime);
  assert.equal(initial.configured,false);assert.equal(initial.configuration.effective,true);assert.equal(initial.configuration.profile_id,'standard');assert.equal(initial.capabilities.qa_driver,false);
  const denied=await runtime.invoke('cycle_control',{action:'begin',request_id:'no-grant',goal:GOAL,scope:DOCS,inputs:DOCS,acceptance_ids:['BLOG-1']});assert.equal(denied.ok,false);
  const mutation=await runtime.invoke('cycle_apply',{request_id:'no-cycle',binding:{workspace_id:'0'.repeat(64),cycle_id:'fake',revision:0,basis_digest:'0'.repeat(64)},targets:[{path:'src/new.mjs',action:'write',expected_sha256:null,content:'x'}]});assert.equal(mutation.ok,false);
  assert.deepEqual(await readdir(root),[]);
});
test('exact signed documents bootstrap through cycle_apply, while arbitrary Markdown keeps the reuse gate',async t=>{
  const {root,runtime}=await fixture(t);const scope=[...DOCS,'content/business.md'];const g=await grant(runtime,scope);
  const begun=await runtime.invoke('cycle_control',{action:'begin',request_id:'begin-docs',goal:GOAL,grant_id:g.id,scope,inputs:DOCS,acceptance_ids:['BLOG-1'],authority_paths:{R:[DOCS[0]],D:[DOCS[1]],I:[DOCS[2]]}});assert.equal(begun.ok,true,JSON.stringify(begun.error));
  await apply(runtime,root,DOCS[0],'# Requirements\nBLOG-1: Preserve actual behavior.\n');
  await apply(runtime,root,DOCS[1],'# Design\nReuse plan will be attached.\n');
  await attach(runtime,'R',DOCS[0]);
  const denied=await runtime.invoke('cycle_apply',{binding:(await status(runtime)).binding,request_id:'business-md',targets:[{path:'content/business.md',action:'write',expected_sha256:null,content:'not authority'}]});assert.equal(denied.ok,false);assert.equal(denied.error.code,'REUSE_PLAN_REQUIRED');
  assert.equal((await status(runtime)).execution_plan.behavioral.status,'missing');
});
test('unregistered real source discovery permits consumer reuse and blocks stale shared writes',async t=>{
  const shared='export const slug = value => String(value).trim().toLowerCase().replace(/\\s+/g, "-");\n';
  const consumer='import { slug } from "./shared.mjs";\nexport const permalink = title => "/" + slug(title);\n';
  const check='import assert from "node:assert/strict";\nimport { permalink } from "../src/consumer.mjs";\nassert.equal(permalink(" Hello World "), "/posts/hello-world");\n';
  const {root,runtime}=await fixture(t,{'src/shared.mjs':shared,'src/consumer.mjs':consumer,'tests/blog.test.mjs':check});
  const scope=[...DOCS,'src/consumer.mjs','tests/blog.test.mjs'];const g=await grant(runtime,scope);
  const begun=await runtime.invoke('cycle_control',{action:'begin',request_id:'begin-reuse',goal:GOAL,grant_id:g.id,scope,inputs:[...scope,'src/shared.mjs'],acceptance_ids:['BLOG-1'],authority_paths:{R:[DOCS[0]],D:[DOCS[1]],I:[DOCS[2]]},check_plan:{planned_node_tests:[{id:'blog-behavior',path:'tests/blog.test.mjs'}]}});assert.equal(begun.ok,true,JSON.stringify(begun.error));
  await apply(runtime,root,DOCS[0],'# Requirements\nBLOG-1: Links must use /posts/ and the shared slug result.\n');await apply(runtime,root,DOCS[1],'# Design\n');
  const discovery=await call(runtime,'cycle_artifact',{action:'discover',kind:'D',query:{paths:['src/consumer.mjs'],capability:'slug'}});assert.equal(discovery.reuse_selection.complete,true,JSON.stringify(discovery.reuse_selection));
  const q=JSON.parse(runtime.store.evidence(discovery.evidence.id).payload.raw_text);const reads=[];
  for(const source of q.candidates){const r=await call(runtime,'cycle_artifact',{action:'read',kind:'D',path:source.path,line_ranges:[{start_line:1,end_line:Math.max(1,source.line_count)}]});reads.push(r.evidence.id);}
  const selected=q.candidates.find(c=>c.path==='src/shared.mjs');
  const decision={id:'blog-reuse',target_paths:['src/consumer.mjs','tests/blog.test.mjs'],acceptance_ids:['BLOG-1'],decision:'reuse',query_evidence_id:discovery.evidence.id,selected_sources:[{candidate_id:selected.candidate_id,path:selected.path,sha256:selected.sha256}],read_evidence_ids:reads,candidate_assessments:[],rationale:'Use the existing normalization implementation; update the consumer prefix and test it.',path_roles:[{path:'src/consumer.mjs',role:'consumer'},{path:'tests/blog.test.mjs',role:'consumer'}]};
  await apply(runtime,root,DOCS[1],'# Design\n\n```cycle-reuse-v2\n'+JSON.stringify(canonical([decision]),null,2)+'\n```\n');await attach(runtime,'R',DOCS[0]);await attach(runtime,'D',DOCS[1]);
  await apply(runtime,root,'src/consumer.mjs',consumer.replace('"/"','"/posts/"'));
  const verified=await call(runtime,'cycle_verify',{check_ids:['source-integrity','blog-behavior']});assert.equal(verified.passed,true);assert.equal((await status(runtime)).reuse.status,'in_progress');
  assert.equal(await readFile(path.join(root,'src/shared.mjs'),'utf8'),shared);
  await writeFile(path.join(root,'src/shared.mjs'),shared+'// external drift\n');
  const stale=await status(runtime);assert.ok(stale.blockers.some(b=>b.kind==='reuse'));
});
test('a second host session gets a readonly pointer and must explicitly join before persistent work',async t=>{
  const {runtime}=await fixture(t);const g=await grant(runtime,DOCS,'docs');const session=randomUUID();
  const begin=await runtime.invoke('cycle_control',{action:'begin',request_id:'session-begin',goal:GOAL,grant_id:g.id,scope:DOCS,inputs:DOCS,acceptance_ids:['BLOG-1']},{hostSessionId:session});assert.equal(begin.ok,true,JSON.stringify(begin.error));
  const other=randomUUID();const pointer=await runtime.invoke('cycle_status',{}, {hostSessionId:other});assert.equal(pointer.binding,null);assert.equal(pointer.active_cycle.writable_binding,false);
  const explicit=await runtime.invoke('cycle_status',{cycle_id:pointer.active_cycle.cycle_id},{hostSessionId:other});assert.ok(explicit.binding);
  const denied=await runtime.invoke('cycle_apply',{binding:explicit.binding,request_id:'other-apply',targets:[{path:DOCS[0],action:'write',expected_sha256:null,content:'x'}]},{hostSessionId:other});assert.equal(denied.error.code,'SESSION_UNBOUND');
  assert.deepEqual(await runtime.handleHook({hook_event_name:'UserPromptSubmit',session_id:other,cwd:runtime.store.root}),{});
  assert.deepEqual(await runtime.handleHook({hook_event_name:'PreToolUse',session_id:other,cwd:runtime.store.root,tool_name:'Write',tool_input:{file_path:'outside.txt'}}),{});
  assert.equal((await runtime.handleHook({hook_event_name:'PreToolUse',session_id:other,cwd:runtime.store.root,tool_name:'Write',tool_input:{file_path:DOCS[0]}})).hookSpecificOutput.permissionDecision,'deny');
});

test('settled own creations remain usable, but an external new file invalidates empty discovery', async t => {
  const { root, runtime } = await fixture(t); const scope = [...DOCS, 'src/new.mjs', 'tests/new.test.mjs']; const g = await grant(runtime, scope);
  const begun = await runtime.invoke('cycle_control', { action:'begin', request_id:'begin-empty', goal:GOAL, grant_id:g.id,
    scope, inputs:scope, acceptance_ids:['BLOG-1'], check_plan:{planned_node_tests:[{id:'new-behavior',path:'tests/new.test.mjs'}]} });
  assert.equal(begun.ok,true,JSON.stringify(begun.error));
  await apply(runtime,root,DOCS[0],'# Requirement\nBLOG-1: greeting is Hello.\n'); await apply(runtime,root,DOCS[1],'# Design\n');
  const discovery = await call(runtime,'cycle_artifact',{action:'discover',kind:'D',query:{paths:[],capability:''}});
  const q = JSON.parse(runtime.store.evidence(discovery.evidence.id).payload.raw_text);
  assert.equal(q.candidates.length,0); assert.equal(q.collection_stable,true);
  const d = {id:'new-greeting',target_paths:['src/new.mjs','tests/new.test.mjs'],acceptance_ids:['BLOG-1'],decision:'new',
    query_evidence_id:discovery.evidence.id,selected_sources:[],read_evidence_ids:[],candidate_assessments:[],rationale:'The complete authorized source inventory is empty.',path_roles:[]};
  await apply(runtime,root,DOCS[1],'# Design\n\n```cycle-reuse-v2\n'+JSON.stringify(canonical([d]),null,2)+'\n```\n');
  await attach(runtime,'R',DOCS[0]); await attach(runtime,'D',DOCS[1]);
  await apply(runtime,root,'src/new.mjs','export const greeting = () => "Hello";\n');
  await apply(runtime,root,'tests/new.test.mjs','import assert from "node:assert/strict";\nimport {greeting} from "../src/new.mjs";\nassert.equal(greeting(),"Hello");\n');
  assert.equal((await status(runtime)).reuse.status,'in_progress');
  const before=(await status(runtime)).binding;
  await writeFile(path.join(root,'src/external.mjs'),'export const greeting = () => "Existing alternative";\n');
  const drift=await status(runtime); assert.notEqual(drift.binding.basis_digest,before.basis_digest);
  assert.ok(drift.blockers.some(b=>b.kind==='reuse')); assert.equal(drift.reuse.diagnostic.code,'REUSE_STALE');
  const denied=await runtime.invoke('cycle_apply',{binding:drift.binding,request_id:'after-external',targets:[{path:'src/new.mjs',action:'write',expected_sha256:sha256(await readFile(path.join(root,'src/new.mjs'))),content:'wrong'}]});
  assert.equal(denied.ok,false); assert.equal(denied.error.code,'REUSE_STALE');
});

test('a real bundled pure validator recognizes existing declarations without executing the provider', async t => {
  const architecture = {schema_version:1,modules:[{uid:'00000001',id:'blog',parent:null,name:{zh:'博客',en:'Blog'},description:{zh:'博客链接',en:'Blog links'},
    source:[{path:'src/shared.mjs'}],revision:'a'.repeat(40),updated_at:'2026-10-10T00:00:00Z',fingerprint:'b'.repeat(64)}],
    policy:{schema_version:1,updated_at:'2026-10-10T00:00:00Z',rules:[]}};
  const {root,runtime}=await fixture(t,{'architecture.json':JSON.stringify(architecture),'src/shared.mjs':'export const slug = x => x;\n'});
  const s=await status(runtime); assert.equal(s.configuration.effective,true); assert.equal(s.registration_source_fact.path,'architecture.json');
  assert.equal(s.registration_source_fact.sha256,sha256(JSON.stringify(architecture)));
  assert.deepEqual((await readdir(root)).sort(),['architecture.json','src']);
  // Declaration recognition makes no graph-readiness or QA claim.
  assert.equal(s.capabilities.qa_driver,false); assert.equal(s.binding,null);
});
