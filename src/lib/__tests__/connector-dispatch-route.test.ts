// Covers the dispatch route's static guarantees without booting Next.js:
// every catalog descriptor maps to a `setup` subroute, the registry resolves
// an entry for it, and the policy stub's admin/workspace split holds.

import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { getConnectorRegistryEntryBySlug } from "@/lib/connectors-registry.server";

// enforceConnectorPolicy resolves the canonical connector access FIRST. With no
// DB in this unit test the canonical read would fail closed
// (deny). Mock the resolver to "absent" to simulate the realistic pre-migration
// state (canonical tables present, no connector rows yet) so these invariants
// exercise the legacy descriptor-default fallback split they were written for.
vi.mock("@/lib/connector-access-resolver", () => ({
  resolveConnectorCanonicalAccessSync: () => ({ status: "absent" }),
}));

import { enforceConnectorPolicy } from "@/lib/connector-policy";

import type { ActorContext } from "@/lib/authz/actor-context";
import { POLICY_VERSION } from "@/lib/authz/actor-context";

const adminActor: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-admin",
  organizationId: "org-1",
  orgRole: "org_admin",
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

const workspaceActor: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-member",
  organizationId: "org-1",
  orgRole: "member",
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

describe("dispatch route invariants", () => {
  it("every catalog descriptor resolves to a registry entry via slug", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      const entry = getConnectorRegistryEntryBySlug(d.slug);
      expect(entry, `entry for ${d.slug}`).toBeDefined();
      expect(entry?.packageId).toBe(d.packageId);
      expect(entry?.setupSubroute).toBe("setup");
      expect(typeof entry?.loadSetupPage).toBe("function");
    }
  });

  it("unknown slug returns undefined (route will notFound)", () => {
    expect(getConnectorRegistryEntryBySlug("nope-connector")).toBeUndefined();
  });
});

describe("connector policy stub invariants", () => {
  it("admin actor sees every connector", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      expect(
        enforceConnectorPolicy(d.packageId, adminActor, "read").allowed,
        `admin should read ${d.slug}`,
      ).toBe(true);
    }
  });

  it("non-admin actor sees ONLY workspace-visibility connectors", () => {
    for (const d of CONNECTOR_DESCRIPTORS) {
      const allowed = enforceConnectorPolicy(
        d.packageId,
        workspaceActor,
        "read",
      ).allowed;
      expect(allowed, `member visibility for ${d.slug}`).toBe(
        d.defaultVisibility === "workspace",
      );
    }
  });

  it("manage mode is admin-only even for workspace-visibility connectors", () => {
    const workspaceConnector = CONNECTOR_DESCRIPTORS.find(
      (d) => d.defaultVisibility === "workspace",
    );
    expect(workspaceConnector).toBeDefined();
    if (!workspaceConnector) return;
    expect(
      enforceConnectorPolicy(workspaceConnector.packageId, workspaceActor, "manage")
        .allowed,
    ).toBe(false);
    expect(
      enforceConnectorPolicy(workspaceConnector.packageId, adminActor, "manage")
        .allowed,
    ).toBe(true);
  });

  it("no actor → denied (unauthenticated)", () => {
    expect(
      enforceConnectorPolicy("@cinatra-ai/openai-connector", undefined, "read")
        .allowed,
    ).toBe(false);
  });

  it("unknown packageId → denied", () => {
    expect(
      enforceConnectorPolicy("@cinatra-ai/nonexistent-connector", adminActor, "read")
        .allowed,
    ).toBe(false);
  });
});
