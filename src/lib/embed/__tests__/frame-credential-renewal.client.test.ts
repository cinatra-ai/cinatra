// cinatra#4217 — THE FRAME CREDENTIAL'S RENEWAL CHAIN.
//
// RED AT MAIN: this suite imports `@/lib/embed/frame-credential-renewal.client`,
// which does not exist before cinatra#4217. At main plus these tests alone the
// file fails to LOAD (module not found), so every case below is red by that
// load failure, not by an assertion.
//
// What is proven here, on fake timers and an in-test fake server:
//   • the first renewal fires at max(expiresIn - 90, 30) seconds and not before;
//   • a success hands the new pair over first and then re-arms from ITS life;
//   • a refusal ends the chain once and nothing re-arms;
//   • a rate-limited renewal (429) is retried with backoff on the SAME pair
//     while the pair still has more than 30 s of life, and ends the chain only
//     when no retry can fire in time (cinatra#4217 r4; red before r4, where the
//     first 429 ended the chain); a retry whose timer fires late, with no more
//     than 30 s left, ends the chain without presenting the pair (r6);
//   • a FIRST timer that fires late presents the user token once, and the
//     fake server's answer on that token alone decides: renewed while it is
//     live, the chain ends when it has run out (r8);
//   • the answer of a disposed or re-armed chain reaches nobody;
//   • a frame kept open past one token lifetime still holds a live credential
//     that a review decision accepts (acceptance 1 of cinatra#4217).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFrameCredentialRenewal,
  type FrameRenewalOutcome,
} from "@/lib/embed/frame-credential-renewal.client";
import type { FrameWidgetCredential } from "@/lib/embed/frame-widget-session.client";

const SECOND = 1_000;
const MINUTE = 60 * SECOND;

function pair(n: number, expiresIn = 300): FrameWidgetCredential {
  return { userToken: `cwu_${n}`, transportToken: `cit_${n}`, expiresIn };
}

/** A promise the test settles by hand, to hold a renewal in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** One chain with spies on every hand-over. */
function chain(renew: (c: FrameWidgetCredential) => Promise<FrameRenewalOutcome>) {
  const log: string[] = [];
  const renewSpy = vi.fn(renew);
  const onRenewed = vi.fn((c: FrameWidgetCredential) => {
    log.push(`renewed:${c.userToken}`);
  });
  const onEnded = vi.fn(() => {
    log.push("ended");
  });
  const renewal = createFrameCredentialRenewal({
    renew: renewSpy,
    onRenewed,
    onEnded,
    setTimer: (callback, ms) => {
      log.push(`timer:${ms}`);
      return globalThis.setTimeout(callback, ms);
    },
    clearTimer: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
  });
  return { renewal, renew: renewSpy, onRenewed, onEnded, log };
}

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-10-19T09:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("when the first renewal fires", () => {
  it("fires at expiresIn minus 90 seconds (210 s for a 300 s pair) and not a millisecond before", async () => {
    const c = chain(async () => ({ ok: true, credential: pair(2) }));
    c.renewal.arm(pair(1), 300);

    await vi.advanceTimersByTimeAsync(210 * SECOND - 1);
    expect(c.renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(c.renew).toHaveBeenCalledWith(pair(1));
  });

  it("never fires sooner than 30 seconds, even for a pair that lives only 40", async () => {
    const c = chain(async () => ({ ok: true, credential: pair(2) }));
    c.renewal.arm(pair(1, 40), 40);

    await vi.advanceTimersByTimeAsync(30 * SECOND - 1);
    expect(c.renew).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(c.renew).toHaveBeenCalledTimes(1);
  });
});

describe("after a successful renewal", () => {
  it("hands the new pair to onRenewed first, then re-arms from the new pair's expiresIn", async () => {
    const answers = [pair(2, 120), pair(3, 300)];
    const c = chain(async () => ({ ok: true, credential: answers.shift()! }));
    c.renewal.arm(pair(1), 300);

    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.onRenewed).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).toHaveBeenCalledWith(pair(2, 120));
    // Hand-over BEFORE the next timer, and that timer is max(120 - 90, 30) s.
    expect(c.log).toEqual(["timer:210000", "renewed:cwu_2", "timer:30000"]);

    await vi.advanceTimersByTimeAsync(30 * SECOND - 1);
    expect(c.renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.renew).toHaveBeenCalledTimes(2);
    // The second renewal presents the pair the first one produced.
    expect(c.renew).toHaveBeenLastCalledWith(pair(2, 120));
    expect(c.onEnded).not.toHaveBeenCalled();
  });
});

