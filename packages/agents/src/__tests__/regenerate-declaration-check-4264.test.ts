/**
 * cinatra#4264 slice A1: the compile-time graph check of a
 * `cinatra.lifecycle.regenerate` declaration (pure).
 *
 * A Regenerate reruns one producing `step` with the reviewer's note in one
 * declared text input (`noteInput`) and files the result through
 * `artifactNode`. The check makes sure the declaration names real top-level
 * nodes of an allowed kind, that the note port is one canonical string port,
 * and that the note reaches it over one dedicated edge from the StartNode.
 *
 * Run: cd packages/agents && pnpm exec vitest run src/__tests__/regenerate-declaration-check-4264.test.ts
 */
import { describe, expect, it } from "vitest";

import { checkRegenerateDeclaration } from "../verdaccio/package-contract";

type Rec = Record<string, unknown>;
const str = (title: string): Rec => ({ title, type: "string" });
const ref = (id: string): Rec => ({ $component_ref: id });
const edge = (src: string, out: string, dst: string, input: string): Rec => ({
  component_type: "DataFlowEdge",
  name: `${src}_${out}_${dst}_${input}`,
  source_node: ref(src),
  source_output: out,
  destination_node: ref(dst),
  destination_input: input,
});

/** start(idea, note) -> step(idea, note) -> file(content) -> end. */
function flow(stepKind = "ApiNode", fileKind = "ApiNode"): Rec {
  const step: Rec = { component_type: stepKind, id: "step", name: "Step", inputs: [str("idea"), str("note")] };
  if (stepKind === "FlowNode") {
    delete step.inputs;
    step.subflow = ref("sub");
  }
  return {
    component_type: "Flow",
    inputs: [str("idea"), str("note")],
    start_node: ref("start"),
    nodes: [ref("start"), ref("step"), ref("file"), ref("end")],
    data_flow_connections: [
      edge("start", "idea", "step", "idea"),
      edge("start", "note", "step", "note"),
      edge("step", "content", "file", "content"),
    ],
    $referenced_components: {
      start: { component_type: "StartNode", id: "start", name: "Start", inputs: [str("idea"), str("note")] },
      step,
      file: { component_type: fileKind, id: "file", name: "File", inputs: [str("content")] },
      end: { component_type: "EndNode", id: "end", name: "End", outputs: [] },
      sub: {
        component_type: "Flow",
        start_node: ref("sub_start"),
        $referenced_components: {
          sub_start: { component_type: "StartNode", id: "sub_start", name: "S", inputs: [str("idea"), str("note")] },
        },
      },
    },
  };
}
const ENTRY = { artifactNode: "file", step: "step", noteInput: "note" };
const refs = (oas: Rec) => oas.$referenced_components as Record<string, Rec>;
const edges = (oas: Rec) => oas.data_flow_connections as Rec[];

function refused(oas: Rec, entries: unknown = [ENTRY]): string {
  const result = checkRegenerateDeclaration(oas, entries);
  expect(result.ok).toBe(false);
  const error = (result as { error: string }).error;
  expect(error).toMatch(/^REGENERATE_DECLARATION_INVALID: /);
  return error;
}

describe("cinatra#4264 A1: checkRegenerateDeclaration accepts", () => {
  it.each(["ApiNode", "AgentNode", "FlowNode"])("a %s step filed by an ApiNode", (kind) => {
    expect(checkRegenerateDeclaration(flow(kind), [ENTRY])).toEqual({ ok: true });
  });

  it("a step that files its own artifact (artifactNode === step)", () => {
    const oas = flow();
    expect(
      checkRegenerateDeclaration(oas, [{ artifactNode: "step", step: "step", noteInput: "note" }]),
    ).toEqual({ ok: true });
  });

  it("T15: two entries that share one step with different note inputs, and ':' in ids", () => {
    const oas = flow();
    const r = refs(oas);
    r["file:2"] = { component_type: "ApiNode", id: "file:2", name: "F2", inputs: [str("content")] };
    (oas.nodes as Rec[]).push(ref("file:2"));
    (r.step.inputs as Rec[]).push(str("imageNote"));
    (oas.inputs as Rec[]).push(str("imageNote"));
    (r.start.inputs as Rec[]).push(str("imageNote"));
    edges(oas).push(edge("step", "image", "file:2", "content"), edge("start", "imageNote", "step", "imageNote"));
    expect(
      checkRegenerateDeclaration(oas, [ENTRY, { artifactNode: "file:2", step: "step", noteInput: "imageNote" }]),
    ).toEqual({ ok: true });
  });

  it("a 129-character node id (no length cap on ids)", () => {
    const long = "n".repeat(129);
    const oas = flow();
    const r = refs(oas);
    r[long] = { ...r.file, id: long };
    (oas.nodes as Rec[]).push(ref(long));
    edges(oas).push(edge("step", "content", long, "content"));
    expect(checkRegenerateDeclaration(oas, [{ ...ENTRY, artifactNode: long }])).toEqual({ ok: true });
  });
});

