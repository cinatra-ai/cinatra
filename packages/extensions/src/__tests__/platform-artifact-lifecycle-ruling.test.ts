import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "../canonical-types";

// ===========================================================================
// OWNER RULING 2026-07-22 (groganz) — platform-wide (NULL-org) archive/restore
// of a `kind:"artifact"` extension REFUSES while any organization still has the
// extension installed (fail-closed), naming the organizations so the admin has
// the migration list; once none remain it proceeds at the platform scope.
// Restore is symmetric with the ruled archive. (Resolves the deferred platform
// legs of cinatra#1454 R1 / cinatra#1837 R1.)
//
// This file pins: (a) the PURE enumeration decision; (b) the BEST-EFFORT
// org-name resolver seam; (c) the dispatcher end-to-end matrix (refuse-with-org-
// list-and-names / proceed-when-none for BOTH archive and restore); (d) the
// regression that the shipped ORG-SCOPED R3 reactivation seam is UNTOUCHED.
//
// Real dispatcher + real resolver + real enumeration against the store boundary
// (`readInstalledExtensionsByPackageName` seeded with real InstalledExtension
// rows) — the enumeration decision is never stubbed.
// ===========================================================================

let SEEDED: InstalledExtension[] = [];

const PKG = "@v/pkg-artifact";
function row(
  id: string,
  organizationId: string | null,
  extra: Partial<InstalledExtension> = {},
): InstalledExtension {
  return {
    id,
    packageName: PKG,
    ownerLevel: organizationId == null ? "platform" : "organization",
    ownerId: organizationId,
    organizationId,
    kind: "artifact",
    status: "active",
    source: { type: "verdaccio", version: "1.0.0" } as InstalledExtension["source"],
    requiredInProd: false,
    dependencies: [],
    manifestHash: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...extra,
  };
}

const transitions: { id: string; op: string }[] = [];

vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => SEEDED),
  readInstalledExtensionById: vi.fn(async (id: string) => SEEDED.find((r) => r.id === id) ?? null),
  listInstalledExtensions: vi.fn(async () => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map<string, "active" | "archived">()),
}));
vi.mock("../lifecycle-primitive", () => ({
  transitionExtensionLifecycle: vi.fn(async (id: string, op: string) => {
    transitions.push({ id, op });
    return null;
  }),
  installExtensionManifest: vi.fn(async () => ({})),
  deleteNonFinalizedCanonicalRow: vi.fn(async () => {}),
}));
vi.mock("../activate-hook", () => ({
  fireExtensionActivate: vi.fn(async () => ({ finalized: true, activated: false, reason: "metadata-only-kind" })),
}));
vi.mock("../audit-log", () => ({
  computeDanglingReferences: vi.fn(async () => ({})),
  writeExtensionLifecycleAuditEntry: vi.fn(async () => {}),
  writeExtensionLifecycleTransitionAudit: vi.fn(async () => {}),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(async () => null),
  countRunsForTemplate: vi.fn(async () => 0),
  readAgentTemplatesDependingOn: vi.fn(async () => []),
  removeReferencingRunRows: vi.fn(async () => {}),
  withInstallLock: (_name: string, fn: () => unknown) => fn(),
}));

import {
  extensionRegistry,
  PlatformArtifactLifecycleOrgInstallsError,
  enumerateOrgScopedInstallsBlockingPlatformArchive,
} from "../index";
import {
  setExtensionArtifactClaimArchivalHook,
  setExtensionArtifactClaimReactivationHook,
  setExtensionArchiveOrgNameResolver,
  resolveExtensionArchiveOrgNames,
} from "../artifact-claim-lifecycle-hook";

const platformAdmin = (): Actor => ({
  actorType: "system",
  userId: "u-admin",
  source: "worker",
  platformRole: "platform_admin",
});
const orgAdmin = (orgId: string): Actor => ({
  actorType: "system",
  userId: "u-org",
  source: "worker",
  orgId,
  orgRole: "org_admin",
});

const ref = () => ({ registryUrl: "", packageName: PKG, version: "1.0.0" });

function artifactHandler() {
  return {
    typeId: "artifact",
    install: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
  };
}
function agentHandler() {
  return {
    typeId: "agent",
    install: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
  };
}
// An actor bound to a specific (possibly malformed) org id — used to drive the
// resolver to a chosen row (`pickLifecycleTargetRow` keys on organizationId).
const orgBoundActor = (orgId: string): Actor => ({
  actorType: "system",
  userId: "u-bound",
  source: "worker",
  orgId,
  orgRole: "org_admin",
});

let archivalFired: unknown[];
let reactivationFired: unknown[];
beforeEach(() => {
  extensionRegistry._resetForTesting();
  vi.clearAllMocks();
  transitions.length = 0;
  extensionRegistry.register(artifactHandler());
  archivalFired = [];
  reactivationFired = [];
  setExtensionArtifactClaimArchivalHook((input) => {
    archivalFired.push(input);
  });
  setExtensionArtifactClaimReactivationHook((input) => {
    reactivationFired.push(input);
  });
});
afterEach(() => {
  setExtensionArtifactClaimArchivalHook(null);
  setExtensionArtifactClaimReactivationHook(null);
  setExtensionArchiveOrgNameResolver(null);
});

