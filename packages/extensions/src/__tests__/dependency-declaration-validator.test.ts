// Declared-vs-used closure validator tests (engineering#422 PR-1).
//
// The acceptance bar: the validator CATCHES a deliberate under-declaration
// (the `blog-linkedin-publish-agent` shape — consumes a connector primitive
// while declaring `cinatra.dependencies: []`) and PASSES a correctly-declared
// extension (the `linkedin-connector` shape — declares the edges its consumed
// primitives resolve to).
import { describe, expect, it } from "vitest";

import type { ExtensionDependency } from "../canonical-types";
import {
  validateDependencyDeclarations,
  type ConsumedPrimitiveInput,
  type OwnershipLookup,
  type PrimitiveOwnership,
} from "../dependency-declaration-validator";
import { isInstallBlockingEdge } from "../dependency-closure";

function edge(packageName: string, over: Partial<ExtensionDependency> = {}): ExtensionDependency {
  return {
    packageName,
    edgeType: "runtime",
    versionConstraint: { kind: "semver-range", range: "*" },
    requirement: "required",
    ...over,
  };
}

// A small fixed ownership registry mirroring the real primitive→owner facts
// (the live registry DATA lives in the private engineering repo, PR-2; the
// validator is pure over this lookup).
const OWNERS: Record<string, PrimitiveOwnership> = {
  // linkedin-connector-owned primitives
  blog_post_publish_linkedin_publish: {
    ownerType: "extension",
    owningPackage: "@cinatra-ai/linkedin-connector",
    kind: "connector",
  },
  blog_post_publish_linkedin_update: {
    ownerType: "extension",
    owningPackage: "@cinatra-ai/linkedin-connector",
    kind: "connector",
  },
  // blog-post-artifact-owned primitives
  artifact_representation_get: {
    ownerType: "extension",
    owningPackage: "@cinatra-ai/blog-post-artifact",
    kind: "artifact",
  },
  artifact_authoring_emit: {
    ownerType: "extension",
    owningPackage: "@cinatra-ai/blog-post-artifact",
    kind: "artifact",
  },
  // host-injected primitive (no declared edge required)
  google_oauth_token_get: { ownerType: "host-injected" },
  // a self-facade primitive the depender provides on its own self-MCP surface
  email_send: { ownerType: "self-facade" },
};

const ownership: OwnershipLookup = (p) => OWNERS[p];

describe("validateDependencyDeclarations — under-declaration (the core gap)", () => {
  it("CATCHES a deliberate under-declaration (consumes a connector primitive, declares [])", () => {
    const consumes: ConsumedPrimitiveInput[] = [
      { primitive: "blog_post_publish_linkedin_publish", requirement: "required" },
      { primitive: "artifact_representation_get", requirement: "required" },
    ];
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/blog-linkedin-publish-agent",
      consumes,
      declaredDependencies: [], // <-- the bug
      ownership,
    });
    expect(result.ok).toBe(false);
    const missing = result.findings.filter((f) => f.code === "MISSING_REQUIRED_DECLARATION");
    expect(missing.map((f) => f.owningPackage).sort()).toEqual([
      "@cinatra-ai/blog-post-artifact",
      "@cinatra-ai/linkedin-connector",
    ]);
    // The expected required-owner set is surfaced for the sweep report.
    expect(result.expectedRequiredPackages).toEqual([
      "@cinatra-ai/blog-post-artifact",
      "@cinatra-ai/linkedin-connector",
    ]);
  });

  it("PASSES a correctly-declared extension", () => {
    const consumes: ConsumedPrimitiveInput[] = [
      { primitive: "blog_post_publish_linkedin_publish", requirement: "required" },
      { primitive: "blog_post_publish_linkedin_update", requirement: "required" },
      { primitive: "artifact_representation_get", requirement: "required" },
      { primitive: "artifact_authoring_emit", requirement: "required" },
    ];
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/blog-linkedin-publish-agent",
      consumes,
      declaredDependencies: [
        edge("@cinatra-ai/linkedin-connector", { kind: "connector" }),
        edge("@cinatra-ai/blog-post-artifact", { kind: "artifact" }),
      ],
      ownership,
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
  });
});

