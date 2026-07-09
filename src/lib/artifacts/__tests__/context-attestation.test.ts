// #907 — per-node context-callback attestation. Full fail-closed decision
// matrix at the pure seam (signature verify + OAS provenance re-anchor), plus
// the acceptance: a composed child claiming a SIBLING's (package, slot) → 403;
// own-slot → pass.
import { describe, it, expect } from "vitest";
import {
  CONTEXT_ATTESTATION_VERSION,
  computeContextAttestation,
  parseContextAttestationHeader,
  verifyContextAttestationSignature,
  resolveContextNodeProvenance,
  evaluateContextAttestation,
} from "../context-attestation";

const KEY = "attest-key-under-test";
const CTX = "conv-ctx-id-123";

// ---------------------------------------------------------------------------
// Realistic orchestrator OAS fixture — mirrors blog-pipeline-agent's compiled
// shape: each composed child slot inlines a context-resolution subflow DEF
// (holding ctx-<slot>-{resolve_context,finalize_*} ApiNodes) referenced by a
// marker FlowNode; the child package identity lives on the outer referencer.
// ---------------------------------------------------------------------------
function contextSubflowDef(slot: string): Record<string, unknown> {
  const base = (kind: "resolve" | "finalize", suffix: string) => ({
    component_type: "ApiNode",
    id: `ctx-${slot}-${suffix}`,
    url:
      kind === "resolve"
        ? "{{CINATRA_BASE_URL}}/api/context-resolve"
        : "{{CINATRA_BASE_URL}}/api/context-finalize",
  });
  return {
    component_type: "Flow",
    id: `child-${slot}__context-${slot}-subflow`,
    start_node: `ctx-${slot}-start`,
    $referenced_components: {
      [`ctx-${slot}-resolve_context`]: base("resolve", "resolve_context"),
      [`ctx-${slot}-finalize_interactive`]: base("finalize", "finalize_interactive"),
      [`ctx-${slot}-finalize_autonomous`]: base("finalize", "finalize_autonomous"),
    },
  };
}

function childSubflow(slot: string): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: `child-${slot}-subflow`,
    start_node: `child-${slot}-start`,
    $referenced_components: {
      [`child-${slot}__context-${slot}-subflow`]: contextSubflowDef(slot),
      [`child-${slot}__context_${slot}`]: {
        component_type: "FlowNode",
        id: `child-${slot}__context_${slot}`,
        subflow: { $component_ref: `child-${slot}__context-${slot}-subflow` },
        metadata: {
          cinatra: { purpose: `author-placed-context-resolution-for-${slot}` },
        },
      },
    },
  };
}

function orchestratorOas(): Record<string, unknown> {
  return {
    component_type: "Flow",
    id: "orchestrator-root",
    start_node: "start",
    metadata: { cinatra: { packageName: "@cinatra-ai/orchestrator" } },
    $referenced_components: {
      "child-slotA-subflow": childSubflow("slotA"),
      "child-slotB-subflow": childSubflow("slotB"),
      a_flow: {
        component_type: "FlowNode",
        id: "a_flow",
        subflow: { $component_ref: "child-slotA-subflow" },
        metadata: { cinatra: { packageName: "@cinatra-ai/child-a" } },
      },
      b_flow: {
        component_type: "FlowNode",
        id: "b_flow",
        subflow: { $component_ref: "child-slotB-subflow" },
        metadata: { cinatra: { packageName: "@cinatra-ai/child-b" } },
      },
    },
  };
}

