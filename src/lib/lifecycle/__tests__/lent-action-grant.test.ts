// THE GRANT ITSELF (cinatra#2932, lifecycle-b W5a) — acceptance items 1 and 3.
//
//   1. "The lent action works only with the grant minted for that message and
//      card."
//   3. "A replayed or foreign grant, or one presented with another control, is
//      refused."
//
// This file proves the CODEC's half of both: what a grant says, and which calls
// it does and does not authorize. The SPEND half (item 2, and replay) is
// `lent-action-grant-store.test.ts`; the two halves meeting is
// `lent-action-mcp.test.ts`.

import { beforeEach, describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-lent-action-grant";

import {
  LENT_ACTION_CONTROLS,
  LENT_ACTION_GRANT_TTL_SECONDS,
  isLentActionControl,
  lentActionCardFingerprint,
  lentActionGrantDigest,
  matchLentActionGrant,
  mintLentActionGrant,
  verifyLentActionGrant,
} from "../lent-action-grant";

const PERSON = { userId: "usr_1", orgId: "org_1" };
const CARD = "ref-alpha";
const MESSAGE = "msg_1";

function mint(overrides: Partial<Parameters<typeof mintLentActionGrant>[0]> = {}) {
  const result = mintLentActionGrant({
    userId: PERSON.userId,
    orgId: PERSON.orgId,
    messageId: MESSAGE,
    cardRef: CARD,
    control: "comment",
    ...overrides,
  });
  if (!result) throw new Error("mint returned null");
  return result;
}

describe("the grant names the person, the message, the card and ONE control", () => {
  it("mints claims for exactly what it was asked for", () => {
    const { claims } = mint();
    expect(claims.userId).toBe(PERSON.userId);
    expect(claims.orgId).toBe(PERSON.orgId);
    expect(claims.messageId).toBe(MESSAGE);
    expect(claims.control).toBe("comment");
    expect(claims.cardRefFingerprint).toBe(lentActionCardFingerprint(CARD));
  });

  it("round-trips through verify with the same claims", () => {
    const { grant, claims } = mint();
    expect(verifyLentActionGrant(grant)).toEqual(claims);
  });

  it("carries neither the card ref nor the person in readable form", () => {
    const { grant } = mint();
    const decoded = Buffer.from(grant, "base64url").toString("utf8");
    expect(decoded).not.toContain(CARD);
    expect(decoded).not.toContain(PERSON.userId);
  });

  it("mints a DISTINCT identity per grant, so two sends never share a spend", () => {
    const a = mint();
    const b = mint({ messageId: "msg_2" });
    expect(a.claims.jti).not.toBe(b.claims.jti);
  });

  it("refuses to mint for a control no card lends", () => {
    expect(
      mintLentActionGrant({
        ...PERSON,
        messageId: MESSAGE,
        cardRef: CARD,
        // `fill` is cinatra#2934's road and is deliberately not in the vocabulary.
        control: "fill" as never,
      }),
    ).toBeNull();
  });

  it("the control vocabulary is exactly the buttons a card draws", () => {
    // cinatra#3080 — the review floor is Comment · Regenerate · Continue, so a
    // grant can name those and the screen's Submit, and nothing else. The
    // retired words buy nothing: a grant naming one cannot be minted at all.
    expect([...LENT_ACTION_CONTROLS]).toEqual(["comment", "regenerate", "continue", "submit"]);
    expect(isLentActionControl("fill")).toBe(false);
    expect(isLentActionControl("continue")).toBe(true);
    expect(isLentActionControl("approve")).toBe(false);
    expect(isLentActionControl("reject")).toBe(false);
  });
});

describe("a grant authorizes ONE call and refuses every other", () => {
  it("authorizes the call it was minted for", () => {
    const { claims } = mint();
    expect(
      matchLentActionGrant(claims, { ...PERSON, cardRef: CARD, control: "comment" }),
    ).toBe(true);
  });

  it("refuses ANOTHER CARD — item 3, the foreign card", () => {
    const { claims } = mint();
    expect(
      matchLentActionGrant(claims, { ...PERSON, cardRef: "ref-beta", control: "comment" }),
    ).toBe(false);
  });

  it("refuses ANOTHER CONTROL — item 3, the substituted button", () => {
    const { claims } = mint();
    expect(
      matchLentActionGrant(claims, { ...PERSON, cardRef: CARD, control: "approve" }),
    ).toBe(false);
  });

  it("refuses ANOTHER PERSON — item 3, the foreign grant", () => {
    const { claims } = mint();
    expect(
      matchLentActionGrant(claims, {
        userId: "usr_2",
        orgId: PERSON.orgId,
        cardRef: CARD,
        control: "comment",
      }),
    ).toBe(false);
  });

  it("refuses ANOTHER ORGANIZATION", () => {
    const { claims } = mint();
    expect(
      matchLentActionGrant(claims, {
        userId: PERSON.userId,
        orgId: "org_2",
        cardRef: CARD,
        control: "comment",
      }),
    ).toBe(false);
  });
});

describe("a grant that is not ours, or not any more, verifies to nothing", () => {
  it("refuses a forged string", () => {
    expect(verifyLentActionGrant("not-a-grant")).toBeNull();
  });

  it("refuses a tampered grant (the tag catches the flipped byte)", () => {
    const { grant } = mint();
    const raw = Buffer.from(grant, "base64url");
    raw[raw.length - 20] ^= 0xff;
    expect(verifyLentActionGrant(raw.toString("base64url"))).toBeNull();
  });

  it("refuses a grant minted under another secret", () => {
    const { grant } = mint();
    const before = process.env.BETTER_AUTH_SECRET;
    process.env.BETTER_AUTH_SECRET = "a-rotated-secret";
    try {
      expect(verifyLentActionGrant(grant)).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = before;
    }
  });

  it("lives for the TURN'S OWN window — two minutes, not ten", () => {
    // convergence round 1, finding 3: the grant is a bearer authority for its life, so
    // the life is the containment. Pinned here so a widening is a decision.
    expect(LENT_ACTION_GRANT_TTL_SECONDS).toBe(120);
  });

  it("refuses a grant whose life has run out", () => {
    const t0 = new Date("2026-08-25T10:00:00Z");
    const { grant } = mint({ now: () => t0 });
    const justInside = new Date(t0.getTime() + (LENT_ACTION_GRANT_TTL_SECONDS - 1) * 1000);
    const justOutside = new Date(t0.getTime() + LENT_ACTION_GRANT_TTL_SECONDS * 1000);
    expect(verifyLentActionGrant(grant, { now: () => justInside })).not.toBeNull();
    expect(verifyLentActionGrant(grant, { now: () => justOutside })).toBeNull();
  });

  it("mints nothing at all without an app secret — fail-closed, never a weak grant", () => {
    const before = process.env.BETTER_AUTH_SECRET;
    delete process.env.BETTER_AUTH_SECRET;
    try {
      expect(
        mintLentActionGrant({
          ...PERSON,
          messageId: MESSAGE,
          cardRef: CARD,
          control: "comment",
        }),
      ).toBeNull();
    } finally {
      process.env.BETTER_AUTH_SECRET = before;
    }
  });
});

describe("the audit handle is a digest, never the authority", () => {
  it("digests stably and does not contain the grant", () => {
    const { grant } = mint();
    const digest = lentActionGrantDigest(grant);
    expect(digest).toBe(lentActionGrantDigest(grant));
    expect(grant).not.toContain(digest);
  });
});

beforeEach(() => {
  process.env.BETTER_AUTH_SECRET = "test-secret-for-lent-action-grant";
});
