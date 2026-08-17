/**
 * The schedule PROPOSAL token (cinatra#2569, epic #2564 S5).
 *
 * Seam proof of the four properties §VI's "nothing exists until the reader
 * confirms" rests on: the proposal is UNFORGEABLE, UNREADABLE, SHORT-LIVED, and
 * BOUND to the reader it was proposed to. (The fifth — spendable once — is a
 * database unique index and is proven against real Postgres in
 * `packages/agents/src/__tests__/trigger-schedule-proposal.integration.test.ts`,
 * because a stateless token cannot express it.)
 */
import { describe, it, expect, beforeAll } from "vitest";

import {
  PROPOSAL_REF_MAX_LENGTH,
  PROPOSAL_TTL_SECONDS,
  mintTriggerScheduleProposalToken,
  proposalConsumeKey,
  readProposalSchedule,
  readTriggerScheduleProposalToken,
  verifyTriggerScheduleProposalToken,
  type ProposalSchedule,
} from "../trigger-schedule-proposal-token";
import { LIFECYCLE_VIEW_REF_MAX_LENGTH } from "@cinatra-ai/agent-ui-protocol/renderable-views";

const USER = "user_01HQZX8K7M4N2P9R3T5V6W8Y0A";
const ORG = "org_01HQZX8K7M4N2P9R3T5V6W8Y0B";
const TEMPLATE = "5f9c2b1e-8a4d-4c7f-9e1b-3d6a8c0f2e47";

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

function mint(schedule: ProposalSchedule = WEEKDAYS_9AM, over: Partial<{ userId: string; orgId: string; templateId: string }> = {}) {
  const minted = mintTriggerScheduleProposalToken({
    templateId: over.templateId ?? TEMPLATE,
    userId: over.userId ?? USER,
    orgId: over.orgId ?? ORG,
    schedule,
  });
  expect(minted).not.toBeNull();
  return minted!;
}

function verify(token: string, over: Partial<{ expectedUserId: string; expectedOrgId: string; nowSeconds: number }> = {}) {
  return verifyTriggerScheduleProposalToken({
    token,
    expectedUserId: over.expectedUserId ?? USER,
    expectedOrgId: over.expectedOrgId ?? ORG,
    ...(over.nowSeconds !== undefined ? { nowSeconds: over.nowSeconds } : {}),
  });
}

// Set unconditionally: the root vitest setup seeds an EMPTY string, which is
// not nullish, so a `??` default would leave the key derivation without a
// secret and every mint would (correctly) refuse.
beforeAll(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-schedule-proposal-token";
});

describe("mint → verify round trip", () => {
  it("returns exactly what was proposed", () => {
    const { token } = mint();
    const proposal = verify(token);
    expect(proposal).not.toBeNull();
    expect(proposal!.templateId).toBe(TEMPLATE);
    expect(proposal!.userId).toBe(USER);
    expect(proposal!.orgId).toBe(ORG);
    expect(proposal!.schedule).toEqual(WEEKDAYS_9AM);
  });

  it("carries the same consume key the mint reported — the DB spends what the caller was told", () => {
    const minted = mint();
    const proposal = verify(minted.token)!;
    expect(proposalConsumeKey(proposal.nonce)).toBe(minted.consumeKey);
  });

  it("gives every mint a DIFFERENT consume identity, so Adjust re-proposing can never collide with what it replaced", () => {
    const a = mint();
    const b = mint();
    expect(a.consumeKey).not.toBe(b.consumeKey);
    expect(a.token).not.toBe(b.token);
  });
});