describe("validateDependencyDeclarations — finding cases", () => {
  it("UNKNOWN_PRIMITIVE fails closed when the registry has no owner", () => {
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [{ primitive: "totally_made_up_primitive", requirement: "required" }],
      declaredDependencies: [],
      ownership,
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]!.code).toBe("UNKNOWN_PRIMITIVE");
  });

  it("REQUIREMENT_MISMATCH when a required primitive's owner is declared only optional/peer", () => {
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [{ primitive: "blog_post_publish_linkedin_publish", requirement: "required" }],
      declaredDependencies: [
        edge("@cinatra-ai/linkedin-connector", { requirement: "optional" }),
      ],
      ownership,
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]!.code).toBe("REQUIREMENT_MISMATCH");
  });

  it("a peer edge is NOT install-blocking → REQUIREMENT_MISMATCH for a required primitive", () => {
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [{ primitive: "blog_post_publish_linkedin_publish", requirement: "required" }],
      declaredDependencies: [edge("@cinatra-ai/linkedin-connector", { edgeType: "peer" })],
      ownership,
    });
    expect(result.findings[0]!.code).toBe("REQUIREMENT_MISMATCH");
  });

  it("MISSING_OPTIONAL_DECLARATION when an optional primitive's owner is not declared", () => {
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [{ primitive: "blog_post_publish_linkedin_publish", requirement: "optional" }],
      declaredDependencies: [],
      ownership,
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]!.code).toBe("MISSING_OPTIONAL_DECLARATION");
  });

  it("host-injected and self-facade primitives are SKIPPED (no edge required)", () => {
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [
        { primitive: "google_oauth_token_get", requirement: "required" },
        { primitive: "email_send", requirement: "required" },
      ],
      declaredDependencies: [],
      ownership,
    });
    expect(result.ok).toBe(true);
    expect(result.findings).toEqual([]);
    expect(result.expectedRequiredPackages).toEqual([]);
  });

  it("a self-owned primitive is a self-edge → never required to declare", () => {
    const selfOwner: OwnershipLookup = (p) =>
      p === "self_thing"
        ? { ownerType: "extension", owningPackage: "@cinatra-ai/x", kind: "agent" }
        : undefined;
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [{ primitive: "self_thing", requirement: "required" }],
      declaredDependencies: [],
      ownership: selfOwner,
    });
    expect(result.ok).toBe(true);
  });

  it("STALE_DECLARATION is a WARNING by default, an ERROR when failOnStaleDeclaration", () => {
    const base = {
      packageName: "@cinatra-ai/x",
      consumes: [] as ConsumedPrimitiveInput[],
      declaredDependencies: [edge("@cinatra-ai/unused-connector")],
      ownership,
    };
    const warn = validateDependencyDeclarations(base);
    expect(warn.ok).toBe(true); // warning does not fail the gate
    expect(warn.findings[0]!.code).toBe("STALE_DECLARATION");
    expect(warn.findings[0]!.severity).toBe("warning");

    const strict = validateDependencyDeclarations({ ...base, failOnStaleDeclaration: true });
    expect(strict.ok).toBe(false);
    expect(strict.findings[0]!.severity).toBe("error");
  });

  it("an optional/peer DECLARED edge with no backing primitive is NOT flagged stale", () => {
    const result = validateDependencyDeclarations({
      packageName: "@cinatra-ai/x",
      consumes: [],
      declaredDependencies: [
        edge("@cinatra-ai/coexist", { edgeType: "peer", requirement: "optional" }),
        edge("@cinatra-ai/maybe", { requirement: "optional" }),
      ],
      ownership,
    });
    expect(result.findings).toEqual([]);
  });
});

describe("install-blocking predicate stays in lockstep with dependency-closure", () => {
  // The validator inlines isInstallBlockingEdge to stay a pure leaf (no
  // server-only import). This drift test asserts the inlined copy matches.
  const cases: ExtensionDependency[] = [
    edge("a"),
    edge("b", { edgeType: "install-time" }),
    edge("c", { requirement: "optional" }),
    edge("d", { edgeType: "peer" }),
    edge("e", { edgeType: "peer", requirement: "optional" }),
    edge("f", { edgeType: "install-time", requirement: "optional" }),
  ];
  it("matches the canonical isInstallBlockingEdge for every shape", () => {
    // Re-validate the same fixtures through the validator's stale-detection
    // path, which keys on the inlined predicate: an install-blocking declared
    // edge with no backing primitive surfaces STALE_DECLARATION; a
    // non-install-blocking one never does.
    for (const dep of cases) {
      const result = validateDependencyDeclarations({
        packageName: "@cinatra-ai/probe",
        consumes: [],
        declaredDependencies: [dep],
        ownership,
      });
      const flaggedStale = result.findings.some((f) => f.code === "STALE_DECLARATION");
      expect(flaggedStale).toBe(isInstallBlockingEdge(dep));
    }
  });
});
