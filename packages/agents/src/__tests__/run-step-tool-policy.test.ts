import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { createRunStepToolPolicy, parseRunStepToolPolicy, assertRunStepToolAllowed, readTrustedStepToolDeclaration } from "../run-step-tool-policy";
const source = JSON.stringify({ flow: { id: "step", tools: ["mail_send"] } });
const readers = { readStepToolDeclaration: () => {}, findStepToolDeclaration: () => ({kind:"declared",tools:["mail_send"]}) };
const policy = () => createRunStepToolPolicy({contextId:"ctx",rawSource:source},readers);
describe("immutable executing-source declaration", () => {
 it("refuses Main's absent trusted reader ABI rather than synthesizing permissive declarations", () => {
  expect(() => createRunStepToolPolicy({contextId:"ctx",rawSource:source},{})).toThrow("step_tool_reader_unavailable");
  expect(() => readTrustedStepToolDeclaration(source,"step",{})).toThrow("step_tool_reader_unavailable");
 });
 it("accepts only named step tools from the fixed compatible prerequisite", () => {
  const p=policy(); expect(Object.isFrozen(p)).toBe(true);
  expect(assertRunStepToolAllowed({policy:p,contextId:"ctx",executedSourceSha256:p.executedSourceSha256,stepId:"step",toolName:"mail_send"},readers).kind).toBe("declared");
  expect(() => assertRunStepToolAllowed({policy:p,contextId:"ctx",executedSourceSha256:p.executedSourceSha256,stepId:"step",toolName:"wordpress_publish"},readers)).toThrow("step_tool_not_declared");
 });
 it("allows an absent declaration only through the compatible trusted reader", () => {
  expect(readTrustedStepToolDeclaration(source,"step",{...readers,findStepToolDeclaration:()=>({kind:"undeclared"})})).toEqual({kind:"undeclared"});
 });
 it("binds context and executing digest independently of declaration bytes", () => {
  const p=policy();
  for(const change of [{contextId:"other"},{executedSourceSha256:"f".repeat(64)}]) {
   expect(() => assertRunStepToolAllowed({policy:p,contextId:"ctx",executedSourceSha256:p.executedSourceSha256,stepId:"step",toolName:"mail_send",...change},readers)).toThrow("step_tool_executed_source_mismatch");
  }
  expect(() => parseRunStepToolPolicy({...p,source:source+" "})).toThrow("step_tool_binding_invalid");
 });
 it("refuses malformed, duplicate and noncanonical declarations", () => {
  for(const value of [null,{kind:"declared",tools:["mail_send","mail_send"]},{kind:"declared",tools:["Mail_send"]},{kind:"declared",tools:["mail send"]},{kind:"other"}]) {
   expect(() => readTrustedStepToolDeclaration(source,"step",{...readers,findStepToolDeclaration:()=>value})).toThrow();
  }
 });
 it("keeps selected raw/executed digests and hashes its immutable pre-substitution graph", () => {
  const p=createRunStepToolPolicy({contextId:"ctx",rawSource:source,selectedRawSourceSha256:"a".repeat(64),selectedExecutedSourceSha256:"b".repeat(64)},readers);
  expect(p.sourceSha256).toBe("a".repeat(64));expect(p.executedSourceSha256).toBe("b".repeat(64));
  expect(p.declarationSourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
 });
});
