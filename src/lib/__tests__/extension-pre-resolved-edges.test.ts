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
    const pins = getPreResolvedVersionedEdges(CALLER, DEFAULT_ID);
    expect(pins?.get(TARGET)).toEqual({ version: V, resolvedInstallId: "i-sib" });
  });

  it("default-resolved / dangling / not-live / versionless edges add NO pin", () => {
    const rows = [
      row({
        id: "i-caller",
        packageName: CALLER,
        dependencyEdges: [
          edgeTo("@x/def", "i-def"), // resolves to the default → global serve
          edgeTo("@x/gone", "i-gone"), // dangling
          edgeTo("@x/dead", "i-dead"), // archived target
          edgeTo("@x/nover", "i-nover"), // non-default without a version
        ],
      }),
      row({ id: "i-def", packageName: "@x/def" }),
      row({ id: "i-dead", packageName: "@x/dead", status: "archived", isDefault: false, version: V }),
      row({ id: "i-nover", packageName: "@x/nover", isDefault: false, version: undefined }),
    ];
    publishPreResolvedEdgeMaps(computePreResolvedEdgeMaps(rows));
    expect(getPreResolvedVersionedEdges(CALLER, DEFAULT_ID)).toBeUndefined();
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
    ).toEqual({ version: V, resolvedInstallId: "i-sib" });
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
