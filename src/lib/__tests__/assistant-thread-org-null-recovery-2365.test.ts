import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// cinatra#2365 AC4 — end-to-end regression across the real exported functions
// (not isolated call-shape assertions): seed a fake in-memory store that
// mimics the reported instance (owner-having legacy threads, most org-null,
// durable content missing), run the REAL restoreDurableContentFromChatThreads
// repair, then assert the REAL org-scoped list path fetchChatThreads uses
// (listAssistantThreadSummariesForOwnerInOrg, packages/chat/src/actions.ts:188)
// now returns them — proving AC1 ("an owner still sees their pre-existing
// threads in /chat") end-to-end, including the org-adoption step.
//
// A live-Postgres proof of this exact scenario was already run by the
// coordinator against a real dev-instance DB copy (6/6 audited/restored,
// 5/6 previously invisible due to org_id NULL). This suite is the portable,
// no-external-DB regression that pins the same behavior going forward,
// exercising the actual production code paths (not a query-shape mock) via a
// small hand-rolled relational fake for the specific query shapes these two
// modules issue.
//
// FOLLOW-UP 2 (live re-verified): the reporting instance's owner actually
// belongs to TWO organizations (Default, created 2026-06-22; Cinatra-Demo,
// created 2026-07-13) — a flat "exactly one org" rule refuses every one of
// that owner's threads. The scenario below now models BOTH orgs and relies
// on TEMPORAL CONTAINMENT (only a membership that predates the thread's own
// creation is eligible) to disambiguate, exactly as the real data does.
// ---------------------------------------------------------------------------

type FakeThread = {
  id: string;
  owner_user_id: string | null;
  org_id: string | null;
  origin: string | null;
  team_id: string | null;
  title: string | null;
  assistant_package: string | null;
  instance_id: string | null;
  title_slug: string | null;
  created_at: string;
  updated_at: string;
  scalars: string | null;
  project_id: string | null;
};

type FakeTurn = {
  id: string;
  thread_id: string;
  run_id: string | null;
  assistant_user_id: string | null;
  role: string;
  status: string;
  content: string | null;
  ordinal: number | null;
  created_at: string;
  updated_at: string;
};

type FakeChatThreadRow = { id: string; payload: string };
/** `memberCreatedAt: null` exercises the organization.createdAt fallback. */
type FakeMemberRow = { organizationId: string; userId: string; memberCreatedAt: string | null };
type FakeOrganizationRow = { id: string; createdAt: string };

type FakeDb = {
  assistantThreads: FakeThread[];
  assistantTurns: FakeTurn[];
  chatThreads: FakeChatThreadRow[];
  member: FakeMemberRow[];
  organization: FakeOrganizationRow[];
};

function makeFakeDb(): FakeDb {
  return { assistantThreads: [], assistantTurns: [], chatThreads: [], member: [], organization: [] };
}

function hasDurableContent(db: FakeDb, threadId: string): boolean {
  return db.assistantTurns.some(
    (turn) =>
      turn.thread_id === threadId &&
      turn.content !== null &&
      turn.run_id === null &&
      turn.id.startsWith("legacy:"),
  );
}

/** Interprets exactly the query shapes
 *  restoreDurableContentFromChatThreads / findLegacyThreadIdsMissing* /
 *  listAssistantThreadSummariesForOwnerInOrg issue, dispatched on a unique
 *  distinguishing substring per shape (not a general SQL parser — this file
 *  controls both the fake and the real callers, so the shapes are known). */
