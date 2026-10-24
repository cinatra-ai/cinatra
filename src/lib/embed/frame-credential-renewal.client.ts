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
// THE CHAIN:
//   1. arm(credential, expiresIn, mintedAt) sets ONE timer for
//      frameRenewalDelayMs(life left), that is max(left - 90, 30) seconds,
//      where the life left is counted from `mintedAt`, the clock reading taken
//      just before the request that minted the pair. THE LIFE IS ANCHORED TO
//      THE MINT and never restarts after awaited work: a caller that arms only
//      once its own work is done (the frame arms after its negotiation) still
//      renews 90 s before the pair's real end, not 90 s before "now + life".
//      A mint time that is not a finite number, or that lies ahead of the
//      clock, is never trusted beyond now (the life left is then at most the
//      advertised one; a non-finite one counts as none left: the 30 s floor).
//   2. When it fires, renew(credential) runs with the credential it was armed
//      with. The server spends that token on success. The chain reads the
//      clock just BEFORE it asks: that is the new pair's mint anchor.
//   3. On success: onRenewed(newCredential) FIRST, so the caller holds the new
//      pair before anything else can run, THEN arm(newCredential,
//      newCredential.expiresIn, the request start of step 2), so a slow
//      answer shortens the next wait instead of pushing it past the pair's
//      end.
//   4. On a refusal or a throw: onEnded() exactly once, and nothing re-arms. The
//      caller drops the pair and returns to its sign-in card.
//   5. On a RATE-LIMIT refusal (reason "renew_rate_limited", an HTTP 429): the
//      server refused before it verified, claimed or minted anything (it has
//      read the header and the body and hashed the bearer only to key its
//      limiter), so the pair is unspent. The
//      chain tries the SAME pair again after FRAME_RENEW_RETRY_DELAYS_SECONDS
//      (5, 10, 20, 40 s; at most four retries). Each retry is SCHEDULED only
//      while it can still fire with more than FRAME_RENEW_RETRY_FLOOR_SECONDS
//      of the pair's life left (the server's grace window: a token with less
//      is never renewed); a retry that would fire later is moved to the last
//      moment that still fits. When its timer FIRES, the retry reads the clock
//      again: a timer that fired late (a suspended or throttled tab) and finds
//      no more than the floor left presents nothing, and step 4 applies. When
//      no retry fits, or the retries are used up, step 4 applies too.
//      (The FIRST attempt of a chain is not checked against the pair's
//      advertised end: a frame suspended past it presents its user token
//      once, and the server decides on that token alone. It renews it while
//      the token has more than the grace window left, and refuses it
//      otherwise; then step 4 applies. A 429 then ends the chain, because no
//      retry fits. There is no renewal on wake.)
//      This stays fail-closed: a retry presents a pair the server already
//      accepts for every other call, and every answer but a success ends the
//      chain in the end. (A shared address bucket can be filled by others,
//      and a 429 must not end a session that could still renew.)
//
// GENERATIONS. Every arm() and every dispose() starts a new generation. A timer
// callback, or a renew() result, that belongs to an older generation is DROPPED
// silently: no onRenewed, no onEnded, no new timer. That is the whole
// cancellation story, and it is why the caller can dispose at any moment (an
// unmount, a new context from the parent, a new sign-in) even while a renewal is
// in flight: the request cannot be recalled, but its answer can no longer reach
// the caller or start another timer. A dropped success leaves a spent token
// behind on the server, which is harmless: the caller has already let go of
// that chain.
//
// dispose() is not terminal. A later arm() starts a fresh chain, so a caller may
// keep one instance for its whole life.
//
// WHAT THIS MODULE NEVER DOES: it never logs, stores or posts a credential. The
// pair passes through its closure to renew() and onRenewed() and nowhere else.
// ---------------------------------------------------------------------------

import {
  frameRenewalDelayMs,
  type FrameSignInFailure,
  type FrameWidgetCredential,
} from "./frame-widget-session.client";

/** What one renewal call answers. renewFrameCredential's `{ ok: false, reason }`
 *  fits this shape as it is. The chain reads one reason only:
 *  "renew_rate_limited" is retried (step 5); every other refusal ends it. */
export type FrameRenewalOutcome =
  | { ok: true; credential: FrameWidgetCredential }
  | { ok: false; reason?: FrameSignInFailure };

/** cinatra#4217 — the waits before each retry of a rate-limited renewal. Four
 *  retries at most; their sum (75 s) is less than the 90 s renewal margin. */
export const FRAME_RENEW_RETRY_DELAYS_SECONDS: readonly number[] = [5, 10, 20, 40];
/** A retry is scheduled, and presented when its timer fires, only while the
 *  pair has MORE than this left: the server never renews a token with no more
 *  life than its 30 s grace window. */
export const FRAME_RENEW_RETRY_FLOOR_SECONDS = 30;

export type FrameRenewalTimerHandle = unknown;

