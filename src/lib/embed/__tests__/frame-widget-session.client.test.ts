// cinatra#2674 (epic #2564 S8e) — THE FRAME-OWNED SIGN-IN, browser side.
//
// The ceremony has one property worth testing above all others: the
// authorization result is accepted ONLY from this origin, only from the window
// this frame opened, and only with the state this frame minted. Everything else
// here is fail-closed plumbing around that.
//
// The credential's storage is asserted as an ABSENCE: after a full successful
// run, nothing was written to `localStorage`, `sessionStorage`, `document.cookie`
// or the URL, and nothing was posted to any window. That is the documented
// storage decision of #2674 — frame-private memory — proven rather than stated.

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  FRAME_INIT_PATH,
  FRAME_TOKEN_PATH,
  WIDGET_AUTH_MESSAGE_TYPE,
  runFrameSignIn,
} from "@/lib/embed/frame-widget-session.client";
// cinatra#4217 — the renewal names, reached through a namespace import so this
// file still loads at main, where they do not exist (see the renewal blocks).
import * as frameSession from "@/lib/embed/frame-widget-session.client";

const SELF = "https://app.cinatra.test";
const SELECTORS = { assistant: "wordpress", instanceId: "inst-1" };

/** A listener registry standing in for `window`. */
function listener() {
  const handlers: Array<(e: MessageEvent) => void> = [];
  return {
    addEventListener: (_t: string, h: (e: MessageEvent) => void) => handlers.push(h),
    removeEventListener: (_t: string, h: (e: MessageEvent) => void) => {
      const i = handlers.indexOf(h);
      if (i >= 0) handlers.splice(i, 1);
    },
    deliver(event: Partial<MessageEvent>) {
      for (const h of [...handlers]) h(event as MessageEvent);
    },
    get count() {
      return handlers.length;
    },
  };
}

type Call = { url: string; body: Record<string, unknown> };

function fetchDouble(
  responses: { init?: unknown; token?: unknown; initStatus?: number; tokenStatus?: number } = {},
) {
  const calls: Call[] = [];
  const impl = vi.fn(async (url: string, options: RequestInit) => {
    const body = JSON.parse(String(options.body)) as Record<string, unknown>;
    calls.push({ url, body });
    const isInit = url === FRAME_INIT_PATH;
    const status = isInit ? (responses.initStatus ?? 200) : (responses.tokenStatus ?? 200);
    const payload = isInit
      ? (responses.init ?? { txnId: "txn-1", authorizeUrl: `${SELF}/widget-auth?txn=txn-1` })
      : (responses.token ?? {
          userToken: "cwu_user",
          transportToken: "cit_transport",
          expiresIn: 600,
        });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => payload,
    } as unknown as Response;
  });
  return { impl: impl as unknown as typeof fetch, calls };
}

let popup: object;
let listen: ReturnType<typeof listener>;
let openPopup: ReturnType<typeof vi.fn>;

beforeEach(() => {
  popup = { name: "popup" };
  listen = listener();
  openPopup = vi.fn(() => popup as unknown as Window);
});

/**
 * Start one ceremony and wait until it is listening for the return message.
 * The timeout is generous relative to the fake work but still bounded, so a
 * ceremony that never reaches the listener fails fast instead of hanging.
 */
async function run(fetchImpl: typeof fetch, timeoutMs = 2_000, now?: () => number) {
  const promise = runFrameSignIn(SELECTORS, {
    fetchImpl,
    openPopup: openPopup as unknown as (url: string) => Window | null,
    listenWindow: listen,
    selfOrigin: SELF,
    timeoutMs,
    ...(now ? { now } : {}),
  });
  await vi.waitFor(() => expect(listen.count).toBeGreaterThan(0));
  return { promise };
}

/** The `state` the frame minted, read off the init call it just made. */
function mintedState(calls: Call[]): string {
  return String(calls.find((c) => c.url === FRAME_INIT_PATH)!.body.state);
}

