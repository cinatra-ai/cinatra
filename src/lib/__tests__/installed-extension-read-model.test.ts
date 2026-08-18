// Read-model derivation matrix (cinatra#657). DI'd — no DB / no `/data` store.
//
// Exercises the query-time read-model's derived fields: actor visibility, the
// 3-status + absent mapping (archived≈disabled-recoverable, absent≈uninstalled),
// the live-wins row pick, teardown state, activation generation, the
// supersession-first row pick (cinatra#2848), and the best-effort trust verdict.
// Runs in the root vitest suite (`src/**/__tests__/**/*.test.ts` is in the root
// include — the gate of record).

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { buildInstalledExtensionReadModel } from "@/lib/installed-extension-read-model.server";
import type { InstalledExtension } from "@cinatra-ai/extensions/canonical-types";
import { PLATFORM_OWNER_SENTINEL } from "@cinatra-ai/extensions/canonical-types";
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

  it("platform_admin: the active-org row wins over a cross-org row with a better status (same-org preference, P3)", async () => {
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...baseDeps,
      // The cross-org row is ACTIVE (better status) but must NOT out-rank the
      // admin's OWN-org locked row — the read-model metadata stays in the actor's
      // active org rather than bleeding an arbitrary other org's install.
      readRows: async () => [
        row({ status: "active", id: "cross", organizationId: "org-OTHER" }),
        row({ status: "locked", id: "mine", organizationId: "org-1" }),
      ],
    });
    expect(rm.status).toBe("locked");
    expect(rm.actorVisible).toBe(true);
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

// cinatra#792 — the read-model's trust verdict binds to the ANCHOR-BOUND record
// (kind + digest), never an arbitrary first match; an ambiguous store with a
// digest-unbound anchor yields NO verdict (fail closed). The verdict feeds
// runtime gates (cube serving), not just display.
describe("buildInstalledExtensionReadModel — cinatra#792 anchor-bound record selection", () => {
  const DIG_A = "a1".padEnd(64, "0");
  const DIG_B = "b2".padEnd(64, "0");
  const anchor = {
    integrity: "sha512-x",
    contentHash: "ch",
    registryUrl: "https://registry.example",
    trustDecision: true,
    version: "1.0.0",
    signature: null,
  };
  const rec = (declaredDigest: string, kind = "connector") =>
    ({ packageName: "@cinatra-ai/demo-connector", declaredDigest, kind, uiSurface: "schema-config", configSchema: null }) as never;

  it("a digest-BOUND anchor evaluates the verdict against exactly the record it pins", async () => {
    const verified: string[] = [];
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () => [rec(DIG_B), rec(DIG_A)],
      resolveTrustAnchor: async () => ({ ...anchor, kind: "connector", digest: DIG_A }),
      verifyIntegrity: async (r: { declaredDigest?: string }) => {
        verified.push(r.declaredDigest ?? "(flat)");
        return true;
      },
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
    expect(rm.trust?.trusted).toBe(true);
    expect(verified).toEqual([DIG_A]); // never the retained prior digest
  });

  it("FAIL-CLOSED: a digest-UNBOUND anchor with >1 on-disk record → no verdict (ambiguous)", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () => [rec(DIG_A), rec(DIG_B)],
      resolveTrustAnchor: async () => ({ ...anchor, kind: "connector" }),
      verifyIntegrity: async () => true,
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true); // present on disk...
    expect(rm.trust).toBeNull(); // ...but no verdict from an ambiguous store
  });

  it("FAIL-CLOSED: the anchor's canonical-row kind contradicts the record's path kind → no verdict", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [row({ status: "active" })],
      discoverRecords: async () => [rec(DIG_A, "connector"), rec(DIG_B, "connector")],
      resolveTrustAnchor: async () => ({ ...anchor, kind: "agent", digest: DIG_A }),
      verifyIntegrity: async () => true,
      classifyTrust: () => ({ tier: "trusted-bootstrap", trusted: true, reason: "test" }),
    });
    expect(rm.sourcePackageStoreRecordPresent).toBe(true);
    expect(rm.trust).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// cinatra#2848 — SUPERSESSION-FIRST in the installed-rows READ MODEL.
