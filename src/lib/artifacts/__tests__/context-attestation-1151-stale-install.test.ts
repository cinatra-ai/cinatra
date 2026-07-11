// cinatra#1151 × cinatra#1194 — the stale-install boundary UNDER the run-token
// declaration gate.
//
// #1151's Layer-3 repro: a composed child whose INSTALLED OAS predates the
// current build (a stale/drifted hand-carried spec that still holds all three
// `author-placed-context-resolution-for-<slot>` markers AND the
// `ctx-<slot>-resolve_context` node) 403s with `attestation_node_unrecognized`.
// The #1207 guard locks that boundary on the LEGACY transport. #1194 then
// introduced a SECOND anchor — the injection-grammar + contextSlots-declaration
// re-anchor, admitted only when the run was served by the run token — which is
// exactly the arm a live composed run now exercises.
//
// This suite closes the remaining question: can the NEW arm fail-OPEN-rescue a
// stale installed build on the run-token path? It must not — declaration
// anchoring requires the attested nodeId (and the injector's full generated-id
// set) ABSENT from the installed bytes and NO marker family for the slot, so a
// pre-#1194 hand-carried build can never ride it. The correct outcomes, locked
// here:
//   1-3. every #1151 stale/drifted shape STILL fails closed with
//        `attestation_node_unrecognized` even with the declaration gate ON
//        (the affected host's fix remains re-import/rebuild — tactical);
//   4-5. the slim (declaration-only) re-release of the SAME composition
//        resolves the exact #1151 repro node via `anchor: "declaration"` on
//        the run-token path, and stays fail-closed on a legacy transport —
//        the durable half: a slim build carries no subflow bytes to drift.
import { describe, it, expect } from "vitest";
import {
  computeContextAttestationV2,
  evaluateContextAttestation,
  resolveContextNodeProvenance,
} from "../context-attestation";
import { findBoundChildPackageForSlot } from "../context-route-support";

const KEY = "attest-key-under-test";
const CTX = "conv-ctx-id-1151";
const NOW_MS = 1_770_000_000_000;
const EXP_S = Math.floor(NOW_MS / 1000) + 60;
const NODE = "ctx-ideaContext-resolve_context"; // the exact #1151 repro node

function v2Header(nodeId: string): string {
  return `v2:${EXP_S}:${computeContextAttestationV2(KEY, CTX, nodeId, EXP_S)}`;
}

function evalOnTokenPath(
  oas: Record<string, unknown>,
  opts: { allowDeclarationAnchor: boolean },
) {
  return evaluateContextAttestation({
    key: KEY,
    contextId: CTX,
    nodeIdHeader: NODE,
    attestationHeader: v2Header(NODE),
    runOas: oas,
    slotId: "ideaContext",
    expectedKind: "resolve",
    allowDeclarationAnchor: opts.allowDeclarationAnchor,
    nowMs: NOW_MS,
  });
}

const CHILDREN: Array<{ agent: string; slot: string }> = [
  { agent: "blog-idea-generator-agent", slot: "ideaContext" },
  { agent: "blog-draft-writer-agent", slot: "draftContext" },
  { agent: "blog-image-prompt-agent", slot: "imagePromptContext" },
];

/** PRE-#1194 installed grammar — mirrors blogPipelineCompiledOas() in the
 *  #1207 guard (context-attestation.test.ts): hand-carried subflow bytes,
 *  author-placed markers, ctx ApiNodes present in the installed document. */