describe("the token is OPAQUE — it rides a persisted, model-visible transcript", () => {
  it("leaks no identifier a reader of the transcript could recover", () => {
    const { token } = mint();
    // The literal strings, and their base64/base64url encodings, must all be
    // absent: the whole point of authenticated ENCRYPTION over a signed JWT is
    // that the payload is not readable off the wire.
    for (const secret of [TEMPLATE, USER, ORG, "Europe/Berlin", "weekly"]) {
      expect(token).not.toContain(secret);
      expect(token).not.toContain(Buffer.from(secret, "utf8").toString("base64url"));
      expect(token).not.toContain(
        Buffer.from(secret, "utf8").toString("base64").replace(/=+$/, ""),
      );
    }
  });

  it("is not a JWT — nothing in it decodes to readable JSON", () => {
    const { token } = mint();
    expect(token.split(".")).toHaveLength(1);
    expect(() => JSON.parse(Buffer.from(token, "base64url").toString("utf8"))).toThrow();
  });

  it("does not store the nonce in the consume key — a dump of the ledger yields nothing replayable", () => {
    const minted = mint();
    const proposal = verify(minted.token)!;
    expect(minted.consumeKey).not.toContain(proposal.nonce);
    expect(minted.consumeKey).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the token is UNFORGEABLE", () => {
  it("rejects a tampered ciphertext", () => {
    const { token } = mint();
    // Flip one character in the body (past the IV, before the tag).
    const mid = Math.floor(token.length / 2);
    const flipped =
      token.slice(0, mid) + (token[mid] === "A" ? "B" : "A") + token.slice(mid + 1);
    expect(verify(flipped)).toBeNull();
  });

  it("rejects a truncated token", () => {
    const { token } = mint();
    expect(verify(token.slice(0, token.length - 8))).toBeNull();
  });

  it("rejects a token minted under a different secret", () => {
    const original = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "a-completely-different-secret";
    const { token } = mint();
    process.env.BETTER_AUTH_SECRET = original;
    expect(verify(token)).toBeNull();
  });

  it("rejects a non-base64url string, an empty string and garbage", () => {
    for (const bad of ["", "not a token", "abc!def", "=====", "a".repeat(600)]) {
      expect(verify(bad)).toBeNull();
    }
  });

  it("rejects null/undefined without throwing", () => {
    expect(
      verifyTriggerScheduleProposalToken({
        token: null,
        expectedUserId: USER,
        expectedOrgId: ORG,
      }),
    ).toBeNull();
    expect(
      verifyTriggerScheduleProposalToken({
        token: undefined,
        expectedUserId: USER,
        expectedOrgId: ORG,
      }),
    ).toBeNull();
  });
});

describe("the token EXPIRES", () => {
  it("verifies inside its window", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: now },
    )!;
    expect(verify(minted.token, { nowSeconds: now + PROPOSAL_TTL_SECONDS - 1 })).not.toBeNull();
  });

  it("refuses AT the expiry second, not merely after it", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: now },
    )!;
    expect(verify(minted.token, { nowSeconds: now + PROPOSAL_TTL_SECONDS })).toBeNull();
  });

  it("refuses a future-dated proposal", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: now + 600 },
    )!;
    expect(verify(minted.token, { nowSeconds: now })).toBeNull();
  });
});

describe("the token is BOUND", () => {
  it("refuses a different user", () => {
    const { token } = mint();
    expect(verify(token, { expectedUserId: "user_someone_else" })).toBeNull();
  });

  it("refuses a different org, even for the same user", () => {
    const { token } = mint();
    expect(verify(token, { expectedOrgId: "org_someone_else" })).toBeNull();
  });

  it("keeps the template it was minted for — a proposal for agent A cannot name agent B", () => {
    const a = mint(WEEKDAYS_9AM, { templateId: "template-a" });
    const b = mint(WEEKDAYS_9AM, { templateId: "template-b" });
    expect(verify(a.token)!.templateId).toBe("template-a");
    expect(verify(b.token)!.templateId).toBe("template-b");
  });
});

describe("the token FITS the wire", () => {
  it("stays inside S1's ref bound for every option row", () => {
    const schedules: ProposalSchedule[] = [
      { kind: "immediate" },
      { kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "America/Argentina/ComodRivadavia" },
      WEEKDAYS_9AM,
      {
        kind: "recurring",
        timezone: "America/Argentina/ComodRivadavia",
        selection: {
          frequency: "weekly",
          interval: 52,
          weekdays: [0, 1, 2, 3, 4, 5, 6],
          dayOfMonth: 31,
          monthlyMode: "weekday",
          nthWeek: 4,
          monthlyWeekday: 6,
          quarterAnchor: "end",
          yearlyMonth: 12,
          hour: 23,
          minute: 59,
        },
      },
    ];
    for (const schedule of schedules) {
      const { token } = mint(schedule);
      expect(token.length).toBeLessThanOrEqual(PROPOSAL_REF_MAX_LENGTH);
      expect(verify(token)!.schedule).toEqual(schedule);
    }
  });

  it("leaves real headroom for an ordinary recurring proposal, not a hair's breadth", () => {
    // The compact positional encoding exists for this: the same proposal in a
    // named-field JSON object overflows the 512-character ref bound outright.
    const { token } = mint();
    expect(token.length).toBeLessThan(PROPOSAL_REF_MAX_LENGTH * 0.85);
  });

  it("pins its bound to the protocol's — a drift here silently stops cards minting", () => {
    expect(PROPOSAL_REF_MAX_LENGTH).toBe(LIFECYCLE_VIEW_REF_MAX_LENGTH);
  });

  it("refuses to mint for an id beyond the bound rather than emitting an oversized ref", () => {
    expect(
      mintTriggerScheduleProposalToken({
        templateId: "t".repeat(200),
        userId: USER,
        orgId: ORG,
        schedule: WEEKDAYS_9AM,
      }),
    ).toBeNull();
  });
});