function runFakeQuery(
  db: FakeDb,
  q: { text: string; values: unknown[] },
): { rows: unknown[]; rowCount?: number } {
  const t = q.text;
  const v = q.values;

  // findLegacyThreadIdsMissingDurableContent
  if (t.includes("ct.payload IS NOT NULL")) {
    const rows = db.assistantThreads
      .filter((th) => {
        const ct = db.chatThreads.find((c) => c.id === th.id);
        if (!ct) return false;
        return !hasDurableContent(db, th.id);
      })
      .map((th) => ({ id: th.id }));
    return { rows };
  }

  // chat_threads payload read
  if (t.includes("SELECT payload FROM")) {
    const id = v[0] as string;
    const row = db.chatThreads.find((c) => c.id === id);
    return { rows: row ? [{ payload: row.payload }] : [] };
  }

  // mirror thread upsert (buildAssistantThreadMirrorUpsertQuery)
  if (t.includes("owner_user_id = COALESCE(assistant_threads.owner_user_id")) {
    const [id, ownerUserId, orgId, projectId, teamId, scalars, title, createdAt, updatedAt] = v as [
      string,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
      string | null,
    ];
    const existing = db.assistantThreads.find((th) => th.id === id);
    if (!existing) {
      db.assistantThreads.push({
        id,
        owner_user_id: ownerUserId,
        org_id: orgId,
        project_id: projectId,
        team_id: teamId,
        origin: "legacy-chat",
        scalars,
        title,
        assistant_package: null,
        instance_id: null,
        title_slug: null,
        created_at: createdAt ?? new Date().toISOString(),
        updated_at: updatedAt ?? new Date().toISOString(),
      });
    } else {
      existing.owner_user_id = existing.owner_user_id ?? ownerUserId;
      existing.org_id = existing.org_id ?? orgId; // SET-ONCE, matches the real upsert's COALESCE
      existing.project_id = projectId;
      existing.team_id = existing.team_id ?? teamId;
      existing.origin = existing.origin ?? "legacy-chat";
      existing.scalars = scalars;
      existing.title = title;
      existing.updated_at = updatedAt ?? new Date().toISOString();
    }
    return { rows: [] };
  }

  // turns reconcile DELETE (buildAssistantTurnMirrorReconcileQueries)
  if (t.includes("NOT (id = ANY(")) {
    const [threadId, ids] = v as [string, string[]];
    db.assistantTurns = db.assistantTurns.filter(
      (turn) => !(turn.thread_id === threadId && turn.id.startsWith("legacy:") && !ids.includes(turn.id)),
    );
    return { rows: [] };
  }

  // turns reconcile INSERT (buildAssistantTurnMirrorReconcileQueries)
  if (t.includes("FROM unnest(")) {
    const [threadId, ids, assistantUserIds, roles, createdAts, contents, ordinals] = v as [
      string,
      string[],
      (string | null)[],
      string[],
      (string | null)[],
      (string | null)[],
      number[],
    ];
    for (let i = 0; i < ids.length; i++) {
      const existing = db.assistantTurns.find((turn) => turn.id === ids[i]);
      if (existing) {
        existing.content = contents[i];
        existing.ordinal = ordinals[i];
        existing.updated_at = new Date().toISOString();
      } else {
        db.assistantTurns.push({
          id: ids[i],
          thread_id: threadId,
          run_id: null,
          assistant_user_id: assistantUserIds[i],
          role: roles[i],
          status: "completed",
          content: contents[i],
          ordinal: ordinals[i],
          created_at: createdAts[i] ?? new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
    }
    return { rows: [] };
  }

  // findLegacyThreadIdsMissingOrgAdoption
  if (t.includes("owner_user_id IS NOT NULL")) {
    const rows = db.assistantThreads
      .filter((th) => th.owner_user_id !== null && th.org_id === null && th.origin === "legacy-chat")
      .map((th) => ({ id: th.id, owner_user_id: th.owner_user_id, created_at: th.created_at }));
    return { rows };
  }

  // owner org membership JOIN organization (public.member / public.organization)
  if (t.includes('public."member"')) {
    const userId = v[0] as string;
    const rows = db.member
      .filter((m) => m.userId === userId)
      .map((m) => {
        const org = db.organization.find((o) => o.id === m.organizationId);
        return {
          organization_id: m.organizationId,
          member_created_at: m.memberCreatedAt,
          org_created_at: org?.createdAt ?? null,
        };
      });
    return { rows };
  }

  // org-adoption UPDATE
  if (t.includes("SET org_id = $2")) {
    const [threadId, orgId] = v as [string, string];
    const th = db.assistantThreads.find((x) => x.id === threadId && x.org_id === null);
    if (th) {
      th.org_id = orgId;
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  // listAssistantThreadSummariesForOwnerInOrg (the exact fetchChatThreads path)
  if (t.includes("at.assistant_package")) {
    const [orgId, ownerUserId, limit] = v as [string, string, number];
    const rows = db.assistantThreads
      .filter((th) => th.org_id === orgId && th.owner_user_id === ownerUserId && hasDurableContent(db, th.id))
      .sort((a, b) => b.created_at.localeCompare(a.created_at) || a.id.localeCompare(b.id))
      .slice(0, limit)
      .map((th) => ({
        id: th.id,
        owner_user_id: th.owner_user_id,
        team_id: th.team_id,
        origin: th.origin,
        title: th.title,
        assistant_package: th.assistant_package,
        instance_id: th.instance_id,
        title_slug: th.title_slug,
        created_at: th.created_at,
        updated_at: th.updated_at,
      }));
    return { rows };
  }

  throw new Error(`assistant-thread-org-null-recovery-2365 fake: unhandled query shape: ${t.slice(0, 160)}`);
}

const runPostgresQueriesSync = vi.fn();

vi.mock("@/lib/postgres-sync", () => ({
  runPostgresQueriesSync: (...a: unknown[]) => runPostgresQueriesSync(...a),
}));
vi.mock("@/lib/postgres-config", () => ({
  getPostgresConnectionString: () => "postgres://test",
  postgresSchema: "cinatra_test",
}));
vi.mock("@/lib/postgres-schema-init", () => ({
  ensurePostgresSchema: () => {},
}));

import { restoreDurableContentFromChatThreads } from "../assistant-thread-dormant-content-purge";
import { listAssistantThreadSummariesForOwnerInOrg } from "../assistant-thread-store";

let db: FakeDb;

beforeEach(() => {
  db = makeFakeDb();
  runPostgresQueriesSync.mockReset();
  runPostgresQueriesSync.mockImplementation(
    ({ queries }: { queries: Array<{ text: string; values: unknown[] }> }) =>
      queries.map((q) => runFakeQuery(db, q)),
  );
});

/** Seed one legacy thread: a chat_threads payload + its (already-restored or
 *  already-missing) assistant_threads/assistant_turns mirror rows. */
function seedLegacyThread(args: {
  id: string;
  ownerUserId: string;
  orgId: string | null;
  hasContent: boolean;
  createdAt: string;
}): void {
  const payload = JSON.stringify({
    id: args.id,
    title: `Thread ${args.id}`,
    ownerUserId: args.ownerUserId,
    messages: [
      { id: `${args.id}-m1`, role: "user", content: "hello" },
      { id: `${args.id}-m2`, role: "assistant", content: "hi there" },
    ],
    createdAt: args.createdAt,
    updatedAt: args.createdAt,
  });
  db.chatThreads.push({ id: args.id, payload });
  db.assistantThreads.push({
    id: args.id,
    owner_user_id: args.ownerUserId,
    org_id: args.orgId,
    origin: "legacy-chat",
    team_id: null,
    title: `Thread ${args.id}`,
    assistant_package: null,
    instance_id: null,
    title_slug: null,
    created_at: args.createdAt,
    updated_at: args.createdAt,
    scalars: null,
    project_id: null,
  });
  if (args.hasContent) {
    db.assistantTurns.push(
      {
        id: `legacy:${args.id.length}:${args.id}:${args.id}-m1`,
        thread_id: args.id,
        run_id: null,
        assistant_user_id: null,
        role: "user",
        status: "completed",
        content: JSON.stringify({ id: `${args.id}-m1`, role: "user", content: "hello" }),
        ordinal: 0,
        created_at: args.createdAt,
        updated_at: args.createdAt,
      },
      {
        id: `legacy:${args.id.length}:${args.id}:${args.id}-m2`,
        thread_id: args.id,
        run_id: null,
        assistant_user_id: null,
        role: "assistant",
        status: "completed",
        content: JSON.stringify({ id: `${args.id}-m2`, role: "assistant", content: "hi there" }),
        ordinal: 1,
        created_at: args.createdAt,
        updated_at: args.createdAt,
      },
    );
  }
}

describe("cinatra#2365 AC4 — the reported instance shape, end to end", () => {
  it("6 owned legacy threads (5 org-null, content already purged, owner belongs to TWO orgs) all reappear in the org-scoped /chat list after repair via temporal containment", () => {
    const ownerUserId = "admin-user";
    const defaultOrgId = "org-default";
    const demoOrgId = "org-cinatra-demo";
    // The REAL reported instance shape (live re-verified): the owner belongs
    // to TWO organizations — Default (created 2026-06-22) and Cinatra-Demo
    // (created 2026-07-13) — so a flat "exactly one org" rule refuses every
    // thread. All 6 threads were created 2026-06-25/26 — after Default
    // existed but BEFORE Cinatra-Demo did — so temporal containment leaves
    // exactly Default eligible for every one of them.
    db.organization.push(
      { id: defaultOrgId, createdAt: "2026-06-22T00:00:00Z" },
      { id: demoOrgId, createdAt: "2026-07-13T00:00:00Z" },
    );
    db.member.push(
      { organizationId: defaultOrgId, userId: ownerUserId, memberCreatedAt: "2026-06-22T00:00:00Z" },
      { organizationId: demoOrgId, userId: ownerUserId, memberCreatedAt: "2026-07-13T00:00:00Z" },
    );

    const ids = ["cc44c035", "8d9c763d", "dbbca750", "905d38e5", "73dd22cd", "446c1562"];
    ids.forEach((id, i) => {
      seedLegacyThread({
        id,
        ownerUserId,
        orgId: i === 0 ? defaultOrgId : null, // only the first is already org-anchored (to Default)
        hasContent: false, // content already purged, matching the reported state
        createdAt: `2026-06-2${5 + (i % 2)}T00:00:00Z`, // 2026-06-25 / 2026-06-26, matching the report
      });
    });

    // BEFORE repair: the org-scoped list (fetchChatThreads' real path) sees
    // none — even the already-anchored thread has no durable content yet.
    // Confirms the reported "vanished" state.
    const before = listAssistantThreadSummariesForOwnerInOrg(defaultOrgId, ownerUserId);
    expect(before).toEqual([]);

    const result = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(result).toEqual({
      auditedThreads: 6,
      restored: 6,
      adopted: 5,
      skippedAmbiguous: 0,
      dryRun: false,
    });

    // AFTER repair: the REAL org-scoped list path now returns all 6 under
    // Default — content restored AND the 5 previously org-null threads
    // adopted into the ONE org that already existed when they were created.
    const after = listAssistantThreadSummariesForOwnerInOrg(defaultOrgId, ownerUserId);
    expect(after.map((t) => t.id).sort()).toEqual([...ids].sort());
    // None leaked into Cinatra-Demo's list — it didn't exist yet at the time.
    expect(listAssistantThreadSummariesForOwnerInOrg(demoOrgId, ownerUserId)).toEqual([]);
  });

  it("multi-org ambiguous case: TWO orgs BOTH predating the thread stays unadopted and invisible to EITHER org's list", () => {
    const ownerUserId = "multi-org-user";
    const threadId = "ambiguous-thread";
    // Both orgs existed well before the thread was created — temporal
    // containment does NOT disambiguate this case; it is genuinely ambiguous.
    db.organization.push(
      { id: "org-a", createdAt: "2026-01-01T00:00:00Z" },
      { id: "org-b", createdAt: "2026-02-01T00:00:00Z" },
    );
    db.member.push(
      { organizationId: "org-a", userId: ownerUserId, memberCreatedAt: "2026-01-01T00:00:00Z" },
      { organizationId: "org-b", userId: ownerUserId, memberCreatedAt: "2026-02-01T00:00:00Z" },
    );
    seedLegacyThread({
      id: threadId,
      ownerUserId,
      orgId: null,
      hasContent: true, // content already present — isolates the org-adoption axis
      createdAt: "2026-07-01T00:00:00Z",
    });

    const result = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(result).toEqual({
      auditedThreads: 0,
      restored: 0,
      adopted: 0,
      skippedAmbiguous: 1,
      dryRun: false,
    });

    // Still invisible to BOTH orgs' /chat panels — never guessed.
    expect(listAssistantThreadSummariesForOwnerInOrg("org-a", ownerUserId)).toEqual([]);
    expect(listAssistantThreadSummariesForOwnerInOrg("org-b", ownerUserId)).toEqual([]);
  });

  it("temporal disambiguation: a two-org owner where only ONE org predates the thread adopts into THAT org", () => {
    const ownerUserId = "single-eligible-user";
    const threadId = "pre-second-org-thread";
    const earlyOrgId = "org-early";
    const lateOrgId = "org-late";
    db.organization.push(
      { id: earlyOrgId, createdAt: "2026-01-01T00:00:00Z" },
      { id: lateOrgId, createdAt: "2026-08-01T00:00:00Z" }, // created AFTER the thread
    );
    db.member.push(
      { organizationId: earlyOrgId, userId: ownerUserId, memberCreatedAt: "2026-01-01T00:00:00Z" },
      { organizationId: lateOrgId, userId: ownerUserId, memberCreatedAt: "2026-08-01T00:00:00Z" },
    );
    seedLegacyThread({
      id: threadId,
      ownerUserId,
      orgId: null,
      hasContent: true,
      createdAt: "2026-07-01T00:00:00Z", // before lateOrgId existed
    });

    const result = restoreDurableContentFromChatThreads({ dryRun: false });
    expect(result).toEqual({
      auditedThreads: 0,
      restored: 0,
      adopted: 1,
      skippedAmbiguous: 0,
      dryRun: false,
    });

    expect(listAssistantThreadSummariesForOwnerInOrg(earlyOrgId, ownerUserId).map((t) => t.id)).toEqual([threadId]);
    expect(listAssistantThreadSummariesForOwnerInOrg(lateOrgId, ownerUserId)).toEqual([]);
  });
});
