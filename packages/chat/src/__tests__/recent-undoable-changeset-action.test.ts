// recentUndoableChangeSetForRunAction.
// Pins: orgless → null; the poll uses runId + closedAtAfter + restorable:true
// (so only recent CLOSED restorable change-sets from the run surface); a found
// row maps to { changeSetId }. Lives in undo-actions.ts (light import graph).

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  listChangeSets: vi.fn(),
  isSessionEligibleForTargetedRestore: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: mocks.requireAuthSession,
}));
vi.mock("@/lib/object-history", () => ({ listChangeSets: mocks.listChangeSets }));
vi.mock("@/lib/object-history/restore-eligibility", () => ({
  isSessionEligibleForTargetedRestore: mocks.isSessionEligibleForTargetedRestore,
}));

import { recentUndoableChangeSetForRunAction } from "../undo-actions";

describe("recentUndoableChangeSetForRunAction", () => {
  beforeEach(() => {
    mocks.requireAuthSession.mockReset();
    mocks.listChangeSets.mockReset();
    mocks.isSessionEligibleForTargetedRestore.mockReset();
    // Default: eligible — the eligibility-suppression cases pin false explicitly.
    mocks.isSessionEligibleForTargetedRestore.mockResolvedValue(true);
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
    // The chip is gated on the SAME per-object eligibility as the restore.
    expect(mocks.isSessionEligibleForTargetedRestore).toHaveBeenCalledWith("cs_recent");
  });

  it("SUPPRESSES the chip (returns null) when a candidate exists but the actor is INELIGIBLE (§VI, no admin bypass)", async () => {
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org_1" },
    });
    mocks.listChangeSets.mockReturnValue([{ id: "cs_recent" }]);
    mocks.isSessionEligibleForTargetedRestore.mockResolvedValue(false);
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
    expect(mocks.isSessionEligibleForTargetedRestore).not.toHaveBeenCalled();
  });
});
