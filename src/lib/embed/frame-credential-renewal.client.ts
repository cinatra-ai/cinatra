// ---------------------------------------------------------------------------
// THE FRAME CREDENTIAL'S RENEWAL CHAIN (cinatra#4217).
//
// The frame holds its credential pair in memory for the life of its document
// (frame-widget-session.client.ts). The pair's user token lives 15 minutes and
// its transport token 5, so a frame kept open longer than that renews the pair
// before it runs out. This module owns WHEN that happens and WHICH results still
// count. It is pure: no React, no DOM, no network of its own. The caller passes
// the one renewal call (renewFrameCredential, with the frame's selectors) and two
// hand-over callbacks.
//
// CLOCKS AND THE TWO BOUNDS. The chain never compares this document's clock with
// the server's. It uses the lives the server advertised (whole seconds, floored
// by the server, so never more than the real remaining life) and two readings of
// its own clock: A, just before the request that minted the pair was sent, and
// R, once its answer was read. The server read its clock between the two. For
// each deadline (the pair E, the user token U) that gives two bounds:
//   - lo = A + life: never later than the real end. Every RENEWAL decision
//     uses it, so a renewal is never late.
//   - hi = R + life + 1 s: never earlier than the real end. Every END decision
//     uses it, so the frame never drops a pair the server still accepts.
// A and R are clamped to the clock at arm time (a future anchor is not
// trusted), and A to R.
//
// THE ONE DECISION FUNCTION, decide(t). It runs at arm, at every timer fire and
// at the release of the last lease, and it answers exactly one of:
//   - END, when the pair is not renewable and t has reached the hold end
//     (E_hi, or the end a refusal set). onEnded runs exactly once.
//   - HOLD to the hold end, when the pair is not renewable before it. The pair
//     stays with the caller and no request is made.
//   - ARM a timer for fireAt, when the pair is renewable and fireAt lies ahead:
//       latest = U_lo - (grace + safety + fire margin)
//       want   = E_lo - margin (90 s)
//       fireAt = min(latest, max(want, the previous request's start + 30 s))
//   - RENEW NOW, when the pair is renewable and fireAt has come. Deferred while
//     a lease is held (see lease()).
// "Renewable" is: the pair does not already reach the session cap, the USER
// token has more than the server's grace window plus the request latency left
// at this document's clock, and no refusal put the chain on hold. A timer set
// for fireAt therefore fires as a request: at fireAt the user token still has
// one fire margin more than that. A timer that fires late (a suspended tab) is
// decided again like any other, and holds or ends instead.
//
// REFUSALS. A 429 refused the request before anything was verified or spent:
// the same pair is tried again after 5, 10, 20 and 40 s, each wait cut to the
// last renewable moment and dropped when under 1 s; then the chain holds. A 409
// "not_renewable" verified the token without renewing it: the chain holds to the
// earlier of E_hi and the answer's arrival plus the grace window plus 1 s (the
// server leaves the presented token at most the grace window from its claim
// instant), then ends. Every other refusal ends the chain at once.
//
// GENERATIONS. Every arm(), dispose() and new hold starts a new generation. A
// timer callback, or a renew() answer, of an older generation is DROPPED
// silently: no onRenewed, no onEnded, no new timer. That is the cancellation
// story: the caller may dispose at any moment, even while a renewal is in
// flight; the request cannot be recalled, but its answer reaches nobody. A
// dropped success leaves a spent token behind on the server, which is harmless.
//
// TIMERS are saturated to FRAME_TIMER_CHUNK_MS. A fire before its moment simply
// decides again, so no timer argument can overflow the platform timer. At most
// one timer is live at a time.
//
// WHAT THIS MODULE NEVER DOES: it never logs, stores or posts a credential. The
// pair passes through its closure to renew() and onRenewed() and nowhere else.
// ---------------------------------------------------------------------------

import {
  FRAME_RENEW_FIRE_MARGIN_SECONDS,
  FRAME_RENEW_MARGIN_SECONDS,
  FRAME_RENEW_MIN_SPACING_SECONDS,
  FRAME_RENEW_SAFETY_SECONDS,
  FRAME_SERVER_RENEW_GRACE_SECONDS,
  isValidFrameLife,
  type FrameSignInFailure,
  type FrameWidgetCredential,
} from "./frame-widget-session.client";

/** No timer of the chain is set for longer than this; a fire before its
 *  moment decides again. */
export const FRAME_TIMER_CHUNK_MS = 3_600_000;

