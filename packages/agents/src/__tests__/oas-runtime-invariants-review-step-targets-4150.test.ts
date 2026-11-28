/**
 * cinatra#4150: a review step marked for artifact review
 * (`metadata.cinatra.artifactReview.targetsInput`) is an InputMessageNode listed
 * directly in the root flow, and its targets input is one the run can supply: a
 * start input of the root flow, or a declared input of a step that sets
 * `surfaceGateInputs: true` (OAS-RUNTIME-013).
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`
 * (exception list: `__fixtures__/known-broken-agents.ts`).
 */
import { describe, it, expect } from "vitest";

import { scanOasForRuntimeInvariantFindings } from "../validate-oas-runtime-invariants";

type Node = Record<string, unknown>;

const TARGETS = { title: "reviewTargets", type: "string" };

function flow(components: Record<string, Node>, top: string[], startInputs: Node[] = []): Node {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "fixture-flow",
    name: "Fixture",
    inputs: startInputs,
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: ["start", ...top, "end"].map((k) => ({ $component_ref: k })),
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start", inputs: startInputs },
      end: { component_type: "EndNode", id: "end", name: "end", outputs: [] },
      ...components,
    },
  };
}

function reviewStep(id: string, cinatra: Record<string, unknown>, componentType = "InputMessageNode"): Node {
  return {
    component_type: componentType,
    id,
    name: id,
    inputs: [TARGETS],
    outputs: [{ title: "user_provided_input", type: "string" }],
    metadata: { cinatra },
  };
}

const MARK = { artifactReview: { targetsInput: "reviewTargets" } };

function reviewFindings(doc: Node) {
  return scanOasForRuntimeInvariantFindings(doc).filter((f) => f.message.startsWith("Review step"));
}

describe("OAS-RUNTIME-013: a review step's targets are ones the run can supply (cinatra#4150)", () => {
  it("refuses a marked step that does not surface its inputs, whose targets input is no start input (the live defect)", () => {
    const findings = reviewFindings(flow({ review: reviewStep("review", MARK) }, ["review"]));
    expect(findings).toHaveLength(1);
    expect(findings[0].code).toBe("OAS-RUNTIME-013");
    expect(findings[0].message).toContain("does not set metadata.cinatra.surfaceGateInputs: true");
    expect(findings[0].location).toBe("$.$referenced_components.review");
  });

  it("accepts a marked step that surfaces its inputs and declares the targets input", () => {
    const doc = flow({ review: reviewStep("review", { ...MARK, surfaceGateInputs: true }) }, ["review"]);
    expect(reviewFindings(doc)).toEqual([]);
  });

  it("refuses a surfacing step that does not declare the targets input", () => {
    const step = { ...reviewStep("review", { ...MARK, surfaceGateInputs: true }), inputs: [] };
    const findings = reviewFindings(flow({ review: step }, ["review"]));
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("not one of the step's declared inputs");
  });

  it("accepts a marked step whose targets input is a start input of the root flow", () => {
    const doc = flow({ review: reviewStep("review", MARK) }, ["review"], [TARGETS]);
    expect(reviewFindings(doc)).toEqual([]);
  });

  it("refuses a marked step inside a nested flow", () => {
    const inner = flow({ review: reviewStep("review", { ...MARK, surfaceGateInputs: true }) }, ["review"]);
    const doc = flow({ sub: { component_type: "FlowNode", id: "sub", name: "sub", subflow: inner } }, ["sub"]);
    const findings = reviewFindings(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("not an InputMessageNode listed in the root flow's nodes");
  });

  it("refuses a marked node that is not an InputMessageNode", () => {
    const doc = flow({ review: reviewStep("review", { ...MARK, surfaceGateInputs: true }, "ApiNode") }, ["review"]);
    const findings = reviewFindings(doc);
    expect(findings).toHaveLength(1);
    expect(findings[0].message).toContain("not an InputMessageNode listed in the root flow's nodes");
  });

  it("does not read the marker inside an ApiNode's data payload", () => {
    const api = {
      component_type: "ApiNode",
      id: "call",
      name: "call",
      url: "https://example.test/api",
      http_method: "POST",
      data: { payload: { metadata: { cinatra: MARK } } },
    };
    expect(reviewFindings(flow({ call: api }, ["call"]))).toEqual([]);
  });

  it("does not read the marker inside the payload of a node in a nested flow", () => {
    const api = {
      component_type: "ApiNode",
      id: "call",
      name: "call",
      url: "https://example.test/api",
      http_method: "POST",
      data: { items: [{ metadata: { cinatra: MARK } }] },
    };
    const inner = flow({ call: api }, ["call"]);
    const doc = flow({ sub: { component_type: "FlowNode", id: "sub", name: "sub", subflow: inner } }, ["sub"]);
    expect(reviewFindings(doc)).toEqual([]);
  });

  it("does not judge an unmarked step", () => {
    expect(reviewFindings(flow({ review: reviewStep("review", {}) }, ["review"]))).toEqual([]);
  });
});
