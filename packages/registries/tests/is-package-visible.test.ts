/**
 * Pin the visibility predicate's contract — the helper is shared between
 * `listExtensionPackages` and `listAgentPackages`, and several screens +
 * MCP handlers depend on its semantics matching the marketplace's vendor
 * visibility state machine. Without this test, a regression in the helper
 * would only be caught by integration tests that mock a full Verdaccio
 * fetch chain.
 */
import { describe, it, expect } from "vitest";

import { isPackageVisible } from "../src/verdaccio/client";
import type { AgentPackageSummary, AgentPackageOrigin } from "../src/types";

function summary(origin: AgentPackageOrigin | null): AgentPackageSummary {
  return {
    packageName: "@acme/foo",
    packageVersion: "1.0.0",
    title: "Foo",
    description: null,
    changelog: null,
    riskLevel: "low",
    hasApprovalGates: false,
    toolAccess: [],
    executionMode: "agentic",
    ownerOrgId: null,
    publishedAt: "",
    registryUrl: "",
    registryUiUrl: "",
    deprecated: false,
    author: null,
    kind: "agent",
    origin,
  };
}

describe("isPackageVisible", () => {
  it("legacy packages with null origin are grandfathered to public", () => {
    expect(isPackageVisible(summary(null), undefined)).toBe(true);
    expect(isPackageVisible(summary(null), "@acme")).toBe(true);
    expect(isPackageVisible(summary(null), "@bravo")).toBe(true);
  });

  it("public origin is visible to everyone regardless of viewerScope", () => {
    const pkg = summary({ visibility: "public", scope: "@acme" });
    expect(isPackageVisible(pkg, undefined)).toBe(true);
    expect(isPackageVisible(pkg, "@acme")).toBe(true);
    expect(isPackageVisible(pkg, "@bravo")).toBe(true);
  });

  it("locked_public origin is visible to everyone regardless of viewerScope", () => {
    const pkg = summary({ visibility: "locked_public", scope: "@acme" });
    expect(isPackageVisible(pkg, undefined)).toBe(true);
    expect(isPackageVisible(pkg, "@acme")).toBe(true);
    expect(isPackageVisible(pkg, "@bravo")).toBe(true);
  });

  it("private origin is visible only when viewerScope matches the package's scope", () => {
    const pkg = summary({ visibility: "private", scope: "@acme" });
    expect(isPackageVisible(pkg, "@acme")).toBe(true);
    expect(isPackageVisible(pkg, "@bravo")).toBe(false);
    expect(isPackageVisible(pkg, undefined)).toBe(false);
  });
});