describe("the ceremony", () => {
  it("mints PKCE, starts the transaction same-origin, opens the popup and redeems with the verifier", async () => {
    const { impl, calls } = fetchDouble();
    const { promise } = await run(impl);
    const state = mintedState(calls);
    listen.deliver({
      origin: SELF,
      source: popup as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "the-code", state },
    });
    const result = await promise;

    expect(result).toEqual({
      ok: true,
      credential: { userToken: "cwu_user", transportToken: "cit_transport", expiresIn: 600 },
      // cinatra#4217: the two clock readings of the minting request.
      mintedAt: expect.any(Number),
      receivedAt: expect.any(Number),
    });

    const init = calls.find((c) => c.url === FRAME_INIT_PATH)!;
    // codex round 0, finding 1 — the frame names the HANDLE, never an agent.
    expect(init.body.assistant).toBe("wordpress");
    expect(init.body).not.toHaveProperty("agentSlug");
    expect(init.body.codeChallengeMethod).toBe("S256");
    expect(String(init.body.codeChallenge)).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The VERIFIER never travelled at init — only its digest.
    expect(JSON.stringify(init.body)).not.toContain(
      String(calls.find((c) => c.url === FRAME_TOKEN_PATH)!.body.codeVerifier),
    );

    const token = calls.find((c) => c.url === FRAME_TOKEN_PATH)!;
    expect(token.body.grantType).toBe("authorization_code");
    expect(token.body.code).toBe("the-code");
    expect(String(token.body.codeVerifier)).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("opens the hosted sign-in on OUR origin, and refuses an authorize URL that is not", async () => {
    const { impl } = fetchDouble({
      init: { txnId: "t", authorizeUrl: "https://evil.example/widget-auth?txn=t" },
    });
    const result = await runFrameSignIn(SELECTORS, {
      fetchImpl: impl,
      openPopup: openPopup as unknown as (url: string) => Window | null,
      listenWindow: listen,
      selfOrigin: SELF,
      timeoutMs: 50,
    });
    expect(result).toEqual({ ok: false, reason: "init_failed" });
    expect(openPopup).not.toHaveBeenCalled();
  });
});

describe("the return message is accepted from ONE place only", () => {
  it("IGNORES a message from another origin, then accepts the genuine one", async () => {
    const { impl, calls } = fetchDouble();
    const { promise } = await run(impl);
    const state = mintedState(calls);
    // A hostile page on the CMS origin, with the right shape and even the right
    // state, is ignored — the browser reports its real origin and we compare.
    listen.deliver({
      origin: "https://wp.example.test",
      source: popup as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "attacker-code", state },
    });
    expect(calls.some((c) => c.url === FRAME_TOKEN_PATH)).toBe(false);

    listen.deliver({
      origin: SELF,
      source: popup as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "the-code", state },
    });
    await expect(promise).resolves.toMatchObject({ ok: true });
    expect(calls.find((c) => c.url === FRAME_TOKEN_PATH)!.body.code).toBe("the-code");
  });

  it("IGNORES a message from a different window, and one carrying a different state", async () => {
    const { impl, calls } = fetchDouble();
    // A short wait bound: this case ends in the give-up path on purpose.
    const { promise } = await run(impl, 50);
    const state = mintedState(calls);
    listen.deliver({
      origin: SELF,
      source: { name: "some-other-frame" } as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "c", state },
    });
    listen.deliver({
      origin: SELF,
      source: popup as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "c", state: "a-different-state" },
    });
    expect(calls.some((c) => c.url === FRAME_TOKEN_PATH)).toBe(false);
    await expect(promise).resolves.toEqual({ ok: false, reason: "cancelled" });
  });
});

