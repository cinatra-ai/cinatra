/**
 * THE TARGET'S TIME IS A READING, AND THE HEADER RECORDS HOW IT WAS SETTLED
 * (cinatra#3046).
 *
 * Two findings from the criterion-5 reshoot, both in this module's copy:
 *
 *   · the light decided target printed the stored instant straight through —
 *     an ISO timestamp with milliseconds — where the drawing writes a relative
 *     reading ("updated 8 min ago"). The app had no shared formatter for one at
 *     all: four private copies in four unrelated packages, and none for the
 *     review surface. The sibling leg (pull request 3058) records the SAME
 *     finding for the header row facts it draws from the same projection, so
 *     there is one formatter here rather than two that can drift;
 *   · the card header said "Review requested" on every settled reading, while
 *     the outcome was written further down the card in a second voice. §I asks a
 *     resolved gate to stay as read-only history that records HOW it was settled.
 *
 *   pnpm exec vitest run src/lib/artifacts/__tests__/review-surface-relative-and-header.test.ts
 */
import { describe, expect, it } from "vitest";

import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
  relativeInstant,
  reviewGateHeaderTitle,
  reviewGateRailSettlement,
  reviewSettledCopy,
  reviewSettledOutcomeFromDisposition,
  reviewTargetRowFacts,
} from "../review-surface-model";

const NOW = new Date("2026-08-29T06:26:52.662Z");
const at = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

describe("relativeInstant — one relative reading of one instant", () => {
  it("reads minutes the way the drawing writes them", () => {
    expect(relativeInstant(at(8 * 60_000), NOW)).toBe("8 min ago");
  });

  it("steps up to hours and days rather than counting minutes for ever", () => {
    expect(relativeInstant(at(3 * 3_600_000), NOW)).toBe("3 h ago");
    expect(relativeInstant(at(2 * 86_400_000), NOW)).toBe("2 d ago");
  });

  it("reads the last minute as just now", () => {
    expect(relativeInstant(at(20_000), NOW)).toBe("just now");
  });

  it("a future instant is just now, never a negative age", () => {
    // Clocks disagree by seconds across a store and a browser; "updated in
    // -3 min" is a bug report, not a reading.
    expect(relativeInstant(at(-90_000), NOW)).toBe("just now");
  });

  it("a value that is not an instant is returned untouched", () => {
    expect(relativeInstant("now", NOW)).toBe("now");
    expect(relativeInstant("8 min ago", NOW)).toBe("8 min ago");
  });

  it("never prints an ISO instant", () => {
    const printed = relativeInstant("2026-08-29T06:18:07.421Z", NOW);
    expect(printed).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
    expect(printed).not.toContain(".421");
  });
});

describe("reviewTargetRowFacts — the meta line's updated time", () => {
  const artifact = {
    ownerLevel: "organization",
    visibility: "organization",
    mime: "text/markdown",
    updatedAt: "2026-08-29T06:18:07.421Z",
  };

  it("draws the relative reading, not the stored instant", () => {
    const line = reviewTargetRowFacts(artifact, NOW).join(" · ");
    expect(line).toBe(
      // THE ROW FACTS CARRY NO LABEL (the ratified drawing, §IV): the drawn
      // line reads "… · Team · Private · text/html · updated 8 min ago". An
      // earlier reading prefixed each fact with "Ownership:" / "Visibility:";
      // the drawing puts neither there, so the pin is re-taken on the drawn line.
      "organization · organization · text/markdown · updated 8 min ago",
    );
    expect(line).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves an already-humanized value exactly as the caller wrote it", () => {
    expect(
      reviewTargetRowFacts({ ...artifact, updatedAt: "8 min ago" }, NOW).at(-1),
    ).toBe("updated 8 min ago");
  });
});

