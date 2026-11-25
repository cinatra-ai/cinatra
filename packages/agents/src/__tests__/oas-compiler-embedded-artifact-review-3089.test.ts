import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { compileOasAgentJson, __resetRegistryCacheForTests, type CompiledAgentOasStep } from "../oas-compiler";
import { SCHEMA_FIELD_FALLBACK_RENDERER_ID } from "../agent-builder-ids";
import embeddedDrafting from "./fixtures/email-drafting-embedded-3089.json";

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

// The gates run one after the other (an edge joins each to the next). A gate in
// `unreachable` is serialized in the subflow and listed in its nodes, but no
// control edge leads to it, so it never executes. When a reachable gate carries
// a marker, the subflow starts with a filing step (`<id>-file`) whose output
// feeds the input that marker names: the child produces its own targets.
function targetsOf(g: Record<string, unknown>): string | undefined {
  const t = (g.metadata as { cinatra?: { artifactReview?: { targetsInput?: unknown } } } | undefined)?.cinatra?.artifactReview?.targetsInput;
  return typeof t === "string" && t.length > 0 ? t : undefined;
}
function subflow(id: string, gates: Array<Record<string, unknown>>, unreachable: Array<Record<string, unknown>> = []) {
  const marked = gates.filter((g) => targetsOf(g) !== undefined);
  const file = {
    component_type: "ApiNode",
    id: `${id}-file`,
    name: `${id}-file`,
    url: "http://localhost/file",
    http_method: "POST",
    inputs: [],
    outputs: [...new Set(marked.map((g) => targetsOf(g)!))].map((title) => ({ title, type: "string" })),
  };
  const chain = marked.length > 0 ? [file, ...gates] : gates;
  const refs: Record<string, unknown> = {};
  for (const g of [...chain, ...unreachable]) refs[g.id as string] = g;
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id,
    name: id,
    metadata: { cinatra: { type: "leaf" } },
    inputs: [],
    outputs: [],
    start_node: { $component_ref: chain[0]!.id },
    nodes: [...chain, ...unreachable].map((g) => ({ $component_ref: g.id })),
    control_flow_connections: chain.slice(1).map((g, i) => ({
      component_type: "ControlFlowEdge",
      name: `s${i}`,
      from_node: { $component_ref: chain[i]!.id },
      to_node: { $component_ref: g.id },
    })),
    data_flow_connections: marked.map((g) => ({
      component_type: "DataFlowEdge",
      name: `file_to_${g.id as string}`,
      source_node: { $component_ref: file.id },
      source_output: targetsOf(g),
      destination_node: { $component_ref: g.id },
      destination_input: targetsOf(g),
    })),
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
  draftsUnreachable?: Array<Record<string, unknown>>;
  // A whole flow document in place of the drafts child, and whether the FlowNode
  // carries it inline (`subflow` is the flow itself) or by reference.
  draftsFlow?: Record<string, unknown>;
  draftsInline?: boolean;
  // Extra components of the whole flow's $referenced_components.
  extraRefs?: Record<string, unknown>;
  // Data edges of the whole (parent) flow.
  parentEdges?: Array<Record<string, unknown>>;
  draftsGateSteps?: unknown[] | undefined;
  senderGateSteps?: unknown[];
  startInputs?: string[];
};

