// ---------------------------------------------------------------------------
// THE FRAME-OWNED SIGN-IN (cinatra#2674, epic #2564 S8e).
//
// This is the browser half of "the iframe owns the sign-in and the token". It
// runs inside the Cinatra-served embed document, on the Cinatra origin, and it
// is the only place in the widget where a credential exists.
//
// THE CEREMONY, and who holds what at each step:
//   1. The frame mints a PKCE verifier and a `state`. BOTH stay in this module's
//      closure. The verifier is the thing that makes the authorization code
//      redeemable, and no other party ever sees it — that is the difference
//      between this flow and the retired one, where a CMS backend held it.
//   2. The frame POSTs the challenge to `/api/widget-auth/frame/init`
//      SAME-ORIGIN. It presents no credential; the server re-derives the site,
//      org, origin, agent and canonical instance from its own rows.
//   3. The frame opens the returned authorize URL in a POPUP. A popup, not an
//      inline view, because the hosted sign-in is a top-level Cinatra document:
//      its session cookie is FIRST-PARTY there, so it works in every browser
//      including those that block third-party cookies outright.
//   4. The hosted page posts {code, state} back to the CINATRA ORIGIN. This
//      module accepts it only when the origin is ours, the source window is the
//      popup we opened, and the state is the one we minted.
//   5. The frame POSTs code + verifier to `/api/widget-auth/frame/token` and
//      receives the credential pair. It lives in a closure for the life of this
//      document and nowhere else.
//
// WHAT THIS MODULE NEVER DOES, and the tests assert each one:
//   • never writes a credential to `localStorage`, `sessionStorage`, a cookie,
//     the URL, the DOM, or any log;
//   • never posts a credential to the parent (it never posts to the parent at
//     all — that is the bridge's job, and the bridge has no credential field);
//   • never accepts an authorization result from any origin but its own;
//   • never falls back to a credential handed in from outside.
//
// RE-AUTHENTICATION BEHAVIOUR, stated because it is the documented cost of
// keeping the credential in memory: a reload of the iframe loses the pair and
// runs the ceremony again. On every browser, step 3 lands on a TOP-LEVEL Cinatra
// document, so a person with a live Cinatra session is returned immediately with
// no typing; a person without one signs in. Nothing about this differs between
// browsers that allow third-party cookies and browsers that do not, which is
// exactly why the credential is held here rather than in a cookie the frame
// cannot rely on having.
//
// RENEWAL (cinatra#4217). While the frame stays open it renews the pair before it
// runs out (renewFrameCredential, driven by the renewal chain in
// frame-credential-renewal.client.ts), presenting the current user token
// same-origin and replacing the pair in memory. The server caps a renewed session
// at a maximum lifetime. A refusal that leaves the pair valid keeps it until its
// end; every other refusal returns the frame to its sign-in card, exactly like a
// reload does.
// ---------------------------------------------------------------------------

/** The public selectors the frame sends. Not authority — the server re-derives
 *  every authoritative binding and denies on mismatch. */
export type FrameSignInSelectors = {
  /** `?assistant` — the widget handle. The server maps it to the agent through
   *  its own CLOSED table; the frame never names an agent (codex round 0,
   *  finding 1). */
  assistant: string;
  instanceId: string;
  /** Optional public site handle, when the parent supplied one. Cross-checked
   *  server-side; omitting it changes nothing. */
  siteId?: string | null;
};

/** The credential pair, as it exists in this document and nowhere else. */
export type FrameWidgetCredential = {
  userToken: string;
  transportToken: string;
  /** The PAIR's life in whole seconds, as the server advertised it when it
   *  minted the pair: the shorter of the two tokens. Advisory: the server
   *  re-checks at every use. Always a valid life (isValidFrameLife). */
  expiresIn: number;
  /** cinatra#4217 — the USER token's own life in whole seconds, advisory. It is
   *  the token a renewal presents, so the renewal chain judges renewability on
   *  it. Absent when the server sent none, or one that is not a valid life of at
   *  least `expiresIn` (the chain then counts the user token as the pair). */
  userExpiresIn?: number;
  /** cinatra#4217 — the seconds left to the session cap, advisory. Absent when
   *  the server sent none, or one that is not a valid life of at least the user
   *  token's (the chain then treats the cap as unknown). */
  sessionExpiresIn?: number;
};

