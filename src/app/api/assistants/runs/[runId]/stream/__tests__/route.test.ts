import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Authorization tests for GET /api/assistants/runs/[runId]/stream
// (cinatra#1218): run_id → assistant_turns → thread, then the SAME access
// policy as the legacy thread read (owner / team / admin; legacy unowned rows
// public), with the structured row as the pre-save fallback. Denials are 404
// (existence not disclosed). Last-Event-ID cursors pass through validated.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const findAssistantTurnByRunId = vi.fn();
const getAssistantThread = vi.fn();
const loadChatThreadForActorAccess = vi.fn();
const subscribeToAgUiEventsWithId = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@/lib/assistant-thread-store", () => ({
  findAssistantTurnByRunId: (id: string) => findAssistantTurnByRunId(id),
  getAssistantThread: (id: string) => getAssistantThread(id),
}));
vi.mock("@/lib/chat-thread-store", () => ({
  loadChatThreadForActorAccess: (i: unknown) => loadChatThreadForActorAccess(i),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: (runId: string, opts: unknown) =>
    subscribeToAgUiEventsWithId(runId, opts),
}));

import { GET } from "../route";

function req(runId: string, lastEventId?: string): [Request, { params: Promise<{ runId: string }> }] {
  return [
    new Request(`https://app.test/api/assistants/runs/${runId}/stream`, {
      headers: lastEventId ? { "last-event-id": lastEventId } : {},
    }),
    { params: Promise.resolve({ runId }) },
  ];
}

async function* oneTerminalEvent() {
  yield {
    id: "7-0",
    event: { type: "RUN_FINISHED", threadId: "th1", runId: "r1" },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
  isPlatformAdmin.mockReturnValue(false);
  findAssistantTurnByRunId.mockReturnValue({ id: "turn-1", threadId: "th1", runId: "r1" });
  loadChatThreadForActorAccess.mockReturnValue({
    payload: {},
    ownerUserId: "user-1",
    teamId: null,
    isActorTeamMember: false,
  });
  getAssistantThread.mockReturnValue(null);
  subscribeToAgUiEventsWithId.mockImplementation(oneTerminalEvent);
});

describe("GET /api/assistants/runs/[runId]/stream", () => {
  it("401s an unauthenticated caller", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await GET(...req("r1"));
    expect(res.status).toBe(401);
  });

  it("404s an unknown runId", async () => {
    findAssistantTurnByRunId.mockReturnValue(null);
    const res = await GET(...req("r-unknown"));
    expect(res.status).toBe(404);
  });

  it("404s (not 403) a cross-user personal thread — existence not disclosed", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: {},
      ownerUserId: "someone-else",
      teamId: null,
      isActorTeamMember: false,
    });
    const res = await GET(...req("r1"));
    expect(res.status).toBe(404);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("allows a team member on a team thread", async () => {
    loadChatThreadForActorAccess.mockReturnValue({
      payload: {},
      ownerUserId: null,
      teamId: "team-9",
      isActorTeamMember: true,
    });
    const res = await GET(...req("r1"));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("id: 7-0");
    expect(body).toContain('"type":"RUN_FINISHED"');
  });

  it("falls back to the structured row when no legacy row exists (pre-save reconnect)", async () => {
    loadChatThreadForActorAccess.mockReturnValue(null);
    getAssistantThread.mockReturnValue({ id: "th1", ownerUserId: "user-1", orgId: null });
    const res = await GET(...req("r1"));
    expect(res.status).toBe(200);
  });

  it("404s the structured-row fallback for a non-owner", async () => {
    loadChatThreadForActorAccess.mockReturnValue(null);
    getAssistantThread.mockReturnValue({ id: "th1", ownerUserId: "someone-else", orgId: null });
    const res = await GET(...req("r1"));
    expect(res.status).toBe(404);
  });

  it("passes a VALID Last-Event-ID through as the resume cursor and drops junk", async () => {
    await (await GET(...req("r1", "42-7"))).text();
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ fromId: "42-7" }),
    );
    vi.clearAllMocks();
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    findAssistantTurnByRunId.mockReturnValue({ id: "turn-1", threadId: "th1", runId: "r1" });
    loadChatThreadForActorAccess.mockReturnValue({
      payload: {},
      ownerUserId: "user-1",
      teamId: null,
      isActorTeamMember: false,
    });
    subscribeToAgUiEventsWithId.mockImplementation(oneTerminalEvent);
    await (await GET(...req("r1", "not-a-cursor"))).text();
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      "r1",
      expect.objectContaining({ fromId: undefined }),
    );
  });
});
