// ---------------------------------------------------------------------------
// THE WIDGET'S THREAD WRITE (cinatra#2683, epic #2564 S8f item 1, write half).
// ---------------------------------------------------------------------------
// The read half restores a widget's transcript after a reload. It restored
// NOTHING, because nothing had ever been written: a turn's own durable rows
// carry a `run_id`, and the payload reconstruction reads only the legacy-mirror
// rows (`id LIKE 'legacy:%' AND run_id IS NULL`) that the thread upsert writes.
// `/chat` writes them on every turn through a cookie-bound writer; the widget
// could not, because the embed frame is same-origin to the Cinatra app and a
// cookie request from it is answered as whoever else is signed in on that
// browser.
//
// WHAT THIS FILE MEASURES, and it is deliberately the pair:
//
//   · what the WRITE refuses — the org wall, the ownership rule, the floored
//     platform standing, the body that cannot spoof its own owner;
//   · that a first-party thread is UNTOUCHED by the widget writer;
//   · that the RECONSTRUCTION then assembles what the widget wrote, through the
//     same rows the first-party writer produces — the property that makes the
//     read work unchanged.
//
// The grant side (a write refused without `conversation.write`) is next door in
// `widget-conversation-branch.test.ts`, where the door is real; here the door is
// already past and what is under test is the handler behind it.
import { beforeEach, describe, expect, it, vi } from "vitest";

const getAssistantThread = vi.fn();
const reconstructThreadPayload = vi.fn();
const upsertChatThreadInDatabase = vi.fn();
const getAuthSession = vi.fn();

vi.mock("@/lib/assistant-thread-store", () => ({
  getAssistantThread: (...a: unknown[]) => getAssistantThread(...a),
  reconstructThreadPayload: (...a: unknown[]) => reconstructThreadPayload(...a),
  listAssistantThreadIdsWithDurableContent: () => [],
  listAssistantThreadSummariesForOwnerInOrg: () => [],
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: () => ({
    ownerUserId: "widget-user",
    teamId: null,
    isActorTeamMember: false,
  }),
  isActorTeamMemberForChat: () => false,
  readChatThreadOwnershipById: () => null,
}));
vi.mock("@/lib/chat-thread-access", () => ({ evaluateChatThreadAccess: () => true }));
vi.mock("@/lib/database", () => ({
  upsertChatThreadInDatabase: (...a: unknown[]) => upsertChatThreadInDatabase(...a),
}));
vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: () => true, // deliberately TRUE: the widget path must ignore it
}));

const PRINCIPAL = { userId: "widget-user", orgId: "org-A" };

const post = (body: unknown) =>
  new Request("https://app.test/api/assistants/threads", {
    method: "POST",
    body: JSON.stringify(body),
  });

const TRANSCRIPT = {
  id: "t-widget",
  title: "Rewrite the title",
  messages: [
    { id: "m1", role: "user", content: "rewrite the title" },
    { id: "m2", role: "assistant", content: "Done." },
  ],
  createdAt: "2026-08-12T10:00:00.000Z",
  updatedAt: "2026-08-12T10:00:05.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  getAssistantThread.mockReturnValue(null); // default: no row — refused
  reconstructThreadPayload.mockReturnValue(null); // default: nothing persisted yet
  getAuthSession.mockResolvedValue({
    user: { id: "somebody-else" },
    session: { activeOrganizationId: "org-Z" },
  });
});

/** The row a widget's own turn already bound: personal, this caller's, this org. */
const OWN_ROW = {
  id: "t-widget",
  orgId: "org-A",
  ownerUserId: "widget-user",
  teamId: null,
};

