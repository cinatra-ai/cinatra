/**
 * THE FRAME'S RENEWAL CHAIN (cinatra#4217, rebuild): the state machine under
 * fake timers and a fake clock.
 *
 * Every case drives createFrameCredentialRenewal itself (arm, the timers it
 * sets, the answers of its renew call, leases), never a pure plan function: the
 * spec's one decision function is proven by what the machine DOES at each
 * timer. Each title names its census row of the rebuild spec.
 *
 * Times in the cases are seconds after the case's start (T0), unless named ms.
 *
 * RED ON MAIN: the module does not exist there, so the suite cannot load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFrameCredentialRenewal,
  FRAME_TIMER_CHUNK_MS,
  type FrameCredentialLives,
  type FrameRenewalOutcome,
} from "@/lib/embed/frame-credential-renewal.client";
import type { FrameWidgetCredential } from "@/lib/embed/frame-widget-session.client";

type Pair = FrameWidgetCredential;

const T0 = Date.UTC(2026, 9, 26, 0, 0, 0);
const at = (seconds: number) => T0 + seconds * 1000;
const rel = () => (Date.now() - T0) / 1000;

const pair = (n: number, expiresIn = 300, extra: Partial<Pair> = {}): Pair => ({
  userToken: `cwu_${n}`,
  transportToken: `cit_${n}`,
  expiresIn,
  ...extra,
});
const livesOf = (p: Pair): FrameCredentialLives => ({
  expiresIn: p.expiresIn,
  ...(p.userExpiresIn !== undefined ? { userExpiresIn: p.userExpiresIn } : {}),
  ...(p.sessionExpiresIn !== undefined ? { sessionExpiresIn: p.sessionExpiresIn } : {}),
});

type HarnessOptions = {
  /** Extra delay added to timer number i (0-based) — a suspended tab. */
  lateness?: (index: number, ms: number) => number;
  /** A clear that does not take: a cleared timer still fires (fold 1, the
   *  deadline callback's own guards; the generation guard is the only other
   *  stop). */
  leakyClear?: boolean;
};

function harness(options: HarnessOptions = {}) {
  const renew = vi.fn<(c: Pair, signal?: AbortSignal) => Promise<FrameRenewalOutcome>>();
  const onRenewed = vi.fn<(c: Pair) => void>();
  const onEnded = vi.fn<() => void>();
  const timerArgs: number[] = [];
  let live = 0;
  let maxLive = 0;
  const handles = new Set<unknown>();
  const requests: Array<{ at: number; presented: Pair }> = [];
  /** The signal each request was given (pre-1 MF1, MF3). */
  const signals: Array<AbortSignal | undefined> = [];
  renew.mockImplementation(async () => {
    throw new Error("no answer arranged");
  });
  const chain = createFrameCredentialRenewal({
    renew: (c, signal) => {
      requests.push({ at: rel(), presented: c });
      signals.push(signal);
      return renew(c, signal);
    },
    onRenewed,
    onEnded,
    setTimer: (callback, ms) => {
      const index = timerArgs.length;
      timerArgs.push(ms);
      const extra = options.lateness ? options.lateness(index, ms) : 0;
      live += 1;
      maxLive = Math.max(maxLive, live);
      const handle = setTimeout(() => {
        if (handles.delete(handle)) live -= 1;
        callback();
      }, ms + extra);
      handles.add(handle);
      return handle;
    },
    clearTimer: (handle) => {
      if (options.leakyClear) return;
      if (handles.delete(handle)) live -= 1;
      clearTimeout(handle as ReturnType<typeof setTimeout>);
    },
  });
  return {
    chain,
    renew,
    onRenewed,
    onEnded,
    timerArgs,
    requests,
    signals,
    get liveTimers() {
      return live;
    },
    get maxLiveTimers() {
      return maxLive;
    },
  };
}

/** Arm `p` so that its pair (and, with no userExpiresIn, its user token) has
 *  `leftSeconds` left now: A = R = now - (life - left). */
function armWithLeft(h: ReturnType<typeof harness>, p: Pair, leftSeconds: number) {
  const anchor = Date.now() - (p.expiresIn - leftSeconds) * 1000;
  h.chain.arm(p, livesOf(p), anchor, anchor);
}

async function advance(seconds: number) {
  await vi.advanceTimersByTimeAsync(Math.round(seconds * 1000));
}
async function advanceTo(seconds: number) {
  await advance(seconds - rel());
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// A fake server with the real server's rules: a user token renewable only while
// it has more than G = 30 s left and the session cap is ahead; a successor of
// min(900 s, cap left); the spent bearer kept as a grace row of at most G; a
// transport token of 300 s; every advertised life FLOORed. Its clock is the
// fake Date.now() when a request arrives (send + latency). It answers after
// `latency` again.
// ---------------------------------------------------------------------------
class FakeServer {
  readonly users = new Map<string, number>(); // user token -> expiry (ms)
  readonly transports = new Map<string, number>(); // transport token -> expiry (ms)
  claims: number[] = []; // server instants of successful claims
  next = 1;
  constructor(
    readonly capAt: number,
    readonly latencyMs = 0,
  ) {}

  /** A pair minted at server instant `s` for user life `userLife` (s). */
  mint(s: number, userExp: number): { pair: Pair; s: number } {
    const n = this.next++;
    const p: Pair = {
      userToken: `cwu_s${n}`,
      transportToken: `cit_s${n}`,
      expiresIn: 0,
    };
    this.users.set(p.userToken, userExp);
    this.transports.set(p.transportToken, s + 300_000);
    const user = Math.floor((userExp - s) / 1000);
    const session = Math.floor((this.capAt - s) / 1000);
    p.expiresIn = Math.min(user, 300);
    p.userExpiresIn = user;
    p.sessionExpiresIn = session;
    return { pair: p, s };
  }

  /** The real end of a pair, by the server's rows. */
  pairEnd(p: Pair): number {
    return Math.min(this.users.get(p.userToken) ?? -Infinity, this.transports.get(p.transportToken) ?? -Infinity);
  }

  accepts(p: Pair, s = Date.now()): boolean {
    return (this.users.get(p.userToken) ?? -Infinity) > s && (this.transports.get(p.transportToken) ?? -Infinity) > s;
  }

  claim(token: string, s: number): Pair | "not_renewable" | "invalid" {
    const exp = this.users.get(token);
    if (exp === undefined || exp <= s) return "invalid";
    if (!(exp > s + 30_000 && this.capAt > s)) return "not_renewable";
    this.users.set(token, Math.min(exp, s + 30_000)); // the grace row
    this.claims.push(s);
    return this.mint(s, Math.min(s + 900_000, this.capAt)).pair;
  }

  /** The chain's renew call against this server. */
  renew = async (p: Pair): Promise<FrameRenewalOutcome> => {
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    const got = this.claim(p.userToken, Date.now());
    if (this.latencyMs) await new Promise((r) => setTimeout(r, this.latencyMs));
    if (got === "invalid") return { ok: false, reason: "renew_failed", receivedAt: Date.now() };
    if (got === "not_renewable") return { ok: false, reason: "renew_not_renewable", receivedAt: Date.now() };
    return { ok: true, credential: got, receivedAt: Date.now() };
  };
}

// ===========================================================================
// Required rows R1-R3
// ===========================================================================

describe("R1: a refusal inside the grace while the token is still valid", () => {
  it("R1: a pair that reaches the cap is held to E_hi and never renewed", async () => {
    const h = harness();
    const p = pair(1, 60, { userExpiresIn: 60, sessionExpiresIn: 60 });
    h.chain.arm(p, livesOf(p), Date.now(), Date.now());
    expect(h.chain.state).toBe("holding");
    await advance(60);
    expect(h.onEnded, "not at E_lo (60 s)").not.toHaveBeenCalled();
    await advance(1);
    expect(h.onEnded, "at E_hi = R + 61 s").toHaveBeenCalledTimes(1);
    expect(h.renew).not.toHaveBeenCalled();
    await advance(3600);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.renew).not.toHaveBeenCalled();
  });

  it("R1: a not_renewable refusal holds to min(E_hi, its receipt + G + 1 s), then ends once", async () => {
    // (a) a renewal sent at ul 50, answered 409 at once: hold to R409 + 31 s.
    const h = harness();
    h.renew.mockResolvedValue({ ok: false, reason: "renew_not_renewable" });
    armWithLeft(h, pair(1), 50);
    expect(h.renew, "ul 50 > 35: the renewal goes out at once").toHaveBeenCalledTimes(1);
    await advance(0);
    expect(h.chain.state).toBe("holding");
    await advance(30.999);
    expect(h.onEnded, "no END before R409 + 31 s").not.toHaveBeenCalled();
    await advance(0.001);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.renew, "no retry inside the grace window").toHaveBeenCalledTimes(1);

    // (b) a slow 409 (10 s) on a pair whose E_hi comes first: hold to E_hi.
    vi.setSystemTime(T0);
    const k = harness();
    k.renew.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: false, reason: "renew_not_renewable" }), 10_000);
        }),
    );
    armWithLeft(k, pair(2), 36); // E_lo = +36, E_hi = +37
    expect(k.renew).toHaveBeenCalledTimes(1);
    await advanceTo(10);
    expect(k.chain.state).toBe("holding");
    await advanceTo(36.999);
    expect(k.onEnded).not.toHaveBeenCalled();
    await advanceTo(37);
    expect(k.onEnded, "min(E_hi = 37, R409 + 31 = 41)").toHaveBeenCalledTimes(1);
  });
});