describe("reviewGateHeaderTitle \u2014 the settled reading, in the drawing's own words", () => {
  // THE DRAWING CARRIES THREE READINGS AND NO MORE: "Review requested",
  // "Continued" and "Changes requested". Continued is the ONLY settled reading a
  // display has \u2014 the ratified floor's terminal press is Continue, and there is
  // no second status after it. "Review approved" / "Review rejected" were words
  // this change invented for a heading the drawing had already written, so the
  // header now says only what the drawing says.
  it.each([
    // The gate released the run: the drawing's terminal reading.
    ["approved", "Continued"],
    // The reviewed work was turned back. The drawing draws that road as
    // Regenerate -> a successor gate and words it "Changes requested"; it has no
    // separate word for a rejection, and a heading may not invent one. The
    // three-way outcome axis is untouched \u2014 it stays on the wire and on the
    // settled panel's own `data-review-outcome`, which is what routing reads.
    ["rejected", "Changes requested"],
    ["changes_requested", "Changes requested"],
  ] as const)("a %s gate reads %s", (outcome, title) => {
    expect(reviewGateHeaderTitle(outcome)).toBe(title);
  });

  it("never puts a word on screen that the drawing does not carry", () => {
    const drawn = new Set(["Review requested", "Continued", "Changes requested"]);
    for (const outcome of [
      "approved",
      "rejected",
      "changes_requested",
      null,
      undefined,
    ] as const) {
      expect(drawn.has(reviewGateHeaderTitle(outcome))).toBe(true);
    }
    // Named explicitly, because these two strings are the departure this leg
    // removes: a re-introduction must fail here rather than on a reshoot.
    for (const outcome of ["approved", "rejected", "changes_requested"] as const) {
      expect(reviewGateHeaderTitle(outcome)).not.toBe("Review approved");
      expect(reviewGateHeaderTitle(outcome)).not.toBe("Review rejected");
    }
  });

  it("a gate with no outcome to name keeps the request wording", () => {
    // Pending, restricted, loading, and a settled gate whose disposition this
    // build cannot read: that card really does still say "Review requested".
    expect(reviewGateHeaderTitle(null)).toBe("Review requested");
    expect(reviewGateHeaderTitle(undefined)).toBe("Review requested");
  });

  it("the header and the settled line are one reading of one outcome", () => {
    // Same vocabulary, one register apart: the line may name the decider, the
    // heading never does. So the heading IS the line with the decider taken off,
    // and the two can no longer disagree about which gate this is.
    for (const outcome of ["approved", "rejected", "changes_requested"] as const) {
      expect(reviewSettledCopy(outcome).title).toBe(reviewGateHeaderTitle(outcome));
      expect(reviewSettledCopy(outcome, "Dana Okonkwo").title).toBe(
        `${reviewGateHeaderTitle(outcome)} by Dana Okonkwo`,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The RUN PAGE RAIL's settled word (cinatra#3046, fix leg 16) — the twelfth
// proof round photographed "APPROVE" beside a resolved Review step while the
// card on the same screen read "Continued".
// ---------------------------------------------------------------------------

describe("reviewSettledOutcomeFromDisposition — the stored verb is not a reading", () => {
  it.each([
    ["approve", "approved"],
    ["reject", "rejected"],
    ["changes_requested", "changes_requested"],
  ] as const)("a gate resolved with %s carries the %s outcome", (disposition, outcome) => {
    expect(reviewSettledOutcomeFromDisposition(disposition)).toBe(outcome);
  });

  it("maps nothing it does not know, rather than guessing", () => {
    // `comment` never resolves a gate; the rest are a future build's value, a
    // corrupted column, and no value at all.
    for (const unknown of ["comment", "approved", "APPROVE", "", null, undefined]) {
      expect(reviewSettledOutcomeFromDisposition(unknown)).toBeNull();
    }
  });

  it("is the SAME three pairs the store maps on its own side of the seam", () => {
    // The store's copy (`OUTCOME_BY_DISPOSITION`) is the one the wire outcome is
    // written from; this pure copy exists only so a client rail can read it
    // without pulling the database in behind it. A pair added on one side and
    // not the other fails HERE, not on a screen.
    const storeSource = readFileSync(
      join(process.cwd(), "src/lib/lifecycle/lifecycle-settled-outcome.ts"),
      "utf8",
    );
    const literal = storeSource.match(
      /OUTCOME_BY_DISPOSITION[^=]*=\s*\{([\s\S]*?)\}/,
    );
    expect(literal).not.toBeNull();
    const pairs = [...literal![1].matchAll(/^\s*([A-Za-z_]+)\s*:\s*"([a-z_]+)"/gm)].map(
      ([, disposition, outcome]) => [disposition, outcome] as const,
    );
    expect(pairs).toHaveLength(3);
    for (const [disposition, outcome] of pairs) {
      expect(reviewSettledOutcomeFromDisposition(disposition)).toBe(outcome);
    }
  });
});

describe("reviewGateRailSettlement — the rail entry says the drawing's word", () => {
  it.each([
    ["approve", "Continued"],
    ["reject", "Changes requested"],
    ["changes_requested", "Changes requested"],
  ] as const)("a gate resolved with %s reads %s on the rail", (disposition, word) => {
    expect(reviewGateRailSettlement(disposition)).toBe(word);
  });

  it("never puts the decider's raw verb on the rail", () => {
    for (const disposition of ["approve", "reject", "changes_requested"] as const) {
      const word = reviewGateRailSettlement(disposition);
      expect(word).not.toBe(disposition);
      expect(word.toLowerCase()).not.toBe(disposition);
    }
  });

  it("says the same word as the header for the same gate", () => {
    // One settlement, one vocabulary: the rail entry and the card header are two
    // renderings of one closed set, and they may not drift apart again.
    for (const disposition of ["approve", "reject", "changes_requested"] as const) {
      const outcome = reviewSettledOutcomeFromDisposition(disposition)!;
      expect(reviewGateRailSettlement(disposition)).toBe(reviewGateHeaderTitle(outcome));
    }
  });

  it("keeps the entry's old fallback for a settled gate it cannot read", () => {
    // The rail row is drawn because the gate IS resolved; the status is still a
    // fact when the outcome is not, and the header's "Review requested" would be
    // false on a row the reader has just watched settle.
    expect(reviewGateRailSettlement(null)).toBe("resolved");
    expect(reviewGateRailSettlement(undefined)).toBe("resolved");
    expect(reviewGateRailSettlement("comment")).toBe("resolved");
    expect(reviewGateRailSettlement(null)).not.toBe("Review requested");
  });
});
