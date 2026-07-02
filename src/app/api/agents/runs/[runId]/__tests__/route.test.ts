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

  it("marks a platform admin caller with the admin role hint", async () => {
    requireAuthSession.mockResolvedValue(sessionFor("admin-1", "org-1"));
    isPlatformAdmin.mockReturnValue(true);
    readAgentRunById.mockResolvedValue({ id: "run-1", templateId: "tpl-1", status: "completed" });

    await GET(new Request("https://app.test/x"), ctx("run-1"));
    const roles = readAgentRunById.mock.calls[0][2];
    expect(roles).toMatchObject({ platformRole: "platform_admin" });
  });
});
