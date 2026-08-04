// ===========================================================================
// cinatra#2400 — ACTION LAYER: every lifecycle form action builds its actor
// through the ONE shared session-derived builder.
//
// The defect this pins: each wrapper used to hand-roll
// `{actorType, userId, source, orgId}` — an audit envelope with NO standing.
// `isPlatformAdminActor` reads ONLY `platformRole`, so a real platform admin's
// §V Danger-zone Force-delete was refused every time while the button rendered
// enabled; the archive/restore/reinstall family never even reached a branch
// (`resolveLifecycleTargetRow → assertActorWriteStandingOverRow` needs
// `orgRole` or platform standing over the resolved row).
//
// LAYER SEPARATION. This file asserts ONLY what the action layer owns:
//   1. the auth gate (`requireAdminSession`) — a non-admin session never
//      reaches a registry primitive;
//   2. the SHAPE of the actor handed to the dispatch layer (platformRole +
//      orgRole, both session-derived);
//   3. that client input can never contribute a role;
//   4. the ONE deliberate exception — install/update, whose actor rides the
//      dependency batch's compensation path and therefore stays standing-free.
// What the dispatcher then DOES with that actor (org-admin archive vs
// platform-admin hard delete / force delete) is the registry layer's contract,
// pinned in `p5-row-scoped-lifecycle.test.ts` against the REAL dispatcher.
// ===========================================================================
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Actor } from "@cinatra-ai/extension-types";

vi.mock("server-only", () => ({}));
// actions.ts does a side-effect `import "./handler-bootstrap"` (pulls heavy,
// unresolvable-in-vitest handler barrels). Stub it — the registry is mocked.
vi.mock("../handler-bootstrap", () => ({}));

// `redirect()` is how a successful form action terminates. Throw the sentinel
// Next.js itself throws so control flow matches production.
class RedirectSentinel extends Error {
  constructor(public readonly to: string) {
    super(`NEXT_REDIRECT:${to}`);
    this.name = "RedirectSentinel";
  }
}
vi.mock("next/navigation", () => ({
  redirect: vi.fn((to: string) => {
    throw new RedirectSentinel(to);
  }),
}));

vi.mock("@cinatra-ai/registries", () => ({
  getAgentPackage: vi.fn(async () => null),
  comparePluginVersions: vi.fn(() => "current"),
  listAgentPackages: vi.fn(async () => []),
  ensureConfig: vi.fn((cfg: unknown) => cfg),
}));

// The registry primitive is fully mocked: this layer's contract is WHICH actor
// reaches it, not what the dispatcher does next.
const registry = vi.hoisted(() => {
  // Typed like the real dispatcher signature (typeId, ref, actor, …) so the
  // captured third argument — the actor under test — is statically indexable.
  type Dispatch = (typeId: string, ref: unknown, actor: unknown) => Promise<void>;
  const dispatch = () => vi.fn<Dispatch>(async () => {});
  return {
    install: dispatch(),
    update: dispatch(),
    uninstall: dispatch(),
    archive: dispatch(),
    restore: dispatch(),
    forceDelete: vi.fn<
      (typeId: string, ref: unknown, actor: unknown, reason?: string) => Promise<{
        danglingReferences: Record<string, never>;
      }>
    >(async () => ({ danglingReferences: {} })),
  };
});
vi.mock("../index", () => ({ extensionRegistry: registry }));

const installBatchMock = vi.hoisted(() =>
  vi.fn<(input: { packageName: string; version: string; actor: unknown }) => Promise<unknown>>(
    async () => ({
      rootPackage: "",
      rootVersion: "",
      installed: [],
      updated: [],
      alreadyInstalled: [],
      batchId: null,
    }),
  ),
);
vi.mock("@/lib/extension-install-batch", () => ({
  installExtensionWithDependencies: installBatchMock,
}));
vi.mock("@/lib/gatekept-install", () => ({
  isGatekeptInstallEnabled: () => true,
}));