export type FrameSignInFailure =
  | "init_failed"
  | "popup_blocked"
  | "cancelled"
  | "redeem_failed"
  | "renew_failed"
  /** cinatra#4217: the renewal was refused by the rate limit (HTTP 429). The
   *  presented pair is unspent, so the renewal chain may try it again. */
  | "renew_rate_limited"
  /** cinatra#4217: the server verified the presented token but did not renew
   *  it (HTTP 409 `{error:"not_renewable"}`): the session cap, no more than the
   *  server's grace window left, or already renewed. The pair stays usable
   *  until its end, so the chain keeps it (frame-credential-renewal). */
  | "renew_not_renewable";

export type FrameSignInResult =
  | {
      ok: true;
      credential: FrameWidgetCredential;
      /** cinatra#4217 — this document's clock (ms) read just BEFORE the request
       *  that minted the pair was sent (after the popup). The server reads its
       *  clock after this moment, so `mintedAt + life` is never later than the
       *  real end. */
      mintedAt: number;
      /** cinatra#4217 — this document's clock (ms) read once the answer body was
       *  read. The server read its clock before this moment, so
       *  `receivedAt + life + 1 s` is never earlier than the real end. */
      receivedAt: number;
    }
  | { ok: false; reason: FrameSignInFailure };

/** What a renewal answers, with this document's clock read before the request
 *  went out (`requestedAt`) and once its answer was read (`receivedAt`). */
export type FrameRenewResult =
  | { ok: true; credential: FrameWidgetCredential; requestedAt: number; receivedAt: number }
  | { ok: false; reason: FrameSignInFailure; requestedAt: number; receivedAt: number };

/** The message the hosted return step posts to this origin. */
export const WIDGET_AUTH_MESSAGE_TYPE = "cinatra-widget-auth";

export const FRAME_INIT_PATH = "/api/widget-auth/frame/init";
export const FRAME_TOKEN_PATH = "/api/widget-auth/frame/token";
export const FRAME_RENEW_PATH = "/api/widget-auth/frame/renew";

/** cinatra#4217 — renew this long before the pair's end (when the user token
 *  is still renewable then). Generous on purpose: a hidden tab's timers may be
 *  throttled to about once a minute. */
export const FRAME_RENEW_MARGIN_SECONDS = 90;
/** Two renewal requests of one frame (retries of a rate-limited one aside) are
 *  at least this far apart, so a pair the server no longer extends cannot turn
 *  the chain into a busy loop. */
export const FRAME_RENEW_MIN_SPACING_SECONDS = 30;
/** The latency a renewal request may take to reach the server. A request is
 *  sent only while the user token has more than the server's grace window plus
 *  this left at this document's clock. */
export const FRAME_RENEW_SAFETY_SECONDS = 5;
/** A scheduled renewal fires at least this long before the last moment that
 *  is still renewable, so it fires as a request, never as a hold. */
export const FRAME_RENEW_FIRE_MARGIN_SECONDS = 1;
/** The longest life the frame accepts (the server's session cap). */
export const FRAME_LIFE_MAX_SECONDS = 8 * 60 * 60;
/** The server's grace window (USER_TOKEN_RENEW_GRACE_SECONDS in
 *  widget-user-auth.ts, which this client module cannot import): the server
 *  never renews a user token with no more than this left. */
export const FRAME_SERVER_RENEW_GRACE_SECONDS = 30;