// ---------------------------------------------------------------------------
// (a) PURE enumeration decision
// ---------------------------------------------------------------------------
describe("enumerateOrgScopedInstallsBlockingPlatformArchive (pure)", () => {
  it("no rows → no blockers", () => {
    expect(enumerateOrgScopedInstallsBlockingPlatformArchive([])).toEqual([]);
  });

  it("a platform (null) row is never an org install", () => {
    expect(
      enumerateOrgScopedInstallsBlockingPlatformArchive([
        { organizationId: null, status: "active" },
      ]),
    ).toEqual([]);
  });

  it("counts org rows in the LIVE set (active|locked), excludes archived, dedups, sorts", () => {
    expect(
      enumerateOrgScopedInstallsBlockingPlatformArchive([
        { organizationId: "org-b", status: "active" },
        { organizationId: "org-a", status: "locked" },
        { organizationId: "org-c", status: "archived" }, // migrated off — never blocks
        { organizationId: "org-b", status: "locked" }, // dup org-b
        { organizationId: null, status: "active" }, // platform row
        { organizationId: "", status: "active" }, // malformed/empty — not an org
      ]),
    ).toEqual(["org-a", "org-b"]);
  });
});

// ---------------------------------------------------------------------------
// (b) BEST-EFFORT org-name resolver seam
// ---------------------------------------------------------------------------
describe("org-name resolver seam (best-effort)", () => {
  it("unwired → empty map (id-only fallback)", async () => {
    expect(await resolveExtensionArchiveOrgNames(["org-a"])).toEqual(new Map());
  });

  it("empty input → empty map (never invokes the resolver)", async () => {
    const resolver = vi.fn(async () => new Map([["x", "X"]]));
    setExtensionArchiveOrgNameResolver(resolver);
    expect(await resolveExtensionArchiveOrgNames([])).toEqual(new Map());
    expect(resolver).not.toHaveBeenCalled();
  });

  it("wired resolver returns the names it can resolve", async () => {
    setExtensionArchiveOrgNameResolver(async (ids) => new Map(ids.map((id) => [id, `Name(${id})`])));
    expect(await resolveExtensionArchiveOrgNames(["org-a", "org-b"])).toEqual(
      new Map([
        ["org-a", "Name(org-a)"],
        ["org-b", "Name(org-b)"],
      ]),
    );
  });

  it("a throwing resolver is swallowed → empty map (never fails the refusal closed)", async () => {
    setExtensionArchiveOrgNameResolver(() => {
      throw new Error("org db down");
    });
    expect(await resolveExtensionArchiveOrgNames(["org-a"])).toEqual(new Map());
  });
});

