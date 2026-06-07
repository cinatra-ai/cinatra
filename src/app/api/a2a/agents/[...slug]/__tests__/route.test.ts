/**
 * GREEN tests for the WayFlow vendor/slug proxy route.
 *
 * The proxy route is the host-side gateway between Cinatra clients and the
 * containerized WayFlow agent servers. It derives the upstream URL from
 * the canonical packageName (`@vendor/slug`) via `resolveWayflowUrl`, which
 * composes `${WAYFLOW_BASE_URL}/agents/<vendor>/<slug>/`. The proxy path only
 * uses the single base URL env var; per-slug URL-map and single-agent
 * URL-fallback env vars are intentionally not part of this route.
 *
 * Behaviors:
 *   - POST: forwards body verbatim to the upstream URL.
 *   - GET (agent-card discovery): strips both proxy segments so upstream
 *     sees /.well-known/agent-card.json.
 *   - Fewer than 2 path segments: returns 404 with a documented error body.
 *   - Malformed packageName (bad chars rejected by strict regex): returns 502.
 *   - Upstream throws: returns 502.
 *
 * Bridge-token fixture: every Request carries `x-cinatra-bridge-token`
 * matching `CINATRA_BRIDGE_TOKEN`. Auth-specific behavior (missing/wrong
 * token → 403) is exercised in route-auth.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const undiciFetchMock = vi.fn();

vi.mock("undici", () => ({
  // Constructor stub — `new UndiciAgent(...)` at route module-load time must
  // succeed. Vitest 4 does not treat `vi.fn().mockImplementation(...)` as a
  // constructor here, so the mock uses a real class.
  Agent: class MockUndiciAgent {
    constructor(_opts?: unknown) {}
  },
  fetch: undiciFetchMock,
}));

let POST: (
  req: Request,
  ctx: { params: Promise<{ slug: string[] }> },
) => Promise<Response>;
let GET: (
  req: Request,
  ctx: { params: Promise<{ slug: string[] }> },
) => Promise<Response>;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  // The proxy uses one base URL env var; vendor/slug is derived from the
  // request path and validated by the strict regex inside resolveWayflowUrl.
  process.env.WAYFLOW_BASE_URL = "http://localhost:3010";
  // Every test below carries the matching bridge-token header.
  // Auth-specific behavior (missing/wrong token → 403) lives in route-auth.test.ts.
  process.env.CINATRA_BRIDGE_TOKEN = "test-token-32chars-XYZXYZXYZXYZ";
  delete process.env.WAYFLOW_INTERNAL_BYPASS; // env hygiene
  const mod = await import("../route");
  POST = mod.POST;
  GET = mod.GET;
});

describe("/api/a2a/agents/[...slug] proxy (vendor/slug)", () => {
  it("forwards POST body verbatim to ${WAYFLOW_BASE_URL}/agents/<vendor>/<slug>/", async () => {
    undiciFetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => '{"jsonrpc":"2.0","result":{"id":"task-X"}}',
    });
    const body =
      '{"jsonrpc":"2.0","method":"tasks/send","params":{"id":"task-X"}}';
    const req = new Request(
      "http://localhost:3000/api/a2a/agents/cinatra/email-outreach-agent",
      {
        method: "POST",
        headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
        body,
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "http://localhost:3010/agents/cinatra/email-outreach-agent/",
      expect.objectContaining({ method: "POST", body }),
    );
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"jsonrpc":"2.0","result":{"id":"task-X"}}');
  });

  it("strips /api/a2a/agents/<vendor>/<slug> prefix on GET (agent-card discovery)", async () => {
    undiciFetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => '{"name":"email-outreach-agent"}',
    });
    const req = new Request(
      "http://localhost:3000/api/a2a/agents/cinatra/email-outreach-agent/.well-known/agent-card.json",
      { headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" } },
    );
    await GET(req, {
      params: Promise.resolve({
        slug: ["cinatra", "email-outreach-agent", ".well-known", "agent-card.json"],
      }),
    });
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "http://localhost:3010/agents/cinatra/email-outreach-agent/.well-known/agent-card.json",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("returns 404 when fewer than 2 path segments (POST)", async () => {
    const req = new Request("http://localhost:3000/api/a2a/agents/foo", {
      method: "POST",
      headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
      body: "{}",
    });
    const res = await POST(req, { params: Promise.resolve({ slug: ["foo"] }) });
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toMatch(/must include vendor and agent slug/);
  });

  it("returns 404 when fewer than 2 path segments (GET)", async () => {
    const req = new Request("http://localhost:3000/api/a2a/agents/foo", {
      headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
    });
    const res = await GET(req, { params: Promise.resolve({ slug: ["foo"] }) });
    expect(res.status).toBe(404);
  });

  it("returns 502 for malformed segments (uppercase rejected by strict regex)", async () => {
    const req = new Request(
      "http://localhost:3000/api/a2a/agents/CINATRA/email-outreach-agent",
      {
        method: "POST",
        headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["CINATRA", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toMatch(/strict @vendor\/slug pattern/);
  });

  it("returns 502 when upstream throws", async () => {
    undiciFetchMock.mockRejectedValueOnce(new Error("ECONNREFUSED"));
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      {
        method: "POST",
        headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(502);
  });

  it("forwards agent-card discovery sub-path GET to upstream /.well-known/agent-card.json", async () => {
    undiciFetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => '{"name":"email-outreach-agent"}',
    });
    const req = new Request(
      "http://localhost:3000/api/a2a/agents/cinatra/email-outreach-agent/.well-known/agent-card.json",
      { headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" } },
    );
    const res = await GET(req, {
      params: Promise.resolve({
        slug: ["cinatra", "email-outreach-agent", ".well-known", "agent-card.json"],
      }),
    });
    expect(res.status).toBe(200);
    // Upstream call MUST hit the bare /.well-known/agent-card.json path.
    expect(undiciFetchMock).toHaveBeenCalledWith(
      "http://localhost:3010/agents/cinatra/email-outreach-agent/.well-known/agent-card.json",
      expect.objectContaining({ method: "GET" }),
    );
  });

  // ---------------------------------------------------------------------------
  // Inbound safeguards: 1 MB body cap and 60s inbound timeout.
  // ---------------------------------------------------------------------------

  it("returns 413 when Content-Length exceeds 1 MB", async () => {
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      {
        method: "POST",
        headers: {
          "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
          "content-length": "2000000",
        },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error).toBe("Body too large");
    expect(body.limit).toBe(1_000_000);
    expect(undiciFetchMock).not.toHaveBeenCalled();
  });

  it("passes through when Content-Length is within limit", async () => {
    undiciFetchMock.mockResolvedValueOnce({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "{}",
    });
    const req = new Request(
      "http://localhost:3000/api/a2a/extensions/cinatra-ai/email-outreach-agent",
      {
        method: "POST",
        headers: {
          "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ",
          "content-length": "100",
        },
        body: "{}",
      },
    );
    const res = await POST(req, {
      params: Promise.resolve({ slug: ["cinatra", "email-outreach-agent"] }),
    });
    expect(res.status).toBe(200);
    expect(undiciFetchMock).toHaveBeenCalled();
  });

  it("routes different vendor/slug pairs to distinct upstream URLs", async () => {
    undiciFetchMock.mockResolvedValue({
      status: 200,
      headers: { get: () => "application/json" },
      text: async () => "{}",
    });

    const reqA = new Request("http://localhost:3000/api/a2a/agents/cinatra/foo", {
      method: "POST",
      headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
      body: "{}",
    });
    await POST(reqA, { params: Promise.resolve({ slug: ["cinatra", "foo"] }) });

    const reqB = new Request("http://localhost:3000/api/a2a/agents/acme/foo", {
      method: "POST",
      headers: { "x-cinatra-bridge-token": "test-token-32chars-XYZXYZXYZXYZ" },
      body: "{}",
    });
    await POST(reqB, { params: Promise.resolve({ slug: ["acme", "foo"] }) });

    const calls = undiciFetchMock.mock.calls.map((c) => c[0]);
    expect(calls).toContain("http://localhost:3010/agents/cinatra/foo/");
    expect(calls).toContain("http://localhost:3010/agents/acme/foo/");
  });
});
