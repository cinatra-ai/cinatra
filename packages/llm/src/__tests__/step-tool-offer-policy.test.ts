import { describe, it, expect, vi } from "vitest";
// These pure offer filters use the actual orchestration index; external provider/DB ports are not executed.
vi.mock("../registry",()=>({}));
vi.mock("../mcp-access",()=>({}));
vi.mock("../tools/skills",()=>({}));
import { intersectStepToolNames, restrictMcpServerOffer, restrictStepToolOffers } from "../step-tool-offer-policy";
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
});