describe("R2: a 300 s pair and a 280 s negotiation", () => {
  it("R2: a lease defers renew-now and release renews at once", async () => {
    const h = harness();
    const signIn = pair(1, 300, { userExpiresIn: 900, sessionExpiresIn: 28_800 });
    // The sign-in answers at A + 1 s; the chain is armed then.
    await advanceTo(1);
    h.chain.arm(signIn, livesOf(signIn), at(0), at(1));
    await h.chain.quiesce();
    const release = h.chain.lease();
    h.renew.mockResolvedValue({ ok: true, credential: pair(2, 300, { userExpiresIn: 900 }) });
    await advanceTo(210);
    expect(h.chain.deferred, "the D3 timer fired at A + 210 s, during the lease").toBe(true);
    expect(h.renew, "no request while the lease is held").not.toHaveBeenCalled();
    await advanceTo(280);
    expect(h.renew).not.toHaveBeenCalled();
    release();
    expect(h.renew, "D4 at release (ul 620)").toHaveBeenCalledTimes(1);
    expect(h.requests[0]).toEqual({ at: 280, presented: signIn });
    await advance(0);
    expect(h.onRenewed).toHaveBeenCalledWith(pair(2, 300, { userExpiresIn: 900 }));
    release();
    expect(h.renew, "release is idempotent").toHaveBeenCalledTimes(1);
  });
});

describe("R3 / C10: one decision function, the worked table", () => {
  const rows: Array<[number, number | null, number | null]> = [
    // [left (ul = pl), seconds until the request (null: none), ul at the request]
    [300, 210, 90],
    [120, 30, 90],
    [100, 10, 90],
    [91, 1, 90],
    [90, 0, 90],
    [61, 0, 61],
    [60, 0, 60],
    [37, 0, 37],
    [36.001, 0, 36.001],
    [36, 0, 36],
    [35.001, 0, 35.001],
    [35, null, null],
    [34.999, null, null],
    [20, null, null],
    [1, null, null],
  ];

  it.each(rows)(
    "C10: armed with %s s left, every scheduled renewal fires as a request (no plan/fire split)",
    async (left, delay, ulAtRequest) => {
      vi.setSystemTime(T0);
      const h = harness();
      h.renew.mockImplementation(() => new Promise(() => undefined)); // in flight forever
      armWithLeft(h, pair(1), left);
      const anchor = Date.now() - (300 - left) * 1000;
      if (delay === null) {
        expect(h.chain.state, "ul <= 35: HOLD at once").toBe("holding");
        const eHi = (anchor + 301_000 - T0) / 1000;
        await advanceTo(eHi - 0.001);
        expect(h.onEnded).not.toHaveBeenCalled();
        await advanceTo(eHi);
        expect(h.onEnded).toHaveBeenCalledTimes(1);
        expect(h.renew, "never sends at ul <= 35").not.toHaveBeenCalled();
        return;
      }
      if (delay > 0) {
        expect(h.chain.state).toBe("armed");
        await advance(delay - 0.001);
        expect(h.renew, "not before fireAt").not.toHaveBeenCalled();
        await advance(0.001);
      }
      expect(h.renew, "the timer at fireAt ends in a request, never a HOLD").toHaveBeenCalledTimes(1);
      expect(h.chain.state).toBe("renewing");
      const ul = (anchor + 300_000 - Date.now()) / 1000;
      expect(ul).toBeCloseTo(ulAtRequest!, 6);
      expect(ul).toBeGreaterThan(35);
    },
  );

  it("R3 (spec v3): after a renewal the next request waits 30 s; left 100 gives 30 s (ul 70); left 60 HOLDs, since the floor lies past latest", async () => {
    for (const [life, wait, ulAt] of [
      [100, 30, 70],
      [60, null, null],
    ] as const) {
      vi.setSystemTime(T0);
      const h = harness();
      // The first renewal answers at once with a pair of `life` s.
      h.renew.mockResolvedValueOnce({ ok: true, credential: pair(2, life), receivedAt: at(0) });
      h.renew.mockImplementation(() => new Promise(() => undefined));
      armWithLeft(h, pair(1), 90); // D4 at once: lastAttempt = now
      expect(h.renew).toHaveBeenCalledTimes(1);
      await advance(0);
      expect(h.onRenewed).toHaveBeenCalledTimes(1);
      if (wait === null) {
        // latest = 60 - 36 = 24 s < the floor at 30 s: the timer fires at 30 s,
        // where ul = 30 <= 35, and the chain holds to E_hi = 61 s.
        await advance(60.999);
        expect(h.renew, `life ${life}: no second request inside the floor`).toHaveBeenCalledTimes(1);
        expect(h.chain.state).toBe("holding");
        expect(h.onEnded).not.toHaveBeenCalled();
        await advance(0.001);
        expect(h.onEnded).toHaveBeenCalledTimes(1);
        continue;
      }
      await advance(wait - 0.001);
      expect(h.renew, `life ${life}: not before ${wait} s`).toHaveBeenCalledTimes(1);
      await advance(0.001);
      expect(h.renew, `life ${life}: at ${wait} s`).toHaveBeenCalledTimes(2);
      expect(life - rel(), "ul at the request").toBe(ulAt);
    }
  });
});

// ===========================================================================
// Anchors, clock and bounds
// ===========================================================================