/** cinatra#4217 — a life the frame accepts: a whole number of seconds from 1
 *  to FRAME_LIFE_MAX_SECONDS. Anything else (zero, negative, fractional, a
 *  string, NaN, an infinity, a huge finite number) is not a life. */
export function isValidFrameLife(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= FRAME_LIFE_MAX_SECONDS
  );
}

/** base64url without padding — the PKCE encoding. */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 32 bytes of CSPRNG entropy, base64url. Used for the PKCE verifier and for
 *  `state`; both are secrets this frame holds and nobody else does. */
export function mintFrameSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64url(bytes);
}

/** The S256 challenge for a verifier. The verifier never leaves this document;
 *  only its digest travels. */
export async function pkceChallengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return base64url(new Uint8Array(digest));
}

/**
 * The message-listening surface this module actually touches. Structural rather
 * than `Window`, for the same reason the bridge's port handle is: the contract is
 * two methods, and naming exactly those two lets a test supply a synchronous
 * double without a cast that would also hide a real mismatch.
 */
export type FrameMessageTarget = {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void;
  removeEventListener(type: "message", listener: (event: MessageEvent) => void): void;
};

/** The seams a test replaces. Defaults are the real browser. */
export type FrameSignInEnvironment = {
  fetchImpl?: typeof fetch;
  /** Opens the hosted sign-in. Returns the popup handle, or null when blocked. */
  openPopup?: (url: string) => Window | null;
  /** The window this frame listens on for the return message. */
  listenWindow?: FrameMessageTarget;
  /** This document's own origin. */
  selfOrigin?: string;
  /** How long to wait for the return message before giving up, ms. */
  timeoutMs?: number;
  /** cinatra#4217 — this document's clock, ms (the mint anchors). */
  now?: () => number;
};

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // the hosted transaction's own life

function defaultOpenPopup(url: string): Window | null {
  return window.open(url, "cinatra-widget-auth", "width=460,height=680");
}

/**
 * Run the whole ceremony and resolve with the credential pair, or a typed
 * failure. Every failure is neutral: the caller renders "sign in" again and
 * learns nothing it could report to the parent.
 */
