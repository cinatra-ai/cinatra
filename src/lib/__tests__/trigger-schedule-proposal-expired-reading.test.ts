/**
 * AN EXPIRED PROPOSAL IS A READING, NOT AN ABSENCE — at the token (cinatra#2836).
 *
 * Plan: `PLAN: Agents Lifecycle (A)` §7.2 step 2 — "an expired card **stays
 * visible**, still editable, with **Confirm** to set the schedule again" — and
 * §7.4 as-designed step 5, which repeats it. Design `app-lifecycle-cards.html`
 * §IV reserves the undrawn answer for a reader who may not see the subject AT
 * ALL, which a reader whose own thirty minutes ran out plainly is not.
 *
 * THE CONSTRAINT THIS FILE EXISTS TO PIN. The fix may not become an oracle. The
 * resolver must still be unable to tell anyone whether an unauthorized token was
 * expired, foreign or forged, so "expired" has to be unreachable for any token
 * the caller does not already own. That is not a promise about intent; it is a
 * property of the CHECK ORDER, and this file tests the order by testing the only
 * thing an attacker can observe — the answer, and the shape of the work behind it.
 *
 * Seam tier: the token is REAL. Every mint and every verify here is genuine
 * AES-256-GCM under a real key, because "an expired-but-foreign token is
 * indistinguishable from a forged one" is a claim about actual crypto and actual
 * branch order; mocking either would test the mock.
 */
import { describe, it, expect, beforeAll } from "vitest";

import {
  PROPOSAL_TTL_SECONDS,
  mintTriggerScheduleProposalToken,
  verifyTriggerScheduleProposalToken,
  verifyTriggerScheduleProposalTokenDetailed,
  type ProposalSchedule,
  type ProposalTokenVerification,
} from "@/lib/trigger-schedule-proposal-token";

const ORG = "org_2836_expired_reading";
const USER = "user_2836_reader";
const OTHER_USER = "user_2836_someone_else";
const OTHER_ORG = "org_2836_elsewhere";
const TEMPLATE = "6d2f8a3c-1b4e-4f7a-8c9d-2e5f1a7b3c48";

const WEEKDAYS_9AM: ProposalSchedule = {
  kind: "recurring",
  timezone: "Europe/Berlin",
  selection: {
    frequency: "weekly",
    interval: 1,
    weekdays: [1, 2, 3, 4, 5],
    dayOfMonth: 1,
    monthlyMode: "date",
    nthWeek: 1,
    monthlyWeekday: 0,
    quarterAnchor: "start",
    yearlyMonth: 1,
    hour: 9,
    minute: 0,
  },
};

const nowSeconds = () => Math.floor(Date.now() / 1000);

/** A proposal minted long enough ago that its window has closed. */
function mintExpired(
  who: { userId: string; orgId: string } = { userId: USER, orgId: ORG },
): string {
  const minted = mintTriggerScheduleProposalToken(
    { templateId: TEMPLATE, userId: who.userId, orgId: who.orgId, schedule: WEEKDAYS_9AM },
    { nowSeconds: nowSeconds() - PROPOSAL_TTL_SECONDS - 60 },
  );
  expect(minted).not.toBeNull();
  return minted!.token;
}

/** A proposal whose window is still open. */
function mintLive(
  who: { userId: string; orgId: string } = { userId: USER, orgId: ORG },
): string {
  const minted = mintTriggerScheduleProposalToken({
    templateId: TEMPLATE,
    userId: who.userId,
    orgId: who.orgId,
    schedule: WEEKDAYS_9AM,
  });
  expect(minted).not.toBeNull();
  return minted!.token;
}

/** A token of this server's, with its ciphertext corrupted — a forgery. */
function forge(): string {
  const raw = Buffer.from(mintLive(), "base64url");
  raw[raw.length - 1] ^= 0xff;
  return raw.toString("base64url");
}

const asReader = (token: string): ProposalTokenVerification =>
  verifyTriggerScheduleProposalTokenDetailed({
    token,
    expectedUserId: USER,
    expectedOrgId: ORG,
  });

beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-2836-expired-reading";
});

// ---------------------------------------------------------------------------
// The reading itself
// ---------------------------------------------------------------------------

