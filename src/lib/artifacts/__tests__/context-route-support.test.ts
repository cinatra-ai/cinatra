import { describe, it, expect } from "vitest";
import type { AgentContextSlot } from "@cinatra-ai/extensions/agent-context-slots-reader";
import {
  normalizeProjectId,
  buildSlotMeta,
  computeAutonomousSelectedRefs,
  computeRouteSelectedRefs,
  refTripleKey,
  canonicalizeTriples,
  computeSelectionKey,
  parseUserResponseEnvelope,
  revalidateSelectedRefs,
  buildSelectionRows,
  ContextRouteError,
  type ContextCandidate,
} from "../context-route-support";

function cand(
  id: string,
  scope: ContextCandidate["sourceScope"] = "user",
  ext = "@cinatra-ai/marketing-icp-artifact",
): ContextCandidate {
  return {
    artifactId: `art-${id}`,
    representationRevisionId: `rev-${id}`,
    semanticAssertionId: `sa-${id}`,
    extension: ext,
    sourceScope: scope,
    ownerId: `owner-${id}`,
  };
}

function slot(over: Partial<AgentContextSlot> = {}): AgentContextSlot {
  return {
    slotId: "offeringContext",
    acceptedArtifactExtensions: ["@cinatra-ai/marketing-icp-artifact"],
    selectionMode: "interactive",
    resolutionMode: "accumulate",
    minItems: 0,
    maxItems: 5,
    readableOnly: true,
    ...over,
  };
}

describe("normalizeProjectId", () => {
  it("maps empty / whitespace / non-string to undefined; preserves a real id", () => {
    expect(normalizeProjectId("")).toBeUndefined();
    expect(normalizeProjectId("   ")).toBeUndefined();
    expect(normalizeProjectId(undefined)).toBeUndefined();
    expect(normalizeProjectId(42)).toBeUndefined();
    expect(normalizeProjectId("proj-1")).toBe("proj-1");
  });
});

describe("buildSlotMeta", () => {
  it("OMITS maxItems when unbounded (never emits 0)", () => {
    const m = buildSlotMeta(slot({ maxItems: undefined }));
    expect("maxItems" in m).toBe(false);
    expect(m.minItems).toBe(0);
    expect(m.readableOnly).toBe(true);
    expect(m.acceptedArtifactExtensions).toEqual(["@cinatra-ai/marketing-icp-artifact"]);
  });
  it("includes maxItems when bounded", () => {
    expect(buildSlotMeta(slot({ maxItems: 3 })).maxItems).toBe(3);
  });
});

describe("computeAutonomousSelectedRefs", () => {
  it("override collapses to the single narrowest ref", () => {
    const refs = computeAutonomousSelectedRefs(
      [cand("a"), cand("b"), cand("c")],
      slot({ resolutionMode: "override" }),
    );
    expect(refs).toHaveLength(1);
    expect(refs[0].artifactId).toBe("art-a");
  });
  it("accumulate keeps all, capped at maxItems", () => {
    const refs = computeAutonomousSelectedRefs(
      [cand("a"), cand("b"), cand("c")],
      slot({ resolutionMode: "accumulate", maxItems: 2 }),
    );
    expect(refs.map((r) => r.artifactId)).toEqual(["art-a", "art-b"]);
  });
  it("empty candidates → empty selection", () => {
    expect(computeAutonomousSelectedRefs([], slot())).toEqual([]);
  });
});

describe("computeRouteSelectedRefs", () => {
  it("interactive → [] (the user picks)", () => {
    expect(
      computeRouteSelectedRefs([cand("a")], slot({ selectionMode: "interactive" })),
    ).toEqual([]);
  });
  it("autonomous → pre-selected", () => {
    expect(
      computeRouteSelectedRefs([cand("a")], slot({ selectionMode: "autonomous" })),
    ).toHaveLength(1);
  });
});