describe("the widget thread write — what it accepts", () => {
  it("KEEPS the caller's own thread, anchored to the TOKEN's org", async () => {
    getAssistantThread.mockReturnValue(OWN_ROW);
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    const res = await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
    expect(res.status).toBe(200);
    const [thread, options] = upsertChatThreadInDatabase.mock.calls[0];
    expect(thread.id).toBe("t-widget");
    expect(thread.messages).toHaveLength(2);
    // The owner is the widget principal, never the body and never a session.
    expect(thread.ownerUserId).toBe("widget-user");
    // BOTH orgs are the token's: the pin-sync scope and the set-once mirror
    // anchor the READ's org wall later compares against.
    // ...and the TOKEN's principal is the acting writer (cinatra#2823 S9j): the
    // truncation tombstone authorizes against it, and the write above already
    // proved this thread is personally owned BY that principal.
    expect(options).toEqual({
      orgId: "org-A",
      assistantMirrorOrgId: "org-A",
      actorUserId: "widget-user",
    });
  });

  it("NEVER reads a session — there is no ambient fallback to fall back TO", async () => {
    getAssistantThread.mockReturnValue(OWN_ROW);
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
    // A cookie for a DIFFERENT person in a DIFFERENT org is mocked as present
    // and is not consulted, so the write cannot be answered as them.
    expect(getAuthSession).not.toHaveBeenCalled();
    expect(upsertChatThreadInDatabase.mock.calls[0][0].ownerUserId).toBe("widget-user");
  });

  // codex round 1 — OMISSION IS A MUTATION. The mirror writes `project_id` and
  // `scalars` WHOLESALE, so a body that merely omitted them would NULL the
  // thread's project and erase its `/chat` render state on every widget turn.
  // They are carried forward FROM THE PERSISTED ROW — which also means the
  // caller can neither set them nor clear them.
  it("CARRIES FORWARD the project scope and the /chat render state it does not own", async () => {
    getAssistantThread.mockReturnValue({ ...OWN_ROW, projectId: "proj-real" });
    reconstructThreadPayload.mockReturnValue({
      id: "t-widget",
      messages: [],
      taggedAssistantUserIds: ["assistant-7"],
      slackMode: true,
      projectId: "proj-real",
    });
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    await handleSaveAssistantThreadForWidget(
      // The body TRIES to move the project and clear the render state; neither
      // value is read from it.
      post({ ...TRANSCRIPT, projectId: "proj-attacker", taggedAssistantUserIds: [], slackMode: false }),
      PRINCIPAL,
    );
    const [thread] = upsertChatThreadInDatabase.mock.calls[0];
    expect(thread.projectId).toBe("proj-real");
    expect(thread.taggedAssistantUserIds).toEqual(["assistant-7"]);
    expect(thread.slackMode).toBe(true);
  });

  // codex round 0, LOW — a strip-list left every OTHER server-decided column the
  // mirror reads writable from a public website, and each new column would have
  // silently joined them. The body is an ALLOW-LIST, and this is what it means.
  it("carries ONLY the transcript fields — every server-decided column is dropped", async () => {
    getAssistantThread.mockReturnValue(OWN_ROW);
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    await handleSaveAssistantThreadForWidget(
      post({
        ...TRANSCRIPT,
        activeAssistantHandle: "wordpress",
        ownerUserId: "victim",
        teamId: "team-9",
        projectId: "proj-someone-elses",
        contextId: "ctx-9",
        instanceId: "inst-9",
        assistantPackage: "pkg-9",
        titleSlug: "claimed-slug",
        orgId: "org-Z",
      }),
      PRINCIPAL,
    );
    const [thread] = upsertChatThreadInDatabase.mock.calls[0];
    expect(Object.keys(thread).sort()).toEqual(
      ["activeAssistantHandle", "createdAt", "id", "messages", "ownerUserId", "title", "updatedAt"].sort(),
    );
    expect(thread.ownerUserId).toBe("widget-user");
  });
});

