import { describe, it, expect, vi } from "vitest";
// These pure offer filters use the actual orchestration index; external provider/DB ports are not executed.
vi.mock("../registry",()=>({}));
vi.mock("../mcp-access",()=>({}));
vi.mock("../tools/skills",()=>({}));
import { intersectStepToolNames, restrictMcpServerOffer, restrictStepToolOffers } from "../step-tool-offer-policy";
import { orchestrateSubmitBatchV2 } from "../index";
describe("provider-independent declared-tool ceiling",()=>{
 it("intersects and deduplicates without broadening existing server restrictions",()=>{
  expect(intersectStepToolNames(["a","a","b"],{kind:"declared",tools:["a"]})).toEqual(["a"]);
  expect(restrictMcpServerOffer({allowedTools:["b"]},["a","b"],{kind:"declared",tools:["a"]})).toBeNull();
 });
 it("removes zero-intersection and unknown-catalog servers instead of passing unrestricted []",()=>{
  expect(restrictMcpServerOffer({},["a"],{kind:"declared",tools:[]})).toBeNull();
  expect(restrictMcpServerOffer({},null,{kind:"declared",tools:["a"]})).toBeNull();
  expect(restrictStepToolOffers([{type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["b"]}] as never,{kind:"declared",tools:["a"]})).toBeUndefined();
 });
 it("drops ambiguous duplicate functions rather than choosing arbitrary credentials/handlers",()=>{
  expect(restrictStepToolOffers([{type:"function",name:"a"},{type:"function",name:"a"}] as never,{kind:"declared",tools:["a"]})).toBeUndefined();
 });
 it("rejects malformed declarations even when no tools were offered",()=>{
  expect(()=>restrictStepToolOffers(undefined,{kind:"declared",tools:[""]})).toThrow("step_tool_offer_policy_invalid");
 });
 it("preserves ordinary undeclared offers",()=>{
  const tools=[{type:"function",name:"a"}];expect(restrictStepToolOffers(tools as never,{kind:"undeclared"})).toEqual(tools);
 });
 // cinatra#3745: a declared step's offer is the intersection, never the whole toolbox.
 it("keeps only the declared tools of a mixed offer, and a declared MCP server only with its declared names",()=>{
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
 it("drops a declared name that a function and an MCP server both carry, and keeps the server's other names",()=>{
  const offered=[{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save"]},
  ]);
  expect(restrictStepToolOffers([{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]}] as never,DECLARED)).toBeUndefined();
 });
 it("drops a declared name that two MCP servers both carry",()=>{
  const offered=[{type:"mcp",serverUrl:"https://a.test",serverLabel:"a",allowedTools:["mail_send"]},
   {type:"mcp",serverUrl:"https://b.test",serverLabel:"b",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"mcp",serverUrl:"https://b.test",serverLabel:"b",allowedTools:["objects_save"]},
  ]);
 });
 it("a name duplicated within one kind is also no longer offered by another kind",()=>{
  const offered=[{type:"function",name:"mail_send"},{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,DECLARED)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["objects_save"]},
  ]);
 });
 it("a name the step does not declare never makes a declared name ambiguous",()=>{
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
 it("a skill-only ceiling keeps the skill shell and container skills and drops MCP servers and functions",()=>{
  const shell={type:"shell",skills:[]};const container={type:"container_skills",skills:[]};
  const offered=[shell,container,{type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"cinatra",allowedTools:["mail_send","objects_save"]},
   {type:"mcp",serverUrl:"https://other.test",serverLabel:"ext"}];
  expect(restrictStepToolOffers(offered as never,SKILL_ONLY)).toEqual([shell,container]);
 });
 it("a skill-only ceiling drops MCP servers and function tools whose names collide with a built-in kind",()=>{
  const shell={type:"shell",skills:[]};const container={type:"container_skills",skills:[]};
  const offered=[shell,container,{type:"function",name:"shell"},{name:"container_skills"},
   {type:"mcp",serverUrl:"https://a.test",serverLabel:"a",allowedTools:["shell"]},
   {type:"mcp",serverUrl:"https://b.test",serverLabel:"b",allowedTools:["container_skills"]},
   {type:"mcp",serverUrl:"https://c.test",serverLabel:"c",allowedTools:["shell","container_skills","mail_send"]}];
  expect(restrictStepToolOffers(offered as never,SKILL_ONLY)).toEqual([shell,container]);
  expect(restrictStepToolOffers(offered.slice(2) as never,SKILL_ONLY)).toBeUndefined();
 });
 it("ordinary skill delivery under the skill-only ceiling keeps its built-in shell",()=>{
  const shell={type:"shell",skills:[{name:"a",description:"a",path:"/skills/a"}]};
  expect(restrictStepToolOffers([shell] as never,SKILL_ONLY)).toEqual([shell]);
 });
 it("the empty ceiling also drops the built-in skill-delivery tools",()=>{
  expect(restrictStepToolOffers([{type:"shell",skills:[]},{type:"container_skills",skills:[]}] as never,
   {kind:"declared",tools:[]})).toBeUndefined();
 });
 it("rejects a built-in kind that is a function tool or an MCP server",()=>{
  for (const kind of ["function","mcp",""]) {
   expect(()=>restrictStepToolOffers(undefined,{kind:"declared",tools:[],builtinTools:[kind]} as never))
    .toThrow("step_tool_offer_policy_invalid");
  }
 });
 // cinatra#3745: a tool is counted under the name the model calls it by. The sandbox built-in is offered
 // as "sandbox_execute", so a function or an MCP tool of that name makes the name ambiguous: neither is offered.
 const SANDBOX_AND_NAME={kind:"declared",tools:["sandbox_execute","mail_send"],builtinTools:["sandbox_execution"]} as const;
 it("drops the sandbox built-in and a function that carry the same model-facing name",()=>{
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  const mail={type:"function",name:"mail_send"};
  expect(restrictStepToolOffers([sandbox,{type:"function",name:"sandbox_execute"},mail] as never,SANDBOX_AND_NAME)).toEqual([mail]);
  expect(restrictStepToolOffers([{type:"function",name:"sandbox_execute"},sandbox] as never,SANDBOX_AND_NAME)).toBeUndefined();
 });
 it("drops the sandbox built-in and an MCP server's tool that carry the same model-facing name",()=>{
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  expect(restrictStepToolOffers([sandbox,
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["sandbox_execute","mail_send"]}] as never,SANDBOX_AND_NAME)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]},
  ]);
 });
 it("keeps the sandbox built-in when no other offered tool carries its model-facing name",()=>{
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
 it("drops the skill shell and a function both offered to OpenAI as skill_file_read",()=>{
  const policy={kind:"declared",tools:["skill_file_read","mail_send"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([skillShell,{type:"function",name:"skill_file_read"},mail] as never,policy)).toEqual([mail]);
 });
 it("drops the skill shell and a function both offered as bash",()=>{
  const policy={kind:"declared",tools:["bash","mail_send"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([skillShell,{type:"function",name:"bash"},mail] as never,policy)).toEqual([mail]);
 });
 it("drops the skill shell and an MCP server's tool both offered as bash, and keeps the server's other names",()=>{
  const policy={kind:"declared",tools:["bash","mail_send"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([skillShell,
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["bash","mail_send"]}] as never,policy)).toEqual([
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]},
  ]);
 });
 it("drops container skills and a function or an MCP tool offered as code_execution",()=>{
  const policy={kind:"declared",tools:["code_execution","mail_send"],builtinTools:["container_skills"]} as const;
  expect(restrictStepToolOffers([containerSkills,{type:"function",name:"code_execution"},mail] as never,policy)).toEqual([mail]);
  expect(restrictStepToolOffers([containerSkills,
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["code_execution"]}] as never,policy)).toBeUndefined();
 });
 it("drops the skill shell and an MCP tool offered to OpenAI as skill_file_read",()=>{
  const policy={kind:"declared",tools:["skill_file_read"],builtinTools:["shell"]} as const;
  expect(restrictStepToolOffers([{type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["skill_file_read"]},
   skillShell] as never,policy)).toBeUndefined();
 });
 it("keeps built-ins of different kinds that share a provider-facing name in the union (each adapter separates them)",()=>{
  const sandbox={type:"sandbox_execution",toolName:"sandbox_execute",description:"d"};
  const policy={kind:"declared",tools:[],builtinTools:["shell","sandbox_execution","container_skills","web_search"]} as const;
  const web={type:"web_search"};
  expect(restrictStepToolOffers([skillShell,sandbox,containerSkills,web] as never,policy)).toEqual([skillShell,sandbox,containerSkills,web]);
 });
 it("names every provider-facing name of each built-in kind in one table",async()=>{
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
 it("offers nothing to a step that declares no tool",()=>{
  expect(restrictStepToolOffers([{type:"function",name:"a"}] as never,{kind:"declared",tools:[]})).toBeUndefined();
 });
 it("refuses a batch submission for a declared step before any provider is resolved",async()=>{
  await expect(orchestrateSubmitBatchV2({provider:"openai",requests:[],stepToolPolicy:{kind:"declared",tools:["a"]}} as never))
   .rejects.toThrow("step_tool_batch_abi_unavailable");
 });
});
