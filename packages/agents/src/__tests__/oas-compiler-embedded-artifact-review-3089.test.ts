import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileOasAgentJson, __resetRegistryCacheForTests, type CompiledAgentOasStep } from "../oas-compiler";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";

// cinatra#3089 — an artifact-review gate inside an EMBEDDED child flow.
//
// The drafting flow's `approval_gate` carries
// `metadata.cinatra.artifactReview.targetsInput`, so the host opens one review
// per filed body. Run on its own, the gate is a top-level InputMessageNode and
// its compiled step carries `artifactReviewTargetsInput`. Embedded in the
// outreach flow as a FlowNode with one gateStep, the step was built from the
// gateStep alone: no marker, and the gateStep's renderer (one the child no
// longer declares). The shape below mirrors the outreach flow: a recipients
// child with two gateSteps, a drafts child whose one gate is marked, and a
// sender child without gateSteps.

const SCHEMA = {
  type: "object",
  properties: { userResponse: { type: "string", title: "Drafts review note" } },
  required: ["userResponse"],
};

function gate(id: string, cinatra: Record<string, unknown>, inputs: string[] = []) {
  return {
    component_type: "InputMessageNode",
    id,
    name: id,
    metadata: { cinatra: { requiresApproval: true, ...cinatra } },
    outputs: [{ title: "userResponse", type: "string" }],
    inputs: inputs.map((title) => ({ title, type: "string", default: "[]" })),
  };
}

function markedGate(id = "drafts-approval_gate", extra: Record<string, unknown> = {}) {
  return gate(
    id,
    {
      surfaceGateInputs: true,
      inputMessageSchema: SCHEMA,
      artifactReview: { targetsInput: "reviewTargets" },
      ...extra,
    },
    ["reviewTargets"],
  );
}

function subflow(id: string, gates: Array<Record<string, unknown>>) {
  const refs: Record<string, unknown> = {};
  for (const g of gates) refs[g.id as string] = g;
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id,
    name: id,
    metadata: { cinatra: { type: "leaf" } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: gates[0]!.id },
    nodes: gates.map((g) => ({ $component_ref: g.id })),
    control_flow_connections: [],
    $referenced_components: refs,
  };
}

type GateStep = Record<string, unknown>;
function flowNode(id: string, subflowRef: string, pkg: string, gateSteps?: unknown[]) {
  return {
    component_type: "FlowNode",
    id,
    name: id,
    subflow: { $component_ref: subflowRef },
    metadata: { cinatra: { packageName: pkg, ...(gateSteps ? { gateSteps } : {}) } },
  };
}

const OLD_RENDERER = "@cinatra-ai/email-drafting-agent:email-drafts-review";
const DRAFTS_STEP: GateStep = {
  name: "Review drafts",
  description: "Review and approve initial email drafts before they are sent.",
  renderer: OLD_RENDERER,
  hitlOwnedBy: "self",
  gateCount: 1,
};

type Parts = {
  draftsGates?: Array<Record<string, unknown>>;
  draftsGateSteps?: unknown[] | undefined;
  startInputs?: string[];
};

function buildAgentJson(parts: Parts = {}): Record<string, unknown> {
  const draftsGates = parts.draftsGates ?? [markedGate()];
  const draftsGateSteps = "draftsGateSteps" in parts ? parts.draftsGateSteps : [DRAFTS_STEP];
  const startInputs = (parts.startInputs ?? ["senderName"]).map((title) => ({ title, type: "string", default: "" }));
  const order = ["startNode", "recipients_flow", "drafts_flow", "sender_flow", "endNode"];
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "outreach",
    name: "Outreach",
    metadata: { cinatra: { type: "orchestrator" } },
    inputs: startInputs,
    outputs: [],
    start_node: { $component_ref: "startNode" },
    nodes: order.map((id) => ({ $component_ref: id })),
    control_flow_connections: order.slice(1).map((to, i) => ({
      component_type: "ControlFlowEdge",
      name: `e${i}`,
      from_node: { $component_ref: order[i] },
      to_node: { $component_ref: to },
    })),
    $referenced_components: {
      startNode: {
        component_type: "StartNode",
        id: "startNode",
        name: "Setup",
        inputs: startInputs,
        metadata: { cinatra: { required: [] } },
      },
      recipients_flow: flowNode("recipients_flow", "recipients-subflow", "@test/recipients", [
        { name: "Account scope", renderer: "@test/outreach:list-picker", hitlOwnedBy: "self", gateCount: 1 },
        { name: "Review recipients", renderer: "@test/recipients:review", hitlOwnedBy: "self", gateCount: 1 },
      ]),
      "recipients-subflow": subflow("recipients-subflow", [
        gate("recipients-scope_gate", {}),
        gate("recipients-review_gate", { renderer: "@test/recipients:review", surfaceGateInputs: true }, ["confirmedRecipients"]),
      ]),
      drafts_flow: flowNode("drafts_flow", "drafts-subflow", "@test/drafting", draftsGateSteps),
      "drafts-subflow": subflow("drafts-subflow", draftsGates),
      sender_flow: flowNode("sender_flow", "sender-subflow", "@test/delivery"),
      "sender-subflow": subflow("sender-subflow", [
        gate("sender-approval_gate", { renderer: "@test/delivery:send-confirmation", surfaceGateInputs: true }, ["campaignId"]),
      ]),
      endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "oas3089embed-"));
});
afterEach(() => rmSync(tempDir, { recursive: true, force: true }));

