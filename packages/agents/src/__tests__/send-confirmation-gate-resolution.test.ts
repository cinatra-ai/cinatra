import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComponentType } from "react";
import {
  compileOasAgentJson,
  __resetRegistryCacheForTests,
  type CompiledAgentOasStep,
} from "../oas-compiler";
import { fieldRendererRegistry } from "../field-renderer-registry";
import { ensureDefaultFieldRenderersRegistered } from "../register-default-renderers";

// ---------------------------------------------------------------------------
// cinatra#1961 — end-to-end resolution lock for the send-confirmation APPROVAL
// GATE (owner ruling 2026-07-22, groganz: every campaign send pauses at a
// confirmation gate). The sibling of the #1959 drafts-review lock, adapted for
// the send-confirmation kind, which is SINGLE-FAMILY and WHOLLY pack-served —
// the host shell send-confirmation-renderer.tsx was DELETED and BOTH
// agent-namespaced ids (:send-confirmation gate + :output result) resolve
// through the generated BUILD map to @cinatra-ai/email-artifacts. There is no
// hybrid host/pack split here, so (unlike drafts-review) there is NO retain-host
// guard: the whole kind resolves pack-served or it is a regression.
//
// The email-delivery-agent OAS names @cinatra-ai/email-delivery-agent:send-confirmation
// as its InputMessageNode gate `renderer`. This bridges the two axes:
//
//   OAS gate `renderer` metadata (the pack id)
//     → compiled approvalPolicy.steps[].xRenderer            (oas-compiler)
//       → fieldRendererRegistry.resolve → the PACK wrapper   (register-default-renderers + generated map)
//
// The RESOLUTION KEY is the compiled step.xRenderer (from the `renderer`
// metadata), NOT the node's `a2uiSurfaceId` (inert for an InputMessageNode gate:
// the compiler never copies it onto the step and no resolver reads it). A
// regression that (a) drops the renderer passthrough in the InputMessageNode
// compile branch, (b) reverts the gate id, or (c) removes either pack id from the
// generated component map, fails this test.
// ---------------------------------------------------------------------------

const PACK_WRAPPER_PREFIX = "ExtensionFieldRenderer(";
const SEND_CONFIRMATION_GATE_ID = "@cinatra-ai/email-delivery-agent:send-confirmation";
const SEND_CONFIRMATION_OUTPUT_ID = "@cinatra-ai/email-delivery-agent:output";

// One-gate flow mirroring the real email-delivery confirmation gate shape:
//   start → confirmation_gate (InputMessageNode) → end
// The gate metadata mirrors the shipped OAS branch (requiresApproval + the
// self-namespaced renderer + surfaceGateInputs), so the compile path exercised
// is the exact InputMessageNode renderer-gate branch.
function buildGateOas(): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "email-delivery-flow",
    name: "Email Delivery Flow",
    metadata: {
      cinatra: { type: "flow", packageName: "@cinatra-ai/email-delivery-agent" },
    },
    inputs: [{ title: "campaignId", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "confirmation_gate" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "start" }, to_node: { $component_ref: "confirmation_gate" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "confirmation_gate" }, to_node: { $component_ref: "end" } },
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Setup",
        inputs: [{ title: "campaignId", type: "string" }],
        metadata: { cinatra: { required: ["campaignId"] } },
      },
      confirmation_gate: {
        component_type: "InputMessageNode",
        id: "confirmation_gate",
        name: "Confirm campaign send",
        metadata: {
          cinatra: {
            riskClass: "approval",
            requiresApproval: true,
            renderer: SEND_CONFIRMATION_GATE_ID,
            surfaceGateInputs: true,
            // Inert for InputMessageNode gates — asserted below to prove it is
            // NOT the resolution key.
            a2uiSurfaceId: "email-delivery:send-confirmation:input",
          },
        },
        inputs: [
          { title: "campaignId", type: "string" },
          { title: "senderEmail", type: "string" },
          { title: "summary", type: "object" },
        ],
        outputs: [{ title: "userResponse", type: "string" }],
      },
      end: { component_type: "EndNode", id: "end", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "send-confirmation-gate-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function compileGateStep(): Promise<CompiledAgentOasStep> {
  const oasPath = path.join(tempDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildGateOas(), null, 2));
  const regPath = path.join(tempDir, "components.json");
  writeFileSync(regPath, JSON.stringify({ components: {} }));
  const res = await compileOasAgentJson({
    packageName: "@cinatra-ai/email-delivery-agent",
    oasSourcePath: oasPath,
    registryPath: regPath,
    executionProvider: "wayflow",
  });
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const gate = res.value.approvalPolicy.steps.find((s) => s.nodeType === "input_message");
  expect(gate, "no input_message gate compiled for email-delivery").toBeTruthy();
  return gate!;
}