describe("the schedule is one the FORM could have produced", () => {
  it("accepts the three option rows", () => {
    expect(readProposalSchedule({ kind: "immediate" })).toEqual({ kind: "immediate" });
    expect(
      readProposalSchedule({ kind: "scheduled", runAt: "2026-07-14T09:00", timezone: "UTC" }),
    ).not.toBeNull();
    expect(readProposalSchedule(WEEKDAYS_9AM)).toEqual(WEEKDAYS_9AM);
  });

  it("refuses out-of-range selections the scheduling step's own controls forbid", () => {
    const bad = [
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, hour: 24 } },
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, minute: 60 } },
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, interval: 0 } },
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, weekdays: [7] } },
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, nthWeek: 5 } },
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, yearlyMonth: 13 } },
      { ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, frequency: "hourly" } },
    ];
    for (const schedule of bad) expect(readProposalSchedule(schedule)).toBeNull();
  });

  it("refuses a WEEKLY selection with no day — the form always carries one, and guessing Monday would arm a day nobody picked", () => {
    expect(
      readProposalSchedule({ ...WEEKDAYS_9AM, selection: { ...WEEKDAYS_9AM.selection, weekdays: [] } }),
    ).toBeNull();
  });

  it("refuses a duplicated weekday rather than silently de-duplicating it", () => {
    expect(
      readProposalSchedule({
        ...WEEKDAYS_9AM,
        selection: { ...WEEKDAYS_9AM.selection, weekdays: [1, 1, 2] },
      }),
    ).toBeNull();
  });

  it("refuses an ISO/offset datetime — the form emits a NAIVE wall clock read in the chosen zone", () => {
    expect(
      readProposalSchedule({
        kind: "scheduled",
        runAt: "2026-07-14T09:00:00Z",
        timezone: "Europe/Berlin",
      }),
    ).toBeNull();
    expect(
      readProposalSchedule({
        kind: "scheduled",
        runAt: "2026-07-14T09:00:00+02:00",
        timezone: "Europe/Berlin",
      }),
    ).toBeNull();
  });

  it("refuses a well-SHAPED but impossible wall clock — codex round-1 finding", () => {
    // The regex alone accepts these. A card the reader can press Confirm on for
    // a moment that cannot exist would fail at INSTALL time, after the run is
    // created — so the proposal refuses instead and the assistant re-asks.
    for (const runAt of [
      "2026-99-99T99:99",
      "2026-13-01T09:00",
      "2026-02-30T09:00",
      "2026-01-01T25:00",
      "2026-01-01T09:61",
    ]) {
      expect(
        readProposalSchedule({ kind: "scheduled", runAt, timezone: "UTC" }),
        runAt,
      ).toBeNull();
    }
    // …and a real one still passes, including a leap day.
    expect(
      readProposalSchedule({ kind: "scheduled", runAt: "2028-02-29T09:00", timezone: "UTC" }),
    ).not.toBeNull();
  });

  it("refuses a timezone this runtime cannot resolve — codex round-1 finding", () => {
    for (const timezone of ["Mars/Olympus_Mons", "Not/A/Zone", "GMT+25", "  "]) {
      expect(
        readProposalSchedule({ kind: "scheduled", runAt: "2026-07-14T09:00", timezone }),
        timezone,
      ).toBeNull();
      expect(
        readProposalSchedule({ ...WEEKDAYS_9AM, timezone }),
        timezone,
      ).toBeNull();
    }
    for (const timezone of ["UTC", "Europe/Berlin", "America/Argentina/ComodRivadavia"]) {
      expect(readProposalSchedule({ ...WEEKDAYS_9AM, timezone }), timezone).not.toBeNull();
    }
  });

  it("refuses an unknown kind, a raw cron, and non-objects", () => {
    expect(readProposalSchedule({ kind: "cron", cronExpression: "0 9 * * 1-5" })).toBeNull();
    expect(readProposalSchedule({ kind: "immediate", cronExpression: "0 9 * * *" })).toBeNull();
    expect(readProposalSchedule(null)).toBeNull();
    expect(readProposalSchedule([])).toBeNull();
    expect(readProposalSchedule("immediate")).toBeNull();
  });

  it("normalizes weekday order so the same selection always yields the same schedule", () => {
    const scrambled = readProposalSchedule({
      ...WEEKDAYS_9AM,
      selection: { ...WEEKDAYS_9AM.selection, weekdays: [5, 1, 3, 2, 4] },
    });
    expect(scrambled).toEqual(WEEKDAYS_9AM);
  });
});

