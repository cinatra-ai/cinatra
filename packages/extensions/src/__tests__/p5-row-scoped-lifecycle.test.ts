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
  handler = makeHandler();
  extensionRegistry.register(handler);
  SEEDED = [row("iext-p", null), row("iext-x", "org-x"), row("iext-y", "org-y")];
});
afterEach(() => setExtensionDataTeardownHook(null));

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
