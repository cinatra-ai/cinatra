// The CREATION-SEAM container bind (cinatra#2650) — decision table + SQL shape.
//
// The postgres sync leaves are mocked so the pure classification and the exact
// statement this primitive assembles are exercised without a database; the live
// behaviour (both create orderings, the failed first turn, the forged client
// field, the absent repair) is proven against real Postgres by
// chat-thread-container-binding.integration.test.ts.
//
// A separate file from assistant-thread-store.test.ts and
// assistant-thread-unbound-store.test.ts so the #2589 and #2642 suites stay
// byte-unchanged.
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
  bindThreadContainerIfUnbound,
  classifyThreadContainerBind,
  isMalformedPartialBinding,
  type AssistantThread,
  type ThreadContainer,
  type UnboundThreadActor,
} from "../assistant-thread-store";

const ACTOR: UnboundThreadActor = { userId: "user-1", orgId: "org-1" };
const THREAD_ID = "cc862657-cbad-4aa9-b815-36eb839510da";
const LOCAL: ThreadContainer = { assistantPackage: "@acme/helper-assistant", instanceId: null };
const REMOTE: ThreadContainer = { assistantPackage: "@cinatra-ai/wordpress-assistant", instanceId: "site-1" };

function thread(over: Partial<AssistantThread> = {}): AssistantThread {
  return {
    id: THREAD_ID,
    assistantUserId: null,
    ownerUserId: "user-1",
    orgId: "org-1",
    projectId: null,
    teamId: null,
    origin: "legacy-chat",
    title: "A thread",
    contextId: null,
    assistantPackage: null,
    instanceId: null,
    titleSlug: null,
    createdAt: "2026-08-10T09:00:00.000Z",
    updatedAt: "2026-08-10T09:00:00.000Z",
    ...over,
  };
}

/** The SELECT the primitive re-reads through when its UPDATE matches nothing. */
function selectReturns(row: Record<string, unknown> | null) {
  return [{ rows: row ? [row] : [], rowCount: row ? 1 : 0 }];
}

function rowOf(t: AssistantThread): Record<string, unknown> {
  return {
    id: t.id,
    assistant_user_id: t.assistantUserId,
    owner_user_id: t.ownerUserId,
    org_id: t.orgId,
    project_id: t.projectId,
    team_id: t.teamId,
    origin: t.origin,
    title: t.title,
    context_id: t.contextId,
    assistant_package: t.assistantPackage,
    instance_id: t.instanceId,
    title_slug: t.titleSlug,
    created_at: t.createdAt,
    updated_at: t.updatedAt,
  };
}

beforeEach(() => runPostgresQueriesSync.mockReset());

describe("isMalformedPartialBinding — the asymmetry is deliberate", () => {
  it("a package with NO instance is a VALID container, not a partial binding", () => {
    expect(isMalformedPartialBinding(thread({ assistantPackage: "@acme/a", instanceId: null }))).toBe(false);
    expect(isMalformedPartialBinding(thread({ assistantPackage: "@acme/a", instanceId: "" }))).toBe(false);
  });

  it("an INSTANCE with no package is malformed — that row is in no container at all", () => {
    expect(isMalformedPartialBinding(thread({ assistantPackage: null, instanceId: "site-1" }))).toBe(true);
    expect(isMalformedPartialBinding(thread({ assistantPackage: "", instanceId: "site-1" }))).toBe(true);
  });

  it("neither half set is UNBOUND, not malformed", () => {
    expect(isMalformedPartialBinding(thread())).toBe(false);
    expect(isMalformedPartialBinding(thread({ assistantPackage: "", instanceId: "" }))).toBe(false);
  });
});

