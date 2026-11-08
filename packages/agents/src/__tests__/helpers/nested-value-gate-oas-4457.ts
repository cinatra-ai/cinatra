import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compileOasAgentJson,
  __resetRegistryCacheForTests,
  type CompiledAgentOasStep,
} from "../../oas-compiler";

// ---------------------------------------------------------------------------
// cinatra#4457 — a neutral fixture: a root flow whose FlowNode wraps an INLINED
// subflow that holds a value-surfacing gate (`surfaceGateInputs: true`). The
// subflow sits in the root `$referenced_components` and its gate in the
// subflow's own `$referenced_components`, as a composed flow is written. The
// root start input `campaignId` has the name of one of the gate's keys.
//
// The compiler test and the host test both compile this fixture with the real
// compiler, so the host test drives the steps the compiler writes.
// ---------------------------------------------------------------------------

export const NESTED_PACKAGE = "@test/nested-gate-flow";
export const NESTED_RENDERER = `${NESTED_PACKAGE}:review`;
export const NESTED_GATE_KEYS = ["campaignId", "reviewBundle"];
export const SECOND_GATE_KEYS = ["reviewBundle", "reviewNote"];
export const GATE_STEP_NAMES = ["Review", "Confirm"];
export const PLAIN_STEP_NAME = "Review flow";
/** As `flag`: the nested gate carries no `surfaceGateInputs` key at all. */
export const NO_FLAG = Symbol("no surfaceGateInputs key");

export type NestedGateOptions = {
  /** The nested gates' `surfaceGateInputs` value (default true); NO_FLAG leaves the key out. */
  flag?: unknown;
  /** true: the FlowNode declares no gateSteps (the plain FlowNode step). */
  plain?: boolean;
  /** How many gateSteps the FlowNode declares (1 or 2). */
  gateStepCount?: 1 | 2;
  /** true: the subflow holds a second flagged gate (SECOND_GATE_KEYS). */
  secondGate?: boolean;
  /** false: the FlowNode's subflow ref names no component of the document. */
  inlined?: boolean;
};

function gate(id: string, keys: string[], flag: unknown) {
  return {
    component_type: "InputMessageNode",
    id,
    name: id,
    metadata: {
      cinatra: {
        requiresApproval: true,
        riskClass: "approval",
        renderer: NESTED_RENDERER,
        ...(flag === NO_FLAG ? {} : { surfaceGateInputs: flag }),
      },
    },
    inputs: keys.map((title) => ({ title, type: "string" })),
    outputs: [{ title: "userResponse", type: "string" }],
  };
}

export function buildNestedGateOas(opts: NestedGateOptions = {}): Record<string, unknown> {
  const flag = Object.prototype.hasOwnProperty.call(opts, "flag") ? opts.flag : true;
  const gateIds = ["review_gate", ...(opts.secondGate ? ["confirm_gate"] : [])];
  const subRefs: Record<string, unknown> = {
    "sub-start": {
      component_type: "StartNode",
      id: "sub-start",
      name: "Start",
      inputs: [{ title: "campaignId", type: "string" }],
    },
    review_gate: gate("review_gate", NESTED_GATE_KEYS, flag),
    ...(opts.secondGate ? { confirm_gate: gate("confirm_gate", SECOND_GATE_KEYS, flag) } : {}),
    "sub-end": { component_type: "EndNode", id: "sub-end", name: "End", outputs: [] },
  };
  const subOrder = ["sub-start", ...gateIds, "sub-end"];
  const subflow = {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "review_subflow",
    name: "Review subflow",
    metadata: { cinatra: { type: "leaf" } },
    inputs: [{ title: "campaignId", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "sub-start" },
    nodes: subOrder.map((id) => ({ $component_ref: id })),
    control_flow_connections: subOrder.slice(1).map((id, i) => ({
      component_type: "ControlFlowEdge",
      name: `s${i + 1}`,
      from_node: { $component_ref: subOrder[i] },
      to_node: { $component_ref: id },
    })),
    data_flow_connections: [],
    $referenced_components: subRefs,
  };
  const gateSteps = GATE_STEP_NAMES.slice(0, opts.gateStepCount ?? 1).map((name) => ({
    name,
    description: name,
    renderer: NESTED_RENDERER,
    hitlOwnedBy: "self",
    gateCount: 1,
  }));
  const flowNode = {
    component_type: "FlowNode",
    id: "review_flow",
    name: PLAIN_STEP_NAME,
    subflow: { $component_ref: opts.inlined === false ? "external_subflow" : "review_subflow" },
    metadata: {
      cinatra: opts.plain
        ? { renderer: NESTED_RENDERER, hitlOwnedBy: "self" }
        : { gateSteps },
    },
  };
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "nested-gate-flow",
    name: "Nested Gate Flow",
    metadata: { cinatra: { type: "orchestrator", packageName: NESTED_PACKAGE } },
    inputs: [{ title: "campaignId", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "review_flow" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "start" }, to_node: { $component_ref: "review_flow" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "review_flow" }, to_node: { $component_ref: "end" } },
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Setup",
        inputs: [{ title: "campaignId", type: "string" }],
        metadata: { cinatra: { required: ["campaignId"] } },
      },
      review_flow: flowNode,
      review_subflow: subflow,
      end: { component_type: "EndNode", id: "end", name: "End", outputs: [] },
    },
  };
}

/** Compile the fixture with the real compiler; the approval policy's steps. */
export async function compileNestedGateSteps(
  opts: NestedGateOptions = {},
): Promise<CompiledAgentOasStep[]> {
  __resetRegistryCacheForTests();
  const dir = mkdtempSync(path.join(tmpdir(), "nested-value-gate-4457-"));
  try {
    const oasPath = path.join(dir, "oas.json");
    writeFileSync(oasPath, JSON.stringify(buildNestedGateOas(opts), null, 2));
    const regPath = path.join(dir, "components.json");
    writeFileSync(regPath, JSON.stringify({ components: {} }));
    const res = await compileOasAgentJson({
      packageName: NESTED_PACKAGE,
      oasSourcePath: oasPath,
      registryPath: regPath,
      executionProvider: "wayflow",
    });
    if (!res.ok) {
      throw new Error(`the nested-gate fixture did not compile: ${(res as { error?: string }).error}`);
    }
    return res.value.approvalPolicy.steps;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
