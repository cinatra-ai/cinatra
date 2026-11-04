/**
 * A step's tool offer follows its flow's declaration, read by the REAL
 * declaration reader (cinatra#3745, the reader of cinatra#4093).
 *
 * The run's step policy binds the flow graph the run executes and reads a
 * step's declared tools with the host's own `findStepToolDeclaration`, never
 * with an injected reader. The graph is the repository's synthetic agent
 * fixture: its one model-bridge ApiNode, `call_llm_bridge`, is given a
 * `metadata.cinatra.tools` list here, the way an author writes it.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

import {
  assertRunStepToolAllowed,
  createRunStepToolPolicy,
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

function allowed(source: string, toolName: string, stepId = STEP) {
  const policy = policyOf(source);
  return assertRunStepToolAllowed({
    policy, contextId: "ctx", executedSourceSha256: policy.executedSourceSha256, stepId, toolName,
  });
}

describe("a step's tool offer follows the flow's declaration, read by the real reader", () => {
  it("the fixture graph carries one model-bridge step, and the host's reader module serves both reader functions", () => {
    const step = (GRAPH.$referenced_components as Record<string, Record<string, unknown>>)[STEP]!;
    expect(step.component_type).toBe("ApiNode");
    expect(String(step.url)).toContain("/api/llm-bridge");
    expect(typeof declarationReaders.readStepToolDeclaration).toBe("function");
    expect(typeof declarationReaders.findStepToolDeclaration).toBe("function");
  });

  it("offers a tool the step declares, and refuses one it does not", () => {
    const source = graphDeclaring(["objects_get", "objects_list"]);
    expect(allowed(source, "objects_get")).toEqual({ kind: "declared", tools: ["objects_get", "objects_list"] });
    expect(() => allowed(source, "email_send")).toThrow("step_tool_not_declared");
  });

  it("refuses every tool for a step that declares an empty list", () => {
    expect(() => allowed(graphDeclaring([]), "objects_get")).toThrow("step_tool_not_declared");
  });

  it("leaves a step that declares nothing to the other rules", () => {
    expect(allowed(graphDeclaring(), "email_send")).toEqual({ kind: "undeclared" });
    expect(allowed(graphDeclaring(["objects_get"]), "email_send", "no_such_step")).toEqual({ kind: "undeclared" });
  });

  it("refuses a declaration that is not of the accepted form", () => {
    for (const tools of [["Objects_get"], ["objects get"], ["objects_get", "objects_get"], "objects_get"]) {
      expect(() => readTrustedStepToolDeclaration(graphDeclaring(tools), STEP)).toThrow("step_tool_declaration_invalid");
    }
  });

  it("binds the graph it read: another executed graph is refused", () => {
    const source = graphDeclaring(["objects_get"]);
    const policy = policyOf(source);
    expect(policy.declarationSourceSha256).toBe(createHash("sha256").update(source).digest("hex"));
    expect(() =>
      assertRunStepToolAllowed({
        policy, contextId: "ctx", executedSourceSha256: "f".repeat(64), stepId: STEP, toolName: "objects_get",
      }),
    ).toThrow("step_tool_executed_source_mismatch");
  });
});