describe("classifyThreadContainerBind — deterministic precedence", () => {
  it("an owned, genuinely unbound row is bindable (NULL and '' alike)", () => {
    expect(classifyThreadContainerBind(thread(), LOCAL, ACTOR)).toBe("bindable");
    expect(
      classifyThreadContainerBind(thread({ assistantPackage: "", instanceId: "" }), LOCAL, ACTOR),
    ).toBe("bindable");
  });

  // ELIGIBILITY IS DECIDED FIRST, deliberately: a caller who could never have
  // written this row is told exactly that, and is never handed a container
  // claim it has no standing to make.
  it("ELIGIBILITY outranks binding state — an admin observing ANOTHER owner's row in the SAME container is refused, never 'already-in-container'", () => {
    const foreign = thread({ ownerUserId: "user-2", assistantPackage: LOCAL.assistantPackage });
    expect(classifyThreadContainerBind(foreign, LOCAL, ACTOR)).toBe("refused-ineligible");
  });

  it("refuses a team-owned row, an ownerless row, another owner's row, and a foreign org — with NO platform-admin bypass anywhere", () => {
    expect(classifyThreadContainerBind(thread({ teamId: "team-1" }), LOCAL, ACTOR)).toBe("refused-ineligible");
    expect(classifyThreadContainerBind(thread({ ownerUserId: null }), LOCAL, ACTOR)).toBe("refused-ineligible");
    expect(classifyThreadContainerBind(thread({ ownerUserId: "user-2" }), LOCAL, ACTOR)).toBe("refused-ineligible");
    expect(classifyThreadContainerBind(thread({ orgId: "org-2" }), LOCAL, ACTOR)).toBe("refused-ineligible");
    expect(classifyThreadContainerBind(thread(), LOCAL, { userId: "", orgId: "org-1" })).toBe("refused-ineligible");
  });

  it("an ORGLESS row is bindable by any owner (the ambient-thread axis is nullable by design)", () => {
    expect(classifyThreadContainerBind(thread({ orgId: null }), LOCAL, ACTOR)).toBe("bindable");
    expect(classifyThreadContainerBind(thread({ orgId: "" }), LOCAL, ACTOR)).toBe("bindable");
  });

  it("a malformed partial binding is refused, never 'repaired' into a scope nobody authorized", () => {
    expect(
      classifyThreadContainerBind(thread({ instanceId: "site-9" }), LOCAL, ACTOR),
    ).toBe("refused-malformed-partial");
  });

  it("an identical container is already-in-container — including a CASE difference (rows predate the canonical-spelling rule)", () => {
    expect(
      classifyThreadContainerBind(thread({ assistantPackage: LOCAL.assistantPackage }), LOCAL, ACTOR),
    ).toBe("already-in-container");
    expect(
      classifyThreadContainerBind(thread({ assistantPackage: "@ACME/Helper-Assistant" }), LOCAL, ACTOR),
    ).toBe("already-in-container");
    expect(
      classifyThreadContainerBind(
        thread({ assistantPackage: REMOTE.assistantPackage, instanceId: REMOTE.instanceId }),
        REMOTE,
        ACTOR,
      ),
    ).toBe("already-in-container");
  });

  it("a DIFFERENT container is bound-elsewhere — never re-pointed", () => {
    expect(
      classifyThreadContainerBind(thread({ assistantPackage: "@other/pkg" }), LOCAL, ACTOR),
    ).toBe("bound-elsewhere");
  });

  it("the INSTANCE half distinguishes containers of the same package (an instance is opaque, matched exactly)", () => {
    const scoped = thread({ assistantPackage: REMOTE.assistantPackage, instanceId: "site-2" });
    expect(classifyThreadContainerBind(scoped, REMOTE, ACTOR)).toBe("bound-elsewhere");
    const unscoped = thread({ assistantPackage: REMOTE.assistantPackage, instanceId: null });
    expect(classifyThreadContainerBind(unscoped, REMOTE, ACTOR)).toBe("bound-elsewhere");
  });
});

