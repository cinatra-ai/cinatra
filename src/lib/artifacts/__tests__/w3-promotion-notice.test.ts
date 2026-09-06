// THE REFUSAL REACHES THE PERSON (cinatra#3091, wave 3 of #3087 — the
// convergence round of the resolution fix leg).
//
// RED FIRST, AND MEASURED ON THE PREVIOUS HEAD: the road's named refusal
// travelled to the server action's result and stopped. The picker read `ok`
// and said "Meaning set." for every outcome, so the case the fix leg made
// nameable — a pack whose display can never be reached — was still silence at
// the surface. These cases pin the translation the picker now shows.
import { describe, expect, it } from "vitest";

import { promotionRefusalNotice } from "../promotion-notice";

describe("promotionRefusalNotice (#3091)", () => {
  it("says nothing extra when the promotion ran", () => {
    expect(promotionRefusalNotice({ promoted: true })).toBeNull();
  });

  it("says nothing extra when the road never applied to the row", () => {
    expect(promotionRefusalNotice(undefined)).toBeNull();
  });

  it("names the unreachable-display refusal the fix leg made reportable", () => {
    const notice = promotionRefusalNotice({
      promoted: false,
      reason: "extension-owns-no-type",
    });
    expect(notice).toContain("no type of its own");
    expect(notice).toContain("publisher");
  });

  it("stays quiet for a row that already carries the confirmed type", () => {
    expect(promotionRefusalNotice({ promoted: false, reason: "already-promoted" })).toBeNull();
  });

  it("answers every other refusal the road can name", () => {
    for (const reason of [
      "no-matcher-assertion",
      "below-threshold",
      "form-not-accepted",
      "no-content",
      "row-not-found",
      "not-confirmed",
    ]) {
      expect(promotionRefusalNotice({ promoted: false, reason })).toBeTruthy();
    }
  });

  it("answers a refusal name it has never seen rather than dropping it", () => {
    expect(promotionRefusalNotice({ promoted: false, reason: "a-name-added-later" })).toBe(
      "The file kind was not changed. The meaning you chose is set.",
    );
  });
});