describe("the widget thread write — what it refuses", () => {
  it("REFUSES a thread anchored in another org, even one this person owns", async () => {
    getAssistantThread.mockReturnValue({
      id: "t-widget",
      orgId: "org-B",
      ownerUserId: "widget-user",
      teamId: null,
    });
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    const res = await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
    expect(res.status).toBe(404);
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("REFUSES somebody else's thread in the SAME org", async () => {
    getAssistantThread.mockReturnValue({
      id: "t-widget",
      orgId: "org-A",
      ownerUserId: "another-person",
      teamId: null,
    });
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    expect((await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL)).status).toBe(
      404,
    );
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("REFUSES a TEAM-owned thread and a legacy UNOWNED one — the narrowing direction", async () => {
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    // Team-owned: mirrors with a NULL org anchor by policy, so it is not
    // READABLE through a widget; it is not writable either.
    getAssistantThread.mockReturnValue({
      id: "t-widget",
      orgId: "org-A",
      ownerUserId: null,
      teamId: "team-1",
    });
    expect((await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL)).status).toBe(
      404,
    );
    // Legacy unowned: PUBLIC to read. Letting a widget append to one would put
    // text a site-embedded surface produced into a conversation anybody reads.
    getAssistantThread.mockReturnValue({
      id: "t-widget",
      orgId: "org-A",
      ownerUserId: null,
      teamId: null,
    });
    expect((await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL)).status).toBe(
      404,
    );
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  // codex round 0, MEDIUM 4 — a row carrying a TEAM is team-owned even when an
  // owner axis is also set. Nothing enforces the two axes are exclusive, so
  // "owner matches" alone was not "personal". This is codex's planted case.
  it("REFUSES a row that carries a team EVEN WHEN the owner is this caller", async () => {
    getAssistantThread.mockReturnValue({ ...OWN_ROW, teamId: "team-1" });
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    expect((await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL)).status).toBe(
      404,
    );
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  // codex round 0, MEDIUM 2 — THE ORACLE, closed. The first draft CREATED on an
  // absent row, so 404 meant "taken by someone else" and 200 meant "free, and
  // now yours": a clean existence probe for other people's thread ids, using
  // nothing but a valid widget credential. It cannot create any more.
  it("REFUSES an id with no row at all — identically to a forbidden one", async () => {
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    getAssistantThread.mockReturnValue(null);
    const absent = await handleSaveAssistantThreadForWidget(
      post({ ...TRANSCRIPT, id: "an-id-nobody-has" }),
      PRINCIPAL,
    );
    getAssistantThread.mockReturnValue({ ...OWN_ROW, ownerUserId: "another-person" });
    const forbidden = await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
    expect(absent.status).toBe(forbidden.status);
    expect(await absent.json()).toEqual(await forbidden.json());
    expect(absent.status).toBe(404);
    // Nothing was created, so a probe cannot claim an id either.
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("every refusal is the SAME 404 the read gives — not an existence oracle", async () => {
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    const statuses: number[] = [];
    for (const row of [
      null, // absent — the case that used to answer 200
      { id: "t", orgId: "org-B", ownerUserId: "widget-user", teamId: null },
      { id: "t", orgId: "org-A", ownerUserId: "another-person", teamId: null },
      { id: "t", orgId: "org-A", ownerUserId: null, teamId: "team-1" },
      { id: "t", orgId: "org-A", ownerUserId: "widget-user", teamId: "team-1" },
    ]) {
      getAssistantThread.mockReturnValue(row);
      const res = await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
      statuses.push(res.status);
      expect(await res.json()).toEqual({ error: "Not found" });
    }
    expect(statuses).toEqual([404, 404, 404, 404, 404]);
  });

  it("PLATFORM STANDING IS FLOORED — `isPlatformAdmin` is mocked TRUE and buys nothing", async () => {
    // The first-party writer lets a platform admin overwrite anyone's thread.
    // This one has no admin branch at all: the same row, the same mocked
    // admin-true environment, refused.
    getAssistantThread.mockReturnValue({
      id: "t-widget",
      orgId: "org-A",
      ownerUserId: "another-person",
      teamId: null,
    });
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    expect((await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL)).status).toBe(
      404,
    );
  });

  it("refuses an incomplete principal and a body with no id", async () => {
    getAssistantThread.mockReturnValue(OWN_ROW);
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    expect(
      (await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), { userId: "", orgId: "org-A" }))
        .status,
    ).toBe(404);
    expect(
      (await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), { userId: "u", orgId: "" }))
        .status,
    ).toBe(404);
    expect((await handleSaveAssistantThreadForWidget(post({ title: "no id" }), PRINCIPAL)).status).toBe(
      400,
    );
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// A FIRST-PARTY THREAD IS UNTOUCHED BY THE WIDGET WRITER.
// ---------------------------------------------------------------------------
// The negative control that matters to somebody who has never opened a widget:
// their `/chat` thread cannot be written by one. Both axes are tried — the org
// wall and the ownership rule — and the persistence layer is never reached.
describe("a first-party thread is untouched by the widget writer", () => {
  it("neither a cross-org nor a same-org first-party thread is written", async () => {
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    for (const row of [
      { id: "chat-thread", orgId: "org-Z", ownerUserId: "chat-person", teamId: null },
      { id: "chat-thread", orgId: "org-A", ownerUserId: "chat-person", teamId: null },
    ]) {
      getAssistantThread.mockReturnValue(row);
      const res = await handleSaveAssistantThreadForWidget(
        post({ ...TRANSCRIPT, id: "chat-thread" }),
        PRINCIPAL,
      );
      expect(res.status).toBe(404);
    }
    expect(upsertChatThreadInDatabase).not.toHaveBeenCalled();
  });

  it("POSITIVE CONTROL: the SAME transcript into the caller's OWN thread does write", async () => {
    // So the refusals above are attributable to the row, not to a writer that
    // never writes anything.
    getAssistantThread.mockReturnValue({
      id: "t-widget",
      orgId: "org-A",
      ownerUserId: "widget-user",
      teamId: null,
    });
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    expect((await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL)).status).toBe(
      200,
    );
    expect(upsertChatThreadInDatabase).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// THE READ THEN WORKS UNCHANGED.
// ---------------------------------------------------------------------------
// The point of the write half: it produces rows the EXISTING reconstruction
// assembles. Nothing about the read was changed to accommodate it, so this is
// asserted end to end through the two shipped functions — the widget writes,
// and the widget read (same org, same person) answers with what was written.
describe("the reconstruct assembles widget-written turns", () => {
  it("what the widget wrote is what the widget read answers with", async () => {
    const {
      handleSaveAssistantThreadForWidget,
      handleGetAssistantThreadByIdForWidget,
    } = await import("@/lib/assistant-thread-http");

    // 1. The widget writes, onto the row its own TURN already bound.
    //    Persistence is captured rather than executed, so what the
    //    reconstruction is asked to return is exactly what the writer handed
    //    the store — no fixture invented in between.
    getAssistantThread.mockReturnValue(OWN_ROW);
    await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
    const [written] = upsertChatThreadInDatabase.mock.calls[0];
    reconstructThreadPayload.mockReturnValue({
      id: written.id,
      title: written.title,
      messages: written.messages,
    });

    // 2. The widget reads, org-walled to the anchor the write set.
    getAssistantThread.mockReturnValue({ id: "t-widget", orgId: "org-A" });
    const res = await handleGetAssistantThreadByIdForWidget("t-widget", PRINCIPAL);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      id: "t-widget",
      title: "Rewrite the title",
      messages: TRANSCRIPT.messages,
    });
    expect(reconstructThreadPayload).toHaveBeenCalledWith("t-widget");
  });

  // codex round 0 ("test claims not proved") — the assertion above mocks BOTH
  // ends, so it proves the handler's plumbing and NOT that the rows the write
  // produces are the rows the read's SELECT matches. That is the real claim, so
  // it is checked against the REAL mirror builder: the same object the handler
  // hands the store, through the same query construction the store uses.
  it("the rows the write produces are exactly the ones the reconstruction SELECTs", async () => {
    const { handleSaveAssistantThreadForWidget } = await import("@/lib/assistant-thread-http");
    const { extractAssistantTurnMirrorRowsFromThread, LEGACY_MIRROR_TURN_ID_PREFIX } =
      await import("@/lib/project-inheritance");
    const { RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX } = await vi.importActual<
      typeof import("@/lib/assistant-thread-store")
    >("@/lib/assistant-thread-store");

    getAssistantThread.mockReturnValue(OWN_ROW);
    await handleSaveAssistantThreadForWidget(post(TRANSCRIPT), PRINCIPAL);
    const [written] = upsertChatThreadInDatabase.mock.calls[0];

    const rows = extractAssistantTurnMirrorRowsFromThread(written);
    expect(rows).toHaveLength(TRANSCRIPT.messages.length);
    for (const row of rows) {
      // The reconstruction's WHERE is `run_id IS NULL AND id LIKE 'legacy:%'
      // AND content IS NOT NULL`. Each clause, against a row this write makes.
      expect(row.id.startsWith(LEGACY_MIRROR_TURN_ID_PREFIX)).toBe(true);
      expect(row.content).not.toBeNull();
      // The mirror never fabricates a `run_id` — it has no field for one — which
      // is precisely why `run_id IS NULL` selects these and not a turn's own
      // durable rows.
      expect(row).not.toHaveProperty("runId");
    }
    // ...and the INSERT the store issues for them names no run_id column either.
    const { buildAssistantTurnMirrorReconcileQueries } = await import(
      "@/lib/project-inheritance"
    );
    const sql = buildAssistantTurnMirrorReconcileQueries({
      schemaName: "public",
      threadId: written.id,
      turns: rows,
    })
      .map((q) => q.text)
      .join("\n");
    // The INSERT names `run_id` and writes it as the literal NULL — never a
    // fabricated run — which is exactly what `run_id IS NULL` selects.
    expect(sql).toMatch(/\(id, thread_id, run_id,/);
    expect(sql).toMatch(/SELECT t\.id, \$1, NULL,/);
    // ...and the reconcile DELETE is scoped to the mirror namespace, so this
    // write can never remove a turn's own runtime-minted row.
    expect(sql).toContain(LEGACY_MIRROR_TURN_ID_PREFIX);
    // The two prefixes are the same string on both sides of the seam — the
    // writer's namespace and the reader's filter cannot drift apart.
    expect(LEGACY_MIRROR_TURN_ID_PREFIX).toBe(RESERVED_LEGACY_MIRROR_TURN_ID_PREFIX);
  });

  it("NEGATIVE CONTROL: a thread with no reconstructable turns still 404s", async () => {
    // The write is what makes the read answer. With nothing reconstructable —
    // the state EVERY widget thread was in before this half existed — the read
    // is a 404 and the panel opens blank, which is the defect, reproduced.
    const { handleGetAssistantThreadByIdForWidget } = await import(
      "@/lib/assistant-thread-http"
    );
    getAssistantThread.mockReturnValue({ id: "t-widget", orgId: "org-A" });
    reconstructThreadPayload.mockReturnValue(null);
    expect((await handleGetAssistantThreadByIdForWidget("t-widget", PRINCIPAL)).status).toBe(404);
  });
});
