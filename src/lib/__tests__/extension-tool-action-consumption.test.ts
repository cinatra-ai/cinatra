import {describe,it,expect,vi,beforeEach} from "vitest";
import path from "node:path";

// The run store the guard reads: the executed-source fence and the step's tool
// offer. The guard itself (withGuardedRunActionInvocation) is the real one.
const h=vi.hoisted(()=>({sourceCurrent:true as boolean,declared:["extension_tool"] as string[],offerChecks:[] as string[]}));
vi.mock("@cinatra-ai/agents/store",()=>({
 parseRunStepToolPolicy:(p:unknown)=>p,
 readRunStepToolPolicy:async()=>({}),
 isRunExecutedSourceCurrent:async()=>h.sourceCurrent,
 assertRunStepToolAllowed:(input:{toolName:string})=>{
  h.offerChecks.push(input.toolName);
  if(!h.declared.includes(input.toolName)) throw new Error("step_tool_not_declared");
  return {kind:"declared"};
 },
 withRunActionPolicyTransaction:async()=>{throw new Error("no person-gate consumption in these cases");},
}));

import {mcpRequestContextStorage,type McpRequestContext} from "@cinatra-ai/mcp-server/request-context";
import {markDeclaredOutwardRunFrame} from "../extension-capabilities-registry";
import {dispatchExtensionTool,type ExtensionToolPorts} from "../extension-tool-dispatch";
import {loadDeclaredToolModuleWithIdentity} from "../extension-tool-module-loader";
const root=path.join(process.cwd(),"src/lib/__tests__/fixtures/extension-tool-pack");
const ports={data:{select:vi.fn(),insertIfAbsent:vi.fn(),updateWhere:vi.fn()},artifacts:{list:vi.fn(),contentRead:vi.fn()},objects:{read:vi.fn(),save:vi.fn()},clock:{now:()=>new Date(0)}} as Omit<ExtensionToolPorts,"review">;
const proof={contextId:"ctx",stepId:"step",executionAttemptId:"attempt",sourceSha256:"a".repeat(64),executedSourceSha256:"b".repeat(64),declarationSourceSha256:"c".repeat(64)};
const verifiedRunFrame=()=>({runId:"run",orgId:"org",userId:"person",verifiedStepId:"step",verifiedExecutedSource:proof}) as unknown as McpRequestContext;
/** An identity-less (bundled, legacy or dev) load of the fixture pack's module. */
function identityLess(effects:unknown[]){
 const namespace={extensionTool:async({input}:{input:unknown})=>{effects.push(input);return {ok:true};}};
 return {packageName:"@fixture-scope/fixture-tool-pack",packageVersion:"1.2.3",orgId:"org",cinatra:{tools:[{name:"fixture_tool",module:"./cinatra/tools/fixture-tool.mjs"}]},request:{name:"fixture_tool",input:{q:"x"}},ports,deps:{resolvePackageRoot:async()=>root,importModule:async()=>namespace}};
}
describe("actual declared module selection without authoritative loaded identity",()=>{
 beforeEach(()=>{h.sourceCurrent=true;h.declared=["extension_tool"];h.offerChecks=[];});
 it("preserves ordinary namespace dispatch compatibility",async()=>{
  const effects:unknown[]=[];
  expect(await dispatchExtensionTool(identityLess(effects))).toEqual({ok:true});expect(effects).toHaveLength(1);
 });
 it("serves an identity-less, non-outward call once on a run frame with a verified source (cinatra#3745)",async()=>{
  const effects:unknown[]=[];
  await expect(mcpRequestContextStorage.run(verifiedRunFrame(),()=>dispatchExtensionTool(identityLess(effects)))).resolves.toEqual({ok:true});
  expect(effects).toEqual([{q:"x"}]);
 });
 it("the step declares only the outer extension_tool: the inner module name is not re-checked as a step offer",async()=>{
  const effects:unknown[]=[];
  await expect(mcpRequestContextStorage.run(verifiedRunFrame(),()=>dispatchExtensionTool(identityLess(effects)))).resolves.toEqual({ok:true});
  expect(h.offerChecks).not.toContain("fixture_tool");
  expect(effects).toHaveLength(1);
 });
 it("refuses an identity-less call on a frame planned as outward, before any effect",async()=>{
  const effects:unknown[]=[];
  await expect(mcpRequestContextStorage.run(markDeclaredOutwardRunFrame(verifiedRunFrame()),()=>dispatchExtensionTool(identityLess(effects))))
   .rejects.toThrow("action_loaded_identity_missing_or_stale");
  expect(effects).toEqual([]);
 });
 it("refuses before effects on a run frame without a verified executed source",async()=>{
  const effects:unknown[]=[];
  await expect(mcpRequestContextStorage.run({runId:"run",orgId:"org"} as McpRequestContext,()=>dispatchExtensionTool(identityLess(effects))))
   .rejects.toThrow("action_executed_source_missing_or_stale");
  expect(effects).toEqual([]);
 });
 it("refuses before effects when the run's executed source is no longer current",async()=>{
  h.sourceCurrent=false;const effects:unknown[]=[];
  await expect(mcpRequestContextStorage.run(verifiedRunFrame(),()=>dispatchExtensionTool(identityLess(effects))))
   .rejects.toThrow("action_executed_source_missing_or_stale");
  expect(effects).toEqual([]);
 });
 it("returns the exact imported namespace, never synthesizes identity from caller metadata",async()=>{
  const namespace=Object.freeze({extensionTool:async()=>({})});const selected=await loadDeclaredToolModuleWithIdentity({packageName:"pack",packageVersion:"1",orgId:"org",toolName:"fixture_tool",modulePath:"./cinatra/tools/fixture-tool.mjs"},{resolvePackageRoot:async()=>root,importModule:async()=>namespace});
  expect(selected.namespace).toBe(namespace);expect(selected.identity).toBeUndefined();expect(Object.isFrozen(selected)).toBe(true);
 });
});