describe("attestation signature", () => {
  it("verifies a matching signature and rejects tampering", () => {
    const sig = computeContextAttestation(KEY, CTX, "ctx-slotA-resolve_context");
    expect(
      verifyContextAttestationSignature({
        key: KEY,
        contextId: CTX,
        nodeId: "ctx-slotA-resolve_context",
        providedSignatureHex: sig,
      }),
    ).toBe(true);
    // wrong key / contextId / nodeId all fail
    expect(
      verifyContextAttestationSignature({
        key: "other",
        contextId: CTX,
        nodeId: "ctx-slotA-resolve_context",
        providedSignatureHex: sig,
      }),
    ).toBe(false);
    expect(
      verifyContextAttestationSignature({
        key: KEY,
        contextId: "other-ctx",
        nodeId: "ctx-slotA-resolve_context",
        providedSignatureHex: sig,
      }),
    ).toBe(false);
    expect(
      verifyContextAttestationSignature({
        key: KEY,
        contextId: CTX,
        nodeId: "ctx-slotB-resolve_context",
        providedSignatureHex: sig,
      }),
    ).toBe(false);
  });

  it("parses only well-formed v1:<hex> headers", () => {
    const sig = computeContextAttestation(KEY, CTX, "n");
    expect(parseContextAttestationHeader(`v1:${sig}`)).toBe(sig);
    expect(parseContextAttestationHeader("v2:" + sig)).toBeNull();
    expect(parseContextAttestationHeader("v1:not-hex!!")).toBeNull();
    expect(parseContextAttestationHeader("no-colon")).toBeNull();
    expect(parseContextAttestationHeader(":" + sig)).toBeNull();
    expect(parseContextAttestationHeader(null)).toBeNull();
  });

  it("uses the v1 version tag", () => {
    expect(CONTEXT_ATTESTATION_VERSION).toBe("v1");
  });
});

