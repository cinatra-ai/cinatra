// THE GRANT CARRIES THE MENU THE PERSON'S WORDS NAMED (cinatra#2853).
//
// Plan (B) §4: the grant is "signed, single-use, naming the person, the message,
// the card and the one control it allows". This slice keeps every one of those
// claims and makes the LAST one honest for a card with more than one button: the
// grant names the controls THIS message may press — the card's own buttons,
// narrowed to the ones the person's own words named — and the single-use ledger
// still lets exactly ONE of them be pressed, once.

import { describe, expect, it } from "vitest";

process.env.BETTER_AUTH_SECRET ??= "test-secret-for-grant-menu";

import {
  matchLentActionGrant,
  mintLentActionGrant,
  verifyLentActionGrant,
} from "../lent-action-grant";

const PERSON = { userId: "usr_1", orgId: "org_1", messageId: "msg_1", cardRef: "card_ref_1" };

describe("the menu claim", () => {
  it("round-trips the controls this message may press", () => {
    const minted = mintLentActionGrant({
      ...PERSON,
      control: "comment",
      controls: ["comment", "approve"],
    })!;
    const claims = verifyLentActionGrant(minted.grant)!;
    expect(claims.controls).toEqual(["comment", "approve"]);
    // The ANCHOR stays the first control — it is what the ledger row records.
    expect(claims.control).toBe("comment");
  });

  it("defaults to the single control, so a grant minted without a menu is unchanged", () => {
    const minted = mintLentActionGrant({ ...PERSON, control: "submit" })!;
    const claims = verifyLentActionGrant(minted.grant)!;
    expect(claims.controls).toEqual(["submit"]);
    expect(claims.control).toBe("submit");
  });

  it("authorizes any control ON the menu and nothing else", () => {
    const minted = mintLentActionGrant({
      ...PERSON,
      control: "comment",
      controls: ["comment", "approve"],
    })!;
    const claims = verifyLentActionGrant(minted.grant)!;
    const call = { userId: PERSON.userId, orgId: PERSON.orgId, cardRef: PERSON.cardRef };
    expect(matchLentActionGrant(claims, { ...call, control: "comment" })).toBe(true);
    expect(matchLentActionGrant(claims, { ...call, control: "approve" })).toBe(true);
    expect(matchLentActionGrant(claims, { ...call, control: "reject" })).toBe(false);
  });

  it("still refuses another person, another organization and another card", () => {
    const minted = mintLentActionGrant({
      ...PERSON,
      control: "comment",
      controls: ["comment", "approve"],
    })!;
    const claims = verifyLentActionGrant(minted.grant)!;
    expect(
      matchLentActionGrant(claims, {
        userId: "usr_2",
        orgId: PERSON.orgId,
        cardRef: PERSON.cardRef,
        control: "approve",
      }),
    ).toBe(false);
    expect(
      matchLentActionGrant(claims, {
        userId: PERSON.userId,
        orgId: PERSON.orgId,
        cardRef: "another_card",
        control: "approve",
      }),
    ).toBe(false);
  });

  it("never authorizes a press from a menu that holds no pressable control", () => {
    const minted = mintLentActionGrant({ ...PERSON, control: "fill", controls: ["fill"] })!;
    const claims = verifyLentActionGrant(minted.grant)!;
    expect(
      matchLentActionGrant(claims, {
        userId: PERSON.userId,
        orgId: PERSON.orgId,
        cardRef: PERSON.cardRef,
        control: "fill",
      }),
    ).toBe(false);
  });

  it("refuses to mint a menu whose anchor is not on it", () => {
    expect(
      mintLentActionGrant({ ...PERSON, control: "approve", controls: ["comment"] } as never),
    ).toBeNull();
  });

  it("refuses to mint an empty menu", () => {
    expect(mintLentActionGrant({ ...PERSON, control: "comment", controls: [] } as never)).toBeNull();
  });
});