/** The waits before each retry of a rate-limited renewal (at most four). */
export const FRAME_RENEW_RETRY_DELAYS_SECONDS: readonly number[] = [5, 10, 20, 40];

/** The lives an answer advertised, in whole seconds (see FrameWidgetCredential). */
export type FrameCredentialLives = {
  expiresIn: number;
  userExpiresIn?: number;
  sessionExpiresIn?: number;
};

/** What one renewal call answers. renewFrameCredential's result fits this
 *  shape as it is. `receivedAt` is this document's clock once the answer was
 *  read; when it is missing the chain reads its own clock instead. */
export type FrameRenewalOutcome =
  | { ok: true; credential: FrameWidgetCredential; receivedAt?: number }
  | { ok: false; reason?: FrameSignInFailure; receivedAt?: number };

export type FrameRenewalTimerHandle = unknown;

export type FrameRenewalState =
  | "idle"
  | "armed"
  | "renewing"
  | "retry_wait"
  | "holding"
  | "ended";

export type FrameCredentialRenewalDeps = {
  /** Renew the pair. Presents `credential` and resolves with its replacement or
   *  a refusal. A rejection counts as a refusal that ends the chain. */
  renew: (credential: FrameWidgetCredential) => Promise<FrameRenewalOutcome>;
  /** The chain produced a new pair. The caller replaces the one it holds. */
  onRenewed: (credential: FrameWidgetCredential) => void;
  /** The chain ended. Called once per chain; nothing re-arms. */
  onEnded: () => void;
  /** Timer seams. Defaults are the global timers, read at call time so a test's
   *  fake timers apply even when installed after this instance was made. */
  setTimer?: (callback: () => void, ms: number) => FrameRenewalTimerHandle;
  clearTimer?: (handle: FrameRenewalTimerHandle) => void;
  /** Clock seam. Default Date.now, read at call time. */
  now?: () => number;
};

export type FrameCredentialRenewal = {
  /** Start a new chain for `credential`, cancelling any earlier one. `mintedAt`
   *  is A and `receivedAt` is R of the request that minted the pair. */
  arm: (
    credential: FrameWidgetCredential,
    lives: FrameCredentialLives,
    mintedAt: number,
    receivedAt: number,
  ) => void;
  /** Hold a NEGOTIATION LEASE: while any lease is held, a RENEW NOW decision is
   *  deferred (no request), and HOLD and END still apply. Returns an idempotent
   *  release; the release of the last lease decides again at once. */
  lease: () => () => void;
  /** Settles when no renewal request is in flight. */
  quiesce: () => Promise<void>;
  /** Cancel the pending timer, invalidate any renewal in flight and drop every
   *  lease and deferred renewal. Not terminal: a later arm() starts afresh. */
  dispose: () => void;
  /** The current generation. Changes on every arm(), dispose() and new hold. */
  readonly generation: number;
  readonly state: FrameRenewalState;
  /** True while a RENEW NOW decision waits for the last lease's release. */
  readonly deferred: boolean;
};

const G_MS = FRAME_SERVER_RENEW_GRACE_SECONDS * 1000;
const S_MS = FRAME_RENEW_SAFETY_SECONDS * 1000;
const FIRE_MS = FRAME_RENEW_FIRE_MARGIN_SECONDS * 1000;
const MARGIN_MS = FRAME_RENEW_MARGIN_SECONDS * 1000;
const SPACING_MS = FRAME_RENEW_MIN_SPACING_SECONDS * 1000;

type Chain = {
  credential: FrameWidgetCredential;
  /** False when A was not a finite number: the lo bounds are unknown. */
  loKnown: boolean;
  eLo: number;
  eHi: number;
  uLo: number;
  capReached: boolean;
  holdEnd: number;
  holdByRefusal: boolean;
  retries: number;
  ended: boolean;
};

