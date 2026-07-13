import { describe, it, expect, beforeEach } from "vitest";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import {
  computePreResolvedEdgeMaps,
  publishPreResolvedEdgeMaps,
  getPreResolvedVersionedEdges,
  substituteEdgeBoundCapabilityProviders,
  EdgeBoundCapabilityRefusal,
  __resetPreResolvedEdgesForTests,
} from "@/lib/extension-pre-resolved-edges";
import {
  beginVersionKeyedRegistration,
  __resetVersionKeyedServingForTests,
} from "@/lib/extension-version-keyed-serving";

// cinatra#1392 S8 — the SYNC consume side of edge-bound serving: the loader's
// pre-resolved versioned-pin maps + the fail-closed capability substitution
// `HostCapabilitiesPort.resolveProviders` applies (sync by ABI — no per-call DB
// read possible).

const CALLER = "@x/caller";
const TARGET = "@x/dep";
const V = "0.1.4";
const CAP = "email-send";

function row(over: Partial<InstalledExtension> & { id: string }): InstalledExtension {
  return {
    packageName: TARGET,
    status: "active",
    organizationId: "org-1",
    ownerLevel: "organization",
    ownerId: null,
    isDefault: true,
    dependencyEdges: [],
    ...over,
  } as unknown as InstalledExtension;
}

function edgeTo(packageName: string, resolvedInstallId: string) {
  return {
    packageName,
    edgeType: "runtime" as const,
    versionConstraint: { kind: "exact" as const, version: V },
    requirement: "required" as const,
    resolvedInstallId,
    resolutionReason: "test-fixture",
  };
}

const DEFAULT_ID = { version: null, isDefault: true };

beforeEach(() => {
  __resetPreResolvedEdgesForTests();
  __resetVersionKeyedServingForTests();
});

describe("computePreResolvedEdgeMaps", () => {
  it("a LIVE row's edge to a LIVE non-default versioned row becomes a pin, keyed by the dependent's identity", () => {
    const rows = [
      row({ id: "i-caller", packageName: CALLER, dependencyEdges: [edgeTo(TARGET, "i-sib")] }),
      row({ id: "i-sib", isDefault: false, version: V }),
    ];
    const maps = computePreResolvedEdgeMaps(rows);
    publishPreResolvedEdgeMaps(maps);
    // Composite alias (identity-less consult) AND the exact row-id key both serve.
    const pins = getPreResolvedVersionedEdges(CALLER, DEFAULT_ID);
    expect(pins?.get(TARGET)).toEqual({ kind: "versioned", version: V, resolvedInstallId: "i-sib" });
    const byId = getPreResolvedVersionedEdges(CALLER, { installId: "i-caller", version: null, isDefault: true });
    expect(byId?.get(TARGET)).toEqual({ kind: "versioned", version: V, resolvedInstallId: "i-sib" });
  });

  it("a default-resolved edge adds NO pin (the global registration IS that version)", () => {
    const rows = [
      row({ id: "i-caller", packageName: CALLER, dependencyEdges: [edgeTo("@x/def", "i-def")] }),
      row({ id: "i-def", packageName: "@x/def" }),
    ];
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps(rows));
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeUndefined();
  });

  it("dangling / not-live / versionless edges become explicit REFUSE pins (codex round-0 #2)", () => {
    const rows = [
      row({
        id: "i-caller",
        packageName: CALLER,
        dependencyEdges: [
          edgeTo("@x/gone", "i-gone"), // dangling
          edgeTo("@x/dead", "i-dead"), // archived target
          edgeTo("@x/nover", "i-nover"), // non-default without a version
        ],
      }),
      row({ id: "i-dead", packageName: "@x/dead", status: "archived", isDefault: false, version: V }),
      row({ id: "i-nover", packageName: "@x/nover", isDefault: false, version: undefined }),
    ];
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps(rows));
    const pins = getPreResolvedVersionedEdges(CALLER, DEFAULT_ID);
    expect(pins?.get("@x/gone")).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_RESOLVED_MISSING" });
    expect(pins?.get("@x/dead")).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_RESOLVED_NOT_LIVE" });
    expect(pins?.get("@x/nover")).toMatchObject({ kind: "refuse", code: "EDGE_BOUND_VERSION_UNPINNED" });
    // Any capability consult under a refuse pin THROWS with that evidence.
    expect(() =>
      substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [
        { packageName: "@x/gone", impl: { tag: "default" } },
      ]),
    ).toThrowError(EdgeBoundCapabilityRefusal);
  });

  it("a composite-key collision drops the alias for every claimant (never another row's pins); id keys stay exact", () => {
    // Two same-shape (package, default) rows — e.g. cross-org — with DIFFERENT pins.
    const rows = [
      row({ id: "i-org-a", packageName: CALLER, organizationId: "org-a", dependencyEdges: [edgeTo(TARGET, "i-sib")] }),
      row({ id: "i-org-b", packageName: CALLER, organizationId: "org-b", dependencyEdges: [edgeTo("@x/other-dep", "i-sib2")] }),
      row({ id: "i-sib", isDefault: false, version: V }),
      row({ id: "i-sib2", packageName: "@x/other-dep", isDefault: false, version: "2.0.0" }),
    ];
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps(rows));
    // Identity-less consult finds NOTHING (fail-closed against cross-row leaks).
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeUndefined();
    // Exact ids each resolve their OWN pins.
    expect(
      getPreResolvedVersionedEdges(CALLER, { installId: "i-org-a", version: null, isDefault: true })?.get(TARGET),
    ).toEqual({ kind: "versioned", version: V, resolvedInstallId: "i-sib" });
    expect(
      getPreResolvedVersionedEdges(CALLER, { installId: "i-org-b", version: null, isDefault: true })?.get("@x/other-dep"),
    ).toEqual({ kind: "versioned", version: "2.0.0", resolvedInstallId: "i-sib2" });
  });

  it("a NON-DEFAULT dependent's map is keyed by ITS version (never the default slot)", () => {
    const rows = [
      row({
        id: "i-caller-sib",
        packageName: CALLER,
        isDefault: false,
        version: "9.9.9",
        dependencyEdges: [edgeTo(TARGET, "i-sib")],
      }),
      row({ id: "i-sib", isDefault: false, version: V }),
    ];
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps(rows));
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeUndefined();
    expect(
      getPreResolvedVersionedEdges(CALLER, { version: "9.9.9", isDefault: false })?.get(TARGET),
    ).toEqual({ kind: "versioned", version: V, resolvedInstallId: "i-sib" });
  });

  it("publish REPLACES (a removed install leaves no stale pins)", () => {
    publishPreResolvedEdgeMaps(
      computePreResolvedEdgeMaps([
        row({ id: "i-caller", packageName: CALLER, dependencyEdges: [edgeTo(TARGET, "i-sib")] }),
        row({ id: "i-sib", isDefault: false, version: V }),
      ]),
    );
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeDefined();
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps([]));
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeUndefined();
  });
});

