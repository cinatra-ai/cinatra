import { readFileSync } from "node:fs";
import path from "node:path";
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
//
// PR2 CUTOVER (cinatra#1037 P5.6): the reader authorizes off the STRUCTURED
// mirror (assistant_threads) in ONE joined statement returning
// { owner_user_id, team_id, mirror_org_id, team_member_ok } — one consistent
// snapshot (no cross-statement TOCTOU) + the personal-thread org predicate — then
// reconstructs the messages from the durable structured turns via
// reconstructThreadPayload (NOT chat_threads.payload).

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

// Relative import bypasses the root vitest stub alias for `@/lib/database` (the
// stub is a minimal helper-only surface and doesn't carry this reader). The
// DENY-matrix cases below return BEFORE the authorized-path reconstruction, so
// they never reach database.ts's internal `require("@/lib/assistant-thread-
// store")` — a raw `@/`-aliased CJS require that vitest cannot boot for this
// module (the same "cannot boot the full sync-pg graph" constraint the
// chat-capture-enqueue-hook test documents). The AUTHORIZED reconstruction path
// is therefore asserted SOURCE-LEVEL below and proven end-to-end by the
// assistant-thread-store reconstructThreadPayload suite + the PR2 live proof.
import { readChatThreadForClassifier } from "../database";

const ACTOR = "user-actor-1";
const ORG = "org-x";
const TID = "thread-1";

// The single joined authz statement returns the structured mirror's ownership
// axes as columns (owner_user_id / team_id / mirror_org_id) + the same-snapshot
// team-membership EXISTS (team_member_ok). Messages come SEPARATELY from
// reconstructThreadPayload — never from this authz row.
function authzRow(opts?: {
  ownerUserId?: string | null;
  teamId?: string | null;
  mirrorOrgId?: string | null;
  teamMemberOk?: boolean;
}) {
  return {
    rows: [
      {
        owner_user_id: opts?.ownerUserId ?? null,
        team_id: opts?.teamId ?? null,
        mirror_org_id: opts?.mirrorOrgId ?? null,
        team_member_ok: opts?.teamMemberOk ?? false,
      },
    ],
  };
}

function emptyResult() {
  return { rows: [] };
}

describe("readChatThreadForClassifier tenant-safety", () => {
  beforeEach(() => {
    runPostgresQueriesSyncMock.mockReset();
  });

  it("returns null for legacy global rows (no ownerUserId AND no teamId)", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [authzRow({})]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when ownerUserId is set but does NOT match actorUserId", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      authzRow({ ownerUserId: "user-different", mirrorOrgId: ORG }),
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when ownerUserId matches but the thread's mirror org != activeOrgId (org predicate)", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      authzRow({ ownerUserId: ACTOR, mirrorOrgId: "org-OTHER" }),
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when ownerUserId matches but the mirror org is NULL (fail-closed)", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      authzRow({ ownerUserId: ACTOR, mirrorOrgId: null }),
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when teamId is set but the same-snapshot membership check fails", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      authzRow({ teamId: "team-x", teamMemberOk: false }),
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
    // The single joined statement is issued with the thread id + actor + org.
    const call = runPostgresQueriesSyncMock.mock.calls[0]?.[0] as {
      queries: Array<{ values: unknown[] }>;
    };
    expect(call.queries[0]?.values).toEqual([TID, ACTOR, ORG]);
    // ...and the authz read is a SINGLE statement (one consistent snapshot, no
    // TOCTOU); a denial returns BEFORE any reconstruction read.
    expect(runPostgresQueriesSyncMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the thread row does not exist", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [emptyResult()]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  it("returns null when the structured row carries no ownership axes (legacy/ownerless)", () => {
    runPostgresQueriesSyncMock.mockImplementation(() => [
      authzRow({ ownerUserId: null, teamId: null, mirrorOrgId: ORG }),
    ]);
    expect(
      readChatThreadForClassifier({ threadId: TID, actorUserId: ACTOR, activeOrgId: ORG }),
    ).toBeNull();
  });

  // The AUTHORIZED path reconstructs messages from the STRUCTURED store (never
  // chat_threads.payload) and strips them to {role, content} last-3. Executing
  // that branch requires booting database.ts's internal `require("@/lib/
  // assistant-thread-store")` — a raw `@/`-aliased CJS require vitest cannot
  // resolve for this module (same constraint as chat-capture-enqueue-hook). The
  // reconstruction + stripping behavior is proven end-to-end by the
  // assistant-thread-store `reconstructThreadPayload` suite and the PR2 live
  // proof; here we source-pin that the authorized branch reconstructs from the
  // structured store and strips via the classifier leaf (so a regression that
  // reverts to reading chat_threads.payload, or drops the strip, trips this).
  it("reconstructs the authorized reply from the structured store + strips via the classifier leaf (source-pinned)", () => {
    const source = readFileSync(
      path.join(process.cwd(), "src/lib/database.ts"),
      "utf8",
    );
    const fnStart = source.indexOf("export function readChatThreadForClassifier(");
    expect(fnStart).toBeGreaterThan(-1);
    const nextExport = source.indexOf("\nexport function", fnStart + 1);
    const body = source.slice(fnStart, nextExport === -1 ? undefined : nextExport);
    // messages come from the structured reconstruction, NOT a chat_threads read
    expect(body).toContain("reconstructThreadPayload(input.threadId)");
    expect(body).not.toContain("FROM chat_threads");
    expect(body).not.toContain('."chat_threads"');
    // and are stripped through the classifier signal leaf
    expect(body).toContain("stripChatMessagesForClassifier");
  });
});
