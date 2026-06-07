import { describe, it, expect, vi, beforeEach } from "vitest";

// Tenant-safety regression for the chat-thread reader used by the
// classifier signal intake path. The reader must DENY by default:
//   - legacy global rows (no ownerUserId AND no teamId) -> null;
//   - ownerUserId set but != actorUserId -> null;
//   - teamId set, but the team->teamMember->activeOrgId join is empty
//     -> null (non-member, wrong-org).
//
// This gate protects the one place that authorizes the
// threadId x actor x activeOrgId triple.

const runPostgresQueriesSyncMock = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...args: unknown[]) =>
    runPostgresQueriesSyncMock(...args),
}));

// `ensurePostgresSchema` lives inside `@/lib/database` itself — its
// real implementation only no-ops in tests when SUPABASE_DB_URL is
// unset. We don't need to mock it; we just need the queries it issues
// to be intercepted by our mock above.
process.env.SUPABASE_DB_URL ??= "postgres://test:test@localhost:5432/test";
process.env.SUPABASE_SCHEMA ??= "cinatra_test";

// Relative import bypasses the root vitest stub alias for
// `@/lib/database` (the stub is a minimal helper-only surface and
// doesn't carry this reader). Going through the real path is fine here
// because the only IO surface (`runPostgresQueriesSync`) is already
// mocked above.
import { readChatThreadForClassifier } from "../database";

const ACTOR = "user-actor-1";
const ORG = "org-x";
const TID = "thread-1";

function chatThreadRow(payload: Record<string, unknown>) {
  return { rows: [{ payload: JSON.stringify(payload) }] };
}

function emptyResult() {
  return { rows: [] };
}

describe("readChatThreadForClassifier tenant-safety", () => {
  beforeEach(() => {
    runPostgresQueriesSyncMock.mockReset();
  });

  it("returns null for legacy global rows (no ownerUserId AND no teamId)", () => {
    runPostgresQueriesSyncMock.mockImplementation((arg: { queries: unknown[] }) => {
      // Single query call -> thread lookup -> legacy row payload.
      if (arg.queries.length === 1) {
        return [chatThreadRow({ id: TID, title: "legacy", messages: [] })];
      }
      return [emptyResult()];
    });
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when ownerUserId is set but does NOT match actorUserId", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      chatThreadRow({
        id: TID,
        ownerUserId: "user-different",
        messages: [{ role: "user", content: "hi" }],
      }),
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns stripped messages when ownerUserId matches actorUserId (last-N, role+content only)", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      chatThreadRow({
        id: TID,
        ownerUserId: ACTOR,
        messages: [
          { id: "m1", role: "user", content: "first", createdAt: "t", toolCalls: [{}] },
          { id: "m2", role: "assistant", content: "second", thinking: "secret" },
          { id: "m3", role: "user", content: "third" },
          { id: "m4", role: "user", content: "fourth" },
        ],
      }),
    ]);
    const out = readChatThreadForClassifier({
      threadId: TID,
      actorUserId: ACTOR,
      activeOrgId: ORG,
    });
    expect(out).not.toBeNull();
    expect(out!.threadId).toBe(TID);
    // last-3 cap; oldest dropped.
    expect(out!.messages).toEqual([
      { role: "assistant", content: "second" },
      { role: "user", content: "third" },
      { role: "user", content: "fourth" },
    ]);
    // No toolCalls / thinking / id leaked.
    for (const m of out!.messages) {
      expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    }
  });

  it("returns null when teamId is set but actor is not a member (or team not in activeOrgId)", () => {
    runPostgresQueriesSyncMock
      .mockImplementationOnce(() => [
        chatThreadRow({ id: TID, teamId: "team-x", messages: [] }),
      ])
      .mockImplementationOnce(() => [emptyResult()]); // member query empty -> reject

    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
    // The second query must have been issued with the actor + org + team.
    const memberQuery = runPostgresQueriesSyncMock.mock.calls[1]?.[0] as {
      queries: Array<{ values: unknown[] }>;
    };
    expect(memberQuery.queries[0]?.values).toEqual(["team-x", ACTOR, ORG]);
  });

  it("returns stripped messages when teamId set + member + team in activeOrgId", () => {
    runPostgresQueriesSyncMock
      .mockImplementationOnce(() => [
        chatThreadRow({
          id: TID,
          teamId: "team-x",
          messages: [{ role: "user", content: "team channel" }],
        }),
      ])
      .mockImplementationOnce(() => [{ rows: [{ "?column?": 1 }] }]); // member query: hit

    const out = readChatThreadForClassifier({
      threadId: TID,
      actorUserId: ACTOR,
      activeOrgId: ORG,
    });
    expect(out).toEqual({
      threadId: TID,
      messages: [{ role: "user", content: "team channel" }],
    });
  });

  it("returns null when the thread row does not exist", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [emptyResult()]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when payload is malformed JSON", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      { rows: [{ payload: "not json" }] },
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });
});