// Deterministic lifecycle resolvers (no marketplace round-trip).
vi.mock("../utils", () => ({
  deriveTypeId: vi.fn(() => "connector"),
  resolveExtensionTypeId: vi.fn(async () => "connector"),
  resolveExtensionPackageForLifecycle: vi.fn(async () => ({
    resolvedVersion: "0.1.7",
    typeId: "connector",
  })),
}));
vi.mock("../canonical-store", () => ({
  readInstalledExtensionsByPackageName: vi.fn(async () => []),
  readInstalledExtensionByIdentity: vi.fn(async () => null),
  listInstalledExtensions: vi.fn(async () => []),
}));
vi.mock("../lifecycle-primitive", () => ({
  transitionExtensionLifecycle: vi.fn(async () => null),
}));
vi.mock("../required-in-prod", () => ({
  readRequiredInProdPackages: vi.fn(() => []),
}));
vi.mock("@cinatra-ai/agents", () => ({
  withInstallLock: (_pkg: string, fn: () => unknown) => fn(),
}));

// --- the session under test ------------------------------------------------
// The REAL `isPlatformAdmin` is used (imported below into the mock factory's
// closure via the canonical comma-split contract pinned in
// src/lib/__tests__/auth-session.test.ts) — the action must not carry its own
// role parsing. `requireAdminSession` + `buildCanDoOptsFromSession` are the
// seams we drive.
type TestSession = {
  user: { id: string; role?: string | null };
  session?: { activeOrganizationId?: string | null } | null;
};
const seam = vi.hoisted(() => ({
  session: null as unknown,
  orgRole: undefined as string | undefined,
  orgRoleThrows: false,
  adminGateThrows: false,
}));

class NotAuthorizedRedirect extends Error {
  constructor() {
    super("NEXT_REDIRECT:/not-authorized");
    this.name = "NotAuthorizedRedirect";
  }
}

vi.mock("@/lib/auth-session", () => ({
  // The real gate REDIRECTS a non-admin to /not-authorized (a thrown
  // NEXT_REDIRECT in Next.js). Model exactly that.
  requireAdminSession: vi.fn(async () => {
    if (seam.adminGateThrows) throw new NotAuthorizedRedirect();
    return seam.session;
  }),
  buildCanDoOptsFromSession: vi.fn(async () => {
    if (seam.orgRoleThrows) throw new Error("membership read failed");
    return seam.orgRole ? { orgRole: seam.orgRole } : {};
  }),
  // The canonical predicate, verbatim (its own semantics — including the
  // comma-separated "user,admin" string — are pinned at its own layer).
  isPlatformAdmin: (s: { user?: { role?: string | null } | null } | null | undefined) =>
    String(s?.user?.role ?? "")
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
      .includes("admin"),
}));

import {
  archiveExtensionPackageFormAction,
  restoreExtensionPackageFormAction,
  reinstallLatestFormAction,
  forceDeleteExtensionPackageFormAction,
  updateExtensionPackageFormAction,
  installExtensionPackageFormAction,
} from "../actions";
import * as actionsModule from "../actions";

const PKG = "@acme/thing";
const VERSION = "1.0.0";
const ORG = "org-x";

/** A promoted Better Auth platform admin: role is the COMMA-SEPARATED string. */
function platformAdminSession(): TestSession {
  return {
    user: { id: "u-admin", role: "user,admin" },
    session: { activeOrganizationId: ORG },
  };
}
/** An org admin who is NOT a platform admin. */
function orgAdminSession(): TestSession {
  return {
    user: { id: "u-org", role: "user" },
    session: { activeOrganizationId: ORG },
  };
}

/** Run a form action, swallowing the redirect its success path throws. */
async function run(fn: () => Promise<unknown>): Promise<unknown> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RedirectSentinel) return { redirectedTo: err.to };
    throw err;
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  seam.session = platformAdminSession();
  seam.orgRole = "org_owner";
  seam.orgRoleThrows = false;
  seam.adminGateThrows = false;
});