describe("the EXPIRED reading belongs to the token's OWN reader, and to nobody else", () => {
  const read = (
    token: string,
    over: Partial<{
      expectedUserId: string;
      expectedOrgId: string;
      nowSeconds: number;
    }> = {},
  ) =>
    readTriggerScheduleProposalToken({
      token,
      expectedUserId: over.expectedUserId ?? USER,
      expectedOrgId: over.expectedOrgId ?? ORG,
      ...(over.nowSeconds !== undefined ? { nowSeconds: over.nowSeconds } : {}),
    });

  const mintAt = (now: number) =>
    mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: now },
    )!;

  it("reads a proposal inside its window as LIVE, with the proposal intact", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    const reading = read(minted.token, { nowSeconds: now + 60 });
    expect(reading?.status).toBe("live");
    expect(reading?.proposal.templateId).toBe(TEMPLATE);
    expect(reading?.proposal.schedule).toEqual(WEEKDAYS_9AM);
  });

  it("reads the reader's OWN timed-out proposal as EXPIRED rather than as nothing", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    const reading = read(minted.token, { nowSeconds: now + PROPOSAL_TTL_SECONDS });
    expect(reading?.status).toBe("expired");
    // The body §VI's expired card draws comes off this reading, so it has to
    // survive the expiry — the card says WHAT expired, not merely that it did.
    expect(reading?.proposal.templateId).toBe(TEMPLATE);
    expect(reading?.proposal.schedule).toEqual(WEEKDAYS_9AM);
  });

  it("still reads as expired long afterwards — reopening the conversation is not a deadline", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    const aWeekOn = now + 7 * 24 * 3600;
    expect(read(minted.token, { nowSeconds: aWeekOn })?.status).toBe("expired");
  });

  // THE CONSTRAINT. Entitlement is decided before the clock is read, so every
  // token this reader was not minted refuses identically — expired or not.
  it("refuses another user's proposal identically whether or not it has expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    const stranger = { expectedUserId: "user_someone_else" };
    expect(read(minted.token, { ...stranger, nowSeconds: now + 60 })).toBeNull();
    expect(
      read(minted.token, { ...stranger, nowSeconds: now + PROPOSAL_TTL_SECONDS }),
    ).toBeNull();
  });

  it("refuses another org's proposal identically whether or not it has expired", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    const elsewhere = { expectedOrgId: "org_someone_else" };
    expect(read(minted.token, { ...elsewhere, nowSeconds: now + 60 })).toBeNull();
    expect(
      read(minted.token, { ...elsewhere, nowSeconds: now + PROPOSAL_TTL_SECONDS }),
    ).toBeNull();
  });

  it("gives ONE indistinguishable refusal for every token that is not this reader's", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    const tampered = `${minted.token.slice(0, -2)}${minted.token.endsWith("aa") ? "bb" : "aa"}`;
    const refusals = [
      // forged / not one of ours
      read("not-a-token", { nowSeconds: now }),
      read(tampered, { nowSeconds: now }),
      read("", { nowSeconds: now }),
      // structurally ours, but not this reader's
      read(minted.token, { expectedUserId: "user_x", nowSeconds: now }),
      read(minted.token, { expectedOrgId: "org_x", nowSeconds: now }),
      // ours, but the minter never emits it: dated into the future
      read(mintAt(now + 600).token, { nowSeconds: now }),
      // and all of the above again, well past the expiry
      read("not-a-token", { nowSeconds: now + PROPOSAL_TTL_SECONDS }),
      read(tampered, { nowSeconds: now + PROPOSAL_TTL_SECONDS }),
      read(minted.token, {
        expectedUserId: "user_x",
        nowSeconds: now + PROPOSAL_TTL_SECONDS,
      }),
    ];
    // Not "each is falsy" — each is the SAME answer, so no branch of this
    // function can be used to tell the cases apart.
    for (const refusal of refusals) expect(refusal).toBeNull();
    expect(new Set(refusals).size).toBe(1);
  });

  it("leaves CONFIRM's reading exactly as it was — an expired proposal is still unspendable", () => {
    const now = Math.floor(Date.now() / 1000);
    const minted = mintAt(now);
    // The card may read it; verify — the one Confirm and the producer use —
    // must not, and must not learn to say why.
    expect(read(minted.token, { nowSeconds: now + PROPOSAL_TTL_SECONDS })?.status).toBe(
      "expired",
    );
    expect(verify(minted.token, { nowSeconds: now + PROPOSAL_TTL_SECONDS })).toBeNull();
    expect(verify(minted.token, { nowSeconds: now + 60 })).not.toBeNull();
  });

  it("never lets a refused token arrive as a drawn expired card", () => {
    // The structural checks all run BEFORE the clock is read, so a token that
    // fails any of them answers `null` — never `expired`. A future-dated one is
    // the case that is constructible without forging plaintext under our key.
    const now = Math.floor(Date.now() / 1000);
    const future = mintAt(now + 600);
    expect(read(future.token, { nowSeconds: now })).toBeNull();
    // …and it does not become drawable merely by waiting past its expiry.
    expect(
      read(future.token, { nowSeconds: now + 600 + PROPOSAL_TTL_SECONDS }),
    ).not.toBeNull();
  });
});

