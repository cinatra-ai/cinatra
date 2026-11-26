/**
 * cinatra#4150: a model-bridge step that the run reads as a step of a
 * `publishes: true` node, and whose toolbox reaches the product's tool
 * boundary, declares its tools in `metadata.cinatra.tools` (OAS-RUNTIME-015).
 * After Publish the run refuses every outward call of a step that does not
 * declare the call's tool (action_decision_step_undeclared).
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`
 * (exception list: `__fixtures__/known-broken-agents.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import {
  BRIDGE_PROVIDER_NATIVE_TOOLBOX_IDS,
  findPublishingAncestor,
  publishingStepScanVisitsForTests,
  scanOasForRuntimeInvariantFindings,
} from "../validate-oas-runtime-invariants";

const BRIDGE = "{{CINATRA_BASE_URL}}/api/llm-bridge";

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

function publishingFlowNode(id: string, subflow: Node, publishes = true): Node {
  return { component_type: "FlowNode", id, name: id, subflow, metadata: { cinatra: { publishes } } };
}

const UNDECLARED = "declares no tools in metadata.cinatra.tools";
const REFUSED = "the bridge refuses this step's call";
const all015 = (doc: Node) => scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === "OAS-RUNTIME-015");

describe("a publishing model step that reaches the product's tools declares them (cinatra#4150)", () => {
  it("refuses a publishing bridge step with product tools and no declaration", () => {
    const found = all015(flow({ publish: bridge("publish", { publishes: true }) }, ["publish"]));
    expect(found.map((f) => f.message)).toEqual([
      expect.stringContaining(`Model-bridge step "publish" of the publishing node "publish"`),
    ]);
    expect(found[0]?.message).toContain(UNDECLARED);
    expect(found[0]?.location).toBe("$.$referenced_components.publish");
  });

  it("refuses a nested bridge step of a publishing FlowNode, naming its path", () => {
    const doc = flow({ pub: publishingFlowNode("pub", flow({ s: bridge("s") }, ["s"])) }, ["pub"]);
    const found = all015(doc);
    expect(found.map((f) => f.message)).toEqual([expect.stringContaining(`Model-bridge step "s" of the publishing node "pub"`)]);
    expect(found[0]?.location).toBe("$.$referenced_components.pub.subflow.$referenced_components.s");
  });

  it("follows a publishing FlowNode's subflow given by a $component_ref, in the run's scope", () => {
    const doc = flow({ pub: publishingFlowNode("pub", { $component_ref: "sub" }), sub: flow({ s: bridge("s") }, ["s"]) }, ["pub"]);
    const found = all015(doc);
    expect(found.map((f) => f.message)).toEqual([expect.stringContaining(`Model-bridge step "s" of the publishing node "pub"`)]);
    expect(found[0]?.location).toBe("$.$referenced_components.sub.$referenced_components.s");
    expect(findPublishingAncestor(doc, "s")).toEqual({ kind: "resolved", nodeId: "pub" });
  });

  it("follows inline `nodes` of a publishing node's subflow", () => {
    const sub = { ...flow({}, []), nodes: [bridge("s")] };
    const doc = flow({ pub: publishingFlowNode("pub", sub) }, ["pub"]);
    const found = all015(doc);
    expect(found.map((f) => f.message)).toEqual([expect.stringContaining(`Model-bridge step "s" of the publishing node "pub"`)]);
    expect(found[0]?.location).toBe("$.$referenced_components.pub.subflow.nodes[0]");
    expect(findPublishingAncestor(doc, "s")).toEqual({ kind: "resolved", nodeId: "pub" });
  });

  it("judges a component referenced from two publishing nodes once", () => {
    const doc = flow({
      a: publishingFlowNode("a", { $component_ref: "sub" }),
      b: publishingFlowNode("b", { $component_ref: "sub" }),
      sub: flow({ s: bridge("s") }, ["s"]),
    }, ["a", "b"]);
    expect(all015(doc)).toHaveLength(1);
  });

  it("terminates on a self-referencing component", () => {
    const loop = flow({ s: bridge("s") }, ["s"]);
    (loop.nodes as Node[]).push({ $component_ref: "loop" });
    const doc = flow({ pub: publishingFlowNode("pub", { $component_ref: "loop" }), loop }, ["pub"]);
    expect(all015(doc)).toHaveLength(1);
  });

  it("accepts a publishing bridge step that declares its tools", () => {
    expect(all015(flow({ p: bridge("p", { publishes: true, tools: ["wordpress_site_tool_write"] }) }, ["p"]))).toEqual([]);
  });

  it("accepts a publishing bridge step offered no toolbox (toolbox_ids: [])", () => {
    expect(all015(flow({ p: bridge("p", { publishes: true }, { toolbox_ids: [] }) }, ["p"]))).toEqual([]);
  });

  it("accepts a publishing bridge step offered only provider-native toolboxes", () => {
    expect(all015(flow({ p: bridge("p", { publishes: true }, { toolbox_ids: ["web_search"] }) }, ["p"]))).toEqual([]);
    for (const ids of [["cinatra-mcp"], ["web_search", "some-external-server"]]) {
      expect(all015(flow({ p: bridge("p", { publishes: true }, { toolbox_ids: ids }) }, ["p"]))).toHaveLength(1);
    }
  });

  it("refuses a publishing bridge step whose toolbox_ids is not a list of texts", () => {
    for (const ids of [["cinatra-mcp", 7], "cinatra-mcp", null]) {
      const found = all015(flow({ p: bridge("p", { publishes: true, tools: ["x_post"] }, { toolbox_ids: ids }) }, ["p"]));
      expect(found.map((f) => f.message)).toEqual([expect.stringContaining(REFUSED)]);
    }
  });

  it("accepts a bridge step under a node that does not publish", () => {
    expect(all015(flow({ p: bridge("p", { publishes: false }) }, ["p"]))).toEqual([]);
    expect(all015(flow({ p: bridge("p") }, ["p"]))).toEqual([]);
    expect(all015(flow({ pub: publishingFlowNode("pub", flow({ s: bridge("s") }, ["s"]), false) }, ["pub"]))).toEqual([]);
  });

  it("stays linear on 1,000 publishing nodes sharing one subflow of 1,000 steps, with no duplicate finding", () => {
    // red-first-expect: publishingStepScanVisitsForTests is not a function
    const P = 1000;
    const S = 1000;
    const steps: Record<string, Node> = {};
    for (let i = 0; i < S; i++) steps[`s${i}`] = bridge(`s${i}`);
    const shared = flow(steps, Object.keys(steps));
    const nodes: Record<string, Node> = {};
    for (let i = 0; i < P; i++) nodes[`pub${i}`] = publishingFlowNode(`pub${i}`, shared);
    // P more publishing nodes reference one root component, a flow of S other steps.
    const refSteps: Record<string, Node> = {};
    for (let i = 0; i < S; i++) refSteps[`r${i}`] = bridge(`r${i}`);
    for (let i = 0; i < P; i++) nodes[`ref${i}`] = publishingFlowNode(`ref${i}`, { $component_ref: "sharedRef" });
    const doc = flow(nodes, Object.keys(nodes));
    (doc.$referenced_components as Record<string, Node>).sharedRef = flow(refSteps, Object.keys(refSteps));
    const found = all015(doc);
    // Each object is entered once in total. Per shared flow: the flow, its S + 2
    // components and the S + 3 references to them (its nodes and start_node).
    // Per publishing node: the node, and for the second P its subflow reference.
    // A walk per publishing node would enter P * (S + 3) objects or more.
    expect(publishingStepScanVisitsForTests()).toBeLessThanOrEqual(3 * P + 2 * (2 * S + 6));
    expect(found).toHaveLength(2 * S);
    expect(new Set(found.map((f) => f.message.match(/Model-bridge step "([^"]+)"/)?.[1])).size).toBe(2 * S);
  });

  it("mirrors the bridge's provider-native toolbox ids", () => {
    // red-first-expect: BRIDGE_PROVIDER_NATIVE_TOOLBOX_IDS is not iterable
    const route = readFileSync(path.resolve(__dirname, "..", "..", "..", "..", "src", "app", "api", "llm-bridge", "route.ts"), "utf8");
    const match = /const BUILT_IN_BRIDGE_TOOLS: ReadonlySet<string> = new Set\(\[([^\]]*)\]\);/.exec(route);
    expect(match).not.toBeNull();
    const bridgeIds = [...match![1]!.matchAll(/"([^"]*)"/g)].map((m) => m[1]).sort();
    expect([...BRIDGE_PROVIDER_NATIVE_TOOLBOX_IDS].sort()).toEqual(bridgeIds);
  });
});
