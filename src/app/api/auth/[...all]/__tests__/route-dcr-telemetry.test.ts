import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Route contract for the Dynamic Client Registration (DCR) usage telemetry
// (cinatra#2218 scope item 7).
//
// The `POST` handler for `/api/auth/[...all]` is the single seam BOTH DCR paths
// pass through, so it is where the evidence for the deprecation-window decision
// is produced. Two properties have to hold for that evidence to mean anything:
//
//   FIRES  — a registration attempt emits exactly one event, and its `path`
//            matches what actually happened to the request (shim vs untouched),
//            with the response status carried through including on rejection.
//   SILENT — nothing else emits. A non-registration auth call that produced an
//            event would inflate the reading with traffic that registered
//            nothing; a mis-wired seam that emitted nothing would deflate it.
//            The silence half is therefore load-bearing, not padding.
//
// Neither half makes a quiet log self-certifying — the emit is best-effort and
// swallows sink failures by design (see src/lib/mcp-dcr-telemetry.ts). What
// these tests establish is narrower and still worth having: IF the seam ran and
// its output was collected, the counts describe DCR traffic and nothing else.
//
// Better Auth's handler and the app auth graph are mocked away: this test is
// about the seam's bookkeeping, not about the provider's registration logic.
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => {
  const post = vi.fn();
  const get = vi.fn();
  return { post, get };
});

vi.mock("@/lib/auth", () => ({ auth: { __stub: true } }));
vi.mock("better-auth/next-js", () => ({
  toNextJsHandler: () => ({
    GET: (...args: unknown[]) => h.get(...args),
    POST: (...args: unknown[]) => h.post(...args),
  }),
}));

import { DCR_REGISTRATION_EVENT } from "@/lib/mcp-dcr-telemetry";
import { GET, POST } from "../route";

const REGISTER_URL = "https://app.test/api/auth/oauth2/register";

let infoSpy: ReturnType<typeof vi.spyOn>;

function events() {
  return infoSpy.mock.calls
    .map((call) => {
      if (typeof call[0] !== "string") return null;
      try {
        return JSON.parse(call[0]) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter(
      (parsed): parsed is Record<string, unknown> =>
        parsed !== null && parsed.event === DCR_REGISTRATION_EVENT,
    );
}

function registrationRequest(body: unknown, init?: { raw?: string }) {
  return new Request(REGISTER_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: init?.raw ?? JSON.stringify(body),
  });
}

beforeEach(() => {
  h.post.mockReset();
  h.get.mockReset();
  h.post.mockResolvedValue(new Response("{}", { status: 201 }));
  h.get.mockResolvedValue(new Response("{}", { status: 200 }));
  infoSpy = vi.spyOn(console, "info").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/auth/oauth2/register — telemetry FIRES", () => {
  it("records the shim path when a client-supplied narrow scope had to be widened", async () => {
    await POST(
      registrationRequest({
        redirect_uris: ["https://client.test/cb"],
        scope: "openid email profile",
      }),
    );

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      path: "cinatra-scope-shim",
      scopeDisposition: "widened",
      clientRequestedScopeCount: 3,
      outcome: "accepted",
      status: 201,
    });

    // …and the forwarded body really was rewritten, so the recorded path is a
    // description of the request rather than an unbacked label.
    const forwarded = h.post.mock.calls[0][0] as Request;
    expect(await forwarded.clone().json()).toMatchObject({
      scope: "openid email profile mcp:connect",
    });
  });

  it("records the plugin-default path when the client omitted scope, and forwards it untouched", async () => {
    const request = registrationRequest({ redirect_uris: ["https://client.test/cb"] });
    await POST(request);

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      path: "plugin-default",
      scopeDisposition: "omitted",
      clientRequestedScopeCount: 0,
      outcome: "accepted",
      status: 201,
    });
    // Identity, not equivalence: the scope-less body must reach the provider as
    // the SAME request so its own default-scope rule applies.
    expect(h.post.mock.calls[0][0]).toBe(request);
  });

  it("records the plugin-default path when the client already asked for mcp:connect", async () => {
    await POST(
      registrationRequest({
        redirect_uris: ["https://client.test/cb"],
        scope: "openid mcp:connect",
      }),
    );

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      path: "plugin-default",
      scopeDisposition: "already-required",
      clientRequestedScopeCount: 2,
    });
  });

  it("records a whitespace-only scope as unusable-scope and forwards it untouched", async () => {
    const request = registrationRequest({
      redirect_uris: ["https://client.test/cb"],
      scope: "   ",
    });
    await POST(request);

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      path: "plugin-default",
      scopeDisposition: "unusable-scope",
      clientRequestedScopeCount: 0,
    });
    expect(h.post.mock.calls[0][0]).toBe(request);
  });

  it("records an unparsable body as unreadable-body rather than as a scope-less registration", async () => {
    await POST(registrationRequest(undefined, { raw: "<not json>" }));

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      path: "plugin-default",
      scopeDisposition: "unreadable-body",
      clientRequestedScopeCount: 0,
    });
  });

  it("records a REJECTED registration with its status — a refused attempt is still usage", async () => {
    h.post.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const response = await POST(
      registrationRequest({ redirect_uris: ["https://client.test/cb"], scope: "openid" }),
    );

    expect(response.status).toBe(403);
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      path: "cinatra-scope-shim",
      outcome: "rejected",
      status: 403,
    });
  });

  it("records a thrown handler as handler-error and re-throws unchanged", async () => {
    const boom = new Error("registration exploded");
    h.post.mockRejectedValue(boom);

    await expect(
      POST(registrationRequest({ redirect_uris: ["https://client.test/cb"] })),
    ).rejects.toBe(boom);

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ outcome: "handler-error", status: null });
  });

  it("emits no client-identifying value from a fully-populated registration body", async () => {
    await POST(
      registrationRequest({
        redirect_uris: ["https://client.test/callback"],
        client_name: "Some MCP Client",
        software_id: "sw-12345",
        contacts: ["ops@client.test"],
        scope: "openid email",
      }),
    );

    const line = String(infoSpy.mock.calls.find((c) => String(c[0]).includes(DCR_REGISTRATION_EVENT))?.[0]);
    for (const banned of [
      "client.test",
      "Some MCP Client",
      "sw-12345",
      "ops@client.test",
      "callback",
      "openid",
    ]) {
      expect(line).not.toContain(banned);
    }
  });
});

