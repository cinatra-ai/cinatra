/**
 * A step's tool declaration, read by the REAL declaration reader (cinatra#3745,
 * the reader of cinatra#4093).
 *
 * The run's step policy binds the flow graph the run executes and reads a
 * step's declared tools with the host's own `findStepToolDeclaration`, never
 * with an injected reader. The graph is the repository's synthetic agent
 * fixture: its one model-bridge ApiNode, `call_llm_bridge`, is given a
 * `metadata.cinatra.tools` list here, the way an author writes it. This file
 * pins the reading and the binding; what a call may do with the reading is a
 * later piece of the stack.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  createRunStepToolPolicy,
  parseRunStepToolPolicy,
  readTrustedStepToolDeclaration,
} from "../run-step-tool-policy";
import * as declarationReaders from "../validate-oas-runtime-invariants";

const STEP = "call_llm_bridge";
const GRAPH: Record<string, unknown> = JSON.parse(
  readFileSync(new URL("./fixtures/synthetic-gemini-agent.json", import.meta.url), "utf8"),
);

/** The fixture graph with the model step's declaration set to `tools` (none when undefined). */
function graphDeclaring(tools?: unknown): string {
  const graph = structuredClone(GRAPH) as { $referenced_components: Record<string, Record<string, unknown>> };
  const step = graph.$referenced_components[STEP]!;
  if (tools !== undefined) step.metadata = { cinatra: { tools } };
  return JSON.stringify(graph);
}

function policyOf(source: string) {
  // No reader argument: the policy reads with the host's own reader module.
  return createRunStepToolPolicy({ contextId: "ctx", rawSource: source });
}

/** What the bound graph declares for `stepId`, read with the host's own reader. */
function declared(source: string, stepId = STEP) {
  return readTrustedStepToolDeclaration(policyOf(source).source, stepId);
}

describe("a step's tool declaration, read by the real reader from the bound graph", () => {
  it("the fixture graph carries one model-bridge step, and the host's reader module serves both reader functions", () => {
    const step = (GRAPH.$referenced_components as Record<string, Record<string, unknown>>)[STEP]!;
    expect(step.component_type).toBe("ApiNode");
    expect(String(step.url)).toContain("/api/llm-bridge");
    expect(typeof declarationReaders.readStepToolDeclaration).toBe("function");
    expect(typeof declarationReaders.findStepToolDeclaration).toBe("function");
  });

  it("reads the tools a step declares, in their declared order", () => {
    expect(declared(graphDeclaring(["objects_get", "objects_list"]))).toEqual({
      kind: "declared",
      tools: ["objects_get", "objects_list"],
    });
  });

  it("reads an empty list as a declaration of no tools", () => {
    expect(declared(graphDeclaring([]))).toEqual({ kind: "declared", tools: [] });
  });

  it("reads a step that declares nothing, and an unknown step, as undeclared", () => {
    expect(declared(graphDeclaring())).toEqual({ kind: "undeclared" });
    expect(declared(graphDeclaring(["objects_get"]), "no_such_step")).toEqual({ kind: "undeclared" });
  });

  it("refuses a declaration that is not of the accepted form", () => {
    for (const tools of [["Objects_get"], ["objects get"], ["objects_get", "objects_get"], "objects_get"]) {
      expect(() => readTrustedStepToolDeclaration(graphDeclaring(tools), STEP)).toThrow("step_tool_declaration_invalid");
    }
  });

  it("binds the bytes of the graph it read, and refuses any other bytes", () => {
    const source = graphDeclaring(["objects_get"]);
    const policy = policyOf(source);
    expect(policy.declarationSourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(policy.source).toBe(source);
    expect(() => parseRunStepToolPolicy({ ...policy, source: graphDeclaring(["objects_list"]) })).toThrow("step_tool_binding_invalid");
  });
});
