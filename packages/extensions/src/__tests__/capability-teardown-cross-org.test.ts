import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";
import type { InstalledExtension } from "../canonical-types";

// ===========================================================================
// cinatra#1277 — per-org capability-teardown granularity (F9 refinement).
//
// The in-process capability registries (MCP tools / providers / ctx.ui / object
// types / dashboard cubes + portlet kinds) are keyed by package NAME only — no
// org dimension — and `fireExtensionCapabilityTeardown(pkg)` deregisters them
// PACKAGE-GLOBALLY. P5 (cinatra#1130) routes org-admin archive / soft-uninstall
// through the SOFT paths, transitioning only the actor-org's row. Firing the
// package-global teardown there dropped the package's in-process registrations
// for EVERY co-tenant org in the worker.
//
// The fix gates the SOFT-path teardown on SURVIVING LIVE ROWS: after the row
// transition COMMITS, fire the process-global teardown ONLY when no canonical
// row for the package is still live (fully retired instance-wide); while a
// co-tenant org's row is active/locked, SKIP it.
//
// This suite drives the REAL dispatcher + REAL resolver against mocked stores.
// It proves the read-after-commit ordering by DERIVING the effective status from
// the mocked row state that `transitionExtensionLifecycle` mutates — a gate that
// read stale (pre-transition) state would drop org-Y's tools and fail here.
// ===========================================================================

const PKG = "@acme/thing";

// --- mutable canonical row set (seeded per test) ---------------------------
let SEEDED: InstalledExtension[] = [];

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

// --- mocks -----------------------------------------------------------------
// `readEffectiveStatusByPackageNames` DERIVES from the CURRENT SEEDED state at
// call time (live-wins aggregate, mirroring canonical-store) — so it reflects
// the mutation `transitionExtensionLifecycle` applies below. That is what proves
// the gate reads AFTER the transition committed, not a fixed pre-baked Map.
const effectiveStatusReadFails = { value: false };
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => SEEDED),
  readInstalledExtensionById: vi.fn(
    async (id: string) => SEEDED.find((r) => r.id === id) ?? null,
  ),
  // Closure gates read this — return [] so archive/uninstall closure is inert.
  listInstalledExtensions: vi.fn(async () => []),
  readEffectiveStatusByPackageNames: vi.fn(async (names: string[]) => {
    if (effectiveStatusReadFails.value) {
      throw new Error("simulated effective-status read failure");
    }
    const m = new Map<string, "active" | "archived">();
    for (const r of SEEDED) {
      if (!names.includes(r.packageName)) continue;
      const live = r.status === "active" || r.status === "locked";
      if (live) m.set(r.packageName, "active");
      else if (!m.has(r.packageName)) m.set(r.packageName, "archived");
    }
    return m;
  }),
}));

