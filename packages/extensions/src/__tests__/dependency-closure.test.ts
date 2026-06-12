// Dependency closure tests.
import { describe, expect, it, vi } from "vitest";

import type { ExtensionDependency, InstalledExtension } from "../canonical-types";
import {
  DependencyClosureError,
  assertArchiveDoesNotBreakClosure,
  assertInstallClosure,
  computeClosure,
  evaluateExecutionClosure,
  findBrokenClosures,
  makeScopedManifestLookup,
  optionalMissingBehaviorForKind,
} from "../dependency-closure";

function ext(
  packageName: string,
  status: InstalledExtension["status"],
  deps: ExtensionDependency[] = [],
  kind: InstalledExtension["kind"] = "agent",
): InstalledExtension {
  return {
    id: `id-${packageName}`,
    packageName,
    ownerLevel: "platform",
    ownerId: null,
    organizationId: null,
    kind,
    status,
    source: { type: "local", path: `/x/${packageName}`, resolvedCommitOrTreeHash: "h" },
    requiredInProd: false,
    dependencies: deps,
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

function req(packageName: string): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
  };
}
function opt(packageName: string): ExtensionDependency {
  return { ...req(packageName), requirement: "optional" };
}

describe("computeClosure", () => {
  it("returns ok when all required deps are active/locked", () => {
    const a = ext("a", "active", [req("b")]);
    const b = ext("b", "locked", []);
    const lookup = (n: string) => ({ a, b }[n]);
    const result = computeClosure(a, lookup);
    expect(result.ok).toBe(true);
    expect(result.missingRequired).toEqual([]);
  });

  it("flags required dep that is archived as missing", () => {
    const a = ext("a", "active", [req("b")]);
    const b = ext("b", "archived", []);
    const lookup = (n: string) => ({ a, b }[n]);
    const result = computeClosure(a, lookup);
    expect(result.ok).toBe(false);
    expect(result.missingRequired[0]?.packageName).toBe("b");
    expect(result.missingRequired[0]?.status).toBe("archived");
  });

  it("flags required dep that is not installed as missing", () => {
    const a = ext("a", "active", [req("ghost")]);
    const lookup = (n: string) => ({ a }[n]);
    const result = computeClosure(a, lookup);
    expect(result.ok).toBe(false);
    expect(result.missingRequired[0]?.status).toBe("missing");
  });

  it("optional missing does not break ok", () => {
    const a = ext("a", "active", [opt("maybe")]);
    const lookup = (n: string) => ({ a }[n]);
    const result = computeClosure(a, lookup);
    expect(result.ok).toBe(true);
    expect(result.missingOptional[0]?.packageName).toBe("maybe");
  });

  it("handles transitive closure + cycles", () => {
    const a = ext("a", "active", [req("b")]);
    const b = ext("b", "active", [req("c")]);
    const c = ext("c", "active", [req("a")]); // cycle back to a
    const lookup = (n: string) => ({ a, b, c }[n]);
    const result = computeClosure(a, lookup);
    expect(result.ok).toBe(true);
    expect(result.visited.sort()).toEqual(["a", "b", "c"]);
  });
});

describe("assertInstallClosure", () => {
  it("throws REQUIRED_MISSING when a required dep is absent", () => {
    const a = ext("a", "active", [req("ghost")]);
    const lookup = (n: string) => ({ a }[n]);
    try {
      assertInstallClosure(a, lookup);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyClosureError);
      expect((e as DependencyClosureError).code).toBe("REQUIRED_MISSING");
    }
  });
});

describe("assertArchiveDoesNotBreakClosure", () => {
  it("blocks archive when an active dependent requires the target", () => {
    const target = ext("lib", "active", []);
    const dependent = ext("app", "active", [req("lib")]);
    expect(() => assertArchiveDoesNotBreakClosure(target, [target, dependent])).toThrow(
      DependencyClosureError,
    );
  });

  it("allows archive when only archived dependents require the target", () => {
    const target = ext("lib", "active", []);
    const dependent = ext("app", "archived", [req("lib")]);
    expect(() => assertArchiveDoesNotBreakClosure(target, [target, dependent])).not.toThrow();
  });

  it("allows archive when dependents reference target optionally", () => {
    const target = ext("lib", "active", []);
    const dependent = ext("app", "active", [opt("lib")]);
    expect(() => assertArchiveDoesNotBreakClosure(target, [target, dependent])).not.toThrow();
  });
});