function staleHandCarriedOas(): Record<string, unknown> {
  const apiNode = (
    agent: string,
    slot: string,
    suffix: string,
    kind: "resolve" | "finalize",
  ) => ({
    component_type: "ApiNode",
    id: `ctx-${slot}-${suffix}`,
    url:
      kind === "resolve"
        ? "{{CINATRA_BASE_URL}}/api/context-resolve"
        : "{{CINATRA_BASE_URL}}/api/context-finalize",
    metadata: { cinatra: { agent } },
  });
  const refs: Record<string, unknown> = {};
  for (const { agent, slot } of CHILDREN) {
    const ctxDefId = `${agent}__context-${slot}-subflow`;
    refs[`${agent}-subflow`] = {
      component_type: "Flow",
      id: `${agent}-subflow`,
      start_node: `${agent}-start`,
      $referenced_components: {
        [ctxDefId]: {
          component_type: "Flow",
          id: ctxDefId,
          start_node: `ctx-${slot}-start`,
          $referenced_components: {
            [`ctx-${slot}-resolve_context`]: apiNode(agent, slot, "resolve_context", "resolve"),
            [`ctx-${slot}-finalize_interactive`]: apiNode(agent, slot, "finalize_interactive", "finalize"),
            [`ctx-${slot}-finalize_autonomous`]: apiNode(agent, slot, "finalize_autonomous", "finalize"),
          },
        },
        [`${agent}__context_${slot}`]: {
          component_type: "FlowNode",
          id: `${agent}__context_${slot}`,
          subflow: { $component_ref: ctxDefId },
          metadata: {
            cinatra: { purpose: `author-placed-context-resolution-for-${slot}` },
          },
        },
      },
    };
    refs[`${slot}_flow`] = {
      component_type: "FlowNode",
      id: `${slot}_flow`,
      subflow: { $component_ref: `${agent}-subflow` },
      metadata: { cinatra: { packageName: `@cinatra-ai/${agent}` } },
    };
  }
  return {
    component_type: "Flow",
    id: "blog-pipeline-agent",
    start_node: "start",
    metadata: { cinatra: { packageName: "@cinatra-ai/blog-pipeline-agent" } },
    $referenced_components: refs,
  };
}

/** The #1151 drift: markers all still present, but each marker's
 *  `subflow.$component_ref` no longer names the def enclosing the ctx node. */
function driftMarkerRefs(oas: Record<string, unknown>): number {
  let renamed = 0;
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (typeof node !== "object" || node === null) return;
    const rec = node as Record<string, unknown>;
    const purpose = (
      rec["metadata"] as { cinatra?: { purpose?: unknown } } | undefined
    )?.cinatra?.purpose;
    if (
      typeof purpose === "string" &&
      purpose.startsWith("author-placed-context-resolution-for-")
    ) {
      const sf = rec["subflow"] as Record<string, unknown> | undefined;
      if (sf && typeof sf["$component_ref"] === "string") {
        sf["$component_ref"] = `${sf["$component_ref"]}__RENAMED_BY_STALE_BUILD`;
        renamed += 1;
      }
    }
    for (const v of Object.values(rec)) walk(v);
  };
  walk(oas);
  return renamed;
}

/** The REAL slim declarations, copied from the child agents' slimmed source
 *  specs (<agent>/cinatra/oas.json in the org — the pending re-release). */
