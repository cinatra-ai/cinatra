import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileOasAgentJson, __resetRegistryCacheForTests, type CompiledAgentOasStep } from "../oas-compiler";
import { stepFiresRendererGate } from "../orchestrator-gate-predicate";

// #839 regression. A FlowNode review `gateStep` whose wrapped subflow only ever
// pauses at a context-selector gate (never a real reviewer InputMessageNode) is
// metadata-only: it must be stamped `firesRendererGate:false` so the renderer-
// gate walk skips it. A FlowNode whose subflow DOES carry a reviewer
// InputMessageNode must keep its gateStep. Mirrors blog-pipeline (phantom) vs
// email-outreach (firing) without depending on the extension universe being
// synced into the tree.

function inputMessageNode(id: string, renderer: string) {
  return {
    component_type: "InputMessageNode",
    id,
    name: id,
    metadata: { cinatra: { requiresApproval: true, renderer } },
    outputs: [{ title: `${id}_out`, type: "string" }],
  };
}

// A subflow is just a Flow object holding one InputMessageNode; the compiler
// only reaches into it structurally (subflowFiresNonContextRuntimeGate) — it is
// not deeply flow-validated.
function subflow(id: string, gate: Record<string, unknown>) {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id,
    name: id,
    metadata: { cinatra: { type: "leaf" } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: gate.id },
    nodes: [{ $component_ref: gate.id }],
    control_flow_connections: [],
    $referenced_components: { [gate.id as string]: gate },
  };
}

function flowNode(id: string, name: string, subflowRef: string, pkg: string) {
  return {
    component_type: "FlowNode",
    id,
    name,
    subflow: { $component_ref: subflowRef },
    metadata: {
      cinatra: {
        packageName: pkg,
        gateSteps: [
          { name, description: name, renderer: "@cinatra-ai/reviewer-agent:output", hitlOwnedBy: "self", gateCount: 1 },
        ],
      },
    },
  };
}

function buildAgentJson(): Record<string, unknown> {
  const CTX = "@cinatra-ai/context-selection-agent:context-selector";
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "test-pipeline",
    name: "Test Pipeline",
    metadata: { cinatra: { type: "orchestrator" } },
    inputs: [{ title: "brief", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [
      { $component_ref: "startNode" },
      { $component_ref: "phantom_flow" },
      { $component_ref: "select_gate" },
      { $component_ref: "firing_flow" },
      { $component_ref: "endNode" },
    ],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "startNode" }, to_node: { $component_ref: "phantom_flow" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "phantom_flow" }, to_node: { $component_ref: "select_gate" } },
      { component_type: "ControlFlowEdge", name: "e3", from_node: { $component_ref: "select_gate" }, to_node: { $component_ref: "firing_flow" } },
      { component_type: "ControlFlowEdge", name: "e4", from_node: { $component_ref: "firing_flow" }, to_node: { $component_ref: "endNode" } },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Setup",
        inputs: [{ title: "brief", type: "string" }],
        metadata: { cinatra: { required: ["brief"] } },
      },
      // phantom: subflow only has a context-selector gate → gateStep is phantom
      phantom_flow: flowNode("phantom_flow", "Phantom review", "phantom_subflow", "@test/phantom-child"),
      phantom_subflow: subflow("phantom_subflow", inputMessageNode("ctx-foo-context_select_gate", CTX)),
      // real self InputMessageNode (idea_selection_gate analogue)
      select_gate: {
        component_type: "InputMessageNode",
        id: "select_gate",
        name: "Select item",
        metadata: {
          cinatra: {
            requiresApproval: true,
            renderer: "@cinatra-ai/reviewer-agent:output",
            inputMessageSchema: {
              type: "object",
              "x-renderer": "@cinatra-ai/reviewer-agent:output",
              properties: { selectedIdeaJson: { type: "string" } },
              required: ["selectedIdeaJson"],
            },
          },
        },
        outputs: [{ title: "selectedIdeaJson", type: "string" }],
      },
      // firing: subflow has a real reviewer gate → gateStep is kept
      firing_flow: flowNode("firing_flow", "Firing review", "firing_subflow", "@test/firing-child"),
      firing_subflow: subflow("firing_subflow", inputMessageNode("review_gate", "@test/firing-child:output")),
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;
beforeEach(() => { __resetRegistryCacheForTests(); tempDir = mkdtempSync(path.join(tmpdir(), "oas839-")); });
afterEach(() => { rmSync(tempDir, { recursive: true, force: true }); });

async function compileSteps(): Promise<CompiledAgentOasStep[]> {
  const p = path.join(tempDir, "agent.json");
  writeFileSync(p, JSON.stringify(buildAgentJson(), null, 2));
  const res = await compileOasAgentJson({
    packageName: "@test/pipeline",
    oasSourcePath: p,
    registryPath: path.join(tempDir, "components.json"),
  });
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res.value.approvalPolicy.steps;
}

describe("#839 phantom review gateStep detection", () => {
  it("flags a review gateStep whose subflow only has a context gate", async () => {
    const steps = await compileSteps();
    const phantom = steps.find((s) => s.name === "Phantom review")!;
    expect(phantom).toBeTruthy();
    expect(phantom.firesRendererGate).toBe(false);
  });

  it("keeps a review gateStep whose subflow has a real reviewer gate", async () => {
    const steps = await compileSteps();
    const firing = steps.find((s) => s.name === "Firing review")!;
    expect(firing).toBeTruthy();
    expect(firing.firesRendererGate).not.toBe(false);
  });

  it("leaves the real self InputMessageNode unflagged", async () => {
    const steps = await compileSteps();
    const sel = steps.find((s) => s.name === "Select item")!;
    expect(sel.nodeType).toBe("input_message");
    expect(sel.inputMessageField).toBe("selectedIdeaJson");
    expect(sel.firesRendererGate).not.toBe(false);
  });

  it("renderer-gate walk skips the phantom so the select gate resolves at index 0 with its schema", async () => {
    const steps = await compileSteps();
    const walk = steps.filter(stepFiresRendererGate);
    // Phantom excluded; real self gate + firing child gate remain (order preserved).
    expect(walk.map((s) => s.name)).toEqual(["Select item", "Firing review"]);
    const required = (walk[0].inputMessageSchema as { required?: string[] } | undefined)?.required ?? [];
    expect(required).toContain("selectedIdeaJson");
  });
});