describe("optionalMissingBehaviorForKind", () => {
  it("declares per-kind behavior", () => {
    expect(optionalMissingBehaviorForKind("agent")).toBe("stop-run-hitl");
    expect(optionalMissingBehaviorForKind("connector")).toBe("skip-step-audit");
    expect(optionalMissingBehaviorForKind("skill")).toBe("log-continue");
    expect(optionalMissingBehaviorForKind("artifact")).toBe("log-continue");
    expect(optionalMissingBehaviorForKind("workflow")).toBe("fail-instantiate");
  });
});

describe("evaluateExecutionClosure (per-kind optional-missing dispatch)", () => {
  it("intact closure, nothing missing → clean verdict", () => {
    const a = ext("a", "active", [req("b")], "agent");
    const b = ext("b", "locked", []);
    const verdict = evaluateExecutionClosure(a, (n) => ({ a, b }[n]));
    expect(verdict.requiredClosureOk).toBe(true);
    expect(verdict.advisory).toBeNull();
    expect(verdict.executionBlock).toBeNull();
  });

  it("missing REQUIRED dep → executionBlock REQUIRED_MISSING for every kind", () => {
    for (const kind of ["agent", "connector", "skill", "artifact", "workflow"] as const) {
      const a = ext("a", "active", [req("ghost")], kind);
      const verdict = evaluateExecutionClosure(a, (n) => ({ a }[n]));
      expect(verdict.requiredClosureOk).toBe(false);
      expect(verdict.executionBlock).toEqual({ code: "REQUIRED_MISSING", missing: ["ghost"] });
    }
  });

  it("workflow with missing OPTIONAL dep → fail-instantiate executionBlock, required closure stays ok", () => {
    const wf = ext("wf", "active", [opt("maybe")], "workflow");
    const verdict = evaluateExecutionClosure(wf, (n) => ({ wf }[n]));
    expect(verdict.requiredClosureOk).toBe(true);
    expect(verdict.advisory?.behavior).toBe("fail-instantiate");
    expect(verdict.executionBlock).toEqual({
      code: "OPTIONAL_MISSING_FAILS_INSTANTIATE",
      missing: ["maybe"],
    });
  });

  it("agent/connector/skill/artifact with missing OPTIONAL dep → behavior-tagged advisory, NO executionBlock", () => {
    const expected = {
      agent: "stop-run-hitl",
      connector: "skip-step-audit",
      skill: "log-continue",
      artifact: "log-continue",
    } as const;
    for (const [kind, behavior] of Object.entries(expected)) {
      const a = ext("a", "active", [opt("maybe")], kind as keyof typeof expected);
      const verdict = evaluateExecutionClosure(a, (n) => ({ a }[n]));
      expect(verdict.requiredClosureOk).toBe(true);
      expect(verdict.executionBlock).toBeNull();
      expect(verdict.advisory).toMatchObject({ kind, behavior });
      expect(verdict.advisory?.missingOptional.map((d) => d.packageName)).toEqual(["maybe"]);
    }
  });

  it("closure is PRESENCE/STATUS-ONLY: a dep's versionConstraint is not evaluated", () => {
    // The dependency edge demands an impossible exact version; the dep is
    // present (active) at any version → satisfied. Version pinning for the
    // required-in-prod set is enforced by verifyRequiredInProdInstalled, not here.
    const dep: ExtensionDependency = {
      ...req("b"),
      versionConstraint: { kind: "exact", version: "999.999.999" },
    };
    const a = ext("a", "active", [dep], "workflow");
    const b = ext("b", "active", []);
    const verdict = evaluateExecutionClosure(a, (n) => ({ a, b }[n]));
    expect(verdict.requiredClosureOk).toBe(true);
    expect(verdict.executionBlock).toBeNull();
  });
});

