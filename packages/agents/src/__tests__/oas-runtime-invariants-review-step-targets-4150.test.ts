/**
 * cinatra#4150: a gate marked `metadata.cinatra.artifactReview.targetsInput`
 * whose targets cannot arrive passed every check and failed only in a live run
 * (no artifact review opened). The runtime-invariant scan now refuses it
 * (OAS-RUNTIME-013): the gate must be an InputMessageNode of the root flow, and
 * its targets input must be a start input of the root flow, or a declared input
 * that surfaceGateInputs: true surfaces and that a DataFlowEdge of the root flow
 * feeds from an output of a root-flow node that every control path from the
 * start node passes before the gate.
 *
 * The fleet sweep over every pinned pack is `oas-runtime-invariants.test.ts`
 * (allow-list: `__fixtures__/known-broken-agents.ts`).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";

import { measureReviewStepRule, scanOasForRuntimeInvariantFindings } from "../validate-oas-runtime-invariants";

type Node = Record<string, unknown>;

/** A ControlFlowEdge of the flow. */
const ctl = (from: string, to: string, branch: string | null = null): Node => ({
  component_type: "ControlFlowEdge",
  name: `${from}->${to}`,
  from_node: { $component_ref: from },
  from_branch: branch,
  to_node: { $component_ref: to },
});
/** The control chain start -> each of `keys` in order -> end. */
const chain = (keys: string[]): Node[] => {
  const all = ["start", ...keys, "end"];
  return all.slice(1).map((to, i) => ctl(all[i]!, to));
};

/** A flow whose control edges run start -> each of `top` in order -> end. */
function flow(components: Record<string, Node>, top: string[], outputs: Node[] = []): Node {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "fixture-flow",
    name: "Fixture",
    inputs: [],
    outputs,
    start_node: { $component_ref: "start" },
    nodes: ["start", ...top, "end"].map((k) => ({ $component_ref: k })),
    control_flow_connections: chain(top),
    data_flow_connections: [],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "start", inputs: [] },
      end: { component_type: "EndNode", id: "end", name: "end", outputs },
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

/** An ApiNode that declares the given outputs. */
function producer(id: string, outputs: string[]): Node {
  return {
    component_type: "ApiNode",
    id,
    name: id,
    url: "{{CINATRA_BASE_URL}}/api/fixture",
    http_method: "POST",
    inputs: [],
    outputs: outputs.map((title) => ({ title, type: "string" })),
  };
}

function subflowNode(id: string, inner: Record<string, Node>, extra: Node = {}): Node {
  return { component_type: "FlowNode", id, name: id, subflow: flow(inner, Object.keys(inner)), ...extra };
}

const review = { artifactReview: { targetsInput: "reviewTargets" } };
const surfaced = { ...review, surfaceGateInputs: true };
/** A root-flow DataFlowEdge from `from.out` into `to.input`. */
const edge = (from: string, out: string, to: string, input: string): Node => ({
  component_type: "DataFlowEdge",
  name: `${from}_${to}`,
  source_node: { $component_ref: from },
  source_output: out,
  destination_node: { $component_ref: to },
  destination_input: input,
});
/** A root flow with the producer `make` (declaring `targets`) and the gate `g`, joined by `edges`. */
const fed = (
  gateNode: Node,
  edges: Node[] = [edge("make", "targets", "g", "reviewTargets")],
  make: Node = producer("make", ["targets"]),
): Node => ({
  ...flow({ make, g: gateNode }, ["make", "g"]),
  data_flow_connections: edges,
});
const RULE = "declares metadata.cinatra.artifactReview.targetsInput";
const BYPASSED = 'reaches the gate without passing through "make"';
const NOT_FED = 'no DataFlowEdge of the root flow feeds its input "reviewTargets"';
const codes = (doc: Node, text: string) =>
  scanOasForRuntimeInvariantFindings(doc).filter((f) => f.code === "OAS-RUNTIME-013" && f.message.includes(text));

