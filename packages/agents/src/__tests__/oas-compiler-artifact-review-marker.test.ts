import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileOasAgentJson,
  __resetRegistryCacheForTests,
  type CompiledAgentOasStep,
} from "../oas-compiler";

// cinatra#1796 (epic #1620 S13) — the OAS-compiler marker propagation.
//
// An InputMessageNode gate whose `metadata.cinatra.artifactReview.targetsInput`
// names the flow input carrying the immutable review targets must compile to a
// step carrying `artifactReviewTargetsInput`. A gate without the marker (or with
// a non-string / empty marker) must leave it UNSET so the gate stays an ordinary
// (byte-identical) HITL gate.

function inputMessageNode(id: string, cinatra: Record<string, unknown>) {
  return {
    component_type: "InputMessageNode",
    id,
    name: id,
    metadata: { cinatra: { requiresApproval: true, ...cinatra } },
    outputs: [{ title: `${id}_out`, type: "string" }],
  };
}

function buildAgentJson(gate: Record<string, unknown>): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "review-flow",
    name: "Review Flow",
    metadata: { cinatra: { type: "flow" } },
    inputs: [
      { title: "reviewTargets", type: "array" },
      { title: "instructions", type: "string", default: "" },
    ],
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: [
      { $component_ref: "startNode" },
      { $component_ref: "approval_gate" },
      { $component_ref: "endNode" },
    ],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "startNode" }, to_node: { $component_ref: "approval_gate" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "approval_gate" }, to_node: { $component_ref: "endNode" } },
    ],
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Setup",
        inputs: [
          { title: "reviewTargets", type: "array" },
          { title: "instructions", type: "string", default: "" },
        ],
        metadata: { cinatra: { required: [], hidden: ["reviewTargets"] } },
      },
      approval_gate: gate,
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas1796-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

async function compileSteps(gate: Record<string, unknown>): Promise<CompiledAgentOasStep[]> {
  const p = path.join(tempDir, "agent.json");
  writeFileSync(p, JSON.stringify(buildAgentJson(gate), null, 2));
  const res = await compileOasAgentJson({
    packageName: "@cinatra-ai/web-research-agent",
    oasSourcePath: p,
    registryPath: path.join(tempDir, "components.json"),
  });
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res.value.approvalPolicy.steps;
}

describe("cinatra#1796 — OAS compiler artifact-review marker propagation", () => {
  it("propagates artifactReview.targetsInput onto the compiled InputMessageNode step", async () => {
    const steps = await compileSteps(
      inputMessageNode("approval_gate", {
        renderer: "@cinatra-ai/web-research-agent:output",
        riskClass: "approval",
        artifactReview: { targetsInput: "reviewTargets" },
      }),
    );
    const gateStep = steps.find((s) => s.nodeType === "input_message")!;
    expect(gateStep).toBeTruthy();
    expect(gateStep.artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("leaves artifactReviewTargetsInput UNSET for a gate without the marker", async () => {
    const steps = await compileSteps(
      inputMessageNode("approval_gate", {
        renderer: "@cinatra-ai/web-research-agent:output",
      }),
    );
    const gateStep = steps.find((s) => s.nodeType === "input_message")!;
    expect(gateStep).toBeTruthy();
    expect(gateStep.artifactReviewTargetsInput).toBeUndefined();
  });

  it("ignores a non-string / empty targetsInput (stays an ordinary gate)", async () => {
    const emptyString = await compileSteps(
      inputMessageNode("approval_gate", { artifactReview: { targetsInput: "" } }),
    );
    expect(emptyString.find((s) => s.nodeType === "input_message")!.artifactReviewTargetsInput).toBeUndefined();

    const nonString = await compileSteps(
      inputMessageNode("approval_gate", { artifactReview: { targetsInput: 42 } }),
    );
    expect(nonString.find((s) => s.nodeType === "input_message")!.artifactReviewTargetsInput).toBeUndefined();
  });
});
