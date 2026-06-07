// recentUndoableChangeSetForRunAction.
// Pins: orgless → null; the poll uses runId + closedAtAfter + restorable:true
// (so only recent CLOSED restorable change-sets from the run surface); a found
// row maps to { changeSetId }. Lives in undo-actions.ts (light import graph).

import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAuthSession: vi.fn(),
  listChangeSets: vi.fn(),
}));

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: mocks.requireAuthSession,
}));
vi.mock("@/lib/object-history", () => ({ listChangeSets: mocks.listChangeSets }));

import { recentUndoableChangeSetForRunAction } from "../undo-actions";

describe("recentUndoableChangeSetForRunAction", () => {
  beforeEach(() => {
    mocks.requireAuthSession.mockReset();
    mocks.listChangeSets.mockReset();
  });

  it("returns null for an orgless session (no query)", async () => {
    mocks.requireAuthSession.mockResolvedValue({ user: { id: "u1" }, session: {} });
    const r = await recentUndoableChangeSetForRunAction({ runId: "run_1" });
    expect(r).toBeNull();
    expect(mocks.listChangeSets).not.toHaveBeenCalled();
  });

  it("queries runId + closedAtAfter + restorable:true, returns { changeSetId }", async () => {
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
  });

  it("returns null when no recent restorable change-set exists", async () => {
    mocks.requireAuthSession.mockResolvedValue({
      user: { id: "u1" },
      session: { activeOrganizationId: "org_1" },
    });
    mocks.listChangeSets.mockReturnValue([]);
    const r = await recentUndoableChangeSetForRunAction({ runId: "run_1" });
    expect(r).toBeNull();
  });
});
