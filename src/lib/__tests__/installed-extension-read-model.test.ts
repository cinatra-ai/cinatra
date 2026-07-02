// Read-model derivation matrix (cinatra#657). DI'd — no DB / no `/data` store.
//
// Exercises the query-time read-model's derived fields: actor visibility, the
// 3-status + absent mapping (archived≈disabled-recoverable, absent≈uninstalled),
// the live-wins row pick, teardown state, activation generation, and the
// best-effort trust verdict. Host `src/lib/__tests__` tests are not CI-gated
// today, so this is a local/dev guard for the read-model contract.

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildInstalledExtensionReadModel } from "@/lib/installed-extension-read-model.server";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { POLICY_VERSION, type ActorContext } from "@/lib/authz/actor-context";

const actor: ActorContext = {
  principalType: "HumanUser",
  principalId: "user-1",
  organizationId: "org-1",
  teamIds: ["team-A"],
  authSource: "ui",
  policyVersion: POLICY_VERSION,
};

function row(partial: Partial<InstalledExtension>): InstalledExtension {
  return {
    id: "iext_x",
    packageName: "@cinatra-ai/demo-connector",
    ownerLevel: "organization",
    ownerId: null,
    organizationId: "org-1",
    kind: "connector",
    status: "active",
    source: { type: "verdaccio", registryUrl: "r", packageName: "p", version: "1", integrity: "i" },
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...partial,
  } as InstalledExtension;
}

// Default deps: no store record, no anchor, fixed generation — isolate the
// canonical-row derivation from the heavy trust IO.
const baseDeps = {
  discoverRecords: async () => [],
  resolveTrustAnchor: async () => null,
  getActivationGeneration: () => 7,
};

describe("buildInstalledExtensionReadModel — actor-scoped status derivation", () => {
  it("a live active row → status active, visible, teardownState live", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.teardownState).toBe("live");
    expect(rm.kind).toBe("connector");
    expect(rm.activationGeneration).toBe(7);
    expect(rm.trust).toBeNull(); // no anchor → not resolvable, best-effort null
    expect(rm.sourcePackageStoreRecordPresent).toBe(false);
  });

  it("a locked row → status locked, visible, live", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "locked" })],
    });
    expect(rm.status).toBe("locked");
    expect(rm.teardownState).toBe("live");
  });

  it("an archived addressable row → status archived (disabled-recoverable), visible, torn-down", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "archived" })],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("archived");
    expect(rm.teardownState).toBe("torn-down");
  });

  it("no addressable row → status absent (uninstalled), not visible", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [],
    });
    expect(rm.actorVisible).toBe(false);
    expect(rm.status).toBe("absent");
    expect(rm.ownerScope).toBeNull();
    expect(rm.teardownState).toBe("torn-down");
  });

  it("a cross-org row is NOT addressable → absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", organizationId: "org-OTHER" })],
    });
    expect(rm.status).toBe("absent");
    expect(rm.actorVisible).toBe(false);
  });

  it("live wins: an active and an archived addressable row → active", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "archived", id: "a" }), row({ status: "active", id: "b" })],
    });
    expect(rm.status).toBe("active");
  });

  it("an owner-less user row fails closed (not addressable) → absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", ownerLevel: "user", ownerId: null })],
    });
    expect(rm.status).toBe("absent");
  });

  it("a team row addressable to a team member is visible", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active", ownerLevel: "team", ownerId: "team-A" })],
    });
    expect(rm.status).toBe("active");
    expect(rm.actorVisible).toBe(true);
  });

  it("null actor → absent record", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", null, baseDeps);
    expect(rm.status).toBe("absent");
    expect(rm.actorVisible).toBe(false);
  });

  it("canonical-store outage (readRows throws) → fail-safe absent", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => {
        throw new Error("db down");
      },
    });
    expect(rm.status).toBe("absent");
    expect(rm.actorVisible).toBe(false);
  });

  it("a present store record + trusted anchor surfaces the trust verdict + store presence", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () =>
        [
          { packageName: "@cinatra-ai/demo-connector", uiSurface: "schema-config", configSchema: null } as never,
        ],
      resolveTrustAnchor: async () => ({
        integrity: "sha512-x",
        contentHash: "ch",
        registryUrl: "https://registry.example",
        trustDecision: true,
        version: "1.0.0",
        signature: null,
      }),
      verifyIntegrity: async () => true,
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
    expect(rm.trust?.trusted).toBe(true);
    expect(rm.trust?.tier).toBe("trusted-bootstrap");
  });
});
