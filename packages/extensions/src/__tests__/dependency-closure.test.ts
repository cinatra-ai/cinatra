// Dependency closure tests.
import { describe, expect, it } from "vitest";

import type { ExtensionDependency, InstalledExtension } from "../canonical-types";
import {
  DependencyClosureError,
  assertArchiveDoesNotBreakClosure,
  assertInstallClosure,
  computeClosure,
  findBrokenClosures,
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
