import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthzError } from "@/lib/authz";

// ---------------------------------------------------------------------------
// Route-handler regression test for GET /api/agents/runs/[runId].
// The previous hand-rolled guard SHORT-CIRCUITED TO ALLOW for unowned
// (runBy: null) runs and never invoked enforceRunAccess. This test pins the fix:
// the route threads a real actor (+ org/admin role hints) into readAgentRunById
// so enforceRunAccess runs, and it maps the resulting AuthzError to 404/403.
// The kernel decision itself is unit-tested in the agents package; here we prove
// the wiring + that a denied caller never has run messages read/returned.
// ---------------------------------------------------------------------------

const requireAuthSession = vi.fn();
const isPlatformAdmin = vi.fn();
const readAgentRunById = vi.fn();
const readAgentRunMessages = vi.fn();
const readAgentTemplateById = vi.fn();
const deriveRunHitlContext = vi.fn();
const readRunReviewSlot = vi.fn(
  async (runId: string): Promise<{ reviewTaskId: string | null; awaiting: boolean }> => {
    void runId;
    return { reviewTaskId: null, awaiting: false };
  },
);

vi.mock("@/lib/auth-session", () => ({
  requireAuthSession: () => requireAuthSession(),
  isPlatformAdmin: (s: unknown) => isPlatformAdmin(s),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentRunById: (...a: unknown[]) => readAgentRunById(...a),
  readAgentRunMessages: (...a: unknown[]) => readAgentRunMessages(...a),
  readAgentTemplateById: (...a: unknown[]) => readAgentTemplateById(...a),
  deriveRunHitlContext: (...a: unknown[]) => deriveRunHitlContext(...a),
}));

// cinatra#2997 — the run's own review slot travels on this seed. The reader is
// a plain run-scoped DB read behind this route's door; these suites are about
// the route's answer, so it is stubbed to "no review" unless a case says
// otherwise, and the ref minting is stubbed with it (a ref needs the instance
// secret, which no unit tree holds).
vi.mock("@cinatra-ai/agents/artifact-review-gate-store", () => ({
  readRunReviewSlot: (runId: string) => readRunReviewSlot(runId),
}));
vi.mock("@/lib/lifecycle/lifecycle-card-ref", () => ({
  encodeLifecycleGateRef: (p: { runId: string; reviewTaskId: string }) =>
    `ref:${p.runId}:${p.reviewTaskId}`,
}));

import { GET } from "../route";

function ctx(runId: string) {
  return { params: Promise.resolve({ runId }) };
}
function sessionFor(userId: string | null, orgId: string | null) {
  return { user: { id: userId }, session: { activeOrganizationId: orgId } };
}

