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
const isWidgetBrokerSessionLive = vi.fn();
// cinatra#2575 (epic #2564 S8b) — the resume seam now re-probes the widget
// session LIVE (no standalone-token trust). These suites are about the token and
// the transport, so the probe is doubled here; its own refusals are proven in
// `src/lib/__tests__/widget-broker-liveness.test.ts` and the WITHDRAWN case is
// exercised below.
vi.mock("@/lib/widget-broker-liveness", () => ({
  isWidgetBrokerSessionLive: (...args: unknown[]) => isWidgetBrokerSessionLive(...args),
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
    widgetJti: "cwu-jti-2575",
    siteId: "site-2575",
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
  isWidgetBrokerSessionLive.mockResolvedValue(true);
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

  it("probes the LIVE session it names, not just its own signature (cinatra#2575)", async () => {
    await (await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }))).text();
    expect(isWidgetBrokerSessionLive).toHaveBeenCalledWith({
      widgetJti: "cwu-jti-2575",
      siteId: "site-2575",
      userId: "u-widget",
      orgId: "org-widget",
      instanceId: "inst-canonical-uuid",
    });
  });
});

// ---------------------------------------------------------------------------
// cinatra#2575 (epic #2564 S8b) AC-4 — resume after a WITHDRAWAL fails closed.
//
// The token is still validly signed, still bound to this run and still inside
// its ten minutes. Before this slice that was the whole authorization, so a
// person signed out mid-run, a suspended site, a revoked or re-keyed connection
// and a removed membership all kept streaming until the signature aged out.
// The probe answers all four; here we assert the SEAM honours it, and that the
// refusal is byte-identical to a bad token so a resumer learns nothing.
// ---------------------------------------------------------------------------
describe("resume seam — a WITHDRAWN session fails closed (cinatra#2575 AC-4)", () => {
  it("401s a perfectly valid token whose widget session is no longer live", async () => {
    isWidgetBrokerSessionLive.mockResolvedValue(false);
    const res = await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }));
    expect(res.status).toBe(401);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("...and answers IDENTICALLY to a forged token — no oracle for which it was", async () => {
    isWidgetBrokerSessionLive.mockResolvedValue(false);
    const withdrawn = await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }));
    const forged = await GET(...req(RUN, { authHeader: "Bearer cwu_cafebabecafebabe" }));
    expect(withdrawn.status).toBe(forged.status);
    expect(await withdrawn.text()).toBe(await forged.text());
  });

  it("the run's turn row is never even looked up for a withdrawn session", async () => {
    isWidgetBrokerSessionLive.mockResolvedValue(false);
    findAssistantTurnByRunId.mockClear();
    await GET(...req(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }));
    expect(findAssistantTurnByRunId).not.toHaveBeenCalled();
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