//
// The rule already exists on main and the lifecycle target resolver applies it
// first (`effectiveInstallRows` → `addressableLifecycleRows`); the four
// write-side seams were aligned to it in #2774. This read model picked without
// it, so a superseded organization row could still be the row a read-model-driven
// surface reported (the CG-5 runtime-cube serve gate is the production consumer).
//
// The helper is NOT mocked here: these drive the real
// `@cinatra-ai/extensions/lifecycle-target-resolver` export through the real
// `buildInstalledExtensionReadModel`; only the canonical-store READ is injected.
// ---------------------------------------------------------------------------

/** The exact workspace anchor the S2 write path persists: org-NULL, `workspace`,
 *  `__platform__`. Anything else is NOT a superseding row. */
function workspaceRow(partial: Partial<InstalledExtension> = {}): InstalledExtension {
  return row({
    id: "iext_workspace",
    ownerLevel: "workspace",
    ownerId: PLATFORM_OWNER_SENTINEL,
    organizationId: null,
    ...partial,
  });
}

describe("buildInstalledExtensionReadModel — supersession-first (cinatra#2848)", () => {
  it("a superseded organization row is NOT the reported row — the live workspace row is, even when the org row ranks better", async () => {
    // Pre-fix this returned the ORG row: both rows are addressable and neither is
    // cross-org, so the status ranking alone decided and `active` beat `locked`.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "locked" }),
      ],
    });
    expect(rm.status).toBe("locked");
    expect(rm.ownerScope).toEqual({
      ownerLevel: "workspace",
      ownerId: PLATFORM_OWNER_SENTINEL,
      organizationId: null,
    });
  });

  it("array order can no longer surface the superseded row (two live rows, org row first)", async () => {
    // Two live rows of equal status rank: the pick was first-wins, so the row the
    // canonical store happened to return first was reported.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1", kind: "agent" }),
        workspaceRow({ status: "active", kind: "connector" }),
      ],
    });
    expect(rm.ownerScope?.organizationId).toBeNull();
    // No field of the superseded row leaks into the record either.
    expect(rm.kind).toBe("connector");
  });

  it("a superseded ARCHIVED organization row does not report `archived` / `torn-down`", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "archived", organizationId: "org-1" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.teardownState).toBe("live");
    expect(rm.ownerScope?.organizationId).toBeNull();
  });

  it("a platform admin's OWN-org row is superseded too (the same-org preference does not rescue it)", async () => {
    const platformAdmin: ActorContext = { ...actor, platformRole: "platform_admin" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", platformAdmin, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        row({ id: "iext_other", status: "active", organizationId: "org-OTHER" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.ownerScope?.organizationId).toBeNull();
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
  });

  // THE SURVIVOR. Supersession never blanks the model: the superseding row is
  // org-NULL and workspace-anchored, so it is addressable by every authenticated
  // actor — including one whose org holds no row at all. The read model reports
  // the row that IS in force, which is what the write seams would address.
  it("supersession-survivor: the live workspace row is reported, visible and live", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.teardownState).toBe("live");
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
  });

  it("supersession-survivor: an actor whose org holds NO row still reads the workspace row", async () => {
    const otherOrgActor: ActorContext = { ...actor, organizationId: "org-9" };
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", otherOrgActor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "active" }),
      ],
    });
    expect(rm.actorVisible).toBe(true);
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.ownerLevel).toBe("workspace");
  });

  // NO-SUPERSESSION CASES — the rule is keyed on a LIVE, WORKSPACE-ANCHORED row.
  // Every other shape must be byte-identical to the pre-fix pick.
  it("an ARCHIVED workspace row supersedes nothing — the org row is still reported", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        workspaceRow({ status: "archived" }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });

  it("a live PLATFORM (bundled) org-NULL anchor supersedes nothing — the org row is still reported", async () => {
    // Narrowness pin: the bundled `platform` tier sits at the SAME org-NULL scope
    // but is not the workspace anchor, so it must not drop the org rows.
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org", status: "active", organizationId: "org-1" }),
        row({ id: "iext_bundled", status: "active", ownerLevel: "platform", ownerId: null, organizationId: null }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });

  it("no workspace row at all — the org-only pick is unchanged", async () => {
    const rm = await buildInstalledExtensionReadModel("@cinatra-ai/demo-connector", actor, {
      ...baseDeps,
      readRows: async () => [
        row({ id: "iext_org_archived", status: "archived", organizationId: "org-1" }),
        row({ id: "iext_org_active", status: "active", organizationId: "org-1" }),
      ],
    });
    expect(rm.status).toBe("active");
    expect(rm.ownerScope?.organizationId).toBe("org-1");
  });
});
