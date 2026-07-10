// Resolved-edge validation in the closure engine (cinatra#1040 S2).
//
// Edges persisted in `extension_dependency_edge` carry a write-time
// resolution (`resolvedInstallId`); when the gates receive a full snapshot
// they VALIDATE the pinned row directly and fall back to the DECLARING row's
// scoped name-lookup for unresolved edges. This suite pins the preference
// matrix, the archive-gate narrowing, the update-gate id-binding, and the
// intentional transitive-scope correction.
import { describe, expect, it } from "vitest";

import type {
  ExtensionDependency,
  InstalledExtension,
  ResolvedDependencyEdge,
} from "../canonical-types";
import {
  assertUpdateDoesNotBreakDependents,
  computeClosure,
  DependencyClosureError,
  edgesOf,
  listArchiveClosureBlockers,
  listArchiveClosureBlockersForPackage,
  makeScopedManifestLookup,
} from "../dependency-closure";

let seq = 0;
function ext(
  packageName: string,
  status: InstalledExtension["status"],
  opts: {
    id?: string;
    organizationId?: string | null;
    version?: string;
    deps?: ExtensionDependency[];
    edges?: ResolvedDependencyEdge[];
  } = {},
): InstalledExtension {
  return {
    id: opts.id ?? `id-${packageName}-${++seq}`,
    packageName,
    ownerLevel: opts.organizationId != null ? "organization" : "platform",
    ownerId: opts.organizationId ?? null,
    organizationId: opts.organizationId ?? null,
    kind: "agent",
    status,
    source:
      opts.version !== undefined
        ? {
            type: "verdaccio",
            registryUrl: "http://localhost:4873",
            packageName,
            version: opts.version,
            integrity: "sha512-x",
          }
        : { type: "local", path: `/x/${packageName}`, resolvedCommitOrTreeHash: "h" },
    requiredInProd: false,
    dependencies: opts.deps ?? (opts.edges ?? []).map(({ resolvedInstallId: _r, resolutionReason: _w, ...d }) => d),
    ...(opts.edges ? { dependencyEdges: opts.edges } : {}),
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function reqEdge(
  packageName: string,
  resolvedInstallId: string | null,
  range = "*",
): ResolvedDependencyEdge {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range },
    requirement: "required",
    resolvedInstallId,
    resolutionReason: resolvedInstallId ? "test:pinned" : null,
  };
}

describe("edgesOf", () => {
  it("prefers persisted dependencyEdges and falls back to unresolved declared deps", () => {
    const withEdges = ext("a", "active", { edges: [reqEdge("b", "id-b")] });
    expect(edgesOf(withEdges)[0]!.resolvedInstallId).toBe("id-b");

    const fixture = ext("a", "active", {
      deps: [
        {
          packageName: "b",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "*" },
          requirement: "required",
        },
      ],
    });
    expect(edgesOf(fixture)).toEqual([
      expect.objectContaining({ packageName: "b", resolvedInstallId: null, resolutionReason: null }),
    ]);
  });
});