export async function runFrameSignIn(
  selectors: FrameSignInSelectors,
  env: FrameSignInEnvironment = {},
): Promise<FrameSignInResult> {
  const doFetch = env.fetchImpl ?? fetch;
  const openPopup = env.openPopup ?? defaultOpenPopup;
  const listenWindow: FrameMessageTarget = env.listenWindow ?? (window as FrameMessageTarget);
  const selfOrigin = env.selfOrigin ?? window.location.origin;
  const timeoutMs = env.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = env.now ?? ((): number => Date.now());

  // 1. The two secrets this frame keeps.
  const verifier = mintFrameSecret();
  const state = mintFrameSecret();
  let codeChallenge: string;
  try {
    codeChallenge = await pkceChallengeFor(verifier);
  } catch {
    return { ok: false, reason: "init_failed" };
  }

  // 2. Start the transaction. Same-origin; no credential presented.
  let authorizeUrl: string;
  try {
    const response = await doFetch(FRAME_INIT_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Same-origin credentials so a person who ALREADY holds a Cinatra session
      // in this browser (a same-site or subdomain deployment) is recognised; on a
      // true third-party site the browser sends none and the flow proceeds
      // identically, because nothing here depends on a cookie.
      credentials: "same-origin",
      body: JSON.stringify({
        assistant: selectors.assistant,
        instanceId: selectors.instanceId,
        ...(selectors.siteId ? { siteId: selectors.siteId } : {}),
        codeChallenge,
        codeChallengeMethod: "S256",
        state,
      }),
    });
    if (!response.ok) return { ok: false, reason: "init_failed" };
    const body = (await response.json()) as { authorizeUrl?: unknown };
    const url = typeof body.authorizeUrl === "string" ? body.authorizeUrl : "";
    // The authorize URL must be on OUR origin. The server builds it that way;
    // this is the frame refusing to be navigated somewhere else by a response it
    // did not compose itself.
    if (!url || new URL(url, selfOrigin).origin !== selfOrigin) {
      return { ok: false, reason: "init_failed" };
    }
    authorizeUrl = url;
  } catch {
    return { ok: false, reason: "init_failed" };
  }

  // 3+4. LISTEN FIRST, THEN OPEN (codex round 0, finding 3).
  //
  // The listener is attached BEFORE the popup exists, and the popup handle it
  // compares against is assigned in the same synchronous turn as `window.open`
  // returns. In a browser the popup's own document cannot run while this
  // function's synchronous block is executing, so the original open-then-listen
  // order was already safe — but "safe because JavaScript is single-threaded
  // here" is a fact a reader has to re-derive every time. This order is safe
  // without the argument, and it costs nothing.
  //
  // The return message is accepted only when it comes from OUR origin, from THAT
  // window, and carries OUR state. A message failing any of the three is
  // IGNORED, not treated as a failure: a page receives unrelated messages, and
  // rejecting on one would let a bystander cancel a sign-in.
  let popup: Window | null = null;
  let settle!: (value: string | null) => void;
  const returned = new Promise<string | null>((resolve) => {
    settle = resolve;
  });
  let settled = false;
  const finish = (value: string | null) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    listenWindow.removeEventListener("message", onMessage);
    settle(value);
  };
  function onMessage(event: MessageEvent): void {
    if (event.origin !== selfOrigin) return;
    if (popup === null || event.source !== popup) return;
    const data = event.data as { type?: unknown; code?: unknown; state?: unknown };
    if (!data || typeof data !== "object") return;
    if (data.type !== WIDGET_AUTH_MESSAGE_TYPE) return;
    if (typeof data.state !== "string" || data.state !== state) return;
    if (typeof data.code !== "string" || data.code.length === 0) return;
    finish(data.code);
  }
  const timer = setTimeout(() => finish(null), timeoutMs);
  listenWindow.addEventListener("message", onMessage);

  popup = openPopup(authorizeUrl);
  if (!popup) {
    finish(null);
    return { ok: false, reason: "popup_blocked" };
  }

  const code = await returned;
  if (!code) return { ok: false, reason: "cancelled" };

  // 5. Redeem, same-origin, with the verifier that never left this closure.
  // cinatra#4217: the clock is read BEFORE the request goes out (the pair is
  // minted after this moment) and AGAIN once the answer is read (it was minted
  // before that moment). The renewal chain counts the pair's life from both.
  const mintedAt = now();
  try {
    const response = await doFetch(FRAME_TOKEN_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify({
        grantType: "authorization_code",
        assistant: selectors.assistant,
        instanceId: selectors.instanceId,
        ...(selectors.siteId ? { siteId: selectors.siteId } : {}),
        code,
        codeVerifier: verifier,
      }),
    });
    if (!response.ok) return { ok: false, reason: "redeem_failed" };
    const raw: unknown = await response.json();
    const receivedAt = now();
    const credential = credentialPairFrom(raw);
    if (!credential) return { ok: false, reason: "redeem_failed" };
    return { ok: true, credential, mintedAt, receivedAt };
  } catch {
    return { ok: false, reason: "redeem_failed" };
  }
}

/** Read the pair out of a ../token or ../renew answer. BOTH or NOTHING: a half
 *  pair cannot drive a turn, and holding one bearer with no way to use it is a
 *  credential in a browser for no benefit.
 *
 *  cinatra#4217 — the lives are bounded (isValidFrameLife). A pair whose
 *  `expiresIn` is not a valid life is refused like a half pair: nothing could
 *  schedule on it. A `userExpiresIn` that is not a valid life of at least
 *  `expiresIn`, and a `sessionExpiresIn` that is not a valid life of at least the
 *  user token's, are dropped (the chain then falls back on the pair's life and
 *  an unknown cap). */
