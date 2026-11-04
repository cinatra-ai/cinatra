import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileOasAgentJson,
  __resetRegistryCacheForTests,
  type CompiledAgentOasStep,
} from "../oas-compiler";

// ---------------------------------------------------------------------------
// cinatra#4457 — the compiled gate step names the keys of a value-surfacing
// gate's message.
//
// The WayFlow loader writes the message of a gate whose
// `metadata.cinatra.surfaceGateInputs` is strictly `true` as one JSON object
// with a key for each declared input title (docker/wayflow/agent_loader.py).
// The compiler carries those titles onto the step as `surfaceGateInputKeys`, so
// that the host never fills one of them from a run input. The flag is read with
// the loader's own strict identity: any other value leaves the step as it was.
// ---------------------------------------------------------------------------

const PACKAGE = "@cinatra-ai/list-curator-agent";
const RENDERER = `${PACKAGE}:list-review`;

const DECLARED_INPUTS: unknown[] = [
  { title: "candidateMembers", type: "array" },
  { title: "listName", type: "string" },
];

function buildGateOas(
  cinatraFlag: Record<string, unknown>,
  gateInputs: unknown[] = DECLARED_INPUTS,
): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "list-gate-flow",
    name: "List Gate Flow",
    metadata: { cinatra: { type: "orchestrator", packageName: PACKAGE } },
    inputs: [{ title: "listName", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "list_gate" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "start" }, to_node: { $component_ref: "list_gate" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "list_gate" }, to_node: { $component_ref: "end" } },
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Setup",
        inputs: [{ title: "listName", type: "string" }],
        metadata: { cinatra: { required: ["listName"] } },
      },
      list_gate: {
        component_type: "InputMessageNode",
        id: "list_gate",
        name: "Approve the list",
        metadata: {
          cinatra: {
            riskClass: "approval",
            requiresApproval: true,
            renderer: RENDERER,
            ...cinatraFlag,
          },
        },
        inputs: gateInputs,
        outputs: [{ title: "userResponse", type: "string" }],
      },
      end: { component_type: "EndNode", id: "end", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "surface-gate-keys-4457-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function compileGateStep(
  cinatraFlag: Record<string, unknown>,
  gateInputs?: unknown[],
): Promise<CompiledAgentOasStep> {
  const oasPath = path.join(tempDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildGateOas(cinatraFlag, gateInputs), null, 2));
  const regPath = path.join(tempDir, "components.json");
  writeFileSync(regPath, JSON.stringify({ components: {} }));
  const res = await compileOasAgentJson({
    packageName: PACKAGE,
    oasSourcePath: oasPath,
    registryPath: regPath,
    executionProvider: "wayflow",
  });
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const gate = res.value.approvalPolicy.steps.find((s) => s.nodeType === "input_message");
  expect(gate, "no input_message gate compiled").toBeTruthy();
  return gate!;
}

describe("cinatra#4457 — compiled surfaceGateInputKeys", () => {
  it("a gate with surfaceGateInputs === true lists its declared input titles", async () => {
    const step = await compileGateStep({ surfaceGateInputs: true });
    expect(step.surfaceGateInputKeys).toEqual(["candidateMembers", "listName"]);
    expect(step.xRenderer).toBe(RENDERER);
  });

  it.each([
    ["absent", {}],
    ["false", { surfaceGateInputs: false }],
    ["the string 'true'", { surfaceGateInputs: "true" }],
    ["the number 1", { surfaceGateInputs: 1 }],
  ])("a gate whose flag is %s carries no keys (strict identity, as the loader reads it)", async (_label, flag) => {
    const step = await compileGateStep(flag);
    expect(step.surfaceGateInputKeys).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(step, "surfaceGateInputKeys")).toBe(false);
  });

  it("a flagged gate lists only its usable titles: a non-string, an empty title or an input without one is left out", async () => {
    const step = await compileGateStep({ surfaceGateInputs: true }, [
      { title: "candidateMembers", type: "array" },
      { title: "", type: "string" },
      { title: 5, type: "number" },
      { title: null, type: "string" },
      { title: ["listName"], type: "string" },
      { title: { length: 2 }, type: "string" },
      { id: "untitled", type: "string" },
      { title: "listName", type: "string" },
    ]);
    expect(step.surfaceGateInputKeys).toEqual(["candidateMembers", "listName"]);
  });

  it.each([
    ["no declared input", []],
    ["only unusable titles", [{ title: "", type: "string" }, { title: 5, type: "number" }]],
  ])("a flagged gate with %s carries no keys (the field is not written)", async (_label, inputs) => {
    const step = await compileGateStep({ surfaceGateInputs: true }, inputs);
    expect(Object.prototype.hasOwnProperty.call(step, "surfaceGateInputKeys")).toBe(false);
  });
});