describe("computeClosure over resolved edges (snapshot form)", () => {
  it("validates the PINNED row: live + satisfying → ok", () => {
    const b = ext("b", "active", { id: "id-b", version: "1.2.0" });
    const a = ext("a", "active", { edges: [reqEdge("b", "id-b", "^1.0.0")] });
    const snapshot = [a, b];
    const result = computeClosure(a, makeScopedManifestLookup(snapshot, a.organizationId), snapshot);
    expect(result.ok).toBe(true);
    expect(result.rangeViolations).toEqual([]);
  });

  it("a resolved edge pinned to an ARCHIVED row is missing (id-validation, fail closed)", () => {
    const bArchived = ext("b", "archived", { id: "id-b-old" });
    const a = ext("a", "active", { edges: [reqEdge("b", "id-b-old")] });
    const snapshot = [a, bArchived];
    const result = computeClosure(a, makeScopedManifestLookup(snapshot, a.organizationId), snapshot);
    expect(result.ok).toBe(false);
    expect(result.missingRequired).toEqual([
      expect.objectContaining({ packageName: "b", status: "archived" }),
    ]);
  });

  it("a resolved edge pinned to a RANGE-VIOLATING row surfaces the violation", () => {
    const b = ext("b", "active", { id: "id-b", version: "0.9.0" });
    const a = ext("a", "active", { edges: [reqEdge("b", "id-b", "^1.0.0")] });
    const snapshot = [a, b];
    const result = computeClosure(a, makeScopedManifestLookup(snapshot, a.organizationId), snapshot);
    expect(result.rangeViolations).toEqual([
      expect.objectContaining({ packageName: "b", installedVersion: "0.9.0" }),
    ]);
  });

  it("an UNRESOLVED edge heals through the scoped name-lookup (dep installed later)", () => {
    const b = ext("b", "active", { id: "id-b-later" });
    const a = ext("a", "active", { edges: [reqEdge("b", null)] });
    const snapshot = [a, b];
    const result = computeClosure(a, makeScopedManifestLookup(snapshot, a.organizationId), snapshot);
    expect(result.ok).toBe(true);
  });

  it("a resolved id ABSENT from the snapshot (target deleted) falls back to the name-lookup", () => {
    const bReinstalled = ext("b", "active", { id: "id-b-new" });
    const a = ext("a", "active", { edges: [reqEdge("b", "id-b-deleted")] });
    const snapshot = [a, bReinstalled];
    const result = computeClosure(a, makeScopedManifestLookup(snapshot, a.organizationId), snapshot);
    expect(result.ok).toBe(true);
  });

  it("fixture rows WITHOUT persisted edges keep the exact pre-S2 name semantics", () => {
    const a = ext("a", "active", {
      deps: [
        {
          packageName: "b",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "*" },
          requirement: "required",
        },
      ],
    });
    const b = ext("b", "locked", {});
    const lookup = (n: string) => ({ a, b } as Record<string, InstalledExtension>)[n];
    expect(computeClosure(a, lookup).ok).toBe(true);
    const lookupMissing = (n: string) => ({ a } as Record<string, InstalledExtension>)[n];
    expect(computeClosure(a, lookupMissing).ok).toBe(false);
  });

  it("TRANSITIVE SCOPE CORRECTION: a platform intermediate's edge binds the platform row, not the org root's row", () => {
    // org root → platform intermediate → dep with BOTH org and platform rows.
    // Pre-S2 the walk reused the ROOT's scoped lookup, so the intermediate's
    // edge bound the ORG row (version-violating here). Post-S2 the edge
    // resolves per-DECLARING-row: the platform intermediate binds the
    // PLATFORM row (satisfying) — the ratified semantic correction.
    const depOrg = ext("dep", "active", { id: "id-dep-org", organizationId: "org1", version: "0.1.0" });
    const depPlatform = ext("dep", "active", { id: "id-dep-platform", version: "2.0.0" });
    const intermediate = ext("mid", "active", { id: "id-mid", edges: [reqEdge("dep", null, "^2.0.0")] });
    const root = ext("root", "active", {
      organizationId: "org1",
      edges: [reqEdge("mid", "id-mid")],
    });
    const snapshot = [root, intermediate, depOrg, depPlatform];
    const result = computeClosure(
      root,
      makeScopedManifestLookup(snapshot, root.organizationId),
      snapshot,
    );
    expect(result.ok).toBe(true);
    expect(result.rangeViolations).toEqual([]);
  });
});

