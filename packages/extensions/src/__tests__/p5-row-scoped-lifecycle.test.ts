import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "../canonical-types";

// ===========================================================================
// P5 (cinatra#1130) — row-scoped lifecycle dispatcher matrix.
//
// The keystone-gap regression (cross-org escalation) + the 9 failure modes +
// positive parity + carve-outs + audit assertions from the converged design.
// Exercises the REAL dispatcher + REAL resolver against mocked stores/hooks.
// ===========================================================================

// --- mutable canonical row set (seeded per test) ---------------------------
let SEEDED: InstalledExtension[] = [];

const PKG = "@acme/thing";
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
    kind: "agent",
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

// --- captured side effects -------------------------------------------------
type Transition = { id: string; op: string; reason: string };
const transitions: Transition[] = [];
type TransitionAudit = {
  operation: string;
  resolvedRowId: string;
  orgId: string | null;
  actorId?: string;
};
const transitionAudits: TransitionAudit[] = [];
type ForceDeleteAudit = { operation: string; resolvedRows: unknown };
const forceDeleteAudits: ForceDeleteAudit[] = [];
const preCleanedTemplateIds: string[] = [];
let dataTeardownFired: string[] = [];
// F9 (cinatra#1277): the package-global in-memory capability teardown. It is the
// ONLY channel that drops a package's register(ctx) registrations (MCP tools /
// capability providers / ctx.ui / object types / cubes / portlets) in the running
// worker. Because those registries are keyed by package name with no org
// dimension, firing it on an org-admin SOFT action would remove the package for
// EVERY org — so an org-admin soft path must NOT fire it.
let capabilityTeardownFired: string[] = [];

// --- mocks -----------------------------------------------------------------
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => SEEDED),
  readInstalledExtensionById: vi.fn(async (id: string) => SEEDED.find((r) => r.id === id) ?? null),
  // Closure gates read this — return [] so archive/restore closure is inert.
  listInstalledExtensions: vi.fn(async () => []),
  readEffectiveStatusByPackageNames: vi.fn(async () => new Map<string, "active" | "archived">()),
}));

vi.mock("../lifecycle-primitive", () => ({
  transitionExtensionLifecycle: vi.fn(
    async (id: string, op: string, opts: { reason: string }) => {
      transitions.push({ id, op, reason: opts.reason });
      return null;
    },
  ),
  installExtensionManifest: vi.fn(async () => ({})),
  deleteNonFinalizedCanonicalRow: vi.fn(async () => {}),
}));

vi.mock("../activate-hook", () => ({
  fireExtensionActivate: vi.fn(async () => ({
    finalized: true,
    activated: false,
    reason: "metadata-only-kind",
  })),
}));

vi.mock("../audit-log", () => ({
  computeDanglingReferences: vi.fn(async () => ({
    agent_runs_count: 0,
    agent_runs_count_capped: false,
    dependent_extensions: [],
    dependent_extensions_capped: false,
  })),
  writeExtensionLifecycleAuditEntry: vi.fn(
    async (input: { operation: string; resolvedRows: unknown }) => {
      forceDeleteAudits.push({
        operation: input.operation,
        resolvedRows: input.resolvedRows,
      });
    },
  ),
  writeExtensionLifecycleTransitionAudit: vi.fn(
    async (input: {
      actor: Actor;
      operation: string;
      resolvedRow: { id: string; organizationId: string | null };
    }) => {
      transitionAudits.push({
        operation: input.operation,
        resolvedRowId: input.resolvedRow.id,
        orgId: input.resolvedRow.organizationId,
        actorId: input.actor.userId,
      });
    },
  ),
}));

vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateByPackageName: vi.fn(async () => null),
  countRunsForTemplate: vi.fn(async () => 0),
  readAgentTemplatesDependingOn: vi.fn(async () => []),
  removeReferencingRunRows: vi.fn(async (id: string) => {
    preCleanedTemplateIds.push(id);
    return {
      agent_runs: 0,
      agent_versions: 0,
      agent_template_versions: 0,
      agent_registry_entries: 0,
      agent_forks: 0,
      runIds: [] as string[],
      runIdsTruncated: false,
    };
  }),
  withInstallLock: (_name: string, fn: () => unknown) => fn(),
}));