describe("bindThreadContainerIfUnbound — one conditional SET-ONCE statement", () => {
  it("writes BOTH binding columns, normalizes the ''-slug, and re-asserts the WHOLE predicate in its own WHERE clause", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 1 }]);
    expect(bindThreadContainerIfUnbound(THREAD_ID, REMOTE, ACTOR)).toEqual({ kind: "bound" });

    const q = runPostgresQueriesSync.mock.calls[0]![0].queries[0];
    expect(q.text).toContain('UPDATE "app_test"."assistant_threads"');
    expect(q.text).toContain("SET assistant_package = $1");
    expect(q.text).toContain("instance_id = $2");
    expect(q.text).toContain("title_slug = NULLIF(title_slug, '')");
    // the set-once + ownership + org predicate, re-asserted so the write can
    // never outrun a concurrent ownership or binding change
    expect(q.text).toContain("COALESCE(assistant_package, '') = ''");
    expect(q.text).toContain("COALESCE(instance_id, '') = ''");
    expect(q.text).toContain("COALESCE(team_id, '') = ''");
    expect(q.text).toContain("owner_user_id = $4");
    expect(q.text).toContain("(COALESCE(org_id, '') = '' OR org_id = $5)");
    expect(q.values).toEqual([REMOTE.assistantPackage, "site-1", THREAD_ID, "user-1", "org-1"]);
  });

  it("NEVER bumps updated_at — recording a thread's home is not thread ACTIVITY, and updated_at orders the sidebar", () => {
    runPostgresQueriesSync.mockReturnValue([{ rows: [], rowCount: 1 }]);
    bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR);
    expect(runPostgresQueriesSync.mock.calls[0]![0].queries[0].text).not.toContain("updated_at");
  });

  it("refuses a non-UUID id, an actorless caller, and an empty package WITHOUT touching the database", () => {
    for (const call of [
      () => bindThreadContainerIfUnbound("not-a-uuid", LOCAL, ACTOR),
      () => bindThreadContainerIfUnbound(THREAD_ID, LOCAL, { userId: "", orgId: null }),
      () => bindThreadContainerIfUnbound(THREAD_ID, { assistantPackage: "", instanceId: null }, ACTOR),
    ]) {
      expect(call()).toEqual({ kind: "refused-ineligible" });
    }
    expect(runPostgresQueriesSync).not.toHaveBeenCalled();
  });

  it("a zero-row write is CLASSIFIED by a re-read, never reported as a bare failure", () => {
    // absent
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }])
      .mockReturnValueOnce(selectReturns(null));
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({ kind: "absent" });

    // ineligible (another owner) — the admin path
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }])
      .mockReturnValueOnce(selectReturns(rowOf(thread({ ownerUserId: "user-2" }))));
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({
      kind: "refused-ineligible",
    });

    // malformed partial
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }])
      .mockReturnValueOnce(selectReturns(rowOf(thread({ instanceId: "site-9" }))));
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({
      kind: "refused-malformed-partial",
    });

    // already home (an idempotent re-assert)
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }])
      .mockReturnValueOnce(selectReturns(rowOf(thread({ assistantPackage: LOCAL.assistantPackage }))));
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({
      kind: "already-in-container",
    });

    // bound elsewhere — reported WITH the container it actually lives in
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }])
      .mockReturnValueOnce(
        selectReturns(rowOf(thread({ assistantPackage: "@other/pkg", instanceId: "site-4" }))),
      );
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({
      kind: "bound-elsewhere",
      container: { assistantPackage: "@other/pkg", instanceId: "site-4" },
    });

    // eligible + unbound on re-read yet the write matched nothing ⇒ a concurrent
    // writer. Reported honestly rather than folded into a refusal it is not.
    runPostgresQueriesSync
      .mockReturnValueOnce([{ rows: [], rowCount: 0 }])
      .mockReturnValueOnce(selectReturns(rowOf(thread())));
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({ kind: "raced" });
  });

  it("a container slug collision refuses WITHOUT clearing or re-minting the slug — a minted slug is stable forever", () => {
    // `…Once`, so the throwing implementation cannot outlive the ONE statement
    // this primitive is allowed to attempt: a compensating second write would
    // fall through to the default mock and be visible in the call count below.
    runPostgresQueriesSync.mockImplementationOnce(() => {
      throw new Error(
        'duplicate key value violates unique constraint "assistant_threads_container_slug_uniq"',
      );
    });
    expect(bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toEqual({
      kind: "refused-slug-collision",
    });
    // exactly ONE statement was attempted, and it is the conditional UPDATE —
    // no compensating slug rewrite follows
    expect(runPostgresQueriesSync).toHaveBeenCalledTimes(1);
  });

  it("an UNEXPECTED database error is NOT swallowed as a refusal", () => {
    runPostgresQueriesSync.mockImplementationOnce(() => {
      throw new Error("connection terminated unexpectedly");
    });
    expect(() => bindThreadContainerIfUnbound(THREAD_ID, LOCAL, ACTOR)).toThrow(
      /connection terminated/,
    );
  });
});