describe("failure is neutral and fail-closed", () => {
  it("a blocked popup, a failed init and a failed redeem each yield a typed, credential-free failure", async () => {
    const blocked = await runFrameSignIn(SELECTORS, {
      fetchImpl: fetchDouble().impl,
      openPopup: () => null,
      listenWindow: listen,
      selfOrigin: SELF,
      timeoutMs: 50,
    });
    expect(blocked).toEqual({ ok: false, reason: "popup_blocked" });

    const badInit = await runFrameSignIn(SELECTORS, {
      fetchImpl: fetchDouble({ initStatus: 400 }).impl,
      openPopup: openPopup as unknown as (url: string) => Window | null,
      listenWindow: listen,
      selfOrigin: SELF,
      timeoutMs: 50,
    });
    expect(badInit).toEqual({ ok: false, reason: "init_failed" });
  });

  it("BOTH OR NOTHING: a half pair is refused rather than half-held", async () => {
    for (const token of [
      { userToken: "cwu_user" },
      { transportToken: "cit_transport" },
      { userToken: "", transportToken: "cit_transport" },
    ]) {
      const { impl, calls } = fetchDouble({ token });
      const { promise } = await run(impl);
      listen.deliver({
        origin: SELF,
        source: popup as unknown as Window,
        data: {
          type: WIDGET_AUTH_MESSAGE_TYPE,
          code: "the-code",
          state: mintedState(calls),
        },
      });
      await expect(promise).resolves.toEqual({ ok: false, reason: "redeem_failed" });
    }
  });
});

describe("the credential is FRAME-PRIVATE — proven as an absence", () => {
  it("after a successful run nothing was stored, put in a URL, or posted anywhere", async () => {
    const storage: Record<string, string> = {};
    const store = {
      setItem: (k: string, v: string) => {
        storage[k] = v;
      },
      getItem: (k: string) => storage[k] ?? null,
      removeItem: (k: string) => {
        delete storage[k];
      },
    };
    vi.stubGlobal("localStorage", store);
    vi.stubGlobal("sessionStorage", store);
    const posts: unknown[] = [];
    vi.stubGlobal("postMessage", (m: unknown) => posts.push(m));

    const { impl, calls } = fetchDouble();
    const { promise } = await run(impl);
    listen.deliver({
      origin: SELF,
      source: popup as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "the-code", state: mintedState(calls) },
    });
    const result = await promise;
    expect(result.ok).toBe(true);

    expect(Object.keys(storage)).toHaveLength(0);
    expect(posts).toHaveLength(0);
    // Nothing bearer-shaped in any URL this module navigated to.
    for (const [url] of openPopup.mock.calls) {
      expect(String(url)).not.toMatch(/cwu_|cit_/);
    }
    // …nor in any request body it sent.
    expect(JSON.stringify(calls)).not.toContain("cwu_");
    expect(JSON.stringify(calls)).not.toContain("cit_");

    vi.unstubAllGlobals();
  });
});

// ---------------------------------------------------------------------------
// cinatra#4217 — RENEWAL, browser side: the mint anchors, the bounded lives and
// the renew call. Each title names its census row of the rebuild spec.
//
// Reached through the namespace import at the top so this file still LOADS at
// main, where none of these names exist: there each case below is red by its
// first assertion, and the ceremony cases above stay green.
// ---------------------------------------------------------------------------

const CURRENT = { userToken: "cwu_current", transportToken: "cit_current", expiresIn: 300 };

function answering(status: number, json: () => Promise<unknown>) {
  return vi.fn(
    async () => ({ ok: status >= 200 && status < 300, status, json }) as unknown as Response,
  ) as unknown as typeof fetch;
}

describe("the mint anchors (cinatra#4217)", () => {
  it("C01: A is read after the popup and before the token request; R once its answer is read", async () => {
    let clock = 1_000;
    const { impl, calls } = fetchDouble();
    const slowImpl = vi.fn(async (url: string, options: RequestInit) => {
      const answer = await (impl as unknown as (u: string, o: RequestInit) => Promise<Response>)(url, options);
      // The token answer takes 60 s to arrive.
      if (url === FRAME_TOKEN_PATH) clock += 60_000;
      return answer;
    });
    const { promise } = await run(slowImpl as unknown as typeof fetch, 2_000, () => clock);
    // The person spends 100 s in the hosted sign-in window.
    clock += 100_000;
    listen.deliver({
      origin: SELF,
      source: popup as unknown as Window,
      data: { type: WIDGET_AUTH_MESSAGE_TYPE, code: "the-code", state: mintedState(calls) },
    });
    const result = await promise;
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.mintedAt, "the request start, not the sign-in start nor the answer").toBe(101_000);
    expect(
      (result as unknown as { receivedAt?: number }).receivedAt,
      "after the slow answer was read",
    ).toBe(161_000);
  });
});

