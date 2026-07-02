import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route-handler regression test for GET /api/agents/instance-name.
// Previously behind cookie-existence only; this test pins the in-handler
// validated-session requirement and that no template lookup happens for an
// unauthenticated caller.
// ---------------------------------------------------------------------------

const getAuthSession = vi.fn();
const readAgentTemplateBySlug = vi.fn();

vi.mock("@/lib/auth-session", () => ({
  getAuthSession: () => getAuthSession(),
}));
vi.mock("@cinatra-ai/agents", () => ({
  readAgentTemplateBySlug: (...a: unknown[]) => readAgentTemplateBySlug(...a),
}));

import { GET } from "../route";

function req(qs: string) {
  return new Request(`https://app.test/api/agents/instance-name${qs}`);
}

describe("GET /api/agents/instance-name", () => {
  beforeEach(() => {
    readAgentTemplateBySlug.mockResolvedValue({ name: "Agent Builder" });
  });
  afterEach(() => vi.clearAllMocks());

  it("401s with no session and never resolves a template", async () => {
    getAuthSession.mockResolvedValue(null);
    const res = await GET(req("?agentId=a1&instanceId=i1"));
    expect(res.status).toBe(401);
    expect(readAgentTemplateBySlug).not.toHaveBeenCalled();
  });

  it("400s an authenticated caller missing required params", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    const res = await GET(req("?agentId=a1"));
    expect(res.status).toBe(400);
    expect(readAgentTemplateBySlug).not.toHaveBeenCalled();
  });

  it("resolves the template name for an authenticated caller", async () => {
    getAuthSession.mockResolvedValue({ user: { id: "user-1" } });
    const res = await GET(req("?agentId=a1&instanceId=i1"));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ name: "Agent Builder" });
  });
});