describe("findBrokenClosures (boot diagnostics)", () => {
  it("finds an active row whose required dep is archived", () => {
    const app = ext("app", "active", [req("lib")]);
    const lib = ext("lib", "archived", []);
    const broken = findBrokenClosures([app, lib]);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.packageName).toBe("app");
    expect(broken[0]?.missingRequired).toContain("lib");
  });

  it("finds an active row whose required dep is not installed", () => {
    const app = ext("app", "active", [req("ghost")]);
    const broken = findBrokenClosures([app]);
    expect(broken).toHaveLength(1);
    expect(broken[0]?.missingRequired).toEqual(["ghost"]);
  });

  it("returns empty when every required closure is satisfied", () => {
    const app = ext("app", "active", [req("lib")]);
    const lib = ext("lib", "locked", []);
    expect(findBrokenClosures([app, lib])).toEqual([]);
  });

  it("ignores archived rows themselves (only active|locked are scanned)", () => {
    // `app` is archived → not a present root, so its broken dep does not surface.
    const app = ext("app", "archived", [req("lib")]);
    const lib = ext("lib", "archived", []);
    expect(findBrokenClosures([app, lib])).toEqual([]);
  });

  it("does not flag optional-missing deps", () => {
    const app = ext("app", "active", [opt("maybe")]);
    expect(findBrokenClosures([app])).toEqual([]);
  });
});

