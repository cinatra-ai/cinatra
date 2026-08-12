// recentUndoableChangeSetForRunAction — the COOKIE door onto the shared undo
// read (cinatra#2683, epic #2564 S8f moved the query and the §VI gate into
// `@/lib/chat/undo-candidate-surface`, which the widget's route entry also
// calls). Pins: orgless → null; the poll uses runId + closedAtAfter +
// restorable:true (so only recent CLOSED restorable change-sets from the run
// surface); a found row maps to { changeSetId }; an INELIGIBLE actor is
// suppressed, and the eligibility gate is asked for the ACTOR this session
// resolves — never for "the current session", which a broker caller has none of.

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  resolveOrgRoleForSession: vi.fn(),
  listChangeSets: vi.fn(),
  loadAuthorizedTargetedRestoreForActor: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: mocks.requireAuthSession,
  resolveOrgRoleForSession: mocks.resolveOrgRoleForSession,
}));
vi.mock("@/lib/authz/build-actor-context", () => ({
  actorFromSession: (session: { user: { id: string } }) => ({
    actorType: "human",
    userId: session.user.id,
  }),
}));
vi.mock("@/lib/object-history", () => ({ listChangeSets: mocks.listChangeSets }));
vi.mock("@/lib/object-history/restore-eligibility", () => ({
  loadAuthorizedTargetedRestoreForActor: mocks.loadAuthorizedTargetedRestoreForActor,
}));

import { recentUndoableChangeSetForRunAction } from "../undo-actions";

describe("recentUndoableChangeSetForRunAction", () => {
  beforeEach(() => {
    mocks.requireAuthSession.mockReset();
    mocks.resolveOrgRoleForSession.mockReset();
    mocks.resolveOrgRoleForSession.mockResolvedValue("member");
    mocks.listChangeSets.mockReset();
    mocks.loadAuthorizedTargetedRestoreForActor.mockReset();
    // Default: eligible — the eligibility-suppression cases pin null explicitly.
    mocks.loadAuthorizedTargetedRestoreForActor.mockResolvedValue({ changeSet: {} });
  });

  it("returns null for an orgless session (no query)", async () => {
    mocks.requireAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
    const r = await recentUndoableChangeSetForRunAction({ runId: "run_1" });
    expect(r).toBeNull();
    expect(mocks.listChangeSets).not.toHaveBeenCalled();
  });

  it("queries runId + closedAtAfter + restorable:true, returns { changeSetId } for an ELIGIBLE actor", async () => {
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org_1" },
    });
    mocks.listChangeSets.mockReturnValue([{ id: "cs_recent" }]);
    const r = await recentUndoableChangeSetForRunAction({ runId: "run_1" });
    expect(r).toEqual({ changeSetId: "cs_recent" });
    const arg = mocks.listChangeSets.mock.calls[0][0];
    expect(arg).toMatchObject({
      orgId: "org_1",
      runId: "run_1",
      restorable: true,
      limit: 1,
    });
    expect(typeof arg.closedAtAfter).toBe("string");
    // The chip is gated on the SAME per-object eligibility as the restore, asked
    // for THIS actor in THIS org — the shape a broker caller can also present.
    expect(mocks.loadAuthorizedTargetedRestoreForActor).toHaveBeenCalledWith({
      changeSetId: "cs_recent",
      orgId: "org_1",
      actor: { actorType: "human", userId: "u1" },
      roleHints: { orgRole: "member" },
    });
  });

  it("SUPPRESSES the chip (returns null) when a candidate exists but the actor is INELIGIBLE (§VI, no admin bypass)", async () => {
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org_1" },
    });
    mocks.listChangeSets.mockReturnValue([{ id: "cs_recent" }]);
    mocks.loadAuthorizedTargetedRestoreForActor.mockResolvedValue(null);
    const r = await recentUndoableChangeSetForRunAction({ runId: "run_1" });
    expect(r).toBeNull();
  });

  it("returns null when no recent restorable change-set exists (no eligibility check)", async () => {
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org_1" },
    });
    mocks.listChangeSets.mockReturnValue([]);
    const r = await recentUndoableChangeSetForRunAction({ runId: "run_1" });
    expect(r).toBeNull();
    expect(mocks.loadAuthorizedTargetedRestoreForActor).not.toHaveBeenCalled();
  });
});
