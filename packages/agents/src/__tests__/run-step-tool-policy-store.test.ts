import { beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
const h=vi.hoisted(()=>({bound:undefined as unknown,run:{id:"run",orgId:"org",status:"running",executionAttemptId:"attempt",a2aContextId:"ctx",templateId:"tmpl"} as Record<string,unknown>,calls:[] as string[],template:undefined as undefined|{packageVersion:string|null;approvalPolicy:string},templates:{packageVersion:"pv",approvalPolicy:"ap",tag:"agentTemplates"}}));
vi.mock("../schema",()=>({agentRuns:{id:"id",orgId:"org"},agentRunOutwardActionPolicies:{runId:"run",orgId:"org",policy:"policy"},agentTemplates:h.templates}));
// cinatra#3089: the pause's read of the bound row (readRunPauseSteps) is a plain select.
vi.mock("../db",()=>({db:{transaction:()=>{throw Error("must use guarded seam");},select:()=>({from(){return this;},where:async()=>h.bound?[{policy:(h.bound as {policy:unknown}).policy}]:[]})}}));
vi.mock("../org-write-run-seam",()=>({guardedRunWrite:async(authority:unknown,input:{orgId:string;runId:string},body:(tx:object)=>Promise<unknown>)=>{
 if(!authority||input.orgId!=="org"||input.runId!=="run")throw Error("ordinary authority refused");h.calls.push("org-first-guard");let n=0;
 const tx={select:()=>{let table:unknown;return {from(t:unknown){table=t;return this;},where(){if(table===h.templates){h.calls.push("template-read");return Promise.resolve(h.template?[h.template]:[]);}return this;},for(){const current=n++;h.calls.push("row-fence");return Promise.resolve(current===0?[h.run]:h.bound?[h.bound]:[]);}};},insert:()=>({values:(value:unknown)=>({onConflictDoNothing:async()=>{h.calls.push("insert-once");h.bound??=value;}})}),
  update:()=>({set:(value:{executionAttemptId:string})=>({where:()=>({returning:async()=>{h.calls.push("move");if(!h.bound)return [];h.bound={...(h.bound as object),...value};return [{runId:"run"}];}})})})};return body(tx);
}}));
// The module is new with cinatra#3745. It is loaded here, not by a static import, so that before the
// change this file still loads and its first case fails by an assertion on the missing module.
const storeModule=await import("../run-step-tool-policy-store").catch(()=>undefined);
const { bindRunStepToolPolicy }=(storeModule??{}) as typeof import("../run-step-tool-policy-store");
it("the run step tool policy store module exists (cinatra#3745)",()=>{expect(storeModule).toBeDefined();});
const source=JSON.stringify({flow:{id:"step"}});const hash=createHash("sha256").update(source).digest("hex");
const policy={version:1,contextId:"ctx",sourceSha256:hash,executedSourceSha256:hash,declarationSourceSha256:hash,source} as const;
const input=()=>({orgId:"org",runId:"run",executionAttemptId:"attempt",policy,authority:{} as never});
beforeEach(()=>{h.bound=undefined;h.calls=[];h.template=undefined;h.run={id:"run",orgId:"org",status:"running",executionAttemptId:"attempt",a2aContextId:"ctx",templateId:"tmpl"};});
describe("immutable first dispatch source binding through actual guarded store seam",()=>{
 it("takes org authority then run lock and inserts exactly once",async()=>{
  await bindRunStepToolPolicy(input());expect(h.calls.slice(0,3)).toEqual(["org-first-guard","row-fence","insert-once"]);expect((h.bound as {policy:unknown}).policy).toEqual(policy);
  await bindRunStepToolPolicy(input());expect(h.bound).toEqual({policy,runId:"run",orgId:"org",executionAttemptId:"attempt"});
 });
 it("refuses mutable source rebinding under the same run",async()=>{
  await bindRunStepToolPolicy(input());await expect(bindRunStepToolPolicy({...input(),policy:{...policy,executedSourceSha256:"f".repeat(64)}})).rejects.toThrow("step_tool_dispatch_rebind_refused");expect((h.bound as {policy:unknown}).policy).toEqual(policy);
 });
 it("a retried run under a fresh attempt moves the binding only for the identical graph (the failed-run retry)",async()=>{
  await bindRunStepToolPolicy(input());h.run.executionAttemptId="attempt-b";
  await bindRunStepToolPolicy({...input(),executionAttemptId:"attempt-b"});
  expect(h.bound).toEqual({policy,runId:"run",orgId:"org",executionAttemptId:"attempt-b"});
  h.run.executionAttemptId="attempt-c";
  await expect(bindRunStepToolPolicy({...input(),executionAttemptId:"attempt-c",policy:{...policy,executedSourceSha256:"f".repeat(64)}})).rejects.toThrow("step_tool_dispatch_rebind_refused");
  expect(h.bound).toEqual({policy,runId:"run",orgId:"org",executionAttemptId:"attempt-b"});
 });
 it("refuses absent authority, stopped run, wrong context and stale attempt",async()=>{
  await expect(bindRunStepToolPolicy({...input(),authority:undefined as never})).rejects.toThrow("ordinary authority refused");
  for(const change of [{status:"completed"},{a2aContextId:"other"},{executionAttemptId:"other"}]){Object.assign(h.run,{status:"running",a2aContextId:"ctx",executionAttemptId:"attempt"},change);await expect(bindRunStepToolPolicy(input())).rejects.toThrow("step_tool_dispatch_binding_mismatch");expect(h.bound).toBeUndefined();}
 });
});

// cinatra#3089: the steps that classify the run's pauses are bound beside its source, in the same row and write: the
// template row read in the bind's transaction (after the source was selected), only when it equals the dispatch's
// read from before the selection. A pause reads that record, never the template row.
describe("the pause steps bound beside the source (cinatra#3089)",()=>{
 const steps={steps:[{stepNumber:1,artifactReviewGateNode:"g",artifactReviewTargetsInput:"t"}]};
 const read={packageVersion:"1.0.0",approvalPolicy:steps};
 const serde=()=>import("../agent-run-serde");
 it("binds the row's version and steps when the row read in the bind equals the dispatch's read (keys in any order)",async()=>{
  h.template={packageVersion:"1.0.0",approvalPolicy:JSON.stringify({steps:[{artifactReviewTargetsInput:"t",artifactReviewGateNode:"g",stepNumber:1}]})};
  await bindRunStepToolPolicy({...input(),dispatchTemplateRead:read} as never);
  expect(h.calls.slice(0,4)).toEqual(["org-first-guard","row-fence","template-read","insert-once"]);
  expect((await (await serde()).readRunPauseSteps("run","org")).packageVersion).toBe("1.0.0");
  expect((await (await serde()).readRunPauseSteps("run","org")).approvalPolicy).toEqual({steps:[{stepNumber:1,artifactReviewGateNode:"g",artifactReviewTargetsInput:"t"}]});
 });
 it("an install or recompile between the dispatch's read and the bind (version or steps differ, or the row is gone): no steps are bound, the pause read fails",async()=>{
  for(const row of [{packageVersion:"2.0.0",approvalPolicy:JSON.stringify(steps)},{packageVersion:"1.0.0",approvalPolicy:JSON.stringify({steps:[]})},undefined]){
   h.bound=undefined;h.template=row;
   await bindRunStepToolPolicy({...input(),dispatchTemplateRead:read} as never);
   await expect((await serde()).readRunPauseSteps("run","org")).rejects.toThrow("no settled pause steps");
  }
 });
 it("a row whose steps are no object (null) binds nothing the pause can use: the pause read fails",async()=>{
  h.template={packageVersion:"1.0.0",approvalPolicy:"null"};
  await bindRunStepToolPolicy({...input(),dispatchTemplateRead:{packageVersion:"1.0.0",approvalPolicy:null}} as never);
  await expect((await serde()).readRunPauseSteps("run","org")).rejects.toThrow("no settled pause steps");
 });
 it("a run bound without them (before they were bound): the pause read fails; the source binding itself is unchanged",async()=>{
  await bindRunStepToolPolicy(input());
  expect((h.bound as {policy:unknown}).policy).toEqual(policy);
  await expect((await serde()).readRunPauseSteps("run","org")).rejects.toThrow("no settled pause steps");
 });
 it("a retry re-binds the same source and keeps the first dispatch's steps",async()=>{
  h.template={packageVersion:"1.0.0",approvalPolicy:JSON.stringify(steps)};
  await bindRunStepToolPolicy({...input(),dispatchTemplateRead:read} as never);
  h.run.executionAttemptId="attempt-b";h.template={packageVersion:"2.0.0",approvalPolicy:JSON.stringify({steps:[]})};
  await bindRunStepToolPolicy({...input(),executionAttemptId:"attempt-b",dispatchTemplateRead:{packageVersion:"2.0.0",approvalPolicy:{steps:[]}}} as never);
  expect((await (await serde()).readRunPauseSteps("run","org")).packageVersion).toBe("1.0.0");
 });
});
