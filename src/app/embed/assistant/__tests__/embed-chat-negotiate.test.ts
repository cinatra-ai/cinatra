// S5 (cinatra#1221) Lane B §8 — the embed's CLIENT-SIDE handshake, fail-closed.
// B8: an advertisement lacking token-broker → wire does NOT mount.
// B18: malformed capability JSON / transport failure → fail closed.
// Also proves the Lane-A interlock (session-gated 401 today → gated, not mount)
// and the credentials:"omit" + broker-header posture (§9.1/§B11).
import { describe, it, expect, vi, afterEach } from "vitest";
import { negotiateEmbedChatContract } from "../embed-chat-negotiate";

const AUTH = () => ({ Authorization: "Bearer cit_x", "X-Cinatra-Widget-User-Token": "cwu_y" });

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response> | Response) {
  const fn = vi.fn(impl as unknown as typeof fetch);
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => vi.unstubAllGlobals());

function caps(auth: string[]) {
  return {
    contract: "1.0.0",
    supportedContracts: ["1.0.0"],
    resumable: true,
    transport: "sse",
    auth,
    renderableViews: [],
  };
}

describe("negotiateEmbedChatContract — fail-closed handshake", () => {
  it("mounts (ok) when the advertisement includes token-broker AND a mutual contract", async () => {
    mockFetch(() => new Response(JSON.stringify(caps(["session", "token-broker"])), { status: 200 }));
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(true);
  });

  it("B8: does NOT mount when the advertisement lacks token-broker", async () => {
    mockFetch(() => new Response(JSON.stringify(caps(["session"])), { status: 200 }));
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
    if (!n.ok) expect(n.reason).toBe("auth_mode_unsupported");
  });

  it("Lane-A interlock: a session-gated 401 today → fail closed (honest gated state)", async () => {
    mockFetch(() => new Response("Unauthorized", { status: 401 }));
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
  });

  it("B18: malformed capability JSON → fail closed", async () => {
    mockFetch(() => new Response("not json", { status: 200 }));
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
  });

  it("B18: a transport failure → fail closed", async () => {
    mockFetch(() => {
      throw new Error("network down");
    });
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
  });

  it("no mutual contract → fail closed", async () => {
    mockFetch(() => new Response(JSON.stringify({ ...caps(["token-broker"]), supportedContracts: ["9.9.9"] }), { status: 200 }));
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
  });

  it("B18: a non-iterable renderableViews (would throw inside the pure negotiator) → fail closed, no throw", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ ...caps(["session", "token-broker"]), renderableViews: 42 }),
          { status: 200 },
        ),
    );
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false); // guard rejects before the negotiator can throw
  });

  it("B18: a missing contract / transport field → fail closed (guard validates every read field)", async () => {
    const partial = { supportedContracts: ["1.0.0"], auth: ["token-broker"], resumable: true };
    mockFetch(() => new Response(JSON.stringify(partial), { status: 200 }));
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
  });

  it("B18: a NON-SSE transport (e.g. websocket) with valid broker auth → fail closed (never mount the SSE wire)", async () => {
    mockFetch(
      () =>
        new Response(
          JSON.stringify({ ...caps(["session", "token-broker"]), transport: "websocket" }),
          { status: 200 },
        ),
    );
    const n = await negotiateEmbedChatContract(AUTH);
    expect(n.ok).toBe(false);
  });

  it("§9.1/§B11: fetches with credentials:'omit' + the broker headers, cache no-store", async () => {
    const fn = mockFetch(() => new Response(JSON.stringify(caps(["session", "token-broker"])), { status: 200 }));
    await negotiateEmbedChatContract(AUTH);
    const [, init] = fn.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.credentials).toBe("omit");
    expect(init.cache).toBe("no-store");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer cit_x");
  });
});