describe("an expired token the reader OWNS resolves to the expired reading", () => {
  it("reports `expired`, and hands back the schedule the reader stated", () => {
    const verified = asReader(mintExpired());

    expect(verified.outcome).toBe("expired");
    if (verified.outcome !== "expired") return;
    // The rows the reader last saw, read back intact — this is what re-opens
    // the expired card on their own schedule instead of on an empty form.
    expect(verified.proposal.schedule).toEqual(WEEKDAYS_9AM);
    expect(verified.proposal.templateId).toBe(TEMPLATE);
    expect(verified.proposal.userId).toBe(USER);
    expect(verified.proposal.orgId).toBe(ORG);
    expect(verified.proposal.nonce).toBeTruthy();
  });

  it("a LIVE token is still plain `valid` — the window is the only difference", () => {
    const verified = asReader(mintLive());
    expect(verified.outcome).toBe("valid");
  });

  it("refuses AT the expiry second, not merely after it", () => {
    const mintedAt = nowSeconds() - PROPOSAL_TTL_SECONDS;
    const minted = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: mintedAt },
    );
    expect(minted).not.toBeNull();
    // Exactly at `exp` the proposal is already over (RFC 7519: now MUST be
    // before exp) — so this is the expired READING, not a live card.
    expect(
      verifyTriggerScheduleProposalTokenDetailed({
        token: minted!.token,
        expectedUserId: USER,
        expectedOrgId: ORG,
        nowSeconds: mintedAt + PROPOSAL_TTL_SECONDS,
      }).outcome,
    ).toBe("expired");
    expect(
      verifyTriggerScheduleProposalTokenDetailed({
        token: minted!.token,
        expectedUserId: USER,
        expectedOrgId: ORG,
        nowSeconds: mintedAt + PROPOSAL_TTL_SECONDS - 1,
      }).outcome,
    ).toBe("valid");
  });
});

// ---------------------------------------------------------------------------
// THE CONSTRAINT: expired is unreachable for a token the caller does not own
// ---------------------------------------------------------------------------

describe("`expired` is unreachable for anything the reader does not own", () => {
  it("an expired token minted for ANOTHER USER is refused, never reported expired", () => {
    expect(asReader(mintExpired({ userId: OTHER_USER, orgId: ORG }))).toEqual({
      outcome: "refused",
    });
  });

  it("an expired token minted in ANOTHER ORG is refused, never reported expired", () => {
    expect(asReader(mintExpired({ userId: USER, orgId: OTHER_ORG }))).toEqual({
      outcome: "refused",
    });
  });

  it("a STRETCHED lifetime is a forgery signal, not an expiry — even when it has also run out", () => {
    // A tag-valid token can only get a non-TTL lifetime by being minted with
    // one, which this server never does. Reported expired, it would let anyone
    // claim a longer window and still be DRAWN a card. It stays flat `refused`,
    // and the check sits BEFORE the expiry reading so the order proves it.
    const key = process.env.BETTER_AUTH_SECRET;
    expect(key).toBeTruthy();
    // There is no API that mints a stretched token, which is the point; the
    // closest observable is a future-dated one, refused for the same reason.
    const future = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: nowSeconds() + 600 },
    );
    expect(future).not.toBeNull();
    expect(asReader(future!.token)).toEqual({ outcome: "refused" });
  });

  it("garbage, empty, oversized and forged refs are all refused", () => {
    for (const ref of ["", "not-a-token", "!!!!", "a".repeat(600), forge()]) {
      expect(asReader(ref), ref.slice(0, 12)).toEqual({ outcome: "refused" });
    }
    expect(
      verifyTriggerScheduleProposalTokenDetailed({
        token: null,
        expectedUserId: USER,
        expectedOrgId: ORG,
      }),
    ).toEqual({ outcome: "refused" });
  });
});

// ---------------------------------------------------------------------------
// INDISTINGUISHABILITY — the answer, byte for byte
// ---------------------------------------------------------------------------

describe("expired-foreign and forged are the SAME answer, byte for byte", () => {
  /** Every input that must be indistinguishable from every other. */
  const refusals = () => ({
    "expired + foreign user": mintExpired({ userId: OTHER_USER, orgId: ORG }),
    "expired + foreign org": mintExpired({ userId: USER, orgId: OTHER_ORG }),
    "live + foreign user": mintLive({ userId: OTHER_USER, orgId: ORG }),
    "live + foreign org": mintLive({ userId: USER, orgId: OTHER_ORG }),
    forged: forge(),
    garbage: "not-a-token",
    empty: "",
  });

  it("every refusal serializes to the same bytes", () => {
    const seen = new Map<string, string>();
    for (const [label, ref] of Object.entries(refusals())) {
      seen.set(label, JSON.stringify(asReader(ref)));
    }
    const distinct = new Set(seen.values());
    expect(
      distinct.size,
      `distinct refusal encodings: ${JSON.stringify([...seen])}`,
    ).toBe(1);
    expect([...distinct][0]).toBe('{"outcome":"refused"}');
  });

  it("every refusal is the SAME OBJECT — no branch can drift into its own shape", () => {
    const answers = Object.values(refusals()).map(asReader);
    const first = answers[0];
    for (const answer of answers) {
      // Reference identity, not deep equality: each rejecting branch returns
      // the one shared constant, so a future branch that built a fresh object
      // (and could then carry a field) fails here rather than in review.
      expect(Object.is(answer, first)).toBe(true);
    }
  });

  it("the refusal carries NO field beyond `outcome` — nothing to read a cause out of", () => {
    for (const ref of Object.values(refusals())) {
      expect(Object.keys(asReader(ref))).toEqual(["outcome"]);
    }
  });
});

