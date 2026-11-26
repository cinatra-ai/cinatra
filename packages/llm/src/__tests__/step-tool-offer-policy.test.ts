import { describe, it, expect, vi } from "vitest";
// These pure offer filters use the actual orchestration index; external provider/DB ports are not executed.
vi.mock("../registry",()=>({}));
vi.mock("../mcp-access",()=>({}));
vi.mock("../tools/skills",()=>({}));
import type * as StepToolOfferPolicy from "../step-tool-offer-policy";
import { orchestrateSubmitBatchV2 } from "../index";
let intersectStepToolNames!: typeof StepToolOfferPolicy.intersectStepToolNames;
let restrictMcpServerOffer!: typeof StepToolOfferPolicy.restrictMcpServerOffer;
let restrictStepToolOffers!: typeof StepToolOfferPolicy.restrictStepToolOffers;
async function loadPolicy(): Promise<void> {
  ({ intersectStepToolNames, restrictMcpServerOffer, restrictStepToolOffers } = await import("../step-tool-offer-policy"));
}
describe("provider-independent declared-tool ceiling",()=>{
 it("intersects and deduplicates without broadening existing server restrictions",async()=>{
  await loadPolicy();
  expect(intersectStepToolNames(["a","a","b"],{kind:"declared",tools:["a"]})).toEqual(["a"]);
  expect(restrictMcpServerOffer({allowedTools:["b"]},["a","b"],{kind:"declared",tools:["a"]})).toBeNull();
 });
 it("removes zero-intersection and unknown-catalog servers instead of passing unrestricted []",async()=>{
  await loadPolicy();
  expect(restrictMcpServerOffer({},["a"],{kind:"declared",tools:[]})).toBeNull();
  expect(restrictMcpServerOffer({},null,{kind:"declared",tools:["a"]})).toBeNull();
  expect(restrictStepToolOffers([{type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["b"]}] as never,{kind:"declared",tools:["a"]})).toBeUndefined();
 });
 // cinatra#4150: the product's own tool server (reserved label "cinatra") without a catalog ceiling is
 // offered exactly the step's declared names; a third-party server without a catalog is still dropped.
 const selfMcp=(allowedTools:string[]|null)=>({type:"mcp",serverUrl:"https://self.test/api/mcp",serverLabel:"cinatra",allowedTools});
 // red-first-expect: AssertionError: expected undefined to deeply equal [ { type: 'mcp', …(3) } ]
 it("offers the product's own server with exactly the declared names when it has no catalog ceiling",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([selfMcp(null),{type:"function",name:"other"}] as never,{kind:"declared",tools:["a","b"]}))
   .toEqual([selfMcp(["a","b"])]);
 });
 // Guard (passes before and after): a known ceiling still bounds the offer, so a declared name the server does not list is not offered.
 it("offers the product's own server only the declared names its known ceiling lists",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([selfMcp(["a","c"])] as never,{kind:"declared",tools:["a","zz"]})).toEqual([selfMcp(["a"])]);
 });
 // Guard (passes before and after): only the reserved label is the product's own server.
 it("still drops a third-party server with an unknown catalog",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([{type:"mcp",serverUrl:"https://x.test",serverLabel:"ext",allowedTools:null}] as never,
   {kind:"declared",tools:["a"]})).toBeUndefined();
 });
 // red-first-expect: AssertionError: expected [ { type: 'function', name: 'a' } ] to deeply equal [ { type: 'mcp', …(3) }, …(1) ]
 it("the own server's declared-names catalog leaves a declared name to the other tool that carries it",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([selfMcp(null),{type:"function",name:"a"}] as never,{kind:"declared",tools:["a","b"]}))
   .toEqual([selfMcp(["b"]),{type:"function",name:"a"}]);
 });
 // Guard (passes before and after): a known ceiling that lists a name another tool carries keeps it ambiguous.
 it("a declared name the own server's known ceiling and a function both carry is not offered",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([selfMcp(["a","b"]),{type:"function",name:"a"}] as never,{kind:"declared",tools:["a","b"]}))
   .toEqual([selfMcp(["b"])]);
 });
 it("leaves the product's own server unrestricted for a step without declarations",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([selfMcp(null)] as never,{kind:"undeclared"})).toEqual([selfMcp(null)]);
 });
 it("drops ambiguous duplicate functions rather than choosing arbitrary credentials/handlers",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([{type:"function",name:"a"},{type:"function",name:"a"}] as never,{kind:"declared",tools:["a"]})).toBeUndefined();
 });
 it("rejects malformed declarations even when no tools were offered",async()=>{
  await loadPolicy();
  expect(()=>restrictStepToolOffers(undefined,{kind:"declared",tools:[""]})).toThrow("step_tool_offer_policy_invalid");
 });
 it("preserves ordinary undeclared offers",async()=>{
  await loadPolicy();
  const tools=[{type:"function",name:"a"}];expect(restrictStepToolOffers(tools as never,{kind:"undeclared"})).toEqual(tools);
 });
 // cinatra#3745: a declared step's offer is the intersection, never the whole toolbox.
 it("keeps only the declared tools of a mixed offer, and a declared MCP server only with its declared names",async()=>{
  await loadPolicy();
  const offered=[{type:"function",name:"mail_send"},{type:"function",name:"wordpress_publish"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save","objects_read"]}];
  expect(restrictStepToolOffers(offered as never,{kind:"declared",tools:["mail_send","objects_save"]})).toEqual([
   {type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save"]},
  ]);
 });
 // cinatra#3745: a declared name selects one handler. A name that more than one offered tool carries,
 // across a function and an MCP server or across two MCP servers, is ambiguous: no tool keeps it.
 const DECLARED={kind:"declared",tools:["mail_send","objects_save"]} as const;
 it("drops a declared name that a function and an MCP server both carry, and keeps the server's other names",async()=>{
  await loadPolicy();
  const offered=[{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save"]},
  ]);
  expect(restrictStepToolOffers([{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]}] as never,DECLARED)).toBeUndefined();
 });
 it("drops a declared name that two MCP servers both carry",async()=>{
  await loadPolicy();
  const offered=[{type:"mcp",serverUrl:"https://a.test",serverLabel:"a",allowedTools:["mail_send"]},
   {type:"mcp",serverUrl:"https://b.test",serverLabel:"b",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"mcp",serverUrl:"https://b.test",serverLabel:"b",allowedTools:["objects_save"]},
  ]);
 });
 it("a name duplicated within one kind is also no longer offered by another kind",async()=>{
  await loadPolicy();
  const offered=[{type:"function",name:"mail_send"},{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save"]},
  ]);
 });
 it("a name the step does not declare never makes a declared name ambiguous",async()=>{
  await loadPolicy();
  const offered=[{type:"function",name:"wordpress_publish"},{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["wordpress_publish","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save"]},
  ]);
 });
 // cinatra#3745: the auditor's fixed host ceiling (src/app/api/auditor/run-skills/route.ts) admits the
 // skill-delivery tools by kind only. A function tool or an MCP tool whose NAME is a built-in kind
 // ("shell", "container_skills") must never pass it.
 const SKILL_ONLY={kind:"declared",tools:[],builtinTools:["shell","container_skills"]} as const;
 it("a skill-only ceiling keeps the skill shell and container skills and drops MCP servers and functions",async()=>{
  await loadPolicy();
  const shell={type:"shell",skills:[]};const container={type:"container_skills",skills:[]};
  const offered=[shell,container,{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"cinatra",allowedTools:["mail_send","objects_save"]},
   {type:"mcp",serverUrl:"https://other.test",serverLabel:"ext"}];
  expect(restrictStepToolOffers(offered as never,SKILL_ONLY)).toEqual([shell,container]);
 });
 it("a skill-only ceiling drops MCP servers and function tools whose names collide with a built-in kind",async()=>{
  await loadPolicy();
  const shell={type:"shell",skills:[]};const container={type:"container_skills",skills:[]};
  const offered=[shell,container,{type:"function",name:"shell"},{name:"container_skills"},
   {type:"mcp",serverUrl:"https://a.test",serverLabel:"a",allowedTools:["shell"]},
   {type:"mcp",serverUrl:"https://b.test",serverLabel:"b",allowedTools:["container_skills"]},
   {type:"mcp",serverUrl:"https://c.test",serverLabel:"c",allowedTools:["shell","container_skills","mail_send"]}];
  expect(restrictStepToolOffers(offered as never,SKILL_ONLY)).toEqual([shell,container]);
  expect(restrictStepToolOffers(offered.slice(2) as never,SKILL_ONLY)).toBeUndefined();
 });
 it("ordinary skill delivery under the skill-only ceiling keeps its built-in shell",async()=>{
  await loadPolicy();
  const shell={type:"shell",skills:[{name:"a",description:"a",path:"/skills/a"}]};
  expect(restrictStepToolOffers([shell] as never,SKILL_ONLY)).toEqual([shell]);
 });
 it("the empty ceiling also drops the built-in skill-delivery tools",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([{type:"shell",skills:[]},{type:"container_skills",skills:[]}] as never,
   {kind:"declared",tools:[]})).toBeUndefined();
 });
 it("rejects a built-in kind that is a function tool or an MCP server",async()=>{
  await loadPolicy();
  for (const kind of ["function","mcp",""]) {
   expect(()=>restrictStepToolOffers(undefined,{kind:"declared",tools:[],builtinTools:[kind]} as never))
    .toThrow("step_tool_offer_policy_invalid");
  }
 });
 // cinatra#3745: a tool is counted under the name the model calls it by. The sandbox built-in is offered
 // as "sandbox_execute", so a function or an MCP tool of that name makes the name ambiguous: neither is offered.
 const SANDBOX_AND_NAME={kind:"declared",tools:["sandbox_execute","mail_send"],builtinTools:["sandbox_execution"]} as const;
 it("drops the sandbox built-in and a function that carry the same model-facing name",async()=>{
  await loadPolicy();
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  const mail={type:"function",name:"mail_send"};
  expect(restrictStepToolOffers([sandbox,{type:"function",name:"sandbox_execute"},mail] as never,SANDBOX_AND_NAME)).toEqual([mail]);
  expect(restrictStepToolOffers([{type:"function",name:"sandbox_execute"},sandbox] as never,SANDBOX_AND_NAME)).toBeUndefined();
 });
 it("drops the sandbox built-in and an MCP server's tool that carry the same model-facing name",async()=>{
  await loadPolicy();
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  expect(restrictStepToolOffers([sandbox,
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["sandbox_execute","mail_send"]}] as never,SANDBOX_AND_NAME)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]},
  ]);
 });
 it("keeps the sandbox built-in when no other offered tool carries its model-facing name",async()=>{
  await loadPolicy();
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  expect(restrictStepToolOffers([sandbox,{type:"function",name:"mail_send"}] as never,SANDBOX_AND_NAME)).toEqual([
   sandbox,{type:"function",name:"mail_send"},
  ]);
 });
 // cinatra#3745: the provider adapters translate built-ins under names other than their kind. OpenAI sends a
 // skill shell without the sandbox as the function "skill_file_read"; the connector with container skills sends
 // it as "bash" and container skills as "code_execution". The filter does not know the provider, so it counts every built-in under every
 // such name: a function or an MCP tool of one of them makes the name ambiguous and neither is offered.
 const mail={type:"function",name:"mail_send"};
 const skillShell={type:"shell",skills:[{name:"a",description:"a",path:"/skills/a"}]};
 const containerSkills={type:"container_skills",skills:[]};
 it("drops the skill shell and a function both offered to OpenAI as skill_file_read",async()=>{
  await loadPolicy();
  const policy={kind:"declared",tools:["skill_file_read","mail_send"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([skillShell,{type:"function",name:"skill_file_read"},mail] as never,policy)).toEqual([mail]);
 });
 it("drops the skill shell and a function both offered as bash",async()=>{
  await loadPolicy();
  const policy={kind:"declared",tools:["bash","mail_send"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([skillShell,{type:"function",name:"bash"},mail] as never,policy)).toEqual([mail]);
 });
 it("drops the skill shell and an MCP server's tool both offered as bash, and keeps the server's other names",async()=>{
  await loadPolicy();
  const policy={kind:"declared",tools:["bash","mail_send"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([skillShell,
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["bash","mail_send"]}] as never,policy)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]},
  ]);
 });
 it("drops container skills and a function or an MCP tool offered as code_execution",async()=>{
  await loadPolicy();
  const policy={kind:"declared",tools:["code_execution","mail_send"],builtinTools:["container_skills"]} as const;
  expect(restrictStepToolOffers([containerSkills,{type:"function",name:"code_execution"},mail] as never,policy)).toEqual([mail]);
  expect(restrictStepToolOffers([containerSkills,
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["code_execution"]}] as never,policy)).toBeUndefined();
 });
 it("drops the skill shell and an MCP tool offered to OpenAI as skill_file_read",async()=>{
  await loadPolicy();
  const policy={kind:"declared",tools:["skill_file_read"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([{type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["skill_file_read"]},
   skillShell] as never,policy)).toBeUndefined();
 });
 it("keeps built-ins of different kinds that share a provider-facing name in the union (each adapter separates them)",async()=>{
  await loadPolicy();
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  const policy={kind:"declared",tools:[],builtinTools:["shell","sandbox_execution","container_skills","web_search"]} as const;
  const web={type:"web_search"};
  expect(restrictStepToolOffers([skillShell,sandbox,containerSkills,web] as never,policy)).toEqual([skillShell,sandbox,containerSkills,web]);
 });
 it("names every provider-facing name of each built-in kind in one table",async()=>{
  await loadPolicy();
  const { BUILTIN_TOOL_MODEL_FACING_NAMES } = await import("../index");
  const { SKILL_FILE_READ_TOOL_NAME } = await import("../tools/skill-read-tool");
  expect(BUILTIN_TOOL_MODEL_FACING_NAMES).toEqual({
   shell:["shell",SKILL_FILE_READ_TOOL_NAME,"bash"],
   container_skills:["container_skills","code_execution","bash_code_execution","text_editor_code_execution"],
   web_search:["web_search"],
   sandbox_execution:["sandbox_execution","sandbox_execute","shell"],
  });
  expect(Object.isFrozen(BUILTIN_TOOL_MODEL_FACING_NAMES)).toBe(true);
 });
 it("offers nothing to a step that declares no tool",async()=>{
  await loadPolicy();
  expect(restrictStepToolOffers([{type:"function",name:"a"}] as never,{kind:"declared",tools:[]})).toBeUndefined();
 });
 it("refuses a batch submission for a declared step before any provider is resolved",async()=>{
  await loadPolicy();
  await expect(orchestrateSubmitBatchV2({provider:"openai",requests:[],stepToolPolicy:{kind:"declared",tools:["a"]}} as never))
   .rejects.toThrow("step_tool_batch_abi_unavailable");
 });
});