describe("resolveContextNodeProvenance", () => {
  it("re-anchors each ctx node to its slot + kind from the OAS structure", () => {
    const oas = orchestratorOas();
    expect(resolveContextNodeProvenance(oas, "ctx-slotA-resolve_context")).toEqual({
      slotId: "slotA",
      kind: "resolve",
    });
    expect(
      resolveContextNodeProvenance(oas, "ctx-slotA-finalize_interactive"),
    ).toEqual({ slotId: "slotA", kind: "finalize" });
    expect(
      resolveContextNodeProvenance(oas, "ctx-slotB-finalize_autonomous"),
    ).toEqual({ slotId: "slotB", kind: "finalize" });
  });

  it("returns null for an unknown node id (fail closed)", () => {
    expect(
      resolveContextNodeProvenance(orchestratorOas(), "ctx-nope-resolve_context"),
    ).toBeNull();
  });

  it("returns null on an id-COLLISION across definitions (fail closed)", () => {
    // A rogue node with an id that collides with slotB's real resolve node,
    // planted inside child-a's subflow. The shape LOOKS legit, but the id now
    // appears twice → ambiguous → fail closed (defeats codex's forged-id path).
    const oas = orchestratorOas();
    const childA = (oas["$referenced_components"] as Record<string, unknown>)[
      "child-slotA-subflow"
    ] as Record<string, unknown>;
    (childA["$referenced_components"] as Record<string, unknown>)[
      "rogue"
    ] = {
      component_type: "ApiNode",
      id: "ctx-slotB-resolve_context",
      url: "{{CINATRA_BASE_URL}}/api/context-resolve",
    };
    expect(
      resolveContextNodeProvenance(oas, "ctx-slotB-resolve_context"),
    ).toBeNull();
  });

  it("returns null when the enclosing def carries no owner marker", () => {
    // A context ApiNode inside a def that no marker references → unowned.
    const oas = orchestratorOas();
    (oas["$referenced_components"] as Record<string, unknown>)["orphan-subflow"] = {
      component_type: "Flow",
      id: "orphan-subflow",
      start_node: "o-start",
      $referenced_components: {
        "ctx-orphan-resolve_context": {
          component_type: "ApiNode",
          id: "ctx-orphan-resolve_context",
          url: "{{CINATRA_BASE_URL}}/api/context-resolve",
        },
      },
    };
    expect(
      resolveContextNodeProvenance(oas, "ctx-orphan-resolve_context"),
    ).toBeNull();
  });

  it("returns null when two markers bind the same context def to different slots", () => {
    const oas = orchestratorOas();
    const childA = (oas["$referenced_components"] as Record<string, unknown>)[
      "child-slotA-subflow"
    ] as Record<string, unknown>;
    (childA["$referenced_components"] as Record<string, unknown>)[
      "second_marker"
    ] = {
      component_type: "FlowNode",
      id: "child-slotA__context_ambiguous",
      subflow: { $component_ref: "child-slotA__context-slotA-subflow" },
      metadata: {
        cinatra: { purpose: "author-placed-context-resolution-for-slotX" },
      },
    };
    expect(
      resolveContextNodeProvenance(oas, "ctx-slotA-resolve_context"),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#1151 regression — REAL-grammar parity + the marker-present-but-drifted
// fail-closed boundary.
//
// The synthetic orchestratorOas() above is hand-built to MATCH the verifier, so
// by construction it cannot catch a divergence between the real OAS COMPILER's
// output grammar and what the re-anchor expects — which is exactly the class of
// failure #1151 hit at runtime: a run whose INSTALLED OAS was a stale/drifted
// build that STILL carried the 3 `author-placed-context-resolution-for-<slot>`
// markers and the `ctx-<slot>-resolve_context` node, yet 403'd with
// `attestation_node_unrecognized`.
//
// Root cause (grounded in #1151): a STALE/DRIFTED installed OAS, NOT a verifier
// bug — the current canonical build re-anchors cleanly, and the fail-closed
// rejection of a drifted build is the intended #907 security boundary (the
// durable structural fix is the loader-owned context-subflow injection redesign,
// tracked in the run-identity-spine epic #1192; the immediate unblock is a
// re-import of a current build). This suite is a REGRESSION GUARD for that
// boundary, not a change to product behavior:
//   1. `blogPipelineCompiledOas()` mirrors the REAL compiled grammar (the actual
//      `<child-agent>__context-<slot>-subflow` def naming, the marker sibling in
//      the child subflow, `{{CINATRA_BASE_URL}}` url templating, 3 composed
//      children) so a future verifier over-tightening that breaks the shipped
//      build is caught here.
//   2. The two "drift" cases assert that a build which STILL carries all 3
//      markers + the node but whose marker->subflow binding has drifted (a
//      renamed `$component_ref`, or a duplicated inline of the ctx node) STILL
//      fails closed with `attestation_node_unrecognized` — locking the boundary
//      against a future fail-OPEN regression (which would let a composed child
//      resolve a sibling's slot on any marker-bearing build).
// ---------------------------------------------------------------------------
function blogPipelineCompiledOas(): Record<string, unknown> {
  // Real composed children, faithful to blog-pipeline-agent's compiled OAS.
  const children: Array<{ agent: string; slot: string }> = [
    { agent: "blog-idea-generator-agent", slot: "ideaContext" },
    { agent: "blog-draft-writer-agent", slot: "draftContext" },
    { agent: "blog-image-prompt-agent", slot: "imagePromptContext" },
  ];
  const apiNode = (agent: string, slot: string, suffix: string, kind: "resolve" | "finalize") => ({
    component_type: "ApiNode",
    id: `ctx-${slot}-${suffix}`,
    url:
      kind === "resolve"
        ? "{{CINATRA_BASE_URL}}/api/context-resolve"
        : "{{CINATRA_BASE_URL}}/api/context-finalize",
    metadata: { cinatra: { agent } },
  });
  const refs: Record<string, unknown> = {};
  for (const { agent, slot } of children) {
    const ctxDefId = `${agent}__context-${slot}-subflow`;
    refs[`${agent}-subflow`] = {
      component_type: "Flow",
      id: `${agent}-subflow`,
      start_node: `${agent}-start`,
      $referenced_components: {
        // the context-resolution subflow DEF (holds the 3 ctx ApiNodes)
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
        // the author-placed marker FlowNode -> the ctx subflow def above
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
    // the outer FlowNode carrying the child PACKAGE identity
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

describe("cinatra#1151 — real-grammar re-anchor + drifted-build fail-closed boundary", () => {
  it("re-anchors every context node of the canonical blog-pipeline grammar", () => {
    const oas = blogPipelineCompiledOas();
    for (const slot of ["ideaContext", "draftContext", "imagePromptContext"]) {
      expect(resolveContextNodeProvenance(oas, `ctx-${slot}-resolve_context`)).toEqual({
        slotId: slot,
        kind: "resolve",
      });
      expect(resolveContextNodeProvenance(oas, `ctx-${slot}-finalize_interactive`)).toEqual({
        slotId: slot,
        kind: "finalize",
      });
      expect(resolveContextNodeProvenance(oas, `ctx-${slot}-finalize_autonomous`)).toEqual({
        slotId: slot,
        kind: "finalize",
      });
    }
  });

  it("#1151: markers PRESENT but the marker->subflow ref DRIFTED still fails closed (never fail-open)", () => {
    // The exact #1151 stale-install symptom: the build STILL carries all 3
    // author-placed markers + the node, but the compiled marker `$component_ref`
    // no longer names the def that encloses the ctx node (a grammar drift
    // between the installed build and the verifier's ground truth). The re-anchor
    // MUST reject it — accepting a marker-bearing-but-unanchorable build would
    // reopen the #907 sibling-slot hole.
    const oas = blogPipelineCompiledOas();
    let markerCount = 0;
    const severRefs = (node: unknown): void => {
      if (Array.isArray(node)) return node.forEach(severRefs);
      if (typeof node !== "object" || node === null) return;
      const rec = node as Record<string, unknown>;
      const purpose = (rec["metadata"] as { cinatra?: { purpose?: unknown } } | undefined)?.cinatra
        ?.purpose;
      if (
        typeof purpose === "string" &&
        purpose.startsWith("author-placed-context-resolution-for-")
      ) {
        const sf = rec["subflow"] as Record<string, unknown> | undefined;
        if (sf && typeof sf["$component_ref"] === "string") {
          sf["$component_ref"] = `${sf["$component_ref"]}__RENAMED_BY_STALE_BUILD`;
          markerCount += 1;
        }
      }
      for (const v of Object.values(rec)) severRefs(v);
    };
    severRefs(oas);
    expect(markerCount).toBe(3); // the markers are all still there
    expect(resolveContextNodeProvenance(oas, "ctx-ideaContext-resolve_context")).toBeNull();

    const nodeId = "ctx-ideaContext-resolve_context";
    const res = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: nodeId,
      attestationHeader: `v1:${computeContextAttestation(KEY, CTX, nodeId)}`,
      runOas: oas,
      slotId: "ideaContext",
      expectedKind: "resolve",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("#1151: a duplicated inline of the ctx node across defs fails closed", () => {
    // An older/drifted build that inlined the context subflow at a SECOND
    // call-site (rather than sharing one $referenced_components def) makes the
    // ctx node id occur in two enclosing defs — an id-collision the re-anchor
    // must reject as ambiguous.
    const oas = blogPipelineCompiledOas();
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    const orig = (refs["blog-idea-generator-agent-subflow"] as Record<string, unknown>)[
      "$referenced_components"
    ] as Record<string, unknown>;
    const dupDef = JSON.parse(
      JSON.stringify(orig["blog-idea-generator-agent__context-ideaContext-subflow"]),
    ) as Record<string, unknown>;
    dupDef["id"] = "some-other-agent__context-ideaContext-subflow"; // different def id, SAME ctx node id inside
    refs["duplicate-inline-subflow"] = {
      component_type: "Flow",
      id: "duplicate-inline-subflow",
      start_node: "dup-start",
      $referenced_components: { "some-other-agent__context-ideaContext-subflow": dupDef },
    };
    expect(resolveContextNodeProvenance(oas, "ctx-ideaContext-resolve_context")).toBeNull();

    // Assert the PUBLIC decision too, not just the internal re-anchor: a
    // duplicated-node build must 403 with attestation_node_unrecognized.
    const nodeId = "ctx-ideaContext-resolve_context";
    const res = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: nodeId,
      attestationHeader: `v1:${computeContextAttestation(KEY, CTX, nodeId)}`,
      runOas: oas,
      slotId: "ideaContext",
      expectedKind: "resolve",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });
});

describe("evaluateContextAttestation — fail-closed matrix", () => {
  function goodInput(slot: string, expectedKind: "resolve" | "finalize") {
    const nodeId =
      expectedKind === "resolve"
        ? `ctx-${slot}-resolve_context`
        : `ctx-${slot}-finalize_interactive`;
    return {
      key: KEY,
      contextId: CTX,
      nodeIdHeader: nodeId,
      attestationHeader: `v1:${computeContextAttestation(KEY, CTX, nodeId)}`,
      runOas: orchestratorOas(),
      slotId: slot,
      expectedKind,
    } as const;
  }

  it("ACCEPTANCE: own-slot resolve/finalize pass", () => {
    expect(evaluateContextAttestation(goodInput("slotA", "resolve"))).toEqual({
      ok: true,
      slotId: "slotA",
      kind: "resolve",
    });
    expect(evaluateContextAttestation(goodInput("slotB", "finalize"))).toEqual({
      ok: true,
      slotId: "slotB",
      kind: "finalize",
    });
  });

  it("ACCEPTANCE: a sibling claiming another child's (package, slot) → 403", () => {
    // Child A is executing (its runtime mints an attestation for ITS node,
    // ctx-slotA-resolve_context), but the request body claims slotB.
    const nodeId = "ctx-slotA-resolve_context";
    const res = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: nodeId,
      attestationHeader: `v1:${computeContextAttestation(KEY, CTX, nodeId)}`,
      runOas: orchestratorOas(),
      slotId: "slotB", // claiming the sibling's slot
      expectedKind: "resolve",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_slot_mismatch");
  });

  it("child A cannot forge a slotB attestation without slotB's node executing", () => {
    // It has no valid signature for ctx-slotB-resolve_context (needs the key +
    // to be the executing node). Presenting body slotB with a slotB nodeId but
    // a signature it cannot produce → invalid.
    const res = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: "ctx-slotB-resolve_context",
      attestationHeader: `v1:${computeContextAttestation(
        "WRONG-KEY-child-cannot-read",
        CTX,
        "ctx-slotB-resolve_context",
      )}`,
      runOas: orchestratorOas(),
      slotId: "slotB",
      expectedKind: "resolve",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_invalid");
  });

  it("missing context-id binding → attestation_context_required", () => {
    const res = evaluateContextAttestation({
      ...goodInput("slotA", "resolve"),
      contextId: null,
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_context_required");
  });

  it("unset signing key → attestation_unconfigured", () => {
    for (const key of [undefined, null, ""] as const) {
      const res = evaluateContextAttestation({ ...goodInput("slotA", "resolve"), key });
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.code).toBe("attestation_unconfigured");
    }
  });

  it("missing/malformed headers → attestation_missing", () => {
    expect(
      evaluateContextAttestation({ ...goodInput("slotA", "resolve"), nodeIdHeader: null }).ok,
    ).toBe(false);
    const res = evaluateContextAttestation({
      ...goodInput("slotA", "resolve"),
      attestationHeader: "garbage",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_missing");
  });

  it("bad signature → attestation_invalid", () => {
    const good = goodInput("slotA", "resolve");
    const tampered = good.attestationHeader.slice(0, -1) + (good.attestationHeader.endsWith("a") ? "b" : "a");
    const res = evaluateContextAttestation({ ...good, attestationHeader: tampered });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_invalid");
  });

  it("unknown node in the run OAS → attestation_node_unrecognized", () => {
    const nodeId = "ctx-ghost-resolve_context";
    const res = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: nodeId,
      attestationHeader: `v1:${computeContextAttestation(KEY, CTX, nodeId)}`,
      runOas: orchestratorOas(),
      slotId: "ghost",
      expectedKind: "resolve",
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("null run OAS → attestation_node_unrecognized (fail closed)", () => {
    const res = evaluateContextAttestation({ ...goodInput("slotA", "resolve"), runOas: null });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("resolve attestation replayed on the finalize endpoint → attestation_kind_mismatch", () => {
    const nodeId = "ctx-slotA-resolve_context";
    const res = evaluateContextAttestation({
      key: KEY,
      contextId: CTX,
      nodeIdHeader: nodeId,
      attestationHeader: `v1:${computeContextAttestation(KEY, CTX, nodeId)}`,
      runOas: orchestratorOas(),
      slotId: "slotA",
      expectedKind: "finalize", // this is the finalize route
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_kind_mismatch");
  });
});