// ---------------------------------------------------------------------------
// 1. The shared builder: platformRole + orgRole on EVERY lifecycle form action
// ---------------------------------------------------------------------------
describe("every lifecycle form action builds a session-derived actor", () => {
  const expectedPlatformAdminActor: Actor = {
    actorType: "human",
    userId: "u-admin",
    source: "ui",
    orgId: ORG,
    platformRole: "platform_admin",
    orgRole: "org_owner",
  };

  it("forceDelete → the actor carries platformRole (the ONLY field the P5 gate reads)", async () => {
    await run(() =>
      forceDeleteExtensionPackageFormAction({
        packageName: PKG,
        packageVersion: VERSION,
        reason: "cleanup",
        confirmDestructive: true,
      }),
    );
    expect(registry.forceDelete).toHaveBeenCalledTimes(1);
    expect(registry.forceDelete.mock.calls[0]?.[2]).toEqual(expectedPlatformAdminActor);
  });

  it("archive → session-derived actor", async () => {
    await run(() =>
      archiveExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
    );
    expect(registry.archive).toHaveBeenCalledTimes(1);
    expect(registry.archive.mock.calls[0]?.[2]).toEqual(expectedPlatformAdminActor);
  });

  it("restore → session-derived actor", async () => {
    await run(() => restoreExtensionPackageFormAction({ packageName: PKG }));
    expect(registry.restore).toHaveBeenCalledTimes(1);
    expect(registry.restore.mock.calls[0]?.[2]).toEqual(expectedPlatformAdminActor);
  });

  it("reinstall → session-derived actor on BOTH legs (uninstall + install)", async () => {
    await run(() => reinstallLatestFormAction({ packageName: PKG }));
    expect(registry.uninstall).toHaveBeenCalledTimes(1);
    expect(registry.install).toHaveBeenCalledTimes(1);
    expect(registry.uninstall.mock.calls[0]?.[2]).toEqual(expectedPlatformAdminActor);
    expect(registry.install.mock.calls[0]?.[2]).toEqual(expectedPlatformAdminActor);
  });

  // -------------------------------------------------------------------------
  // The install/update BOUNDARY. Their actor is threaded into the dependency
  // batch, whose abort path compensates member installs via `uninstallMember` →
  // `extensionRegistry.uninstall(…, actor)`. Platform standing there would send
  // a freshly-installed, never-used DEPENDENCY down the package-global
  // hard-delete branch and tear down every OTHER org's row for it. So these two
  // keep the standing-free envelope — pinned here so a future "make it uniform"
  // refactor has to confront the reason.
  // -------------------------------------------------------------------------
  const standingFreeEnvelope: Actor = {
    actorType: "human",
    userId: "u-admin",
    source: "ui",
    orgId: ORG,
  };

  it("update → the standing-free envelope (NO platformRole into the dependency batch)", async () => {
    await run(() =>
      updateExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
    );
    expect(registry.update).toHaveBeenCalledTimes(1);
    expect(registry.update.mock.calls[0]?.[2]).toEqual(standingFreeEnvelope);
  });

  it("install → the standing-free envelope (NO platformRole into the dependency batch)", async () => {
    await run(() =>
      installExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
    );
    expect(installBatchMock).toHaveBeenCalledTimes(1);
    expect(installBatchMock.mock.calls[0]?.[0].actor).toEqual(standingFreeEnvelope);
  });

  it("an ORG admin (role 'user', no platform standing) gets orgRole but NEVER platformRole", async () => {
    seam.session = orgAdminSession();
    seam.orgRole = "org_admin";
    await run(() =>
      archiveExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
    );
    expect(registry.archive.mock.calls[0]?.[2]).toEqual({
      actorType: "human",
      userId: "u-org",
      source: "ui",
      orgId: ORG,
      orgRole: "org_admin",
    });
  });

  it("no active organization → no orgId, platform standing still resolved", async () => {
    seam.session = { user: { id: "u-admin", role: "user,admin" }, session: null };
    seam.orgRole = undefined;
    await run(() =>
      archiveExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
    );
    expect(registry.archive.mock.calls[0]?.[2]).toEqual({
      actorType: "human",
      userId: "u-admin",
      source: "ui",
      platformRole: "platform_admin",
    });
  });

  it("a FAILED membership read degrades to platform standing only — it never throws", async () => {
    seam.orgRoleThrows = true;
    await run(() =>
      archiveExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
    );
    // Fail-closed for an org admin (no orgRole ⇒ the P5 standing gate refuses),
    // unaffected for a platform admin — and NOT an unhandled server-action error.
    expect(registry.archive.mock.calls[0]?.[2]).toEqual({
      actorType: "human",
      userId: "u-admin",
      source: "ui",
      orgId: ORG,
      platformRole: "platform_admin",
    });
  });
});

