// enforceConnectorPolicy delegates to the uniform evaluator when
// a canonical connector install exists, fails CLOSED on a canonical read error
// (no looser legacy fallback), and keeps `manage` admin-only.

import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import { POLICY_VERSION } from "@/lib/authz/actor-context";
import type { ConnectorCanonicalResult } from "@/lib/connector-access-resolver";

// Hoisted mock state the resolver mock reads.
const state = vi.hoisted(() => ({
  result: { status: "absent" } as ConnectorCanonicalResult,
  catalogDeclaration: null as null | { formatVersion: 1; mode: string; scope: string; source: string },
}));

vi.mock("@/lib/connector-access-resolver", () => ({
  resolveConnectorCanonicalAccessSync: () => state.result,
}));

// The shipped-catalog declaration source (cinatra#955): controllable so the
// legacy-fallback only:"admin" clamp is testable without the generated
// manifest carrying the synthetic package.
vi.mock("@/lib/connector-access-config-host", () => ({
  connectorCatalogAccessDeclaration: () => state.catalogDeclaration,
  connectorCatalogDefaultVisibility: () =>
    state.catalogDeclaration?.scope === "admin" ? "admin" : "workspace",
}));

// Pin a known descriptor so the test does not depend on catalog contents.
vi.mock("@cinatra-ai/connectors-catalog/descriptors.mjs", () => ({
  getConnectorDescriptorByPackageId: (pkg: string) =>
    pkg === "@cinatra-ai/known-connector"
      ? { packageId: pkg, slug: "known" }
      : undefined,
  CONNECTOR_DESCRIPTORS: [],
  listConnectorDescriptors: () => [],
}));

import { enforceConnectorPolicy } from "@/lib/connector-policy";

const PKG = "@cinatra-ai/known-connector";
const ORG = "org-1";

function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u-member",
    organizationId: ORG,
    orgRole: "member",
    authSource: "ui",
    policyVersion: POLICY_VERSION,
    ...over,
  };
}

function found(over: Partial<ConnectorCanonicalResult & { access: unknown }> = {}): ConnectorCanonicalResult {
  return {
    status: "found",
    access: {
      resourceId: "inst-1",
      owner: { ownerLevel: "organization", ownerId: ORG, organizationId: ORG },
      policy: {
        runListVisibility: ["workspace"],
        runDataVisibility: ["workspace"],
        runExecuteVisibility: ["workspace"],
        allowRunSharing: false,
      },
      coOwnerUserIds: [],
      installedByUserId: "installer-1",
      accessDeclaration: null,
      ...(over as { access?: object }).access,
    },
  };
}

describe("enforceConnectorPolicy — canonical delegation", () => {
  beforeEach(() => {
    state.result = { status: "absent" };
  });

  it("canonical workspace policy → member is allowed read", () => {
    state.result = found();
    expect(enforceConnectorPolicy(PKG, actor(), "read").allowed).toBe(true);
  });

  it("canonical admin policy → member denied, org_admin allowed", () => {
    state.result = found({
      access: {
        resourceId: "inst-1",
        owner: { ownerLevel: "organization", ownerId: ORG, organizationId: ORG },
        policy: {
          runListVisibility: ["admin"],
          runDataVisibility: ["admin"],
          runExecuteVisibility: ["admin"],
          allowRunSharing: false,
        },
        coOwnerUserIds: [],
        installedByUserId: "installer-1",
        accessDeclaration: null,
      },
    } as never);
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "member" }), "read").allowed).toBe(false);
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "org_admin" }), "read").allowed).toBe(true);
  });

  it("manage stays admin-only even though installer/co-owner could manage in the uniform model", () => {
    state.result = found();
    // installer is a plain member here → manage must still be denied.
    expect(
      enforceConnectorPolicy(PKG, actor({ principalId: "installer-1", orgRole: "member" }), "manage").allowed,
    ).toBe(false);
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "org_admin" }), "manage").allowed).toBe(true);
  });

  it("canonical read ERROR fails closed (denied, not legacy fallback)", () => {
    state.result = { status: "error" };
    const decision = enforceConnectorPolicy(PKG, actor({ orgRole: "org_admin" }), "read");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("access_read_error");
  });

  it("only:admin CEILING on the canonical path: a looser stored policy row cannot loosen it (cinatra#955)", () => {
    state.result = found({
      access: {
        accessDeclaration: { formatVersion: 1, mode: "only", scope: "admin", source: "declared" },
        // Stored WORKSPACE policy row — must NOT win over the exclusive
        // admin declaration.
      },
    } as never);
    const member = enforceConnectorPolicy(PKG, actor({ orgRole: "member" }), "read");
    expect(member.allowed).toBe(false);
    expect(member.reason).toBe("admin_only_connector");
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "org_admin" }), "read").allowed).toBe(true);
  });

  it("policy-null canonical row derives the effective tier from the cached declaration", () => {
    state.result = found({
      access: {
        policy: null,
        accessDeclaration: { formatVersion: 1, mode: "default", scope: "admin", source: "declared" },
      },
    } as never);
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "member" }), "read").allowed).toBe(false);
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "org_admin" }), "read").allowed).toBe(true);
    state.result = found({
      access: {
        policy: null,
        accessDeclaration: { formatVersion: 1, mode: "default", scope: "user", source: "declared" },
      },
    } as never);
    // Non-admin scope projects to the workspace tier → member allowed.
    expect(enforceConnectorPolicy(PKG, actor({ orgRole: "member" }), "read").allowed).toBe(true);
  });

  it("only:admin CEILING on the LEGACY fallback path: a legacy row cannot loosen the shipped declaration (cinatra#955)", () => {
    state.result = { status: "absent" };
    state.catalogDeclaration = { formatVersion: 1, mode: "only", scope: "admin", source: "declared" };
    try {
      const member = enforceConnectorPolicy(PKG, actor({ orgRole: "member" }), "read");
      expect(member.allowed).toBe(false);
      expect(member.reason).toBe("admin_only_connector");
      expect(enforceConnectorPolicy(PKG, actor({ orgRole: "org_admin" }), "read").allowed).toBe(true);
    } finally {
      state.catalogDeclaration = null;
    }
  });
});
