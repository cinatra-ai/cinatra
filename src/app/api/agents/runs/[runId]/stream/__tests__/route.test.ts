import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthzError } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Route-handler regression test for the AG-UI SSE stream
// GET /api/agents/runs/[runId]/stream. Same runBy:null short-circuit as the
// poll route lived here; this test pins that the stream now authorizes via
// readAgentRunById(actor) BEFORE subscribing, and never opens the event
// subscription for a denied caller.
// ---------------------------------------------------------------------------

const requireAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const readAgentRunById = vi.fn();
const subscribeToAgUiEventsWithId = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
}));
vi.mock("@cinatra-ai/agent-ui-protocol/server", () => ({
  subscribeToAgUiEventsWithId: (...a: unknown[]) => subscribeToAgUiEventsWithId(...a),
}));

import { GET } from "../route";

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}
function sessionFor(userId: string | null, orgId: string | null) {
  return { user: { id: userId }, session: { activeOrganizationId: orgId } };
}
function streamReq(): Request {
  return new Request("https://app.test/api/agents/runs/run-1/stream");
}

describe("GET /api/agents/runs/[runId]/stream", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    // Default: an immediately-completing subscription (used by allow path).
    subscribeToAgUiEventsWithId.mockImplementation(async function* () {
      /* no events */
    });
  });
  afterEach(() => vi.clearAllMocks());

  it("401s when there is no authenticated user and never reads the run", async () => {
    requireAuthSession.mockResolvedValue(sessionFor(null, null));
    const res = await GET(streamReq(), ctx("run-1"));
    expect(res.status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  it("threads the actor + org/admin hints into readAgentRunById", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({ id: "run-1", status: "completed" });
    await GET(streamReq(), ctx("run-1"));
    const [runId, actor, roles] = readAgentRunById.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(actor).toMatchObject({ actorType: "human", userId: "user-self" });
    expect(roles).toMatchObject({ platformRole: "member", actorOrganizationId: "org-1" });
  });

  it("returns 403 on a forbidden AuthzError and NEVER subscribes to the stream", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-b", "org-b"));
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const res = await GET(streamReq(), ctx("run-1"));
    expect(res.status).toBe(403);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("returns 404 on a hidden AuthzError and NEVER subscribes to the stream", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-b", "org-b"));
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
    );

    const res = await GET(streamReq(), ctx("run-1"));
    expect(res.status).toBe(404);
    expect(subscribeToAgUiEventsWithId).not.toHaveBeenCalled();
  });

  it("opens the SSE stream once access is granted", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({ id: "run-1", status: "completed" });

    const res = await GET(streamReq(), ctx("run-1"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // Drain the stream so the subscription generator is entered and cleaned up.
    await res.body?.getReader().read();
    expect(subscribeToAgUiEventsWithId).toHaveBeenCalledWith("run-1", expect.anything());
  });
});
