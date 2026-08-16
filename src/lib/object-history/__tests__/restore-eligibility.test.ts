// Targeted-restore eligibility gate (app-artifacts §VI, design@94cfbcf5).
//
// The gate is the SINGLE source of truth the entry affordances (chip + toast)
// and the non-admin deep-link resolver consult. It answers "may THIS session
// restore THIS change-set as a targeted restore?" purely from the per-object
// inverse-write check — with NO administrator bypass — and fails closed on
// every negative / error path. These tests pin:
//   - fail-closed on empty id / orgless / missing (foreign-org) / non-restorable
//   - the per-object verdict is authoritative (no admin short-circuit)
//   - the actor + org-role hints handed to the check mirror the confirm path
//   - any thrown error degrades to "not eligible", never propagates
//
// cinatra#2800 adds the SECOND thing the loader must say: WHICH no it is.
// "not_authorized" is reserved for a change-set that exists and is restorable
// and whose per-object check denied; everything else — unknown id, foreign org,
// no longer restorable, unreadable gate — is "not_found", so the restore page
// can stop telling an administrator they lack rights they hold. The boolean
// façade is unchanged: an entry affordance still learns only yes or no.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  resolveOrgRoleForSession: vi.fn(),
  actorFromSession: vi.fn(),
  loadChangeSet: vi.fn(),
  canActorRestoreChangeSet: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: mocks.requireAuthSession,
  resolveOrgRoleForSession: mocks.resolveOrgRoleForSession,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: mocks.actorFromSession,
}));
vi.mock("@/lib/object-history", () => ({ loadChangeSet: mocks.loadChangeSet }));
vi.mock("@/lib/object-history/server-views", () => ({
  canActorRestoreChangeSet: mocks.canActorRestoreChangeSet,
}));

import {
  isSessionEligibleForTargetedRestore,
  loadAuthorizedTargetedRestore,
  loadAuthorizedTargetedRestoreForActor,
  resolveSessionRestoreAuthz,
} from "../restore-eligibility";

const PRIMITIVE_ACTOR = { actorType: "human", userId: "u1", roles: [] } as never;

function sessionWithOrg(orgId: string | null) {
  return {
    user: { id: "u1", role: null },
    session: orgId ? { activeOrganizationId: orgId } : {},
  };
}

function loaded(restorable: boolean) {
  return {
    changeSet: { id: "cs_1", restorable, restorableReason: null, openedAt: "2026-07-15T00:00:00Z" },
    events: [{ objectId: "obj_1", operation: "update" }],
  };
}

beforeEach(() => {
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.actorFromSession.mockReturnValue(PRIMITIVE_ACTOR);
});

describe("isSessionEligibleForTargetedRestore", () => {
  it("returns false for an empty change-set id without touching the session", async () => {
    expect(await isSessionEligibleForTargetedRestore("")).toBe(false);
    expect(mocks.requireAuthSession).not.toHaveBeenCalled();
  });

  it("returns false (and never loads) for an orgless session", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg(null));
    expect(await isSessionEligibleForTargetedRestore("cs_1")).toBe(false);
    expect(mocks.loadChangeSet).not.toHaveBeenCalled();
  });

  it("returns false for a missing / foreign-org change-set (org-scoped load → null)", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.loadChangeSet.mockReturnValue(null);
    expect(await isSessionEligibleForTargetedRestore("cs_1")).toBe(false);
    // org-scoped load — never runs the per-object check for a non-loadable id.
    expect(mocks.loadChangeSet).toHaveBeenCalledWith("cs_1", { orgId: "org_1" });
    expect(mocks.canActorRestoreChangeSet).not.toHaveBeenCalled();
  });

  it("returns false for a non-restorable change-set (still-restorable is part of eligibility)", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.loadChangeSet.mockReturnValue(loaded(false));
    expect(await isSessionEligibleForTargetedRestore("cs_1")).toBe(false);
    expect(mocks.canActorRestoreChangeSet).not.toHaveBeenCalled();
  });

  it("returns true when restorable AND the per-object check passes, forwarding actor + org-role hints", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.resolveOrgRoleForSession.mockResolvedValue("org_admin");
    mocks.loadChangeSet.mockReturnValue(loaded(true));
    mocks.canActorRestoreChangeSet.mockResolvedValue(true);
    expect(await isSessionEligibleForTargetedRestore("cs_1")).toBe(true);
    expect(mocks.canActorRestoreChangeSet).toHaveBeenCalledWith(
      loaded(true).events,
      PRIMITIVE_ACTOR,
      { orgRole: "org_admin" },
    );
  });

  it("NO ADMIN BYPASS: a per-object denial is authoritative even for an admin-roled actor", async () => {
    // The gate never consults platform-admin status; an admin actor whose
    // per-object check is denied is NOT eligible (§VI no-bypass).
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: "u1", role: "admin" },
      session: { activeOrganizationId: "org_1" },
    });
    mocks.resolveOrgRoleForSession.mockResolvedValue(undefined);
    mocks.loadChangeSet.mockReturnValue(loaded(true));
    mocks.canActorRestoreChangeSet.mockResolvedValue(false);
    expect(await isSessionEligibleForTargetedRestore("cs_1")).toBe(false);
    // No org role → undefined role hints (mirrors restoreChangeSetAction).
    expect(mocks.canActorRestoreChangeSet).toHaveBeenCalledWith(
      loaded(true).events,
      PRIMITIVE_ACTOR,
      undefined,
    );
  });

  it("fails closed (returns false) when a dependency throws", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.loadChangeSet.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(isSessionEligibleForTargetedRestore("cs_1")).resolves.toBe(false);
  });
});