// ---------------------------------------------------------------------------
// (c) DISPATCHER matrix — refuse-with-list-and-names / proceed-when-none
// ---------------------------------------------------------------------------
describe("platform archive (dispatcher)", () => {
  it("REFUSES while orgs still have it installed — names the migration list (id + name where resolvable)", async () => {
    SEEDED = [row("iext-p", null), row("iext-b", "org-b"), row("iext-a", "org-a")];
    // Resolver resolves org-a's name but not org-b's → org-b falls back to id-only.
    setExtensionArchiveOrgNameResolver(async () => new Map([["org-a", "Acme Inc"]]));
    const err = await extensionRegistry
      .archive("artifact", ref(), platformAdmin())
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlatformArtifactLifecycleOrgInstallsError);
    expect(err.operation).toBe("archive");
    expect(err.packageName).toBe(PKG);
    expect(err.organizations).toEqual([{ id: "org-a", name: "Acme Inc" }, { id: "org-b" }]);
    expect(err.message).toContain("Acme Inc (org-a)");
    // Fail-closed: no claim archival fired, no durable transition.
    expect(archivalFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("PROCEEDS at platform scope when no org has it installed", async () => {
    SEEDED = [row("iext-p", null)];
    await extensionRegistry.archive("artifact", ref(), platformAdmin());
    expect(archivalFired).toEqual([
      expect.objectContaining({ packageName: PKG, organizationId: null }),
    ]);
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-p", op: "archive" })]);
  });

  it("an archived org row does NOT block (that org already migrated off)", async () => {
    SEEDED = [row("iext-p", null), row("iext-a", "org-a", { status: "archived" })];
    await extensionRegistry.archive("artifact", ref(), platformAdmin());
    expect(archivalFired).toEqual([
      expect.objectContaining({ packageName: PKG, organizationId: null }),
    ]);
  });
});

describe("platform restore (dispatcher) — symmetric with the ruled archive", () => {
  it("REFUSES while orgs still have it installed", async () => {
    SEEDED = [row("iext-p", null, { status: "archived" }), row("iext-a", "org-a")];
    const err = await extensionRegistry
      .restore("artifact", ref(), platformAdmin())
      .then(() => null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(PlatformArtifactLifecycleOrgInstallsError);
    expect(err.operation).toBe("restore");
    expect(err.organizations.map((o: { id: string }) => o.id)).toEqual(["org-a"]);
    expect(reactivationFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("PROCEEDS at platform scope when no org has it installed", async () => {
    SEEDED = [row("iext-p", null, { status: "archived" })];
    await extensionRegistry.restore("artifact", ref(), platformAdmin());
    expect(reactivationFired).toEqual([
      expect.objectContaining({ packageName: PKG, organizationId: null }),
    ]);
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-p", op: "activate" })]);
  });
});

// ---------------------------------------------------------------------------
// (d) REGRESSION — the shipped ORG-SCOPED R3 reactivation seam is UNTOUCHED.
// ---------------------------------------------------------------------------
describe("regression: org-scoped R3 reactivation seam untouched", () => {
  it("an ORG-SCOPED restore fires the reactivation seam at the org:<id> scope (never the platform gate)", async () => {
    SEEDED = [row("iext-x", "org-x", { status: "archived" })];
    await extensionRegistry.restore("artifact", ref(), orgAdmin("org-x"));
    expect(reactivationFired).toEqual([
      expect.objectContaining({ packageName: PKG, organizationId: "org-x", installId: "iext-x" }),
    ]);
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-x", op: "activate" })]);
  });

  it("an ORG-SCOPED archive fires the archival seam at the org:<id> scope", async () => {
    SEEDED = [row("iext-x", "org-x")];
    await extensionRegistry.archive("artifact", ref(), orgAdmin("org-x"));
    expect(archivalFired).toEqual([
      expect.objectContaining({ packageName: PKG, organizationId: "org-x", installId: "iext-x" }),
    ]);
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-x", op: "archive" })]);
  });
});

// ---------------------------------------------------------------------------
// FAIL-CLOSED dispatcher guards (owner-ruling hardening) — a malformed
// empty-string org id and a mis-dispatched artifact row must both REFUSE (no
// fire, no transition), symmetrically across archive + restore.
// ---------------------------------------------------------------------------
describe("fail-closed dispatcher guards", () => {
  it("REFUSES a malformed empty-string organizationId row on ARCHIVE (never an ungated platform sweep)", async () => {
    // A row that is neither a genuine platform install (null) nor a scope-exact
    // org install ("") — the pre-hardening `!row.organizationId` conflated it
    // with the platform row. Drive the resolver to it via an org-""-bound actor.
    SEEDED = [row("iext-empty", "")];
    const err = await extensionRegistry
      .archive("artifact", ref(), orgBoundActor(""))
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/malformed empty organizationId/i);
    expect(archivalFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("REFUSES a malformed empty-string organizationId row on RESTORE (symmetric)", async () => {
    SEEDED = [row("iext-empty", "", { status: "archived" })];
    const err = await extensionRegistry
      .restore("artifact", ref(), orgBoundActor(""))
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/malformed empty organizationId/i);
    expect(reactivationFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("REFUSES a kind:'artifact' row dispatched under a non-artifact typeId on ARCHIVE (gate would be silently skipped)", async () => {
    // A registry-read outage can mis-derive an artifact package's typeId to
    // "agent" (deriveTypeId floors an unresolved kind); the gate + platform
    // refusal must NOT be skipped as a no-op.
    extensionRegistry.register(agentHandler());
    SEEDED = [row("iext-x", "org-x")]; // kind:"artifact" (the row factory default)
    const err = await extensionRegistry
      .archive("agent", ref(), orgAdmin("org-x"))
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/kind:"artifact".*typeId="agent"/);
    expect(archivalFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("REFUSES a kind:'artifact' row dispatched under a non-artifact typeId on RESTORE (symmetric)", async () => {
    extensionRegistry.register(agentHandler());
    SEEDED = [row("iext-x", "org-x", { status: "archived" })];
    const err = await extensionRegistry
      .restore("agent", ref(), orgAdmin("org-x"))
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/kind:"artifact".*typeId="agent"/);
    expect(reactivationFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("REFUSES a platform archive when a live MALFORMED empty-org SIBLING row exists (enumeration fails closed, not skips)", async () => {
    // A valid NULL-org platform target + a live "" sibling: the pure enumeration
    // SKIPS the "" row, so without the sibling guard the sweep would proceed. The
    // enumeration path must fail closed over the whole set.
    SEEDED = [row("iext-p", null), row("iext-empty", "", { status: "active" })];
    const err = await extensionRegistry
      .archive("artifact", ref(), platformAdmin())
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/malformed empty organizationId/i);
    expect(String(err?.message)).toContain("iext-empty");
    expect(archivalFired).toEqual([]);
    expect(transitions).toEqual([]);
  });

  it("REFUSES a platform restore when a live MALFORMED empty-org SIBLING row exists (symmetric)", async () => {
    SEEDED = [row("iext-p", null, { status: "archived" }), row("iext-empty", "", { status: "locked" })];
    const err = await extensionRegistry
      .restore("artifact", ref(), platformAdmin())
      .then(() => null)
      .catch((e) => e);
    expect(String(err?.message)).toMatch(/malformed empty organizationId/i);
    expect(reactivationFired).toEqual([]);
    expect(transitions).toEqual([]);
  });
});