export type FrameCredentialRenewalDeps = {
  /** Renew the pair. Presents `credential` and resolves with its replacement or
   *  a refusal. A rejection counts as a refusal. */
  renew: (credential: FrameWidgetCredential) => Promise<FrameRenewalOutcome>;
  /** The chain produced a new pair. The caller replaces the one it holds. */
  onRenewed: (credential: FrameWidgetCredential) => void;
  /** The chain ended on a refusal. Called once per chain; nothing re-arms. */
  onEnded: () => void;
  /** Timer seams. Defaults are the global timers, read at call time so a test's
   *  fake timers apply even when installed after this instance was made. */
  setTimer?: (callback: () => void, ms: number) => FrameRenewalTimerHandle;
  clearTimer?: (handle: FrameRenewalTimerHandle) => void;
  /** Clock seam for the mint anchor and the retry deadline. Default Date.now,
   *  read at call time. */
  now?: () => number;
};

export type FrameCredentialRenewal = {
  /** Start a new chain for `credential`, cancelling any earlier one. Its life
   *  `expiresInSeconds` is counted from `mintedAtMs`, the clock reading taken
   *  just before the request that minted it (step 1 above). */
  arm: (credential: FrameWidgetCredential, expiresInSeconds: number, mintedAtMs: number) => void;
  /** Cancel the pending timer and invalidate any renewal in flight. */
  dispose: () => void;
  /** The current generation. Changes on every arm() and dispose(). */
  readonly generation: number;
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
  let timer: { handle: FrameRenewalTimerHandle } | null = null;

  function cancelTimer(): void {
    if (timer) {
      clearTimer(timer.handle);
      timer = null;
    }
  }

  /** Set the chain's one timer; its callback is dropped once the chain's
   *  generation has moved on. */
  function setChainTimer(armedGeneration: number, ms: number, run: () => void): void {
    const entry: { handle: FrameRenewalTimerHandle } = { handle: undefined };
    entry.handle = setTimer(() => {
      if (timer === entry) timer = null;
      if (armedGeneration !== generation) return;
      run();
    }, ms);
    timer = entry;
  }

  /** The wait before retry number `attempt` (0-based), or null when no retry
   *  can still fire while the pair has more than the floor of life left. */
  function retryWaitMs(attempt: number, deadline: number): number | null {
    const backoff = FRAME_RENEW_RETRY_DELAYS_SECONDS[attempt];
    if (backoff === undefined) return null;
    const latest = deadline - (FRAME_RENEW_RETRY_FLOOR_SECONDS + 1) * 1000 - now();
    const wait = Math.min(backoff * 1000, latest);
    return wait >= 1000 ? wait : null;
  }

  async function renewNow(
    credential: FrameWidgetCredential,
    armedGeneration: number,
    deadline: number,
    attempt: number,
  ): Promise<void> {
    let outcome: FrameRenewalOutcome;
    // The new pair's mint anchor: the server mints after this moment.
    const requestedAt = now();
    try {
      outcome = await deps.renew(credential);
    } catch {
      outcome = { ok: false };
    }
    // The answer of a chain the caller has let go of reaches nobody.
    if (armedGeneration !== generation) return;
    if (!outcome.ok) {
      if (outcome.reason === "renew_rate_limited") {
        const wait = retryWaitMs(attempt, deadline);
        if (wait !== null) {
          setChainTimer(armedGeneration, wait, () => {
            // The clock as the timer FIRES, not as it was set: a late timer
            // whose pair has no more than the floor left ends the chain
            // without presenting the pair.
            if (deadline - now() <= FRAME_RENEW_RETRY_FLOOR_SECONDS * 1000) {
              deps.onEnded();
              return;
            }
            void renewNow(credential, armedGeneration, deadline, attempt + 1);
          });
          return;
        }
      }
      deps.onEnded();
      return;
    }
    const renewed = outcome.credential;
    deps.onRenewed(renewed);
    // onRenewed may itself have disposed or re-armed; then that call owns the
    // chain and this one stops here.
    if (armedGeneration !== generation) return;
    arm(renewed, renewed.expiresIn, requestedAt);
  }

  function arm(
    credential: FrameWidgetCredential,
    expiresInSeconds: number,
    mintedAtMs: number,
  ): void {
    cancelTimer();
    generation += 1;
    const armedGeneration = generation;
    const at = now();
    const life = Number.isFinite(expiresInSeconds) ? expiresInSeconds : 0;
    // Anchored to the mint, never to this call: the time spent between the mint
    // and this arm() is already gone from the pair's life.
    const deadline = Number.isFinite(mintedAtMs) ? Math.min(mintedAtMs, at) + life * 1000 : at;
    setChainTimer(armedGeneration, frameRenewalDelayMs((deadline - at) / 1000), () => {
      void renewNow(credential, armedGeneration, deadline, 0);
    });
  }

  function dispose(): void {
    cancelTimer();
    generation += 1;
  }

  return {
    arm,
    dispose,
    get generation() {
      return generation;
    },
  };
}