function resolveRenderer(xRenderer: string) {
  const schema = { "x-renderer": xRenderer } as Record<string, unknown>;
  const ctx = {
    connectedApps: [],
    allFieldValues: {},
    runId: "r",
    templateId: "t",
    xRenderer,
  };
  return fieldRendererRegistry.resolve("hitl-field", schema, ctx as never);
}

describe("#1961 send-confirmation approval-gate resolution (compile → resolve)", () => {
  beforeAll(() => {
    fieldRendererRegistry.clear();
    ensureDefaultFieldRenderersRegistered();
  });

  it("OAS gate renderer → compiled xRenderer → PACK wrapper", async () => {
    const gate = await compileGateStep();

    // 1. The compiler carries the OAS `renderer` metadata onto the step as the
    //    resolution key — verbatim, no a2uiSurfaceId substitution.
    expect(gate.xRenderer).toBe(SEND_CONFIRMATION_GATE_ID);
    // a2uiSurfaceId is inert for an InputMessageNode gate: never compiled onto
    // the step (so it can never be the resolution key).
    expect(gate.a2uiSurfaceId).toBeUndefined();

    // 2. That exact compiled key resolves to the PACK renderer (the
    //    ExtensionFieldRenderer wrapper that lazy-loads the email-artifacts
    //    send-confirmation component). There is NO host renderer to fall back to.
    const entry = resolveRenderer(gate.xRenderer!);
    expect(entry, `no renderer resolved for ${SEND_CONFIRMATION_GATE_ID}`).toBeTruthy();
    const resolved = entry!.renderer as ComponentType & { displayName?: string };
    expect(resolved.displayName).toBe(`${PACK_WRAPPER_PREFIX}${SEND_CONFIRMATION_GATE_ID})`);
  });

  it("the whole send-confirmation kind is pack-served — both ids resolve to the pack wrapper", () => {
    // send-confirmation is single-family (email-delivery-agent only): the host
    // shell was deleted, so BOTH agent-namespaced ids — the :send-confirmation
    // gate and the :output result renderer — resolve pack-served. A revert that
    // restored a host component (or dropped a generated-map entry) fails here.
    for (const id of [SEND_CONFIRMATION_GATE_ID, SEND_CONFIRMATION_OUTPUT_ID]) {
      const entry = resolveRenderer(id);
      expect(entry, `no renderer resolved for ${id}`).toBeTruthy();
      const resolved = entry!.renderer as ComponentType & { displayName?: string };
      expect(resolved.displayName).toBe(`${PACK_WRAPPER_PREFIX}${id})`);
    }
  });

  it("the :send-confirmation GATE binding is flagged midRunHitl (no mount-onChange auto-approve)", () => {
    // The gate renderer calls onChange on mount (it surfaces campaignId +
    // senderEmail + summary). In agentic-run-panel a NON-midRunHitl renderer's
    // onChange routes straight to performGateSubmit — which would auto-approve
    // the send with no operator click. The manifest MUST flag the gate binding
    // midRunHitl so onChange buffers behind an explicit Continue instead. This
    // is the structural guarantee behind the owner ruling 2026-07-22.
    const gate = resolveRenderer(SEND_CONFIRMATION_GATE_ID);
    expect(gate!.midRunHitl).toBe(true);
  });
});
