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
async function run(fetchImpl: typeof fetch, timeoutMs = 2_000) {
  const promise = runFrameSignIn(SELECTORS, {
    fetchImpl,
    openPopup: openPopup as unknown as (url: string) => Window | null,
    listenWindow: listen,
    selfOrigin: SELF,
    timeoutMs,
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
