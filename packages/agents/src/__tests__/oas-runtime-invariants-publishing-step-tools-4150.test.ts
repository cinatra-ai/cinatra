/**
 * cinatra#4150: a step of a `publishes: true` node that the run would refuse is
 * refused by the runtime-invariant scan (OAS-RUNTIME-015).
 *
 *   - A model-bridge step that can call tools but declares none in
 *     `metadata.cinatra.tools`: every outward call is refused after Publish
 *     (`action_decision_step_undeclared`, run-action-decision-consumption.ts).
 *   - Any bridge or passthrough step in a holder the run does not read steps
 *     from (an agent, its tools, a tool's flow): every call is refused
 *     (`step_tool_step_unknown`, agent-run-serde.ts), whatever it declares or is
 *     offered.
 *   - A passthrough step in a holder the run reads is served: it declares
 *     nothing, and the passthrough serves its tool under the claimed decision.
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`
 * (allow-list: `__fixtures__/known-broken-agents.ts`).
 */
import { describe, it, expect } from "vitest";

import { checkPublishingCallRoutes } from "../oas-compiler";
import {
  everyApiNodeUnder,
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

function passthrough(id: string): Node {
  return {
    component_type: "ApiNode",
    id,
    name: id,
    url: PASSTHROUGH,
    http_method: "POST",
    data: { tool: "email_test_delivery_run_send", input: {}, agent_run_id: "{{cinatra_run_id}}" },
    inputs: [],
    outputs: [],
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

const RULE = "declares no tools in metadata.cinatra.tools";
const UNREAD = "sits in a holder the run does not read steps from";
const rule015 = (doc: Node, text: string) =>
  scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === "OAS-RUNTIME-015" && f.message.includes(text));
const all015 = (doc: Node) => scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === "OAS-RUNTIME-015");

describe("a model step of a publishing node declares its tools", () => {
  it("refuses a publishing model step with no or an empty tools list, and accepts a declared one", () => {
    const none = flow({ publish: bridge("publish", { publishes: true }) }, ["publish"]);
    const [f] = rule015(none, RULE);
    expect(f?.message).toContain('Model-bridge step "publish" is part of the publishing node "publish"');
    expect(f?.location).toBe("$.$referenced_components.publish");

    const empty = flow({ publish: bridge("publish", { publishes: true, tools: [] }) }, ["publish"]);
    expect(rule015(empty, RULE)).toHaveLength(1);

    const declared = flow({ p: bridge("p", { publishes: true, tools: ["wordpress_pages_create"] }) }, ["p"]);
    expect(all015(declared)).toEqual([]);
  });

  it("refuses a model step nested in a publishing FlowNode, and accepts it declared", () => {
    const doc = flow({ pub: subflowNode("pub", { call_site: bridge("call_site") }, { publishes: true }) }, ["pub"]);
    expect(rule015(doc, RULE).map((x) => x.message)).toEqual([
      expect.stringContaining('Model-bridge step "call_site" is part of the publishing node "pub"'),
    ]);
    const nestedDeclared = flow({ pub: subflowNode("pub", { s: bridge("s", { tools: ["x_post"] }) }, { publishes: true }) }, ["pub"]);
    expect(all015(nestedDeclared)).toEqual([]);
  });

  it("refuses an undeclared publishing model step only when it can call tools and only in a publishing node", () => {
    expect(rule015(flow({ p: bridge("p", { publishes: true }) }, ["p"]), RULE)).toHaveLength(1);
    // The bridge offers no tool to a step whose toolbox_ids is an empty list.
    expect(all015(flow({ p: bridge("p", { publishes: true }, { toolbox_ids: [] }) }, ["p"]))).toEqual([]);
    expect(all015(flow({ p: bridge("p", { publishes: false }) }, ["p"]))).toEqual([]);
    expect(all015(flow({ p: bridge("p") }, ["p"]))).toEqual([]);
  });

  // cinatra#4150 round 3, finding 2: the passthrough is a publishing route the
  // compiler permits. Its step declares nothing (the key is read on model-bridge
  // steps only), and the route serves its tool directly under the claimed
  // publish decision, never through the outward action consumer. What the run
  // requires of it is that it finds the step: a passthrough publisher in a
  // holder the run does not read is refused.
  it("accepts a passthrough publisher the run reads, and refuses one it does not", () => {
    const read = flow({ p: { ...passthrough("p"), metadata: { cinatra: { publishes: true } } } }, ["p"]);
    expect(hasApiNodeStep(read, "p")).toBe(true);
    expect(findStepToolDeclaration(read, "p")).toEqual({ kind: "undeclared" });
    expect(all015(read)).toEqual([]);
    const nested = flow({ pub: subflowNode("pub", { send: passthrough("send") }, { publishes: true }) }, ["pub"]);
    expect(all015(nested)).toEqual([]);

    const unread = flow({
      pub: {
        component_type: "AgentNode", id: "pub", name: "pub", metadata: { cinatra: { publishes: true } },
        agent: { component_type: "Agent", id: "h", name: "h",
          tools: [{ component_type: "FlowTool", id: "t", name: "t", flow: flow({ send: passthrough("send") }, ["send"]) }] },
      },
    }, ["pub"]);
    expect(hasApiNodeStep(unread, "send")).toBe(false);
    expect(rule015(unread, UNREAD).map((x) => x.message)).toEqual([
      expect.stringContaining('Step "send" can run inside the publishing node "pub"'),
    ]);
  });

  // The run reads a step's declaration (findStepToolDeclaration), proves the
  // step (hasApiNodeStep) and ties it to a publishing node
  // (findPublishingAncestor) by id. A step the publishing node runs in any
  // other holder (an agent's tool flow, which the compiler's publishing
  // traversal still walks) is refused at run time whatever it declares or is
  // offered (cinatra#4150 round 3, finding 1).
  const helper = (inner: Node, single = false): Node => ({
    component_type: "Agent",
    id: "helper",
    name: "helper",
    tools: single
      ? { component_type: "FlowTool", id: "t", name: "t", flow: flow({ s: inner }, ["s"]) }
      : [{ component_type: "FlowTool", id: "t", name: "t", flow: flow({ s: inner }, ["s"]) }],
  });
  const agentNode = (agent: unknown): Node =>
    ({ component_type: "AgentNode", id: "pub", name: "pub", agent, metadata: { cinatra: { publishes: true } } });
  const unread: Record<string, (inner: Node) => Node> = {
    "AgentNode.agent > Agent.tools list > tool flow": (inner) => flow({ pub: agentNode(helper(inner)) }, ["pub"]),
    "Agent.tools as a single object": (inner) => flow({ pub: agentNode(helper(inner, true)) }, ["pub"]),
    "AgentNode.agent by $component_ref to a root component": (inner) => {
      const doc = flow({ pub: agentNode({ $component_ref: "helper" }) }, ["pub"]);
      (doc.$referenced_components as Record<string, Node>).helper = helper(inner);
      return doc;
    },
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

  for (const [shape, build] of Object.entries(read)) {
    it(`reads a model step in ${shape} as the run does`, () => {
      const id = shape === "the node itself" ? "pub" : "deep";
      expect(hasApiNodeStep(build(step()), id)).toBe(true);
      expect(findPublishingAncestor(build(step()), id)).toEqual({ kind: "resolved", nodeId: "pub" });
      expect(rule015(build(step()), RULE).map((x) => x.message)).toEqual([
        expect.stringContaining(`Model-bridge step "${id}" is part of the publishing node "pub"`),
      ]);
      const declared = build(step({ tools: ["x_post"] }));
      expect(findStepToolDeclaration(declared, id)).toEqual({ kind: "declared", tools: ["x_post"] });
      expect(all015(declared)).toEqual([]);
      expect(all015(build({ ...passthrough("deep") }))).toEqual([]);
    });
  }

  for (const [shape, build] of Object.entries(unread)) {
    it(`refuses a step through ${shape}, whatever it declares or is offered`, () => {
      expect(hasApiNodeStep(build(step({ tools: ["x_post"] })), "deep")).toBe(false);
      const docs = [
        build(step()),
        build(step({ tools: ["x_post"] })),
        build(bridge("deep", undefined, { toolbox_ids: [] })),
        build(passthrough("deep")),
      ];
      for (const doc of docs) {
        expect(rule015(doc, UNREAD).map((x) => x.message)).toEqual([
          expect.stringContaining('Step "deep" can run inside the publishing node "pub"'),
        ]);
        expect(rule015(doc, RULE)).toEqual([]);
      }
      // The compiler's publishing traversal reaches the step: it is a call of the node.
      const outward = { ...bridge("deep"), url: "https://example.test/hook" };
      expect(checkPublishingCallRoutes(build(outward), ["pub"], {})).toEqual({
        ok: false,
        error: expect.stringContaining('node "deep" of publishing step "pub"'),
      });
    });
  }
});

// cinatra#4150 round 4, finding 1: the walk of a publishing node's components
// ends on any input. Each document is run through the whole scan as well, so a
// walk that does not end fails the test file by its timeout.
describe("the walk of a publishing node's components ends on cycles", () => {
  const pubOver = (subflow: unknown, extra: Record<string, unknown>): Node => {
    const doc = flow({ pub: { component_type: "FlowNode", id: "pub", name: "pub", subflow, metadata: { cinatra: { publishes: true } } } }, ["pub"]);
    Object.assign(doc.$referenced_components as Record<string, unknown>, extra);
    return doc;
  };
  const shapes: Record<string, () => Node> = {
    "a list that references itself through a $component_ref": () =>
      pubOver({ $component_ref: "loop" }, { loop: [bridge("deep"), { $component_ref: "loop" }] }),
    "a component that references itself": () =>
      pubOver({ $component_ref: "a" }, { a: { component_type: "Flow", id: "a", name: "a", nodes: [bridge("deep"), { $component_ref: "a" }] } }),
    "two components that reference each other": () =>
      pubOver({ $component_ref: "a" }, {
        a: { component_type: "Flow", id: "a", name: "a", nodes: [bridge("deep"), { $component_ref: "b" }] },
        b: { component_type: "Flow", id: "b", name: "b", nodes: [{ $component_ref: "a" }] },
      }),
  };

  for (const [shape, build] of Object.entries(shapes)) {
    it(`ends on ${shape}, and finds its step once`, () => {
      // red-first-expect: everyApiNodeUnder is not a function
      const doc = build();
      const rootRefs = doc.$referenced_components as Record<string, unknown>;
      expect(everyApiNodeUnder(rootRefs.pub, rootRefs).map((n) => n.id)).toEqual(["deep"]);
      expect(Array.isArray(scanOasForRuntimeInvariantFindings(doc))).toBe(true);
    });
  }

  it("ends on a list and a component that contain themselves", () => {
    // red-first-expect: everyApiNodeUnder is not a function
    const list: unknown[] = [bridge("deep")];
    list.push(list);
    expect(everyApiNodeUnder(list, {}).map((n) => n.id)).toEqual(["deep"]);
    const holder: Record<string, unknown> = { component_type: "Flow", id: "h", nodes: [bridge("deep")] };
    holder.self = holder;
    (holder.nodes as unknown[]).push(holder, { $component_ref: "h" });
    expect(everyApiNodeUnder(holder, { h: holder }).map((n) => n.id)).toEqual(["deep"]);
  });
});

// cinatra#4150 round 4, finding 2: the consumer ties each outward call of a
// step to the decision of its ONE top-level node (findPublishingAncestor) and
// refuses the call when there is none, more than one, or a node that does not
// publish (readDecisionNode, run-action-decision-consumption.ts).
describe("a publishing model step resolves to one publishing node", () => {
  const AMBIGUOUS = "action_decision_node_ambiguous";
  const shared = (keys: string[]): Node => {
    const nodes = Object.fromEntries(keys.map((k) => [k, {
      component_type: "FlowNode", id: k, name: k, subflow: { $component_ref: "sub" }, metadata: { cinatra: { publishes: true } },
    } as Node]));
    const doc = flow(nodes, keys);
    (doc.$referenced_components as Record<string, Node>).sub = flow({ s: bridge("s", { tools: ["x_post"] }) }, ["s"]);
    return doc;
  };

  it("refuses one model step shared beneath two publishing FlowNodes, naming both", () => {
    const doc = shared(["pub_a", "pub_b"]);
    expect(findPublishingAncestor(doc, "s")).toEqual({ kind: "ambiguous", nodeIds: ["pub_a", "pub_b"] });
    const found = rule015(doc, AMBIGUOUS);
    expect(found.map((f) => f.message)).toEqual([
      expect.stringContaining('the top-level nodes "pub_a" and "pub_b" all hold it'),
    ]);
    expect(found[0]?.message).toContain('Model-bridge step "s" can run inside the publishing node "pub_a"');
  });

  it("accepts the same model step beneath one publishing FlowNode", () => {
    const doc = shared(["pub_a"]);
    expect(findPublishingAncestor(doc, "s")).toEqual({ kind: "resolved", nodeId: "pub_a" });
    expect(all015(doc)).toEqual([]);
  });

  it("refuses a step a publishing node shares with a node that does not publish", () => {
    const doc = shared(["pub_a", "plain"]);
    ((doc.$referenced_components as Record<string, Node>).plain as Node).metadata = { cinatra: { publishes: false } };
    expect(rule015(doc, AMBIGUOUS).map((f) => f.message)).toEqual([
      expect.stringContaining('the top-level nodes "pub_a" and "plain" all hold it'),
    ]);
  });

  it("refuses a step whose one publishing node has a key the run cannot record a decision under", () => {
    const key = "p".repeat(513);
    expect(rule015(shared([key]), "is not one the run can record a decision under")).toHaveLength(1);
  });

  it("leaves a passthrough step and a step offered no tools to the routes that serve them", () => {
    const doc = shared(["pub_a", "pub_b"]);
    (doc.$referenced_components as Record<string, Node>).sub = flow({ s: passthrough("s") }, ["s"]);
    expect(all015(doc)).toEqual([]);
    (doc.$referenced_components as Record<string, Node>).sub = flow({ s: bridge("s", undefined, { toolbox_ids: [] }) }, ["s"]);
    expect(all015(doc)).toEqual([]);
  });
});