describe("listArchiveClosureBlockers narrowing (resolved edges)", () => {
  it("an id-resolved edge blocks ONLY the exact row it resolved to — the sibling version is orphanable", () => {
    const d1 = ext("d", "active", { id: "id-d1", version: "1.0.0" });
    const d2 = ext("d", "active", { id: "id-d2", version: "2.0.0" });
    const dependent = ext("a", "active", { edges: [reqEdge("d", "id-d1", "^1.0.0")] });
    const allRows = [dependent, d1, d2];
    expect(listArchiveClosureBlockers(d1, allRows)).toEqual(["a"]);
    expect(listArchiveClosureBlockers(d2, allRows)).toEqual([]);
  });

  it("an UNRESOLVED edge keeps the conservative package-name block on every row of the package", () => {
    const d1 = ext("d", "active", { id: "id-d1" });
    const d2 = ext("d", "active", { id: "id-d2" });
    const dependent = ext("a", "active", { edges: [reqEdge("d", null)] });
    const allRows = [dependent, d1, d2];
    expect(listArchiveClosureBlockers(d1, allRows)).toEqual(["a"]);
    expect(listArchiveClosureBlockers(d2, allRows)).toEqual(["a"]);
  });

  it("fixture rows without persisted edges keep the pre-S2 name-based block", () => {
    const d = ext("d", "active", { id: "id-d" });
    const dependent = ext("a", "active", {
      deps: [
        {
          packageName: "d",
          edgeType: "runtime",
          versionConstraint: { kind: "semver-range", range: "*" },
          requirement: "required",
        },
      ],
    });
    expect(listArchiveClosureBlockers(d, [dependent, d])).toEqual(["a"]);
  });

  it("PACKAGE-LEVEL union: a name-only gate blocks when ANY row of the package is pinned", () => {
    // The dispatcher/removal gates archive by package NAME (the exact row is
    // resolved after the gate) — a dependent pinned to ANY row of the package
    // must block, exactly the pre-S2 conservative name-based set.
    const d1 = ext("d", "active", { id: "id-d1" });
    const d2 = ext("d", "active", { id: "id-d2" });
    const dependent = ext("a", "active", { edges: [reqEdge("d", "id-d2")] });
    const allRows = [dependent, d1, d2];
    // Row-level narrowing would clear d1 — but the package-level gate cannot
    // know which row the archive will touch, so the union blocks.
    expect(listArchiveClosureBlockers(d1, allRows)).toEqual([]);
    expect(listArchiveClosureBlockersForPackage("d", allRows)).toEqual(["a"]);
    // No dependent at all → the package is archivable.
    expect(listArchiveClosureBlockersForPackage("d", [d1, d2])).toEqual([]);
  });
});

describe("makeScopedManifestLookup default preference", () => {
  it("prefers the DEFAULT version within a scope, deterministic id tie-break", () => {
    // Two live rows of one package in the SAME scope (side-by-side versions,
    // S1): the unresolved-edge fallback must bind the default — the same
    // preference the write-time resolver and the core__0024 backfill apply.
    const nonDefault = ext("d", "active", { id: "id-a-nondefault" });
    (nonDefault as { isDefault?: boolean }).isDefault = false;
    const dflt = ext("d", "active", { id: "id-z-default" });
    (dflt as { isDefault?: boolean }).isDefault = true;
    expect(makeScopedManifestLookup([nonDefault, dflt], null)("d")?.id).toBe("id-z-default");
    // All-default (or fixture rows without the flag): lowest id wins.
    const f1 = ext("e", "active", { id: "id-1" });
    const f2 = ext("e", "active", { id: "id-2" });
    expect(makeScopedManifestLookup([f2, f1], null)("e")?.id).toBe("id-1");
  });
});

describe("assertUpdateDoesNotBreakDependents over resolved edges", () => {
  it("a dependent bound by resolvedInstallId blocks the pinned row's violating update", () => {
    const d = ext("d", "active", { id: "id-d", version: "1.4.0" });
    const dependent = ext("a", "active", { edges: [reqEdge("d", "id-d", "^1.0.0")] });
    expect(() => assertUpdateDoesNotBreakDependents("d", "2.0.0", [dependent, d])).toThrow(
      DependencyClosureError,
    );
  });

  it("a dependent whose edge resolved to a DIFFERENT row does not block the sibling's update", () => {
    const d1 = ext("d", "active", { id: "id-d1", organizationId: "org1", version: "1.4.0" });
    const d2 = ext("d", "active", { id: "id-d2", version: "1.4.0" });
    const dependent = ext("a", "active", {
      organizationId: "org1",
      edges: [reqEdge("d", "id-d1", "^1.0.0")],
    });
    // updating the PLATFORM row (id-d2) to a version outside the dependent's
    // range: the dependent's edge is pinned to the ORG row, so no block.
    expect(() =>
      assertUpdateDoesNotBreakDependents("d", "2.0.0", [dependent, d1, d2], {
        organizationId: null,
      }),
    ).not.toThrow();
  });
});