// `transitionExtensionLifecycle` MUTATES the seeded row (archive -> archived),
// so the surviving-live-row probe above sees the committed post-transition
// state — the read-after-commit ordering codex convergence required.
vi.mock("../lifecycle-primitive", () => ({
  transitionExtensionLifecycle: vi.fn(async (id: string, op: string) => {
    const target = SEEDED.find((r) => r.id === id);
    if (target) {
      target.status =
        op === "archive" ? "archived" : op === "activate" ? "active" : target.status;
    }
    return null;
  }),
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

import { extensionRegistry } from "../index";
import { setExtensionCapabilityTeardownHook } from "../capability-teardown-hook";

// --- simulated package-keyed in-process registry ---------------------------
// A faithful stand-in for the host's package-keyed capability registries: the
// wired teardown hook deletes the package's entry wholesale, exactly like the
// real `teardownExtensionCapabilities(pkg)` closure does across every registry.
// Asserting the entry survives === the package's MCP tools / providers / ctx.ui
// / object types / cubes / portlets remain resolvable + invocable in-process.
let inProcessRegistry: Map<string, Set<string>>;
let teardownFired: string[];

function seedRegistrations(): void {
  inProcessRegistry = new Map([
    [PKG, new Set(["mcp:thing_tool", "provider:email-send", "ui:setup", "objtype:thing"])],
  ]);
}

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

// --- actors ----------------------------------------------------------------
const orgAdmin = (orgId: string): Actor => ({
  actorType: "human",
  userId: "u-org",
  source: "ui",
  orgId,
  orgRole: "org_admin",
});
const platformAdmin = (orgId?: string): Actor => ({
  actorType: "human",
  userId: "u-admin",
  source: "ui",
  platformRole: "platform_admin",
  ...(orgId ? { orgId } : {}),
});

beforeEach(() => {
  extensionRegistry._resetForTesting();
  vi.clearAllMocks();
  effectiveStatusReadFails.value = false;
  handler = makeHandler();
  extensionRegistry.register(handler);
  seedRegistrations();
  teardownFired = [];
  // Wire the REAL host teardown seam to the simulated package-keyed registry.
  setExtensionCapabilityTeardownHook((pkg) => {
    teardownFired.push(pkg);
    inProcessRegistry.delete(pkg);
  });
});
afterEach(() => setExtensionCapabilityTeardownHook(null));

// ---------------------------------------------------------------------------
// The acceptance: org-X soft transition must NOT drop a co-tenant org-Y's
// in-process registrations.
// ---------------------------------------------------------------------------
describe("cross-org availability: a co-tenant live row is preserved", () => {
  it("org-X admin ARCHIVE leaves org-Y's tools resolvable in-process (teardown NOT fired)", async () => {
    SEEDED = [row("iext-x", "org-x"), row("iext-y", "org-y")];
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    // org-X row transitioned to archived; org-Y still live => teardown skipped.
    expect(SEEDED.find((r) => r.id === "iext-x")!.status).toBe("archived");
    expect(SEEDED.find((r) => r.id === "iext-y")!.status).toBe("active");
    expect(teardownFired).toEqual([]);
    // org-Y's (package-keyed) registrations remain resolvable + invocable.
    expect(inProcessRegistry.has(PKG)).toBe(true);
    expect(inProcessRegistry.get(PKG)!.has("mcp:thing_tool")).toBe(true);
    expect(inProcessRegistry.get(PKG)!.has("provider:email-send")).toBe(true);
  });

  it("org-X admin SOFT-UNINSTALL leaves org-Y's tools resolvable in-process (teardown NOT fired)", async () => {
    SEEDED = [row("iext-x", "org-x"), row("iext-y", "org-y")];
    await extensionRegistry.uninstall("agent", ref(), orgAdmin("org-x"));
    // org-admin uninstall takes the SOFT (archive) path.
    expect(handler.archive).toHaveBeenCalledTimes(1);
    expect(handler.uninstall).not.toHaveBeenCalled();
    expect(SEEDED.find((r) => r.id === "iext-x")!.status).toBe("archived");
    expect(teardownFired).toEqual([]);
    expect(inProcessRegistry.has(PKG)).toBe(true);
  });

  it("PLATFORM admin archiving ONE org's row while another is live also preserves the sibling", async () => {
    // The org-agnostic surviving-row gate is correct even for a platform admin —
    // a standing-based gate would wrongly fire and drop org-Y.
    SEEDED = [row("iext-x", "org-x"), row("iext-y", "org-y")];
    await extensionRegistry.archive("agent", ref(), platformAdmin("org-x"));
    expect(SEEDED.find((r) => r.id === "iext-x")!.status).toBe("archived");
    expect(teardownFired).toEqual([]);
    expect(inProcessRegistry.has(PKG)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The bound: retiring the LAST live row still tears down in-process (no
// regression vs the pre-#1277 unconditional fire).
// ---------------------------------------------------------------------------
describe("fully-retired instance-wide: the last live row still tears down", () => {
  it("org-X admin ARCHIVE of the only live row fires the process-global teardown", async () => {
    SEEDED = [row("iext-x", "org-x")];
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    expect(SEEDED.find((r) => r.id === "iext-x")!.status).toBe("archived");
    expect(teardownFired).toEqual([PKG]);
    expect(inProcessRegistry.has(PKG)).toBe(false);
  });

  it("org-X admin SOFT-UNINSTALL of the only live row fires the process-global teardown", async () => {
    SEEDED = [row("iext-x", "org-x")];
    await extensionRegistry.uninstall("agent", ref(), orgAdmin("org-x"));
    expect(teardownFired).toEqual([PKG]);
    expect(inProcessRegistry.has(PKG)).toBe(false);
  });

  it("a co-tenant row that is ALREADY archived does not count as live (teardown fires)", async () => {
    SEEDED = [row("iext-x", "org-x"), row("iext-y", "org-y", { status: "archived" })];
    await extensionRegistry.archive("agent", ref(), orgAdmin("org-x"));
    expect(teardownFired).toEqual([PKG]);
    expect(inProcessRegistry.has(PKG)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Fail-safe: a surviving-row probe failure AFTER the committed transition must
// SKIP the teardown (never drop a co-tenant's tools; never abort the archive).
// ---------------------------------------------------------------------------
describe("fail-safe: effective-status probe failure skips teardown", () => {
  it("does NOT fire the teardown and does NOT abort the committed soft archive", async () => {
    SEEDED = [row("iext-x", "org-x"), row("iext-y", "org-y")];
    effectiveStatusReadFails.value = true;
    // The committed archive is NOT aborted by the probe failure.
    await expect(
      extensionRegistry.archive("agent", ref(), orgAdmin("org-x")),
    ).resolves.toBeUndefined();
    expect(SEEDED.find((r) => r.id === "iext-x")!.status).toBe("archived");
    // Teardown SKIPPED (safe direction) — registrations preserved.
    expect(teardownFired).toEqual([]);
    expect(inProcessRegistry.has(PKG)).toBe(true);
  });
});
