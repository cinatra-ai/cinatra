/**
 * The connector-instance invoker under the real run guard (cinatra#3745 MF2).
 *
 * A connector's model-visible primitive is a guarded leaf; its handler calls
 * the invoker, which hands the wire call to the same guard under the leaf's
 * owner (pinned, or unpinned for a load without a current loaded identity).
 * A wire call the host does not read as outward is served as on main, after
 * the content-review hook (the unchanged 5b road) and the executed-source
 * fence; the inner wire name is not re-checked as the step's tool offer. A
 * call outside any guarded leaf has no owner and refuses; an outward wire name
 * refuses before any wire call.
 *
 * Drives the real `bindArtifactGuardedMcpHandler` -> `withGuardedRunActionInvocation`
 * and the real invoker; the run store, the audit writer, the classification
 * reader and the invoker's injected deps (wire, endpoint, catalog) are doubles.
 */
import "server-only";
import {afterEach,beforeEach,describe,it,expect,vi} from "vitest";

const h=vi.hoisted(()=>({armed:false,before:()=>{},sourceCurrent:true,declared:["example_site_tool_call"] as string[],offerChecks:[] as string[]}));
vi.mock("@cinatra-ai/agents/store",()=>({
 parseRunStepToolPolicy:(p:unknown)=>p,
 readRunStepToolPolicy:async()=>({}),
 assertRunStepToolAllowed:(input:{toolName:string})=>{h.offerChecks.push(input.toolName);if(!h.declared.includes(input.toolName))throw new Error("step_tool_not_declared");return {kind:"declared"};},
 // The first await after the guard captured its call: a change made here must
 // not reach the wire call.
 isRunExecutedSourceCurrent:async()=>{if(h.armed){h.armed=false;h.before();}return h.sourceCurrent;},
 withRunActionPolicyTransaction:async()=>{throw new Error("no person-gate consumption in these cases");},
}));

import * as auditModule from "@/lib/authz/audit";
import * as augmentModule from "@/lib/authz/inventory-augment";
import {mcpRequestContextStorage,type McpRequestContext} from "@cinatra-ai/mcp-server/request-context";
import {recordLoadedExtensionIdentity,type LoadedExtensionIdentity} from "../extension-capabilities-registry";
import {bindArtifactGuardedMcpHandler} from "../extension-host-context";
import {invokeConnectorInstanceTool,type ConnectorInstanceInvokerDeps,type InvokerTrustedActor} from "../connector-instance-invoker";
import {createInMemoryConnectorInstanceCatalogCache,CATALOG_DEFAULT_SERVER_ID,type CatalogServerSnapshot} from "../connector-instance-catalog-cache";

const OUTER="example_site_tool_call";
const FIXTURE_CLASSIFICATION={resourceType:"agent_run",action:"execute",status:"enforced"} as const;
const proof={contextId:"ctx",stepId:"step",executionAttemptId:"attempt",sourceSha256:"a".repeat(64),executedSourceSha256:"b".repeat(64),declarationSourceSha256:"c".repeat(64)};
const runFrame=()=>({runId:"run",orgId:"org",userId:"person",verifiedStepId:"step",verifiedExecutedSource:proof}) as unknown as McpRequestContext;
const actor:InvokerTrustedActor={actor:{principalType:"HumanUser",principalId:"person",organizationId:"org"} as never,userId:"person",orgId:"org",connectorInstancePin:{connectorKey:"wordpress",instanceId:"instance"}};
const READ={readOnlyHint:true,destructiveHint:false},WRITE={readOnlyHint:false,destructiveHint:false},DESTRUCTIVE={readOnlyHint:false,destructiveHint:true};
type Hook=NonNullable<ConnectorInstanceInvokerDeps["contentReviewHook"]>;
function fixture(hook?:Hook){
 const endpoint={endpoint:"https://site.invalid/original",authHeader:"Basic native-test"};
 const tool=(name:string,rawAnnotations:Record<string,unknown>)=>({name,serverId:CATALOG_DEFAULT_SERVER_ID,inputSchema:{},rawAnnotations});
 const snapshot:CatalogServerSnapshot={serverId:CATALOG_DEFAULT_SERVER_ID,exposureMode:"triad-only",tools:[tool("core/get-site-info",READ),tool("core/update-post",WRITE),tool("core/delete-post",DESTRUCTIVE),tool("email_send",WRITE)],catalogRevision:"rev",fetchedAtMs:0};
 const cache=createInMemoryConnectorInstanceCatalogCache();cache.set("instance",snapshot);
 const wire=vi.fn(async()=>({ok:true}));
 const deps:ConnectorInstanceInvokerDeps={requireUse:async()=>{},ensureDefaultOpenPolicy:async()=>({created:false}),resolveInstanceEndpoint:async()=>endpoint,cache,loadServerSnapshot:async()=>snapshot,callWireTool:wire,readPolicy:async()=>({connectorKey:"wordpress",instanceId:"instance",mode:"open",updatedBy:"person",updatedAt:new Date(0).toISOString()}),audit:async()=>{},...(hook?{contentReviewHook:hook}:{})};
 return {endpoint,snapshot,wire,deps};
}
let installSeq=0;
function pinned():LoadedExtensionIdentity{installSeq+=1;return recordLoadedExtensionIdentity({packageName:"@example-org/site-connector",version:"1.0.0",installId:`site-install-${installSeq}`,digest:"d".repeat(64)});}
/** The connector's guarded primitive, whose handler calls the invoker. */
function viaLeaf(identity:LoadedExtensionIdentity|undefined,deps:ConnectorInstanceInvokerDeps,toolName:string,args:Record<string,unknown>={}){
 const leaf=bindArtifactGuardedMcpHandler(OUTER,async()=>{h.armed=true;return invokeConnectorInstanceTool({connectorKey:"wordpress",toolName,args,actor},deps);},identity,{name:OUTER});
 return mcpRequestContextStorage.run(runFrame(),()=>leaf({}));
}