describe("substituteEdgeBoundCapabilityProviders — fail-closed matrix", () => {
  const defaultProvider = { packageName: TARGET, impl: { tag: "default" } };
  const otherProvider = { packageName: "@x/unrelated", impl: { tag: "other" } };

  function publishPin() {
    publishPreResolvedEdgeMaps(
      computePreResolvedEdgeMaps([
        row({ id: "i-caller", packageName: CALLER, dependencyEdges: [edgeTo(TARGET, "i-sib")] }),
        row({ id: "i-sib", isDefault: false, version: V }),
      ]),
    );
  }

  it("no pins → the base list UNCHANGED (byte-identical pre-S8)", () => {
    const base = [defaultProvider, otherProvider];
    expect(substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, base)).toBe(base);
  });

  it("pinned + retained provider → SUBSTITUTED for the default's entry (order preserved)", () => {
    publishPin();
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "versioned" } });
    sink.commit();
    const out = substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [
      defaultProvider,
      otherProvider,
    ]);
    expect(out.map((p) => (p.impl as { tag: string }).tag)).toEqual(["versioned", "other"]);
  });

  it("pinned + version registered NO provider for the capability → the default's entry is DROPPED", () => {
    publishPin();
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainCapabilityProvider("some-other-cap", { packageName: TARGET, impl: {} });
    sink.commit();
    const out = substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [
      defaultProvider,
      otherProvider,
    ]);
    expect(out.map((p) => (p.impl as { tag: string }).tag)).toEqual(["other"]);
  });

  it("UNION: a pinned target absent from the base list still contributes its retained provider", () => {
    publishPin();
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainCapabilityProvider(CAP, { packageName: TARGET, impl: { tag: "versioned" } });
    sink.commit();
    const out = substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [otherProvider]);
    expect(out.map((p) => (p.impl as { tag: string }).tag)).toEqual(["other", "versioned"]);
  });

  it("pinned + version NEVER retained → THROWS (torn retention; never the default)", () => {
    publishPin();
    expect(() =>
      substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [defaultProvider]),
    ).toThrowError(EdgeBoundCapabilityRefusal);
    try {
      substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [defaultProvider]);
    } catch (err) {
      expect((err as EdgeBoundCapabilityRefusal).code).toBe("UNKNOWN_VERSION");
    }
  });

  it("pinned + retained-but-uncommitted → THROWS NOT_SERVABLE", () => {
    publishPin();
    const sink = beginVersionKeyedRegistration(TARGET, V);
    sink.retainCapabilityProvider(CAP, { packageName: TARGET, impl: {} });
    // no commit
    try {
      substituteEdgeBoundCapabilityProviders(CALLER, DEFAULT_ID, CAP, [defaultProvider]);
      throw new Error("expected a refusal");
    } catch (err) {
      expect((err as EdgeBoundCapabilityRefusal).code).toBe("NOT_SERVABLE");
    }
  });
});

// codex S8 round-1 #1 — a PINLESS same-shape live row is still an alias claimant.
describe("composite alias — pinless claimants count (round-1)", () => {
  it("a pinned row + a PINLESS same-shape row → alias dropped; id keys exact", () => {
    const rows = [
      row({ id: "i-pinned", packageName: CALLER, organizationId: "org-a", dependencyEdges: [edgeTo(TARGET, "i-sib")] }),
      row({ id: "i-pinless", packageName: CALLER, organizationId: "org-b", dependencyEdges: [] }),
      row({ id: "i-sib", isDefault: false, version: V }),
    ];
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps(rows));
    // Identity-less consult must NOT see the pinned sibling's edges.
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeUndefined();
    expect(
      getPreResolvedVersionedEdges(CALLER, { installId: "i-pinned", version: null, isDefault: true })?.get(TARGET),
    ).toEqual({ kind: "versioned", version: V, resolvedInstallId: "i-sib" });
    expect(
      getPreResolvedVersionedEdges(CALLER, { installId: "i-pinless", version: null, isDefault: true }),
    ).toBeUndefined();
  });
});