// ---------------------------------------------------------------------------
// INDISTINGUISHABILITY — the shape of the work behind the answer
// ---------------------------------------------------------------------------

describe("expired-foreign does the SAME WORK as live-foreign", () => {
  /**
   * The load-bearing timing claim, and it is deliberately the narrow one.
   *
   * An expired FOREIGN token and a live FOREIGN token must exit at the very
   * same instruction — the binding compare — because expiry is read only after
   * both bindings pass. If the expiry reading had been left where it was
   * (before the bindings), the expired one would exit EARLIER and a caller
   * could time the difference. So this compares those two and expects no
   * separation.
   *
   * What it deliberately does NOT claim: that a FORGED token times like a
   * foreign one. A forgery fails inside `decipher.final()` and never reaches
   * the JSON parse, so it is genuinely cheaper — and it was already, byte for
   * byte, before this change. That gap is inherent to AEAD and is not something
   * this fix introduced, widened or can close; the covering test below only
   * pins that it stays within the same order of magnitude.
   */
  const SAMPLES = 4000;

  function medianNanos(ref: string): number {
    const timings: number[] = [];
    // A warm-up pass, so the first measured call is not the one that JITs.
    for (let i = 0; i < 500; i += 1) asReader(ref);
    for (let i = 0; i < SAMPLES; i += 1) {
      const started = process.hrtime.bigint();
      asReader(ref);
      timings.push(Number(process.hrtime.bigint() - started));
    }
    return median(timings);
  }

  function median(timings: number[]): number {
    timings.sort((a, b) => a - b);
    return timings[Math.floor(timings.length / 2)];
  }

  /**
   * The medians of two refs, sampled in ONE interleaved loop: every pass times
   * both, and the order inside the pass alternates. A burst of load on a busy
   * runner then lands on both arms alike instead of on one whole block, so the
   * ratio reads the work done and not the moment each block happened to run.
   */
  function pairedMedianNanos(refA: string, refB: string): [number, number] {
    const a: number[] = [];
    const b: number[] = [];
    for (let i = 0; i < 500; i += 1) {
      asReader(refA);
      asReader(refB);
    }
    const time = (ref: string, into: number[]) => {
      const started = process.hrtime.bigint();
      asReader(ref);
      into.push(Number(process.hrtime.bigint() - started));
    };
    for (let i = 0; i < SAMPLES; i += 1) {
      if (i % 2 === 0) {
        time(refA, a);
        time(refB, b);
      } else {
        time(refB, b);
        time(refA, a);
      }
    }
    return [median(a), median(b)];
  }

  it("expired-foreign and live-foreign are the same shape — expiry leaks no timing", () => {
    const expiredForeign = medianNanos(mintExpired({ userId: OTHER_USER, orgId: ORG }));
    const liveForeign = medianNanos(mintLive({ userId: OTHER_USER, orgId: ORG }));
    const ratio = expiredForeign / liveForeign;
    // Same path, so the medians track each other. The band is wide enough to
    // survive a loaded CI box and far too tight to hide an early return.
    expect(
      ratio,
      `expired-foreign ${expiredForeign}ns vs live-foreign ${liveForeign}ns`,
    ).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(2.5);
  });

  it("forged stays within the same order of magnitude — the pre-existing AEAD gap, not a new one", () => {
    // Three readings, each from one interleaved loop; the claim is decided on
    // their MEDIAN ratio (see forgedRatioVerdict below), so one reading taken in
    // a burst of load cannot fail it and one lucky reading cannot pass it.
    const expiredRef = mintExpired({ userId: OTHER_USER, orgId: ORG });
    const forgedRef = forge();
    const readings: ForgedReading[] = [];
    for (let attempt = 0; attempt < FORGED_ATTEMPTS; attempt += 1) {
      const [expiredForeign, forged] = pairedMedianNanos(expiredRef, forgedRef);
      readings.push({ expiredForeign, forged });
    }
    const verdict = forgedRatioVerdict(readings);
    expect(verdict.pass, verdict.message).toBe(true);
  });
});

/**
 * The decision of the forged timing test, pure so that its branches are
 * pinned without a clock.
 *
 * The forged path stops inside `decipher.final()` and is the cheaper one, so
 * the expired-foreign/forged ratio sits well above 1: CI runners read it at
 * about 10. The band is therefore 0.1 to 25. Both ends are strict. It still
 * fails a change that makes either path orders of magnitude slower or faster.
 * The decision is on the median of the per-reading ratios: one outlier in
 * either direction cannot decide it, and a steady shift moves the median.
 */