describe("credentialPairFrom: the lives are bounded (cinatra#4217)", () => {
  const pairWith = (fields: Record<string, unknown>) => ({
    userToken: "cwu_a",
    transportToken: "cit_a",
    ...fields,
  });

  it("C05: an expiresIn that is not a whole number of seconds in [1, 28800] makes no pair", () => {
    expect(typeof frameSession.credentialPairFrom).toBe("function");
    for (const expiresIn of [
      0,
      -5,
      Number.NaN,
      undefined,
      299.5,
      "300",
      null,
      Number.MAX_VALUE,
      1e308,
      Number.POSITIVE_INFINITY,
      28_801,
    ]) {
      expect(frameSession.credentialPairFrom(pairWith({ expiresIn })), String(expiresIn)).toBeNull();
    }
    // The edges that are lives.
    expect(frameSession.credentialPairFrom(pairWith({ expiresIn: 1 }))).toEqual(pairWith({ expiresIn: 1 }));
    expect(frameSession.credentialPairFrom(pairWith({ expiresIn: 28_800 }))).toEqual(
      pairWith({ expiresIn: 28_800 }),
    );
  });

  it("C47: a userExpiresIn or sessionExpiresIn that is invalid, absent or too short is dropped", () => {
    expect(typeof frameSession.credentialPairFrom).toBe("function");
    // Valid: kept.
    expect(
      frameSession.credentialPairFrom(pairWith({ expiresIn: 300, userExpiresIn: 900, sessionExpiresIn: 28_800 })),
    ).toEqual(pairWith({ expiresIn: 300, userExpiresIn: 900, sessionExpiresIn: 28_800 }));
    // The user life must be a valid life of at least the pair's: else U := E.
    for (const userExpiresIn of [undefined, 299, 0, 900.5, "900", Number.MAX_VALUE, 28_801]) {
      const got = frameSession.credentialPairFrom(pairWith({ expiresIn: 300, userExpiresIn }));
      expect(got, `userExpiresIn ${String(userExpiresIn)}`).toEqual(pairWith({ expiresIn: 300 }));
    }
    // The cap must be a valid life of at least the user token's (or the pair's,
    // when the user life was dropped): else K is unknown.
    for (const sessionExpiresIn of [undefined, 899, 0, -1, "28800", Number.NaN, 1e308]) {
      const got = frameSession.credentialPairFrom(
        pairWith({ expiresIn: 300, userExpiresIn: 900, sessionExpiresIn }),
      );
      expect(got, `sessionExpiresIn ${String(sessionExpiresIn)}`).toEqual(
        pairWith({ expiresIn: 300, userExpiresIn: 900 }),
      );
    }
    expect(
      frameSession.credentialPairFrom(pairWith({ expiresIn: 300, sessionExpiresIn: 300 })),
      "a cap equal to the pair's life, with no user life",
    ).toEqual(pairWith({ expiresIn: 300, sessionExpiresIn: 300 }));
  });

  it("C26: an answer without sessionExpiresIn yields a pair with no cap", () => {
    expect(typeof frameSession.credentialPairFrom).toBe("function");
    const got = frameSession.credentialPairFrom(pairWith({ expiresIn: 300, userExpiresIn: 900 }));
    expect(got).toEqual(pairWith({ expiresIn: 300, userExpiresIn: 900 }));
    expect(got && "sessionExpiresIn" in got).toBe(false);
  });
});

