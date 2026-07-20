import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// cinatra#1881 (OPTION 1) — the REAL middleware + handler SEAM for the
// cookieless assistant run-stream RESUME.
//
// Before #1881 the middleware route guard 307'd a cookieless
// GET /api/assistants/runs/<runId>/stream to /sign-in, so the handler's MODE-2
// resume-token branch (#1221 / #1855) was UNREACHABLE for a public-site widget.
// OPTION 1 adds a NARROW UUID-shaped matcher to isPublicPath so the handler's
// OWN fail-closed auth becomes the gate — the same posture /api/assistants/chat
// already has.
//
// This suite drives BOTH seams together with the REAL guardAppRoute and the
// REAL route GET (stores mocked, but the REAL verifyWidgetChatResumeToken), so
// it proves end to end:
//   AC-1 ACCEPT  — middleware lets the cookieless path through AND a valid
//                  run-bound resume token → 200 replaying the run's frames.
//   AC-1 REJECT  — middleware still lets it through (the path is public) BUT the
//                  handler fail-closes 401 on an invalid / expired / foreign-run
//                  token — the handler, not the middleware, is the wall.
//   NARROWNESS   — a cookieless SIBLING assistants path is still 307'd by the
//                  middleware; the matcher does not leak to neighbors.
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
import { guardAppRoute } from "@/lib/auth-route-guard";
import { issueWidgetChatResumeToken } from "@/lib/widget-chat-resume-token";
import type { NextRequest } from "next/server";

// A representative v4 UUID — the shape randomUUID() mints for a runId
// (src/lib/assistant-runtime/ag-ui-stream-route.ts).
const RUN = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
const STREAM_PATH = `/api/assistants/runs/${RUN}/stream`;

// The middleware half: a minimal NextRequest with NO session cookie, so a
// PROTECTED path 307s → /sign-in and a PUBLIC path returns NextResponse.next().
function middlewareRequest(pathname: string): NextRequest {
  return {
    nextUrl: { pathname },
    url: `http://localhost${pathname}`,
    cookies: { get: () => undefined },
    headers: new Headers(),
  } as unknown as NextRequest;
}
function passedMiddleware(res: { status?: number; headers?: Headers }): boolean {
  const status = res.status ?? 200;
  const location = res.headers?.get?.("location") ?? null;
  return status !== 307 && location === null;
}

// The handler half: a real Request + route context for the same run.
function handlerCall(
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
  yield { id: "9-0", event: { type: "RUN_FINISHED", threadId: "th1", runId: RUN } };
}

function mintResume(runId: string): string {
  return issueWidgetChatResumeToken({
    userId: "u-widget",
    orgId: "org-widget",
    instanceId: "inst-canonical-uuid",
    kind: "wordpress",
    runId,
    jti: "run-nonce-seam",
  });
}

const BEFORE_AUTH_SECRET = process.env.BETTER_AUTH_SECRET;

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-seam";
});
afterAll(() => {
  if (BEFORE_AUTH_SECRET === undefined) delete process.env.BETTER_AUTH_SECRET;
  else process.env.BETTER_AUTH_SECRET = BEFORE_AUTH_SECRET;
});

beforeEach(() => {
  vi.clearAllMocks();
  // Cookieless broker path: no session.
  getAuthSession.mockResolvedValue(null);
  isPlatformAdmin.mockReturnValue(false);
  findAssistantTurnByRunId.mockReturnValue({ id: "turn-1", threadId: "th1", runId: RUN });
  getAssistantThread.mockReturnValue(null);
  loadChatThreadForActorAccess.mockReturnValue(null);
  subscribeToAgUiEventsWithId.mockImplementation(oneTerminalEvent);
});

describe("#1881 seam — AC-1 ACCEPT (cookieless middleware + valid resume token → 200)", () => {
  it("the middleware lets the cookieless stream path through AND the handler streams replayed frames", async () => {
    // 1) Middleware: the cookieless path is public (would have 307'd pre-#1881).
    const guard = await guardAppRoute(middlewareRequest(STREAM_PATH));
    expect(passedMiddleware(guard)).toBe(true);

    // 2) Handler: a valid RUN-BOUND resume token → 200 replaying the run's frames.
    const res = await GET(...handlerCall(RUN, { authHeader: `Bearer ${mintResume(RUN)}` }));
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("id: 9-0");
    expect(body).toContain('"type":"RUN_FINISHED"');
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      RUN,
      expect.objectContaining({ fromId: undefined }),
    );
  });

  it("carries the Last-Event-ID resume cursor through the accepted seam", async () => {
    expect(passedMiddleware(await guardAppRoute(middlewareRequest(STREAM_PATH)))).toBe(true);
    await (
      await GET(...handlerCall(RUN, { authHeader: `Bearer ${mintResume(RUN)}`, lastEventId: "42-7" }))
    ).text();
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith(
      RUN,
      expect.objectContaining({ fromId: "42-7" }),
    );
  });
});

describe("#1881 seam — AC-1 REJECT (middleware open, handler is the fail-closed wall)", () => {
  it("middleware still passes the path, but the handler 401s a foreign-run token (never streams)", async () => {
    expect(passedMiddleware(await guardAppRoute(middlewareRequest(STREAM_PATH)))).toBe(true);
    const foreign = mintResume("11111111-2222-3333-4444-555555555555");
    const res = await GET(...handlerCall(RUN, { authHeader: `Bearer ${foreign}` }));
    expect(res.status).toBe(401);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("handler 401s an EXPIRED resume token (TTL bound at verify)", async () => {
    expect(passedMiddleware(await guardAppRoute(middlewareRequest(STREAM_PATH)))).toBe(true);
    // Mint the token 1000 s in the past so its 600 s TTL is already spent.
    const realNow = Date.now();
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(realNow - 1_000_000);
    const expired = mintResume(RUN);
    nowSpy.mockRestore();
    const res = await GET(...handlerCall(RUN, { authHeader: `Bearer ${expired}` }));
    expect(res.status).toBe(401);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("handler 401s an invalid/garbage token and a sessionless caller with no token", async () => {
    expect(passedMiddleware(await guardAppRoute(middlewareRequest(STREAM_PATH)))).toBe(true);
    for (const authHeader of [undefined, "Bearer not-a-real-token", "Bearer cit_deadbeef"]) {
      const res = await GET(...handlerCall(RUN, authHeader ? { authHeader } : {}));
      expect(res.status).toBe(401);
    }
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });
});

describe("#1881 seam — NARROWNESS (a cookieless sibling stays 307'd by the middleware)", () => {
  it("a cookieless sibling assistants run sub-route is NOT public (matcher must end at /stream)", async () => {
    for (const p of [
      `/api/assistants/runs/${RUN}/cancel`,
      `/api/assistants/runs/${RUN}`,
      `/api/assistants/runs/${RUN}/stream/extra`,
      "/api/assistants/runs/not-a-uuid/stream",
      "/api/assistants/list",
    ]) {
      const guard = await guardAppRoute(middlewareRequest(p));
      expect(guard.status, `${p} must stay session-guarded`).toBe(307);
      expect(guard.headers.get("location")).toContain("/sign-in");
    }
  });
});