describe("an INHERITED nonce is one consume identity, not two", () => {
  // The mechanism the expired card's Adjust is built on: a re-proposal must
  // never become a second independently spendable copy of the question it
  // re-asks. `proposalConsumeKey` derives the single-use DB edge from the
  // NONCE, so inheriting the nonce is what makes the old card and the new one
  // one row under that table's primary key.

  const read = (token: string) =>
    readTriggerScheduleProposalToken({
      token,
      expectedUserId: USER,
      expectedOrgId: ORG,
    });

  it("mints a genuinely fresh TOKEN that addresses the SAME consume key", () => {
    const original = mint();
    const inherited = read(original.token);
    expect(inherited).not.toBeNull();

    const replacement = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nonce: inherited!.proposal.nonce },
    );
    expect(replacement).not.toBeNull();

    // A fresh envelope — fresh IV, fresh ciphertext, fresh window…
    expect(replacement!.token).not.toBe(original.token);
    // …addressing the identity that is already spoken for.
    expect(replacement!.consumeKey).toBe(original.consumeKey);
    expect(proposalConsumeKey(inherited!.proposal.nonce)).toBe(original.consumeKey);
  });

  it("gives the replacement its OWN window, starting now", () => {
    const now = Math.floor(Date.now() / 1000);
    const original = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: now - PROPOSAL_TTL_SECONDS - 60 },
    );
    expect(original).not.toBeNull();
    const expired = read(original!.token);
    expect(expired?.status).toBe("expired");

    const replacement = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nowSeconds: now, nonce: expired!.proposal.nonce },
    );
    // Live again, and still the same identity: the reader gets a new window on
    // the same question rather than a second question.
    expect(read(replacement!.token)?.status).toBe("live");
    expect(replacement!.consumeKey).toBe(original!.consumeKey);
  });

  it("still binds the replacement to its reader — inheriting an identity widens nothing", () => {
    const original = mint();
    const inherited = read(original.token)!.proposal.nonce;
    const replacement = mintTriggerScheduleProposalToken(
      { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
      { nonce: inherited },
    );
    expect(
      verifyTriggerScheduleProposalToken({
        token: replacement!.token,
        expectedUserId: "user_someone_else",
        expectedOrgId: ORG,
      }),
    ).toBeNull();
  });

  it("refuses a nonce outside the id bound rather than minting a mutilated identity", () => {
    for (const nonce of ["", "   ", "n".repeat(129)]) {
      expect(
        mintTriggerScheduleProposalToken(
          { templateId: TEMPLATE, userId: USER, orgId: ORG, schedule: WEEKDAYS_9AM },
          { nonce },
        ),
      ).toBeNull();
    }
  });
});

describe("no secret, no proposal", () => {
  it("refuses to mint and refuses to verify", () => {
    const original = process.env.BETTER_AUTH_SECRET;
    const { token } = mint();
    delete process.env.BETTER_AUTH_SECRET;
    try {
      expect(
        mintTriggerScheduleProposalToken({
          templateId: TEMPLATE,
          userId: USER,
          orgId: ORG,
          schedule: WEEKDAYS_9AM,
        }),
      ).toBeNull();
      expect(verify(token)).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = original;
    }
  });
});