describe("a refused renewal ends the chain", () => {
  it("calls onEnded exactly once and arms no further timer", async () => {
    const c = chain(async () => ({ ok: false }));
    c.renewal.arm(pair(1), 300);

    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
  });

  it("treats a renewal that throws as a refusal: onEnded once, nothing re-arms", async () => {
    const c = chain(async () => {
      throw new Error("network down");
    });
    c.renewal.arm(pair(1), 300);

    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

// cinatra#4217 r4 — a 429 refused the request before the server verified,
// claimed or minted anything (it had read the header and the body and hashed
// the bearer only to key its limiter), so the pair is unspent and worth trying
// again. RED BEFORE r4: the chain ended
// at the first 429 (onEnded after one call), so each case below fails at its
// first onEnded or call-count assertion.
describe("a rate-limited renewal is retried while the pair still has life", () => {
  const LIMITED: FrameRenewalOutcome = { ok: false, reason: "renew_rate_limited" };

  it("retries a 429 on the same pair with backoff, and the chain goes on when a retry succeeds", async () => {
    const answers: FrameRenewalOutcome[] = [LIMITED, LIMITED, { ok: true, credential: pair(2) }];
    const c = chain(async () => answers.shift()!);
    c.renewal.arm(pair(1), 300);

    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(c.onEnded, "a 429 does not end the chain").not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(5 * SECOND - 1);
    expect(c.renew, "the first retry waits 5 s").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(c.renew).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(c.renew, "the second retry waits 10 s").toHaveBeenCalledTimes(3);
    for (const [presented] of c.renew.mock.calls) {
      expect(presented, "every retry presents the unspent pair").toEqual(pair(1));
    }
    expect(c.onRenewed).toHaveBeenCalledWith(pair(2));
    expect(c.onEnded).not.toHaveBeenCalled();
    expect(c.log).toEqual([
      "timer:210000",
      "timer:5000",
      "timer:10000",
      "renewed:cwu_2",
      "timer:210000",
    ]);
  });

  it("ends the chain once, before the pair expires, when no retry can still renew it", async () => {
    const t0 = Date.now();
    const calledAt: number[] = [];
    const c = chain(async () => {
      calledAt.push((Date.now() - t0) / SECOND);
      return LIMITED;
    });
    c.renewal.arm(pair(1), 300);

    await vi.advanceTimersByTimeAsync(300 * SECOND);
    // 210, then 5, 10 and 20 s later; the 40 s retry would fire with 15 s left,
    // so it is moved to the last moment with more than 30 s left (269 s).
    expect(calledAt).toEqual([210, 215, 225, 245, 269]);
    for (const at of calledAt) {
      expect(300 - at, "every attempt fires with more than 30 s left").toBeGreaterThan(30);
    }
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(c.renew).toHaveBeenCalledTimes(5);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 on a pair whose life is already too short", async () => {
    const c = chain(async () => LIMITED);
    c.renewal.arm(pair(1, 40), 40); // the first attempt fires at 30 s, with 10 s left
    await vi.advanceTimersByTimeAsync(30 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("any other refusal during the retries still ends the chain at once", async () => {
    const answers: FrameRenewalOutcome[] = [LIMITED, { ok: false, reason: "renew_failed" }];
    const c = chain(async () => answers.shift()!);
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(215 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(2);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  // cinatra#4217 r6 — the floor is read when the retry FIRES. RED ON r5: the
  // deadline was checked only when the retry was scheduled, so a timer that
  // fired after a suspend presented the expired pair a second time.
  it("a retry whose timer fires late, with no more than 30 s left, presents nothing and ends the chain", async () => {
    const t0 = Date.now();
    const c = chain(async () => LIMITED);
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount(), "the 5 s retry is pending").toBe(1);

    // The tab is suspended: the clock jumps to 400 s while no timer runs, and
    // the retry's timer fires only when the tab wakes.
    vi.setSystemTime(t0 + 400 * SECOND);
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(c.renew, "the late retry does not present the pair").toHaveBeenCalledTimes(1);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a retry whose timer fires a little late, still with more than 30 s left, is presented", async () => {
    const t0 = Date.now();
    const answers: FrameRenewalOutcome[] = [LIMITED, { ok: true, credential: pair(2) }];
    const c = chain(async () => answers.shift()!);
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(210 * SECOND);
    vi.setSystemTime(t0 + 260 * SECOND); // the retry then fires at 265 s, with 35 s left
    await vi.advanceTimersByTimeAsync(5 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(2);
    expect(c.onRenewed).toHaveBeenCalledWith(pair(2));
    expect(c.onEnded).not.toHaveBeenCalled();
  });

  it("dispose() during a retry wait cancels the retry", async () => {
    const c = chain(async () => LIMITED);
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(vi.getTimerCount(), "the retry is pending").toBe(1);

    c.renewal.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(c.onEnded).not.toHaveBeenCalled();
  });
});

// cinatra#4217 r8 — the FIRST timer of a chain is not checked against the
// pair's advertised end. A frame suspended past it presents its user token
// once when the timer runs, and the server decides on that token alone: it
// renews a cwu_ with more than its 30 s grace window left and refuses it
// otherwise. A behaviour pin: no code change goes with these cases.
describe("a first timer that fires late presents the user token once and the server decides", () => {
  /** A fake server that judges the presented cwu_ only, as the renewal does:
   *  the cwu_ lives `userTokenLifeSeconds` from t0, the advertised pair 300 s. */
  function userTokenServer(t0: number, userTokenLifeSeconds: number) {
    return async (): Promise<FrameRenewalOutcome> =>
      t0 + userTokenLifeSeconds * SECOND - Date.now() > 30 * SECOND
        ? { ok: true, credential: pair(2) }
        : { ok: false, reason: "renew_failed" };
  }

  it("a late first timer whose user token is still live renews once and the chain goes on", async () => {
    const t0 = Date.now();
    const c = chain(userTokenServer(t0, 900));
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(200 * SECOND);
    expect(c.renew, "the first timer has not fired yet").not.toHaveBeenCalled();

    // The tab is suspended: the clock jumps to 400 s, past the pair's
    // advertised 300 s, while no timer runs; the first timer fires on wake.
    vi.setSystemTime(t0 + 400 * SECOND);
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(c.renew, "the late first attempt presents the pair once").toHaveBeenCalledTimes(1);
    expect(c.renew).toHaveBeenCalledWith(pair(1));
    expect(c.onRenewed).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).toHaveBeenCalledWith(pair(2));
    expect(c.onEnded).not.toHaveBeenCalled();
    expect(vi.getTimerCount(), "the renewed pair is armed").toBe(1);
  });

  it("a late first timer whose user token has run out is refused and ends the chain once", async () => {
    const t0 = Date.now();
    const c = chain(userTokenServer(t0, 900));
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(200 * SECOND);
    expect(c.renew).not.toHaveBeenCalled();

    // Suspended until the cwu_ has no more than the grace window left.
    vi.setSystemTime(t0 + 880 * SECOND);
    await vi.advanceTimersByTimeAsync(10 * SECOND);
    expect(c.renew, "the late first attempt presents the pair once").toHaveBeenCalledTimes(1);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(c.renew).toHaveBeenCalledTimes(1);
    expect(c.onEnded).toHaveBeenCalledTimes(1);
  });
});

describe("the answer of a chain the caller let go of is dropped", () => {
  it("drops a success that lands after dispose(): no onRenewed, no onEnded, no timer", async () => {
    const inFlight = deferred<FrameRenewalOutcome>();
    const c = chain(() => inFlight.promise);
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(1);

    c.renewal.dispose();
    inFlight.resolve({ ok: true, credential: pair(2) });
    await vi.advanceTimersByTimeAsync(0);

    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(c.onEnded).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a refusal that lands after dispose(): the caller is not sent back to sign-in", async () => {
    const inFlight = deferred<FrameRenewalOutcome>();
    const c = chain(() => inFlight.promise);
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(210 * SECOND);

    c.renewal.dispose();
    inFlight.resolve({ ok: false });
    await vi.advanceTimersByTimeAsync(0);

    expect(c.onEnded).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops the old chain's answer after a new arm(), and keeps only the new chain's timer", async () => {
    const oldFlight = deferred<FrameRenewalOutcome>();
    const c = chain(async (presented) =>
      presented.userToken === "cwu_1" ? oldFlight.promise : { ok: true, credential: pair(9) },
    );
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(1);

    // A new sign-in arms a new chain while the old renewal is still in flight.
    const before = c.renewal.generation;
    c.renewal.arm(pair(5), 300);
    expect(c.renewal.generation).not.toBe(before);

    oldFlight.resolve({ ok: true, credential: pair(2) });
    await vi.advanceTimersByTimeAsync(0);
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(c.onEnded).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(1);

    // The one live timer is the new chain's, and it presents the new pair.
    await vi.advanceTimersByTimeAsync(210 * SECOND);
    expect(c.renew).toHaveBeenCalledTimes(2);
    expect(c.renew).toHaveBeenLastCalledWith(pair(5));
    expect(c.onRenewed).toHaveBeenCalledTimes(1);
    expect(c.onRenewed).toHaveBeenCalledWith(pair(9));
  });

  it("never calls renew() when dispose() comes before the timer fires", async () => {
    const c = chain(async () => ({ ok: true, credential: pair(2) }));
    c.renewal.arm(pair(1), 300);
    await vi.advanceTimersByTimeAsync(209 * SECOND);

    c.renewal.dispose();
    expect(vi.getTimerCount()).toBe(0);

    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(c.renew).not.toHaveBeenCalled();
    expect(c.onRenewed).not.toHaveBeenCalled();
    expect(c.onEnded).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ACCEPTANCE 1 (cinatra#4217): a widget frame kept open longer than one token
// lifetime can still send a pending review decision without a new sign-in.
//
// The fake server keeps the two token kinds the way the real one does: a user
// token (cwu_) lives 900 s, a transport token (cit_) lives 300 s, a renewal
// spends the presented user token and mints a fresh pair whose advertised life
// is min(remaining cwu, remaining cit). It refuses an expired or already-spent
// user token, and a decision needs a live, unspent pair.
// ---------------------------------------------------------------------------

const CWU_LIFE_S = 900;
const CIT_LIFE_S = 300;

function fakeServer() {
  const userTokens = new Map<string, { expiresAt: number; spent: boolean }>();
  const transportTokens = new Map<string, number>();
  let minted = 0;
  let signIns = 0;
  let renewals = 0;

  function mintPair(): FrameWidgetCredential {
    minted += 1;
    const now = Date.now();
    const userToken = `cwu_${minted}`;
    const transportToken = `cit_${minted}`;
    userTokens.set(userToken, { expiresAt: now + CWU_LIFE_S * SECOND, spent: false });
    transportTokens.set(transportToken, now + CIT_LIFE_S * SECOND);
    const remainingCwu = Math.ceil((userTokens.get(userToken)!.expiresAt - now) / SECOND);
    return {
      userToken,
      transportToken,
      expiresIn: Math.min(remainingCwu, CIT_LIFE_S),
    };
  }

  function liveUserToken(token: string): boolean {
    const row = userTokens.get(token);
    return !!row && !row.spent && Date.now() < row.expiresAt;
  }

  return {
    signIn(): FrameWidgetCredential {
      signIns += 1;
      return mintPair();
    },
    async renew(presented: FrameWidgetCredential): Promise<FrameRenewalOutcome> {
      if (!liveUserToken(presented.userToken)) return { ok: false };
      userTokens.get(presented.userToken)!.spent = true;
      renewals += 1;
      return { ok: true, credential: mintPair() };
    },
    decide(held: FrameWidgetCredential | null): { ok: boolean } {
      if (!held || !liveUserToken(held.userToken)) return { ok: false };
      const citExpiresAt = transportTokens.get(held.transportToken);
      if (citExpiresAt === undefined || Date.now() >= citExpiresAt) return { ok: false };
      return { ok: true };
    },
    get signIns() {
      return signIns;
    },
    get renewals() {
      return renewals;
    },
  };
}

describe("acceptance 1: a long-open frame can still send a review decision", () => {
  it("a frame kept open past one token lifetime still holds a live credential for a review decision", async () => {
    const server = fakeServer();
    const first = server.signIn();
    let held: FrameWidgetCredential | null = first;
    const onEnded = vi.fn(() => {
      held = null;
    });
    const renewal = createFrameCredentialRenewal({
      renew: (c) => server.renew(c),
      onRenewed: (c) => {
        held = c;
      },
      onEnded,
    });
    renewal.arm(first, first.expiresIn);

    // Twenty minutes: past the 900 s user token and four times the 300 s
    // transport token. Renewals fall at 210, 420, 630, 840 and 1050 s.
    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    expect(onEnded).not.toHaveBeenCalled();
    expect(server.signIns).toBe(1);
    expect(server.renewals).toBe(5);
    // The held pair is the server's current live one: a decision with it goes through.
    expect(held).not.toBeNull();
    expect(held).not.toEqual(first);
    expect(server.decide(held)).toEqual({ ok: true });
    // The sign-in's own pair is long gone (spent, and past its life), and the
    // server refuses to renew it again.
    expect(server.decide(first)).toEqual({ ok: false });
    await expect(server.renew(first)).resolves.toEqual({ ok: false });

    renewal.dispose();
  });

  it("without the renewal chain the same frame could not decide after twenty minutes (control)", async () => {
    const server = fakeServer();
    const first = server.signIn();

    await vi.advanceTimersByTimeAsync(20 * MINUTE);

    expect(server.decide(first)).toEqual({ ok: false });
  });
});
