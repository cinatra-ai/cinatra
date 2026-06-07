/**
 * Tests for proxy auth gate parity with /api/llm-bridge.
 *
 * The proxy at /api/a2a/agents/[...slug] is a peer of /api/llm-bridge — both
 * are internal-surface routes WayFlow containers reach to talk to Cinatra.
 * They share the same auth gate (CINATRA_BRIDGE_TOKEN) implemented by the
 * `isAuthorizedBridgeRequest` helper at src/lib/wayflow-bridge-auth.ts.
 *
 * Auth invariant: the auth gate runs BEFORE the segment-count check, so
 * an unauthenticated probe with a malformed path returns 403, never 404.
 * Tests below verify the auth contract using valid 2-segment vendor/slug paths.
 *
 * Mock topology mirrors src/app/api/a2a/agents/[...slug]/__tests__/route.test.ts —
 * the only addition is per-test toggling of CINATRA_BRIDGE_TOKEN.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const undiciFetchMock = vi.fn();

vi.mock("undici", () => ({
  // Constructor stub — `new UndiciAgent(...)` at route module-load time must
  // succeed. Vitest requires a real constructable class here.
  Agent: class MockUndiciAgent {
    constructor(_opts?: unknown) {}
  },
  fetch: undiciFetchMock,
}));

let POST: (
  req: Request,
  ctx: { params: Promise<{ slug: string[] }> },
) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  delete process.env.CINATRA_BRIDGE_TOKEN;
  delete process.env.WAYFLOW_INTERNAL_BYPASS;
  process.env.WAYFLOW_BASE_URL = "http://localhost:3010";
  const mod = await import("../route");
  POST = mod.POST;
  undiciFetchMock.mockResolvedValue({
    status: 200,
    headers: { get: () => "application/json" },
    text: async () => "{}",
  });
});

describe("/api/a2a/agents/[...slug] auth gate", () => {
  it("accepts request when X-Cinatra-Bridge-Token matches CINATRA_BRIDGE_TOKEN env", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      {
        method: "POST",
        headers: { "x-cinatra-bridge-token": "secret-token-32chars-XYZXYZXYZXYZ" },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(200);
  });

  it("rejects request with wrong X-Cinatra-Bridge-Token (403)", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      {
        method: "POST",
        headers: { "x-cinatra-bridge-token": "wrong-token-32chars-AAAAAAAAAAAAA" },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects request with no header when CINATRA_BRIDGE_TOKEN is set", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      { method: "POST", body: "{}" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects request when CINATRA_BRIDGE_TOKEN is unset (no fallback)", async () => {
    delete process.env.CINATRA_BRIDGE_TOKEN;
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      { method: "POST", body: "{}" },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects on length mismatch without invoking timingSafeEqual (short-circuit)", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      {
        method: "POST",
        headers: { "x-cinatra-bridge-token": "short" },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(403);
  });

  it("auth gate runs BEFORE segment-count check — unauthenticated request with 1 segment returns 403, not 404", async () => {
    process.env.CINATRA_BRIDGE_TOKEN = "secret-token-32chars-XYZXYZXYZXYZ";
    const req = new Request("http://localhost:3000/api/a2a/agents/foo", {
      method: "POST",
      // No bridge-token header — should be rejected at the auth gate.
      body: "{}",
    });
    const res = await POST(req, { params: Promise.resolve({ slug: ["foo"] }) });
    expect(res.status).toBe(403);
  });
});
