// Covers the dispatch route's static guarantees without booting Next.js:
// every catalog descriptor maps to a `setup` subroute, the registry resolves
// an entry for it, and the policy stub's admin/workspace split holds.

import { describe, expect, it, vi } from "vitest";
import { CONNECTOR_DESCRIPTORS } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import {
  getConnectorRegistryEntryBySlug,
  connectorRequiresSetupPageLoader,
} from "@/lib/connectors-registry.server";

// enforceConnectorPolicy resolves the canonical connector access FIRST. With no
// DB in this unit test the canonical read would fail closed
// (deny). Mock the resolver to "absent" to simulate the realistic pre-migration
// state (canonical tables present, no connector rows yet) so these invariants
// exercise the catalog-default fallback split — since cinatra#955 that default
// derives from each connector's SHIPPED cinatra/config.json (the generated
// manifest pass-through), so the expectation below recomputes the tier from
// the same shipped bytes through the SDK validator.
vi.mock("@/lib/connector-access-resolver", () => ({
  resolveConnectorCanonicalAccessSync: () => ({ status: "absent" }),
}));

// Sibling to the resolver mock above: on the "absent"/legacy-fallback path
// enforceConnectorPolicy reads the deprecated connector_access_policy table via
// readConnectorAccessPolicy — a REAL synchronous pg worker (runPostgresQueriesSync
// spawns a worker_thread that require()s `pg` and TCP-connects). This unit test
// has NO DB, so stub that read to "no row" — the SAME pre-migration state the
// resolver mock already simulates — so the assertions below exercise the pure
// catalog-default fallback hermetically. Without it, every descriptor spawns a
// sync pg worker; the two all-descriptor loops accumulate ~40 worker spawns and,
// under wholesale-suite CPU contention, exceed the 30s per-test ceiling (a
// synchronous test that blocks in Atomics.wait → "Test timed out in 30000ms").
vi.mock("@/lib/connector-policy-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/connector-policy-store")>()),
  readConnectorAccessPolicy: () => undefined,
}));

import { enforceConnectorPolicy } from "@/lib/connector-policy";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { parseConnectorAccessConfig } from "@cinatra-ai/sdk-extensions/access-config";

// Independent recomputation of the 2-tier default from the shipped config —
// absent/undeclared resolves "admin" (fail-closed), matching the host helper.
function expectedTier(packageId: string): "admin" | "workspace" {
  const raw = STATIC_EXTENSION_MANIFEST[packageId]?.accessConfig ?? null;
  if (raw === null) return "admin";
  return parseConnectorAccessConfig(raw, { packageName: packageId }).scope === "admin"
    ? "admin"
    : "workspace";
}

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
      // A bundled-react connector carries a React setup-page LOADER (function); a
      // schema-config connector (cinatra#658 — e.g. the external-MCP connector
      // after its pin bump) ships NO React page, so `loadSetupPage` is `null` and
      // the host renders its declared `configSchema` instead. Assert per the
      // connector's declared surface, not a blanket "always a function".
      if (connectorRequiresSetupPageLoader(d.packageId)) {
        expect(typeof entry?.loadSetupPage, `loader for ${d.slug}`).toBe("function");
      } else {
        expect(entry?.loadSetupPage, `schema-config ${d.slug} has no loader`).toBeNull();
      }
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
        expectedTier(d.packageId) === "workspace",
      );
    }
  });

  it("manage mode is admin-only even for workspace-visibility connectors", () => {
    const workspaceConnector = CONNECTOR_DESCRIPTORS.find(
      (d) => expectedTier(d.packageId) === "workspace",
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
