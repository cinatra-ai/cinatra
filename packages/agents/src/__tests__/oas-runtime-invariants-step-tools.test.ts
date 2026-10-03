/**
 * A model step of a flow may declare the application tools it uses under
 * `metadata.cinatra.tools`. The declaration is read by the step's id and
 * validated with the flow (OAS-RUNTIME-015). The cases below build plain OAS
 * documents in this file and drive the real exports of the validator and the
 * real validation entry point.
 */

import { describe, it, expect } from "vitest";

import {
  findStepToolDeclaration,
  readStepToolDeclaration,
  scanOasForRuntimeInvariantFindings,
} from "../validate-oas-runtime-invariants";
import { validateOasAgentJson } from "../validate-agent-json";

const BRIDGE_URL = "https://example.com/api/llm-bridge";
const OTHER_URL = "https://example.com/api/other";
const CODE = "OAS-RUNTIME-015";
const FORM = "metadata.cinatra.tools: a list of distinct lower-case tool names of the application";

function modelStep(
  id: string,
  tools?: unknown,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const node: Record<string, unknown> = {
    component_type: "ApiNode",
    id,
    name: `Step ${id}`,
    url: BRIDGE_URL,
    http_method: "POST",
    data: { agent_id: "fixture", user: "hello" },
    inputs: [],
    outputs: [{ title: "result", type: "string" }],
    ...extra,
  };
  if (tools !== undefined) {
    node.metadata = { cinatra: { tools } };
  }
  return node;
}

function flowOf(
  components: Record<string, Record<string, unknown>>,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "fixture-flow",
    name: "Fixture Flow",
    inputs: [],
    outputs: [{ title: "result", type: "string" }],
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "start" }, { $component_ref: "end" }],
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "Inputs", inputs: [] },
      end: {
        component_type: "EndNode",
        id: "end",
        name: "End",
        outputs: [{ title: "result", type: "string" }],
      },
      ...components,
    },
    ...extra,
  };
}

function findingsOf015(doc: Record<string, unknown>) {
  return scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === CODE);
}

