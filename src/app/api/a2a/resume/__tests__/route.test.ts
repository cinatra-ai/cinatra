/**
 * POST /api/a2a/resume route tests.
 *
 * Tests the external HITL approval endpoint:
 *   - 404 when CINATRA_AGUI_EXTERNAL_ENABLED is unset
 *   - 401 when auth fails
 *   - 400 when body is missing or malformed
 *   - 200 { ok: true } on success
 *   - 404 when approveReviewTaskInternal throws "not found"
 *   - 410 when approveReviewTaskInternal throws "expired"
 *   - 500 on unexpected errors
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Module mocks — must be declared before any import of the mocked modules
// ---------------------------------------------------------------------------
vi.mock("@/lib/a2a-auth", () => ({
  verifyA2AAccessToken: vi.fn(),
}));

vi.mock("@cinatra-ai/agents", () => ({
  approveReviewTaskInternal: vi.fn(),
}));

vi.mock("@/lib/a2a-cors", () => ({
  corsHeaders: () => ({
    "Access-Control-Allow-Origin": "http://localhost:3000",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  }),
}));

// server-only guard — stub so vitest doesn't reject the import
vi.mock("server-only", () => ({}));

import { POST, OPTIONS } from "../route";
import { verifyA2AAccessToken } from "@/lib/a2a-auth";
import { approveReviewTaskInternal } from "@cinatra-ai/agents";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(
  body: unknown,
  opts: { flagOn?: boolean; origin?: string } = {},
): Request {
  if (opts.flagOn !== false) {
    process.env.CINATRA_AGUI_EXTERNAL_ENABLED = "true";
  }
  return new Request(`http://localhost/api/a2a/resume`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
}

function authOk(subject = "user-123") {
  (verifyA2AAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    subject,
  });
}

function authFail() {
  (verifyA2AAccessToken as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    }),
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /api/a2a/resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.CINATRA_AGUI_EXTERNAL_ENABLED;
  });

  it("returns 404 when CINATRA_AGUI_EXTERNAL_ENABLED is unset", async () => {
    delete process.env.CINATRA_AGUI_EXTERNAL_ENABLED;
    const req = new Request("http://localhost/api/a2a/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ reviewTaskId: "rt1" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
  });

  it("returns 401 when auth fails", async () => {
    authFail();
    const req = makeReq({ reviewTaskId: "rt1" });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it("returns 400 when body is missing reviewTaskId", async () => {
    authOk();
    const req = makeReq({});
    const res = await POST(req);
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Invalid request body");
  });

  it("returns 400 when body is not JSON", async () => {
    authOk();
    process.env.CINATRA_AGUI_EXTERNAL_ENABLED = "true";
    const req = new Request("http://localhost/api/a2a/resume", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer tok" },
      body: "not json",
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("returns 200 { ok: true } on successful approval", async () => {
    authOk("user-abc");
    (approveReviewTaskInternal as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    const req = makeReq({ reviewTaskId: "rt1", values: { decision: "approve" } });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(approveReviewTaskInternal).toHaveBeenCalledWith("rt1", "user-abc", { decision: "approve" });
  });

  it("returns 404 when approveReviewTaskInternal throws 'not found'", async () => {
    authOk();
    (approveReviewTaskInternal as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Review task not found or already resolved"),
    );
    const req = makeReq({ reviewTaskId: "rt-unknown" });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.error).toBe("Review task not found or already resolved");
  });

  it("returns 410 when approveReviewTaskInternal throws 'expired'", async () => {
    authOk();
    (approveReviewTaskInternal as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Review task has expired"),
    );
    const req = makeReq({ reviewTaskId: "rt-expired" });
    const res = await POST(req);
    expect(res.status).toBe(410);
    const json = await res.json();
    expect(json.error).toBe("Review task has expired");
  });

  it("returns 500 on unexpected errors", async () => {
    authOk();
    (approveReviewTaskInternal as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("DB connection lost"),
    );
    const req = makeReq({ reviewTaskId: "rt1" });
    const res = await POST(req);
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(json.error).toBe("Internal server error");
  });
});

describe("OPTIONS /api/a2a/resume", () => {
  it("returns 204 with CORS headers", async () => {
    const req = new Request("http://localhost/api/a2a/resume", { method: "OPTIONS" });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
  });
});
