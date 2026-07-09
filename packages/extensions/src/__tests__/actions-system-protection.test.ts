// System-extension removal protection at the user-facing server-action layer
// (cinatra#1036).
//
// The action layer is the clean FRONT DOOR: a delete-intent action refuses a
// host-declared system extension up front, before any registry round-trip, with
// the stable typed error — while UPDATE and REINSTALL stay fully functional
// (reinstall re-lays a system extension down IN PLACE via update, never
// uninstall, so it is never stranded). The dispatcher primitive is the
// membership backstop (proven in registry.test.ts); here we pin the action
// contract against a fully mocked registry.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";

vi.mock("server-only", () => ({}));
// actions.ts does a side-effect `import "./handler-bootstrap"` (pulls heavy,
// unresolvable-in-vitest handler barrels). Stub it — the registry is mocked.
vi.mock("../handler-bootstrap", () => ({}));
vi.mock("next/navigation", () => ({ redirect: vi.fn() }));
vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: vi.fn(async () => null),
  comparePluginVersions: vi.fn(() => "current"),
  listAgentPackages: vi.fn(async () => []),
  ensureConfig: vi.fn((cfg: unknown) => cfg),
}));

// The registry primitive is fully mocked so each test asserts EXACTLY which
// primitive was (or was not) dispatched. `vi.hoisted` so the object exists when
// the hoisted `vi.mock` factory runs.
const registry = vi.hoisted(() => ({
  install: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  uninstall: vi.fn(async () => {}),
  archive: vi.fn(async () => {}),
  restore: vi.fn(async () => {}),
  forceDelete: vi.fn(async () => ({ danglingReferences: {} })),
}));
vi.mock("../index", () => ({ extensionRegistry: registry }));

// Deterministic lifecycle resolvers (no marketplace round-trip).
vi.mock("../utils", () => ({
  deriveTypeId: vi.fn(() => "connector"),
  resolveExtensionTypeId: vi.fn(async () => "connector"),
  resolveExtensionPackageForLifecycle: vi.fn(async () => ({
    resolvedVersion: "0.1.7",
    typeId: "connector",
  })),
}));

// Always an authenticated admin.
vi.mock("@/lib/auth-session", () => ({
  requireAdminSession: vi.fn(async () => ({ user: { id: "admin-1" }, session: {} })),
}));

// Keep the REAL system-extension inventory (real host-membership check against
// the root package.json) but mock its DB-side imports so the module graph stays
// light in vitest. `readSystemExtensions`/`isSystemExtension`/
// `assertCanRemoveExtension` are self-contained (fs read + frozen set) and are
// unaffected by these mocks.
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => []),
}));
vi.mock("../lifecycle-primitive", () => ({
  transitionExtensionLifecycle: vi.fn(async () => null),
}));
vi.mock("../required-in-prod", () => ({
  readRequiredInProdPackages: vi.fn(() => []),
}));

import {
  uninstallExtensionPackage,
  archiveExtensionPackage,
  forceDeleteExtensionPackage,
  updateExtensionPackage,
  reinstallLatestExtensionPackage,
} from "../actions";

const SYSTEM_PKG = "@cinatra-ai/nango-connector"; // real member of cinatra.systemExtensions
const NORMAL_PKG = "@acme/not-a-system-ext";
const MSG = "System extension — can be updated but not deleted.";
const actor: Actor = { actorType: "human", userId: "admin-1", source: "ui" };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("delete-intent actions refuse a system extension (front door)", () => {
  it("uninstallExtensionPackage returns the exact refusal and never touches the registry", async () => {
    const res = await uninstallExtensionPackage(SYSTEM_PKG, "0.1.7", actor);
    // cinatra#1061: the operator `error` message is unchanged; the core action
    // now ALSO classifies the refusal into `failure` so the form action can
    // RETURN a structured value the production client renders (a system
    // extension → reason "system").
    expect(res).toEqual({
      success: false,
      error: MSG,
      failure: { ok: false, reason: "system" },
    });
    expect(registry.uninstall).not.toHaveBeenCalled();
  });

  it("archiveExtensionPackage returns the exact refusal and never touches the registry", async () => {
    const res = await archiveExtensionPackage(SYSTEM_PKG, "0.1.7", actor);
    expect(res).toEqual({
      success: false,
      error: MSG,
      failure: { ok: false, reason: "system" },
    });
    expect(registry.archive).not.toHaveBeenCalled();
  });

  it("forceDeleteExtensionPackage returns the exact refusal and never touches the registry", async () => {
    const res = await forceDeleteExtensionPackage(SYSTEM_PKG, "0.1.7", actor, "cleanup");
    expect(res).toEqual({ success: false, error: MSG });
    expect(registry.forceDelete).not.toHaveBeenCalled();
  });

  it("does NOT block a non-system extension (normal uninstall proceeds)", async () => {
    const res = await uninstallExtensionPackage(NORMAL_PKG, "1.0.0", actor);
    expect(res).toEqual({ success: true });
    expect(registry.uninstall).toHaveBeenCalledTimes(1);
  });
});

describe("update / reinstall stay functional for a system extension", () => {
  it("updateExtensionPackage upgrades a system extension in place (update is permitted)", async () => {
    const res = await updateExtensionPackage(SYSTEM_PKG, "0.1.7", actor);
    expect(res.success).toBe(true);
    expect(registry.update).toHaveBeenCalledTimes(1);
    expect(registry.uninstall).not.toHaveBeenCalled();
  });

  it("reinstallLatestExtensionPackage re-lays a system extension down via update — NEVER uninstall/install", async () => {
    const res = await reinstallLatestExtensionPackage(SYSTEM_PKG, actor);
    expect(res).toEqual({ success: true });
    expect(registry.update).toHaveBeenCalledTimes(1);
    expect(registry.uninstall).not.toHaveBeenCalled();
    expect(registry.install).not.toHaveBeenCalled();
  });

  it("a FAILED system reinstall leaves it live — the uninstall phase is never attempted (no stranding)", async () => {
    registry.update.mockRejectedValueOnce(new Error("registry unreachable"));
    const res = await reinstallLatestExtensionPackage(SYSTEM_PKG, actor);
    expect(res.success).toBe(false);
    expect(registry.uninstall).not.toHaveBeenCalled();
    expect(registry.install).not.toHaveBeenCalled();
  });

  it("reinstall of a NON-system extension keeps the uninstall-then-install path", async () => {
    const res = await reinstallLatestExtensionPackage(NORMAL_PKG, actor);
    expect(res).toEqual({ success: true });
    expect(registry.uninstall).toHaveBeenCalledTimes(1);
    expect(registry.install).toHaveBeenCalledTimes(1);
    expect(registry.update).not.toHaveBeenCalled();
  });
});
