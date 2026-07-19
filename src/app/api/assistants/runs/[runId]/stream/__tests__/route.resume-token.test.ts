import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Broker resume-token acceptance at the REAL resume seam
// (GET /api/assistants/runs/[runId]/stream) — S5 follow-up, cinatra#1221,
// OWNER RULING 2026-07-19 (option A). The stores are mocked (same harness as the
// session-auth test) but the token verifier is the REAL
// `verifyWidgetChatResumeToken`, so this proves, on the actual route:
//   - resume-ACCEPT: no session + a valid RUN-BOUND resume token → 200 stream
//   - chat-token-REJECT: the chat-audience broker (cit_/cwu_) token, and an
//     mcp-obo token, are REJECTED (401) — never a silent fresh mount
//   - cross-run / missing / expired token → 401 (explicit refusal)
//   - the session mode is byte-unchanged and takes precedence
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
import { issueWidgetChatResumeToken } from "@/lib/widget-chat-resume-token";
import { issueWidgetMcpActorToken } from "@/lib/widget-mcp-actor-token";

// The mcp-obo token mint reads the MCP credentials; stub them so the cross-type
// reject fixture can be minted.
vi.mock("@cinatra-ai/mcp-server/credentials", () => ({
  getLocalMcpServerUrl: (path: string) => `http://localhost:3000${path}`,
  getPublicMcpServerUrl: () => "https://cinatra-test.example/api/mcp",
}));

const RUN = "run-broker-xyz";

function req(
  runId: string,
  opts: { authHeader?: string; lastEventId?: string } = {},
): [Request, { params: Promise<{ runId: string }> }] {
  const headers: Record<string, string> = {};
  if (opts.authHeader) headers["authorization"] = opts.authHeader;
  if (opts.lastEventId) headers["last-event-id"] = opts.lastEventId;
  return [
    new Request(`https://app.test/api/assistants/runs/${runId}/stream`, { headers }),
    { params: Promise.resolve({ runId }) },
  ];
}

async function* oneTerminalEvent() {
  yield { id: "7-0", event: { type: "RUN_FINISHED", threadId: "th1", runId: RUN } };
}

function mintResume(runId: string): string {
  return issueWidgetChatResumeToken({
    userId: "u-widget",
    orgId: "org-widget",
    instanceId: "inst-canonical-uuid",
    kind: "wordpress",
    runId,
    jti: "run-nonce-1",
  });
}

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-resume-seam";
});
afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Default: NO session (the broker path).
  getAuthSession.mockResolvedValue(null);
  isPlatformAdmin.mockReturnValue(false);
  findAssistantTurnByRunId.mockReturnValue({ id: "turn-1", threadId: "th1", runId: RUN });
  getAssistantThread.mockReturnValue(null);
  loadChatThreadForActorAccess.mockReturnValue(null);
  subscribeToAgUiEventsWithId.mockImplementation(oneTerminalEvent);
});

describe("resume seam — broker resume-token ACCEPT", () => {
  it("streams for a sessionless caller presenting a valid RUN-BOUND resume token", async () => {
    const res = await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("id: 7-0");
    expect(body).toContain('"type":"RUN_FINISHED"');
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      RUN,
      expect.objectContaining({ fromId: undefined }),
    );
  });

  it("honors the Last-Event-ID resume cursor on the broker path", async () => {
    await (
      await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}`, lastEventId: "42-7" }))
    ).text();
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      RUN,
      expect.objectContaining({ fromId: "42-7" }),
    );
  });

  it("404s (existence not disclosed) when the accepted token's run has no turn row", async () => {
    findAssistantTurnByRunId.mockReturnValue(null);
    const res = await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }));
    expect(res.status).toBe(404);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });
});

describe("resume seam — chat-token / cross-type REJECT (option A, not B)", () => {
  it("401s the OPAQUE chat broker cit_/cwu_ token — never accepted at resume", async () => {
    for (const tok of ["cit_deadbeefdeadbeef", "cwu_cafebabecafebabe"]) {
      const res = await GET(...req(RUN, { authHeader: `Bearer ${tok}` }));
      expect(res.status).toBe(401);
    }
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("401s an mcp-obo widget token presented at the resume seam (cross-type)", async () => {
    const mcp = issueWidgetMcpActorToken({
      userId: "u-widget",
      orgId: "org-widget",
      instanceId: "inst-canonical-uuid",
      kind: "wordpress",
      jti: "turn-nonce",
    });
    const res = await GET(...req(RUN, { authHeader: `Bearer ${mcp}` }));
    expect(res.status).toBe(401);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });
});

describe("resume seam — run-binding + missing credential REJECT", () => {
  it("401s a resume token minted for a DIFFERENT run (cross-run replay)", async () => {
    const otherRunToken = mintResume("some-other-run");
    const res = await GET(...req(RUN, { authHeader: `Bearer ${otherRunToken}` }));
    expect(res.status).toBe(401);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("401s a sessionless caller with NO Authorization header (no silent fresh mount)", async () => {
    const res = await GET(...req(RUN));
    expect(res.status).toBe(401);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });
});

describe("resume seam — session mode unchanged + precedence", () => {
  it("still authorizes the in-app session owner (byte-unchanged path)", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    loadChatThreadForActorAccess.mockReturnValue({
      payload: {},
      ownerUserId: "user-1",
      teamId: null,
      isActorTeamMember: false,
    });
    const res = await GET(...req(RUN));
    expect(res.status).toBe(200);
  });

  it("takes the SESSION path when a session exists even if an Authorization header rides along", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" }, session: {} });
    loadChatThreadForActorAccess.mockReturnValue({
      payload: {},
      ownerUserId: "user-1",
      teamId: null,
      isActorTeamMember: false,
    });
    // A garbage/cross-run token present, but the session decides — 200 via session.
    const res = await GET(...req(RUN, { authHeader: "Bearer cit_ignored" }));
    expect(res.status).toBe(200);
  });
});