describe("anchors and bounds", () => {
  it("C02: a renewal answer that takes 60 s re-arms from the request start", async () => {
    const h = harness();
    h.renew.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(9) }), 60_000);
        }),
    );
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(1000);
    expect(h.requests.map((r) => r.at), "every request 210 s after the previous START").toEqual([
      210, 420, 630, 840,
    ]);
  });

  it("C03: a future mint time is distrusted for the pair, the user token and the cap", async () => {
    // A 10 s ahead of the clock: the pair counts from now.
    let h = harness();
    h.chain.arm(pair(1), livesOf(pair(1)), at(10), at(0));
    await advanceTo(209.999);
    expect(h.renew).not.toHaveBeenCalled();
    h.renew.mockImplementation(() => new Promise(() => undefined));
    await advanceTo(210);
    expect(h.renew, "fires at now + 210, not A + 210 = 220").toHaveBeenCalledTimes(1);

    // The user token from a future A: 30 s of user life clamped is a HOLD;
    // unclamped (A = +10) it would have been 40 s and a request.
    vi.setSystemTime(T0);
    h = harness();
    const shortUser = pair(2, 20, { userExpiresIn: 30 });
    h.chain.arm(shortUser, livesOf(shortUser), at(10), at(0));
    expect(h.chain.state).toBe("holding");
    expect(h.renew).not.toHaveBeenCalled();

    // R and A 10 s ahead with the cap reached: END at now + 301, not 311. The
    // cap enters only as capReached (the lives on one anchor), so a clamp
    // cannot move it.
    vi.setSystemTime(T0);
    h = harness();
    const capped = pair(3, 300, { userExpiresIn: 300, sessionExpiresIn: 300 });
    h.chain.arm(capped, livesOf(capped), at(10), at(10));
    expect(h.chain.state).toBe("holding");
    await advanceTo(300.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(301);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
  });

  it("C04: a non-finite A renews once at once; a non-finite R ends at once", async () => {
    // A not finite, R finite: one attempt at once; success re-anchors.
    let h = harness();
    h.renew.mockResolvedValueOnce({ ok: true, credential: pair(2), receivedAt: at(0) });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(pair(1), livesOf(pair(1)), Number.NaN, at(0));
    expect(h.renew).toHaveBeenCalledTimes(1);
    await advanceTo(209.999);
    expect(h.renew).toHaveBeenCalledTimes(1);
    await advanceTo(210);
    expect(h.renew, "re-anchored on A' = 0: next at 210").toHaveBeenCalledTimes(2);

    // A not finite: any refusal holds to E_hi (from R) and ends there.
    for (const reason of ["renew_failed", "renew_rate_limited"] as const) {
      vi.setSystemTime(T0);
      h = harness();
      h.renew.mockResolvedValue({ ok: false, reason });
      h.chain.arm(pair(1), livesOf(pair(1)), Number.POSITIVE_INFINITY, at(0));
      await advance(0);
      expect(h.renew, `${reason}: a single attempt`).toHaveBeenCalledTimes(1);
      expect(h.chain.state, reason).toBe("holding");
      await advanceTo(300.999);
      expect(h.onEnded, reason).not.toHaveBeenCalled();
      await advanceTo(301);
      expect(h.onEnded, `${reason}: END at E_hi`).toHaveBeenCalledTimes(1);
      expect(h.renew).toHaveBeenCalledTimes(1);
    }

    // R not finite (A finite or not): there is no hi bound; END now.
    for (const [a, r] of [
      [Number.NaN, Number.NaN],
      [at(0), Number.NaN],
      [at(0), Number.NEGATIVE_INFINITY],
    ]) {
      vi.setSystemTime(T0);
      h = harness();
      h.chain.arm(pair(1), livesOf(pair(1)), a, r);
      expect(h.onEnded, `A ${a}, R ${r}`).toHaveBeenCalledTimes(1);
      expect(h.renew).not.toHaveBeenCalled();
      expect(h.timerArgs).toEqual([]);
    }
  });

  it.each([
    0,
    -5,
    Number.NaN,
    299.5,
    "300",
    undefined,
    Number.MAX_VALUE,
    1e308,
    Number.POSITIVE_INFINITY,
    28_801,
  ])("C05: an advertised life of %s ends the chain at once, with no request and no timer", async (life) => {
    const h = harness();
    h.chain.arm(pair(1), { expiresIn: life as number }, at(0), at(0));
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("ended");
    expect(h.timerArgs, "no timer").toEqual([]);
    await advance(3600);
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.onEnded).toHaveBeenCalledTimes(1);
  });

  it("C06: a finite mint at or past its deadline (E_hi <= t_arm) ends at once", async () => {
    for (const ago of [301, 400, 100_000]) {
      vi.setSystemTime(T0);
      const h = harness();
      h.chain.arm(pair(1), livesOf(pair(1)), at(-ago), at(-ago));
      expect(h.onEnded, `${ago} s ago`).toHaveBeenCalledTimes(1);
      expect(h.renew).not.toHaveBeenCalled();
      expect(h.timerArgs).toEqual([]);
    }
  });

  it.each([30, 20, 1])("C07: armed with ul %s, the pair is held and ends at E_hi", async (left) => {
    const h = harness();
    armWithLeft(h, pair(1), left);
    expect(h.chain.state).toBe("holding");
    await advance(left + 1 - 0.001);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advance(0.001);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.renew).not.toHaveBeenCalled();
  });

  // Restated in the fold 1 cure (pre-1 MF1). (a) The old case: the answer was
  // read at +211 s but handled at +600 s. A request is now awaited only to its
  // deadline, max(E_hi 301, start 210 + 90) = 301 s: the chain gives it up
  // there, ends once (the sign-in card), aborts its signal, and the answer at
  // +600 s reaches nobody. (b) The row's point, an answer handled after its
  // successor's whole life ran out ends the chain without presenting the
  // successor, still holds for an answer handled before the deadline.
  it("C08: an answer handled after its successor's whole life ends the chain; one handled after the deadline is given up there", async () => {
    // (a) handled at +600 s, after the deadline.
    let h = harness();
    h.renew.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2), receivedAt: at(211) }), 390_000);
        }),
    );
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(300.999);
    expect(h.requests.map((r) => r.at)).toEqual([210]);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.chain.state).toBe("renewing");
    await advanceTo(301);
    expect(h.onEnded, "given up at the deadline, 301 s").toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("ended");
    expect(h.signals[0]!.aborted, "its signal aborts").toBe(true);
    await advanceTo(600);
    await advance(3600);
    expect(h.onRenewed, "the answer at +600 s reaches nobody").not.toHaveBeenCalled();
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.requests, "the successor is never presented").toHaveLength(1);
    expect(h.liveTimers).toBe(0);

    // (b) read at +211 s, handled at +290 s (before the deadline), with a
    // successor of 60 s: E'_hi = 211 + 61 = 272 <= 290, so END at its arm.
    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2, 60), receivedAt: at(211) }), 80_000);
        }),
    );
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(290);
    expect(h.onRenewed).toHaveBeenCalledTimes(1);
    expect(h.onEnded, "END at once at arm").toHaveBeenCalledTimes(1);
    expect(h.onEnded.mock.invocationCallOrder[0]).toBeGreaterThan(h.onRenewed.mock.invocationCallOrder[0]);
    await advance(3600);
    expect(
      h.requests.filter((r) => r.presented.userToken === "cwu_2"),
      "the successor is never presented",
    ).toEqual([]);
    expect(h.liveTimers).toBe(0);
  });

  // Restated in fold 1 (pre-1 MF1): the answer of the old case arrived at
  // +600 s, 299 s after the held pair's E_hi (301 s). A request is now awaited
  // only to its deadline, max(E_hi, start + 90 s) = 301 s, so that answer is
  // given up there (the case "a renewal that never answers" below). The hold
  // on a late R' is kept with an answer read before the deadline.
  it("C08: an answer READ late (+80 s, before the held pair's E_hi) is held to its own hi bound, never ended early", async () => {
    const h = harness();
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2, 60) }), 80_000);
        }),
    );
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(290);
    // A' = 210, R' = 290: the successor's user lo bound (210 + 60 = 270) is
    // gone, so HOLD to E'_hi = 290 + 61 = 351 (the server may have minted as
    // late as 290).
    expect(h.onRenewed).toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("holding");
    await advanceTo(350.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(351);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);
  });

  it("C09: a late timer decides on the user token's life", async () => {
    // (a) U = E: the 210 s timer fires 75 s late (ul 15): HOLD to E_hi, no request.
    let h = harness({ lateness: (i) => (i === 0 ? 75_000 : 0) });
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(285);
    expect(h.chain.state).toBe("holding");
    expect(h.renew).not.toHaveBeenCalled();
    await advanceTo(301);
    expect(h.onEnded).toHaveBeenCalledTimes(1);

    // (b) pl 20 while ul 620: the late timer renews at once.
    vi.setSystemTime(T0);
    h = harness({ lateness: (i) => (i === 0 ? 70_000 : 0) });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    const signIn = pair(1, 300, { userExpiresIn: 900 });
    h.chain.arm(signIn, livesOf(signIn), at(0), at(0));
    await advanceTo(280);
    expect(h.requests).toEqual([{ at: 280, presented: signIn }]);

    // (c) both over: END, no request.
    vi.setSystemTime(T0);
    h = harness({ lateness: (i) => (i === 0 ? 700_000 : 0) });
    h.chain.arm(signIn, livesOf(signIn), at(0), at(0));
    await advanceTo(910);
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.onEnded).toHaveBeenCalledTimes(1);
  });

  it("C40: an END never precedes the real end under request latency", async () => {
    // The renewal is sent at client 1,000; the server reads its clock at 1,010
    // (and mints a capped 300 s pair: real end 1,310); the answer is read at 1,012.
    const h = harness();
    const first = pair(1, 1090, { userExpiresIn: 1090 });
    h.renew.mockImplementation(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                ok: true,
                credential: pair(2, 300, { userExpiresIn: 300, sessionExpiresIn: 300 }),
                receivedAt: Date.now(),
              }),
            12_000,
          );
        }),
    );
    h.chain.arm(first, livesOf(first), at(0), at(0));
    await advanceTo(1000);
    expect(h.requests.map((r) => r.at)).toEqual([1000]);
    await advanceTo(1012);
    expect(h.chain.state, "capReached: HOLD").toBe("holding");
    await advanceTo(1310);
    expect(h.onEnded, "not at E_lo (1,300), nor at the real end").not.toHaveBeenCalled();
    await advanceTo(1312.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(1313);
    expect(h.onEnded, "END at E_hi = 1,012 + 301").toHaveBeenCalledTimes(1);
  });

  it("C41: the same answer without the cap is renewed on the lo bound, before the server's renewable moment", async () => {
    const h = harness();
    const first = pair(1, 1090, { userExpiresIn: 1090 });
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2, 300), receivedAt: Date.now() }), 12_000);
        }),
    );
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(first, livesOf(first), at(0), at(0));
    await advanceTo(1300);
    // want = E'_lo - 90 = 1,000 + 300 - 90 = 1,210; the server would still
    // renew until 1,310 - 30 = 1,280.
    expect(h.requests.map((r) => r.at)).toEqual([1000, 1210]);
  });
});

// ===========================================================================
// The decision function, composed
// ===========================================================================