// ---------------------------------------------------------------------------
// 2. Client input can never contribute standing
// ---------------------------------------------------------------------------
describe("a crafted request cannot supply a role", () => {
  it("role-ish fields smuggled into the form-action input are ignored", async () => {
    seam.session = orgAdminSession();
    seam.orgRole = "member";
    await run(() =>
      archiveExtensionPackageFormAction({
        packageName: PKG,
        packageVersion: VERSION,
        // A crafted client payload. The action's typed contract does not
        // declare these; the builder reads NOTHING from `input` but the
        // package identity, so they cannot reach the actor.
        ...({
          platformRole: "platform_admin",
          orgRole: "org_owner",
          actor: { platformRole: "platform_admin" },
          userId: "u-someone-else",
          orgId: "org-victim",
        } as unknown as Record<string, never>),
      }),
    );
    expect(registry.archive.mock.calls[0]?.[2]).toEqual({
      actorType: "human",
      userId: "u-org",
      source: "ui",
      orgId: ORG,
      orgRole: "member",
    });
  });
});

// ---------------------------------------------------------------------------
// 3. The action-level auth gate
// ---------------------------------------------------------------------------
describe("requireAdminSession is the action-level gate", () => {
  it("a NON-admin session is rejected before ANY registry primitive is dispatched", async () => {
    seam.adminGateThrows = true;
    const cases: Array<[string, () => Promise<unknown>]> = [
      [
        "forceDelete",
        () =>
          forceDeleteExtensionPackageFormAction({
            packageName: PKG,
            packageVersion: VERSION,
            reason: "cleanup",
            confirmDestructive: true,
          }),
      ],
      [
        "archive",
        () => archiveExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
      ],
      ["restore", () => restoreExtensionPackageFormAction({ packageName: PKG })],
      ["reinstall", () => reinstallLatestFormAction({ packageName: PKG })],
      [
        "update",
        () => updateExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
      ],
      [
        "install",
        () => installExtensionPackageFormAction({ packageName: PKG, packageVersion: VERSION }),
      ],
    ];
    for (const [name, invoke] of cases) {
      await expect(invoke(), `${name} must be refused`).rejects.toBeInstanceOf(
        NotAuthorizedRedirect,
      );
    }
    expect(registry.forceDelete).not.toHaveBeenCalled();
    expect(registry.archive).not.toHaveBeenCalled();
    expect(registry.restore).not.toHaveBeenCalled();
    expect(registry.uninstall).not.toHaveBeenCalled();
    expect(registry.update).not.toHaveBeenCalled();
    expect(registry.install).not.toHaveBeenCalled();
    expect(installBatchMock).not.toHaveBeenCalled();
  });

  it("force-delete's destructive-acknowledgment guards still refuse before the gate's actor is used", async () => {
    await expect(
      forceDeleteExtensionPackageFormAction({
        packageName: PKG,
        packageVersion: VERSION,
        reason: "   ",
        confirmDestructive: true,
      }),
    ).rejects.toThrow(/non-empty reason/);
    expect(registry.forceDelete).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 4. The removed dead export (issue AC4)
// ---------------------------------------------------------------------------
describe("no dead broken export remains", () => {
  it("uninstallExtensionPackageFormAction is GONE (it was unreferenced and shipped the same defect)", () => {
    expect(
      (actionsModule as Record<string, unknown>).uninstallExtensionPackageFormAction,
    ).toBeUndefined();
  });

  it("the programmatic dispatcher uninstallExtensionPackage is UNCHANGED and still exported", () => {
    expect(typeof actionsModule.uninstallExtensionPackage).toBe("function");
  });
});
