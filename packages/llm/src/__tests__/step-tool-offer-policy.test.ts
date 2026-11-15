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
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send","objects_save"]}];
  expect(restrictStepToolOffers(offered as never,{kind:"declared",tools:["mail_send"]})).toEqual([
   {type:"function",name:"mail_send"},
   {type:"mcp",serverUrl:"https://example.test",serverLabel:"s",allowedTools:["mail_send"]},
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
 it("offers nothing to a step that declares no tool",()=>{
  expect(restrictStepToolOffers([{type:"function",name:"a"}] as never,{kind:"declared",tools:[]})).toBeUndefined();
 });
 it("refuses a batch submission for a declared step before any provider is resolved",async()=>{
  await expect(orchestrateSubmitBatchV2({provider:"openai",requests:[],stepToolPolicy:{kind:"declared",tools:["a"]}} as never))
   .rejects.toThrow("step_tool_batch_abi_unavailable");
 });
});
