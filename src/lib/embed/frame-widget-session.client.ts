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
  /** Seconds from mint. Advisory — the server re-checks at every use. */
  expiresIn: number;
};

export type FrameSignInFailure =
  | "init_failed"
  | "popup_blocked"
  | "cancelled"
  | "redeem_failed";

export type FrameSignInResult =
  | { ok: true; credential: FrameWidgetCredential }
  | { ok: false; reason: FrameSignInFailure };

/** A renewal answers one of two ways and says nothing else. There is one
 *  failure name, deliberately: the frame does exactly the same thing for every
 *  refusal — keeps the pair it has and stops asking — so a second name would be
 *  a distinction nothing acts on and an oracle a page could read. */
export type FrameRenewResult =
  | { ok: true; credential: FrameWidgetCredential }
  | { ok: false; reason: "renew_failed" };

/** The message the hosted return step posts to this origin. */
export const WIDGET_AUTH_MESSAGE_TYPE = "cinatra-widget-auth";

export const FRAME_INIT_PATH = "/api/widget-auth/frame/init";
export const FRAME_TOKEN_PATH = "/api/widget-auth/frame/token";
/** The RENEWAL road (cinatra#3051). Same origin, same document, same rules
 *  as the mint above — the only road on which this frame ever presents the
 *  bearer it holds back to Cinatra. */
export const FRAME_RENEW_PATH = "/api/widget-auth/frame/renew";
/** The header the bearer travels on — here and on every turn. A credential
 *  belongs in a header and not in a body a log can swallow, and having ONE
 *  way to present it is what keeps that true. */
export const WIDGET_USER_TOKEN_HEADER = "X-Cinatra-Widget-User-Token";

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
    const body = (await response.json()) as {
      userToken?: unknown;
      transportToken?: unknown;
      expiresIn?: unknown;
    };
    const userToken = typeof body.userToken === "string" ? body.userToken : "";
    const transportToken =
      typeof body.transportToken === "string" ? body.transportToken : "";
    // BOTH or NOTHING. A half pair cannot drive a turn, and holding one bearer
    // with no way to use it is a credential in a browser for no benefit.
    if (!userToken || !transportToken) return { ok: false, reason: "redeem_failed" };
    const expiresIn =
      typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)
        ? body.expiresIn
        : 0;
    return { ok: true, credential: { userToken, transportToken, expiresIn } };
  } catch {
    return { ok: false, reason: "redeem_failed" };
  }
}

// ---------------------------------------------------------------------------
// THE RENEWAL (cinatra#3051), beside the mint and deliberately much smaller.
//
// The ceremony above exists because a credential has to be CREATED out of a
// person's sign-in, and that takes a popup, a verifier, a code and four hops.
// A renewal creates nothing: it presents the pair this document already holds
// and asks for the same authorization with a fresh life. So it is one
// same-origin round trip with no window, no listener and no secret of its own —
// and the smallness is the property, not a shortcut. Everything that decides
// whether it is allowed is on the server, in the same module that decided it
// the first time.
//
// WHAT THE FRAME DOES WITH A REFUSAL: nothing visible. It keeps the pair it has
// until that pair's own life ends, and the column degrades exactly as it did
// before this existed. A person who has signed out somewhere else, a site that
// was revoked, a network that was down for the one moment this asked — all of
// them look the same from here, and all of them mean "stop asking".
// ---------------------------------------------------------------------------

/** The seams a test replaces for the renewal. The default is the real browser. */
export type FrameRenewEnvironment = {
  fetchImpl?: typeof fetch;
};

/**
 * Present the held bearer and adopt the pair that comes back, or refuse.
 *
 * BOTH OR NOTHING, like the redeem: a half pair cannot drive a turn, and
 * adopting one half would swap a working credential for a broken one — the
 * failure mode this whole leg exists to remove, arrived at from the other side.
 */