describe("OAS-RUNTIME-013: a review step gets its targets (cinatra#4150)", () => {
  it("refuses a review gate without surfaceGateInputs: true, top-level and nested", () => {
    const top = flow({ review_post: gate("review_post", review) }, ["review_post"]);
    const found = codes(top, RULE);
    expect(found).toHaveLength(1);
    const [f] = found;
    expect(f?.message).toContain('Gate "review_post"');
    expect(f?.message).toContain("does not set metadata.cinatra.surfaceGateInputs: true");
    expect(f?.severity).toBe("blocker");

    const nested = flow({ outer: subflowNode("outer", { inner_gate: gate("inner_gate", { ...review, surfaceGateInputs: "true" }) }) }, ["outer"]);
    expect(codes(nested, RULE).map((x) => x.message)).toEqual([
      expect.stringContaining('Gate "inner_gate" declares metadata.cinatra.artifactReview.targetsInput but it is not a node of the root flow'),
    ]);
  });

  it("refuses a targets input that is not a declared input, an empty marker and a marker on another node kind", () => {
    const wrongInput = flow({ g: gate("g", { artifactReview: { targetsInput: "other" }, surfaceGateInputs: true }) }, ["g"]);
    expect(codes(wrongInput, '"other" is not one of its declared inputs')).toHaveLength(1);

    const empty = flow({ g: gate("g", { artifactReview: { targetsInput: "" }, surfaceGateInputs: true }) }, ["g"]);
    expect(codes(empty, "the marker does not name an input")).toHaveLength(1);

    const notGate = flow({ a: { ...producer("a", ["targets"]), metadata: { cinatra: review } } }, ["a"]);
    expect(codes(notGate, 'it is a "ApiNode", not an InputMessageNode')).toHaveLength(1);
  });

  // The application falls back to the run's start parameters
  // (resolveDeclaredReviewTargets); they hold the ROOT flow's inputs only.
  it("accepts a targets input that is a start input of the root flow, and refuses one of a nested flow only", () => {
    // A start input is declared by the root flow AND its StartNode (cinatra#4150 round 3).
    const withStart = (doc: Node) => {
      const input = { title: "reviewTargets", type: "array" };
      const refs = { ...(doc.$referenced_components as Record<string, Node>) };
      refs.start = { ...refs.start, inputs: [input] };
      return { ...doc, inputs: [input], $referenced_components: refs };
    };
    expect(codes(withStart(flow({ g: gate("g", review, { inputs: [] }) }, ["g"])), RULE)).toEqual([]);

    const fixture = JSON.parse(readFileSync(path.resolve(__dirname, "../../../../tests/fixtures/review-gate-agent/cinatra-review-fixture/marked-review-gate/cinatra/oas.json"), "utf8"));
    expect(codes(fixture, RULE)).toEqual([]);

    const nestedOnly = flow({ o: subflowNode("o", { g: gate("g", review, { inputs: [] }) }) }, ["o"]);
    const o = (nestedOnly.$referenced_components as Record<string, Node>).o!;
    o.subflow = { ...(o.subflow as Node), inputs: [{ title: "reviewTargets", type: "array" }] };
    expect(codes(nestedOnly, RULE).map((x) => x.message)).toEqual([
      expect.stringContaining("is not a node of the root flow"),
    ]);
  });

  // The compiler carries a nested gate's surfaceGateInputKeys through its
  // FlowNode, never its artifactReviewTargetsInput, and execution routes to
  // the review only on that compiled field: a nested marked gate opens no
  // review on either road.
  it("refuses a marked gate inside a nested flow, whatever road it uses", () => {
    const withStart = (doc: Node) => ({ ...doc, inputs: [{ title: "reviewTargets", type: "array" }] });
    const startRoad = withStart(flow({ o: subflowNode("o", { g: gate("g", review, { inputs: [] }) }) }, ["o"]));
    expect(codes(startRoad, "is not a node of the root flow")).toHaveLength(1);

    const inner = fed(gate("g", surfaced));
    const surfacedRoad = flow({ o: { component_type: "FlowNode", id: "o", name: "o", subflow: inner } }, ["o"]);
    expect(codes(surfacedRoad, "is not a node of the root flow")).toHaveLength(1);
  });

  // The loader renders an input no edge feeds as null, which
  // resolveDeclaredReviewTargets takes as absent.
  it("refuses a surfaced targets input that no DataFlowEdge of the root flow feeds", () => {
    expect(codes(flow({ g: gate("g", surfaced) }, ["g"]), NOT_FED)).toHaveLength(1);
    expect(codes(fed(gate("g", surfaced), [edge("make", "targets", "g", "otherInput")]), NOT_FED)).toHaveLength(1);
    expect(codes(fed(gate("g", surfaced), [edge("make", "targets", "elsewhere", "reviewTargets")]), NOT_FED)).toHaveLength(1);
    expect(codes(fed(gate("g", surfaced), [edge("ghost", "targets", "g", "reviewTargets")]), NOT_FED)).toHaveLength(1);
    const untyped = { ...edge("make", "targets", "g", "reviewTargets"), component_type: undefined };
    expect(codes(fed(gate("g", surfaced), [untyped]), NOT_FED)).toHaveLength(1);
  });

  // pyagentspec joins a DataFlowEdge only between declared ports: an edge whose
  // source does not declare the named output delivers nothing.
  it("refuses an edge whose source declares no outputs, or no output of that name", () => {
    const noOutputs = fed(gate("g", surfaced), undefined, producer("make", []));
    expect(codes(noOutputs, NOT_FED)).toHaveLength(1);

    const otherName = fed(gate("g", surfaced), undefined, producer("make", ["reviewTargetList"]));
    expect(codes(otherName, NOT_FED)).toHaveLength(1);

    const wrongOutputOnEdge = fed(gate("g", surfaced), [edge("make", "target", "g", "reviewTargets")]);
    expect(codes(wrongOutputOnEdge, NOT_FED)).toHaveLength(1);
  });

  it("refuses an edge whose source is not a node of the root flow", () => {
    // A component of the root `$referenced_components` that the root `nodes` do not list.
    const unlisted: Node = {
      ...flow({ g: gate("g", surfaced) }, ["g"]),
      data_flow_connections: [edge("make", "targets", "g", "reviewTargets")],
    };
    (unlisted.$referenced_components as Record<string, Node>).make = producer("make", ["targets"]);
    expect(codes(unlisted, NOT_FED)).toHaveLength(1);

    // A node of a nested flow, named by its key in that flow.
    const nested = {
      ...flow({ o: subflowNode("o", { inner_make: producer("inner_make", ["targets"]) }), g: gate("g", surfaced) }, ["o", "g"]),
      data_flow_connections: [edge("inner_make", "targets", "g", "reviewTargets")],
    };
    expect(codes(nested, NOT_FED)).toHaveLength(1);
  });

  it("accepts a conforming surfaced gate fed from a declared output, and refuses the same gate without the edge", () => {
    expect(codes(fed(gate("g", surfaced)), RULE)).toEqual([]);
    expect(codes(fed(gate("g", surfaced), []), NOT_FED)).toHaveLength(1);
  });

  it("accepts a FlowNode source whose subflow declares the output, and refuses one whose subflow does not", () => {
    const out = [{ title: "targets", type: "string" }];
    const viaSubflow = (subflowOutputs: Node[], extra: Node = {}): Node => {
      const sub = flow({ inner: producer("inner", ["targets"]) }, ["inner"], subflowOutputs);
      return fed(gate("g", surfaced), undefined, { component_type: "FlowNode", id: "make", name: "make", subflow: sub, ...extra });
    };
    expect(codes(viaSubflow(out), RULE)).toEqual([]);
    expect(codes(viaSubflow(out, { outputs: out }), RULE)).toEqual([]);
    expect(codes(viaSubflow([]), NOT_FED)).toHaveLength(1);
    // A port the FlowNode lists but its subflow does not declare gets no value.
    expect(codes(viaSubflow([], { outputs: out }), NOT_FED)).toHaveLength(1);

    // The subflow by $component_ref to a root component.
    const byRef = fed(gate("g", surfaced), undefined, { component_type: "FlowNode", id: "make", name: "make", subflow: { $component_ref: "sub" } });
    (byRef.$referenced_components as Record<string, Node>).sub = flow({ inner: producer("inner", ["targets"]) }, ["inner"], out);
    expect(codes(byRef, RULE)).toEqual([]);
    (byRef.$referenced_components as Record<string, Node>).sub = flow({ inner: producer("inner", ["targets"]) }, ["inner"], []);
    expect(codes(byRef, NOT_FED)).toHaveLength(1);
  });

  it("accepts an edge from the StartNode's inputs, and refuses one from an input the StartNode does not have", () => {
    // The start message fills a StartNode port only for an input the root flow
    // declares too (the rule 004 and 005 share, cinatra#4150 round 3).
    const fromStart = (inputs: Node[], flowInputs: Node[] = inputs): Node => {
      const doc: Node = {
        ...flow({ g: gate("g", surfaced) }, ["g"]),
        inputs: flowInputs,
        data_flow_connections: [edge("start", "targets", "g", "reviewTargets")],
      };
      (doc.$referenced_components as Record<string, Node>).start = { component_type: "StartNode", id: "start", name: "start", inputs };
      return doc;
    };
    expect(codes(fromStart([{ title: "targets", type: "string" }]), RULE)).toEqual([]);
    expect(codes(fromStart([]), NOT_FED)).toHaveLength(1);
    expect(codes(fromStart([{ title: "targets", type: "string" }], []), NOT_FED)).toHaveLength(1);
  });

  it("leaves an unmarked gate alone, and still refuses a marked one beside it", () => {
    const doc = flow({ plain: gate("plain", {}), o: subflowNode("o", { inner: gate("inner", {}) }), g: gate("g", review) }, ["plain", "o", "g"]);
    expect(codes(doc, RULE).map((x) => x.message)).toEqual([expect.stringContaining('Gate "g"')]);
  });

  // The edge alone does not deliver: the loader renders the input from the
  // producer's output only after the producer has run, and execution follows
  // the control edges. The producer must lie on every control path from the
  // start node to the gate.
  describe("the feeding step runs before the gate on every control path", () => {
    const withControl = (control: Node[], extra: Record<string, Node> = {}, top: string[] = ["make", "g"]): Node => {
      const doc = fed(gate("g", surfaced));
      Object.assign(doc.$referenced_components as Record<string, Node>, extra);
      return { ...doc, nodes: ["start", ...top, "end"].map((k) => ({ $component_ref: k })), control_flow_connections: control };
    };

    it("accepts a producer upstream of the gate on the single path", () => {
      expect(codes(withControl(chain(["make", "g"])), RULE)).toEqual([]);
    });

    it("refuses a producer downstream of the gate", () => {
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(withControl(chain(["g", "make"])), BYPASSED)).toHaveLength(1);
    });

    it("refuses a producer the control graph never reaches", () => {
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(withControl(chain(["g"])), BYPASSED)).toHaveLength(1);
    });

    it("refuses a producer on only one of two branches that both reach the gate", () => {
      const branch = { component_type: "BranchingNode", id: "pick", name: "pick", mapping: { a: "a" } };
      const other = producer("other", []);
      const control = [
        ctl("start", "pick"),
        ctl("pick", "make", "a"),
        ctl("pick", "other", "default"),
        ctl("make", "g"),
        ctl("other", "g"),
        ctl("g", "end"),
      ];
      const doc = withControl(control, { pick: branch, other }, ["pick", "make", "other", "g"]);
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(doc, BYPASSED)).toHaveLength(1);
      // With the producer before the branch it runs on both paths.
      const before = withControl(
        [ctl("start", "make"), ctl("make", "pick"), ctl("pick", "other", "a"), ctl("pick", "g", "default"), ctl("other", "g"), ctl("g", "end")],
        { pick: branch, other },
        ["make", "pick", "other", "g"],
      );
      expect(codes(before, RULE)).toEqual([]);
    });

    // A revisited gate pauses on every visit, so the rule asks for dominance:
    // a loop back to the producer before the gate passes; a loop whose first
    // visit of the gate comes before the producer is refused, although later
    // visits would carry targets.
    it("decides a loop by dominance: producer before the first visit passes, after it is refused", () => {
      const loopBefore = withControl([ctl("start", "make"), ctl("make", "g"), ctl("g", "make"), ctl("g", "end")]);
      expect(codes(loopBefore, RULE)).toEqual([]);
      const loopAfter = withControl([ctl("start", "g"), ctl("g", "make"), ctl("make", "g"), ctl("g", "end")]);
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(loopAfter, BYPASSED)).toHaveLength(1);
    });

    it("refuses a gate the start node never reaches, and a flow whose control edges cannot be read", () => {
      const unreachable = withControl([ctl("start", "make"), ctl("make", "end")]);
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(unreachable, "no control path of the root flow leads from its start node to the gate")).toHaveLength(1);
      const unreadable = withControl([...chain(["make", "g"]), { component_type: "ControlFlowEdge", name: "broken", from_node: { $component_ref: "g" } }]);
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(unreadable, "control_flow_connections cannot be read")).toHaveLength(1);
      const untyped = withControl(chain(["make", "g"]).map((e) => ({ ...e, component_type: "Edge" })));
      // red-first-expect: expected [] to have a length of 1 but got +0
      expect(codes(untyped, "control_flow_connections cannot be read")).toHaveLength(1);
    });
  });
});