import { extensionRegistry } from "../index";
import {
  NoAddressableRowError,
  AmbiguousLifecycleTargetError,
  LifecycleStandingError,
  PlatformAdminRequiredError,
} from "../lifecycle-target-resolver";
import { setExtensionDataTeardownHook } from "../data-teardown-hook";
import { setExtensionCapabilityTeardownHook } from "../capability-teardown-hook";
import { readAgentTemplateByPackageName } from "@cinatra-ai/agents";

// --- actors ----------------------------------------------------------------
const platformAdmin = (orgId?: string): Actor => ({
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  platformRole: "platform_admin",
  ...(orgId ? { orgId } : {}),
});
const orgAdmin = (orgId: string, userId = "u-org"): Actor => ({
  actorType: "human",
  userId,
  source: "ui",
  orgId,
  orgRole: "org_admin",
});
const member = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-mem",
  source: "ui",
  orgId,
  orgRole: "member",
});

const ref = (packageName = PKG) => ({
  registryUrl: "",
  packageName,
  version: "1.0.0",
});

function makeHandler() {
  return {
    typeId: "agent",
    install: vi.fn(async () => {}),
    update: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    archive: vi.fn(async () => {}),
    restore: vi.fn(async () => {}),
  };
}
let handler: ReturnType<typeof makeHandler>;

beforeEach(() => {
  extensionRegistry._resetForTesting();
  vi.clearAllMocks();
  transitions.length = 0;
  transitionAudits.length = 0;
  forceDeleteAudits.length = 0;
  preCleanedTemplateIds.length = 0;
  dataTeardownFired = [];
  setExtensionDataTeardownHook((pkg) => {
    dataTeardownFired.push(pkg);
  });
  capabilityTeardownFired = [];
  setExtensionCapabilityTeardownHook((pkg) => {
    capabilityTeardownFired.push(pkg);
  });
  handler = makeHandler();
  extensionRegistry.register(handler);
  SEEDED = [row("iext-p", null), row("iext-x", "org-x"), row("iext-y", "org-y")];
});
afterEach(() => {
  setExtensionDataTeardownHook(null);
  setExtensionCapabilityTeardownHook(null);
});