describe("OAS-RUNTIME-015 — a model step's declared tool list", () => {
  it("reads a declared list of two names in written order and accepts it", () => {
    const step = modelStep("step_a", ["objects_get", "objects_list"]);
    expect(readStepToolDeclaration(step)).toEqual({
      kind: "declared",
      tools: ["objects_get", "objects_list"],
    });
    const doc = flowOf({ step_a: step });
    expect(findStepToolDeclaration(doc, "step_a")).toEqual({
      kind: "declared",
      tools: ["objects_get", "objects_list"],
    });
    expect(findingsOf015(doc)).toEqual([]);
  });

  it("reads an empty list as a declaration of no tools and accepts it", () => {
    const step = modelStep("step_a", []);
    const doc = flowOf({ step_a: step });
    expect(readStepToolDeclaration(step)).toEqual({ kind: "declared", tools: [] });
    expect(findStepToolDeclaration(doc, "step_a")).toEqual({ kind: "declared", tools: [] });
    expect(findingsOf015(doc)).toEqual([]);
  });

  it("reports one blocker naming the node and its path when the value is not a list", () => {
    for (const value of ["objects_get", { objects_get: true }, null]) {
      const step = modelStep("step_a", value);
      expect(readStepToolDeclaration(step).kind).toBe("invalid");
      const doc = flowOf({ step_a: step });
      expect(findStepToolDeclaration(doc, "step_a").kind).toBe("invalid");
      const found = findingsOf015(doc);
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("blocker");
      expect(found[0]!.message).toContain('"step_a"');
      expect(found[0]!.message).toContain(FORM);
      expect(found[0]!.location).toBe("$.$referenced_components.step_a");
    }
  });

  it("reports one blocker per document for an empty, blank, non-text, spaced or upper-case entry", () => {
    const lists: unknown[][] = [
      ["objects_get", ""],
      ["objects_get", "   "],
      ["objects_get", 7],
      ["objects get"],
      ["Objects_Get"],
    ];
    for (const list of lists) {
      const step = modelStep("step_a", list);
      expect(readStepToolDeclaration(step).kind).toBe("invalid");
      const found = findingsOf015(flowOf({ step_a: step }));
      expect(found).toHaveLength(1);
      expect(found[0]!.severity).toBe("blocker");
      expect(found[0]!.location).toBe("$.$referenced_components.step_a");
    }
  });

  it("reports one blocker when a name is written twice", () => {
    const step = modelStep("step_a", ["objects_get", "objects_list", "objects_get"]);
    const reading = readStepToolDeclaration(step);
    expect(reading.kind).toBe("invalid");
    const found = findingsOf015(flowOf({ step_a: step }));
    expect(found).toHaveLength(1);
    expect(found[0]!.message).toContain('"step_a"');
  });

  it("reports the key on a node that is not a model step, saying it is read on model steps only", () => {
    const doc = flowOf({
      note: {
        component_type: "InputMessageNode",
        id: "note",
        name: "Note",
        inputs: [],
        outputs: [],
        metadata: { cinatra: { tools: ["objects_get"] } },
      },
      plain: modelStep("plain", ["objects_get"], { url: OTHER_URL }),
    });
    const found = findingsOf015(doc);
    expect(found).toHaveLength(2);
    for (const f of found) {
      expect(f.severity).toBe("blocker");
      expect(f.message).toContain("read on model-bridge steps only");
    }
    expect(found.map((f) => f.location).sort()).toEqual([
      "$.$referenced_components.note",
      "$.$referenced_components.plain",
    ]);
    expect(found.some((f) => f.message.includes('"note"'))).toBe(true);
    expect(found.some((f) => f.message.includes('"plain"'))).toBe(true);
  });

  it("reports one blocker for model steps sharing an id when one declares, and reads the common names", () => {
    const declaring = flowOf({
      first: modelStep("shared", ["objects_get", "objects_list"]),
      second: modelStep("shared"),
    });
    const found = findingsOf015(declaring);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("blocker");
    expect(found[0]!.message).toContain('"shared"');
    expect(found[0]!.message).toContain("$.$referenced_components.first");
    expect(found[0]!.message).toContain("$.$referenced_components.second");
    expect(findStepToolDeclaration(declaring, "shared")).toEqual({
      kind: "declared",
      tools: ["objects_get", "objects_list"],
    });

    const both = flowOf({
      first: modelStep("shared", ["objects_get", "objects_list"]),
      second: modelStep("shared", ["objects_list", "objects_save"]),
    });
    expect(findStepToolDeclaration(both, "shared")).toEqual({
      kind: "declared",
      tools: ["objects_list"],
    });
  });

  it("finds a declaring model step inside a subflow by its id and reads an unknown id as undeclared", () => {
    const inner = flowOf(
      { inner_step: modelStep("inner_step", ["objects_get"]) },
      { id: "inner-flow", name: "Inner Flow" },
    );
    const doc = flowOf({
      sub: {
        component_type: "FlowNode",
        id: "sub",
        name: "Sub",
        subflow: inner,
      },
    });
    expect(findStepToolDeclaration(doc, "inner_step")).toEqual({
      kind: "declared",
      tools: ["objects_get"],
    });
    expect(findStepToolDeclaration(doc, "no_such_step")).toEqual({ kind: "undeclared" });
    expect(findingsOf015(doc)).toEqual([]);
  });

  it("refuses a flow with a malformed declaration through the validation entry point", () => {
    const doc = flowOf({ step_a: modelStep("step_a", ["Objects_Get"]) });
    const errors = validateOasAgentJson(doc);
    expect(errors.some((e) => e.includes(CODE))).toBe(true);
    expect(errors.some((e) => e.includes(CODE) && e.includes("$.$referenced_components.step_a"))).toBe(
      true,
    );
  });

  it("yields no finding of this code for a flow that declares no tools on any step", () => {
    const plain = flowOf({ step_a: modelStep("step_a"), step_b: modelStep("step_b") });
    const withEmptyMetadata = flowOf({
      step_a: modelStep("step_a", undefined, { metadata: { cinatra: {} } }),
      step_b: modelStep("step_b"),
    });
    const before = scanOasForRuntimeInvariantFindings(plain);
    expect(before.filter((f) => f.code === CODE)).toEqual([]);
    expect(scanOasForRuntimeInvariantFindings(withEmptyMetadata)).toEqual(before);
  });
});