export async function renewFrameCredential(
  selectors: FrameSignInSelectors,
  credential: FrameWidgetCredential,
  env: FrameRenewEnvironment = {},
): Promise<FrameRenewResult> {
  const doFetch = env.fetchImpl ?? fetch;
  if (!credential?.userToken) return { ok: false, reason: "renew_failed" };
  // A HUNG ASK IS A REFUSAL, not a wait without end. Without this, a request
  // that never settles takes the chain with it: the attempt never completes, the
  // next one is never armed, and the column dies at its current expiry with no
  // further ask ever made. The ceiling is generous enough that a slow network
  // still renews and short enough that the retry above it still has room inside
  // the life being renewed.
  const controller = new AbortController();
  const bell = setTimeout(() => controller.abort(), RENEW_REQUEST_TIMEOUT_MS);
  try {
    const response = await doFetch(FRAME_RENEW_PATH, {
      signal: controller.signal,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        // THE BEARER, on the header. It is never a body field — see the route.
        [WIDGET_USER_TOKEN_HEADER]: credential.userToken,
      },
      credentials: "same-origin",
      body: JSON.stringify({
        grantType: "widget_token_renewal",
        // SELECTORS ONLY, exactly as at the mint: the server re-derives the
        // site, origin and agent from its own rows and judges the renewal
        // against those. Nothing here is authority.
        assistant: selectors.assistant,
        instanceId: selectors.instanceId,
        ...(selectors.siteId ? { siteId: selectors.siteId } : {}),
      }),
    });
    if (!response.ok) return { ok: false, reason: "renew_failed" };
    const body = (await response.json()) as {
      userToken?: unknown;
      transportToken?: unknown;
      expiresIn?: unknown;
    };
    const userToken = typeof body.userToken === "string" ? body.userToken : "";
    const transportToken =
      typeof body.transportToken === "string" ? body.transportToken : "";
    if (!userToken || !transportToken) return { ok: false, reason: "renew_failed" };
    const expiresIn =
      typeof body.expiresIn === "number" && Number.isFinite(body.expiresIn)
        ? body.expiresIn
        : 0;
    return { ok: true, credential: { userToken, transportToken, expiresIn } };
  } catch {
    return { ok: false, reason: "renew_failed" };
  } finally {
    clearTimeout(bell);
  }
}

/** The floor under the schedule below, in milliseconds. A server that stated an
 *  absurdly short life must not turn the renewal into a spin. */
const RENEW_FLOOR_MS = 5_000;

/** How long one renewal ask may take before it counts as refused. */
const RENEW_REQUEST_TIMEOUT_MS = 10_000;

/**
 * WHEN to ask, from the life the server stated.
 *
 * Two thirds of the way through, so a refused attempt still leaves the pair
 * usable for the last third and the column keeps working while the chain gives
 * up quietly. `null` when the server stated no life at all — there is nothing to
 * schedule against, and guessing a number here would be inventing a clock the
 * server never gave us.
 */
export function frameCredentialRenewDelayMs(expiresIn: number): number | null {
  if (!Number.isFinite(expiresIn) || expiresIn <= 0) return null;
  return Math.max(RENEW_FLOOR_MS, Math.floor((expiresIn * 1000 * 2) / 3));
}

// ---------------------------------------------------------------------------
// A REFUSAL IS NOT ALWAYS AN ANSWER (cinatra#3051 convergence).
//
// The first shape of this chain treated every failure as terminal, which reads
// as caution and is not: a signed-out person and a network that was down for one
// second look identical from here, and treating both as final means ONE dropped
// request ends a column that would have gone on working for hours. The pair is
// asked for with a third of its life still ahead of it, so there is room for a
// few short retries inside that third and no room at all for more than a few.
//
// So a failed ask is retried on a short fixed delay, a bounded number of times,
// and only then does the chain stop. A person who really has signed out costs
// the server three refused asks and nothing else.
// ---------------------------------------------------------------------------

/** How many further asks a failed renewal may make before the chain gives up. */
export const FRAME_RENEW_RETRY_LIMIT = 3;

/**
 * WHEN to ask again after a refusal — or `null` once the tries are spent.
 *
 * A fixed short delay rather than a growing one: the whole retry budget has to
 * fit inside the last third of a life that may be as short as a few minutes, and
 * a backoff that grew would spend that third waiting rather than asking.
 */
export function frameCredentialRenewRetryDelayMs(failures: number): number | null {
  if (!Number.isFinite(failures) || failures < 1) return null;
  if (failures > FRAME_RENEW_RETRY_LIMIT) return null;
  return 15_000;
}
