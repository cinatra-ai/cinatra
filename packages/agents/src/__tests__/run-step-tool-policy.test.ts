import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { createRunStepToolPolicy, parseRunStepToolPolicy, readTrustedStepToolDeclaration, selectWayflowRunStepToolPolicy } from "../run-step-tool-policy";
const source = JSON.stringify({ flow: { id: "step", tools: ["mail_send"] } });
const readers = { readStepToolDeclaration: () => {}, findStepToolDeclaration: () => ({kind:"declared",tools:["mail_send"]}) };
const policy = () => createRunStepToolPolicy({contextId:"ctx",rawSource:source},readers);
describe("immutable executing-source declaration", () => {
 it("refuses Main's absent trusted reader ABI rather than synthesizing permissive declarations", () => {
  expect(() => createRunStepToolPolicy({contextId:"ctx",rawSource:source},{})).toThrow("step_tool_reader_unavailable");
  expect(() => readTrustedStepToolDeclaration(source,"step",{})).toThrow("step_tool_reader_unavailable");
 });
 it("reads the named step tools from the fixed compatible prerequisite", () => {
  const p=policy(); expect(Object.isFrozen(p)).toBe(true);
  expect(readTrustedStepToolDeclaration(p.source,"step",readers)).toEqual({kind:"declared",tools:["mail_send"]});
 });
 it("allows an absent declaration only through the compatible trusted reader", () => {
  expect(readTrustedStepToolDeclaration(source,"step",{...readers,findStepToolDeclaration:()=>({kind:"undeclared"})})).toEqual({kind:"undeclared"});
 });
 it("refuses a policy whose graph bytes are not the bytes it hashed", () => {
  const p=policy();
  expect(parseRunStepToolPolicy(p)).toEqual(p);
  expect(() => parseRunStepToolPolicy({...p,source:source+" "})).toThrow("step_tool_binding_invalid");
  for(const change of [{version:2},{contextId:""},{sourceSha256:"x"},{executedSourceSha256:"A".repeat(64)}]) {
   expect(() => parseRunStepToolPolicy({...p,...change})).toThrow("step_tool_binding_invalid");
  }
  expect(() => parseRunStepToolPolicy(undefined)).toThrow("step_tool_binding_missing");
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
  expect(() => createRunStepToolPolicy({contextId:"ctx",rawSource:source,selectedRawSourceSha256:"nothex"},readers)).toThrow("step_tool_selected_source_invalid");
 });
});

// cinatra#3745: the host selects the loader's binding BEFORE the first send. The loader
// answers on its internal composed-OAS route; the bridge token goes to the configured
// origin only, and an answer without a binding refuses the dispatch.
describe("the loader's selected source, read before dispatch", () => {
 const sha = (t: string) => createHash("sha256").update(t).digest("hex");
 const graph = JSON.stringify({ flow: { id: "step" } });
 const binding = { sourceSha256: "a".repeat(64), executedSourceSha256: "b".repeat(64), declarationSourceSha256: sha(graph), declarationSource: graph };
 const answer = (body: unknown, ok = true) => vi.fn(async (_url: URL | string, _init?: RequestInit) => ({ ok, json: async () => body }) as unknown as Response);
 const env = () => { vi.stubEnv("WAYFLOW_BASE_URL", "http://wayflow.test:3010"); vi.stubEnv("CINATRA_BRIDGE_TOKEN", "bridge-test-value"); };
 afterEach(() => { vi.unstubAllEnvs(); });

 it("binds the loader's three digests and graph to the dispatch context", async () => {
  env();
  const f = answer({ label: "v/s", selectedSourceBinding: binding });
  const p = await selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/cinatra-ai/some-agent/", contextId: "ctx-1" }, f as unknown as typeof fetch);
  expect(p).toEqual({ version: 1, contextId: "ctx-1", sourceSha256: binding.sourceSha256, executedSourceSha256: binding.executedSourceSha256, declarationSourceSha256: binding.declarationSourceSha256, source: graph });
  expect(Object.isFrozen(p)).toBe(true);
  const [url, init] = f.mock.calls[0]!;
  expect(String(url)).toBe("http://wayflow.test:3010/.internal/composed-oas/cinatra-ai/some-agent");
  expect(init).toMatchObject({ headers: { "X-Cinatra-Bridge-Token": "bridge-test-value" }, redirect: "error", cache: "no-store" });
 });

 it("refuses the dispatch when the loader answers without a binding", async () => {
  env();
  for (const body of [{ label: "v/s" }, { selectedSourceBinding: null }, null]) {
   await expect(selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" }, answer(body) as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_binding_missing");
  }
 });

 it("refuses a binding whose graph bytes are not the bytes it names", async () => {
  env();
  for (const bad of [{ ...binding, declarationSource: graph + " " }, { ...binding, sourceSha256: "x" }, { ...binding, declarationSource: "" }]) {
   await expect(selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" }, answer({ selectedSourceBinding: bad }) as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_binding_invalid");
  }
 });

 it("never sends the bridge token to another origin or a non-agent path", async () => {
  env();
  for (const agentUrl of ["http://elsewhere.test:3010/agents/v/s", "http://wayflow.test:3011/agents/v/s", "http://wayflow.test:3010/other/v/s",
    "http://u:p@wayflow.test:3010/agents/v/s", "http://wayflow.test:3010/agents/v/s?x=1", "http://wayflow.test:3010/agents/v/s#x", "not a url"]) {
   const f = answer({ selectedSourceBinding: binding });
   await expect(selectWayflowRunStepToolPolicy({ agentUrl, contextId: "c" }, f as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_target_invalid");
   expect(f).not.toHaveBeenCalled();
  }
 });

 it("keeps the path prefix of the configured base, as the agent URL and the reload client do", async () => {
  vi.stubEnv("WAYFLOW_BASE_URL", "https://edge.test/wayflow/"); vi.stubEnv("CINATRA_BRIDGE_TOKEN", "bridge-test-value");
  const f = answer({ selectedSourceBinding: binding });
  await selectWayflowRunStepToolPolicy({ agentUrl: "https://edge.test/wayflow/agents/v/s/", contextId: "c" }, f as unknown as typeof fetch);
  expect(String(f.mock.calls[0]![0])).toBe("https://edge.test/wayflow/.internal/composed-oas/v/s");
  for (const agentUrl of ["https://edge.test/agents/v/s", "https://edge.test/wayflowx/agents/v/s", "https://edge.test/wayflow/x/agents/v/s"]) {
   const g = answer({ selectedSourceBinding: binding });
   await expect(selectWayflowRunStepToolPolicy({ agentUrl, contextId: "c" }, g as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_target_invalid");
   expect(g).not.toHaveBeenCalled();
  }
 });

 it("refuses when the loader is not configured or refuses the read", async () => {
  vi.stubEnv("WAYFLOW_BASE_URL", ""); vi.stubEnv("CINATRA_BRIDGE_TOKEN", "bridge-test-value");
  await expect(selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" }, answer({}) as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_unavailable");
  env();
  await expect(selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" }, answer({}, false) as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_selection_refused");
 });
});
