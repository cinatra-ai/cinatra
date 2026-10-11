import { describe, it, expect, vi } from "vitest";
import type { ArtifactActionCheckInput } from "@cinatra-ai/sdk-extensions";
vi.mock("@/lib/extension-version-keyed-serving",()=>({resolveVersionKeyedCapabilityProviders:()=>({kind:"refuse"})}));
vi.mock("@/lib/extension-capabilities-registry",()=>({resolveCapabilityProviders:()=>[],capabilityProviderLoadedIdentity:()=>undefined}));
import { immutableActionJson, canonicalActionJson, checkArtifactAction, actionContentSha256, resolveArtifactActionChecker } from "../artifact-action-check-provider";
const action={packageName:"pack",version:"1",installId:"i",digest:"a".repeat(64),generation:1,toolName:"publish",wrapper:"extension_tool"} as const;
const revision={artifactId:"a",representationRevisionId:"r",artifactType:"document",content:{recipient:"approved"},contentSha256:actionContentSha256({recipient:"approved"})};
describe("extension-owned action CHECK immutable input",()=>{
 it("deep-freezes a detached canonical copy",()=>{
  const input={nested:{recipient:"approved"}};const copied=immutableActionJson(input) as { nested: { recipient: string } };
  input.nested.recipient="unapproved";expect(copied.nested.recipient).toBe("approved");expect(Object.isFrozen(copied.nested)).toBe(true);
  expect(canonicalActionJson({b:2,a:1})).toBe('{"a":1,"b":2}');
 });
 it("never evaluates getters/toJSON or accepts prototype/cyclic/sparse/oversize input",()=>{
  let calls=0;const getter=Object.defineProperty({},"value",{enumerable:true,get(){calls++;return 1;}});
  const cycle:{self?:unknown}={};cycle.self=cycle;
  for(const v of [getter,cycle,Array(2),new Date(),{value:Infinity},{text:"x".repeat(262145)}])expect(()=>immutableActionJson(v)).toThrow();
  expect(calls).toBe(0);
 });
 it("refuses CHECK that does not cover every live pinned revision or matching projection",()=>{
  const input={action,arguments:{recipient:"unapproved"},revisions:[revision]};
  for(const result of [{kind:"checked",usedRevisionIds:[],actual:{x:1},pinned:{x:1}},{kind:"checked",usedRevisionIds:["r"],actual:{x:1},pinned:{x:2}},{kind:"refused",reason:"destination_not_covered"}]) {
   expect(()=>checkArtifactAction({check:()=>result} as never,input)).toThrow("action_not_covered_by_pins");
  }
 });
 it("checks immutable actual args against pinned projections through the registered pack implementation",()=>{
  let frozen=false;checkArtifactAction({check:(input:ArtifactActionCheckInput)=>{frozen=Object.isFrozen(input.arguments)&&Object.isFrozen(input.revisions);return {kind:"checked",usedRevisionIds:["r"],actual:input.arguments,pinned:input.revisions[0].content};}} as never,{action,arguments:{recipient:"approved"},revisions:[revision]});expect(frozen).toBe(true);
 });
 it("rejects mismatched pin content hash and unregistered owner identity",()=>{
  expect(()=>checkArtifactAction({check:()=>{throw new Error("must not execute");}} as never,{action,arguments:{},revisions:[{...revision,contentSha256:"f".repeat(64)}]})).toThrow("action_pin_content_mismatch");
  expect(()=>resolveArtifactActionChecker(action)).toThrow("action_checker_missing_or_ambiguous");
 });
});
