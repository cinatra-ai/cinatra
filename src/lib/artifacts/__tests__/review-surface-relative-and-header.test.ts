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

import {
  relativeInstant,
  reviewGateHeaderTitle,
  reviewSettledCopy,
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

describe("reviewGateHeaderTitle — the resolved reading records how it was settled", () => {
  it.each([
    ["approved", "Review approved"],
    ["rejected", "Review rejected"],
    ["changes_requested", "Changes requested"],
  ] as const)("a %s gate reads %s", (outcome, title) => {
    expect(reviewGateHeaderTitle(outcome)).toBe(title);
    expect(reviewGateHeaderTitle(outcome)).not.toBe("Review requested");
  });

  it("a gate with no outcome to name keeps the request wording", () => {
    // Pending, restricted, loading, and a settled gate whose disposition this
    // build cannot read: that card really does still say "Review requested".
    expect(reviewGateHeaderTitle(null)).toBe("Review requested");
    expect(reviewGateHeaderTitle(undefined)).toBe("Review requested");
  });

  it("the header and the settled line are one reading of one outcome", () => {
    // Not the same words — a heading has no decider and no sentence — but the
    // same closed set, so the two cannot disagree about which gate this is.
    for (const outcome of ["approved", "rejected", "changes_requested"] as const) {
      const line = reviewSettledCopy(outcome).title.toLowerCase();
      const header = reviewGateHeaderTitle(outcome).toLowerCase();
      const word = outcome === "changes_requested" ? "changes" : outcome.slice(0, 6);
      expect(line).toContain(word);
      expect(header).toContain(word);
    }
  });
});
