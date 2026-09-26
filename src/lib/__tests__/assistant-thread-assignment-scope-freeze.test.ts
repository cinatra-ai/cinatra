/**
 * A NEW CONVERSATION FREEZES ITS ASSIGNMENT SCOPES (cinatra#2815 S3, epic
 * #2812).
 *
 * `assistant_threads.assignment_scope_snapshot` is the immutable twin of the
 * agent run's column: the scopes a conversation was created under, decided once
 * and never re-pointed. The delivery seam reads nothing else. So a row born
 * without it takes the sole legacy fallback for its whole life, and the whole
 * per-scope chain is unreachable from the chat surface.
 *
 * Two writers create such a row: this store's own create, and the legacy chat
 * mirror, whose upsert names no scope column and which in the field usually
 * wins the race. This suite pins both roads: the create freezes inside its own
 * atomic insert, and the set-once freeze covers the row the mirror made.
 *
 * The postgres leaves are mocked, so what is asserted is the statement and the
 * values the store actually sends.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const runPostgresQueriesSync = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "app_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => undefined,
}));

import {
  buildThreadAssignmentScopeSnapshotText,
  createAssistantThread,
  freezeAssistantThreadAssignmentScopeIfAbsent,
} from "../assistant-thread-store";

const HUMAN = {
  principalType: "HumanUser",
  principalId: "user-1",
  teamIds: ["team-b", "team-a"],
};

function insertedRow() {
  return {
    rows: [
      {
        id: "th1",
        assistant_user_id: null,
        owner_user_id: "user-1",
        org_id: "org-1",
        project_id: null,
        team_id: null,
        origin: "assistant-native",
        title: null,
        context_id: null,
        assistant_package: null,
        instance_id: null,
        title_slug: null,
        created_at: "2026-09-23T10:00:00.000Z",
        updated_at: "2026-09-23T10:00:00.000Z",
      },
    ],
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "warn").mockImplementation(() => {});
  runPostgresQueriesSync.mockReturnValue([insertedRow()]);
});

describe("the derivation", () => {
  it("is the run's own: organization, project, sorted teams, the originating human", () => {
    const text = buildThreadAssignmentScopeSnapshotText({
      orgId: "org-1",
      projectId: "proj-1",
      scopeActor: HUMAN,
    });
    expect(JSON.parse(text as string)).toEqual({
      v: 1,
      orgId: "org-1",
      projectId: "proj-1",
      teamIds: ["team-a", "team-b"],
      originatingHumanUserId: "user-1",
    });
  });

  it("names NO originating human for a non-human principal", () => {
    const text = buildThreadAssignmentScopeSnapshotText({
      orgId: "org-1",
      scopeActor: { principalType: "ServiceAccount", principalId: "svc-1", teamIds: [] },
    });
    expect(JSON.parse(text as string).originatingHumanUserId).toBeUndefined();
  });

  it("freezes NOTHING when there is no organization to anchor the scopes", () => {
    expect(buildThreadAssignmentScopeSnapshotText({ orgId: null, scopeActor: HUMAN })).toBeNull();
    expect(buildThreadAssignmentScopeSnapshotText({ orgId: "   ", scopeActor: HUMAN })).toBeNull();
  });
});

describe("the create", () => {
  it("writes the frozen scopes in the SAME insert as the row", () => {
    createAssistantThread({
      id: "th1",
      ownerUserId: "user-1",
      orgId: "org-1",
      projectId: "proj-1",
      scopeActor: HUMAN,
    });
    const query = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(query.text).toContain("assignment_scope_snapshot");
    expect(JSON.parse(query.values[10] as string)).toEqual({
      v: 1,
      orgId: "org-1",
      projectId: "proj-1",
      teamIds: ["team-a", "team-b"],
      originatingHumanUserId: "user-1",
    });
  });

  it("leaves the column NULL when the thread has no organization, and still creates the row", () => {
    createAssistantThread({ id: "th1", ownerUserId: "user-1", orgId: null, scopeActor: HUMAN });
    const query = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    expect(query.values[10]).toBeNull();
  });
});

describe("the set-once freeze of a row this request did not create", () => {
  // A later turn may NOT decide what an existing conversation was created
  // under. Its participant can be an administrator continuing somebody else's
  // conversation, or the owner with a different active organization, and either
  // would rewrite the provenance of a row that already has one. The only
  // evidence this seam may use is the row's OWN creation-time columns.
  function seedRow(row: Record<string, unknown> | null) {
    runPostgresQueriesSync.mockReset();
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: row ? [row] : [] }])
      .mockReturnValue([{ rowCount: 1, rows: [] }]);
  }

  it("derives the scopes from the row's own owner and organization", () => {
    seedRow({ owner_user_id: "owner-1", org_id: "org-A" });
    expect(freezeAssistantThreadAssignmentScopeIfAbsent("th1")).toBe(true);
    const update = runPostgresQueriesSync.mock.calls[1][0].queries[0];
    expect(JSON.parse(update.values[1] as string)).toEqual({
      v: 1,
      orgId: "org-A",
      teamIds: [],
      originatingHumanUserId: "owner-1",
    });
  });

  it("takes NOTHING from the participant of this turn", () => {
    // The signature carries no session at all, which is what makes the rule
    // hold for every caller rather than for the one that remembered it.
    expect(freezeAssistantThreadAssignmentScopeIfAbsent.length).toBe(1);
  });

  it("records no project, because a conversation's project moves after creation", () => {
    seedRow({ owner_user_id: "owner-1", org_id: "org-A", project_id: "proj-now" });
    freezeAssistantThreadAssignmentScopeIfAbsent("th1");
    const update = runPostgresQueriesSync.mock.calls[1][0].queries[0];
    expect(JSON.parse(update.values[1] as string).projectId).toBeUndefined();
  });

  it("names no originating human when the row records no owner", () => {
    seedRow({ owner_user_id: null, org_id: "org-A" });
    freezeAssistantThreadAssignmentScopeIfAbsent("th1");
    const update = runPostgresQueriesSync.mock.calls[1][0].queries[0];
    expect(JSON.parse(update.values[1] as string).originatingHumanUserId).toBeUndefined();
  });

  it("admits a NULL column only, so a live conversation can never be re-pointed", () => {
    seedRow({ owner_user_id: "owner-1", org_id: "org-A" });
    freezeAssistantThreadAssignmentScopeIfAbsent("th1");
    const read = runPostgresQueriesSync.mock.calls[0][0].queries[0];
    const update = runPostgresQueriesSync.mock.calls[1][0].queries[0];
    expect(read.text).toContain("assignment_scope_snapshot IS NULL");
    expect(update.text).toContain("assignment_scope_snapshot IS NULL");
  });

  it("writes nothing when the row already carries a snapshot", () => {
    seedRow(null);
    expect(freezeAssistantThreadAssignmentScopeIfAbsent("th1")).toBe(false);
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the row names no organization to anchor the scopes", () => {
    seedRow({ owner_user_id: "owner-1", org_id: null });
    expect(freezeAssistantThreadAssignmentScopeIfAbsent("th1")).toBe(false);
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("degrades rather than ending the turn when the read throws", () => {
    runPostgresQueriesSync.mockReset();
    runPostgresQueriesSync.mockImplementation(() => {
      throw new Error("database unreachable");
    });
    expect(freezeAssistantThreadAssignmentScopeIfAbsent("th1")).toBe(false);
  });
});
