// cinatra#2090 S3 — the declared skill-edge `role` must SURVIVE the publish /
// install parse of `cinatra.dependencies[]`.
//
// `cinatraExtensionDependencySchema` is a `.strict()` object and it is a MIRROR
// of the install authority `validateExtensionDependencyShape`
// (packages/extensions/src/manifest-dependencies.ts), not a second opinion.
// Before this suite the mirror had not learned the role vocabulary, and strict
// means an unknown key is an ERROR, not a silent strip — so a consumer that says
// which surface each of its skill edges feeds could not be parsed at all.
//
// The two rules mirrored here, in the authority's own order:
//   1. a role, when present, is one of matcher|authoring;
//   2. a role is meaningful ONLY on a kind:"skill" edge.
// And the rule deliberately NOT imposed: `edgeType` is unconstrained, so a role
// on an install-time or peer skill edge parses exactly as it does at install. A
// stricter mirror would refuse a manifest the host itself accepts.
import { describe, expect, it } from "vitest";

import { parseAgentPackageManifestForInstall } from "../verdaccio/package-contract";

const PKG = "@cinatra-ai/blog-idea-artifact";

const MATCHER_EDGE = {
  packageName: "@cinatra-ai/blog-idea-matcher-skill",
  kind: "skill",
  role: "matcher",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "^1.0.0" },
  requirement: "required",
} as const;

const AUTHORING_EDGE = {
  packageName: "@cinatra-ai/blog-idea-authoring-skill",
  kind: "skill",
  role: "authoring",
  edgeType: "runtime",
  versionConstraint: { kind: "semver-range", range: "^1.0.0" },
  requirement: "required",
} as const;

/** Drop ONE key from an edge fixture (no destructure-and-discard, which the
 *  lint config flags as an unused binding). */
function omit<T extends object, K extends keyof T>(obj: T, key: K): Omit<T, K> {
  const copy = { ...obj } as Record<string, unknown>;
  delete copy[key as string];
  return copy as Omit<T, K>;
}

function manifestWithDeps(dependencies: unknown): Record<string, unknown> {
  return {
    name: PKG,
    version: "1.0.0",
    cinatra: {
      packageType: "agent",
      manifestVersion: 1,
      sourceTemplateId: "tpl-1",
      sourceVersionId: "ver-1",
      sourceVersionNumber: 1,
      riskLevel: "low",
      hasApprovalGates: false,
      toolAccess: [],
      ownerOrgId: null,
      dependencies,
    },
  };
}

describe("cinatra.dependencies[].role — install-parse round-trip", () => {
  it("carries BOTH declared roles through the parse VERBATIM", () => {
    const parsed = parseAgentPackageManifestForInstall(
      manifestWithDeps([MATCHER_EDGE, AUTHORING_EDGE]),
      PKG,
    );
    expect(parsed.cinatra.dependencies).toEqual([MATCHER_EDGE, AUTHORING_EDGE]);
    expect(parsed.cinatra.dependencies?.map((d) => d.role)).toEqual(["matcher", "authoring"]);
  });

  it("a role-LESS edge still parses and reports an undefined role (additive vocabulary)", () => {
    const roleless = omit(MATCHER_EDGE, "role");
    const parsed = parseAgentPackageManifestForInstall(manifestWithDeps([roleless]), PKG);
    expect(parsed.cinatra.dependencies).toEqual([roleless]);
    expect(parsed.cinatra.dependencies?.[0]?.role).toBeUndefined();
  });

  it("REFUSES an unknown role value", () => {
    expect(() =>
      parseAgentPackageManifestForInstall(
        manifestWithDeps([{ ...MATCHER_EDGE, role: "matchr" }]),
        PKG,
      ),
    ).toThrow();
  });

  it("REFUSES a role on a non-skill edge, and on a kind-LESS edge", () => {
    expect(() =>
      parseAgentPackageManifestForInstall(
        manifestWithDeps([{ ...MATCHER_EDGE, kind: "connector" }]),
        PKG,
      ),
    ).toThrow();
    expect(() =>
      parseAgentPackageManifestForInstall(manifestWithDeps([omit(MATCHER_EDGE, "kind")]), PKG),
    ).toThrow();
  });

  it("does NOT constrain edgeType — the authority keys the rule on kind alone", () => {
    for (const edgeType of ["runtime", "install-time", "peer"] as const) {
      const parsed = parseAgentPackageManifestForInstall(
        manifestWithDeps([{ ...MATCHER_EDGE, edgeType }]),
        PKG,
      );
      expect(parsed.cinatra.dependencies?.[0]?.edgeType).toBe(edgeType);
      expect(parsed.cinatra.dependencies?.[0]?.role).toBe("matcher");
    }
  });

  it("still refuses a genuinely unknown key on the edge (the object stays CLOSED)", () => {
    expect(() =>
      parseAgentPackageManifestForInstall(
        manifestWithDeps([{ ...MATCHER_EDGE, notARealField: true }]),
        PKG,
      ),
    ).toThrow();
  });
});