describe("cinatra#4264 A1: checkRegenerateDeclaration refuses", () => {
  it("an entry that fails the schema piece", () => {
    refused(flow(), [{ ...ENTRY, extra: 1 }]);
    refused(flow(), [ENTRY, { ...ENTRY, step: "step" }]);
    refused(flow(), [{ ...ENTRY, noteInput: "lifecycleRepairRequest" }]);
    refused(flow(), []);
  });

  it.each(["StartNode", "EndNode", "InputMessageNode", "OutputMessageNode", "TriggerWaitNode", "ParallelFlowNode", "MysteryNode"])(
    "a %s as step and as filing node",
    (kind) => {
      expect(refused(flow(kind))).toMatch(/step must be/);
      expect(refused(flow("ApiNode", kind))).toMatch(/artifactNode must be an ApiNode/);
    },
  );

  it("T15: an AgentNode filing node", () => {
    expect(refused(flow("ApiNode", "AgentNode"))).toContain("artifactNode must be an ApiNode");
  });

  it("a node that is not a top-level node", () => {
    refused(flow(), [{ ...ENTRY, step: "ghost" }]);
    refused(flow(), [{ ...ENTRY, artifactNode: "sub_start" }]);
  });

  it("no data edge from step to artifactNode", () => {
    const oas = flow();
    oas.data_flow_connections = edges(oas).filter((e) => (e.destination_node as Rec).$component_ref !== "file");
    expect(refused(oas)).toMatch(/no data edge/);
  });

  it("a non-canonical note port: schema.type, a non-string type, a duplicate title, a missing port", () => {
    for (const port of [{ title: "note", schema: { type: "string" } }, { title: "note", type: "integer" }]) {
      const oas = flow();
      refs(oas).step.inputs = [str("idea"), port];
      refused(oas);
    }
    const dup = flow();
    (refs(dup).step.inputs as Rec[]).push(str("note"));
    expect(refused(dup)).toMatch(/two ports/);
    const none = flow();
    refs(none).step.inputs = [str("idea")];
    refused(none);
  });

  it("a FlowNode with a missing, non-Flow or start-less subflow, or own inputs that disagree", () => {
    const missing = flow("FlowNode");
    delete refs(missing).step.subflow;
    expect(refused(missing)).toMatch(/subflow/);
    const nonFlow = flow("FlowNode");
    refs(nonFlow).sub.component_type = "ApiNode";
    expect(refused(nonFlow)).toMatch(/subflow/);
    const startless = flow("FlowNode");
    delete refs(startless).sub.start_node;
    expect(refused(startless)).toMatch(/subflow/);
    const subPort = flow("FlowNode");
    ((refs(subPort).sub.$referenced_components as Record<string, Rec>).sub_start).inputs = [str("idea")];
    refused(subPort);
    const own = flow("FlowNode");
    refs(own).step.inputs = [str("idea"), { title: "note", type: "object" }];
    refused(own);
  });

  it("zero or two edges into the note port", () => {
    const zero = flow();
    zero.data_flow_connections = edges(zero).filter((e) => e.destination_input !== "note");
    expect(refused(zero)).toMatch(/exactly one edge/);
    const two = flow();
    edges(two).push(edge("start", "idea", "step", "note"));
    expect(refused(two)).toMatch(/exactly one edge/);
  });

  it("a note edge that starts at a node other than the StartNode", () => {
    const oas = flow();
    oas.data_flow_connections = edges(oas).map((e) =>
      e.destination_input === "note" ? edge("file", "content", "step", "note") : e,
    );
    expect(refused(oas)).toMatch(/StartNode/);
  });

  it("a start output that is not exposed, not a root input, or not a string", () => {
    const hidden = flow();
    refs(hidden).start.outputs = [str("idea")];
    refused(hidden);
    const notRoot = flow();
    notRoot.inputs = [str("idea")];
    refused(notRoot);
    const notString = flow();
    notString.inputs = [str("idea"), { title: "note", type: "object" }];
    refused(notString);
  });

  it("a start note output that feeds another input too (fan-out)", () => {
    const oas = flow();
    (refs(oas).file.inputs as Rec[]).push(str("note"));
    edges(oas).push(edge("start", "note", "file", "note"));
    expect(refused(oas)).toMatch(/feeds another input/);
  });
});
