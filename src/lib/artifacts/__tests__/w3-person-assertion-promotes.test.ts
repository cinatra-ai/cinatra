/**
 * THE PERSON'S OWN ASSERTION PROMOTES — fix leg 2 of wave 3 of
 * `PLAN: Agents Lifecycle (D) — Review` (cinatra#3091).
 *
 * THE SENTENCE THIS FILE IS BUILT TO (the ratified drawing, artifact-review
 * §XI.10):
 *
 *   "Promotion happens only on the matcher's assertion at its threshold and
 *    with the person's confirmation, OR ON THE PERSON'S OWN ASSERTION, WHICH
 *    OUTRANKS THE MATCHER."
 *
 * and what promotion is for:
 *
 *   "the row gains a revision of the claiming extension's own type over the
 *    same content, and from that moment the extension's own display draws it"
 *   "After promotion the row reads as the claiming extension's row — its type
 *    on the mono line".
 *
 * WHAT THE FOURTH PROOF ROUND MEASURED. A person asserted the screenshot type
 * through the product's own picker. The kind label moved; the row's type did
 * not, so the mono line still named the base type and the plain image display
 * still drew the picture. The road refused with `no-matcher-assertion`, because
 * this planner required BOTH authorities and the drawing gives two roads, not
 * one: the person's own assertion is an authority all by itself.
 */
import { describe, expect, it } from "vitest";

import { isPersonsOwnAssertion } from "@/lib/artifacts/typed-promotion-store";

import { planTypedPromotion, type PromotableRow } from "../typed-promotion";

const OWN_TYPE = {
  typeId: "@cinatra-ai/screenshot-artifact:screenshot",
  acceptsMimes: ["image/png", "image/jpeg", "image/webp"],
};

function row(over: Partial<PromotableRow> = {}): PromotableRow {
  return {
    objectType: "@cinatra-ai/image-artifact:image",
    data: { title: "library-screenshot.png" },
    version: 3,
    latestRevision: {
      representationRevisionId: "rep_16423af4",
      resourceId: "res_9f10",
      form: "file",
      mime: "image/png",
    },
    ...over,
  };
}

describe("the person's own assertion is an authority of its own", () => {
  it("promotes on the person's own assertion with no matcher association at all", () => {
    const plan = planTypedPromotion({
      row: row(),
      ownType: OWN_TYPE,
      matcher: null,
      confirmed: true,
      personAsserted: true,
    });
    expect(plan).toMatchObject({
      ok: true,
      fromType: "@cinatra-ai/image-artifact:image",
      toType: "@cinatra-ai/screenshot-artifact:screenshot",
      sharedResourceId: "res_9f10",
      expectedVersion: 3,
    });
  });

  it("outranks the matcher — a sub-threshold match does not hold the person back", () => {
    const plan = planTypedPromotion({
      row: row(),
      ownType: OWN_TYPE,
      matcher: { confidence: 0.1, threshold: 0.7 },
      confirmed: true,
      personAsserted: true,
    });
    expect(plan.ok).toBe(true);
  });

  it("still re-validates the shared content against the type it lands under", () => {
    const plan = planTypedPromotion({
      row: row({
        latestRevision: {
          representationRevisionId: "rep_1",
          resourceId: "res_1",
          form: "file",
          mime: "application/pdf",
        },
      }),
      ownType: OWN_TYPE,
      matcher: null,
      confirmed: true,
      personAsserted: true,
    });
    expect(plan).toEqual({ ok: false, reason: "form-not-accepted" });
  });
});

describe("the matcher road is unchanged where the person asserted nothing", () => {
  it("still refuses a confirmation on a row nothing associated", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: OWN_TYPE,
        matcher: null,
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "no-matcher-assertion" });
  });

  it("still refuses a match below the extension's own threshold", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: OWN_TYPE,
        matcher: { confidence: 0.4, threshold: 0.7 },
        confirmed: true,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "below-threshold" });
  });

  it("still refuses a match at threshold nobody confirmed", () => {
    expect(
      planTypedPromotion({
        row: row(),
        ownType: OWN_TYPE,
        matcher: { confidence: 0.9, threshold: 0.7 },
        confirmed: false,
        personAsserted: false,
      }),
    ).toEqual({ ok: false, reason: "not-confirmed" });
  });

  it("names the row before it names an authority — order is load-bearing", () => {
    expect(
      planTypedPromotion({
        row: null,
        ownType: OWN_TYPE,
        matcher: null,
        confirmed: true,
        personAsserted: true,
      }),
    ).toEqual({ ok: false, reason: "row-not-found" });
    expect(
      planTypedPromotion({
        row: row({ objectType: OWN_TYPE.typeId }),
        ownType: OWN_TYPE,
        matcher: null,
        confirmed: true,
        personAsserted: true,
      }),
    ).toEqual({ ok: false, reason: "already-promoted" });
  });
});

// WHOSE ASSERTION IT IS (fix leg 2, convergence round). The road onto the
// promotion runs BESIDE the per-actor extension-access gate — the converging
// branch reaches it with an extension the gate dropped — so "the person's own
// assertion" has to mean the ACTING person's. Reading any person's assertion
// would let a second person, who cannot address that extension at all, spend
// somebody else's assertion as their authority and append the revision.
describe("the person's own assertion is the ACTING person's (#3091 fix leg 2)", () => {
  const alice = {
    extension: "@cinatra-ai/screenshot-artifact",
    assertedBy: "user" as const,
    assertionBasis: "classic" as const,
    assertedByPrincipal: "principal_alice",
  };

  it("counts the acting person's own classic assertion", () => {
    expect(
      isPersonsOwnAssertion(alice, {
        extension: "@cinatra-ai/screenshot-artifact",
        principal: "principal_alice",
      }),
    ).toBe(true);
  });

  it("does not let a second person spend the first person's assertion", () => {
    expect(
      isPersonsOwnAssertion(alice, {
        extension: "@cinatra-ai/screenshot-artifact",
        principal: "principal_bob",
      }),
    ).toBe(false);
  });

  it("is not satisfied by an assertion on another extension", () => {
    expect(
      isPersonsOwnAssertion(alice, {
        extension: "@cinatra-ai/pdf-artifact",
        principal: "principal_alice",
      }),
    ).toBe(false);
  });

  it("counts neither an agent's, an authoring skill's, nor a binding row", () => {
    expect(
      isPersonsOwnAssertion(
        { ...alice, assertedBy: "agent" },
        { extension: alice.extension, principal: "principal_alice" },
      ),
    ).toBe(false);
    expect(
      isPersonsOwnAssertion(
        { ...alice, assertedBy: "authoring_skill" },
        { extension: alice.extension, principal: "principal_alice" },
      ),
    ).toBe(false);
    expect(
      isPersonsOwnAssertion(
        { ...alice, assertionBasis: "binding" },
        { extension: alice.extension, principal: "principal_alice" },
      ),
    ).toBe(false);
  });
});
