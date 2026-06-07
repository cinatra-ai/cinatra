import { describe, it, expect } from "vitest";
import {
  normalizeLegacyDependencies,
  parseVersionConstraint,
  type ExtensionDependency,
} from "../dependencies";

describe("parseVersionConstraint", () => {
  it("classifies caret/tilde/range as semver-range", () => {
    expect(parseVersionConstraint("^0.1.0")).toEqual({ kind: "semver-range", range: "^0.1.0" });
    expect(parseVersionConstraint("~1.2.3")).toEqual({ kind: "semver-range", range: "~1.2.3" });
    expect(parseVersionConstraint(">=2.0.0")).toEqual({ kind: "semver-range", range: ">=2.0.0" });
  });
  it("classifies a bare pinned version as exact", () => {
    expect(parseVersionConstraint("0.1.10")).toEqual({ kind: "exact", version: "0.1.10" });
  });
  it("classifies git refs", () => {
    expect(parseVersionConstraint("git+https://x#abc").kind).toBe("git-ref");
  });
  it("treats empty/latest as a wildcard semver-range", () => {
    expect(parseVersionConstraint("")).toEqual({ kind: "semver-range", range: "*" });
    expect(parseVersionConstraint("latest")).toEqual({ kind: "semver-range", range: "latest" });
  });
});

describe("normalizeLegacyDependencies", () => {
  it("normalizes the legacy agentDependencies map (the real email-outreach shape)", () => {
    const out = normalizeLegacyDependencies({
      agentDependencies: {
        "@cinatra-ai/email-drafting-agent": "^0.1.0",
        "@cinatra-ai/reviewer-agent": "^0.1.0",
      },
    });
    expect(out).toHaveLength(2);
    // sorted by packageName
    expect(out.map((d) => d.packageName)).toEqual([
      "@cinatra-ai/email-drafting-agent",
      "@cinatra-ai/reviewer-agent",
    ]);
    expect(out[0]).toMatchObject({
      edgeType: "runtime",
      requirement: "required",
      versionConstraint: { kind: "semver-range", range: "^0.1.0" },
    });
  });

  it("resolves kind via the resolver", () => {
    const out = normalizeLegacyDependencies(
      { agentDependencies: { "@cinatra-ai/reviewer-agent": "^0.1.0" } },
      (pkg) => (pkg.endsWith("-agent") ? "agent" : undefined),
    );
    expect(out[0].kind).toBe("agent");
  });

  it("normalizes connectorDependencies (cross-kind connector→connector)", () => {
    const out = normalizeLegacyDependencies(
      { connectorDependencies: { "@cinatra-ai/email-connector": "^0.1.0" } },
      () => "connector",
    );
    expect(out[0]).toMatchObject({ packageName: "@cinatra-ai/email-connector", kind: "connector" });
  });

  it("gives an already-canonical edge precedence over a legacy shim for the same package", () => {
    const canonical: ExtensionDependency = {
      packageName: "@cinatra-ai/email-connector",
      kind: "connector",
      edgeType: "peer",
      versionConstraint: { kind: "exact", version: "0.2.0" },
      requirement: "optional",
    };
    const out = normalizeLegacyDependencies({
      dependencies: [canonical],
      connectorDependencies: { "@cinatra-ai/email-connector": "^0.1.0" },
    });
    expect(out).toHaveLength(1);
    // canonical's optional/peer/exact wins — the legacy shim does NOT overwrite
    expect(out[0]).toMatchObject({ edgeType: "peer", requirement: "optional" });
  });

  it("dedupes a package declared in both agent and connector maps", () => {
    const out = normalizeLegacyDependencies({
      agentDependencies: { "@cinatra-ai/dup": "^0.1.0" },
      connectorDependencies: { "@cinatra-ai/dup": "^0.2.0" },
    });
    expect(out).toHaveLength(1);
    // agent map runs first → its version wins
    expect(out[0].versionConstraint).toEqual({ kind: "semver-range", range: "^0.1.0" });
  });

  it("returns [] for an extension with no dependency fields", () => {
    expect(normalizeLegacyDependencies({})).toEqual([]);
  });
});
