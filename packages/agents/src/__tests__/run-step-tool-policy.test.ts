import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
// The module is new with cinatra#3745. It is loaded here, not by a static import, so that before the
// change this file still loads and its first case fails by an assertion on the missing module.
const policyModule = await import("../run-step-tool-policy").catch(() => undefined);
const { createRunStepToolPolicy, parseRunStepToolPolicy, readTrustedStepToolDeclaration, selectWayflowRunStepToolPolicy, assertRunStepToolAllowed, RunStepToolPolicyRefusal } =
  (policyModule ?? {}) as typeof import("../run-step-tool-policy");
it("the run step tool policy module exists (cinatra#3745)", () => {
 expect(policyModule).toBeDefined();
});
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
 // A real Response: the host reads the answer as a bounded byte stream (cinatra#3745).
 const answer = (body: unknown, ok = true) => vi.fn(async (_url: URL | string, _init?: RequestInit) => new Response(JSON.stringify(body), { status: ok ? 200 : 503 }));
 const env = () => { vi.stubEnv("WAYFLOW_BASE_URL", "http://wayflow.test:3010"); vi.stubEnv("CINATRA_BRIDGE_TOKEN", "bridge-test-value"); };
 afterEach(() => { vi.unstubAllEnvs(); });

 it("binds the loader's three digests and graph to the dispatch context", async () => {
  env();
  const f = answer({ label: "v/s", selectedSourceBinding: binding });
  const p = await selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/cinatra-ai/blog-pipeline-agent/", contextId: "ctx-1" }, f as unknown as typeof fetch);
  expect(p).toEqual({ version: 1, contextId: "ctx-1", sourceSha256: binding.sourceSha256, executedSourceSha256: binding.executedSourceSha256, declarationSourceSha256: binding.declarationSourceSha256, source: graph });
  expect(Object.isFrozen(p)).toBe(true);
  const [url, init] = f.mock.calls[0]!;
  expect(String(url)).toBe("http://wayflow.test:3010/.internal/composed-oas/cinatra-ai/blog-pipeline-agent");
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

 it("carries the mounted file's own text when its digest is the mounted source's, and refuses one that is not (cinatra#3089)", async () => {
  env();
  const file = JSON.stringify({ flow: { id: "mounted" } });
  const p = await selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" },
   answer({ selectedSourceBinding: { ...binding, sourceSha256: sha(file), mountedSource: file } }) as unknown as typeof fetch);
  // red-first-expect: expected undefined to be
  expect(p.mountedSource).toBe(file);
  for (const mountedSource of [file + " ", ""]) {
   await expect(selectWayflowRunStepToolPolicy({ agentUrl: "http://wayflow.test:3010/agents/v/s", contextId: "c" },
    answer({ selectedSourceBinding: { ...binding, sourceSha256: sha(file), mountedSource } }) as unknown as typeof fetch)).rejects.toThrow("step_tool_loader_binding_invalid");
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

// cinatra#3745: one call of a step is admitted only for a tool the step's bound source
// declares; a step that declares nothing keeps every tool. The binding's context and
// executing digest must be the proof's.
describe("the step's declared tools, asserted for one call", () => {
 const call = (p: ReturnType<typeof policy>, toolName: string) =>
  ({ policy: p, contextId: "ctx", executedSourceSha256: p.executedSourceSha256, stepId: "step", toolName });
 it("admits a declared tool and refuses an undeclared one", () => {
  const p=policy();
  expect(assertRunStepToolAllowed(call(p,"mail_send"),readers)).toEqual({kind:"declared",tools:["mail_send"]});
  expect(() => assertRunStepToolAllowed(call(p,"wordpress_publish"),readers)).toThrow("step_tool_not_declared");
 });
 it("admits any tool of a step that declares nothing", () => {
  const undeclared = {...readers,findStepToolDeclaration:()=>({kind:"undeclared"})};
  expect(assertRunStepToolAllowed(call(policy(),"wordpress_publish"),undeclared)).toEqual({kind:"undeclared"});
 });
 it("refuses a proof for another context or another executing source", () => {
  const p=policy();
  for(const change of [{contextId:"other"},{executedSourceSha256:"f".repeat(64)}]) {
   expect(() => assertRunStepToolAllowed({...call(p,"mail_send"),...change},readers)).toThrow("step_tool_executed_source_mismatch");
  }
 });
 it("refuses a binding that is not a bound policy", () => {
  expect(() => assertRunStepToolAllowed({...call(policy(),"mail_send"),policy:undefined},readers)).toThrow("step_tool_binding_missing");
  expect(() => assertRunStepToolAllowed({...call(policy(),"mail_send"),policy:{...policy(),source:source+" "}},readers)).toThrow("step_tool_binding_invalid");
 });
 it("refuses with its own class, which carries the code and the class name the 403 map reads", () => {
  let caught: unknown;
  try { assertRunStepToolAllowed(call(policy(),"wordpress_publish"),readers); } catch (e) { caught = e; }
  expect(caught).toBeInstanceOf(RunStepToolPolicyRefusal);
  expect((caught as InstanceType<typeof RunStepToolPolicyRefusal>).name).toBe("RunStepToolPolicyRefusal");
  expect((caught as InstanceType<typeof RunStepToolPolicyRefusal>).code).toBe("step_tool_not_declared");
 });
});