const REAL_SLOT_DECLS: Record<string, Record<string, unknown>> = {
  ideaContext: {
    slotId: "ideaContext",
    acceptedArtifactExtensions: ["@cinatra-ai/brand-voice-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
  },
  draftContext: {
    slotId: "draftContext",
    acceptedArtifactExtensions: [
      "@cinatra-ai/brand-voice-artifact",
      "@cinatra-ai/blog-idea-artifact",
    ],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
  },
  imagePromptContext: {
    slotId: "imagePromptContext",
    acceptedArtifactExtensions: [
      "@cinatra-ai/brand-voice-artifact",
      "@cinatra-ai/blog-post-artifact",
    ],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
  },
};

function slotDecl(slot: string): Record<string, unknown> {
  return REAL_SLOT_DECLS[slot];
}

/** POST-#1194 slim re-release of the SAME composition: each child definition
 *  carries only its contextSlots declaration; NO subflow bytes, markers, or
 *  ctx node ids exist anywhere in the installed document (the loader injects
 *  them at mount). Each child is LOADER-INJECTABLE per the injector's
 *  validation in docker/wayflow/context_subflow_injection.py — nodes +
 *  control_flow_connections + an outgoing start edge + an executable
 *  consumer declaring the `contextSlotBindings` input (mirrors the pytest
 *  `_slim_spec` fixture) — so this fixture is a build the loader would
 *  actually mount, not just a shape the verifier happens to accept.
 *  Cross-validated against the REAL injector: `inject_context_subflows`
 *  accepts this exact document and injects all three slots with the correct
 *  owner packages (report: definition `<agent>-subflow`, packageName
 *  `@cinatra-ai/<agent>`, templateVersion 1 for each child). */
export function slimReleaseOas(): Record<string, unknown> {
  const refs: Record<string, unknown> = {
    start: {
      component_type: "StartNode",
      id: "start",
      inputs: [{ title: "brief", type: "string" }],
    },
    end: {
      component_type: "EndNode",
      id: "end",
      inputs: [{ title: "result", type: "string" }],
      outputs: [{ title: "result", type: "string" }],
    },
  };
  for (const { agent, slot } of CHILDREN) {
    refs[`${agent}-subflow`] = {
      component_type: "Flow",
      id: `${agent}-subflow`,
      inputs: [{ title: "brief", type: "string" }],
      outputs: [{ title: "result", type: "string" }],
      start_node: { $component_ref: `${agent}-start` },
      nodes: [
        { $component_ref: `${agent}-start` },
        { $component_ref: `${agent}-work` },
        { $component_ref: `${agent}-end` },
      ],
      control_flow_connections: [
        {
          component_type: "ControlFlowEdge",
          name: `${agent}-start_to_work`,
          from_node: { $component_ref: `${agent}-start` },
          to_node: { $component_ref: `${agent}-work` },
        },
        {
          component_type: "ControlFlowEdge",
          name: `${agent}-work_to_end`,
          from_node: { $component_ref: `${agent}-work` },
          to_node: { $component_ref: `${agent}-end` },
        },
      ],
      data_flow_connections: [
        {
          component_type: "DataFlowEdge",
          name: `${agent}-start_brief_to_work`,
          source_node: { $component_ref: `${agent}-start` },
          source_output: "brief",
          destination_node: { $component_ref: `${agent}-work` },
          destination_input: "brief",
        },
      ],
      metadata: { cinatra: { contextSlots: [slotDecl(slot)] } },
      $referenced_components: {
        [`${agent}-start`]: {
          component_type: "StartNode",
          id: `${agent}-start`,
          inputs: [{ title: "brief", type: "string" }],
        },
        // The slot's CONSUMER: a single-slot definition, so the bare
        // `contextSlotBindings` input is the injector's wiring target.
        [`${agent}-work`]: {
          component_type: "ApiNode",
          id: `${agent}-work`,
          url: "{{CINATRA_BASE_URL}}/api/llm-bridge",
          http_method: "POST",
          data: { user: "brief: {{ brief }} ctx: {{ contextSlotBindings }}" },
          inputs: [
            { title: "brief", type: "string" },
            { title: "contextSlotBindings", type: "array" },
          ],
          outputs: [{ title: "result", type: "string" }],
        },
        [`${agent}-end`]: {
          component_type: "EndNode",
          id: `${agent}-end`,
          inputs: [{ title: "result", type: "string" }],
          outputs: [{ title: "result", type: "string" }],
        },
      },
    };
    refs[`${slot}_flow`] = {
      component_type: "FlowNode",
      id: `${slot}_flow`,
      subflow: { $component_ref: `${agent}-subflow` },
      metadata: { cinatra: { packageName: `@cinatra-ai/${agent}` } },
    };
  }
  const chain = ["start", ...CHILDREN.map((c) => `${c.slot}_flow`), "end"];
  return {
    component_type: "Flow",
    id: "blog-pipeline-agent",
    metadata: { cinatra: { packageName: "@cinatra-ai/blog-pipeline-agent" } },
    inputs: [{ title: "brief", type: "string" }],
    outputs: [{ title: "result", type: "string" }],
    start_node: { $component_ref: "start" },
    nodes: chain.map((id) => ({ $component_ref: id })),
    control_flow_connections: chain.slice(0, -1).map((from, i) => ({
      component_type: "ControlFlowEdge",
      name: `${from}_to_${chain[i + 1]}`,
      from_node: { $component_ref: from },
      to_node: { $component_ref: chain[i + 1] },
    })),
    $referenced_components: refs,
  };
}

describe("cinatra#1151 — stale installed build under the #1194 run-token declaration gate", () => {
  it("drifted marker refs: the declaration gate does NOT rescue a stale build (still attestation_node_unrecognized)", () => {
    const oas = staleHandCarriedOas();
    expect(driftMarkerRefs(oas)).toBe(3);
    // The attested node id is PRESENT in the installed bytes, so the legacy
    // structural branch stays authoritative and fails closed; the declaration
    // arm is unreachable by construction (nodeId-in-bytes + marker present).
    expect(
      resolveContextNodeProvenance(oas, NODE, { allowDeclarationAnchor: true }),
    ).toBeNull();
    const res = evalOnTokenPath(oas, { allowDeclarationAnchor: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("duplicated ctx-node inline (id collision): still fail-closed on the run-token path", () => {
    const oas = staleHandCarriedOas();
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    const child = refs["blog-idea-generator-agent-subflow"] as Record<string, unknown>;
    const childRefs = child["$referenced_components"] as Record<string, unknown>;
    const dupDef = JSON.parse(
      JSON.stringify(childRefs["blog-idea-generator-agent__context-ideaContext-subflow"]),
    ) as Record<string, unknown>;
    dupDef["id"] = "some-other-agent__context-ideaContext-subflow";
    refs["duplicate-inline-subflow"] = {
      component_type: "Flow",
      id: "duplicate-inline-subflow",
      start_node: "dup-start",
      $referenced_components: {
        "some-other-agent__context-ideaContext-subflow": dupDef,
      },
    };
    expect(
      resolveContextNodeProvenance(oas, NODE, { allowDeclarationAnchor: true }),
    ).toBeNull();
    const res = evalOnTokenPath(oas, { allowDeclarationAnchor: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("a drifted stale build that ALSO declares the slot cannot ride the declaration arm", () => {
    // Adversarial hybrid: take the drifted hand-carried build and ADD a valid
    // contextSlots declaration for the slot. The declaration arm must still
    // refuse — the nodeId (and the injector's whole generated-id set) is in
    // the installed bytes, and the marker family names the slot.
    const oas = staleHandCarriedOas();
    driftMarkerRefs(oas);
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    const child = refs["blog-idea-generator-agent-subflow"] as Record<string, unknown>;
    child["metadata"] = { cinatra: { contextSlots: [slotDecl("ideaContext")] } };
    expect(
      resolveContextNodeProvenance(oas, NODE, { allowDeclarationAnchor: true }),
    ).toBeNull();
    const res = evalOnTokenPath(oas, { allowDeclarationAnchor: true });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("the slim re-release resolves the exact #1151 repro node via the declaration anchor (run-token path)", () => {
    const oas = slimReleaseOas();
    expect(
      resolveContextNodeProvenance(oas, NODE, { allowDeclarationAnchor: true }),
    ).toEqual({ slotId: "ideaContext", kind: "resolve", anchor: "declaration" });
    const res = evalOnTokenPath(oas, { allowDeclarationAnchor: true });
    expect(res).toEqual({
      ok: true,
      slotId: "ideaContext",
      kind: "resolve",
      anchor: "declaration",
    });
    // The owner-package binding joins through the declaration too.
    expect(
      findBoundChildPackageForSlot(oas, "ideaContext", {
        allowDeclarationBinding: true,
      }),
    ).toBe("@cinatra-ai/blog-idea-generator-agent");
    // Sibling isolation is preserved: each sibling slot joins to its OWN
    // package via its own declaration…
    expect(
      findBoundChildPackageForSlot(oas, "draftContext", {
        allowDeclarationBinding: true,
      }),
    ).toBe("@cinatra-ai/blog-draft-writer-agent");
    // …and the ideaContext resolve node cannot serve a SIBLING's slot (the
    // #907 boundary, now enforced through the declaration anchor).
    const cross = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: NODE,
      attestationHeader: v2Header(NODE),
      runOas: oas,
      slotId: "draftContext",
      expectedKind: "resolve",
      allowDeclarationAnchor: true,
      nowMs: NOW_MS,
    });
    expect(cross.ok).toBe(false);
    if (!cross.ok) expect(cross.code).toBe("attestation_slot_mismatch");
  });

  it("the slim re-release stays fail-closed on a legacy (non-run-token) transport", () => {
    const oas = slimReleaseOas();
    expect(resolveContextNodeProvenance(oas, NODE)).toBeNull();
    const res = evalOnTokenPath(oas, { allowDeclarationAnchor: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
    expect(findBoundChildPackageForSlot(oas, "ideaContext")).toBeNull();
  });
});
