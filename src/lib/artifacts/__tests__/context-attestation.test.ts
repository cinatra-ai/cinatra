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