// cinatra#4150 round 3: the gate must run (both roads), a StartNode feeds only
// a start input of the root flow, and the rule's work is linear in the document.
describe("OAS-RUNTIME-013: the review step runs, gets real start inputs, and is checked in linear time", () => {
  const UNREACHABLE = "no control path of the root flow leads from its start node to the gate, so the gate never runs";
  /** The root flow's start inputs: declared by the flow AND its StartNode. */
  const startInputs = (doc: Node, flowTitles: string[], startTitles: string[] = flowTitles): Node => {
    const refs = { ...(doc.$referenced_components as Record<string, Node>) };
    refs.start = { ...refs.start, inputs: startTitles.map((title) => ({ title, type: "array" })) };
    return { ...doc, inputs: flowTitles.map((title) => ({ title, type: "array" })), $referenced_components: refs };
  };

  it("refuses a start-input gate that the control edges never reach", () => {
    // start -> end; the gate is a root node with no control edge at all.
    const disconnected = startInputs({ ...flow({ g: gate("g", review, { inputs: [] }) }, []), nodes: ["start", "g", "end"].map((k) => ({ $component_ref: k })) }, ["reviewTargets"]);
    expect(codes(disconnected, UNREACHABLE)).toHaveLength(1);
    // The gate only has an outgoing edge.
    const outgoingOnly = { ...disconnected, control_flow_connections: [ctl("start", "end"), ctl("g", "end")] };
    expect(codes(outgoingOnly, UNREACHABLE)).toHaveLength(1);
    // Reached: accepted.
    const reached = startInputs(flow({ g: gate("g", review, { inputs: [] }) }, ["g"]), ["reviewTargets"]);
    expect(codes(reached, RULE)).toEqual([]);
  });

  it("refuses a start-input gate whose control edges cannot be read", () => {
    const doc = startInputs(flow({ g: gate("g", review, { inputs: [] }) }, ["g"]), ["reviewTargets"]);
    expect(codes({ ...doc, control_flow_connections: undefined }, "control_flow_connections cannot be read")).toHaveLength(1);
    expect(codes({ ...doc, start_node: undefined }, "control_flow_connections cannot be read")).toHaveLength(1);
  });

  it("refuses a surfaced, fed gate that the control edges never reach", () => {
    const doc = { ...fed(gate("g", surfaced)), control_flow_connections: [ctl("start", "make"), ctl("make", "end")] };
    expect(codes(doc, UNREACHABLE)).toHaveLength(1);
  });

  it("refuses a marked gate that is the root flow's start node", () => {
    const doc = startInputs(flow({ g: gate("g", review, { inputs: [] }) }, ["g"]), ["reviewTargets"]);
    const asStart = { ...doc, start_node: { $component_ref: "g" }, control_flow_connections: [ctl("g", "start"), ctl("start", "end")] };
    expect(codes(asStart, "it is the root flow's start node")).toHaveLength(1);
  });

  it("takes a start input only when the root flow AND its StartNode declare it", () => {
    const base = flow({ g: gate("g", review, { inputs: [] }) }, ["g"]);
    expect(codes(startInputs(base, ["reviewTargets"]), RULE)).toEqual([]);
    expect(codes(startInputs(base, ["reviewTargets"], []), 'is not a start input of the flow')).toHaveLength(1);
    expect(codes(startInputs(base, [], ["reviewTargets"]), 'is not a start input of the flow')).toHaveLength(1);
  });

  it("refuses a StartNode feeder whose input the root flow does not declare, even with an explicit StartNode output", () => {
    const doc: Node = {
      ...flow({ g: gate("g", surfaced) }, ["g"]),
      data_flow_connections: [edge("start", "targets", "g", "reviewTargets")],
    };
    const port = [{ title: "targets", type: "string" }];
    (doc.$referenced_components as Record<string, Node>).start = { component_type: "StartNode", id: "start", name: "start", inputs: port, outputs: port };
    expect(codes(doc, NOT_FED)).toHaveLength(1);
    expect(codes({ ...doc, inputs: port }, RULE)).toEqual([]);
  });

  /** A flow start -> p0 .. p(n-1) -> gates -> end, each producer feeding each listed gate's targets. */
  function large(producers: number, gates: number): { doc: Node; size: number } {
    const components: Record<string, Node> = {};
    const top: string[] = [];
    const data: Node[] = [];
    for (let i = 0; i < producers; i++) {
      components[`p${i}`] = producer(`p${i}`, ["targets"]);
      top.push(`p${i}`);
    }
    for (let j = 0; j < gates; j++) {
      components[`g${j}`] = gate(`g${j}`, surfaced);
      top.push(`g${j}`);
    }
    // Every producer feeds the first gate; each further gate is fed by one producer.
    for (let i = 0; i < producers; i++) data.push(edge(`p${i}`, "targets", "g0", "reviewTargets"));
    for (let j = 1; j < gates; j++) data.push(edge(`p${j % producers}`, "targets", `g${j}`, "reviewTargets"));
    const doc: Node = { ...flow(components, top), data_flow_connections: data };
    const size = (doc.nodes as Node[]).length + (doc.control_flow_connections as Node[]).length + data.length;
    return { doc, size };
  }

  it("checks 5,000 feeders of one gate in work linear in the document", () => {
    const { doc, size } = large(5000, 1);
    const t0 = performance.now();
    // red-first-expect: measureReviewStepRule is not a function
    const { findings, steps } = measureReviewStepRule(doc);
    const ms = performance.now() - t0;
    expect(findings.filter((f) => f.message.includes(RULE))).toEqual([]);
    expect(steps).toBeLessThanOrEqual(12 * size);
    expect(ms).toBeLessThan(2000);
  });

  it("checks 5,000 gates, and 5,000 feeders that do not run before their gate, in work linear in the document", () => {
    // red-first-expect: measureReviewStepRule is not a function
    const { doc, size } = large(2, 5000);
    const { findings, steps } = measureReviewStepRule(doc);
    expect(findings.filter((f) => f.message.includes(RULE))).toEqual([]);
    expect(steps).toBeLessThanOrEqual(12 * size);

    // The producers come after the gate: every feeder is bypassed, none dominates.
    const { doc: late, size: lateSize } = large(5000, 1);
    const order = ["g0", ...Array.from({ length: 5000 }, (_, i) => `p${i}`)];
    const reordered = { ...late, control_flow_connections: chain(order) };
    const t0 = performance.now();
    const result = measureReviewStepRule(reordered);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(result.findings.filter((f) => f.message.includes("reaches the gate without passing through"))).toHaveLength(1);
    expect(result.steps).toBeLessThanOrEqual(12 * lateSize);
  });

  it("keeps a ParallelFlowNode feeder's port work within the document's size when its subflows are shared", () => {
    // 300 ParallelFlowNodes share the same 300 subflows of 300 outputs each; each feeds its own gate.
    const k = 300;
    const outputs = Array.from({ length: k }, (_, i) => ({ title: `o${i}`, type: "string" }));
    const components: Record<string, Node> = {};
    const top: string[] = [];
    const data: Node[] = [];
    const refs: Record<string, Node> = {};
    for (let s = 0; s < k; s++) refs[`sub${s}`] = { component_type: "Flow", id: `sub${s}`, name: `sub${s}`, outputs };
    for (let i = 0; i < k; i++) {
      components[`par${i}`] = { component_type: "ParallelFlowNode", id: `par${i}`, name: `par${i}`, subflows: Array.from({ length: k }, (_, s) => ({ $component_ref: `sub${s}` })) };
      components[`g${i}`] = gate(`g${i}`, surfaced);
      top.push(`par${i}`, `g${i}`);
      data.push(edge(`par${i}`, "o0", `g${i}`, "reviewTargets"));
    }
    const doc: Node = { ...flow(components, top), data_flow_connections: data };
    Object.assign(doc.$referenced_components as Record<string, Node>, refs);
    const size = (doc.nodes as Node[]).length + (doc.control_flow_connections as Node[]).length + data.length + k * k + k * k;
    // red-first-expect: measureReviewStepRule is not a function
    const { findings, steps } = measureReviewStepRule(doc);
    expect(steps).toBeLessThanOrEqual(12 * size);
    // The first ParallelFlowNode resolves; the budget refuses, never accepts, the rest.
    expect(findings.filter((f) => f.message.includes('Gate "g0"'))).toEqual([]);
    expect(findings.filter((f) => f.message.includes("take more work to resolve")).length).toBeGreaterThan(0);
  });
});