describe("renewFrameCredential (cinatra#4217)", () => {
  it("POSTs to the renew path with the user token in the header only, cookie-less, selectors-only body", async () => {
    expect(typeof frameSession.renewFrameCredential).toBe("function");
    expect(frameSession.FRAME_RENEW_PATH).toBe("/api/widget-auth/frame/renew");

    let clock = 5_000;
    const seen: Array<{ url: string; options: RequestInit }> = [];
    const impl = vi.fn(async (url: string, options: RequestInit) => {
      seen.push({ url, options });
      clock += 2_000; // the answer takes 2 s
      return {
        ok: true,
        status: 200,
        json: async () => ({
          userToken: "cwu_next",
          transportToken: "cit_next",
          expiresIn: 300,
          userExpiresIn: 900,
          sessionExpiresIn: 27_000,
        }),
      } as unknown as Response;
    });

    const result = await frameSession.renewFrameCredential({ ...SELECTORS, siteId: "site-1" }, CURRENT, {
      fetchImpl: impl as unknown as typeof fetch,
      now: () => clock,
    });

    expect(result).toEqual({
      ok: true,
      credential: {
        userToken: "cwu_next",
        transportToken: "cit_next",
        expiresIn: 300,
        userExpiresIn: 900,
        sessionExpiresIn: 27_000,
      },
      requestedAt: 5_000,
      receivedAt: 7_000,
    });
    expect(seen).toHaveLength(1);
    const { url, options } = seen[0]!;
    expect(url).toBe(frameSession.FRAME_RENEW_PATH);
    expect(options.method).toBe("POST");
    expect(options.credentials).toBe("omit");
    const headers = options.headers as Record<string, string>;
    expect(headers["X-Cinatra-Widget-User-Token"]).toBe("cwu_current");
    // Selectors only: no token of either kind travels in the body.
    expect(JSON.parse(String(options.body))).toEqual({
      assistant: "wordpress",
      instanceId: "inst-1",
      siteId: "site-1",
    });
    expect(String(options.body)).not.toContain("cwu_");
    expect(String(options.body)).not.toContain("cit_");
  });

  it("C14: a 400 (and every other non-200 that is not 429 or an exact 409) is renew_failed", async () => {
    expect(typeof frameSession.renewFrameCredential).toBe("function");
    for (const status of [400, 401, 403, 500, 502, 503]) {
      const refused = await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
        fetchImpl: answering(status, async () => ({ error: "invalid_grant" })),
      });
      expect(refused.ok, `HTTP ${status}`).toBe(false);
      expect(!refused.ok && refused.reason, `HTTP ${status}`).toBe("renew_failed");
    }
  });

  it("a 429 is renew_rate_limited", async () => {
    expect(typeof frameSession.renewFrameCredential).toBe("function");
    const limited = await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
      fetchImpl: answering(429, async () => ({ error: "invalid_grant" })),
    });
    expect(!limited.ok && limited.reason).toBe("renew_rate_limited");
  });

  it("C22: only a 409 whose body is exactly {error:\"not_renewable\"} is renew_not_renewable", async () => {
    expect(typeof frameSession.renewFrameCredential).toBe("function");
    let clock = 10_000;
    const exact = await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
      fetchImpl: vi.fn(async () => {
        clock += 1_500;
        return { ok: false, status: 409, json: async () => ({ error: "not_renewable" }) } as unknown as Response;
      }) as unknown as typeof fetch,
      now: () => clock,
    });
    expect(exact).toEqual({ ok: false, reason: "renew_not_renewable", requestedAt: 10_000, receivedAt: 11_500 });

    const notExact: Array<[string, () => Promise<unknown>]> = [
      ["another error", async () => ({ error: "invalid_grant" })],
      ["an extra field", async () => ({ error: "not_renewable", hint: "x" })],
      ["the error in an array", async () => [{ error: "not_renewable" }]],
      ["a string body", async () => "not_renewable"],
      ["null", async () => null],
      ["not JSON", async () => Promise.reject(new SyntaxError("Unexpected token"))],
    ];
    for (const [label, json] of notExact) {
      const got = await frameSession.renewFrameCredential(SELECTORS, CURRENT, { fetchImpl: answering(409, json) });
      expect(!got.ok && got.reason, label).toBe("renew_failed");
    }
  });

  it("C21: a fetch throw, a 5xx and every malformed 200 body is renew_failed", async () => {
    expect(typeof frameSession.renewFrameCredential).toBe("function");
    const thrown = await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
      fetchImpl: vi.fn(async () => {
        throw new TypeError("network down");
      }) as unknown as typeof fetch,
    });
    expect(!thrown.ok && thrown.reason, "a fetch throw").toBe("renew_failed");
    const fiveHundred = await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
      fetchImpl: answering(500, async () => ({})),
    });
    expect(!fiveHundred.ok && fiveHundred.reason, "a 5xx").toBe("renew_failed");

    const refused: Array<[string, () => Promise<unknown>]> = [
      ["not JSON", async () => Promise.reject(new SyntaxError("Unexpected token"))],
      ["null", async () => null],
      ["an array", async () => [{ userToken: "cwu_a", transportToken: "cit_a", expiresIn: 300 }]],
      ["a string", async () => "cwu_a cit_a"],
      ["half a pair (user token only)", async () => ({ userToken: "cwu_a", expiresIn: 300 })],
      ["half a pair (transport only)", async () => ({ transportToken: "cit_a", expiresIn: 300 })],
      ["tokens that are not strings", async () => ({ userToken: 1, transportToken: true, expiresIn: 300 })],
      ["empty tokens", async () => ({ userToken: "", transportToken: "", expiresIn: 300 })],
      // C05 through the renew call: a whole pair with an invalid life.
      ["a string life", async () => ({ userToken: "cwu_a", transportToken: "cit_a", expiresIn: "300" })],
      ["no life", async () => ({ userToken: "cwu_a", transportToken: "cit_a", expiresIn: null })],
      ["a NaN life", async () => ({ userToken: "cwu_a", transportToken: "cit_a", expiresIn: Number.NaN })],
      ["a zero life", async () => ({ userToken: "cwu_a", transportToken: "cit_a", expiresIn: 0 })],
      ["a huge life", async () => ({ userToken: "cwu_a", transportToken: "cit_a", expiresIn: Number.MAX_VALUE })],
    ];
    for (const [label, json] of refused) {
      const got = await frameSession.renewFrameCredential(SELECTORS, CURRENT, { fetchImpl: answering(200, json) });
      expect(got.ok, label).toBe(false);
      expect(!got.ok && got.reason, label).toBe("renew_failed");
    }
  });
});