describe("the cap", () => {
  it("C11: capReached at life_E == life_K; not at life_E = life_K - 1", async () => {
    let h = harness();
    const reached = pair(1, 300, { userExpiresIn: 300, sessionExpiresIn: 300 });
    h.chain.arm(reached, livesOf(reached), at(0), at(0));
    expect(h.chain.state).toBe("holding");
    await advanceTo(300);
    expect(h.renew).not.toHaveBeenCalled();

    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockImplementation(() => new Promise(() => undefined));
    const under = pair(2, 299, { userExpiresIn: 300, sessionExpiresIn: 300 });
    h.chain.arm(under, livesOf(under), at(0), at(0));
    expect(h.chain.state).toBe("armed");
    await advanceTo(209);
    expect(h.requests.map((r) => r.at)).toEqual([209]);
  });

  it("C12: with K - A = 600 and the transport binding, the chain renews until capReached, then holds to E_hi near K", async () => {
    const server = new FakeServer(at(600));
    const h = harness();
    h.renew.mockImplementation(server.renew);
    h.onEnded.mockImplementation(() => {
      expect(Date.now(), "END is not before the held pair's real end").toBeGreaterThanOrEqual(
        server.pairEnd(h.onRenewed.mock.lastCall![0]),
      );
    });
    const { pair: first } = server.mint(at(0), at(600));
    expect(first).toMatchObject({ expiresIn: 300, userExpiresIn: 600, sessionExpiresIn: 600 });
    h.chain.arm(first, livesOf(first), at(0), at(0));
    await advanceTo(2000);
    expect(h.requests.map((r) => r.at)).toEqual([210, 420]);
    expect(h.onRenewed.mock.calls.map((c) => livesOf(c[0]))).toEqual([
      { expiresIn: 300, userExpiresIn: 390, sessionExpiresIn: 390 },
      { expiresIn: 180, userExpiresIn: 180, sessionExpiresIn: 180 },
    ]);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    // END at E_hi of the last pair: 420 + 180 + 1 = 601, one second after K.
    expect(h.onEnded.mock.invocationCallOrder.length).toBe(1);
  });

  it("C13: the request whose success gives capReached is the LAST request; after it, zero requests", async () => {
    for (const capLeft of [450, 600, 1000, 3600, 4000]) {
      vi.setSystemTime(T0);
      const server = new FakeServer(at(capLeft));
      const h = harness();
      h.renew.mockImplementation(server.renew);
      let endedAt: number | null = null;
      h.onEnded.mockImplementation(() => {
        endedAt = rel();
      });
      const { pair: first } = server.mint(at(0), at(Math.min(900, capLeft)));
      h.chain.arm(first, livesOf(first), at(0), at(0));
      await advanceTo(capLeft + 600);
      const capped = h.onRenewed.mock.calls.findIndex(
        ([c]) => c.sessionExpiresIn !== undefined && c.expiresIn >= c.sessionExpiresIn,
      );
      expect(capped, `cap ${capLeft}: a renewal reached the cap`).toBeGreaterThanOrEqual(0);
      expect(h.requests.length, `cap ${capLeft}: no request after it`).toBe(capped + 1);
      expect(endedAt, `cap ${capLeft}: END once, at about K`).not.toBeNull();
      expect(endedAt!).toBeGreaterThanOrEqual(capLeft);
      expect(endedAt!).toBeLessThanOrEqual(capLeft + 1);
    }
  });

  /** A server double whose answers carry no usable session life (K unknown):
   *  sessionExpiresIn is dropped, or replaced by `session` (an invalid or short
   *  value the frame must not read as a cap). It stops answering after `limit`
   *  requests, so a burst shows as a count, never as a hung test. */
  function capOnlyServer(
    h: ReturnType<typeof harness>,
    server: FakeServer,
    limit = 40,
    session: { value: unknown } | null = null,
  ) {
    h.renew.mockImplementation(async (p) => {
      if (h.requests.length > limit) return new Promise<FrameRenewalOutcome>(() => undefined);
      const out = await server.renew(p);
      if (out.ok) {
        const rest: Pair = { ...out.credential };
        delete rest.sessionExpiresIn;
        if (session) (rest as Record<string, unknown>).sessionExpiresIn = session.value;
        return { ...out, credential: rest };
      }
      return out;
    });
  }

  // Spec v3 (a), SC G1: a session life that is PRESENT but invalid or shorter
  // than the user life leaves K unknown (C47), so the no-gain rule applies
  // exactly as when it is absent. RED ON 1555a8a7: the chain bursts.
  it.each([
    ["NaN", Number.NaN],
    ["0", 0],
    ["299 (below the user life)", 299],
  ])(
    "C26 (spec v3): sessionExpiresIn %s reads as K unknown: a no-gain successor counts as the cap, no burst, END at E_hi",
    async (_label, value) => {
      const server = new FakeServer(at(1000), 100);
      const h = harness();
      capOnlyServer(h, server, 40, { value });
      let endedAt: number | null = null;
      h.onEnded.mockImplementation(() => {
        endedAt = Date.now();
      });
      const first = pair(1, 300, { userExpiresIn: 900, sessionExpiresIn: value });
      server.users.set(first.userToken, at(900));
      server.transports.set(first.transportToken, at(300));
      h.chain.arm(first, livesOf(first), at(0), at(0));
      await advanceTo(2000);
      expect(h.requests.map((r) => r.at)).toEqual([210, 420]);
      expect(h.onEnded).toHaveBeenCalledTimes(1);
      expect(endedAt).toBe(T0 + 721_200);
    },
  );

  // Spec v3 (a), SC G1: the boundary of `U'_lo <= U_lo`. A successor whose
  // user token ends exactly where the replaced one did gained nothing (cap);
  // one that ends 1 s later gained, and the chain renews on. The equal side is
  // RED ON 1555a8a7 (no such rule there); the +1 s side is a guard, green at
  // 1555a8a7 too.
  it.each([
    ["no gain (U'_lo = U_lo)", 390, "holding"],
    ["a 1 s gain (U'_lo = U_lo + 1 s)", 391, "armed"],
  ] as const)(
    "C26 (spec v3): with K unknown, %s",
    async (_label, successorUserLife, stateAfter) => {
      const h = harness();
      // The sign-in: pair 300 s, user token 600 s, K unknown: U_lo = 600 s.
      const first = pair(1, 300, { userExpiresIn: 600 });
      // The renewal at 210 s answers at once: U'_lo = 210 + life.
      const successor = pair(2, 300, { userExpiresIn: successorUserLife });
      h.renew.mockResolvedValueOnce({ ok: true, credential: successor, receivedAt: at(210) });
      h.renew.mockImplementation(() => new Promise(() => undefined));
      h.chain.arm(first, livesOf(first), at(0), at(0));
      await advanceTo(210);
      await advance(0);
      expect(h.renew).toHaveBeenCalledTimes(1);
      expect(h.onRenewed).toHaveBeenCalledWith(successor);
      expect(h.chain.state).toBe(stateAfter);
      await advanceTo(420);
      if (stateAfter === "holding") {
        expect(h.renew, "no request after a no-gain successor").toHaveBeenCalledTimes(1);
        expect(h.onEnded, "held to E_hi = 210 + 301 s").not.toHaveBeenCalled();
        await advanceTo(511);
        expect(h.onEnded).toHaveBeenCalledTimes(1);
      } else {
        expect(h.renew, "the next renewal at want = 210 + 300 - 90 s").toHaveBeenCalledTimes(2);
        expect(h.onEnded).not.toHaveBeenCalled();
      }
    },
  );

  it("C26 (spec v3): with no sessionExpiresIn and a fixed server cap, renewals never burst: a no-gain successor counts as the cap", async () => {
    // RED ON 1555a8a7 (spec v2): once the successors end at the cap, fireAt =
    // latest = the request's own start, so the chain renews again at once,
    // again and again, until the user token has 35 s left.
    const server = new FakeServer(at(1000), 100); // 100 ms each way
    const h = harness();
    capOnlyServer(h, server);
    let endedAt: number | null = null;
    h.onEnded.mockImplementation(() => {
      endedAt = Date.now();
    });
    const first = pair(1, 300, { userExpiresIn: 900 });
    server.users.set(first.userToken, at(900));
    server.transports.set(first.transportToken, at(300));
    h.chain.arm(first, livesOf(first), at(0), at(0));
    await advanceTo(2000);
    const starts = h.requests.map((r) => r.at);
    for (let i = 1; i < starts.length; i += 1) {
      expect(starts[i]! - starts[i - 1]!, `requests ${i - 1} and ${i}: ${starts.join(", ")}`).toBeGreaterThanOrEqual(30);
    }
    // 210 s: the successor's user token ends at the cap (1000 > 900, a gain).
    // 420 s: its successor ends at the cap too (1000 <= 1000): no gain, so the
    // chain holds that pair to its hi bound and renews no more.
    expect(starts).toEqual([210, 420]);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    // K14 (the known limit): the frame ends at the held pair's E_hi, the 420 s
    // answer's receipt (420.2 s) + 301 s, early against the cap (1000 s) and
    // never before the pair's real end (its transport token, 420.1 + 300 s).
    expect(endedAt).toBe(T0 + 721_200);
    expect(endedAt!).toBeLessThan(at(1000));
  });

  it("C12 (spec v3, the other side): with sessionExpiresIn known, a no-gain successor does NOT stop the chain; it renews to the cap and ends at about K", async () => {
    // The same server and schedule as the burst case, with K advertised. At
    // 420 s the successor gains no user life (both end at the cap, 1000 s), but
    // (a) applies to K unknown only: the cap rule life_E >= life_K decides.
    const server = new FakeServer(at(1000));
    const h = harness();
    h.renew.mockImplementation(server.renew);
    let endedAt: number | null = null;
    h.onEnded.mockImplementation(() => {
      endedAt = Date.now();
    });
    const first = pair(1, 300, { userExpiresIn: 900, sessionExpiresIn: 1000 });
    server.users.set(first.userToken, at(900));
    server.transports.set(first.transportToken, at(300));
    h.chain.arm(first, livesOf(first), at(0), at(0));
    await advanceTo(2000);
    // 210: user 790 (to the cap), pair 300; 420: user 580, no gain, pair 300;
    // 630: user 370, pair 300; 840: user 160 = K left, pair 160: capReached.
    expect(h.requests.map((r) => r.at)).toEqual([210, 420, 630, 840]);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(endedAt, "END at E_hi = 840 + 161 s, at about K").toBe(at(1001));
  });

  it("C26 (spec v3): with no sessionExpiresIn the chain renews by decide; at the cap it holds the last pair to E_hi and ends once", async () => {
    const server = new FakeServer(at(700));
    const h = harness();
    capOnlyServer(h, server);
    let endedAt: number | null = null;
    let lastHeld: Pair | null = null;
    h.onRenewed.mockImplementation((c) => {
      lastHeld = c;
    });
    h.onEnded.mockImplementation(() => {
      endedAt = Date.now();
    });
    const first = pair(1, 300, { userExpiresIn: 700 });
    server.users.set(first.userToken, at(700));
    server.transports.set(first.transportToken, at(300));
    h.chain.arm(first, livesOf(first), at(0), at(0));
    await advanceTo(2000);
    // 210 s: the successor ends at the cap like the sign-in's user token (700 <=
    // 700): no gain, so the cap stops the chain after one renewal.
    expect(h.requests.map((r) => r.at)).toEqual([210]);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    // END at E_hi of the pair it holds (210 + 301 s), never before its real end.
    expect(endedAt).toBe(at(511));
    expect(endedAt!).toBeGreaterThanOrEqual(server.pairEnd(lastHeld!));
    const outcomes = (await Promise.all(h.renew.mock.results.map((r) => r.value))) as FrameRenewalOutcome[];
    expect(outcomes.every((o) => o.ok), "no refusal was needed").toBe(true);
  });

  it("C47: an invalid or short userExpiresIn counts the user token as the pair; an invalid or short sessionExpiresIn leaves the cap unknown", async () => {
    // userExpiresIn below expiresIn: U := E, so ul 20 HOLDs (U would be 900).
    let h = harness();
    h.chain.arm(pair(1, 300), { expiresIn: 300, userExpiresIn: 299 }, at(-280), at(-280));
    expect(h.chain.state).toBe("holding");
    vi.setSystemTime(T0);
    h = harness();
    h.chain.arm(pair(1, 300), { expiresIn: 300, userExpiresIn: Number.MAX_VALUE }, at(-280), at(-280));
    expect(h.chain.state).toBe("holding");
    // A valid userExpiresIn: the same moment renews at once (ul 620).
    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(pair(1, 300), { expiresIn: 300, userExpiresIn: 900 }, at(-280), at(-280));
    expect(h.renew).toHaveBeenCalledTimes(1);

    // sessionExpiresIn below the user life, or invalid: K unknown, no cap hold,
    // and no timer is ever armed for K.
    for (const sessionExpiresIn of [299, 0, Number.NaN, 1e308]) {
      vi.setSystemTime(T0);
      h = harness();
      h.renew.mockImplementation(() => new Promise(() => undefined));
      h.chain.arm(pair(1, 300), { expiresIn: 300, sessionExpiresIn }, at(0), at(0));
      expect(h.chain.state, String(sessionExpiresIn)).toBe("armed");
      expect(h.timerArgs, String(sessionExpiresIn)).toEqual([210_000]);
    }
  });

  it("C48: a HOLD of 8 h is set as 1-hour chunks; each chunk re-decides; END once at holdEnd", async () => {
    const h = harness();
    const day = pair(1, 28_800, { userExpiresIn: 28_800, sessionExpiresIn: 28_800 });
    h.chain.arm(day, livesOf(day), at(0), at(0));
    await advanceTo(28_800.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(28_801);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(Math.max(...h.timerArgs), "no setTimeout argument above CHUNK").toBeLessThanOrEqual(FRAME_TIMER_CHUNK_MS);
    expect(h.timerArgs.filter((ms) => ms === FRAME_TIMER_CHUNK_MS)).toHaveLength(8);
    expect(h.maxLiveTimers).toBe(1);

    // An armed renewal 8 h away is chunked the same way and fires on time.
    vi.setSystemTime(T0);
    const k = harness();
    k.renew.mockImplementation(() => new Promise(() => undefined));
    const long = pair(2, 28_800, { userExpiresIn: 28_800 });
    k.chain.arm(long, livesOf(long), at(0), at(0));
    await advanceTo(28_709.999);
    expect(k.renew).not.toHaveBeenCalled();
    await advanceTo(28_710);
    expect(k.renew).toHaveBeenCalledTimes(1);
    expect(Math.max(...k.timerArgs)).toBeLessThanOrEqual(FRAME_TIMER_CHUNK_MS);
  });
});

// ===========================================================================
// Refusals
// ===========================================================================

describe("refusals", () => {
  it("C14: a renew_failed refusal (a 400, a 5xx, a throw) ends the chain at once", async () => {
    for (const answer of [
      () => Promise.resolve({ ok: false, reason: "renew_failed" } as FrameRenewalOutcome),
      () => Promise.resolve({ ok: false } as FrameRenewalOutcome),
      () => Promise.reject(new Error("network down")),
    ]) {
      vi.setSystemTime(T0);
      const h = harness();
      h.renew.mockImplementation(answer);
      h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
      await advanceTo(210);
      expect(h.onEnded).toHaveBeenCalledTimes(1);
      expect(rel()).toBe(210);
      await advanceTo(2000);
      expect(h.renew).toHaveBeenCalledTimes(1);
    }
  });

  it("C17: 429 retries follow the feasible offsets", async () => {
    // Sign-in lives (E 300, U 900): latest = +864.
    let h = harness();
    h.renew.mockResolvedValue({ ok: false, reason: "renew_rate_limited" });
    const signIn = pair(1, 300, { userExpiresIn: 900 });
    h.chain.arm(signIn, livesOf(signIn), at(0), at(0));
    await advanceTo(286);
    expect(h.requests.map((r) => r.at)).toEqual([210, 215, 225, 245, 285]);
    expect(h.requests.every((r) => r.presented === signIn), "each with the same pair").toBe(true);
    expect(h.chain.state, "the fifth 429: HOLD to E_hi").toBe("holding");
    await advanceTo(300.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(301);
    expect(h.onEnded).toHaveBeenCalledTimes(1);

    // U = E = 300: latest = +264; the fourth wait is cut to it (ul 36).
    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockResolvedValue({ ok: false, reason: "renew_rate_limited" });
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(300);
    expect(h.requests.map((r) => r.at)).toEqual([210, 215, 225, 245, 264]);
    expect(h.chain.state).toBe("holding");
    await advanceTo(301);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
  });

  it("C18: a retry that would fire after latest is moved to latest; under 1 s there is no retry, so HOLD", async () => {
    // ul 40: latest is 4 s ahead, so the 5 s wait is cut to 4 s (ul 36).
    let h = harness();
    h.renew.mockResolvedValueOnce({ ok: false, reason: "renew_rate_limited" });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    armWithLeft(h, pair(1), 40);
    await advance(3.999);
    expect(h.requests).toHaveLength(1);
    await advance(0.001);
    expect(h.requests.map((r) => r.at)).toEqual([0, 4]);

    // ul 37: the first wait is exactly 1 s (kept); the next would be 0 (dropped).
    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockResolvedValue({ ok: false, reason: "renew_rate_limited" });
    armWithLeft(h, pair(1), 37);
    await advance(1);
    expect(h.requests.map((r) => r.at)).toEqual([0, 1]);
    expect(h.chain.state, "no retry fits: HOLD").toBe("holding");
    await advance(37);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(2);
  });

  it("C19: an exhausted rate limit holds the pair to its end, it does not end at the refusal", async () => {
    const h = harness();
    h.renew.mockResolvedValue({ ok: false, reason: "renew_rate_limited" });
    armWithLeft(h, pair(1), 36.5);
    await advance(0);
    // 0.5 s to latest: no retry fits.
    expect(h.requests).toHaveLength(1);
    expect(h.chain.state).toBe("holding");
    expect(h.onEnded, "not at the refusal").not.toHaveBeenCalled();
    await advance(37.5 - 0.001);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advance(0.001);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
  });

  it("C20: a late retry timer goes through decide: HOLD or END, no request at ul <= 35", async () => {
    // A 429 at ul 50; the 5 s retry timer fires 20 s late (ul 25): HOLD.
    // Timer 0 is the request's deadline (fold 1, pre-1 MF1: max(E_hi 51 s,
    // start + 90 s) = 90 s), which the retry timer (timer 1) replaces.
    let h = harness({ lateness: (i) => (i === 1 ? 20_000 : 0) });
    h.renew.mockResolvedValue({ ok: false, reason: "renew_rate_limited" });
    armWithLeft(h, pair(1), 50);
    await advance(0);
    expect(h.timerArgs, "the deadline, then the 5 s retry wait").toEqual([90_000, 5_000]);
    await advance(25);
    expect(h.requests).toHaveLength(1);
    expect(h.chain.state).toBe("holding");
    await advance(26);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);

    // Late past E_hi: END at the fire.
    vi.setSystemTime(T0);
    h = harness({ lateness: (i) => (i === 1 ? 100_000 : 0) });
    h.renew.mockResolvedValue({ ok: false, reason: "renew_rate_limited" });
    armWithLeft(h, pair(1), 50);
    await advance(0);
    expect(h.timerArgs).toEqual([90_000, 5_000]);
    await advance(105);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.requests).toHaveLength(1);
  });

  it("C27: a renewal that lost the claim to a concurrent one holds to min(E_hi, R409 + 31 s), past the server's grace end", async () => {
    const server = new FakeServer(at(28_800), 1_000);
    const h = harness();
    h.renew.mockImplementation(server.renew);
    const { pair: first } = server.mint(at(0), at(900));
    first.expiresIn = 300;
    h.chain.arm(first, livesOf(first), at(0), at(0));
    // Another request renews the same bearer first, at +209.5 s.
    await advanceTo(209.5);
    expect(server.claim(first.userToken, Date.now())).not.toBe("invalid");
    const graceEnd = server.users.get(first.userToken)!;
    await advanceTo(212); // our request: sent 210, answered 409 at 212
    expect(h.chain.state).toBe("holding");
    expect(server.accepts(first, at(235)), "the held pair still works inside the grace").toBe(true);
    await advanceTo(242.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(243);
    expect(h.onEnded, "END at R409 + 31 s").toHaveBeenCalledTimes(1);
    expect(Date.now()).toBeGreaterThanOrEqual(graceEnd);
    expect(Date.now() - graceEnd, "not presented past the grace end by more than 1 s plus the latency").toBeLessThanOrEqual(
      3_500,
    );
  });
});

// ===========================================================================
// Lease, quiesce, generations
// ===========================================================================

describe("lease, quiesce and generations", () => {
  it("C45: quiesce waits for a renewal already in flight; the lease then follows the renewed pair", async () => {
    const h = harness();
    let answer!: (o: FrameRenewalOutcome) => void;
    h.renew.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    h.renew.mockImplementation(() => new Promise(() => undefined));
    armWithLeft(h, pair(1), 60); // D4 at once: in flight
    expect(h.chain.state).toBe("renewing");
    let settled = false;
    void h.chain.quiesce().then(() => {
      settled = true;
    });
    await advance(0);
    expect(settled, "quiesce waits for the answer").toBe(false);
    answer({ ok: true, credential: pair(2) });
    await advance(0);
    expect(settled).toBe(true);
    expect(h.onRenewed).toHaveBeenCalledWith(pair(2));
    // A fresh chain with nothing in flight settles at once.
    const k = harness();
    k.chain.arm(pair(3), livesOf(pair(3)), Date.now(), Date.now());
    let quick = false;
    void k.chain.quiesce().then(() => {
      quick = true;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(quick).toBe(true);
  });

  // cinatra#4217 fold 2: the conversation's readers ask whether a renewal is
  // on its way (pre-2 MUST-FIX 1 and 2). RED AT 2c98c0e4: no such reading.
  it("fold 2: inFlight is true only while a request is in flight; its answer, a dispose or its deadline ends it", async () => {
    const h = harness();
    let answer!: (o: FrameRenewalOutcome) => void;
    h.renew.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    h.renew.mockImplementation(() => new Promise(() => undefined));
    expect(h.chain.inFlight, "nothing armed").toBe(false);
    armWithLeft(h, pair(1), 60); // D4 at once: in flight
    expect(h.chain.inFlight, "the request is on its way").toBe(true);
    answer({ ok: true, credential: pair(2) });
    await advance(0);
    expect(h.onRenewed).toHaveBeenCalledWith(pair(2));
    expect(h.chain.inFlight, "answered").toBe(false);

    const d = harness();
    d.renew.mockImplementation(() => new Promise(() => undefined));
    armWithLeft(d, pair(3), 60);
    expect(d.chain.inFlight).toBe(true);
    d.chain.dispose();
    expect(d.chain.inFlight, "a dispose gave it up").toBe(false);

    const t = harness();
    t.renew.mockImplementation(() => new Promise(() => undefined));
    armWithLeft(t, pair(4), 60);
    expect(t.chain.inFlight).toBe(true);
    await advance(120); // past max(E_hi, start + 90 s)
    expect(t.onEnded).toHaveBeenCalledTimes(1);
    expect(t.chain.inFlight, "its deadline gave it up").toBe(false);
  });

  it("C33: dispose, re-arm and a new hold drop the answers and timers of the older generation", async () => {
    // In RENEWING: the answer reaches nobody.
    let h = harness();
    let answer!: (o: FrameRenewalOutcome) => void;
    h.renew.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    armWithLeft(h, pair(1), 60);
    const g = h.chain.generation;
    h.chain.dispose();
    expect(h.chain.generation).toBeGreaterThan(g);
    answer({ ok: true, credential: pair(2) });
    await advance(3600);
    expect(h.onRenewed).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.chain.state).toBe("idle");

    // In HOLDING: the end timer is dropped.
    vi.setSystemTime(T0);
    h = harness();
    armWithLeft(h, pair(1), 20);
    expect(h.chain.state).toBe("holding");
    h.chain.dispose();
    await advance(3600);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.liveTimers).toBe(0);

    // A refusal answered after a re-arm reaches nobody either.
    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    armWithLeft(h, pair(1), 60);
    h.chain.arm(pair(5), livesOf(pair(5)), Date.now(), Date.now());
    answer({ ok: false, reason: "renew_failed" });
    await advance(100);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.chain.state).toBe("armed");
  });

  it("C33: a deferred renewal under a lease is dropped by dispose; the old release does nothing", async () => {
    const h = harness();
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    const release = h.chain.lease();
    await advanceTo(210);
    expect(h.chain.deferred).toBe(true);
    h.chain.dispose();
    expect(h.chain.deferred).toBe(false);
    release();
    await advanceTo(1000);
    expect(h.renew).not.toHaveBeenCalled();
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("C34: onRenewed that disposes or re-arms stops this chain there", async () => {
    let h = harness();
    h.renew.mockResolvedValue({ ok: true, credential: pair(2) });
    h.onRenewed.mockImplementation(() => h.chain.dispose());
    armWithLeft(h, pair(1), 60);
    await advance(3600);
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("idle");

    vi.setSystemTime(T0);
    h = harness();
    h.renew.mockResolvedValueOnce({ ok: true, credential: pair(2) });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.onRenewed.mockImplementation(() => h.chain.arm(pair(7), livesOf(pair(7)), Date.now(), Date.now()));
    armWithLeft(h, pair(1), 60);
    await advance(0);
    await advanceTo(209.999);
    expect(h.renew, "the caller's re-arm owns the chain").toHaveBeenCalledTimes(1);
    await advanceTo(210);
    expect(h.requests.map((r) => r.presented.userToken)).toEqual(["cwu_1", "cwu_7"]);
  });

  it("a lease that outlasts the user token's renewable life holds and ends at E_hi (K13)", async () => {
    const h = harness();
    const signIn = pair(1, 300, { userExpiresIn: 900 });
    h.chain.arm(signIn, livesOf(signIn), at(0), at(0));
    const release = h.chain.lease();
    await advanceTo(865);
    expect(h.chain.state, "renewability lost under the lease: HOLD").toBe("ended");
    // E_hi = 301 is long past when renewability ends at 865: END at once.
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    release();
    expect(h.renew).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// C46: the proof obligations P1-P4, over a grid
// ===========================================================================

describe("C46: P1-P4 over a grid of lives, latency, leases and timer lateness", () => {
  type Run = {
    userLife: number;
    capLeft: number | null;
    latencyMs: number;
    lease: [number, number] | null;
    lateMs: number;
    session: boolean;
  };
  const grid: Run[] = [];
  for (const userLife of [300, 900])
    for (const capLeft of [null, 600, 1000, 2000])
      for (const latencyMs of [0, 1000, 5000])
        for (const lease of [null, [0, 280], [100, 400], [1, 1000]] as Array<[number, number] | null>)
          for (const lateMs of [0, 7000, 75_000])
            for (const session of [true, false]) grid.push({ userLife, capLeft, latencyMs, lease, lateMs, session });

  it(`holds every obligation in ${grid.length} runs`, async () => {
    const failures: string[] = [];
    for (const run of grid) {
      vi.setSystemTime(T0);
      const label = JSON.stringify(run);
      const capAt = at(run.capLeft ?? 28_800);
      const server = new FakeServer(capAt, run.latencyMs);
      // A timer is late by lateMs once in three (a throttled tab).
      const h = harness({ lateness: (i) => (i % 3 === 1 ? run.lateMs : 0) });
      // Without a session reading (an older server, K unknown), every answer
      // drops sessionExpiresIn; past 400 requests the double stops answering,
      // so a busy loop shows as a P3 failure, never as a hung run.
      h.renew.mockImplementation(async (p) => {
        if (h.requests.length > 400) return new Promise<FrameRenewalOutcome>(() => undefined);
        const out = await server.renew(p);
        if (run.session || !out.ok) return out;
        const rest: Pair = { ...out.credential };
        delete rest.sessionExpiresIn;
        return { ...out, credential: rest };
      });
      const { pair: first } = server.mint(at(0), Math.min(at(run.userLife), capAt));
      if (!run.session) delete first.sessionExpiresIn;
      // The record of each pair the frame holds: its A and its user life.
      const held: Array<{ pair: Pair; a: number; userLife: number }> = [
        { pair: first, a: at(0), userLife: first.userExpiresIn ?? first.expiresIn },
      ];
      let leased = false;
      let endedAt: number | null = null;
      h.onRenewed.mockImplementation((c) => {
        held.push({ pair: c, a: h.requests[h.requests.length - 1]!.at * 1000 + T0, userLife: c.userExpiresIn ?? c.expiresIn });
      });
      h.onEnded.mockImplementation(() => {
        endedAt = Date.now();
        const current = held[held.length - 1]!;
        // P4: END never before the real end of the pair the frame holds.
        if (Date.now() < server.pairEnd(current.pair)) failures.push(`${label}: END before the real end`);
      });
      h.chain.arm(first, livesOf(first), at(0), at(0));
      let release: (() => void) | null = null;
      if (run.lease) {
        await advanceTo(run.lease[0]);
        await h.chain.quiesce();
        release = h.chain.lease();
        leased = true;
        const sentBefore = h.requests.length;
        await advanceTo(run.lease[1]);
        if (h.requests.length !== sentBefore) failures.push(`${label}: a request under the lease`);
        leased = false;
        release();
      }
      void leased;
      await advanceTo(Math.min(7200, (capAt - T0) / 1000 + 600));
      // P2: no request at ul <= G + S, at this document's clock.
      for (const req of h.requests) {
        const pairAtSend = held.filter((x) => x.a <= req.at * 1000 + T0).pop() ?? held[0]!;
        const record = held.find((x) => x.pair === req.presented) ?? pairAtSend;
        const ul = (record.a + record.userLife * 1000 - (req.at * 1000 + T0)) / 1000;
        if (!(ul > 35)) failures.push(`${label}: a request at ul ${ul}`);
      }
      // P3 (spec v3): after every renewal the next request starts at least
      // F = 30 s after the renewal's own start (no busy loop). This grid has
      // no 429, so every request but a refused last one is a renewal.
      const answered = (await Promise.all(
        h.renew.mock.results.slice(0, h.requests.length - 1).map((r) => r.value),
      )) as FrameRenewalOutcome[];
      for (let i = 1; i < h.requests.length; i += 1) {
        if (!answered[i - 1]?.ok) continue;
        const gap = (h.requests[i]!.at - h.requests[i - 1]!.at) * 1000;
        if (gap < 30_000) failures.push(`${label}: spacing ${gap} ms < 30000 ms after a renewal`);
      }
      // At most one timer is live at a time.
      if (h.maxLiveTimers > 1) failures.push(`${label}: ${h.maxLiveTimers} live timers`);
      // Every 409 or 400 means a request reached the server too late: none in
      // this grid (latency <= S).
      const outcomes = (await Promise.all(h.renew.mock.results.map((r) => r.value))) as FrameRenewalOutcome[];
      if (outcomes.some((o) => !o.ok && o.reason === "renew_failed")) failures.push(`${label}: a 400 refusal`);
      if (run.capLeft !== null && endedAt === null) failures.push(`${label}: never ended at the cap`);
      h.chain.dispose();
    }
    expect(failures).toEqual([]);
  }, 120_000);
});

// ===========================================================================
// Fold 1 of the pre-1 review (cinatra#4217 rebuild). RED AT a895dbef: the chain
// set no timer while a renewal was in flight, read the cap before the C04
// rule, and kept an obsolete request in quiesce() after dispose().
// ===========================================================================

describe("fold 1: a request in flight, C04 with the cap, and quiesce after dispose", () => {
  it("MF1: a renewal that never answers is given up at E_hi: the chain ends once, its signal aborts, and a later answer changes nothing", async () => {
    const h = harness();
    let answer!: (o: FrameRenewalOutcome) => void;
    h.renew.mockImplementationOnce(() => new Promise((resolve) => (answer = resolve)));
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(210);
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("renewing");
    await advanceTo(300.999);
    expect(h.onEnded, "the held pair lives to E_hi = 301 s").not.toHaveBeenCalled();
    expect(h.chain.state).toBe("renewing");
    await advanceTo(301);
    expect(h.onEnded, "deadline max(E_hi 301, 210 + 90) = 301 s").toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("ended");
    expect(h.signals[0], "the request carries a signal").toBeInstanceOf(AbortSignal);
    expect(h.signals[0]!.aborted, "the request given up is aborted").toBe(true);
    // The old C08 answer: read at +600 s, after the deadline. It reaches nobody.
    await advanceTo(600);
    answer({ ok: true, credential: pair(2) });
    await advance(3600);
    expect(h.onRenewed).not.toHaveBeenCalled();
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.renew).toHaveBeenCalledTimes(1);
    expect(h.liveTimers).toBe(0);
  });

  it("MF1: a late wake that renews after E_hi waits 90 s for its answer, then ends", async () => {
    // The 210 s timer fires 110 s late (a suspended tab): t = 320, the pair is
    // past E_hi (301) but the user token has 580 s left, so the chain renews.
    const h = harness({ lateness: (i) => (i === 0 ? 110_000 : 0) });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    const signIn = pair(1, 300, { userExpiresIn: 900 });
    h.chain.arm(signIn, livesOf(signIn), at(0), at(0));
    await advanceTo(320);
    expect(h.requests).toEqual([{ at: 320, presented: signIn }]);
    await advanceTo(409.999);
    expect(h.onEnded, "not cut at the old E_hi already behind it").not.toHaveBeenCalled();
    expect(h.chain.state).toBe("renewing");
    await advanceTo(410);
    expect(h.onEnded, "deadline max(301, 320 + 90) = 410 s").toHaveBeenCalledTimes(1);
    expect(h.signals[0]!.aborted).toBe(true);
    expect(h.renew).toHaveBeenCalledTimes(1);
  });

  it("MF1: an answer before the deadline replaces its timer; the next renewal keeps the schedule", async () => {
    const h = harness();
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2) }), 60_000);
        }),
    );
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(300);
    expect(h.onRenewed).toHaveBeenCalledTimes(1);
    expect(h.signals[0]?.aborted, "an answered request is not aborted").not.toBe(true);
    await advanceTo(420);
    expect(h.requests.map((r) => r.at), "re-armed from A' = 210").toEqual([210, 420]);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.maxLiveTimers).toBe(1);
  });

  it("MF1: a deadline 8 h away is set in 1-hour chunks and ends once at E_hi", async () => {
    // A not finite: the single attempt goes out at arm, 8 h before E_hi.
    const h = harness();
    h.renew.mockImplementation(() => new Promise(() => undefined));
    const day = pair(1, 28_800, { userExpiresIn: 28_800 });
    h.chain.arm(day, livesOf(day), Number.NaN, at(0));
    expect(h.renew).toHaveBeenCalledTimes(1);
    await advanceTo(28_800.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    expect(h.chain.state).toBe("renewing");
    await advanceTo(28_801);
    expect(h.onEnded, "END at E_hi = R + 28,801 s").toHaveBeenCalledTimes(1);
    expect(Math.max(...h.timerArgs), "no setTimeout argument above CHUNK").toBeLessThanOrEqual(FRAME_TIMER_CHUNK_MS);
    expect(h.timerArgs.filter((ms) => ms === FRAME_TIMER_CHUNK_MS)).toHaveLength(8);
    expect(h.maxLiveTimers).toBe(1);
  });

  it("MF2: C04 with the cap reached in the same answer: one attempt at once; a refusal holds to E_hi and ends", async () => {
    const h = harness();
    h.renew.mockResolvedValue({ ok: false, reason: "renew_not_renewable" });
    const capped = pair(1, 300, { userExpiresIn: 300, sessionExpiresIn: 300 });
    h.chain.arm(capped, livesOf(capped), Number.NaN, at(0));
    expect(h.renew, "C04: exactly one request at once, even with capReached").toHaveBeenCalledTimes(1);
    await advance(0);
    expect(h.chain.state).toBe("holding");
    await advanceTo(300.999);
    expect(h.onEnded).not.toHaveBeenCalled();
    await advanceTo(301);
    expect(h.onEnded, "END at E_hi = R + 301 s").toHaveBeenCalledTimes(1);
    expect(h.renew).toHaveBeenCalledTimes(1);
  });

  it("MF2: C04 with the cap reached in the same answer: a success re-anchors on A'", async () => {
    const h = harness();
    h.renew.mockResolvedValueOnce({ ok: true, credential: pair(2), receivedAt: at(0) });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    const capped = pair(1, 300, { userExpiresIn: 300, sessionExpiresIn: 300 });
    h.chain.arm(capped, livesOf(capped), Number.NaN, at(0));
    expect(h.renew).toHaveBeenCalledTimes(1);
    await advance(0);
    expect(h.onRenewed).toHaveBeenCalledWith(pair(2));
    await advanceTo(209.999);
    expect(h.renew).toHaveBeenCalledTimes(1);
    await advanceTo(210);
    expect(h.renew, "re-anchored on A' = 0: next at 210").toHaveBeenCalledTimes(2);
  });

  it("MF3: dispose aborts the renewal in flight, and quiesce no longer waits for it", async () => {
    const h = harness();
    h.renew.mockImplementation(() => new Promise(() => undefined)); // never answers
    armWithLeft(h, pair(1), 60);
    expect(h.chain.state).toBe("renewing");
    let early = false;
    void h.chain.quiesce().then(() => {
      early = true;
    });
    await advance(0);
    expect(early, "control: quiesce waits while the request is the chain's own").toBe(false);
    h.chain.dispose();
    await advance(0);
    expect(early, "a quiesce already waiting settles at the dispose").toBe(true);
    expect(h.signals[0]!.aborted, "dispose aborts it").toBe(true);
    // A new sign-in on the same instance: its quiesce settles at once.
    h.chain.arm(pair(3), livesOf(pair(3)), Date.now(), Date.now());
    let quick = false;
    void h.chain.quiesce().then(() => {
      quick = true;
    });
    await advance(0);
    expect(quick, "the obsolete request never holds the new sign-in back").toBe(true);
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("MF3: a new arm() gives up the request of the chain it replaces", async () => {
    const h = harness();
    h.renew.mockImplementation(() => new Promise(() => undefined));
    armWithLeft(h, pair(1), 60);
    expect(h.chain.state).toBe("renewing");
    h.chain.arm(pair(5), livesOf(pair(5)), Date.now(), Date.now());
    let quick = false;
    void h.chain.quiesce().then(() => {
      quick = true;
    });
    await advance(0);
    expect(quick, "quiesce does not wait for the replaced chain's request").toBe(true);
    expect(h.signals[0]!.aborted).toBe(true);
    expect(h.chain.state).toBe("armed");
  });

  // The deadline callback's guards (self-check C2). Each is reached only by a
  // timer that fires although the chain cleared it, so these cases use a clear
  // that does not take. Two guards stop such a timer: the generation test of
  // every chain timer (setChainTimer) and the deadline's own state test. The
  // fold 1 cure removed the deadline's `chain !== c` and `c.ended` tests: the
  // generation implies the first, and the state test implies the second (see
  // watchRequest). Mutant check (fold 1 run 7): removing the state test turns
  // the 429-wait case red; removing the generation test turns the stale-retry
  // case red. GREEN AT a895dbef TOO (it set no deadline).
  it("MF1 guard: a deadline that fires during a 429 retry wait changes nothing (state is not renewing)", async () => {
    const h = harness({ leakyClear: true });
    const signIn = pair(1, 300, { userExpiresIn: 900 });
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: false, reason: "renew_rate_limited" }), 90_000);
        }),
    );
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: true, credential: pair(2) }), 1_000);
        }),
    );
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(signIn, livesOf(signIn), at(0), at(0));
    await advanceTo(300);
    expect(h.requests.map((r) => r.at)).toEqual([210]);
    expect(h.chain.state, "the 429 at 300 s waits 5 s").toBe("retry_wait");
    const generation = h.chain.generation;
    await advanceTo(301);
    expect(h.onEnded, "the old deadline (301 s) fired in the retry wait: dropped").not.toHaveBeenCalled();
    expect(h.chain.generation).toBe(generation);
    expect(h.chain.state).toBe("retry_wait");
    await advanceTo(306);
    expect(h.requests.map((r) => r.at), "the retry goes out at 305 s").toEqual([210, 305]);
    expect(h.onRenewed).toHaveBeenCalledWith(pair(2));
    expect(h.onEnded).not.toHaveBeenCalled();
  });

  it("MF1 guard: a deadline that fires after the chain ended moves nothing (state is ended, not renewing)", async () => {
    const h = harness({ leakyClear: true });
    h.renew.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => resolve({ ok: false, reason: "renew_failed" }), 10_000);
        }),
    );
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(220);
    expect(h.onEnded, "C14: renew_failed ends at once").toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("ended");
    const generation = h.chain.generation;
    await advanceTo(400);
    expect(h.chain.generation, "the stale deadline (301 s) moved no generation").toBe(generation);
    expect(h.onEnded).toHaveBeenCalledTimes(1);
    expect(h.chain.state).toBe("ended");
    expect(h.renew).toHaveBeenCalledTimes(1);
  });

  it("MF1 guard: a deadline that fires after dispose changes nothing (generation, and state idle)", async () => {
    const h = harness({ leakyClear: true });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    h.chain.arm(pair(1), livesOf(pair(1)), at(0), at(0));
    await advanceTo(210);
    expect(h.chain.state).toBe("renewing");
    h.chain.dispose();
    const generation = h.chain.generation;
    await advanceTo(400);
    expect(h.onEnded, "the disposed chain's deadline (301 s) reaches nobody").not.toHaveBeenCalled();
    expect(h.chain.state).toBe("idle");
    expect(h.chain.generation).toBe(generation);
  });

  it("MF1 guard: a stale retry timer of a replaced chain changes nothing (the generation)", async () => {
    const h = harness({ leakyClear: true });
    h.renew.mockResolvedValueOnce({ ok: false, reason: "renew_rate_limited" });
    h.renew.mockImplementation(() => new Promise(() => undefined));
    armWithLeft(h, pair(1), 50);
    await advance(0);
    expect(h.chain.state, "the 429 at 0 s waits 5 s").toBe("retry_wait");
    await advance(1);
    // A new sign-in at 1 s replaces the chain; its first renewal is due at
    // A + 210 s = 211 s. The old chain's retry timer (5 s) and deadline
    // (90 s) still fire, because the clear does not take.
    h.chain.arm(pair(2), livesOf(pair(2)), Date.now(), Date.now());
    expect(h.chain.state).toBe("armed");
    await advanceTo(210.999);
    expect(h.requests.map((r) => r.at), "no retry request on the new chain").toEqual([0]);
    expect(h.chain.state).toBe("armed");
    await advanceTo(211);
    expect(h.requests.map((r) => [r.at, r.presented.userToken])).toEqual([
      [0, "cwu_1"],
      [211, "cwu_2"],
    ]);
    expect(h.onEnded).not.toHaveBeenCalled();
  });
});
