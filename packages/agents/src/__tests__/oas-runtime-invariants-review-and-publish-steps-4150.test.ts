/**
 * cinatra#4150: two flow mistakes that passed every check and failed only in a
 * live run are now refused by the runtime-invariant scan.
 *
 *   1. A gate marked `metadata.cinatra.artifactReview.targetsInput` whose
 *      targets do not reach the review: it is not an InputMessageNode of the
 *      root flow, or its targets input is neither a start input of the root flow
 *      nor a declared input that surfaceGateInputs: true surfaces and a
 *      DataFlowEdge feeds. No artifact review opens (OAS-RUNTIME-013).
 *   2. A model-bridge step inside a `publishes: true` node that can call tools
 *      but declares none in `metadata.cinatra.tools`: the run refuses its outward
 *      call with `action_decision_step_undeclared` after Publish; and a model
 *      step the node runs in a holder the run does not read steps from (an
 *      agent's tool flow), which is refused whatever it declares (OAS-RUNTIME-015).
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`
 * (allow-list: `__fixtures__/known-broken-agents.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { checkPublishingCallRoutes } from "../oas-compiler";
import {
  findPublishingAncestor,
  findStepToolDeclaration,
  hasApiNodeStep,
  scanOasForRuntimeInvariantFindings,
} from "../validate-oas-runtime-invariants";

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
/** A root-flow DataFlowEdge from `from.out` into `to.input`. */
const edge = (from: string, out: string, to: string, input: string): Node => ({
  component_type: "DataFlowEdge",
  name: `${from}_${to}`,
  source_node: { $component_ref: from },
  source_output: out,
  destination_node: { $component_ref: to },
  destination_input: input,
});
/** A root flow with a producer node `make` whose output feeds the gate's targets input. */
const fed = (gateNode: Node, edges: Node[] = [edge("make", "targets", "g", "reviewTargets")]): Node => ({
  ...flow({ make: bridge("make"), g: gateNode }, ["make", "g"]),
  data_flow_connections: edges,
});
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
      expect.stringContaining('Gate "inner_gate" declares metadata.cinatra.artifactReview.targetsInput but it is not a node of the root flow'),
    ]);
  });

  it("refuses a targets input that is not a declared input, and a marker on another node kind", () => {
    const wrongInput = flow({ g: gate("g", { artifactReview: { targetsInput: "other" }, surfaceGateInputs: true }) }, ["g"]);
    expect(codes(wrongInput, "OAS-RUNTIME-013", '"other" is not one of its declared inputs')).toHaveLength(1);

    const notGate = flow({ a: { ...bridge("a"), metadata: { cinatra: review } } }, ["a"]);
    expect(codes(notGate, "OAS-RUNTIME-013", 'it is a "ApiNode", not an InputMessageNode')).toHaveLength(1);
  });

  it("accepts a gate whose targets input is a start input of the root flow, and not one of a nested flow only", () => {
    // The application falls back to the run's start parameters
    // (resolveDeclaredReviewTargets); they hold the ROOT flow's inputs only.
    const withStart = (doc: Node) => ({ ...doc, inputs: [{ title: "reviewTargets", type: "array" }] });
    expect(codes(withStart(flow({ g: gate("g", review, { inputs: [] }) }, ["g"])), "OAS-RUNTIME-013", RULE)).toEqual([]);

    const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../tests/fixtures/review-gate-agent/cinatra-review-fixture/marked-review-gate/cinatra/oas.json"), "utf8"));
    expect(codes(fixture, "OAS-RUNTIME-013", RULE)).toEqual([]);

    const nestedOnly = flow({ o: { ...subflowNode("o", { g: gate("g", review, { inputs: [] }) }) } }, ["o"]);
    (nestedOnly.$referenced_components as Record<string, Node>).o!.subflow = {
      ...((nestedOnly.$referenced_components as Record<string, Node>).o!.subflow as Node),
      inputs: [{ title: "reviewTargets", type: "array" }],
    };
    expect(codes(nestedOnly, "OAS-RUNTIME-013", RULE).map((x) => x.message)).toEqual([
      expect.stringContaining("is not a node of the root flow"),
    ]);
  });

  // cinatra#4150 round 3, finding 2: the compiler carries a nested gate's
  // surfaceGateInputKeys through its FlowNode, never its
  // artifactReviewTargetsInput, and execution routes to the review only on that
  // compiled field, so a nested marked gate opens no review on either road.
  it("refuses a marked gate inside a nested flow, whatever road it uses", () => {
    const withStart = (doc: Node) => ({ ...doc, inputs: [{ title: "reviewTargets", type: "array" }] });
    const startRoad = withStart(flow({ o: subflowNode("o", { g: gate("g", review, { inputs: [] }) }) }, ["o"]));
    expect(codes(startRoad, "OAS-RUNTIME-013", "is not a node of the root flow")).toHaveLength(1);

    const inner = fed(gate("g", { ...review, surfaceGateInputs: true }));
    const surfacedRoad = flow({ o: { component_type: "FlowNode", id: "o", name: "o", subflow: inner } }, ["o"]);
    expect(codes(surfacedRoad, "OAS-RUNTIME-013", "is not a node of the root flow")).toHaveLength(1);
  });

  // cinatra#4150 round 3, finding 1: the loader renders an input no edge feeds
  // as null, which resolveDeclaredReviewTargets takes as absent.
  it("refuses a surfaced targets input that no DataFlowEdge of the root flow feeds", () => {
    const ok = { ...review, surfaceGateInputs: true };
    const NOT_FED = 'no DataFlowEdge of the root flow feeds its input "reviewTargets"';
    expect(codes(flow({ g: gate("g", ok) }, ["g"]), "OAS-RUNTIME-013", NOT_FED)).toHaveLength(1);
    expect(codes(fed(gate("g", ok), [edge("make", "targets", "g", "otherInput")]), "OAS-RUNTIME-013", NOT_FED)).toHaveLength(1);
    expect(codes(fed(gate("g", ok), [edge("make", "targets", "elsewhere", "reviewTargets")]), "OAS-RUNTIME-013", NOT_FED)).toHaveLength(1);
    expect(codes(fed(gate("g", ok), [edge("ghost", "targets", "g", "reviewTargets")]), "OAS-RUNTIME-013", NOT_FED)).toHaveLength(1);
    const untyped = { ...edge("make", "targets", "g", "reviewTargets"), component_type: undefined };
    expect(codes(fed(gate("g", ok), [untyped]), "OAS-RUNTIME-013", NOT_FED)).toHaveLength(1);
  });

  it("accepts a conforming surfaced review gate of the root flow, and an unmarked gate", () => {
    const ok = { ...review, surfaceGateInputs: true };
    expect(codes(fed(gate("g", ok)), "OAS-RUNTIME-013", RULE)).toEqual([]);
    expect(codes(flow({ g: gate("g", {}) }, ["g"]), "OAS-RUNTIME-013", RULE)).toEqual([]);
    expect(codes(flow({ o: subflowNode("o", { g: gate("g", {}) }) }, ["o"]), "OAS-RUNTIME-013", RULE)).toEqual([]);
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

  // cinatra#4150 round 3, finding 3: the run reads a step's declaration
  // (findStepToolDeclaration, hasApiNodeStep) and ties it to a publishing node
  // (findPublishingAncestor) through ONE shape set. A model step the node runs
  // in any other holder (an agent's tool flow, which the compiler's publishing
  // traversal still walks) is reported as a step that cannot be checked.
  const UNCHECKED = "sits in a holder the run does not read steps from";
  const helper = (inner: Node, single = false): Node => ({
    component_type: "Agent",
    id: "helper",
    name: "helper",
    tools: single
      ? { component_type: "FlowTool", id: "t", name: "t", flow: flow({ s: inner }, ["s"]) }
      : [{ component_type: "FlowTool", id: "t", name: "t", flow: flow({ s: inner }, ["s"]) }],
  });
  const unread: Record<string, (inner: Node) => Node> = {
    "AgentNode.agent > Agent.tools list > tool flow": (inner) =>
      flow({ pub: { component_type: "AgentNode", id: "pub", name: "pub", agent: helper(inner), metadata: { cinatra: { publishes: true } } } }, ["pub"]),
    "Agent.tools as a single object": (inner) =>
      flow({ pub: { component_type: "AgentNode", id: "pub", name: "pub", agent: helper(inner, true), metadata: { cinatra: { publishes: true } } } }, ["pub"]),
    "AgentNode.agent by $component_ref to a root component": (inner) => ({
      ...flow({ pub: { component_type: "AgentNode", id: "pub", name: "pub", agent: { $component_ref: "helper" }, metadata: { cinatra: { publishes: true } } } }, ["pub"]),
      $referenced_components: {
        ...(flow({}, []).$referenced_components as Node),
        pub: { component_type: "AgentNode", id: "pub", name: "pub", agent: { $component_ref: "helper" }, metadata: { cinatra: { publishes: true } } },
        helper: helper(inner),
      },
    }),
    "Agent.tools by $component_ref inside a subflow's own components": (inner) => {
      const sub = flow({ ask: { component_type: "AgentNode", id: "ask", name: "ask", agent: { component_type: "Agent", id: "h", name: "h", tools: [{ $component_ref: "tool" }] } } }, ["ask"]);
      (sub.$referenced_components as Record<string, Node>).tool = { component_type: "FlowTool", id: "tool", name: "tool", flow: flow({ s: inner }, ["s"]) };
      return flow({ pub: { component_type: "FlowNode", id: "pub", name: "pub", subflow: sub, metadata: { cinatra: { publishes: true } } } }, ["pub"]);
    },
  };
  const read: Record<string, (inner: Node) => Node> = {
    "the node itself": (inner) => {
      const own = ((inner.metadata as Node | undefined)?.cinatra ?? {}) as Node;
      return flow({ pub: { ...inner, id: "pub", metadata: { cinatra: { ...own, publishes: true } } } }, ["pub"]);
    },
    "an inline subflow": (inner) => flow({ pub: subflowNode("pub", { s: inner }, { publishes: true }) }, ["pub"]),
    "a subflow by $component_ref to a root component": (inner) => {
      const doc = flow({ pub: { component_type: "FlowNode", id: "pub", name: "pub", subflow: { $component_ref: "sub" }, metadata: { cinatra: { publishes: true } } } }, ["pub"]);
      (doc.$referenced_components as Record<string, Node>).sub = flow({ s: inner }, ["s"]);
      return doc;
    },
    "a subflow listing a root component in its nodes": (inner) => {
      const sub = flow({}, []);
      (sub.nodes as Node[]).push({ $component_ref: "s" });
      const doc = flow({ pub: { component_type: "FlowNode", id: "pub", name: "pub", subflow: sub, metadata: { cinatra: { publishes: true } } } }, ["pub"]);
      (doc.$referenced_components as Record<string, Node>).s = inner;
      return doc;
    },
    "a ParallelFlowNode's inline subflows": (inner) =>
      flow({ pub: { component_type: "ParallelFlowNode", id: "pub", name: "pub", subflows: [flow({ s: inner }, ["s"])], metadata: { cinatra: { publishes: true } } } }, ["pub"]),
  };
  const step = (cinatra?: Record<string, unknown>) => bridge("deep", cinatra);
  const servedById = (doc: Node, id: string) =>
    hasApiNodeStep(doc, id) && findPublishingAncestor(doc, id).kind === "resolved";

  for (const [shape, build] of Object.entries(read)) {
    it(`reads a model step in ${shape} as the run does`, () => {
      const id = shape === "the node itself" ? "pub" : "deep";
      expect(servedById(build(step()), id)).toBe(true);
      expect(codes(build(step()), "OAS-RUNTIME-015", RULE).map((x) => x.message)).toEqual([
        expect.stringContaining(`Model-bridge step "${id}" is part of the publishing node "pub"`),
      ]);
      const declared = build(step({ tools: ["x_post"] }));
      expect(findStepToolDeclaration(declared, id)).toEqual({ kind: "declared", tools: ["x_post"] });
      expect(scanOasForRuntimeInvariantFindings(declared).filter((f) => f.code === "OAS-RUNTIME-015")).toEqual([]);
    });
  }

  for (const [shape, build] of Object.entries(unread)) {
    it(`reports a model step through ${shape} as one that cannot be checked`, () => {
      // red-first-expect: AssertionError: expected [] to deeply equal [ StringContaining{…} ]
      expect(servedById(build(step({ tools: ["x_post"] })), "deep")).toBe(false);
      for (const doc of [build(step()), build(step({ tools: ["x_post"] }))]) {
        expect(codes(doc, "OAS-RUNTIME-015", UNCHECKED).map((x) => x.message)).toEqual([
          expect.stringContaining('Model-bridge step "deep" can run inside the publishing node "pub"'),
        ]);
        expect(codes(doc, "OAS-RUNTIME-015", RULE)).toEqual([]);
      }
      const offeredNone = build(bridge("deep", undefined, { toolbox_ids: [] }));
      expect(codes(offeredNone, "OAS-RUNTIME-015", UNCHECKED)).toEqual([]);
      const outward = { ...bridge("deep"), url: "https://example.test/hook" };
      expect(checkPublishingCallRoutes(build(outward), ["pub"], {})).toEqual({
        ok: false,
        error: expect.stringContaining('node "deep" of publishing step "pub"'),
      });
    });
  }
});
