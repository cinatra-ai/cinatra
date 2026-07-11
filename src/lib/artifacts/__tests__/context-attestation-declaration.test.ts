// cinatra#1194 — declaration re-anchor (loader-owned context-subflow
// injection). A slim (declaration-only) spec carries NO subflow bytes; on
// the run-token path the attested nodeId is re-anchored to the deterministic
// injection grammar + the installed contextSlots declaration. Full
// fail-closed matrix, plus verifier/injector collision parity and the
// declaration join in findBoundChildPackageForSlot.
import { describe, it, expect } from "vitest";
import {
  computeContextAttestationV2,
  evaluateContextAttestation,
  parseInjectedContextNodeId,
  resolveContextNodeProvenance,
} from "../context-attestation";
import { findBoundChildPackageForSlot } from "../context-route-support";

const KEY = "attest-key-under-test";
const CTX = "conv-ctx-id-123";

function slotDecl(slotId: string): Record<string, unknown> {
  return {
    slotId,
    acceptedArtifactExtensions: ["@cinatra-ai/brand-voice-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
  };
}

/** A slim COMPOSED parent: the inlined child definition carries the child's
 *  contextSlots declaration (slim composition contract) and NO subflow
 *  bytes; the referencing FlowNode carries the child package identity —
 *  exactly the compiled shape minus the injected machinery. */
function slimParentOas(
  overrides: {
    childSlots?: unknown;
    rootSlots?: unknown;
    extraRefs?: Record<string, unknown>;
    secondChild?: boolean;
    secondChildSlots?: unknown;
  } = {},
): Record<string, unknown> {
  const childSlots = overrides.childSlots ?? [slotDecl("ideaContext")];
  const refs: Record<string, unknown> = {
    start: { component_type: "StartNode", id: "start" },
    "child-agent-subflow": {
      component_type: "Flow",
      id: "child-agent-subflow",
      start_node: { $component_ref: "child__start" },
      nodes: [],
      metadata: { cinatra: { contextSlots: childSlots } },
      $referenced_components: {
        child__start: { component_type: "StartNode", id: "child__start" },
      },
    },
    child_flow: {
      component_type: "FlowNode",
      id: "child_flow",
      subflow: { $component_ref: "child-agent-subflow" },
      metadata: { cinatra: { packageName: "@cinatra-ai/child-agent" } },
    },
    ...(overrides.extraRefs ?? {}),
  };
  if (overrides.secondChild) {
    refs["other-agent-subflow"] = {
      component_type: "Flow",
      id: "other-agent-subflow",
      start_node: { $component_ref: "other__start" },
      nodes: [],
      metadata: {
        cinatra: {
          contextSlots: overrides.secondChildSlots ?? [slotDecl("otherSlot")],
        },
      },
      $referenced_components: {
        other__start: { component_type: "StartNode", id: "other__start" },
      },
    };
    refs["other_flow"] = {
      component_type: "FlowNode",
      id: "other_flow",
      subflow: { $component_ref: "other-agent-subflow" },
      metadata: { cinatra: { packageName: "@cinatra-ai/other-agent" } },
    };
  }
  const root: Record<string, unknown> = {
    component_type: "Flow",
    id: "parent-root",
    start_node: { $component_ref: "start" },
    nodes: [{ $component_ref: "child_flow" }],
    metadata: { cinatra: { packageName: "@cinatra-ai/parent-agent" } },
    $referenced_components: refs,
  };
  if (overrides.rootSlots !== undefined) {
    (root["metadata"] as Record<string, Record<string, unknown>>)["cinatra"][
      "contextSlots"
    ] = overrides.rootSlots;
  }
  return root;
}

/** Legacy marker structure for a slot (the hand-carried format). */
function legacyMarkerRefs(slot: string): Record<string, unknown> {
  return {
    [`legacy-${slot}__context-${slot}-subflow`]: {
      component_type: "Flow",
      id: `legacy-${slot}__context-${slot}-subflow`,
      start_node: `ctx-${slot}-start`,
      $referenced_components: {
        [`ctx-${slot}-resolve_context`]: {
          component_type: "ApiNode",
          id: `ctx-${slot}-resolve_context`,
          url: "{{CINATRA_BASE_URL}}/api/context-resolve",
        },
      },
    },
    [`legacy-${slot}__context_${slot}`]: {
      component_type: "FlowNode",
      id: `legacy-${slot}__context_${slot}`,
      subflow: { $component_ref: `legacy-${slot}__context-${slot}-subflow` },
      metadata: {
        cinatra: { purpose: `author-placed-context-resolution-for-${slot}` },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Grammar parse.
// ---------------------------------------------------------------------------

describe("parseInjectedContextNodeId", () => {
  it("parses the three injected ApiNode kinds", () => {
    expect(parseInjectedContextNodeId("ctx-ideaContext-resolve_context")).toEqual(
      { slotId: "ideaContext", kind: "resolve" },
    );
    expect(
      parseInjectedContextNodeId("ctx-ideaContext-finalize_interactive"),
    ).toEqual({ slotId: "ideaContext", kind: "finalize" });
    expect(
      parseInjectedContextNodeId("ctx-ideaContext-finalize_autonomous"),
    ).toEqual({ slotId: "ideaContext", kind: "finalize" });
  });

  it("keeps hyphenated slot ids intact (suffix match)", () => {
    expect(
      parseInjectedContextNodeId("ctx-a-b-c-resolve_context"),
    ).toEqual({ slotId: "a-b-c", kind: "resolve" });
  });

  it("rejects non-context node kinds and malformed ids", () => {
    for (const bad of [
      "ctx-slot-start",
      "ctx-slot-select_mode",
      "ctx-slot-emit_context_payload",
      "ctx-slot-context_select_gate",
      "ctx-slot-end",
      "ctx--resolve_context",
      "context_slot",
      "resolve_context",
      "",
    ]) {
      expect(parseInjectedContextNodeId(bad)).toBeNull();
    }
  });
});

// ---------------------------------------------------------------------------
// resolveContextNodeProvenance — declaration arm.
// ---------------------------------------------------------------------------

describe("resolveContextNodeProvenance declaration anchor", () => {
  const NODE = "ctx-ideaContext-resolve_context";
  const allow = { allowDeclarationAnchor: true };

  it("anchors a declared slot on the gated path", () => {
    expect(resolveContextNodeProvenance(slimParentOas(), NODE, allow)).toEqual({
      slotId: "ideaContext",
      kind: "resolve",
      anchor: "declaration",
    });
    expect(
      resolveContextNodeProvenance(
        slimParentOas(),
        "ctx-ideaContext-finalize_autonomous",
        allow,
      ),
    ).toEqual({ slotId: "ideaContext", kind: "finalize", anchor: "declaration" });
  });

  it("anchors a root-level (leaf) declaration too", () => {
    const oas = slimParentOas({
      childSlots: [],
      rootSlots: [slotDecl("rootSlot")],
    });
    expect(
      resolveContextNodeProvenance(oas, "ctx-rootSlot-resolve_context", allow),
    ).toEqual({ slotId: "rootSlot", kind: "resolve", anchor: "declaration" });
  });

  it("gate off ⇒ null (legacy transports never see the declaration arm)", () => {
    expect(resolveContextNodeProvenance(slimParentOas(), NODE)).toBeNull();
    expect(
      resolveContextNodeProvenance(slimParentOas(), NODE, {
        allowDeclarationAnchor: false,
      }),
    ).toBeNull();
  });

  it("undeclared slot ⇒ null", () => {
    expect(
      resolveContextNodeProvenance(
        slimParentOas(),
        "ctx-unknownSlot-resolve_context",
        allow,
      ),
    ).toBeNull();
  });

  it("duplicate declaration across carriers ⇒ null", () => {
    const oas = slimParentOas({
      secondChild: true,
      secondChildSlots: [slotDecl("ideaContext")],
    });
    expect(resolveContextNodeProvenance(oas, NODE, allow)).toBeNull();
  });

  it("duplicate declaration within one carrier ⇒ null (tainted)", () => {
    const oas = slimParentOas({
      childSlots: [slotDecl("ideaContext"), slotDecl("ideaContext")],
    });
    expect(resolveContextNodeProvenance(oas, NODE, allow)).toBeNull();
  });

  it("malformed carrier taints its slot ids ⇒ null", () => {
    const oas = slimParentOas({
      childSlots: [
        slotDecl("ideaContext"),
        { slotId: "junk", selectionMode: "nope" },
      ],
    });
    expect(resolveContextNodeProvenance(oas, NODE, allow)).toBeNull();
  });

  it("marker present for the slot (either family) ⇒ declaration arm blocked", () => {
    const withAuthorMarker = slimParentOas({
      extraRefs: legacyMarkerRefs("otherThing"),
    });
    // marker for a DIFFERENT slot does not block ideaContext…
    expect(
      resolveContextNodeProvenance(withAuthorMarker, NODE, allow),
    ).not.toBeNull();
    // …but a marker for the SAME slot does (legacy authoritative), even a
    // loader-injected one.
    const withSameSlotMarker = slimParentOas({
      extraRefs: {
        stray_marker: {
          component_type: "FlowNode",
          id: "stray_marker",
          metadata: {
            cinatra: {
              purpose: "loader-injected-context-resolution-for-ideaContext",
            },
          },
        },
      },
    });
    expect(
      resolveContextNodeProvenance(withSameSlotMarker, NODE, allow),
    ).toBeNull();
  });

  it("carrier-predicate parity: a declarer the loader would not recognize never anchors", () => {
    // `$referenced_components: null` / array shapes satisfy the LOOSE legacy
    // isFlowDefinition (`typeof === "object"`) but NOT the loader's
    // `_is_flow_definition` — the declaration scan must mirror the loader.
    for (const badRefs of [null, [] as unknown[]]) {
      const oas = slimParentOas({
        childSlots: [],
        extraRefs: {
          "weird-def": {
            component_type: "Flow",
            id: "weird-def",
            $referenced_components: badRefs,
            metadata: { cinatra: { contextSlots: [slotDecl("weirdSlot")] } },
          },
        },
      });
      expect(
        resolveContextNodeProvenance(oas, "ctx-weirdSlot-resolve_context", allow),
      ).toBeNull();
    }
  });

  it("a degenerate (non-carrier) declarer is IGNORED, not tainting a proper carrier", () => {
    // Loader parity: the loader ignores a contextSlots blob on a non-
    // definition node and injects from the proper carrier — the anchor must
    // therefore still resolve.
    const oas = slimParentOas({
      extraRefs: {
        stray_blob: {
          component_type: "FlowNode",
          id: "stray_blob",
          metadata: { cinatra: { contextSlots: [slotDecl("ideaContext")] } },
        },
      },
    });
    expect(resolveContextNodeProvenance(oas, NODE, allow)).toEqual({
      slotId: "ideaContext",
      kind: "resolve",
      anchor: "declaration",
    });
  });

  it("verifier/injector collision parity: any generated id present in bytes ⇒ null", () => {
    for (const collidingId of [
      "ctx-ideaContext-resolve_context",
      "ctx-ideaContext-start",
      "context-ideaContext-subflow",
      "context_ideaContext",
    ]) {
      const oas = slimParentOas({
        extraRefs: {
          [collidingId]: {
            component_type: "ApiNode",
            id: collidingId,
            url: "{{CINATRA_BASE_URL}}/api/unrelated",
          },
        },
      });
      expect(resolveContextNodeProvenance(oas, NODE, allow)).toBeNull();
    }
  });

  it("node id present in bytes as a NON-context node never declaration-anchors", () => {
    const oas = slimParentOas({
      extraRefs: {
        [NODE]: {
          component_type: "OutputMessageNode",
          id: NODE,
          message: "not a context ApiNode",
        },
      },
    });
    expect(resolveContextNodeProvenance(oas, NODE, allow)).toBeNull();
  });

  it("legacy marker anchor still wins and is unchanged when bytes carry the node", () => {
    const oas = slimParentOas({
      childSlots: [],
      extraRefs: legacyMarkerRefs("legacySlot"),
    });
    expect(
      resolveContextNodeProvenance(oas, "ctx-legacySlot-resolve_context", allow),
    ).toEqual({ slotId: "legacySlot", kind: "resolve", anchor: "marker" });
  });
});

// ---------------------------------------------------------------------------
// evaluateContextAttestation end-to-end with a declaration-only spec.
// ---------------------------------------------------------------------------

describe("evaluateContextAttestation with declaration anchor", () => {
  const NODE = "ctx-ideaContext-resolve_context";
  const exp = Math.floor(Date.now() / 1000) + 60;
  const goodInput = (over: Record<string, unknown> = {}) => ({
    key: KEY,
    contextId: CTX,
    nodeIdHeader: NODE,
    attestationHeader: `v2:${exp}:${computeContextAttestationV2(KEY, CTX, NODE, exp)}`,
    runOas: slimParentOas(),
    slotId: "ideaContext",
    expectedKind: "resolve" as const,
    allowDeclarationAnchor: true,
    ...over,
  });

  it("passes with anchor=declaration on the token path", () => {
    expect(evaluateContextAttestation(goodInput())).toEqual({
      ok: true,
      slotId: "ideaContext",
      kind: "resolve",
      anchor: "declaration",
    });
  });

  it("fails closed without the token-path gate", () => {
    const res = evaluateContextAttestation(
      goodInput({ allowDeclarationAnchor: false }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_node_unrecognized");
  });

  it("kind mismatch across the declaration anchor fails closed", () => {
    const res = evaluateContextAttestation(
      goodInput({ expectedKind: "finalize" }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_kind_mismatch");
  });

  it("slot mismatch across the declaration anchor fails closed", () => {
    const res = evaluateContextAttestation(goodInput({ slotId: "otherSlot" }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_slot_mismatch");
  });

  it("a forged signature still fails before any anchoring", () => {
    const res = evaluateContextAttestation(
      goodInput({ attestationHeader: `v2:${exp}:${"0".repeat(64)}` }),
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("attestation_invalid");
  });
});

// ---------------------------------------------------------------------------
// findBoundChildPackageForSlot — declaration join.
// ---------------------------------------------------------------------------

describe("findBoundChildPackageForSlot declaration join", () => {
  const allow = { allowDeclarationBinding: true };

  it("binds the declared slot to the referencing FlowNode's package", () => {
    expect(
      findBoundChildPackageForSlot(slimParentOas(), "ideaContext", allow),
    ).toBe("@cinatra-ai/child-agent");
  });

  it("gate off ⇒ null", () => {
    expect(findBoundChildPackageForSlot(slimParentOas(), "ideaContext")).toBeNull();
    expect(
      findBoundChildPackageForSlot(slimParentOas(), "ideaContext", {
        allowDeclarationBinding: false,
      }),
    ).toBeNull();
  });

  it("root-level declarations contribute no owner (composed path must 403)", () => {
    const oas = slimParentOas({
      childSlots: [],
      rootSlots: [slotDecl("rootSlot")],
    });
    expect(findBoundChildPackageForSlot(oas, "rootSlot", allow)).toBeNull();
  });

  it("two children declaring the same slot ⇒ null (ambiguous)", () => {
    const oas = slimParentOas({
      secondChild: true,
      secondChildSlots: [slotDecl("ideaContext")],
    });
    expect(findBoundChildPackageForSlot(oas, "ideaContext", allow)).toBeNull();
  });

  it("duplicate declaration within the carrier ⇒ null", () => {
    const oas = slimParentOas({
      childSlots: [slotDecl("ideaContext"), slotDecl("ideaContext")],
    });
    expect(findBoundChildPackageForSlot(oas, "ideaContext", allow)).toBeNull();
  });

  it("carrier-predicate parity: a declarer with null/array refs never binds", () => {
    const oas = slimParentOas({ childSlots: [] }) as Record<string, unknown>;
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    refs["weird-def"] = {
      component_type: "Flow",
      id: "weird-def",
      $referenced_components: null,
      metadata: { cinatra: { contextSlots: [slotDecl("weirdSlot")] } },
    };
    refs["weird_flow"] = {
      component_type: "FlowNode",
      id: "weird_flow",
      subflow: { $component_ref: "weird-def" },
      metadata: { cinatra: { packageName: "@cinatra-ai/weird-agent" } },
    };
    expect(findBoundChildPackageForSlot(oas, "weirdSlot", allow)).toBeNull();
  });

  it("a definition without a package-named referencer ⇒ null", () => {
    const oas = slimParentOas();
    // Strip the packageName from the referencing FlowNode.
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    (refs["child_flow"] as Record<string, unknown>)["metadata"] = {};
    expect(findBoundChildPackageForSlot(oas, "ideaContext", allow)).toBeNull();
  });

  it("ANY marker for the slot keeps the legacy join authoritative", () => {
    // A legacy marker exists for the slot but its def has no package-named
    // referencer → legacy join yields null; the declaration join must NOT
    // rescue it (marker presence = legacy authoritative).
    const oas = slimParentOas({
      extraRefs: {
        stray_marker: {
          component_type: "FlowNode",
          id: "stray_marker",
          metadata: {
            cinatra: {
              purpose: "author-placed-context-resolution-for-ideaContext",
            },
          },
        },
      },
    });
    expect(findBoundChildPackageForSlot(oas, "ideaContext", allow)).toBeNull();
  });

  it("legacy marker join is unchanged for compiled parents", () => {
    const oas = slimParentOas({ childSlots: [] }) as Record<string, unknown>;
    const refs = oas["$referenced_components"] as Record<string, unknown>;
    // Reuse the real compiled topology: marker INSIDE the child def, package
    // on the referencing FlowNode.
    refs["legacy-child-subflow"] = {
      component_type: "Flow",
      id: "legacy-child-subflow",
      start_node: { $component_ref: "lc__start" },
      nodes: [],
      $referenced_components: {
        lc__start: { component_type: "StartNode", id: "lc__start" },
        lc__marker: {
          component_type: "FlowNode",
          id: "lc__marker",
          subflow: { $component_ref: "lc__ctx-subflow" },
          metadata: {
            cinatra: {
              purpose: "author-placed-context-resolution-for-legacySlot",
            },
          },
        },
      },
    };
    refs["legacy_flow"] = {
      component_type: "FlowNode",
      id: "legacy_flow",
      subflow: { $component_ref: "legacy-child-subflow" },
      metadata: { cinatra: { packageName: "@cinatra-ai/legacy-child" } },
    };
    expect(findBoundChildPackageForSlot(oas, "legacySlot")).toBe(
      "@cinatra-ai/legacy-child",
    );
    expect(findBoundChildPackageForSlot(oas, "legacySlot", allow)).toBe(
      "@cinatra-ai/legacy-child",
    );
  });
});