describe("the telemetry stays SILENT off the DCR path", () => {
  it("emits nothing for a non-registration auth POST", async () => {
    await POST(
      new Request("https://app.test/api/auth/sign-in/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: "user@example.test", password: "hunter2" }),
      }),
    );

    expect(events()).toHaveLength(0);
    expect(h.post).toHaveBeenCalledTimes(1);
  });

  it("emits nothing for a POST whose path merely CONTAINS the register segment", async () => {
    await POST(
      new Request("https://app.test/api/auth/oauth2/register/extra", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ redirect_uris: ["https://client.test/cb"] }),
      }),
    );

    expect(events()).toHaveLength(0);
  });

  it("emits nothing for a near-miss PREFIXED path that only ENDS with the register segment", async () => {
    // The catch-all segment routes this here, so a suffix predicate would both
    // rewrite a body Better Auth is about to 404 AND count it as DCR usage,
    // inflating the deprecation-window reading with traffic that never
    // registered anything.
    const request = new Request("https://app.test/api/auth/not-dcr/oauth2/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://client.test/cb"],
        scope: "openid email profile",
      }),
    });
    await POST(request);

    expect(events()).toHaveLength(0);
    // …and the body was NOT rewritten: the request reached the handler as-is.
    expect(h.post.mock.calls[0][0]).toBe(request);
  });

  it.each([
    ["trailing slash", "https://app.test/api/auth/oauth2/register/"],
    ["doubled slash", "https://app.test/api/auth/oauth2//register"],
  ])(
    "emits nothing for a %s variant, which Better Auth's router 404s rather than routing to DCR",
    async (_label, url) => {
      // `better-call`'s router returns 404 when a path's trailing slash differs
      // from the declared route's (Better Auth leaves `skipTrailingSlashes`
      // false) and when a path contains consecutive slashes. Normalising either
      // into a match here would rewrite a body that never reaches the endpoint
      // and count a 404 as a registration.
      const request = new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          redirect_uris: ["https://client.test/cb"],
          scope: "openid email profile",
        }),
      });
      await POST(request);

      expect(events()).toHaveLength(0);
      expect(h.post.mock.calls[0][0]).toBe(request);
    },
  );

  it("emits nothing for a GET, including a GET on the registration path", async () => {
    await GET(new Request("https://app.test/api/auth/oauth2/register", { method: "GET" }));
    await GET(new Request("https://app.test/api/auth/session", { method: "GET" }));

    expect(events()).toHaveLength(0);
    expect(h.get).toHaveBeenCalledTimes(2);
  });

  it("passes non-registration requests through with their original argument list", async () => {
    const request = new Request("https://app.test/api/auth/sign-out", { method: "POST" });
    const extra = { params: Promise.resolve({ all: ["sign-out"] }) };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    await (POST as any)(request, extra);

    expect(h.post).toHaveBeenCalledWith(request, extra);
    expect(events()).toHaveLength(0);
  });
});