export function createFrameCredentialRenewal(
  deps: FrameCredentialRenewalDeps,
): FrameCredentialRenewal {
  const setTimer =
    deps.setTimer ??
    ((callback: () => void, ms: number): FrameRenewalTimerHandle =>
      globalThis.setTimeout(callback, ms));
  const clearTimer =
    deps.clearTimer ??
    ((handle: FrameRenewalTimerHandle): void =>
      globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const now = deps.now ?? ((): number => Date.now());

  let generation = 0;
  let state: FrameRenewalState = "idle";
  let chain: Chain | null = null;
  let timer: { handle: FrameRenewalTimerHandle } | null = null;
  /** The start of the previous renewal request of this frame's chain (kept
   *  across the re-arm a success makes; cleared by dispose). */
  let lastAttempt: number | null = null;
  let leases = 0;
  let leaseEpoch = 0;
  let deferred = false;
  let deferredRetry = false;
  let inflight: Promise<void> | null = null;

  function cancelTimer(): void {
    if (timer) {
      clearTimer(timer.handle);
      timer = null;
    }
  }

  /** Set the chain's one timer, saturated to the chunk; its callback is dropped
   *  once the generation has moved on. */
  function setChainTimer(armedGeneration: number, ms: number, run: () => void): void {
    cancelTimer();
    const wait = Number.isFinite(ms)
      ? Math.min(FRAME_TIMER_CHUNK_MS, Math.max(1, Math.ceil(ms)))
      : FRAME_TIMER_CHUNK_MS;
    const entry: { handle: FrameRenewalTimerHandle } = { handle: undefined };
    entry.handle = setTimer(() => {
      if (timer === entry) timer = null;
      if (armedGeneration !== generation) return;
      run();
    }, wait);
    timer = entry;
  }

  function end(c: Chain): void {
    if (c.ended) return;
    c.ended = true;
    cancelTimer();
    state = "ended";
    deferred = false;
    deferredRetry = false;
    deps.onEnded();
  }

  function renewable(c: Chain, t: number): boolean {
    if (c.capReached || c.holdByRefusal) return false;
    // A chain with unknown lo bounds (A was not a finite number) has exactly
    // one attempt; its refusal sets holdByRefusal.
    if (!c.loKnown) return true;
    return c.uLo - t > G_MS + S_MS;
  }

  /** THE decision function (see the header). `retry` is set when a 429 retry
   *  timer fires: the retry then goes out at once when the pair is renewable. */
  function decide(t: number, retry: boolean): void {
    const c = chain;
    if (!c || c.ended) return;
    if (!renewable(c, t)) {
      if (t >= c.holdEnd) {
        end(c);
        return;
      }
      // HOLD: a new hold moves the generation, so nothing of the state it
      // leaves can still act.
      if (state !== "holding") generation += 1;
      state = "holding";
      deferred = false;
      deferredRetry = false;
      const held = generation;
      setChainTimer(held, c.holdEnd - t, () => decide(now(), false));
      return;
    }
    let fireAt = Number.NEGATIVE_INFINITY;
    if (c.loKnown && !retry) {
      const latest = c.uLo - (G_MS + S_MS + FIRE_MS);
      const want = c.eLo - MARGIN_MS;
      const earliest = lastAttempt === null ? Number.NEGATIVE_INFINITY : lastAttempt + SPACING_MS;
      fireAt = Math.min(latest, Math.max(want, earliest));
    }
    const armed = generation;
    if (fireAt > t) {
      state = "armed";
      setChainTimer(armed, fireAt - t, () => decide(now(), false));
      return;
    }
    // RENEW NOW.
    if (leases > 0) {
      // Deferred: no request while a negotiation is in flight. The pair keeps
      // its timer for the moment it stops being renewable, so HOLD and END
      // still apply under the lease.
      state = "armed";
      deferred = true;
      deferredRetry = retry;
      if (c.loKnown) {
        const stops = c.uLo - (G_MS + S_MS);
        setChainTimer(armed, stops - t, () => decide(now(), retry));
      } else {
        cancelTimer();
      }
      return;
    }
    renewNow(c, armed);
  }

  function renewNow(c: Chain, armedGeneration: number): void {
    cancelTimer();
    state = "renewing";
    deferred = false;
    deferredRetry = false;
    // A' of the pair this request mints: the server reads its clock after it.
    const requestedAt = now();
    lastAttempt = requestedAt;
    const presented = c.credential;
    const run = (async (): Promise<void> => {
      let outcome: FrameRenewalOutcome;
      try {
        outcome = await deps.renew(presented);
      } catch {
        outcome = { ok: false };
      }
      // The answer of a chain the caller has let go of reaches nobody.
      if (armedGeneration !== generation || chain !== c) return;
      const receivedAt =
        typeof outcome.receivedAt === "number" && Number.isFinite(outcome.receivedAt)
          ? outcome.receivedAt
          : now();
      if (outcome.ok) {
        const renewed = outcome.credential;
        deps.onRenewed(renewed);
        // onRenewed may itself have disposed or re-armed; then that call owns
        // the chain and this one stops here.
        if (armedGeneration !== generation || chain !== c) return;
        arm(renewed, livesOf(renewed), requestedAt, receivedAt);
        return;
      }
      if (!c.loKnown) {
        // The single attempt of a chain with unknown lo bounds: any refusal
        // holds to E_hi (counted from R), then ends.
        c.holdByRefusal = true;
        c.holdEnd = c.eHi;
        decide(now(), false);
        return;
      }
      if (outcome.reason === "renew_not_renewable") {
        c.holdByRefusal = true;
        c.holdEnd = Math.min(c.eHi, receivedAt + G_MS + 1000);
        decide(now(), false);
        return;
      }
      if (outcome.reason === "renew_rate_limited") {
        const backoff = FRAME_RENEW_RETRY_DELAYS_SECONDS[c.retries];
        if (backoff !== undefined) {
          const t = now();
          const latest = c.uLo - (G_MS + S_MS + FIRE_MS);
          const wait = Math.min(backoff * 1000, latest - t);
          if (wait >= 1000) {
            c.retries += 1;
            state = "retry_wait";
            setChainTimer(armedGeneration, wait, () => decide(now(), true));
            return;
          }
        }
        c.holdByRefusal = true;
        decide(now(), false);
        return;
      }
      end(c);
    })();
    inflight = run;
    void run.finally(() => {
      if (inflight === run) inflight = null;
    });
  }

  function livesOf(credential: FrameWidgetCredential): FrameCredentialLives {
    return {
      expiresIn: credential.expiresIn,
      ...(credential.userExpiresIn !== undefined ? { userExpiresIn: credential.userExpiresIn } : {}),
      ...(credential.sessionExpiresIn !== undefined
        ? { sessionExpiresIn: credential.sessionExpiresIn }
        : {}),
    };
  }

  function arm(
    credential: FrameWidgetCredential,
    lives: FrameCredentialLives,
    mintedAt: number,
    receivedAt: number,
  ): void {
    cancelTimer();
    generation += 1;
    deferred = false;
    deferredRetry = false;
    const t = now();
    const lifeE = lives.expiresIn;
    const c: Chain = {
      credential,
      loKnown: false,
      eLo: Number.NaN,
      eHi: Number.NaN,
      uLo: Number.NaN,
      capReached: false,
      holdEnd: Number.NaN,
      holdByRefusal: false,
      retries: 0,
      ended: false,
    };
    chain = c;
    state = "armed";
    // An invalid pair life: the pair is unusable. End at once, with no request.
    if (!isValidFrameLife(lifeE)) {
      end(c);
      return;
    }
    const lifeU =
      isValidFrameLife(lives.userExpiresIn) && lives.userExpiresIn >= lifeE
        ? lives.userExpiresIn
        : lifeE;
    const lifeK =
      isValidFrameLife(lives.sessionExpiresIn) && lives.sessionExpiresIn >= lifeU
        ? lives.sessionExpiresIn
        : null;
    c.capReached = lifeK !== null && lifeE >= lifeK;
    // Without a finite R there is no hi bound, so no end the chain could hold
    // to: end at once.
    if (typeof receivedAt !== "number" || !Number.isFinite(receivedAt)) {
      end(c);
      return;
    }
    const r = Math.min(receivedAt, t);
    c.eHi = r + (lifeE + 1) * 1000;
    c.holdEnd = c.eHi;
    if (typeof mintedAt === "number" && Number.isFinite(mintedAt)) {
      const a = Math.min(mintedAt, t, r);
      c.loKnown = true;
      c.eLo = a + lifeE * 1000;
      c.uLo = a + lifeU * 1000;
    }
    decide(t, false);
  }

  function lease(): () => void {
    const epoch = leaseEpoch;
    leases += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (epoch !== leaseEpoch) return;
      leases -= 1;
      if (leases === 0 && deferred) {
        const retry = deferredRetry;
        deferred = false;
        deferredRetry = false;
        decide(now(), retry);
      }
    };
  }

  async function quiesce(): Promise<void> {
    while (inflight) {
      await inflight.catch(() => undefined);
    }
  }

  function dispose(): void {
    cancelTimer();
    generation += 1;
    chain = null;
    state = "idle";
    lastAttempt = null;
    deferred = false;
    deferredRetry = false;
    leases = 0;
    leaseEpoch += 1;
  }

  return {
    arm,
    lease,
    quiesce,
    dispose,
    get generation() {
      return generation;
    },
    get state() {
      return state;
    },
    get deferred() {
      return deferred;
    },
  };
}