beforeEach(()=>{
 h.armed=false;h.before=()=>{};h.sourceCurrent=true;h.declared=[OUTER];h.offerChecks=[];
 const realLookup=augmentModule.lookupPrimitiveClassification;
 vi.spyOn(auditModule,"logAuditEvent").mockResolvedValue(undefined);
 vi.spyOn(augmentModule,"lookupPrimitiveClassification").mockImplementation((name:string)=>name===OUTER?{...FIXTURE_CLASSIFICATION}:realLookup(name));
});
afterEach(()=>{vi.restoreAllMocks();});

describe("the instance invoker under the real run guard",()=>{
 it.each([
  ["pinned","read","core/get-site-info"],["pinned","write","core/update-post"],["pinned","destructive","core/delete-post"],
  ["unpinned","read","core/get-site-info"],["unpinned","write","core/update-post"],["unpinned","destructive","core/delete-post"],
 ] as const)("serves a %s owner's %s wire call once",async(owner,_cls,toolName)=>{
  const {wire,deps}=fixture();
  await expect(viaLeaf(owner==="pinned"?pinned():undefined,deps,toolName,{id:1})).resolves.toEqual({ok:true});
  expect(wire).toHaveBeenCalledTimes(1);
  expect(wire).toHaveBeenCalledWith(expect.objectContaining({arguments:{ability_name:toolName,parameters:{id:1}}}));
 });

 it("does not re-check the inner wire name as the step's tool offer",async()=>{
  const {wire,deps}=fixture();
  await expect(viaLeaf(pinned(),deps,"core/update-post")).resolves.toEqual({ok:true});
  expect(h.offerChecks).toEqual([OUTER]);
  expect(wire).toHaveBeenCalledTimes(1);
 });

 it("keeps the executed-source fence on the inner wire call",async()=>{
  const {wire,deps}=fixture();
  h.before=()=>{h.sourceCurrent=false;};
  await expect(viaLeaf(pinned(),deps,"core/update-post")).rejects.toThrow("action_executed_source_missing_or_stale");
  expect(wire).not.toHaveBeenCalled();
 });

 it.each([["hold"],["continue"]] as const)("the content-review hook's %s verdict is the unchanged 5b road",async(action)=>{
  const fire=vi.fn(async()=>action==="hold"?{action:"hold" as const,message:"held for review",holdId:"hold-1"}:{action:"continue" as const});
  const {wire,deps}=fixture({enabled:()=>true,fire} as unknown as Hook);
  const call=viaLeaf(pinned(),deps,"core/update-post");
  if(action==="hold"){await expect(call).rejects.toMatchObject({code:"content_review_hold"});expect(wire).not.toHaveBeenCalled();}
  else{await expect(call).resolves.toEqual({ok:true});expect(wire).toHaveBeenCalledTimes(1);}
  expect(fire).toHaveBeenCalledTimes(1);
 });

 it.each([["pinned","action_checker_missing_or_ambiguous"],["unpinned","action_loaded_identity_missing_or_stale"]] as const)(
  "refuses an outward wire name under a %s owner before any wire call",async(owner,code)=>{
  const {wire,deps}=fixture();
  await expect(viaLeaf(owner==="pinned"?pinned():undefined,deps,"email_send")).rejects.toThrow(code);
  expect(wire).not.toHaveBeenCalled();
 });

 it("refuses a run with no guarded owner before any wire call",async()=>{
  const {wire,deps}=fixture();
  await expect(mcpRequestContextStorage.run(runFrame(),()=>invokeConnectorInstanceTool({connectorKey:"wordpress",toolName:"core/get-site-info",args:{},actor},deps)))
   .rejects.toThrow("executed connector owner is unavailable");
  expect(wire).not.toHaveBeenCalled();
 });

 it("binds the exact destination, tool and detached arguments before the guard's first await",async()=>{
  const {wire,deps,endpoint,snapshot}=fixture();
  const args={id:"approved"};
  h.before=()=>{endpoint.endpoint="https://site.invalid/replaced";snapshot.exposureMode="first-class";args.id="replaced";};
  await viaLeaf(pinned(),deps,"core/get-site-info",args);
  expect(wire).toHaveBeenCalledWith(expect.objectContaining({endpoint:"https://site.invalid/original",name:"mcp-adapter-execute-ability",arguments:{ability_name:"core/get-site-info",parameters:{id:"approved"}}}));
 });
});