describe("computeSelectionKey", () => {
  const base = {
    parentRunId: "run-1",
    parentPackageName: "@cinatra-ai/email-outreach-agent",
    slotId: "offeringContext",
    selectionMode: "interactive" as const,
  };
  it("is order-independent + dedup-stable (same set → same key)", () => {
    const k1 = computeSelectionKey({ ...base, refs: [cand("a"), cand("b")] });
    const k2 = computeSelectionKey({ ...base, refs: [cand("b"), cand("a"), cand("a")] });
    expect(k1).toBe(k2);
  });
  it("changes when the selected set changes", () => {
    const k1 = computeSelectionKey({ ...base, refs: [cand("a")] });
    const k2 = computeSelectionKey({ ...base, refs: [cand("a"), cand("b")] });
    expect(k1).not.toBe(k2);
  });
  it("changes when selectionMode changes (autonomous vs interactive)", () => {
    const k1 = computeSelectionKey({ ...base, refs: [cand("a")] });
    const k2 = computeSelectionKey({ ...base, selectionMode: "autonomous", refs: [cand("a")] });
    expect(k1).not.toBe(k2);
  });
  it("is a 64-char hex digest (safe LIKE prefix)", () => {
    const k = computeSelectionKey({ ...base, refs: [cand("a")] });
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("refTripleKey / canonicalizeTriples", () => {
  it("dedupes + sorts triples", () => {
    const out = canonicalizeTriples([cand("b"), cand("a"), cand("a")]);
    expect(out).toEqual([refTripleKey(cand("a")), refTripleKey(cand("b"))].sort());
    expect(out).toHaveLength(2);
  });
});

describe("parseUserResponseEnvelope", () => {
  it("parses a valid envelope", () => {
    const env = parseUserResponseEnvelope(
      JSON.stringify({
        slotId: "offeringContext",
        resolutionMode: "override",
        selectedRefs: [cand("a")],
      }),
    );
    expect(env.slotId).toBe("offeringContext");
    expect(env.resolutionMode).toBe("override");
    expect(env.selectedRefs[0].artifactId).toBe("art-a");
  });
  it("rejects non-JSON", () => {
    expect(() => parseUserResponseEnvelope("not json")).toThrow(ContextRouteError);
  });
  it("rejects a missing slotId", () => {
    expect(() =>
      parseUserResponseEnvelope(JSON.stringify({ resolutionMode: "accumulate", selectedRefs: [] })),
    ).toThrow(ContextRouteError);
  });
  it("defaults resolutionMode to accumulate + selectedRefs to []", () => {
    const env = parseUserResponseEnvelope(JSON.stringify({ slotId: "s" }));
    expect(env.resolutionMode).toBe("accumulate");
    expect(env.selectedRefs).toEqual([]);
  });
});

describe("revalidateSelectedRefs (security boundary)", () => {
  const candidates = [cand("a"), cand("b"), cand("c")];
  it("returns TRUSTED candidates (not body-supplied fields)", () => {
    const forged = [{ ...cand("a"), extension: "@evil/x", sourceScope: "workspace" as const }];
    const trusted = revalidateSelectedRefs({ submitted: forged, candidates, slot: slot() });
    expect(trusted[0].extension).toBe("@cinatra-ai/marketing-icp-artifact"); // trusted, not forged
    expect(trusted[0].sourceScope).toBe("user");
  });
  it("rejects a ref not in the trusted candidate set", () => {
    expect(() =>
      revalidateSelectedRefs({ submitted: [cand("zzz")], candidates, slot: slot() }),
    ).toThrow(/not in the trusted candidate set/);
  });
  it("enforces minItems", () => {
    expect(() =>
      revalidateSelectedRefs({ submitted: [], candidates, slot: slot({ minItems: 1 }) }),
    ).toThrow(/below_min_items|minItems/);
  });
  it("enforces maxItems", () => {
    expect(() =>
      revalidateSelectedRefs({
        submitted: [cand("a"), cand("b"), cand("c")],
        candidates,
        slot: slot({ maxItems: 2 }),
      }),
    ).toThrow(/maxItems|above_max_items/);
  });
  it("rejects multi-select on an override slot", () => {
    expect(() =>
      revalidateSelectedRefs({
        submitted: [cand("a"), cand("b")],
        candidates,
        slot: slot({ resolutionMode: "override" }),
      }),
    ).toThrow(/override/);
  });
  it("dedupes a double-submitted ref", () => {
    const trusted = revalidateSelectedRefs({
      submitted: [cand("a"), cand("a")],
      candidates,
      slot: slot(),
    });
    expect(trusted).toHaveLength(1);
  });
});

describe("buildSelectionRows", () => {
  it("interactive → selectedBy:user; autonomous → selectedBy:autonomous", () => {
    const trusted = [cand("a")];
    const inter = buildSelectionRows({
      orgId: "org-1",
      parentRunId: "run-1",
      parentPackageName: "@cinatra-ai/email-outreach-agent",
      slotId: "offeringContext",
      selectionMode: "interactive",
      trusted,
    });
    expect(inter[0].selectedBy).toBe("user");
    expect(inter[0].selectionMode).toBe("interactive");
    expect(inter[0].extension).toBe("@cinatra-ai/marketing-icp-artifact");
    const auto = buildSelectionRows({
      orgId: "org-1",
      parentRunId: "run-1",
      parentPackageName: "@cinatra-ai/email-outreach-agent",
      slotId: "offeringContext",
      selectionMode: "autonomous",
      trusted,
    });
    expect(auto[0].selectedBy).toBe("autonomous");
    expect(auto[0].selectionMode).toBe("autonomous");
  });
});
