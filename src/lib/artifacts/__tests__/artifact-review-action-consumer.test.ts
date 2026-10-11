import { beforeEach, describe, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
const h=vi.hoisted(()=>({burned:new Set<string>(),events:[] as string[],resolvedBy:"person",fingerprint:"person:gate",live:true,status:"running",current:true,identity:true,matching:true,commits:0, queue:Promise.resolve(),raw:JSON.stringify({recipient:"approved"})}));
vi.mock("@cinatra-ai/agents/schema",()=>({agentRuns:{id:"id",orgId:"org"},agentRunOutwardActionPolicies:{runId:"run"},artifactReviewGates:{id:"gate",runId:"run",orgId:"org",status:"status",disposition:"disposition"},artifactReviewActionConsumptions:{gateId:"gate"}}));
vi.mock("@/lib/extension-capabilities-registry",async(importOriginal)=>{const actual=await importOriginal<typeof import("@/lib/extension-capabilities-registry")>();return {...actual,isLoadedExtensionIdentityCurrent:(v:import("@/lib/extension-capabilities-registry").LoadedExtensionIdentity)=>h.identity && ("wrapper" in v || actual.isLoadedExtensionIdentityCurrent(v)),
 resolveCapabilityProviders:()=>[{packageName:"pack",impl:checker}],capabilityProviderLoadedIdentity:()=>({packageName:"pack",version:"1",installId:"install",digest:"f".repeat(64),generation:1})};});
vi.mock("@/lib/extension-version-keyed-serving",()=>({resolveVersionKeyedCapabilityProviders:()=>({kind:"refuse"})}));
vi.mock("@/lib/artifacts/local-disk-blob-store",()=>({createLocalDiskBlobStore:()=>({openByStorageKey:async()=>({sizeBytes:Buffer.byteLength(h.raw),stream:(async function*(){yield Buffer.from(h.raw);})()})})}));
const checker={check:(input:import("@cinatra-ai/sdk-extensions").ArtifactActionCheckInput)=>{h.events.push("check");return h.matching?{kind:"checked",usedRevisionIds:input.revisions.map(r=>r.representationRevisionId),actual:input.arguments,pinned:input.revisions[0].content}:{kind:"refused",reason:"not covered"};}};
vi.mock("@/lib/authz/mcp-boundary",async(importOriginal)=>{const actual=await importOriginal<typeof import("@/lib/authz/mcp-boundary")>();return {takeOutwardActionAdmission:actual.takeOutwardActionAdmission,OUTWARD_EFFECT_TOOL_NAMES:new Set(["publish"]),
 enforceMcpBoundaryPrerequisites:async()=>({allowed:true}),
 enforceMcpBoundary:async(req:{primitiveName:string;arguments:unknown;ctx?:Parameters<typeof actual.takeOutwardActionAdmission>[2]})=>({allowed:actual.takeOutwardActionAdmission(req.primitiveName,req.arguments,req.ctx),shouldBlock:true,reason:"exact_admission_required"})};});
vi.mock("@cinatra-ai/agents/store",()=>({
 parseRunStepToolPolicy:(p:unknown)=>p,assertRunStepToolAllowed:()=>h.events.push("declaration"),readRunStepToolPolicy:async()=>({}),isRunExecutedSourceCurrent:async()=>h.current,
 withRunActionPolicyTransaction:async(_scope:unknown,fn:(tx:object)=>Promise<unknown>)=>{
  const previous=h.queue;let release!:()=>void;h.queue=new Promise<void>(r=>release=r);await previous;
  let select=0;
  const gate=()=>({id:"gate",status:"resolved",disposition:"approve",resolvedBy:h.resolvedBy,resolvedAt:new Date(),fingerprint:h.fingerprint,pinnedTargets:[{artifactId:"artifact",representationRevisionId:"revision"}]});
  const chain=()=>{const n=select++;const result=()=>n===0?[{status:h.status,executionAttemptId:"attempt",a2aContextId:"ctx"}]:n===1?[{orgId:"org",executionAttemptId:"attempt",policy:{sourceSha256:"a".repeat(64),declarationSourceSha256:"c".repeat(64)}}]:[gate()];return {from(){return this;},where(){return this;},for(){return Promise.resolve(result());},orderBy(){return Promise.resolve(result());}};};
  let exec=0;const tx={select:chain,execute:async()=>{
   const n=exec++;if(n===0){h.events.push("artifact-fence");return {rows:[]};}
   if(n===1)return {rows:h.resolvedBy?[{id:h.resolvedBy}]:[]};
   if(n===2)return {rows:[{id:"artifact",type:"document",deleted_at:null}]};
   return {rows:h.live?[{id:"revision",kind:"blob",form:"file",substance_key:"blob:"+createHash("sha256").update(h.raw).digest("hex"),metadata:{storageKey:"bound"},size_bytes:Buffer.byteLength(h.raw)}]:[]};
  },insert:()=>({values:()=>({onConflictDoNothing:()=>({returning:async()=>{h.events.push("unique-consume");if(h.burned.has("gate"))return [];h.burned.add("gate");return [{gateId:"gate"}];}})})})};
  try{const result=await fn(tx);h.events.push("commit");h.commits++;return result;}finally{release();}
 }
}));
import { mcpRequestContextStorage } from "@cinatra-ai/mcp-server/request-context";
import { withArtifactReviewAction, takeOutwardActionAdmission, prepareDeclaredRunToolArguments } from "../artifact-review-action-consumer";
const action={packageName:"pack",version:"1",installId:"install",digest:"f".repeat(64),generation:1,toolName:"publish",wrapper:"extension_tool"} as const;
const proof={contextId:"ctx",stepId:"step",executionAttemptId:"attempt",sourceSha256:"a".repeat(64),executedSourceSha256:"b".repeat(64),declarationSourceSha256:"c".repeat(64)};
const frame=()=>({runId:"run",orgId:"org",userId:"person",orgWriteAuthority:{} as never,verifiedStepId:"step",verifiedExecutedSource:proof});
const call=(effect=async()=>{h.events.push("effect");return "sent";},args:unknown={recipient:"approved"})=>mcpRequestContextStorage.run(frame(),()=>withArtifactReviewAction({action,arguments:args},effect));
beforeEach(()=>{h.burned.clear();h.events=[];h.resolvedBy="person";h.fingerprint="person:gate";h.live=true;h.status="running";h.current=true;h.identity=true;h.matching=true;h.commits=0;h.queue=Promise.resolve();});
describe("real consumer with deterministic transactional ports (not PostgreSQL race proof)",()=>{
 it("commits its unique person-gate consumption before the exact effect",async()=>{
  expect(await call()).toBe("sent");expect(h.events.indexOf("commit")).toBeLessThan(h.events.indexOf("effect"));expect(h.burned.has("gate")).toBe(true);
 });
 it("admits at most one concurrent channel and refuses replay",async()=>{
  const result=await Promise.allSettled([call(),call()]);expect(result.filter(r=>r.status==="fulfilled")).toHaveLength(1);expect(h.events.filter(e=>e==="effect")).toHaveLength(1);
  await expect(call()).rejects.toThrow("action_gate_already_consumed");
 });
 it("never refunds the gate when the downstream effect fails",async()=>{
  await expect(call(async()=>{throw Error("external failed");})).rejects.toThrow("external failed");await expect(call()).rejects.toThrow("action_gate_already_consumed");
 });
 it("rejects expiry-synthesized/null-person and stale revision approvals without effects",async()=>{
  for(const change of [{fingerprint:"expiry:gate"},{resolvedBy:""},{live:false},{status:"completed"},{identity:false},{matching:false}]){
   Object.assign(h,{fingerprint:"person:gate",resolvedBy:"person",live:true,status:"running",identity:true,matching:true},change);
   await expect(call()).rejects.toThrow();expect(h.events).not.toContain("effect");expect(h.burned.size).toBe(0);
  }
 });
 it("binds the opaque boundary admission to exact frame/name/args and one use",async()=>{
  await call(async()=>{const current=mcpRequestContextStorage.getStore();expect(takeOutwardActionAdmission("publish",{recipient:"other"},current)).toBe(false);expect(takeOutwardActionAdmission("publish",{recipient:"approved"},{...current})).toBe(false);expect(takeOutwardActionAdmission("publish",{recipient:"approved"},current)).toBe(true);expect(takeOutwardActionAdmission("publish",{recipient:"approved"},current)).toBe(false);return "done";});
  expect(takeOutwardActionAdmission("publish",{recipient:"approved"},{outwardActionAdmission:{}})).toBe(false);
 });
 it("refuses all four gate-less actions even if a person gate exists",async()=>{
  for(const toolName of ["agent_run_resume","approvals_decide","permissions_members_invite","agent_creation_request_decide"])await expect(mcpRequestContextStorage.run(frame(),()=>withArtifactReviewAction({action:{...action,toolName},arguments:{}},async()=>"never"))).rejects.toThrow("action_has_no_artifact_gate");
  expect(h.burned.size).toBe(0);
 });
 it("does not accept a legacy step-only frame or stale source as declaration proof",async()=>{
  await expect(mcpRequestContextStorage.run({...frame(),verifiedExecutedSource:undefined},()=>prepareDeclaredRunToolArguments("publish",{}))).rejects.toThrow("action_executed_source_missing_or_stale");
  h.current=false;await expect(mcpRequestContextStorage.run(frame(),()=>prepareDeclaredRunToolArguments("publish",{}))).rejects.toThrow("action_executed_source_missing_or_stale");
 });
});


describe("captured guarded leaf to real shared consumer cross-channel",()=>{
 it("runs the captured leaf once after a real opaque admission; another channel cannot reuse the gate",async()=>{
  const registry=await vi.importActual<typeof import("@/lib/extension-capabilities-registry")>("@/lib/extension-capabilities-registry");
  registry.__resetCapabilityRegistry();const identity=registry.recordLoadedExtensionIdentity({packageName:"pack",version:"1",installId:"install",digest:"f".repeat(64)});
  let effects=0;const leaf=(await import("@/lib/extension-host-context")).bindArtifactGuardedMcpHandler("publish",async(input:unknown)=>{effects++;expect(Object.isFrozen(input)).toBe(true);return (input as {recipient:string}).recipient;},identity);
  expect(await mcpRequestContextStorage.run(frame(),()=>leaf({recipient:"approved"}))).toBe("approved");
  await expect(call()).rejects.toThrow("action_gate_already_consumed");expect(effects).toBe(1);registry.__resetCapabilityRegistry();
 });
 it("captures exact target and arguments before asynchronous source lookup",async()=>{
  const store=await import("@cinatra-ai/agents/store");let release!:()=>void;
  const blocked=new Promise<void>(r=>release=r);
  const spy=vi.spyOn(store,"isRunExecutedSourceCurrent").mockImplementationOnce(async()=>{await blocked;return true;});
  const selected={...action,toolName:"publish" as string,wrapper:"primitive" as const};const argumentsValue={recipient:"approved"};let effects=0;
  const {withGuardedRunActionInvocation}=await import("../artifact-review-action-consumer");
  const result=mcpRequestContextStorage.run(frame(),()=>withGuardedRunActionInvocation({action:selected,arguments:argumentsValue},async frozen=>{effects++;expect(frozen).toEqual({recipient:"approved"});return "sent";}));
  selected.toolName="agent_run_resume";argumentsValue.recipient="other";release();
  await expect(result).resolves.toBe("sent");expect(effects).toBe(1);expect(h.burned.size).toBe(1);spy.mockRestore();
 });
 it("a stale/unbound actual selected leaf refuses before CHECK or effects",async()=>{
  const registry=await vi.importActual<typeof import("@/lib/extension-capabilities-registry")>("@/lib/extension-capabilities-registry");
  registry.__resetCapabilityRegistry();const identity=registry.recordLoadedExtensionIdentity({packageName:"pack",version:"1",installId:"install",digest:"f".repeat(64)});let effects=0;
  const stale=(await import("@/lib/extension-host-context")).bindArtifactGuardedMcpHandler("publish",async()=>++effects,identity);registry.invalidateProvidersForPackage("pack");
  for(const leaf of [stale,(await import("@/lib/extension-host-context")).bindArtifactGuardedMcpHandler("publish",async()=>++effects)])await expect(mcpRequestContextStorage.run(frame(),()=>leaf({recipient:"approved"}))).rejects.toThrow("action_loaded_identity_missing_or_stale");
  expect(effects).toBe(0);expect(h.burned.size).toBe(0);registry.__resetCapabilityRegistry();
 });
});
