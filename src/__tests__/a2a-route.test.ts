/**
 * Static inspection + mount-mocked behavioural tests for the POST /api/a2a
 * Next.js Route Handler.
 *
 * We mock `@/lib/a2a-server` and `@/lib/a2a-auth` so the tests run without a
 * live auth instance, DB, or Redis. The assertions cover the three feature-flag
 * + auth branches that the Route Handler owns itself (the SDK's JSON-RPC
 * envelopes are covered in the @cinatra-ai/a2a unit tests).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// vi.mock is hoisted to the top of the file; referencing module-scope consts
// inside the factory fails with "Cannot access before initialization". Use
// vi.hoisted() so the shared mock fns are created BEFORE the mock factories
// run.
const { verifyA2AAccessTokenMock, getA2AMountMock, resolveA2AActorContextMock } =
  vi.hoisted(() => ({
    verifyA2AAccessTokenMock: vi.fn(),
    getA2AMountMock: vi.fn(),
    resolveA2AActorContextMock: vi.fn(),
  }));

vi.mock("@/lib/a2a-auth", () => ({
  verifyA2AAccessToken: verifyA2AAccessTokenMock,
}));
vi.mock("@/lib/a2a-server", () => ({
  getA2AMount: getA2AMountMock,
}));
// The route resolves the originating ActorContext (and looks up agent_runs by
// task id) before dispatching to the mount. Mock the resolver so the route's
// own flag/auth/mount/SSE logic is exercised without a live DB.
vi.mock("../app/api/a2a/actor-context-resolver", () => ({
  resolveA2AActorContext: resolveA2AActorContextMock,
}));
// withActorContext wraps mount.handle in an AsyncLocalStorage frame; pass the
// callback straight through in the test.
vi.mock("@cinatra-ai/llm/actor-context", () => ({
  withActorContext: (_ctx: unknown, fn: () => unknown) => fn(),
}));

// Import AFTER mocks are registered — the route module pulls these in.
import { POST, OPTIONS } from "../app/api/a2a/route";

describe("POST /api/a2a", () => {
  const originalFlag = process.env.CINATRA_A2A_HTTP_ENABLED;

  beforeEach(() => {
    verifyA2AAccessTokenMock.mockReset();
    getA2AMountMock.mockReset();
    resolveA2AActorContextMock.mockReset();
    // Default: the originating ActorContext resolves cleanly so the route
    // proceeds to the mount. Individual tests can override.
    resolveA2AActorContextMock.mockResolvedValue({
      kind: "ok",
      actorContext: {
        principalType: "InternalWorker",
        principalId: "test-actor",
        organizationId: "org-test",
        teamIds: [],
        policyVersion: "v2",
      },
    });
  });

  afterEach(() => {
    if (originalFlag === undefined) {
      delete process.env.CINATRA_A2A_HTTP_ENABLED;
    } else {
      process.env.CINATRA_A2A_HTTP_ENABLED = originalFlag;
    }
  });

  it("returns 404 when CINATRA_A2A_HTTP_ENABLED is not 'true'", async () => {
    delete process.env.CINATRA_A2A_HTTP_ENABLED;
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: JSON.stringify({}),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).toContain("A2A HTTP surface disabled");
  });

  it("returns 401 from verifyA2AAccessToken response when unauthorized", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    const unauthorized = new Response(
      JSON.stringify({ error: "unauthorized" }),
      {
        status: 401,
        headers: {
          "Content-Type": "application/json",
          "WWW-Authenticate":
            'Bearer resource_metadata="http://example.com/.well-known/oauth-protected-resource"',
        },
      },
    );
    verifyA2AAccessTokenMock.mockResolvedValueOnce({
      ok: false,
      response: unauthorized,
    });
    const req = new Request("http://tunnel.example.com/api/a2a", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "foo", id: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
    expect(res.headers.get("WWW-Authenticate")).toContain("resource_metadata");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  it("delegates to the SDK mount and returns its JSON-RPC envelope", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    verifyA2AAccessTokenMock.mockResolvedValueOnce({ ok: true });
    const envelope = {
      jsonrpc: "2.0",
      error: { code: -32601, message: "Method not found: unknown/method" },
      id: 1,
    };
    getA2AMountMock.mockResolvedValueOnce({
      handle: vi.fn().mockResolvedValueOnce(envelope),
      refresh: vi.fn(),
    });
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "unknown/method",
        id: 1,
      }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual(envelope);
  });

  it("returns 200 + text/event-stream when the SDK returns an AsyncGenerator (streaming path)", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    verifyA2AAccessTokenMock.mockResolvedValueOnce({ ok: true });
    async function* gen() {
      yield { jsonrpc: "2.0", result: "x", id: 7 };
    }
    getA2AMountMock.mockResolvedValueOnce({
      handle: vi.fn().mockResolvedValueOnce(gen()),
      refresh: vi.fn(),
    });
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "message/stream", id: 7 }),
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    // CORS headers must still be present on the streaming response.
    expect(res.headers.get("Access-Control-Allow-Origin")).toBeTruthy();
  });

  // Last-Event-ID header threading for tasks/resubscribe.
  it("forwards valid Last-Event-ID header to mount.handle context", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    verifyA2AAccessTokenMock.mockResolvedValueOnce({ ok: true });
    const handleMock = vi
      .fn()
      .mockResolvedValue({ jsonrpc: "2.0", id: 1, result: "ok" });
    getA2AMountMock.mockResolvedValueOnce({
      handle: handleMock,
      refresh: vi.fn(),
    });
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/resubscribe",
        id: 1,
        params: { id: "run-x" },
      }),
      headers: {
        "Content-Type": "application/json",
        "Last-Event-ID": "12345-0",
      },
    });
    await POST(req);
    expect(handleMock).toHaveBeenCalledTimes(1);
    const ctx = handleMock.mock.calls[0][1];
    expect(ctx).toBeDefined();
    expect((ctx as { lastEventId?: string }).lastEventId).toBe(
      "12345-0",
    );
  });

  it("ignores malformed Last-Event-ID (treats as absent, no 400 response)", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    verifyA2AAccessTokenMock.mockResolvedValueOnce({ ok: true });
    const handleMock = vi
      .fn()
      .mockResolvedValue({ jsonrpc: "2.0", id: 1, result: "ok" });
    getA2AMountMock.mockResolvedValueOnce({
      handle: handleMock,
      refresh: vi.fn(),
    });
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "tasks/resubscribe",
        id: 1,
        params: { id: "run-x" },
      }),
      headers: {
        "Content-Type": "application/json",
        "Last-Event-ID": "; DROP TABLE events --",
      },
    });
    const res = await POST(req);
    expect(res.status).toBe(200);
    const ctx = handleMock.mock.calls[0][1];
    expect((ctx as { lastEventId?: string }).lastEventId).toBeUndefined();
  });

  it("no Last-Event-ID header → lastEventId undefined", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    verifyA2AAccessTokenMock.mockResolvedValueOnce({ ok: true });
    const handleMock = vi
      .fn()
      .mockResolvedValue({ jsonrpc: "2.0", id: 1, result: "ok" });
    getA2AMountMock.mockResolvedValueOnce({
      handle: handleMock,
      refresh: vi.fn(),
    });
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", method: "message/send", id: 1 }),
      headers: { "Content-Type": "application/json" },
    });
    await POST(req);
    const ctx = handleMock.mock.calls[0][1];
    expect((ctx as { lastEventId?: string }).lastEventId).toBeUndefined();
  });

  it("returns 400 parse-error envelope when the body is not valid JSON", async () => {
    process.env.CINATRA_A2A_HTTP_ENABLED = "true";
    verifyA2AAccessTokenMock.mockResolvedValueOnce({ ok: true });
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "POST",
      body: "not-json",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32700);
  });
});

describe("OPTIONS /api/a2a", () => {
  it("returns 204 + CORS headers", async () => {
    const req = new Request("http://localhost:3000/api/a2a", {
      method: "OPTIONS",
    });
    const res = await OPTIONS(req);
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Authorization",
    );
  });
});