async function compile(parts?: Parts) {
  const p = path.join(tempDir, "agent.json");
  writeFileSync(p, JSON.stringify(buildAgentJson(parts), null, 2));
  return compileOasAgentJson({
    packageName: "@test/outreach",
    oasSourcePath: p,
    registryPath: path.join(tempDir, "components.json"),
  });
}

async function compileSteps(parts?: Parts): Promise<CompiledAgentOasStep[]> {
  const res = await compile(parts);
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  return res.value.approvalPolicy.steps;
}

async function compileError(parts: Parts): Promise<string> {
  const res = await compile(parts);
  // red-first-expect: expected true to be false
  expect(res.ok).toBe(false);
  return res.ok ? "" : res.error;
}

const byName = (steps: CompiledAgentOasStep[], name: string) => steps.find((s) => s.name === name)!;

describe("cinatra#3089 — an embedded child's artifact-review gate", () => {
  it("the FlowNode gateStep of a marked child gate carries the marker, the child gate's renderer and its schema", async () => {
    const steps = await compileSteps();
    const drafts = byName(steps, "Review drafts");
    expect(drafts).toBeTruthy();
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(drafts.artifactReviewTargetsInput).toBe("reviewTargets");
    // The renderer the child's own gate resolves to (the standalone flow's), not
    // the gateStep's renderer, which the child no longer declares.
    expect(drafts.xRenderer).toBe(SCHEMA_FIELD_FALLBACK_RENDERER_ID);
    expect(drafts.inputMessageSchema).toEqual(SCHEMA);
    expect(drafts.gateCount).toBe(1);
    expect(drafts.hitlOwnedBy).toBe("self");
    expect(drafts.description).toBe(DRAFTS_STEP.description);
  });

  it("a renderer the marked child gate declares is the step's renderer", async () => {
    const steps = await compileSteps({
      draftsGates: [markedGate("drafts-approval_gate", { renderer: "@test/drafting:own-review" })],
    });
    const drafts = byName(steps, "Review drafts");
    // red-first-expect: to be '@test/drafting:own-review'
    expect(drafts.xRenderer).toBe("@test/drafting:own-review");
  });

  it("the other steps of the flow compile as before", async () => {
    const steps = await compileSteps();
    const scope = byName(steps, "Account scope");
    const recipients = byName(steps, "Review recipients");
    const sender = byName(steps, "sender_flow");
    expect(scope.xRenderer).toBe("@test/outreach:list-picker");
    expect(recipients.xRenderer).toBe("@test/recipients:review");
    for (const s of [scope, recipients, sender]) {
      expect(s.artifactReviewTargetsInput).toBeUndefined();
      expect(s.inputMessageSchema).toBeUndefined();
    }
  });

  it("a child gate without the marker compiles as before", async () => {
    const steps = await compileSteps({
      draftsGates: [gate("drafts-approval_gate", { surfaceGateInputs: true, inputMessageSchema: SCHEMA }, ["reviewTargets"])],
    });
    const drafts = byName(steps, "Review drafts");
    expect(drafts.artifactReviewTargetsInput).toBeUndefined();
    expect(drafts.xRenderer).toBe(OLD_RENDERER);
    expect(drafts.inputMessageSchema).toBeUndefined();
  });

  it("an unusable marker (empty or not a string) is ignored, as on a top-level gate", async () => {
    for (const targetsInput of ["", 42]) {
      const steps = await compileSteps({
        draftsGates: [markedGate("drafts-approval_gate", { artifactReview: { targetsInput } })],
      });
      const drafts = byName(steps, "Review drafts");
      expect(drafts.artifactReviewTargetsInput).toBeUndefined();
      expect(drafts.xRenderer).toBe(OLD_RENDERER);
    }
  });

  it("refuses a marked gate that shares its subflow with another gate", async () => {
    const error = await compileError({
      draftsGates: [markedGate(), gate("drafts-other_gate", {})],
    });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
    expect(error).toContain('"drafts_flow"');
  });

  it("refuses two gateSteps for one marked gate", async () => {
    const error = await compileError({ draftsGateSteps: [DRAFTS_STEP, { ...DRAFTS_STEP, name: "Second" }] });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("refuses a marked gate whose FlowNode declares no gateStep", async () => {
    const error = await compileError({ draftsGateSteps: undefined });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("refuses a gateStep that spans more than one pause", async () => {
    const error = await compileError({ draftsGateSteps: [{ ...DRAFTS_STEP, gateCount: 2 }] });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("refuses a marked gate that is not a reviewer pause", async () => {
    const error = await compileError({
      draftsGates: [markedGate("drafts-approval_gate", { requiresApproval: false })],
    });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_NOT_A_PAUSE");
  });

  it("refuses a marked gate that does not hand the named input to the host", async () => {
    const notSurfaced = await compileError({
      draftsGates: [markedGate("drafts-approval_gate", { surfaceGateInputs: "yes" })],
    });
    expect(notSurfaced).toContain("ARTIFACT_REVIEW_GATE_INPUT_NOT_SURFACED");
    const notAnInput = await compileError({
      draftsGates: [markedGate("drafts-approval_gate", { artifactReview: { targetsInput: "otherTargets" } })],
    });
    expect(notAnInput).toContain("ARTIFACT_REVIEW_GATE_INPUT_NOT_SURFACED");
  });

  it("refuses a flow whose own run input has the name of the marked input", async () => {
    const error = await compileError({ startInputs: ["senderName", "reviewTargets"] });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_INPUT_SHADOWED");
  });

  // The context decision reads the renderer the compiled step carries: the
  // field's inputRenderers entry first, then the gate's own renderer.
  it("a marked gate whose own renderer is a context renderer but whose field renderer is a normal one compiles with the marker", async () => {
    const steps = await compileSteps({
      draftsGates: [
        markedGate("drafts-approval_gate", {
          renderer: "@test/drafting:context-selector",
          inputRenderers: { userResponse: "@test/drafting:own-review" },
        }),
      ],
    });
    const drafts = byName(steps, "Review drafts");
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(drafts.artifactReviewTargetsInput).toBe("reviewTargets");
    expect(drafts.xRenderer).toBe("@test/drafting:own-review");
    expect(drafts.firesRendererGate).toBeUndefined();
  });

  it("a marked gate whose field renderer is a context renderer is refused, whatever its own renderer is", async () => {
    const error = await compileError({
      draftsGates: [
        markedGate("drafts-approval_gate", {
          renderer: "@test/drafting:own-review",
          inputRenderers: { userResponse: "@test/drafting:context-selector" },
        }),
      ],
    });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_NOT_A_PAUSE");
    expect(error).toContain('"drafts_flow"');
  });

  it("refuses a marked gate whose gateStep entry is not an object", async () => {
    for (const entry of [null, "Review drafts", 7, true, []]) {
      const error = await compileError({ draftsGateSteps: [entry] });
      expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
      expect(error).toContain('"drafts_flow"');
    }
  });

  it("a marked gate with an empty gateStep object compiles with the marker", async () => {
    const steps = await compileSteps({ draftsGateSteps: [{}] });
    const drafts = byName(steps, "drafts_flow");
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(drafts.artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("an unmarked child with a null or string gateStep entry compiles as on main", async () => {
    for (const entry of [null, "Review drafts"]) {
      const steps = await compileSteps({
        draftsGates: [gate("drafts-approval_gate", { surfaceGateInputs: true, inputMessageSchema: SCHEMA }, ["reviewTargets"])],
        draftsGateSteps: [entry],
      });
      for (const s of steps) expect(s.artifactReviewTargetsInput).toBeUndefined();
    }
  });
});
