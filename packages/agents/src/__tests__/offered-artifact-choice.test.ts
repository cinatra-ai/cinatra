/**
 * THE GENERIC OFFERED-CHOICE ROAD (cinatra#3035, epic #3023 W11).
 *
 * The shape a "pick one of these artifacts" gate offers is the host's and knows
 * no pack: a reference pair per entry, a title that is the first line of the
 * entry's text, the words below it, and the run-ending sentence an empty offer
 * carries instead of entries. The idea-selection renderer reads its offer
 * through this road, so the host copy of a pack's screen holds no shape of its
 * own.
 *
 *   pnpm exec vitest run src/__tests__/offered-artifact-choice.test.ts
 */
import { describe, expect, it } from "vitest";

import {
  choiceBody,
  choiceReference,
  choiceTitle,
  offerableChoices,
  statedReason,
} from "../field-renderer-registry";

describe("the offered-choice road", () => {
  it("names a pick by the reference the offer carried", () => {
    expect(choiceReference({ artifactId: "a-1", representationRevisionId: "r-1" })).toEqual({
      artifactId: "a-1",
      representationRevisionId: "r-1",
    });
  });

  it("refuses an entry that names no revision, and never offers it", () => {
    expect(choiceReference({ artifactId: "a-1" })).toBeNull();
    expect(choiceReference({ artifactId: "a-1", representationRevisionId: "" })).toBeNull();
    expect(
      offerableChoices([
        { artifactId: "a-1", representationRevisionId: "r-1" },
        { artifactId: "a-2" },
        { title: "no reference at all" },
      ]),
    ).toEqual([{ artifactId: "a-1", representationRevisionId: "r-1" }]);
  });

  it("offers nothing at all when the value is not a list", () => {
    expect(offerableChoices(undefined)).toEqual([]);
    expect(offerableChoices("[]")).toEqual([]);
  });

  it("falls back to a positional title so no row is nameless", () => {
    expect(choiceTitle({ title: "Shipping on Fridays" }, 0, "Idea")).toBe("Shipping on Fridays");
    expect(choiceTitle({ title: "   " }, 2, "Idea")).toBe("Idea 3");
    expect(choiceTitle({}, 0)).toBe("Item 1");
  });

  it("shows the entry's own words BELOW its title, and nothing when it has none", () => {
    expect(choiceBody({ text: "Title: One\n\nWhy a Friday deploy is a habit." })).toBe(
      "Why a Friday deploy is a habit.",
    );
    expect(choiceBody({ text: "A title on its own" })).toBe("");
    expect(choiceBody({})).toBe("");
  });

  it("reads the run-ending sentence only when there is one", () => {
    expect(statedReason("There is no blog idea left to draft.")).toBe(
      "There is no blog idea left to draft.",
    );
    expect(statedReason("   ")).toBeNull();
    expect(statedReason(undefined)).toBeNull();
  });
});