function buildAgentJson(parts: Parts = {}): Record<string, unknown> {
  const draftsGates = parts.draftsGates ?? [markedGate()];
  const draftsGateSteps = "draftsGateSteps" in parts ? parts.draftsGateSteps : [DRAFTS_STEP];
  const draftsFlowDoc = parts.draftsFlow ?? subflow("drafts-subflow", draftsGates, parts.draftsUnreachable);
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
    ...(parts.parentEdges ? { data_flow_connections: parts.parentEdges } : {}),
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
      drafts_flow: (() => {
        const fn = flowNode("drafts_flow", "drafts-subflow", "@test/drafting", draftsGateSteps);
        if (parts.draftsInline) (fn as Record<string, unknown>).subflow = draftsFlowDoc;
        return fn;
      })(),
      ...(parts.draftsInline ? {} : { "drafts-subflow": draftsFlowDoc }),
      ...(parts.extraRefs ?? {}),
      sender_flow: flowNode("sender_flow", "sender-subflow", "@test/delivery", parts.senderGateSteps),
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

  it("a marked gate that no control edge reaches is ignored: the step compiles as on main, without the marker", async () => {
    const steps = await compileSteps({
      draftsGates: [gate("drafts-approval_gate", { surfaceGateInputs: true, inputMessageSchema: SCHEMA }, ["reviewTargets"])],
      draftsUnreachable: [markedGate("drafts-unused_gate")],
    });
    const drafts = byName(steps, "Review drafts");
    expect(drafts.artifactReviewTargetsInput).toBeUndefined();
    expect(drafts.xRenderer).toBe(OLD_RENDERER);
    expect(drafts.inputMessageSchema).toBeUndefined();
  });

  it("an unmarked gate that no control edge reaches does not stop the reachable marked gate from carrying its marker", async () => {
    const steps = await compileSteps({
      draftsUnreachable: [gate("drafts-unused_gate", {})],
    });
    const drafts = byName(steps, "Review drafts");
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(drafts.artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("a marked gate that no control edge reaches is not refused for the gateStep shape either", async () => {
    const steps = await compileSteps({
      draftsGates: [gate("drafts-approval_gate", {})],
      draftsUnreachable: [markedGate("drafts-unused_gate")],
      draftsGateSteps: [DRAFTS_STEP, { ...DRAFTS_STEP, name: "Second" }],
    });
    for (const s of steps) expect(s.artifactReviewTargetsInput).toBeUndefined();
  });

  it("refuses a marked gate whose renderer is the bare context-selector alias, set on the gate or on its field", async () => {
    for (const cinatra of [
      { renderer: "context-selector" },
      { renderer: "@test/drafting:own-review", inputRenderers: { userResponse: "context-selector" } },
    ]) {
      const error = await compileError({ draftsGates: [markedGate("drafts-approval_gate", cinatra)] });
      expect(error).toContain("ARTIFACT_REVIEW_GATE_NOT_A_PAUSE");
    }
  });

  it("a gate with the bare context-selector alias takes no renderer slot, as one with the scoped id takes none", async () => {
    for (const renderer of ["context-selector", "@test/context:context-selector"]) {
      const steps = await compileSteps({
        draftsGates: [gate("drafts-approval_gate", { renderer, surfaceGateInputs: true }, ["reviewTargets"])],
      });
      // red-first-expect: expected undefined to be false
      expect(byName(steps, "Review drafts").firesRendererGate).toBe(false);
    }
  });

  // ----- the reader, for every shape of a serialized child flow -----

  it("a gate whose output title is a name an object inherits still resolves its renderer from the gate, never from the prototype", async () => {
    for (const title of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      const g = markedGate("drafts-approval_gate", { renderer: "@test/drafting:own-review", inputRenderers: {} });
      (g as Record<string, unknown>).outputs = [{ title, type: "string" }];
      const steps = await compileSteps({ draftsGates: [g] });
      const drafts = byName(steps, "Review drafts");
      expect(drafts.artifactReviewTargetsInput).toBe("reviewTargets");
      // red-first-expect: expected undefined to be 'reviewTargets'
      expect(drafts.xRenderer).toBe("@test/drafting:own-review");
    }
  });

  it("a top-level gate whose output title is an inherited name takes the renderer of the gate", async () => {
    const g = gate("only_gate", { renderer: "@test/own:renderer", inputRenderers: {} });
    (g as Record<string, unknown>).outputs = [{ title: "constructor", type: "string" }];
    const doc = {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id: "top",
      name: "Top",
      metadata: { cinatra: { type: "orchestrator" } },
      inputs: [],
      outputs: [],
      start_node: { $component_ref: "only_gate" },
      nodes: [{ $component_ref: "only_gate" }, { $component_ref: "endNode" }],
      control_flow_connections: [
        { component_type: "ControlFlowEdge", name: "e", from_node: { $component_ref: "only_gate" }, to_node: { $component_ref: "endNode" } },
      ],
      $referenced_components: { only_gate: g, endNode: { component_type: "EndNode", id: "endNode", name: "End", outputs: [] } },
    };
    const p = path.join(tempDir, "top.json");
    writeFileSync(p, JSON.stringify(doc));
    const res = await compileOasAgentJson({ packageName: "@test/top", oasSourcePath: p, registryPath: path.join(tempDir, "components.json") });
    expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    // red-first-expect: to be '@test/own:renderer'
    expect(res.value.approvalPolicy.steps.find((s) => s.name === "only_gate")!.xRenderer).toBe("@test/own:renderer");
  });

  it("a marked gate with odd renderer, schema or output shapes is carried or refused, never a crash", async () => {
    const shapes: Array<Record<string, unknown>> = [
      { renderer: 5 },
      { renderer: { id: "x" } },
      { inputRenderers: "abc" },
      { inputRenderers: ["x"] },
      { inputRenderers: { userResponse: 7 } },
      { inputMessageSchema: "abc" },
      { inputMessageSchema: ["a"] },
    ];
    for (const extra of shapes) {
      const res = await compile({ draftsGates: [markedGate("drafts-approval_gate", extra)] });
      expect(res.ok, JSON.stringify(extra)).toBe(true);
      if (!res.ok) continue;
      const drafts = byName(res.value.approvalPolicy.steps, "Review drafts");
      // red-first-expect: expected undefined to be 'reviewTargets'
      expect(drafts.artifactReviewTargetsInput, JSON.stringify(extra)).toBe("reviewTargets");
      expect(typeof drafts.xRenderer, JSON.stringify(extra)).toBe("string");
      expect(drafts.inputMessageSchema && typeof drafts.inputMessageSchema === "object" && !Array.isArray(drafts.inputMessageSchema), JSON.stringify(extra)).toBe(true);
    }
    for (const outputs of ["abc", [null], [{ title: 5 }], [{}]]) {
      const g = markedGate();
      (g as Record<string, unknown>).outputs = outputs;
      const res = await compile({ draftsGates: [g] });
      expect(res.ok, JSON.stringify(outputs)).toBe(true);
    }
  });

  // A child nested `depth` levels inside the drafts child, the gates at the bottom.
  function nestedDraftsFlow(depth: number, bottomGates: Array<Record<string, unknown>>): Record<string, unknown> {
    let inner: Record<string, unknown> = subflow("level-bottom", bottomGates);
    for (let i = depth - 1; i >= 0; i--) {
      const id = `level-${i}`;
      inner = {
        agentspec_version: "26.1.0",
        component_type: "Flow",
        id,
        name: id,
        metadata: { cinatra: { type: "leaf" } },
        inputs: [],
        outputs: [],
        start_node: { $component_ref: `node-${i}` },
        nodes: [{ $component_ref: `node-${i}` }],
        control_flow_connections: [],
        $referenced_components: {
          [`node-${i}`]: { component_type: "FlowNode", id: `node-${i}`, name: `node-${i}`, subflow: { $component_ref: `child-${i}` } },
          [`child-${i}`]: inner,
        },
      };
    }
    return inner;
  }

  it("a marked gate nested nine levels or more inside the child is carried, at any depth", async () => {
    for (const depth of [9, 30]) {
      const steps = await compileSteps({ draftsFlow: nestedDraftsFlow(depth, [markedGate()]) });
      const drafts = byName(steps, "Review drafts");
      // red-first-expect: expected undefined to be 'reviewTargets'
      expect(drafts.artifactReviewTargetsInput, `depth ${depth}`).toBe("reviewTargets");
    }
  });

  it("a deeply nested child with an unmarked gate compiles without a marker", async () => {
    const steps = await compileSteps({ draftsFlow: nestedDraftsFlow(12, [gate("drafts-approval_gate", {})]) });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBeUndefined();
  });

  it("a cyclic reference between child flows ends: a marked gate in it is refused, an unmarked one compiles", async () => {
    const cyc = (gates: Array<Record<string, unknown>>) => {
      const doc = subflow("drafts-subflow", gates) as Record<string, unknown>;
      (doc.$referenced_components as Record<string, unknown>)["again"] = { component_type: "FlowNode", id: "again", name: "again", subflow: { $component_ref: "drafts-subflow" } };
      (doc.nodes as unknown[]).push({ $component_ref: "again" });
      (doc.control_flow_connections as unknown[]).push({
        component_type: "ControlFlowEdge",
        name: "loop",
        from_node: { $component_ref: gates[0]!.id },
        to_node: { $component_ref: "again" },
      });
      return doc;
    };
    const error = await compileError({ draftsFlow: cyc([markedGate()]) });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
    const steps = await compileSteps({ draftsFlow: cyc([gate("drafts-approval_gate", {})]) });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBeUndefined();
  });

  it("an inline subflow is read as a referenced one is: its marked gate is carried", async () => {
    const steps = await compileSteps({ draftsInline: true });
    const drafts = byName(steps, "Review drafts");
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(drafts.artifactReviewTargetsInput).toBe("reviewTargets");
    expect(drafts.inputMessageSchema).toEqual(SCHEMA);
    expect(drafts.surfaceGateInputKeys).toEqual(["reviewTargets"]);
  });

  it("an inline subflow's unreachable marked gate is ignored", async () => {
    const steps = await compileSteps({
      draftsInline: true,
      draftsGates: [gate("drafts-approval_gate", { surfaceGateInputs: true }, ["reviewTargets"])],
      draftsUnreachable: [markedGate("drafts-unused_gate")],
    });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBeUndefined();
  });

  it("an inline subflow with two reachable gates, one marked, is refused", async () => {
    const error = await compileError({ draftsInline: true, draftsGates: [markedGate(), gate("drafts-other_gate", {})] });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("a marked gate that is the only gate of a parallel branch of the child is carried", async () => {
    const doc = subflow("drafts-subflow", [gate("drafts-start_gate", {})]) as Record<string, unknown>;
    const refs = doc.$referenced_components as Record<string, unknown>;
    delete refs["drafts-start_gate"];
    refs["par"] = { component_type: "ParallelFlowNode", id: "par", name: "par", subflows: [subflow("branch", [markedGate()])] };
    doc.nodes = [{ $component_ref: "par" }];
    doc.start_node = { $component_ref: "par" };
    const steps = await compileSteps({ draftsFlow: doc });
    // red-first-expect: expected undefined to be 'reviewTargets'
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("a marked gate inside a parallel branch next to another reachable gate is refused", async () => {
    const branch = subflow("branch", [markedGate()]);
    const doc = subflow("drafts-subflow", [gate("drafts-first_gate", {})]) as Record<string, unknown>;
    (doc.$referenced_components as Record<string, unknown>)["par"] = { component_type: "ParallelFlowNode", id: "par", name: "par", subflows: [branch] };
    (doc.nodes as unknown[]).push({ $component_ref: "par" });
    (doc.control_flow_connections as unknown[]).push({
      component_type: "ControlFlowEdge",
      name: "p",
      from_node: { $component_ref: "drafts-first_gate" },
      to_node: { $component_ref: "par" },
    });
    // The branch gate and the first gate are two reachable gates: refused, not dropped.
    const error = await compileError({ draftsFlow: doc });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("a child flow with no readable start that holds a marked gate is refused", async () => {
    const doc = subflow("drafts-subflow", [markedGate()]) as Record<string, unknown>;
    delete doc.start_node;
    const error = await compileError({ draftsFlow: doc });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  // ----- provenance: the targets input is the child's own -----

  const dataEdge = (from: string, out: string, to: string, input: string) => ({
    component_type: "DataFlowEdge",
    name: `${from}_${out}_to_${to}_${input}`,
    source_node: { $component_ref: from },
    source_output: out,
    destination_node: { $component_ref: to },
    destination_input: input,
  });
  const ctl = (from: string, to: string, branch?: string) => ({
    component_type: "ControlFlowEdge",
    name: `${from}_${to}${branch ? `_${branch}` : ""}`,
    from_node: { $component_ref: from },
    to_node: { $component_ref: to },
    ...(branch ? { from_branch: branch } : {}),
  });
  const startNode = (id: string, titles: string[]) => ({
    component_type: "StartNode",
    id,
    name: id,
    inputs: titles.map((title) => ({ title, type: "string", default: "[]" })),
    outputs: titles.map((title) => ({ title, type: "string", default: "[]" })),
  });
  const mintNode = (id: string) => ({
    component_type: "ApiNode",
    id,
    name: id,
    url: "http://localhost/mint",
    http_method: "POST",
    inputs: [],
    outputs: [{ title: "reviewTargets", type: "string" }],
  });
  const endNode = (id: string, titles: string[] = []) => ({
    component_type: "EndNode",
    id,
    name: id,
    inputs: titles.map((title) => ({ title, type: "string" })),
    outputs: titles.map((title) => ({ title, type: "string" })),
  });
  function flowDoc(
    id: string,
    start: string,
    comps: Array<Record<string, unknown>>,
    control: Array<Record<string, unknown>>,
    data: Array<Record<string, unknown>> = [],
  ): Record<string, unknown> {
    const refs: Record<string, unknown> = {};
    for (const c of comps) refs[c.id as string] = c;
    return {
      agentspec_version: "26.1.0",
      component_type: "Flow",
      id,
      name: id,
      metadata: { cinatra: { type: "leaf" } },
      inputs: [],
      outputs: [],
      start_node: { $component_ref: start },
      nodes: comps.map((c) => ({ $component_ref: c.id })),
      control_flow_connections: control,
      data_flow_connections: data,
      $referenced_components: refs,
    };
  }
  const G = "drafts-approval_gate";
  const CALLER = "ARTIFACT_REVIEW_GATE_INPUT_FROM_CALLER";

  it("a marked gate whose targets input is fed by a node of the child is carried", async () => {
    const doc = flowDoc("drafts-subflow", "cs", [startNode("cs", ["campaignId"]), mintNode("mint"), markedGate(), endNode("ce")],
      [ctl("cs", "mint"), ctl("mint", G), ctl(G, "ce")], [dataEdge("mint", "reviewTargets", G, "reviewTargets")]);
    const steps = await compileSteps({ draftsFlow: doc });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("refuses a marked gate whose targets input is fed from the child's start, whatever its name there", async () => {
    for (const startOut of ["reviewTargets", "pickedByCaller"]) {
      const doc = flowDoc("drafts-subflow", "cs", [startNode("cs", [startOut]), markedGate(), endNode("ce")],
        [ctl("cs", G), ctl(G, "ce")], [dataEdge("cs", startOut, G, "reviewTargets")]);
      const error = await compileError({ draftsFlow: doc });
      expect(error).toContain(CALLER);
      expect(error).toContain('"drafts_flow"');
    }
  });

  it("refuses a targets input that reaches the gate from the child's start through a nested flow", async () => {
    const passThrough = (fed: "start" | "mint") =>
      flowDoc("inner", "is", [startNode("is", ["reviewTargets"]), mintNode("imint"), endNode("ie", ["reviewTargets"])],
        [ctl("is", "imint"), ctl("imint", "ie")],
        [dataEdge(fed === "start" ? "is" : "imint", "reviewTargets", "ie", "reviewTargets")]);
    const outer = (fed: "start" | "mint") =>
      flowDoc("drafts-subflow", "cs", [
        startNode("cs", ["reviewTargets"]),
        { component_type: "FlowNode", id: "inner_node", name: "inner_node", subflow: passThrough(fed) },
        markedGate(),
        endNode("ce"),
      ], [ctl("cs", "inner_node"), ctl("inner_node", G), ctl(G, "ce")],
      [dataEdge("cs", "reviewTargets", "inner_node", "reviewTargets"), dataEdge("inner_node", "reviewTargets", G, "reviewTargets")]);
    expect(await compileError({ draftsFlow: outer("start") })).toContain(CALLER);
    const steps = await compileSteps({ draftsFlow: outer("mint") });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("refuses a marked gate whose unfed targets input is handed in by the embedding flow, and one whose targets nothing in the child produces", async () => {
    const unfed = flowDoc("drafts-subflow", "cs", [startNode("cs", ["campaignId"]), markedGate(), endNode("ce")], [ctl("cs", G), ctl(G, "ce")]);
    const handed = (input: string) => [dataEdge("startNode", "senderName", "drafts_flow", input)];
    expect(await compileError({ draftsFlow: unfed, parentEdges: handed("reviewTargets") })).toContain(CALLER);
    // Only an unrelated input is handed in: nothing feeds the targets at all.
    const error = await compileError({ draftsFlow: unfed, parentEdges: handed("campaignId") });
    // red-first-expect: expected true to be false
    expect(error).toContain("ARTIFACT_REVIEW_GATE_TARGETS_NOT_PRODUCED");
  });

  // ----- control flow: exactly one pause -----

  it("refuses a marked gate on a control-flow loop, however the loop closes", async () => {
    const loops: Array<[string, Array<Record<string, unknown>>]> = [
      ["gate to node and back", [ctl(G, "n1"), ctl("n1", G)]],
      ["a loop through an earlier node", [ctl("n0", G), ctl(G, "n1"), ctl("n1", "n0")]],
      ["a branch back to the gate", [ctl(G, "n1"), ctl("n1", "ce", "done"), ctl("n1", G, "again")]],
    ];
    for (const [label, edges] of loops) {
      const doc = flowDoc("drafts-subflow", label.startsWith("a loop") ? "n0" : G,
        [mintNode("n0"), markedGate(), mintNode("n1"), endNode("ce")], edges);
      const error = await compileError({ draftsFlow: doc });
      expect(error, label).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
    }
  });

  it("a loop after the marked gate that never returns to it does not refuse the gate", async () => {
    const doc = flowDoc("drafts-subflow", "file", [mintNode("file"), markedGate(), mintNode("n0"), mintNode("n1")],
      [ctl("file", G), ctl(G, "n0"), ctl("n0", "n1"), ctl("n1", "n0")], [dataEdge("file", "reviewTargets", G, "reviewTargets")]);
    const steps = await compileSteps({ draftsFlow: doc });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("refuses a marked gate in a nested flow whose node sits on a loop of the enclosing flow", async () => {
    const inner = flowDoc("inner", G, [markedGate()], []);
    const doc = flowDoc("drafts-subflow", "n0", [
      mintNode("n0"),
      { component_type: "FlowNode", id: "inner_node", name: "inner_node", subflow: inner },
      mintNode("n1"),
    ], [ctl("n0", "inner_node"), ctl("inner_node", "n1"), ctl("n1", "n0")]);
    expect(await compileError({ draftsFlow: doc })).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("refuses a marked gate that a branch lets the run skip after the filing, and one inside a repeating node", async () => {
    const skip = flowDoc("drafts-subflow", "n0", [mintNode("n0"), markedGate(), endNode("ce")],
      [ctl("n0", G, "yes"), ctl("n0", "ce", "no"), ctl(G, "ce")], [dataEdge("n0", "reviewTargets", G, "reviewTargets")]);
    expect(await compileError({ draftsFlow: skip })).toContain("ARTIFACT_REVIEW_GATE_UNREVIEWED_PATH");
    const each = flowDoc("drafts-subflow", "m", [
      { component_type: "MapNode", id: "m", name: "m", subflow: flowDoc("per-item", G, [markedGate()], []) },
    ], []);
    expect(await compileError({ draftsFlow: each })).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("a marked gate that every path crosses once, after a branch that rejoins, is carried", async () => {
    const doc = flowDoc("drafts-subflow", "n0", [mintNode("n0"), mintNode("a"), mintNode("b"), markedGate(), endNode("ce")],
      [ctl("n0", "a", "x"), ctl("n0", "b", "y"), ctl("a", G), ctl("b", G), ctl(G, "ce")], [dataEdge("n0", "reviewTargets", G, "reviewTargets")]);
    const steps = await compileSteps({ draftsFlow: doc });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("the step of a carried gate is a reviewer pause the flow owns, whatever its gateStep declares", async () => {
    const steps = await compileSteps({ draftsGateSteps: [{ ...DRAFTS_STEP, requiresApproval: false, hitlOwnedBy: "childAgent" }] });
    const drafts = byName(steps, "Review drafts");
    // red-first-expect: expected false to be true
    expect(drafts.requiresApproval).toBe(true);
    expect(drafts.hitlOwnedBy).toBe("self");
  });

  // ----- one reading of a gate's renderer -----

  it("an unmarked gate is judged by its field renderer first, whether the subflow is referenced or inline", async () => {
    const cases: Array<[Record<string, unknown>, boolean | undefined]> = [
      [{ renderer: "@test/c:context-selector", inputRenderers: { userResponse: "@test/c:review" } }, undefined],
      [{ renderer: "@test/c:review", inputRenderers: { userResponse: "@test/c:context-selector" } }, false],
    ];
    for (const inline of [false, true]) {
      for (const [cinatra, expected] of cases) {
        const steps = await compileSteps({
          draftsInline: inline,
          draftsGates: [gate("drafts-approval_gate", cinatra, [])],
        });
        // red-first-expect: expected false to be undefined
        expect(byName(steps, "Review drafts").firesRendererGate, JSON.stringify([inline, cinatra])).toBe(expected);
      }
    }
  });

  // ----- provenance through a parallel node's joined outputs -----

  const parallelNode = (id: string, branches: Array<Record<string, unknown>>, inputs: string[], outputs: string[]) => ({
    component_type: "ParallelFlowNode",
    id,
    name: id,
    subflows: branches,
    inputs: inputs.map((title) => ({ title, type: "string" })),
    outputs: outputs.map((title) => ({ title, type: "string" })),
  });

  it("refuses a caller value that reaches the targets through a parallel branch and the joined output, but carries one a branch mints", async () => {
    const branch = (minted: boolean) =>
      flowDoc("branch", "bs", [startNode("bs", ["alias"]), mintNode("bmint"), endNode("be", ["joined"])],
        [ctl("bs", "bmint"), ctl("bmint", "be")],
        [minted ? dataEdge("bmint", "reviewTargets", "be", "joined") : dataEdge("bs", "alias", "be", "joined")]);
    const doc = (minted: boolean) =>
      flowDoc("drafts-subflow", "cs", [startNode("cs", ["picked"]), parallelNode("par", [branch(minted)], ["alias"], ["joined"]), markedGate(), endNode("ce")],
        [ctl("cs", "par"), ctl("par", G), ctl(G, "ce")],
        [dataEdge("cs", "picked", "par", "alias"), dataEdge("par", "joined", G, "reviewTargets")]);
    // red-first-expect: expected true to be false
    expect(await compileError({ draftsFlow: doc(false) })).toContain(CALLER);
    const steps = await compileSteps({ draftsFlow: doc(true) });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
  });

  it("refuses a targets input that passes through a container of another kind", async () => {
    const doc = flowDoc("drafts-subflow", "cs", [
      startNode("cs", ["campaignId"]),
      { component_type: "MapNode", id: "m", name: "m", subflow: flowDoc("per-item", "ms", [startNode("ms", ["x"]), endNode("me", ["reviewTargets"])], [ctl("ms", "me")]) },
      markedGate(),
      endNode("ce"),
    ], [ctl("cs", "m"), ctl("m", G), ctl(G, "ce")], [dataEdge("m", "reviewTargets", G, "reviewTargets")]);
    // red-first-expect: expected true to be false
    expect(await compileError({ draftsFlow: doc })).toContain("ARTIFACT_REVIEW_GATE_INPUT_UNTRACEABLE");
  });

  // ----- early exits before the filing -----

  const UNREVIEWED = "ARTIFACT_REVIEW_GATE_UNREVIEWED_PATH";
  // The drafting pack's flow as the outreach flow embeds it (fixture source in
  // its `_source`). Its filing step's list grammar (one artifact per member)
  // comes with cinatra#4783, so the copy drops that step's request body; its
  // control and data edges, which this rule reads, stay as they are.
  const draftingSubflow = (): Record<string, unknown> => {
    const sub = structuredClone(embeddedDrafting.subflow) as Record<string, unknown>;
    delete ((sub.$referenced_components as Record<string, Record<string, unknown>>)["drafts-file_drafts"]!).data;
    return sub;
  };
  const draftingParts = (extra: Partial<Parts> = {}): Parts => ({
    draftsGates: [gate("drafts-unused_gate", {})],
    extraRefs: {
      drafts_flow: embeddedDrafting.flowNode,
      "email-drafting-subflow": draftingSubflow(),
    },
    ...extra,
  });
  // An early exit (check -> ce) runs before the filing step (mint).
  const earlyExit = (control: Array<Record<string, unknown>>, data: Array<Record<string, unknown>>, comps: Array<Record<string, unknown>> = []) =>
    flowDoc("drafts-subflow", "cs", [startNode("cs", ["campaignId"]), mintNode("check"), mintNode("mint"), markedGate(), endNode("ce", ["bodies"]), ...comps],
      [ctl("cs", "check"), ctl("check", "ce", "missing"), ctl("check", "mint", "ok"), ...control], data);
  const TARGETS = dataEdge("mint", "reviewTargets", G, "reviewTargets");

  it("the drafting pack's flow, embedded as the outreach flow embeds it, compiles with one review step", async () => {
    const steps = await compileSteps(draftingParts());
    const reviews = steps.filter((s) => s.artifactReviewTargetsInput !== undefined);
    expect(reviews.map((s) => s.name)).toEqual(["Review drafts"]);
    expect(reviews[0]!.artifactReviewTargetsInput).toBe("reviewTargets");
    expect(reviews[0]!.gateCount).toBe(1);
  });

  it("an early exit before the filing may skip the gate; a branch after the filing that skips it is refused", async () => {
    const steps = await compileSteps({ draftsFlow: earlyExit([ctl("mint", G), ctl(G, "ce")], [TARGETS]) });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
    const after = earlyExit([ctl("mint", G, "review"), ctl("mint", "ce", "skip"), ctl(G, "ce")], [TARGETS]);
    expect(await compileError({ draftsFlow: after })).toContain(UNREVIEWED);
  });

  it("an early exit beside a loop that could cross the gate twice is still refused", async () => {
    const loop = earlyExit([ctl("mint", G), ctl(G, "mint", "again"), ctl(G, "ce", "done")], [TARGETS]);
    expect(await compileError({ draftsFlow: loop })).toContain("ARTIFACT_REVIEW_GATE_AMBIGUOUS");
  });

  it("an early exit inside the parallel branch that files and reviews is carried; one in a branch handed filed targets is refused", async () => {
    const own = flowDoc("branch", "bs", [startNode("bs", ["campaignId"]), mintNode("check"), mintNode("mint"), markedGate(), endNode("be")],
      [ctl("bs", "check"), ctl("check", "be", "missing"), ctl("check", "mint", "ok"), ctl("mint", G), ctl(G, "be")], [TARGETS]);
    const inParallel = (branch: Record<string, unknown>, before: Array<Record<string, unknown>>, data: Array<Record<string, unknown>>) =>
      flowDoc("drafts-subflow", "cs", [startNode("cs", ["campaignId"]), mintNode("mint0"), parallelNode("par", [branch], ["filed"], []), endNode("ce")],
        [...before, ctl("par", "ce")], data);
    const steps = await compileSteps({ draftsFlow: inParallel(own, [ctl("cs", "par")], []) });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
    const handed = flowDoc("branch", "bs", [startNode("bs", ["filed"]), mintNode("check"), markedGate(), endNode("be")],
      [ctl("bs", "check"), ctl("check", "be", "missing"), ctl("check", G, "ok"), ctl(G, "be")], [dataEdge("bs", "filed", G, "reviewTargets")]);
    const error = await compileError({
      draftsFlow: inParallel(handed, [ctl("cs", "mint0"), ctl("mint0", "par")], [dataEdge("mint0", "reviewTargets", "par", "filed")]),
    });
    expect(error).toContain(UNREVIEWED);
  });

  it("targets from two producers are carried when each is followed by the gate, refused when one is not", async () => {
    const two = (skip: boolean) =>
      flowDoc("drafts-subflow", "cs", [startNode("cs", ["campaignId"]), mintNode("check"), mintNode("p1"), mintNode("p2"), markedGate(), endNode("ce")],
        [ctl("cs", "check"), ctl("check", "p1", "a"), ctl("check", "p2", "b"), ctl("p1", G), skip ? ctl("p2", "ce") : ctl("p2", G), ctl(G, "ce"), ...(skip ? [ctl("check", G, "c")] : [])],
        [dataEdge("p1", "reviewTargets", G, "reviewTargets"), dataEdge("p2", "reviewTargets", G, "reviewTargets")]);
    const steps = await compileSteps({ draftsFlow: two(false) });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
    expect(await compileError({ draftsFlow: two(true) })).toContain(UNREVIEWED);
  });

  it("an end output fed by the filing is empty on an early exit; a step that reads the filing before the gate is refused", async () => {
    const steps = await compileSteps({
      draftsFlow: earlyExit([ctl("mint", G), ctl(G, "ce")], [TARGETS, dataEdge("mint", "reviewTargets", "ce", "bodies")]),
    });
    expect(byName(steps, "Review drafts").artifactReviewTargetsInput).toBe("reviewTargets");
    const reader = {
      component_type: "ApiNode", id: "send", name: "send", url: "http://localhost/send", http_method: "POST",
      inputs: [{ title: "bodies", type: "string" }], outputs: [],
    };
    const readsFirst = earlyExit([ctl("mint", "send"), ctl("send", G), ctl(G, "ce")], [TARGETS, dataEdge("mint", "reviewTargets", "send", "bodies")], [reader]);
    expect(await compileError({ draftsFlow: readsFirst })).toContain(UNREVIEWED);
  });

  it("the step of a carried gate names the gate's node, also before a later reviewer step, whatever the paths", async () => {
    const later = { senderGateSteps: [{ name: "Confirm send", renderer: "@test/delivery:send-confirmation", hitlOwnedBy: "self", gateCount: 1 }] };
    for (const parts of [draftingParts(later), later]) {
      const steps = await compileSteps(parts);
      // red-first-expect: expected undefined to be 'drafts-approval_gate'
      expect(byName(steps, "Review drafts").artifactReviewGateNode).toBe("drafts-approval_gate");
      expect(byName(steps, "Confirm send").artifactReviewGateNode).toBeUndefined();
    }
  });

  it("refuses a marked gate whose id another component of the flow also carries", async () => {
    const error = await compileError({ extraRefs: { "other-subflow": subflow("other-subflow", [gate(G, {})]) } });
    expect(error).toContain("ARTIFACT_REVIEW_GATE_NODE_NOT_UNIQUE");
  });
});
