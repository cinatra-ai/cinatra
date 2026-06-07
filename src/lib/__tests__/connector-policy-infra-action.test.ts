// `enforceConnectorActionPolicy` infrastructure-connector fallback.
//
// Infrastructure connectors (e.g. the Nango gateway) are configured via a
// relocated connector action gated by `requireExtensionAction(pkg, "manage")`,
// but they have NO user-facing catalog descriptor, so the strict
// `enforceConnectorPolicy` returns `unknown_connector` and would deny everyone
// (breaking the setup form). `enforceConnectorActionPolicy` adds a generic
// fallback: `unknown_connector` + `manage` → org-admin only; `read` → allowed.
// Catalog connectors are unaffected (the fallback ONLY triggers on
// `unknown_connector`).
//
// Per the IoC doctrine (no extension package literals under src/, even in tests),
// this uses SYNTHETIC package IDs and a mocked descriptor catalog — never a real
// `@cinatra-ai/*` extension name.

import { describe, expect, it, vi } from "vitest";
import type { ActorContext } from "@/lib/authz/actor-context";
import { POLICY_VERSION } from "@/lib/authz/actor-context";

// Synthetic catalog: `@test/catalog-connector` is "known", everything else (incl.
// `@test/infra-connector`) is absent → enforceConnectorPolicy → unknown_connector.
vi.mock("@cinatra-ai/connectors-catalog/descriptors.mjs", () => ({
  getConnectorDescriptorByPackageId: (pkg: string) =>
    pkg === "@test/catalog-connector"
      ? { packageId: pkg, slug: "catalog", defaultVisibility: "admin" }
      : undefined,
  CONNECTOR_DESCRIPTORS: [],
  listConnectorDescriptors: () => [],
}));

// Defensive: keep the unit hermetic if any path reaches the resolver (the tested
// paths return before it).
vi.mock("@/lib/connector-access-resolver", () => ({
  resolveConnectorCanonicalAccessSync: () => ({ status: "absent" }),
}));

import { enforceConnectorActionPolicy } from "@/lib/connector-policy";

const INFRA = "@test/infra-connector";
const CATALOG = "@test/catalog-connector";

function actor(over: Partial<ActorContext> = {}): ActorContext {
  return {
    principalType: "HumanUser",
    principalId: "u-member",
    organizationId: "org-1",
    orgRole: "member",
    authSource: "ui",
    policyVersion: POLICY_VERSION,
    ...over,
  };
}

describe("enforceConnectorActionPolicy — infra connector (no catalog descriptor) fallback", () => {
  it("org_owner passes `manage` on an infra connector", () => {
    expect(enforceConnectorActionPolicy(INFRA, actor({ orgRole: "org_owner" }), "manage")).toMatchObject({
      allowed: true,
    });
  });

  it("org_admin passes `manage`", () => {
    expect(enforceConnectorActionPolicy(INFRA, actor({ orgRole: "org_admin" }), "manage")).toMatchObject({
      allowed: true,
    });
  });

  it("platform_admin passes `manage`", () => {
    expect(
      enforceConnectorActionPolicy(INFRA, actor({ orgRole: "member", platformRole: "platform_admin" }), "manage"),
    ).toMatchObject({ allowed: true });
  });

  it("non-admin member is DENIED `manage` (admin only, fail closed)", () => {
    expect(enforceConnectorActionPolicy(INFRA, actor({ orgRole: "member" }), "manage").allowed).toBe(false);
  });

  it("any authenticated actor may `read` an infra connector", () => {
    expect(enforceConnectorActionPolicy(INFRA, actor({ orgRole: "member" }), "read")).toMatchObject({
      allowed: true,
    });
  });

  it("no actor is denied (the guard redirects to sign-in earlier; this still fails closed)", () => {
    expect(enforceConnectorActionPolicy(INFRA, undefined, "manage").allowed).toBe(false);
  });

  it("catalog connectors are UNCHANGED: the fallback only triggers on unknown_connector", () => {
    // A known catalog connector with no actor denies with reason `no_actor`, NOT
    // `unknown_connector`, so the infra fallback must NOT relax it.
    const decision = enforceConnectorActionPolicy(CATALOG, undefined, "manage");
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toBe("no_actor");
  });
});
