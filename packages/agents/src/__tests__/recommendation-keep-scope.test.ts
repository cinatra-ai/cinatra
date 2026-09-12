/**
 * cinatra#2815 S3 part (4) — recommendation persistence lands in the chosen
 * scope, including a non-admin's personal scope on their OWN run, and never for
 * a foreign confirmer. The store insert is injected, so this is a unit test of
 * the ENFORCEMENT, not of the store.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("server-only", () => ({}));

const insert = vi.fn();

import type { AssignmentScopeSnapshot } from "../assignment-scope-snapshot";
import { keepConfirmedRecommendationInScope } from "../run-recommendation-core";
import type { RecommendationWritableScopes } from "../run-recommendation-core";

const snapshot = (over: Partial<AssignmentScopeSnapshot> = {}): AssignmentScopeSnapshot =>
  ({ v: 1, orgId: "org-1", teamIds: [], ...over }) as AssignmentScopeSnapshot;

const writable = (
  over: Partial<RecommendationWritableScopes> = {},
): RecommendationWritableScopes => ({
  actorUserId: "user-1",
  projectIds: [],
  teamIds: [],
  organizationIds: [],
  mayWriteWorkspace: false,
  ...over,
});

const keep = (over: Record<string, unknown> = {}) =>
  keepConfirmedRecommendationInScope({
    agentPackageName: "@cinatra-ai/some-agent",
    runId: "run-1",
    confirmedSkillIds: ["skill-a", "skill-b"],
    createdBy: "user-1",
    snapshot: snapshot({ originatingHumanUserId: "user-1" }),
    writable: writable(),
    insert,
    ...over,
  });

beforeEach(() => {
  insert.mockReset();
  insert.mockResolvedValue({ outcome: "assigned" });
});

describe("keeping a confirmed recommendation", () => {
  it("a NON-ADMIN lands it in their PERSONAL scope on their own run, as source=recommended", async () => {
    const result = await keep();
    expect(result).toMatchObject({
      ok: true,
      scope: { scopeKind: "user", scopeId: "user-1" },
      written: 2,
    });
    expect(insert).toHaveBeenCalledTimes(2);
    expect(insert).toHaveBeenNthCalledWith(1, {
      agentPackageName: "@cinatra-ai/some-agent",
      skillId: "skill-a",
      createdBy: "user-1",
      scope: { scopeKind: "user", scopeId: "user-1" },
      source: "recommended",
      // The row POINTS at the run it came from.
      originRunId: "run-1",
    });
  });

  it("never persists for a FOREIGN confirmer — nothing is written at all", async () => {
    const result = await keep({
      snapshot: snapshot({ originatingHumanUserId: "someone-else" }),
      writable: writable(),
    });
    expect(result).toEqual({ ok: false, reason: "no-writable-scope" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses a requested scope that is not in the SERVER-derived offered set", async () => {
    const result = await keep({
      snapshot: snapshot({ originatingHumanUserId: "someone-else" }),
      writable: writable({ organizationIds: ["org-1"] }),
      // The confirmer asks for the run starter's personal scope.
      requestedScope: { scopeKind: "user", scopeId: "someone-else" },
    });
    expect(result).toEqual({ ok: false, reason: "scope-not-offered" });
    expect(insert).not.toHaveBeenCalled();
  });

  it("honours an OFFERED requested scope over the narrowest default", async () => {
    const result = await keep({
      snapshot: snapshot({ originatingHumanUserId: "user-1", projectId: "proj-1" }),
      writable: writable({ projectIds: ["proj-1"], organizationIds: ["org-1"] }),
      requestedScope: { scopeKind: "organization", scopeId: "org-1" },
    });
    expect(result).toMatchObject({
      ok: true,
      scope: { scopeKind: "organization", scopeId: "org-1" },
    });
  });

  it("a cap-full or already-assigned row is SKIPPED, never thrown, and the rest still land", async () => {
    insert
      .mockResolvedValueOnce({ outcome: "cap_exceeded", count: 5 })
      .mockResolvedValueOnce({ outcome: "assigned" });
    const result = await keep();
    expect(result).toMatchObject({ ok: true, written: 1, skipped: ["skill-a"] });
  });

  it("a store that throws costs that ONE row, not the keep", async () => {
    insert.mockRejectedValueOnce(new Error("db down")).mockResolvedValueOnce({
      outcome: "assigned",
    });
    const result = await keep();
    expect(result).toMatchObject({ ok: true, written: 1, skipped: ["skill-a"] });
  });

  it("deduplicates the confirmed ids — one skill is one row", async () => {
    await keep({ confirmedSkillIds: ["skill-a", "skill-a", "skill-b"] });
    expect(insert).toHaveBeenCalledTimes(2);
  });
});