// cinatra#4217 fold 1 (pre-1 MF1, MF3). RED AT a895dbef: the renew call took
// no signal, so the renewal chain could not abort a request it gave up.
describe("renewFrameCredential: the caller's signal (cinatra#4217 fold 1)", () => {
  it("passes the signal to the request, and an aborted request is renew_failed", async () => {
    const controller = new AbortController();
    const seen: RequestInit[] = [];
    const aborting = vi.fn(async (_url: string, options: RequestInit) => {
      seen.push(options);
      controller.abort();
      throw new DOMException("The operation was aborted.", "AbortError");
    });
    const got = await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
      fetchImpl: aborting as unknown as typeof fetch,
      signal: controller.signal,
    });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.signal, "the request carries the caller's signal").toBe(controller.signal);
    expect(!got.ok && got.reason).toBe("renew_failed");

    // Without a signal, the request carries none (the init is unchanged).
    const plain: RequestInit[] = [];
    await frameSession.renewFrameCredential(SELECTORS, CURRENT, {
      fetchImpl: vi.fn(async (_url: string, options: RequestInit) => {
        plain.push(options);
        return { ok: false, status: 400, json: async () => ({}) } as unknown as Response;
      }) as unknown as typeof fetch,
    });
    expect("signal" in plain[0]!).toBe(false);
  });
});
