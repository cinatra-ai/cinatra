/**
 * cinatra#4150: two flow mistakes that passed every check and failed only in a
 * live run are now refused by the runtime-invariant scan.
 *
 *   1. A gate marked `metadata.cinatra.artifactReview.targetsInput` that does not
 *      set `metadata.cinatra.surfaceGateInputs: true` (or is not an
 *      InputMessageNode, or does not declare the named input): the loader writes
 *      an empty pause message and no artifact review opens (OAS-RUNTIME-013).
 *   2. A model-bridge step inside a `publishes: true` node that can call tools
 *      but declares none in `metadata.cinatra.tools`: the run refuses its outward
 *      call with `action_decision_step_undeclared` after Publish (OAS-RUNTIME-015).
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`
 * (allow-list: `__fixtures__/known-broken-agents.ts`).
 */
import { describe, it, expect } from "vitest";

import { scanOasForRuntimeInvariantFindings } from "../validate-oas-runtime-invariants";

const BRIDGE = "{{CINATRA_BASE_URL}}/api/llm-bridge";
const PASSTHROUGH = "{{CINATRA_BASE_URL}}/api/agents/passthrough";

type Node = Record<string, unknown>;

function flow(components: Record<string, Node>, top: string[]): Node {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "fixture-flow",
    name: "Fixture",
    inputs: [],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: ["start", ...top, "end"].map((k) => ({ $component_ref: k })),
    control_flow_connections: [],
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start", inputs: [] },
      end: { component_type: "EndNode", id: "end", name: "end", outputs: [] },
      ...components,
    },
  };
}

function gate(id: string, cinatra: Record<string, unknown>, extra: Node = {}): Node {
  return {
    component_type: "InputMessageNode",
    id,
    name: id,
    inputs: [{ title: "reviewTargets", type: "string" }],
    outputs: [{ title: "decision", type: "string" }],
    metadata: { cinatra },
    ...extra,
  };
}

function bridge(id: string, cinatra?: Record<string, unknown>, data: Node = {}): Node {
  return {
    component_type: "ApiNode",
    id,
    name: id,
    url: BRIDGE,
    http_method: "POST",
    data: { agent_id: "fixture", user: "hi", ...data },
    inputs: [],
    outputs: [],
    ...(cinatra ? { metadata: { cinatra } } : {}),
  };
}

function subflowNode(id: string, inner: Record<string, Node>, cinatra?: Record<string, unknown>): Node {
  return {
    component_type: "FlowNode",
    id,
    name: id,
    subflow: flow(inner, Object.keys(inner)),
    ...(cinatra ? { metadata: { cinatra } } : {}),
  };
}

const review = { artifactReview: { targetsInput: "reviewTargets" } };
const codes = (doc: Node, code: string, text: string) =>
  scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === code && f.message.includes(text));

describe("rule 1: an artifact-review gate surfaces its targets", () => {
  const RULE = "declares metadata.cinatra.artifactReview.targetsInput";

  it("refuses a review gate without surfaceGateInputs: true, top-level and nested", () => {
    const top = flow({ review_post: gate("review_post", review) }, ["review_post"]);
    const [f] = codes(top, "OAS-RUNTIME-013", RULE);
    expect(f?.message).toContain('Gate "review_post"');
    expect(f?.message).toContain("does not set metadata.cinatra.surfaceGateInputs: true");

    const nested = flow({ outer: subflowNode("outer", { inner_gate: gate("inner_gate", { ...review, surfaceGateInputs: "true" }) }) }, ["outer"]);
    expect(codes(nested, "OAS-RUNTIME-013", RULE).map((x) => x.message)).toEqual([
      expect.stringContaining('Gate "inner_gate"'),
    ]);
  });

  it("refuses a targets input that is not a declared input, and a marker on another node kind", () => {
    const wrongInput = flow({ g: gate("g", { artifactReview: { targetsInput: "other" }, surfaceGateInputs: true }) }, ["g"]);
    expect(codes(wrongInput, "OAS-RUNTIME-013", '"other" is not one of its declared inputs')).toHaveLength(1);

    const notGate = flow({ a: { ...bridge("a"), metadata: { cinatra: review } } }, ["a"]);
    expect(codes(notGate, "OAS-RUNTIME-013", 'it is a "ApiNode", not an InputMessageNode')).toHaveLength(1);
  });

  it("accepts a conforming review gate, top-level and nested, and an unmarked gate", () => {
    const ok = { ...review, surfaceGateInputs: true };
    expect(codes(flow({ g: gate("g", ok) }, ["g"]), "OAS-RUNTIME-013", RULE)).toEqual([]);
    expect(codes(flow({ o: subflowNode("o", { g: gate("g", ok) }) }, ["o"]), "OAS-RUNTIME-013", RULE)).toEqual([]);
    expect(codes(flow({ g: gate("g", {}) }, ["g"]), "OAS-RUNTIME-013", RULE)).toEqual([]);
  });
});

describe("rule 2: a model step of a publishing node declares its tools", () => {
  const RULE = "declares no tools in metadata.cinatra.tools";

  it("refuses a publishing model step with no or an empty tools list", () => {
    const none = flow({ publish: bridge("publish", { publishes: true }) }, ["publish"]);
    const [f] = codes(none, "OAS-RUNTIME-015", RULE);
    expect(f?.message).toContain('Model-bridge step "publish" is part of the publishing node "publish"');
    expect(f?.location).toBe("$.$referenced_components.publish");

    const empty = flow({ publish: bridge("publish", { publishes: true, tools: [] }) }, ["publish"]);
    expect(codes(empty, "OAS-RUNTIME-015", RULE)).toHaveLength(1);
  });

  it("refuses a model step nested in a publishing FlowNode", () => {
    const doc = flow({ pub: subflowNode("pub", { call_site: bridge("call_site") }, { publishes: true }) }, ["pub"]);
    expect(codes(doc, "OAS-RUNTIME-015", RULE).map((x) => x.message)).toEqual([
      expect.stringContaining('Model-bridge step "call_site" is part of the publishing node "pub"'),
    ]);
  });

  it("accepts declared tools, a step offered no tools, a non-publishing node and a passthrough publisher", () => {
    const declared = flow({ p: bridge("p", { publishes: true, tools: ["wordpress_pages_create"] }) }, ["p"]);
    expect(codes(declared, "OAS-RUNTIME-015", RULE)).toEqual([]);
    const noTools = flow({ p: bridge("p", { publishes: true }, { toolbox_ids: [] }) }, ["p"]);
    expect(codes(noTools, "OAS-RUNTIME-015", RULE)).toEqual([]);
    const notPublishing = flow({ p: bridge("p", { publishes: false }) }, ["p"]);
    expect(codes(notPublishing, "OAS-RUNTIME-015", RULE)).toEqual([]);
    const nestedDeclared = flow({ pub: subflowNode("pub", { s: bridge("s", { tools: ["x_post"] }) }, { publishes: true }) }, ["pub"]);
    expect(codes(nestedDeclared, "OAS-RUNTIME-015", RULE)).toEqual([]);
    const passthrough = flow({ p: { ...bridge("p", { publishes: true }), url: PASSTHROUGH } }, ["p"]);
    expect(codes(passthrough, "OAS-RUNTIME-015", RULE)).toEqual([]);
  });
});