// ---------------------------------------------------------------------------
// 6.1 Cross-org escalation regression (the keystone-gap guard)
// ---------------------------------------------------------------------------
describe("cross-org escalation regression", () => {
  it("org-X admin archive touches ONLY the org-X row (org-Y + platform unchanged)", async () => {
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    expect(transitions).toEqual([
      expect.objectContaining({ id: "iext-x", op: "archive" }),
    ]);
    expect(transitions.map((t) => t.id)).not.toContain("iext-y");
    expect(transitions.map((t) => t.id)).not.toContain("iext-p");
    // one audit row, carrying the org-X resolved-row identity
    expect(transitionAudits).toHaveLength(1);
    expect(transitionAudits[0]).toMatchObject({ resolvedRowId: "iext-x", orgId: "org-x" });
    // F9 (cinatra#1277): the package-global capability teardown does NOT fire on
    // the org-admin soft path, so org-Y's + the platform row's in-process
    // registrations stay live in the running worker.
    expect(capabilityTeardownFired).toEqual([]);
  });

  it("org-X admin soft-uninstall touches ONLY the org-X row and fires NO package-global hooks", async () => {
    await extensionRegistry.uninstall("agent", ref(), orgAdmin("org-x"));
    // soft/archive path: handler.archive, NOT handler.uninstall
    expect(handler.archive).toHaveBeenCalledTimes(1);
    expect(handler.uninstall).not.toHaveBeenCalled();
    // canonical transition row-scoped to org-X, op archive
    expect(transitions).toEqual([
      expect.objectContaining({ id: "iext-x", op: "archive" }),
    ]);
    // package-global destructive hooks did NOT fire
    expect(preCleanedTemplateIds).toEqual([]);
    expect(dataTeardownFired).toEqual([]);
    // F9 (cinatra#1277): nor the package-global in-memory capability teardown.
    expect(capabilityTeardownFired).toEqual([]);
  });

  it("org admin force_delete is REFUSED with ZERO row changes", async () => {
    await expect(
      extensionRegistry.forceDelete("agent", ref(), orgAdmin("org-x")),
    ).rejects.toThrow(PlatformAdminRequiredError);
    expect(forceDeleteAudits).toEqual([]);
    expect(preCleanedTemplateIds).toEqual([]);
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
  });

  it("org-A admin cannot transition org-B's row (F5) — throws, org-B untouched", async () => {
    SEEDED = [row("iext-b", "org-b")];
    await expect(
      extensionRegistry.archive("agent", ref(), orgAdmin("org-a")),
    ).rejects.toThrow(NoAddressableRowError);
    expect(handler.archive).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
  });

  it("org admin cannot reach the platform NULL-org row (F2) even when their org has no row", async () => {
    SEEDED = [row("iext-p", null)];
    await expect(
      extensionRegistry.archive("agent", ref(), orgAdmin("org-a")),
    ).rejects.toThrow(NoAddressableRowError);
    expect(transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Failure modes F1 / F3 / F6 / F7 / F8 (F2/F5 covered above; F4/F9 below)
// ---------------------------------------------------------------------------
describe("failure modes", () => {
  it("F1: org admin whose org has no row -> NoAddressableRowError", async () => {
    SEEDED = [row("iext-p", null), row("iext-x", "org-x")];
    await expect(
      extensionRegistry.archive("agent", ref(), orgAdmin("org-z")),
    ).rejects.toThrow(NoAddressableRowError);
  });

  it("F6: two rows for the actor's org -> AmbiguousLifecycleTargetError (fail closed)", async () => {
    SEEDED = [row("iext-x1", "org-x"), row("iext-x2", "org-x")];
    await expect(
      extensionRegistry.archive("agent", ref(), orgAdmin("org-x")),
    ).rejects.toThrow(AmbiguousLifecycleTargetError);
    expect(transitions).toEqual([]);
  });

  it("F7: platform admin, no org context, no NULL-org row -> NoAddressableRowError", async () => {
    SEEDED = [row("iext-x", "org-x"), row("iext-y", "org-y")];
    await expect(
      extensionRegistry.archive("agent", ref(), platformAdmin()),
    ).rejects.toThrow(NoAddressableRowError);
  });

  it("F8: org admin hard-delete-uninstall never hard-deletes (routes to soft), force_delete refused", async () => {
    // Even with a platform-admin-only HARD-delete predicate (unused, no deps),
    // an org admin's uninstall takes the SOFT path — handler.uninstall never runs.
    (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    await extensionRegistry.uninstall("agent", ref(), orgAdmin("org-x"));
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(handler.archive).toHaveBeenCalledTimes(1);
  });

  it("member / no-standing actor is denied on every mutation", async () => {
    await expect(
      extensionRegistry.archive("agent", ref(), member("org-x")),
    ).rejects.toThrow(LifecycleStandingError);
    expect(handler.archive).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6.2 Positive parity
// ---------------------------------------------------------------------------
describe("positive parity", () => {
  it("org-X admin archive -> restore round-trips their org-X row", async () => {
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    // restore: seed the org-X row as archived; resolver still resolves by org.
    SEEDED = [
      row("iext-p", null),
      row("iext-x", "org-x", { status: "archived" }),
      row("iext-y", "org-y"),
    ];
    await extensionRegistry.restore("agent", ref(), orgAdmin("org-x"));
    expect(handler.restore).toHaveBeenCalledTimes(1);
    const restoreT = transitions.filter((t) => t.op === "activate");
    expect(restoreT).toEqual([expect.objectContaining({ id: "iext-x", op: "activate" })]);
  });

  it("a DIFFERENT org-X admin (not the installer) has identical reach — role-derived", async () => {
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x", "some-other-admin"));
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-x" })]);
    expect(transitionAudits[0].actorId).toBe("some-other-admin");
  });

  it("platform admin with explicit targetOrgId=Y transitions only org-Y's row; audit records org-Y id", async () => {
    await extensionRegistry.archive("agent", ref(), platformAdmin("org-y"));
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-y", op: "archive" })]);
    expect(transitionAudits[0]).toMatchObject({ resolvedRowId: "iext-y", orgId: "org-y" });
  });

  it("platform admin force_delete succeeds: run-rows pre-cleaned, audit written, all rows cleaned", async () => {
    (readAgentTemplateByPackageName as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "tpl-1" });
    const result = await extensionRegistry.forceDelete("agent", ref(), platformAdmin(), "cleanup");
    expect(result.danglingReferences).toBeDefined();
    expect(handler.uninstall).toHaveBeenCalledTimes(1);
    expect(preCleanedTemplateIds).toEqual(["tpl-1"]);
    // audit written BEFORE destruction, carrying every affected row id
    expect(forceDeleteAudits).toHaveLength(1);
    expect(forceDeleteAudits[0].operation).toBe("force_delete");
    expect(forceDeleteAudits[0].resolvedRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "iext-p" }),
        expect.objectContaining({ id: "iext-x" }),
        expect.objectContaining({ id: "iext-y" }),
      ]),
    );
    // package-global canonical cleanup transitions EVERY row (explicit, platform-admin-only)
    expect(transitions.map((t) => t.id).sort()).toEqual(["iext-p", "iext-x", "iext-y"]);
    expect(transitions.every((t) => t.op === "force_delete")).toBe(true);
    expect(dataTeardownFired).toEqual([PKG]);
  });
});

// ---------------------------------------------------------------------------
// 6.3 Carve-outs / preservation
// ---------------------------------------------------------------------------
describe("carve-outs / preservation", () => {
  it("F4: locked (required-in-prod) row -> archive refused for an org admin (standing-agnostic)", async () => {
    SEEDED = [row("iext-x", "org-x", { status: "locked", requiredInProd: true })];
    await expect(
      extensionRegistry.archive("agent", ref(), orgAdmin("org-x")),
    ).rejects.toThrow(/locked/i);
    expect(transitions).toEqual([]);
  });

  it("system extension archive refused for BOTH standings (#1036 preserved)", async () => {
    const SYS = "@cinatra-ai/nango-connector";
    await expect(
      extensionRegistry.archive("agent", ref(SYS), orgAdmin("org-x")),
    ).rejects.toThrow(/updated but not deleted/i);
    await expect(
      extensionRegistry.archive("agent", ref(SYS), platformAdmin()),
    ).rejects.toThrow(/updated but not deleted/i);
  });

  it("system extension force_delete refused for a platform admin too (#1036 standing-agnostic)", async () => {
    const SYS = "@cinatra-ai/nango-connector";
    await expect(
      extensionRegistry.forceDelete("agent", ref(SYS), platformAdmin()),
    ).rejects.toThrow(/updated but not deleted/i);
  });
});

// ---------------------------------------------------------------------------
// 6.4 Audit assertions
// ---------------------------------------------------------------------------
describe("audit provenance", () => {
  it("every row-scoped transition writes exactly one audit row with the resolved-row identity", async () => {
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    expect(transitionAudits).toHaveLength(1);
    expect(transitionAudits[0].resolvedRowId).toBe("iext-x");
  });

  it("an org-A admin audit row never carries an org-B / NULL-org row id", async () => {
    // org-A admin archives; only org-A's row (seed one) is ever audited.
    SEEDED = [row("iext-a", "org-a"), row("iext-b", "org-b"), row("iext-p", null)];
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-a"));
    expect(transitionAudits).toHaveLength(1);
    expect(transitionAudits[0].resolvedRowId).toBe("iext-a");
    expect(transitionAudits[0].orgId).toBe("org-a");
    // never org-b or the NULL-org platform row
    const ids = transitionAudits.map((a) => a.resolvedRowId);
    expect(ids).not.toContain("iext-b");
    expect(ids).not.toContain("iext-p");
  });
});

// ---------------------------------------------------------------------------
// F9 (cinatra#1277) — per-org capability-teardown granularity.
//
// The in-memory capability registries are keyed by PACKAGE NAME with no org
// dimension (per-org in-process registration is not modelled), so the
// package-global `fireExtensionCapabilityTeardown` cannot drop only one org's
// registrations. Option B: gate that teardown behind PLATFORM-ADMIN standing on
// the org-admin-reachable SOFT paths (archive / soft-uninstall) so an org-X
// admin's ordinary soft action leaves every OTHER org's in-process MCP tools /
// providers / ctx.ui / object-types / cubes/portlets resolvable and invocable.
// Durable per-org DB rows stay correctly row-scoped (asserted above); a platform
// admin and the genuine full-removal paths (hard-delete / forceDelete) retain the
// package-global teardown.
// ---------------------------------------------------------------------------
describe("F9 capability-teardown granularity (#1277)", () => {
  it("cross-org availability: org-X admin archive fires NO package-global capability teardown (org-Y + platform stay live)", async () => {
    // Two orgs (org-x, org-y) + the platform row share ONE installed package —
    // its register(ctx) capabilities are a SINGLE process-global registration.
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    // The soft path did NOT fire the package-global teardown, so the shared
    // in-process registration survives for org-Y (and the platform row).
    expect(capabilityTeardownFired).toEqual([]);
    // And the durable transition stayed scoped to org-X's row.
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-x", op: "archive" })]);
  });

  it("org-X admin soft-uninstall fires NO package-global capability teardown", async () => {
    await extensionRegistry.uninstall("agent", ref(), orgAdmin("org-x"));
    expect(handler.archive).toHaveBeenCalledTimes(1);
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(capabilityTeardownFired).toEqual([]);
  });

  it("platform-admin archive RETAINS instance-wide reach — fires the package-global capability teardown", async () => {
    // A platform admin resolves the NULL-org platform row; instance-wide reach is
    // by design, so the package-global teardown still fires.
    await extensionRegistry.archive("agent", ref(), platformAdmin());
    expect(transitions).toEqual([expect.objectContaining({ id: "iext-p", op: "archive" })]);
    expect(capabilityTeardownFired).toEqual([PKG]);
  });

  it("platform-admin hard-delete uninstall fires the package-global capability teardown (genuine full removal)", async () => {
    // Unused + no dependents + platform admin -> the hard-delete branch, which
    // genuinely removes the package process-wide.
    SEEDED = [row("iext-p", null)];
    await extensionRegistry.uninstall("agent", ref(), platformAdmin());
    expect(handler.uninstall).toHaveBeenCalledTimes(1);
    expect(capabilityTeardownFired).toEqual([PKG]);
    expect(dataTeardownFired).toEqual([PKG]);
  });
});

// ---------------------------------------------------------------------------
// cinatra#2400 — REGISTRY LAYER: the actor shapes the UI now builds.
//
// The action layer (lifecycle-form-action-actor.test.ts) pins WHICH actor a
// form action hands to this dispatcher; this block pins what the REAL
// dispatcher then DOES with those exact shapes — the org-admin archive vs
// platform-admin delete semantics, plus a regression pin on the role-less
// envelope the UI used to send.
//
// The shapes, verbatim from the shared builder:
//   platform admin, active org  → {…, orgId, platformRole:'platform_admin', orgRole}
//   org admin,      active org  → {…, orgId, orgRole:'org_admin'}            (no platformRole)
//   the #2400 DEFECT            → {…, orgId}                                  (neither)
// ---------------------------------------------------------------------------
describe("cinatra#2400 UI-built actors reach the designed lifecycle branches", () => {
  // A platform admin signed in WITH an active org — the ordinary settings-page
  // shape (the session always carries the active org; platform standing is what
  // the old builder dropped).
  const uiPlatformAdmin: Actor = {
    actorType: "human",
    userId: "u-admin",
    source: "ui",
    orgId: "org-x",
    platformRole: "platform_admin",
    orgRole: "org_owner",
  };
  const uiOrgAdmin: Actor = {
    actorType: "human",
    userId: "u-org",
    source: "ui",
    orgId: "org-x",
    orgRole: "org_admin",
  };
  /** The pre-#2400 envelope: identity + org context, NO standing. */
  const roleLessUiActor: Actor = {
    actorType: "human",
    userId: "u-admin",
    source: "ui",
    orgId: "org-x",
  };

  it("platform-admin force_delete SUCCEEDS (the live UI refusal is gone)", async () => {
    await expect(
      extensionRegistry.forceDelete("agent", ref(), uiPlatformAdmin, "cleanup"),
    ).resolves.toEqual({ danglingReferences: expect.anything() });
    expect(handler.uninstall).toHaveBeenCalledTimes(1);
    expect(forceDeleteAudits).toEqual([
      expect.objectContaining({ operation: "force_delete" }),
    ]);
  });

  it("org-admin force_delete stays REFUSED — platform-admin-only, zero row changes", async () => {
    await expect(
      extensionRegistry.forceDelete("agent", ref(), uiOrgAdmin, "cleanup"),
    ).rejects.toBeInstanceOf(PlatformAdminRequiredError);
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(transitions).toEqual([]);
  });

  it("the ROLE-LESS pre-#2400 actor is refused on force_delete (the reported live failure)", async () => {
    await expect(
      extensionRegistry.forceDelete("agent", ref(), roleLessUiActor, "cleanup"),
    ).rejects.toBeInstanceOf(PlatformAdminRequiredError);
  });

  it("the ROLE-LESS pre-#2400 actor cannot even resolve a target for archive/uninstall/restore", async () => {
    // Not an archive fallback — a standing refusal over the resolved row, before
    // any branch is taken. (The row IS addressable: org-equality picks iext-x.)
    for (const op of ["archive", "uninstall", "restore"] as const) {
      await expect(
        extensionRegistry[op]("agent", ref(), roleLessUiActor),
      ).rejects.toBeInstanceOf(LifecycleStandingError);
    }
    expect(transitions).toEqual([]);
    expect(handler.archive).not.toHaveBeenCalled();
    expect(handler.uninstall).not.toHaveBeenCalled();
  });

  it("platform-admin uninstall of an UNUSED, unblocked extension reaches handler.uninstall (hard delete)", async () => {
    // Only the actor's own org row exists; unused (no template ⇒ no runs) and no
    // dependents ⇒ the predicate routes to the package-global hard-delete branch.
    SEEDED = [row("iext-x", "org-x")];
    await extensionRegistry.uninstall("agent", ref(), uiPlatformAdmin);
    expect(handler.uninstall).toHaveBeenCalledTimes(1);
    expect(handler.archive).not.toHaveBeenCalled();
    // The removal-time cleanup the browser proof observes (the extension's own
    // teardown, e.g. a skill package's direct-assignment teardown, runs inside
    // handler.uninstall; the durable org-scoped teardown fires right after).
    expect(dataTeardownFired).toEqual([PKG]);
  });

  it("platform-admin uninstall of a USED extension takes the designed ARCHIVE path instead", async () => {
    SEEDED = [row("iext-x", "org-x")];
    vi.mocked(readAgentTemplateByPackageName).mockResolvedValueOnce({
      id: "tpl-1",
    } as unknown as Awaited<ReturnType<typeof readAgentTemplateByPackageName>>);
    const { countRunsForTemplate } = await import("@cinatra-ai/agents");
    vi.mocked(countRunsForTemplate).mockResolvedValueOnce(3);
    await extensionRegistry.uninstall("agent", ref(), uiPlatformAdmin);
    expect(handler.archive).toHaveBeenCalledTimes(1);
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(transitions).toEqual([
      expect.objectContaining({ id: "iext-x", op: "archive" }),
    ]);
    // An archive is restorable: no durable data teardown.
    expect(dataTeardownFired).toEqual([]);
  });

  it("org-admin uninstall NEVER hard-deletes — it archives THEIR org's row only", async () => {
    await extensionRegistry.uninstall("agent", ref(), uiOrgAdmin);
    expect(handler.archive).toHaveBeenCalledTimes(1);
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(transitions).toEqual([
      expect.objectContaining({ id: "iext-x", op: "archive" }),
    ]);
    expect(dataTeardownFired).toEqual([]);
  });

  it("a platform admin acting from an org context addresses THEIR org's row, not the platform row", async () => {
    // Org-equality resolution is unchanged by #2400: platform standing widens
    // WRITE STANDING, never the row selection. The settings page acts on the row
    // its own session scope resolves.
    await extensionRegistry.archive("agent", ref(), uiPlatformAdmin);
    expect(transitions).toEqual([
      expect.objectContaining({ id: "iext-x", op: "archive" }),
    ]);
  });
});