describe("loadAuthorizedTargetedRestore — one load feeds both the verdict and the render", () => {
  it("returns the loaded change-set (not just a boolean) when authorized, so the page renders the exact authorized object", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.resolveOrgRoleForSession.mockResolvedValue("member");
    const l = loaded(true);
    mocks.loadChangeSet.mockReturnValue(l);
    mocks.canActorRestoreChangeSet.mockResolvedValue(true);
    await expect(loadAuthorizedTargetedRestore("cs_1")).resolves.toEqual({
      kind: "authorized",
      loaded: l,
    });
    // Exactly ONE load — no check-then-reload TOCTOU.
    expect(mocks.loadChangeSet).toHaveBeenCalledTimes(1);
  });

  it("says not_authorized when the change-set exists and is restorable but the per-object check denies", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.resolveOrgRoleForSession.mockResolvedValue(undefined);
    mocks.loadChangeSet.mockReturnValue(loaded(true));
    mocks.canActorRestoreChangeSet.mockResolvedValue(false);
    await expect(loadAuthorizedTargetedRestore("cs_1")).resolves.toEqual({
      kind: "not_authorized",
    });
  });
});

// cinatra#2800 — the two nos are told apart at the source, because only the load
// knows which one happened. Everything that is NOT "exists, restorable, denied"
// must read as not_found, including the paths that never reach the check.
describe("loadAuthorizedTargetedRestore — which no it is", () => {
  it("says not_found for an unknown / foreign-org id (never that another org holds it)", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.loadChangeSet.mockReturnValue(null);
    await expect(loadAuthorizedTargetedRestore("cs_1")).resolves.toEqual({
      kind: "not_found",
    });
    expect(mocks.canActorRestoreChangeSet).not.toHaveBeenCalled();
  });

  it("says not_found for a change-set that is no longer restorable", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.loadChangeSet.mockReturnValue(loaded(false));
    await expect(loadAuthorizedTargetedRestore("cs_1")).resolves.toEqual({
      kind: "not_found",
    });
    expect(mocks.canActorRestoreChangeSet).not.toHaveBeenCalled();
  });

  it("says not_found for an empty id, without touching the session", async () => {
    await expect(loadAuthorizedTargetedRestore("")).resolves.toEqual({
      kind: "not_found",
    });
    expect(mocks.requireAuthSession).not.toHaveBeenCalled();
  });

  it("says not_found for an orgless session, and never loads", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg(null));
    await expect(loadAuthorizedTargetedRestore("cs_1")).resolves.toEqual({
      kind: "not_found",
    });
    expect(mocks.loadChangeSet).not.toHaveBeenCalled();
  });

  it("degrades an unreadable gate to not_found — a thrown dependency never claims a denial", async () => {
    mocks.requireAuthSession.mockResolvedValue(sessionWithOrg("org_1"));
    mocks.loadChangeSet.mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(loadAuthorizedTargetedRestore("cs_1")).resolves.toEqual({
      kind: "not_found",
    });
  });
});

describe("loadAuthorizedTargetedRestoreForActor — the same kinds for a non-cookie actor", () => {
  const forActor = (changeSetId: string) =>
    loadAuthorizedTargetedRestoreForActor({
      changeSetId,
      orgId: "org_1",
      actor: PRIMITIVE_ACTOR,
      roleHints: undefined,
    });

  it("carries the loaded change-set on authorized", async () => {
    const l = loaded(true);
    mocks.loadChangeSet.mockReturnValue(l);
    mocks.canActorRestoreChangeSet.mockResolvedValue(true);
    await expect(forActor("cs_1")).resolves.toEqual({ kind: "authorized", loaded: l });
  });

  it("says not_authorized only for an existing, restorable change-set the check denies", async () => {
    mocks.loadChangeSet.mockReturnValue(loaded(true));
    mocks.canActorRestoreChangeSet.mockResolvedValue(false);
    await expect(forActor("cs_1")).resolves.toEqual({ kind: "not_authorized" });
  });

  it("says not_found for a missing id and for a missing org", async () => {
    mocks.loadChangeSet.mockReturnValue(null);
    await expect(forActor("cs_1")).resolves.toEqual({ kind: "not_found" });
    await expect(
      loadAuthorizedTargetedRestoreForActor({
        changeSetId: "cs_1",
        orgId: "",
        actor: PRIMITIVE_ACTOR,
        roleHints: undefined,
      }),
    ).resolves.toEqual({ kind: "not_found" });
  });
});

describe("resolveSessionRestoreAuthz", () => {
  it("builds the primitive actor + org-role hint (mirrors the confirm path)", async () => {
    mocks.resolveOrgRoleForSession.mockResolvedValue("org_owner");
    const out = await resolveSessionRestoreAuthz(sessionWithOrg("org_1") as never);
    expect(out).toEqual({ primitiveActor: PRIMITIVE_ACTOR, roleHints: { orgRole: "org_owner" } });
  });

  it("omits role hints (undefined) when no org role resolves", async () => {
    mocks.resolveOrgRoleForSession.mockResolvedValue(undefined);
    const out = await resolveSessionRestoreAuthz(sessionWithOrg("org_1") as never);
    expect(out).toEqual({ primitiveActor: PRIMITIVE_ACTOR, roleHints: undefined });
  });
});