describe("makeScopedManifestLookup (no cross-org dependency bleed)", () => {
  const inOrg = (row: InstalledExtension, org: string | null): InstalledExtension => ({
    ...row,
    organizationId: org,
  });

  it("an org-scoped dependent resolves its own org's row first", () => {
    const depA = inOrg(ext("dep", "active"), "org-a");
    const depPlat = inOrg(ext("dep", "active"), null);
    const lookup = makeScopedManifestLookup([depA, depPlat], "org-a");
    expect(lookup("dep")?.organizationId).toBe("org-a");
  });

  it("falls back to the platform-scoped row when the org has none", () => {
    const depPlat = inOrg(ext("dep", "locked"), null);
    const lookup = makeScopedManifestLookup([depPlat], "org-b");
    expect(lookup("dep")?.organizationId).toBeNull();
  });

  it("a FOREIGN org's live row never satisfies the edge", () => {
    const depA = inOrg(ext("dep", "active"), "org-a");
    const lookup = makeScopedManifestLookup([depA], "org-b");
    expect(lookup("dep")).toBeUndefined();
  });

  it("a platform-scoped dependent resolves only platform rows", () => {
    const depA = inOrg(ext("dep", "active"), "org-a");
    const lookup = makeScopedManifestLookup([depA], null);
    expect(lookup("dep")).toBeUndefined();
  });

  it("archived rows are never present at any scope", () => {
    const dep = inOrg(ext("dep", "archived"), "org-a");
    const lookup = makeScopedManifestLookup([dep], "org-a");
    expect(lookup("dep")).toBeUndefined();
  });

  it("findBrokenClosures flags an org-B dependent whose required dep is live only in org A", () => {
    const appB = inOrg(ext("app", "active", [req("dep")]), "org-b");
    const depA = inOrg(ext("dep", "active"), "org-a");
    const broken = findBrokenClosures([appB, depA]);
    expect(broken).toEqual([{ packageName: "app", missingRequired: ["dep"], rangeViolations: [] }]);
  });

  it("findBrokenClosures accepts a platform-scoped dep for an org-scoped dependent", () => {
    const appB = inOrg(ext("app", "active", [req("dep")]), "org-b");
    const depPlat = inOrg(ext("dep", "locked"), null);
    expect(findBrokenClosures([appB, depPlat])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// #180: shared edge predicates + edgeType-aware closure + forward gate
// ---------------------------------------------------------------------------

import {
  assertForwardInstallClosureForPackage,
  isAutoInstallableEdge,
  isInstallBlockingEdge,
} from "../dependency-closure";

function peer(packageName: string, requirement: "required" | "optional" = "required"): ExtensionDependency {
  return { ...req(packageName), edgeType: "peer", requirement };
}
function installTime(packageName: string, requirement: "required" | "optional" = "required"): ExtensionDependency {
  return { ...req(packageName), edgeType: "install-time", requirement };
}

describe("edge predicates (#180) — the TEST-PINNED edgeType × requirement matrix", () => {
  // Every install-gating / auto-install surface keys on these two predicates.
  // This matrix is the contract: changing a cell is a semantic change to the
  // dependency model and must be deliberate.
  const matrix: Array<[ExtensionDependency, boolean, boolean]> = [
    //  edge                          install-blocking  auto-installable
    [req("b"), /*           runtime/required      */ true, true],
    [installTime("b"), /*   install-time/required */ true, true],
    [opt("b"), /*           runtime/optional      */ false, false],
    [installTime("b", "optional"), /* it/optional */ false, false],
    [peer("b", "required"), /* peer/required      */ false, false],
    [peer("b", "optional"), /* peer/optional      */ false, false],
  ];
  it.each(matrix.map(([e, blocking, auto]) => [e.edgeType, e.requirement, e, blocking, auto] as const))(
    "%s/%s → install-blocking=%j",
    (_t, _r, e, blocking, auto) => {
      expect(isInstallBlockingEdge(e)).toBe(blocking);
      expect(isAutoInstallableEdge(e)).toBe(auto);
    },
  );
});

describe("computeClosure — peer edges are bucketed out of missingRequired (#180)", () => {
  it("a MISSING required-peer edge lands in missingPeer, never missingRequired", () => {
    const a = ext("a", "active", [peer("p"), req("b")]);
    const b = ext("b", "active", []);
    const lookup = (n: string) => ({ a, b }[n]);
    const result = computeClosure(a, lookup);
    expect(result.ok).toBe(true); // peer never breaks the install closure
    expect(result.missingRequired).toEqual([]);
    expect(result.missingPeer.map((d) => d.packageName)).toEqual(["p"]);
    expect(result.missingOptional).toEqual([]);
  });

  it("an ARCHIVED optional-peer edge also lands in missingPeer", () => {
    const a = ext("a", "active", [peer("p", "optional")]);
    const p = ext("p", "archived", []);
    const result = computeClosure(a, (n) => ({ a, p }[n]));
    expect(result.missingPeer.map((d) => `${d.packageName}:${d.status}`)).toEqual(["p:archived"]);
    expect(result.ok).toBe(true);
  });

  it("assertInstallClosure does NOT throw for a missing peer; STILL throws for a missing blocking edge", () => {
    const peerOnly = ext("a", "active", [peer("p")]);
    expect(() => assertInstallClosure(peerOnly, () => undefined)).not.toThrow();

    const blocking = ext("a", "active", [installTime("b")]);
    expect(() => assertInstallClosure(blocking, () => undefined)).toThrowError(DependencyClosureError);
  });

  it("findBrokenClosures ignores missing peer edges (boot gate never trips on peers)", () => {
    const rows = [ext("a", "active", [peer("p")])];
    expect(findBrokenClosures(rows)).toEqual([]);
  });

  it("evaluateExecutionClosure routes missing peers into the per-kind ADVISORY (activation-time check)", () => {
    const wf = ext("w", "active", [peer("p")], "workflow");
    const verdict = evaluateExecutionClosure(wf, () => undefined);
    expect(verdict.requiredClosureOk).toBe(true);
    expect(verdict.advisory?.behavior).toBe("fail-instantiate");
    expect(verdict.advisory?.missingOptional.map((d) => d.packageName)).toEqual(["p"]);
    // workflow-kind: a missing peer trips the fail-instantiate execution block
    expect(verdict.executionBlock?.code).toBe("OPTIONAL_MISSING_FAILS_INSTANTIATE");

    const agent = ext("g", "active", [peer("p")], "agent");
    const agentVerdict = evaluateExecutionClosure(agent, () => undefined);
    expect(agentVerdict.executionBlock).toBeNull();
    expect(agentVerdict.advisory?.behavior).toBe("stop-run-hitl");
  });
});

describe("assertArchiveDoesNotBreakClosure — peer dependents never block (#180)", () => {
  it("a live dependent holding only a PEER edge does not block the archive", () => {
    const target = ext("t", "active", []);
    const dependent = ext("d", "active", [peer("t")]);
    expect(() => assertArchiveDoesNotBreakClosure(target, [target, dependent])).not.toThrow();
  });

  it("a live dependent holding a required INSTALL-TIME edge still blocks", () => {
    const target = ext("t", "active", []);
    const dependent = ext("d", "active", [installTime("t")]);
    expect(() => assertArchiveDoesNotBreakClosure(target, [target, dependent])).toThrowError(
      /required by active dependents: d/,
    );
  });
});

describe("assertForwardInstallClosureForPackage (#180 item 5 — the fresh-install forward gate)", () => {
  it("refuses when an install-blocking edge's target is missing, NAMING the dep + the interim instruction", () => {
    const a = ext("a", "active", [req("b")]);
    try {
      assertForwardInstallClosureForPackage("a", [a]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyClosureError);
      expect((e as DependencyClosureError).code).toBe("REQUIRED_MISSING");
      expect((e as Error).message).toContain("b (missing)");
      expect((e as Error).message).toContain("auto-install did not put in place");
      // The actionable instruction is part of the contract: name the deps and
      // tell the operator to install them first.
      expect((e as Error).message).toContain("Install b first, then retry");
      expect((e as DependencyClosureError).dependents).toEqual(["b"]);
    }
  });

  it("passes when blocking edges are satisfied; peer/optional edges never gate", () => {
    const a = ext("a", "active", [req("b"), peer("p"), opt("o")]);
    const b = ext("b", "locked", []);
    expect(() => assertForwardInstallClosureForPackage("a", [a, b])).not.toThrow();
  });

  it("scopes to the given org: only the matching row is gated", () => {
    const orgRow = { ...ext("a", "active", [req("b")]), organizationId: "org-1", id: "id-a-org" };
    const platformRow = ext("a", "active", []); // platform row has no edges
    // gate org-2 → no row at that scope → pass
    expect(() =>
      assertForwardInstallClosureForPackage("a", [orgRow, platformRow], { organizationId: "org-2" }),
    ).not.toThrow();
    // gate org-1 → broken
    expect(() =>
      assertForwardInstallClosureForPackage("a", [orgRow, platformRow], { organizationId: "org-1" }),
    ).toThrowError(DependencyClosureError);
    // platform scope (null) → clean
    expect(() =>
      assertForwardInstallClosureForPackage("a", [orgRow, platformRow], { organizationId: null }),
    ).not.toThrow();
  });

  it("an ARCHIVED blocking dep counts as missing (closure semantics preserved)", () => {
    const a = ext("a", "active", [req("b")]);
    const b = ext("b", "archived", []);
    // The scope-aware lookup resolves LIVE rows only, so an archived dep
    // surfaces as "missing" — either way the gate refuses.
    expect(() => assertForwardInstallClosureForPackage("a", [a, b])).toThrowError(/b \(missing\)/);
  });
});

// ---------------------------------------------------------------------------
// #180 item 6 — VERSION AWARENESS (durable version constraints)
// ---------------------------------------------------------------------------

import {
  assertUpdateDoesNotBreakDependents,
  edgeVersionViolation,
  installedVersionOfRow,
  orderPackagesByDependencyFirst,
  assertForwardInstallClosureForPackage as fwdGate,
} from "../dependency-closure";

function vext(
  packageName: string,
  version: string,
  deps: ExtensionDependency[] = [],
  over: Partial<InstalledExtension> = {},
): InstalledExtension {
  return {
    ...ext(packageName, "active", deps),
    source: {
      type: "verdaccio",
      registryUrl: "https://registry.cinatra.ai",
      packageName,
      version,
      integrity: "sha512-x",
    } as InstalledExtension["source"],
    ...over,
  };
}

function reqRange(packageName: string, range: string): ExtensionDependency {
  return { ...req(packageName), versionConstraint: { kind: "semver-range", range } };
}

describe("edgeVersionViolation / installedVersionOfRow (#180 item 6)", () => {
  it("matrix: star + git-ref + versionless rows are presence-only; range/exact evaluate", () => {
    expect(edgeVersionViolation(reqRange("b", "*"), "1.0.0")).toBeNull();
    expect(edgeVersionViolation(reqRange("b", "^1.0.0"), "1.4.0")).toBeNull();
    expect(edgeVersionViolation(reqRange("b", "^2.0.0"), "1.4.0")).toBe('"^2.0.0"');
    expect(
      edgeVersionViolation({ ...req("b"), versionConstraint: { kind: "exact", version: "1.0.0" } }, "1.0.0"),
    ).toBeNull();
    expect(
      edgeVersionViolation({ ...req("b"), versionConstraint: { kind: "exact", version: "1.0.0" } }, "1.0.1"),
    ).toBe("=1.0.0");
    expect(
      edgeVersionViolation({ ...req("b"), versionConstraint: { kind: "git-ref", ref: "main" } }, "1.0.0"),
    ).toBeNull();
    expect(edgeVersionViolation(reqRange("b", "^2.0.0"), null)).toBeNull();
    // local/dev sources have no registry version → presence-only.
    expect(installedVersionOfRow(ext("a", "active"))).toBeNull();
    expect(installedVersionOfRow(vext("a", "1.2.3"))).toBe("1.2.3");
  });
});

describe("computeClosure — rangeViolations bucket (#180 item 6)", () => {
  it("a PRESENT install-blocking dep at a violating version lands in rangeViolations (ok stays presence-based)", () => {
    const a = vext("a", "1.0.0", [reqRange("b", "^2.0.0")]);
    const b = vext("b", "1.4.0");
    const result = computeClosure(a, makeScopedManifestLookup([a, b], null));
    expect(result.ok).toBe(true); // presence holds
    expect(result.rangeViolations).toEqual([
      { packageName: "b", via: "a", installedVersion: "1.4.0", constraint: '"^2.0.0"' },
    ]);
  });

  it("violating PEER/OPTIONAL edges never enter rangeViolations (blocking semantics only)", () => {
    const a = vext("a", "1.0.0", [
      { ...reqRange("b", "^2.0.0"), edgeType: "peer" },
      { ...reqRange("c", "^2.0.0"), requirement: "optional" },
    ]);
    const b = vext("b", "1.0.0");
    const c = vext("c", "1.0.0");
    const result = computeClosure(a, makeScopedManifestLookup([a, b, c], null));
    expect(result.rangeViolations).toEqual([]);
  });

  it("findBrokenClosures surfaces range violations alongside missing deps; assertInstallClosure + the forward gate refuse on them", () => {
    const a = vext("a", "1.0.0", [reqRange("b", "^2.0.0")]);
    const b = vext("b", "1.4.0");
    const broken = findBrokenClosures([a, b]);
    expect(broken).toHaveLength(1);
    expect(broken[0]!.rangeViolations[0]).toContain('b@1.4.0 violates "^2.0.0" required by a');

    expect(() => assertInstallClosure(a, makeScopedManifestLookup([a, b], null))).toThrowError(
      /violate/,
    );
    try {
      fwdGate("a", [a, b]);
      expect.unreachable("forward gate must refuse");
    } catch (e) {
      expect((e as DependencyClosureError).code).toBe("RANGE_VIOLATION");
      expect((e as Error).message).toContain("Update the violating dependencies");
    }
  });
});

describe("assertUpdateDoesNotBreakDependents (#180 item 6 — the update gate)", () => {
  it("REFUSES a breaking-range update NAMING the dependents and their constraints, with the actionable instruction", () => {
    const dependent1 = vext("dep1", "1.0.0", [reqRange("lib", "^1.0.0")]);
    const dependent2 = vext("dep2", "1.0.0", [reqRange("lib", ">=1.2.0 <2.0.0")]);
    const lib = vext("lib", "1.4.0");
    try {
      assertUpdateDoesNotBreakDependents("lib", "2.0.0", [dependent1, dependent2, lib]);
      expect.unreachable("must refuse");
    } catch (e) {
      expect(e).toBeInstanceOf(DependencyClosureError);
      expect((e as DependencyClosureError).code).toBe("UPDATE_BREAKS_DEPENDENTS");
      expect((e as DependencyClosureError).dependents.sort()).toEqual(["dep1", "dep2"]);
      expect((e as Error).message).toContain('dep1 requires lib@"^1.0.0"');
      expect((e as Error).message).toContain("Update the dependent(s)");
    }
  });

  it("PASSES a satisfying update; '*' ranges and archived/peer/optional dependents never block", () => {
    const star = vext("star-dep", "1.0.0", [reqRange("lib", "*")]);
    const archived = vext("old-dep", "1.0.0", [reqRange("lib", "^1.0.0")], { status: "archived" } as never);
    const peer = vext("peer-dep", "1.0.0", [{ ...reqRange("lib", "^1.0.0"), edgeType: "peer" }]);
    const satisfied = vext("ok-dep", "1.0.0", [reqRange("lib", "^1.0.0")]);
    const lib = vext("lib", "1.4.0");
    expect(() =>
      assertUpdateDoesNotBreakDependents("lib", "1.9.0", [star, archived, peer, satisfied, lib]),
    ).not.toThrow();
    expect(() =>
      assertUpdateDoesNotBreakDependents("lib", "2.0.0", [star, archived, peer, lib]),
    ).not.toThrow();
  });

  it("scope-aware (row identity): an ORG dependent FALLING BACK to the platform row BLOCKS a platform update", () => {
    const orgDep = {
      ...vext("org-dep", "1.0.0", [reqRange("lib", "^1.0.0")]),
      organizationId: "org-1",
    };
    const platformLib = vext("lib", "1.4.0"); // organizationId null
    expect(() =>
      assertUpdateDoesNotBreakDependents("lib", "2.0.0", [orgDep, platformLib], {
        organizationId: null,
      }),
    ).toThrowError(/org-dep requires lib/);
  });

  it("scope-aware (row identity): a PLATFORM dependent resolving the PLATFORM row never blocks an ORG-scoped update", () => {
    const platformDep = vext("plat-dep", "1.0.0", [reqRange("lib", "^1.0.0")]);
    const platformLib = vext("lib", "1.4.0");
    const orgLib = { ...vext("lib", "1.4.0"), id: "id-lib-org", organizationId: "org-1" };
    expect(() =>
      assertUpdateDoesNotBreakDependents("lib", "2.0.0", [platformDep, platformLib, orgLib], {
        organizationId: "org-1",
      }),
    ).not.toThrow();
  });

  it("scope-aware (row identity): an org dependent with its OWN org row of the dep never blocks the platform update", () => {
    const orgDep = {
      ...vext("org-dep", "1.0.0", [reqRange("lib", "^1.0.0")]),
      organizationId: "org-1",
    };
    const orgLib = { ...vext("lib", "1.4.0"), id: "id-lib-org", organizationId: "org-1" };
    const platformLib = vext("lib", "1.4.0");
    // org-dep resolves ITS OWN org row — the platform update touches a row it
    // does not consume.
    expect(() =>
      assertUpdateDoesNotBreakDependents("lib", "2.0.0", [orgDep, orgLib, platformLib], {
        organizationId: null,
      }),
    ).not.toThrow();
  });
});

describe("assertArchiveDoesNotBreakClosure — version posture (#180 item 6 reconciliation)", () => {
  it("a dependent whose edge the CURRENT version already violates STILL blocks the archive (presence-based is strictly stronger)", () => {
    const dependent = vext("dep1", "1.0.0", [reqRange("lib", "^2.0.0")]); // violated today
    const lib = vext("lib", "1.4.0");
    expect(() => assertArchiveDoesNotBreakClosure(lib, [dependent, lib])).toThrowError(
      /required by active dependents: dep1/,
    );
  });
});

describe("orderPackagesByDependencyFirst (#180 item 8 — activation order)", () => {
  it("dependencies place FIRST; lexicographic tie-break (test-pinned direction)", () => {
    const edges = new Map<string, ExtensionDependency[]>([
      ["a", [req("c")]],
      ["b", []],
      ["c", []],
    ]);
    expect(orderPackagesByDependencyFirst(["a", "b", "c"], edges)).toEqual(["b", "c", "a"]);
  });

  it("peer edges and out-of-set edges never affect the order", () => {
    const edges = new Map<string, ExtensionDependency[]>([
      ["a", [{ ...req("b"), edgeType: "peer" }, req("@outside/pkg")]],
      ["b", []],
    ]);
    expect(orderPackagesByDependencyFirst(["a", "b"], edges)).toEqual(["a", "b"]);
  });

  it("a cycle falls back to DETERMINISTIC lexicographic order with a LOUD warning (never a hang)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const edges = new Map<string, ExtensionDependency[]>([
      ["a", [req("b")]],
      ["b", [req("a")]],
      ["z", []],
    ]);
    expect(orderPackagesByDependencyFirst(["z", "b", "a"], edges)).toEqual(["z", "a", "b"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("dependency CYCLE among a, b"));
    warn.mockRestore();
  });
});
