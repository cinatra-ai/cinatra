// GET /api/cli/extensions/reconcile/plan — route wiring + auth mirroring.

import { describe, it, expect, vi, beforeEach } from "vitest";

const authorizeCliRequestMock = vi.fn();
const planReconcileMock = vi.fn();

vi.mock("@/lib/cli-api/route-guard", () => ({
  authorizeCliRequest: (...args: unknown[]) => authorizeCliRequestMock(...args),
}));
vi.mock("@/lib/cli-api/extensions-reconcile", () => ({
  planReconcile: (...args: unknown[]) => planReconcileMock(...args),
}));

import { GET } from "../route";

function req(): Request {
  return new Request("https://inst.cinatra.ai/api/cli/extensions/reconcile/plan", {
    method: "GET",
  });
}

const SAMPLE_PLAN = {
  planDigest: "sha256:abc",
  generatedAt: "2026-07-12T00:00:00.000Z",
  readModelStatus: "unwired",
  candidates: [],
  skipped: [{ packageName: "@acme/foo", reason: "read-model-unwired" }],
  fences: [],
};

beforeEach(() => {
  authorizeCliRequestMock.mockReset();
  planReconcileMock.mockReset();
});

describe("GET /api/cli/extensions/reconcile/plan", () => {
  it("platform-admin → 200 with the plan; auth mirrors the sibling routes (platform-admin + cli:extensions:read)", async () => {
    authorizeCliRequestMock.mockResolvedValue({ ok: true, actor: { userId: "admin-1" } });
    planReconcileMock.mockResolvedValue(SAMPLE_PLAN);

    const res = await GET(req());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(SAMPLE_PLAN);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(authorizeCliRequestMock).toHaveBeenCalledWith(expect.anything(), {
      minTier: "platform-admin",
      requiredScope: "cli:extensions:read",
    });
  });

  it("under-privileged → the guard's status/error passthrough; the plan is NEVER computed", async () => {
    authorizeCliRequestMock.mockResolvedValue({
      ok: false,
      status: 403,
      error: "Forbidden: this CLI endpoint requires platform admin.",
    });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "Forbidden: this CLI endpoint requires platform admin.",
    });
    expect(planReconcileMock).not.toHaveBeenCalled();
  });

  it("unauthenticated → 401 passthrough", async () => {
    authorizeCliRequestMock.mockResolvedValue({ ok: false, status: 401, error: "Unauthorized" });
    const res = await GET(req());
    expect(res.status).toBe(401);
    expect(planReconcileMock).not.toHaveBeenCalled();
  });

  it("a planner error → 500 (no leak, no crash)", async () => {
    authorizeCliRequestMock.mockResolvedValue({ ok: true, actor: { userId: "admin-1" } });
    planReconcileMock.mockRejectedValue(new Error("boom"));

    const res = await GET(req());

    expect(res.status).toBe(500);
    expect((await res.json()).error).toMatch(/Failed to compute the reconcile plan/);
  });
});