describe("GET /api/agents/runs/[runId]", () => {
  beforeEach(() => {
    isPlatformAdmin.mockReturnValue(false);
    readAgentRunMessages.mockResolvedValue([]);
    readAgentTemplateById.mockResolvedValue(null);
    deriveRunHitlContext.mockResolvedValue(null);
  });
  afterEach(() => vi.clearAllMocks());

  it("401s when there is no authenticated user", async () => {
    requireAuthSession.mockResolvedValue(sessionFor(null, null));
    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(401);
    expect(readAgentRunById).not.toHaveBeenCalled();
  });

  // -----------------------------------------------------------------------
  // cinatra#2902 convergence F2 — the UNAUTHENTICATED first-party poll.
  //
  // The guard admits GET on this path cookieless (for the widget's sake), so a
  // first-party poll with no cookie and no widget header now reaches the handler
  // and `requireAuthSession()` is what refuses it. It refuses by calling Next's
  // `redirect()`, which does NOT return — it throws a control-flow signal tagged
  // with a `NEXT_REDIRECT` digest. The handler's generic error arm caught that
  // signal and answered 500 with `err.message` as the body, so the ordinary
  // signed-out case read as a server fault AND put the framework's internal
  // token on the wire. These rows pin the 401 and the silence.
  // -----------------------------------------------------------------------
  function nextRedirectSignal() {
    // The shape Next actually throws: a plain Error the framework tags.
    return Object.assign(new Error("NEXT_REDIRECT"), {
      digest: "NEXT_REDIRECT;replace;/sign-in?redirectTo=%2Fchat;307;",
    });
  }

  it("401s — not 500 — when the unauthenticated poll trips requireAuthSession's redirect", async () => {
    requireAuthSession.mockRejectedValue(nextRedirectSignal());
    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });
    expect(readAgentRunById).not.toHaveBeenCalled();
    expect(readAgentRunMessages).not.toHaveBeenCalled();
  });

  it("the refusal body carries NO framework text (no NEXT_REDIRECT, no sign-in URL)", async () => {
    requireAuthSession.mockRejectedValue(nextRedirectSignal());
    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    const body = await res.text();
    expect(body).not.toMatch(/NEXT_REDIRECT/);
    expect(body).not.toMatch(/sign-in/);
    expect(body).not.toMatch(/redirectTo/);
    expect(body).toBe(JSON.stringify({ error: "Unauthorized" }));
  });

  it("a bare digest-only redirect signal is recognised too", async () => {
    requireAuthSession.mockRejectedValue(
      Object.assign(new Error("x"), { digest: "NEXT_REDIRECT" }),
    );
    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(401);
  });

  it("PRESERVATION: a genuine fault is still a 500 — the redirect arm swallowed nothing", async () => {
    requireAuthSession.mockRejectedValue(new Error("connection terminated"));
    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(500);
    await expect(res.json()).resolves.toEqual({ error: "connection terminated" });
  });

  it("PRESERVATION: a digest that is not a redirect is NOT treated as one", async () => {
    requireAuthSession.mockRejectedValue(
      Object.assign(new Error("boom"), { digest: "NEXT_NOT_FOUND" }),
    );
    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(500);
  });

  it("threads the actor + org/admin hints into readAgentRunById", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({ id: "run-1", templateId: "tpl-1", status: "completed" });

    await GET(new Request("https://app.test/x"), ctx("run-1"));

    const [runId, actor, roles] = readAgentRunById.mock.calls[0];
    expect(runId).toBe("run-1");
    expect(actor).toMatchObject({ actorType: "human", userId: "user-self" });
    expect(roles).toMatchObject({ platformRole: "member", actorOrganizationId: "org-1" });
  });

  it("maps a forbidden AuthzError to 403 and NEVER reads run messages", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-b", "org-b"));
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 403, reason: "forbidden", message: "Run access denied." }),
    );

    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ error: "Forbidden" });
    expect(readAgentRunMessages).not.toHaveBeenCalled();
  });

  it("maps a hidden AuthzError to 404 (not disclose existence)", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-b", "org-b"));
    readAgentRunById.mockRejectedValue(
      new AuthzError({ statusCode: 404, reason: "hidden", message: "Not found." }),
    );

    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(404);
    expect(readAgentRunMessages).not.toHaveBeenCalled();
  });

  it("returns run detail once access is granted", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({
      id: "run-1",
      templateId: "tpl-1",
      status: "completed",
      error: null,
      inputParams: { a: 1 },
      startedAt: null,
      completedAt: null,
    });
    readAgentRunMessages.mockResolvedValue([]);

    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ status: "completed", inputParams: { a: 1 } });
    expect(readAgentRunMessages).toHaveBeenCalledWith("run-1");
  });

  // cinatra#2997 — the run card is the review screen's placeholder while the
  // agent works and becomes that screen when the work opens one, so THE SEED
  // carries the answer. The card must not have to ask a model for it, and a
  // person must not have to ask for it in a new turn.
  it("carries the run's own review slot — the minted ref and the awaiting flag", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({
      id: "run-1",
      templateId: "tpl-1",
      status: "completed",
      error: null,
      inputParams: {},
    });
    readAgentRunMessages.mockResolvedValue([]);
    readRunReviewSlot.mockResolvedValueOnce({
      reviewTaskId: "review-task-1",
      awaiting: false,
    });

    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      reviewGate: { ref: "ref:run-1:review-task-1", awaiting: false },
    });
    expect(readRunReviewSlot).toHaveBeenCalledWith("run-1");
  });

  it("says a review may still open when the run's output is unanswered", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({ id: "run-1", templateId: "tpl-1", status: "completed" });
    readAgentRunMessages.mockResolvedValue([]);
    readRunReviewSlot.mockResolvedValueOnce({ reviewTaskId: null, awaiting: true });

    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    await expect(res.json()).resolves.toMatchObject({
      reviewGate: { ref: null, awaiting: true },
    });
  });

  // A slot read that throws costs the reader the placeholder's precision, never
  // the panel: the seed still serves, with the answer this route gave before the
  // field existed.
  it("still serves the seed when the slot read fails", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("user-self", "org-1"));
    readAgentRunById.mockResolvedValue({ id: "run-1", templateId: "tpl-1", status: "completed" });
    readAgentRunMessages.mockResolvedValue([]);
    readRunReviewSlot.mockRejectedValueOnce(new Error("db down"));

    const res = await GET(new Request("https://app.test/x"), ctx("run-1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      reviewGate: { ref: null, awaiting: false },
    });
  });

  it("marks a platform admin caller with the admin role hint", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("admin-1", "org-1"));
    isPlatformAdmin.mockReturnValue(true);
    readAgentRunById.mockResolvedValue({ id: "run-1", templateId: "tpl-1", status: "completed" });

    await GET(new Request("https://app.test/x"), ctx("run-1"));
    const roles = readAgentRunById.mock.calls[0][2];
    expect(roles).toMatchObject({ platformRole: "platform_admin" });
  });
});
