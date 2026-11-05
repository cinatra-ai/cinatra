import { beforeEach, describe, it, expect, vi } from "vitest";
import { createHash } from "node:crypto";
const h=vi.hoisted(()=>({bound:undefined as unknown,run:{id:"run",orgId:"org",status:"running",executionAttemptId:"attempt",a2aContextId:"ctx"},calls:[] as string[]}));
vi.mock("../schema",()=>({agentRuns:{id:"id",orgId:"org"},agentRunOutwardActionPolicies:{runId:"run",orgId:"org",policy:"policy"}}));
vi.mock("../db",()=>({db:{transaction:()=>{throw Error("must use guarded seam");}}}));
vi.mock("../org-write-run-seam",()=>({guardedRunWrite:async(authority:unknown,input:{orgId:string;runId:string},body:(tx:object)=>Promise<unknown>)=>{
 if(!authority||input.orgId!=="org"||input.runId!=="run")throw Error("ordinary authority refused");h.calls.push("org-first-guard");let n=0;
 const tx={select:()=>{const current=n++;return {from(){return this;},where(){return this;},for(){h.calls.push("row-fence");return Promise.resolve(current===0?[h.run]:h.bound?[h.bound]:[]);}};},insert:()=>({values:(value:unknown)=>({onConflictDoNothing:async()=>{h.calls.push("insert-once");h.bound??=value;}})})};return body(tx);
}}));
import { bindRunStepToolPolicy } from "../run-step-tool-policy-store";
const source=JSON.stringify({flow:{id:"step"}});const hash=createHash("sha256").update(source).digest("hex");
const policy={version:1,contextId:"ctx",sourceSha256:hash,executedSourceSha256:hash,declarationSourceSha256:hash,source} as const;
const input=()=>({orgId:"org",runId:"run",executionAttemptId:"attempt",policy,authority:{} as never});
beforeEach(()=>{h.bound=undefined;h.calls=[];h.run={id:"run",orgId:"org",status:"running",executionAttemptId:"attempt",a2aContextId:"ctx"};});
describe("immutable first dispatch source binding through actual guarded store seam",()=>{
 it("takes org authority then run lock and inserts exactly once",async()=>{
  await bindRunStepToolPolicy(input());expect(h.calls.slice(0,3)).toEqual(["org-first-guard","row-fence","insert-once"]);expect((h.bound as {policy:unknown}).policy).toEqual(policy);
  await bindRunStepToolPolicy(input());expect(h.bound).toEqual({policy,runId:"run",orgId:"org",executionAttemptId:"attempt"});
 });
 it("refuses mutable source rebinding under the same run",async()=>{
  await bindRunStepToolPolicy(input());await expect(bindRunStepToolPolicy({...input(),policy:{...policy,executedSourceSha256:"f".repeat(64)}})).rejects.toThrow("step_tool_dispatch_rebind_refused");expect((h.bound as {policy:unknown}).policy).toEqual(policy);
 });
 it("refuses absent authority, stopped run, wrong context and stale attempt",async()=>{
  await expect(bindRunStepToolPolicy({...input(),authority:undefined as never})).rejects.toThrow("ordinary authority refused");
  for(const change of [{status:"completed"},{a2aContextId:"other"},{executionAttemptId:"other"}]){Object.assign(h.run,{status:"running",a2aContextId:"ctx",executionAttemptId:"attempt"},change);await expect(bindRunStepToolPolicy(input())).rejects.toThrow("step_tool_dispatch_binding_mismatch");expect(h.bound).toBeUndefined();}
 });
});