export function credentialPairFrom(raw: unknown): FrameWidgetCredential | null {
  const body = (raw && typeof raw === "object" ? raw : {}) as {
    userToken?: unknown;
    transportToken?: unknown;
    expiresIn?: unknown;
    userExpiresIn?: unknown;
    sessionExpiresIn?: unknown;
  };
  const userToken = typeof body.userToken === "string" ? body.userToken : "";
  const transportToken =
    typeof body.transportToken === "string" ? body.transportToken : "";
  if (!userToken || !transportToken) return null;
  if (!isValidFrameLife(body.expiresIn)) return null;
  const expiresIn = body.expiresIn;
  const credential: FrameWidgetCredential = { userToken, transportToken, expiresIn };
  const userLife =
    isValidFrameLife(body.userExpiresIn) && body.userExpiresIn >= expiresIn
      ? body.userExpiresIn
      : undefined;
  if (userLife !== undefined) credential.userExpiresIn = userLife;
  if (
    isValidFrameLife(body.sessionExpiresIn) &&
    body.sessionExpiresIn >= (userLife ?? expiresIn)
  ) {
    credential.sessionExpiresIn = body.sessionExpiresIn;
  }
  return credential;
}

/** The exact body of the server's "verified, but not renewed" answer. */
function isNotRenewableBody(raw: unknown): boolean {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
  const keys = Object.keys(raw);
  return keys.length === 1 && keys[0] === "error" && (raw as { error?: unknown }).error === "not_renewable";
}

/**
 * cinatra#4217 — renew the pair this frame holds. Presents the CURRENT user
 * token, same-origin and cookie-less, and resolves with the replacement pair or
 * a neutral failure. The presented token is spent by a successful renewal, so
 * the caller must replace the pair it holds with the result. The answer carries
 * this document's clock read just before the request (`requestedAt`) and once
 * its answer was read (`receivedAt`).
 *
 * The failures the renewal chain tells apart:
 *   - 429: renew_rate_limited (refused before anything was verified or spent);
 *   - 409 with exactly `{error:"not_renewable"}`: renew_not_renewable (the token
 *     was verified and stays valid, but was not renewed);
 *   - everything else, including a malformed answer and a network error:
 *     renew_failed.
 */
export async function renewFrameCredential(
  selectors: FrameSignInSelectors,
  current: FrameWidgetCredential,
  env: Pick<FrameSignInEnvironment, "fetchImpl" | "now"> = {},
): Promise<FrameRenewResult> {
  const doFetch = env.fetchImpl ?? fetch;
  const now = env.now ?? ((): number => Date.now());
  const requestedAt = now();
  const failed = (reason: FrameSignInFailure): FrameRenewResult => ({
    ok: false,
    reason,
    requestedAt,
    receivedAt: now(),
  });
  try {
    const response = await doFetch(FRAME_RENEW_PATH, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Cinatra-Widget-User-Token": current.userToken,
      },
      credentials: "omit",
      body: JSON.stringify({
        assistant: selectors.assistant,
        instanceId: selectors.instanceId,
        ...(selectors.siteId ? { siteId: selectors.siteId } : {}),
      }),
    });
    if (response.status === 429) return failed("renew_rate_limited");
    if (response.status === 409) {
      let raw: unknown = null;
      try {
        raw = await response.json();
      } catch {
        raw = null;
      }
      return failed(isNotRenewableBody(raw) ? "renew_not_renewable" : "renew_failed");
    }
    if (!response.ok) return failed("renew_failed");
    const raw: unknown = await response.json();
    const receivedAt = now();
    const credential = credentialPairFrom(raw);
    if (!credential) return { ok: false, reason: "renew_failed", requestedAt, receivedAt };
    return { ok: true, credential, requestedAt, receivedAt };
  } catch {
    return failed("renew_failed");
  }
}