const FORGED_ATTEMPTS = 3;
const FORGED_RATIO_LOW = 0.1;
const FORGED_RATIO_HIGH = 25;

type ForgedReading = { expiredForeign: number; forged: number };

function forgedRatioVerdict(readings: ForgedReading[]): {
  pass: boolean;
  medianRatio: number;
  message: string;
} {
  const ratios = readings.map((r) => r.expiredForeign / r.forged);
  const sorted = [...ratios].sort((a, b) => a - b);
  const medianRatio = sorted[Math.floor(sorted.length / 2)];
  const pass =
    readings.length > 0 &&
    Number.isFinite(medianRatio) &&
    medianRatio > FORGED_RATIO_LOW &&
    medianRatio < FORGED_RATIO_HIGH;
  const lines = readings.map(
    (r, i) =>
      `attempt ${i + 1}/${readings.length}: ratio ${ratios[i]} ` +
      `(expired-foreign ${r.expiredForeign}ns vs forged ${r.forged}ns)`,
  );
  const message =
    `median ratio ${medianRatio} must be inside ${FORGED_RATIO_LOW}..${FORGED_RATIO_HIGH}; ` +
    lines.join("; ");
  return { pass, medianRatio, message };
}

describe("the forged timing decision reads the median ratio, not any one reading", () => {
  /** A reading with the given expired-foreign/forged ratio. */
  const r = (ratio: number): ForgedReading => ({ expiredForeign: ratio * 1000, forged: 1000 });

  it("passes a steady ratio inside the band", () => {
    expect(forgedRatioVerdict([r(9), r(10.2), r(11)]).pass).toBe(true);
  });

  it("fails at and above the upper bound", () => {
    expect(forgedRatioVerdict([r(25), r(25), r(25)]).pass).toBe(false);
    expect(forgedRatioVerdict([r(40), r(26), r(30)]).pass).toBe(false);
  });

  it("fails at and below the lower bound", () => {
    expect(forgedRatioVerdict([r(0.1), r(0.1), r(0.1)]).pass).toBe(false);
    expect(forgedRatioVerdict([r(0.05), r(0.09), r(0.2)]).pass).toBe(false);
  });

  it("one outside reading does not decide it, either way", () => {
    expect(forgedRatioVerdict([r(80), r(9), r(10)]).pass).toBe(true);
    expect(forgedRatioVerdict([r(9), r(10), r(80)]).pass).toBe(true);
    expect(forgedRatioVerdict([r(9), r(30), r(40)]).pass).toBe(false);
  });

  it("a steady regression near the bound fails although one reading falls inside", () => {
    expect(forgedRatioVerdict([r(26), r(24.9), r(26.5)]).pass).toBe(false);
    expect(forgedRatioVerdict([r(0.098), r(0.101), r(0.097)]).pass).toBe(false);
  });

  it("fails with no reading or a non-finite ratio", () => {
    expect(forgedRatioVerdict([]).pass).toBe(false);
    const zero: ForgedReading = { expiredForeign: 1, forged: 0 };
    expect(forgedRatioVerdict([r(9), zero, zero]).pass).toBe(false);
  });

  it("the failure message names every attempt and the band", () => {
    const { message } = forgedRatioVerdict([r(30), r(31), r(32)]);
    expect(message).toContain("attempt 1/3: ratio 30");
    expect(message).toContain("attempt 2/3: ratio 31");
    expect(message).toContain("attempt 3/3: ratio 32");
    expect(message).toContain("inside 0.1..25");
  });
});

// ---------------------------------------------------------------------------
// The collapsing wrapper is UNCHANGED
// ---------------------------------------------------------------------------

describe("the collapsing verify keeps its old contract exactly", () => {
  it("still answers `null` for an expired token — Confirm may not act on one", () => {
    // The whole point of leaving this entry point alone: every caller for whom
    // an expired proposal has nothing left to spend keeps refusing it, and none
    // of them can start accepting one by inheriting a widened return type.
    expect(
      verifyTriggerScheduleProposalToken({
        token: mintExpired(),
        expectedUserId: USER,
        expectedOrgId: ORG,
      }),
    ).toBeNull();
  });

  it("still answers `null` for foreign and forged, and the proposal for a live one", () => {
    for (const ref of [
      mintExpired({ userId: OTHER_USER, orgId: ORG }),
      mintLive({ userId: USER, orgId: OTHER_ORG }),
      forge(),
      "not-a-token",
    ]) {
      expect(
        verifyTriggerScheduleProposalToken({
          token: ref,
          expectedUserId: USER,
          expectedOrgId: ORG,
        }),
      ).toBeNull();
    }
    expect(
      verifyTriggerScheduleProposalToken({
        token: mintLive(),
        expectedUserId: USER,
        expectedOrgId: ORG,
      }),
    ).not.toBeNull();
  });
});
