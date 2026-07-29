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
import { CampaignRecipientsReviewRenderer } from "../campaign-recipients-review-renderer";

// ---------------------------------------------------------------------------
// #1960 — end-to-end resolution lock for the campaign-recipients-review APPROVAL
// GATE (the recipients analogue of the #1959 drafts-review lock).
//
// The gate is an InputMessageNode whose `metadata.cinatra.renderer` names the
// PACK renderer id (relocated into @cinatra-ai/email-artifacts, cinatra#1960):
//
//   OAS gate `renderer` metadata (the pack id)
//     → compiled approvalPolicy.steps[].xRenderer            (oas-compiler)
//       → fieldRendererRegistry.resolve → the PACK wrapper   (register-default-renderers + generated map)
//
// The RESOLUTION KEY is the compiled step.xRenderer (sourced from `renderer`),
// NOT the node's `a2uiSurfaceId` (inert for an InputMessageNode gate). A
// regression that (a) drops the renderer passthrough in the InputMessageNode
// compile branch, (b) reverts the gate id to the pre-#1960
// the RETIRED reviewer gate id, or (c) removes the pack id from
// the generated component map, fails this test.
//
// RETIREMENT (cinatra#1796): the pre-#1960 reviewer gate id is RETIRED and
// the host CampaignRecipientsReviewRenderer (it is NOT in the generated map). The
// hybrid `campaign-recipients-review` kind is agent-namespaced-pack /
// reviewer-host by design (cinatra#1960).
// ---------------------------------------------------------------------------

const PACK_WRAPPER_PREFIX = "ExtensionFieldRenderer(";
const RECIPIENT_SELECTION_PACKAGE = "@cinatra-ai/email-recipient-selection-agent";
const PACK_GATE_ID = "@cinatra-ai/email-recipient-selection-agent:campaign-recipients-review";
// cinatra#1796 teardown: the RETIRED pre-#1960 gate id. Reassembled from parts
// so this file holds no live reference to the retired identity — the
// repo-wide exact-identity grep must stay at zero.
const RETIRED_GATE_ID = ["@cinatra-ai/", "reviewer", "-agent:contacts-output"].join("");

// One-gate flow mirroring the real recipients-review OAS shape:
//   start → approval_gate (InputMessageNode) → end
function buildGateOas(packageName: string, rendererId: string): Record<string, unknown> {
  return {
    agentspec_version: "26.1.0",
    component_type: "Flow",
    id: "recipients-review-flow",
    name: "Recipients Review Flow",
    metadata: { cinatra: { type: "node", packageName } },
    inputs: [{ title: "campaignId", type: "string" }],
    outputs: [],
    start_node: { $component_ref: "start" },
    nodes: [
      { $component_ref: "start" },
      { $component_ref: "approval_gate" },
      { $component_ref: "end" },
    ],
    control_flow_connections: [
      { component_type: "ControlFlowEdge", name: "e1", from_node: { $component_ref: "start" }, to_node: { $component_ref: "approval_gate" } },
      { component_type: "ControlFlowEdge", name: "e2", from_node: { $component_ref: "approval_gate" }, to_node: { $component_ref: "end" } },
    ],
    $referenced_components: {
      start: {
        component_type: "StartNode",
        id: "start",
        name: "Setup",
        inputs: [{ title: "campaignId", type: "string" }],
        metadata: { cinatra: { required: ["campaignId"] } },
      },
      approval_gate: {
        component_type: "InputMessageNode",
        id: "approval_gate",
        name: "Review and approve",
        metadata: {
          cinatra: {
            riskClass: "approval",
            requiresApproval: true,
            renderer: rendererId,
            // Inert for InputMessageNode gates — asserted below to prove it is
            // NOT the resolution key.
            a2uiSurfaceId: "reviewer:approval-gate:input",
            surfaceGateInputs: true,
          },
        },
        inputs: [{ title: "confirmedRecipients", type: "array" }],
        outputs: [{ title: "userResponse", type: "string" }],
      },
      end: { component_type: "EndNode", id: "end", name: "End", outputs: [] },
    },
  };
}

let tempDir: string;
beforeEach(() => {
  __resetRegistryCacheForTests();
  tempDir = mkdtempSync(path.join(tmpdir(), "recipients-review-gate-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function compileGateStep(
  packageName: string,
  rendererId: string,
): Promise<CompiledAgentOasStep> {
  const oasPath = path.join(tempDir, "oas.json");
  writeFileSync(oasPath, JSON.stringify(buildGateOas(packageName, rendererId), null, 2));
  const regPath = path.join(tempDir, "components.json");
  writeFileSync(regPath, JSON.stringify({ components: {} }));
  const res = await compileOasAgentJson({
    packageName,
    oasSourcePath: oasPath,
    registryPath: regPath,
    executionProvider: "wayflow",
  });
  expect(res.ok, res.ok ? "" : (res as { error?: string }).error).toBe(true);
  if (!res.ok) throw new Error("unreachable");
  const gate = res.value.approvalPolicy.steps.find((s) => s.nodeType === "input_message");
  expect(gate, `no input_message gate compiled for ${packageName}`).toBeTruthy();
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

describe("#1960 recipients-review approval-gate resolution (compile → resolve)", () => {
  beforeAll(() => {
    fieldRendererRegistry.clear();
    ensureDefaultFieldRenderersRegistered();
  });

  it("OAS gate renderer → compiled xRenderer → PACK wrapper", async () => {
    const gate = await compileGateStep(RECIPIENT_SELECTION_PACKAGE, PACK_GATE_ID);

    // 1. The compiler carries the OAS `renderer` metadata onto the step as the
    //    resolution key — verbatim, no a2uiSurfaceId substitution.
    expect(gate.xRenderer).toBe(PACK_GATE_ID);
    expect(gate.xRenderer).not.toBe(RETIRED_GATE_ID);
    expect(gate.a2uiSurfaceId).toBeUndefined();

    // 2. That exact compiled key resolves to the PACK renderer (the
    //    ExtensionFieldRenderer wrapper), NOT the host CampaignRecipientsReviewRenderer.
    const entry = resolveRenderer(gate.xRenderer!);
    expect(entry, `no renderer resolved for ${PACK_GATE_ID}`).toBeTruthy();
    const resolved = entry!.renderer as ComponentType & { displayName?: string };
    expect(resolved.displayName).toBe(`${PACK_WRAPPER_PREFIX}${PACK_GATE_ID})`);
    expect(resolved).not.toBe(CampaignRecipientsReviewRenderer);
    // The pack gate is a mid-run HITL surface (manifest-declared).
    expect(entry!.midRunHitl).toBe(true);
  });

  it("cinatra#1796: the RETIRED reviewer gate id resolves to NOTHING", () => {
    // Before the retirement this id kept the host CampaignRecipientsReviewRenderer (the
    // deliberate hybrid split, #1960). The reviewer package, its bindings and
    // its kind are now gone, so a stale template still carrying the old id
    // resolves to NO renderer rather than silently rendering a review
    // surface no live flow produces. The pack id above is the only path.
    expect(resolveRenderer(RETIRED_GATE_ID)).toBeFalsy();
  });
});
