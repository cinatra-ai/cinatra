/**
 * PER-PRODUCER fixture for the chat "Undo last action" chip
 * (cinatra#2701, epic #2699 S2).
 *
 * The chip renders ONLY when this read returns a change-set id, and its single
 * act is to deep-link into `/configuration/artifacts/restore/...` — a segment
 * that answers only to a platform-admin session (S1, #2700). So the gate lives
 * in the one shared candidate read, where BOTH doors (the `/chat` cookie server
 * action and the widget's `/api/chat/undo-candidate`) must pass through it.
 *
 * The two doors stamp the tier differently — the widget's S8a actor carries the
 * trusted `platformRole` claim, the cookie door's `actorFromSession` carries the
 * translated `roles` list — so both shapes are exercised here.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const mocks = vi.hoisted(() => ({
  listChangeSets: vi.fn(() => [{ id: "cs_1" }]),
  loadAuthorizedTargetedRestoreForActor: vi.fn(async () => true),
}));

vi.mock("@/lib/object-history", () => ({ listChangeSets: mocks.listChangeSets }));
vi.mock("@/lib/object-history/restore-eligibility", () => ({
  loadAuthorizedTargetedRestoreForActor: mocks.loadAuthorizedTargetedRestoreForActor,
}));

import { recentUndoableChangeSetFor } from "../undo-candidate-surface";

const BASE = { runId: "run_1", orgId: "org_1" } as const;

describe("cinatra#2701 — the undo chip's candidate read is platform-admin only", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listChangeSets.mockReturnValue([{ id: "cs_1" }]);
    mocks.loadAuthorizedTargetedRestoreForActor.mockResolvedValue(true);
  });

  it("a MEMBER gets null — and the change-set is never even queried", async () => {
    const found = await recentUndoableChangeSetFor({
      ...BASE,
      actor: { actorType: "human", source: "ui", userId: "u2", roles: ["user"] } as never,
      roleHints: { orgRole: "member" },
    });
    expect(found).toBeNull();
    // Discretion preserved: a non-admin learns nothing about what exists.
    expect(mocks.listChangeSets).not.toHaveBeenCalled();
    expect(mocks.loadAuthorizedTargetedRestoreForActor).not.toHaveBeenCalled();
  });

  it("the COOKIE door's actor shape (translated `roles`) is recognised as admin", async () => {
    const found = await recentUndoableChangeSetFor({
      ...BASE,
      actor: {
        actorType: "human",
        source: "ui",
        userId: "u1",
        roles: ["user", "platform_admin"],
      } as never,
      roleHints: { orgRole: "org_admin" },
    });
    expect(found).toEqual({ changeSetId: "cs_1" });
  });

  it("the WIDGET door's actor shape (trusted `platformRole` claim) is recognised as admin", async () => {
    const found = await recentUndoableChangeSetFor({
      ...BASE,
      actor: {
        actorType: "human",
        source: "mcp",
        userId: "u1",
        platformRole: "platform_admin",
      } as never,
      roleHints: undefined,
    });
    expect(found).toEqual({ changeSetId: "cs_1" });
  });

  it("a resolved `roleHints.platformRole` is honoured too", async () => {
    const found = await recentUndoableChangeSetFor({
      ...BASE,
      actor: { actorType: "human", source: "ui", userId: "u1" } as never,
      roleHints: { platformRole: "platform_admin" },
    });
    expect(found).toEqual({ changeSetId: "cs_1" });
  });

  it("the §VI per-object gate STILL decides for an admin — no bypass was introduced", async () => {
    mocks.loadAuthorizedTargetedRestoreForActor.mockResolvedValue(false);
    const found = await recentUndoableChangeSetFor({
      ...BASE,
      actor: {
        actorType: "human",
        source: "ui",
        userId: "u1",
        platformRole: "platform_admin",
      } as never,
      roleHints: undefined,
    });
    expect(found).toBeNull();
    expect(mocks.loadAuthorizedTargetedRestoreForActor).toHaveBeenCalledTimes(1);
  });
});
