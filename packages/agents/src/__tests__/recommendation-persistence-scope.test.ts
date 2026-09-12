import { describe, it, expect } from "vitest";
import { WORKSPACE_SCOPE_SENTINEL } from "@/lib/assignment-scope";
import type { AssignmentScopeSnapshot } from "../assignment-scope-snapshot";
import {
  offeredRecommendationScopes,
  resolveRecommendationPersistenceScope,
  type RecommendationWritableScopes,
} from "../run-recommendation-core";

// ---------------------------------------------------------------------------
// cinatra#2815 S3 part (4): the confirm path ENFORCES the offered scope set
// server-side — (the run-snapshot chain INTERSECTED with the actor's writable
// scopes) plus the actor's personal scope only when the snapshot's originating
// human IS the actor.
// ---------------------------------------------------------------------------

const snapshot = (over: Partial<AssignmentScopeSnapshot> = {}): AssignmentScopeSnapshot =>
  ({
    v: 1,
    orgId: "org-1",
    teamIds: ["team-a", "team-b"],
    ...over,
  }) as AssignmentScopeSnapshot;

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

describe("the offered recommendation-persistence scope set", () => {
  it("is the run-snapshot chain INTERSECTED with the actor's writable scopes, narrowest first", () => {
    const offered = offeredRecommendationScopes({
      snapshot: snapshot({ projectId: "proj-1", originatingHumanUserId: "user-1" }),
      writable: writable({
        projectIds: ["proj-1"],
        teamIds: ["team-b"],
        organizationIds: ["org-1"],
        mayWriteWorkspace: true,
      }),
    });
    expect(offered).toEqual([
      { scopeKind: "project", scopeId: "proj-1" },
      { scopeKind: "user", scopeId: "user-1" },
      { scopeKind: "team", scopeId: "team-b" },
      { scopeKind: "organization", scopeId: "org-1" },
      { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL },
    ]);
  });

  it("drops every layer the actor cannot write, however wide the snapshot is", () => {
    const offered = offeredRecommendationScopes({
      snapshot: snapshot({ projectId: "proj-1", originatingHumanUserId: "user-1" }),
      // A non-admin with no project grant and no team: the personal scope on
      // their own run is all that is left.
      writable: writable(),
    });
    expect(offered).toEqual([{ scopeKind: "user", scopeId: "user-1" }]);
  });

  it("offers the personal scope ONLY when the snapshot's originating human IS the actor", () => {
    const foreign = offeredRecommendationScopes({
      snapshot: snapshot({ originatingHumanUserId: "someone-else" }),
      writable: writable({ organizationIds: ["org-1"] }),
    });
    expect(foreign).toEqual([{ scopeKind: "organization", scopeId: "org-1" }]);
    // A headless run names no originating human at all — still no personal scope.
    const headless = offeredRecommendationScopes({
      snapshot: snapshot(),
      writable: writable({ organizationIds: ["org-1"] }),
    });
    expect(headless.some((s) => s.scopeKind === "user")).toBe(false);
  });

  it("walks the snapshot's teams in the snapshot's own order", () => {
    const offered = offeredRecommendationScopes({
      snapshot: snapshot({ teamIds: ["team-a", "team-b"] }),
      writable: writable({ teamIds: ["team-b", "team-a"] }),
    });
    expect(offered.map((s) => s.scopeId)).toEqual(["team-a", "team-b"]);
  });

  it("never offers a scope the snapshot does not carry, even to an admin", () => {
    const offered = offeredRecommendationScopes({
      snapshot: snapshot({ teamIds: [] }),
      writable: writable({
        projectIds: ["proj-9"],
        teamIds: ["team-z"],
        organizationIds: ["org-1", "org-2"],
        mayWriteWorkspace: true,
      }),
    });
    expect(offered).toEqual([
      { scopeKind: "organization", scopeId: "org-1" },
      { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL },
    ]);
  });
});

describe("resolving the scope a confirm writes into", () => {
  it("defaults to the NARROWEST writable scope", () => {
    const verdict = resolveRecommendationPersistenceScope({
      snapshot: snapshot({ projectId: "proj-1", originatingHumanUserId: "user-1" }),
      writable: writable({ projectIds: ["proj-1"], organizationIds: ["org-1"] }),
    });
    expect(verdict).toMatchObject({
      ok: true,
      scope: { scopeKind: "project", scopeId: "proj-1" },
    });
  });

  it("a NON-ADMIN confirming on their OWN run may land in their personal scope", () => {
    const verdict = resolveRecommendationPersistenceScope({
      snapshot: snapshot({ originatingHumanUserId: "user-1" }),
      writable: writable(),
      requested: { scopeKind: "user", scopeId: "user-1" },
    });
    expect(verdict).toEqual({
      ok: true,
      scope: { scopeKind: "user", scopeId: "user-1" },
      offered: [{ scopeKind: "user", scopeId: "user-1" }],
    });
  });

  it("a FOREIGN confirmer is refused the personal scope — the server enforces, never renders", () => {
    const verdict = resolveRecommendationPersistenceScope({
      snapshot: snapshot({ originatingHumanUserId: "someone-else" }),
      writable: writable({ organizationIds: ["org-1"] }),
      // The client asks for the originating human's personal scope anyway.
      requested: { scopeKind: "user", scopeId: "someone-else" },
    });
    expect(verdict).toEqual({ ok: false, reason: "scope-not-offered" });
    // And it cannot reach its OWN personal scope on a run it did not start.
    expect(
      resolveRecommendationPersistenceScope({
        snapshot: snapshot({ originatingHumanUserId: "someone-else" }),
        writable: writable({ organizationIds: ["org-1"] }),
        requested: { scopeKind: "user", scopeId: "user-1" },
      }),
    ).toEqual({ ok: false, reason: "scope-not-offered" });
  });

  it("refuses a request for a scope the snapshot or the actor does not carry", () => {
    expect(
      resolveRecommendationPersistenceScope({
        snapshot: snapshot(),
        writable: writable({ organizationIds: ["org-1"] }),
        requested: { scopeKind: "workspace", scopeId: WORKSPACE_SCOPE_SENTINEL },
      }),
    ).toEqual({ ok: false, reason: "scope-not-offered" });
  });

  it("refuses when the actor can write NOTHING the run's chain names", () => {
    expect(
      resolveRecommendationPersistenceScope({
        snapshot: snapshot({ originatingHumanUserId: "someone-else" }),
        writable: writable(),
      }),
    ).toEqual({ ok: false, reason: "no-writable-scope" });
  });
});
