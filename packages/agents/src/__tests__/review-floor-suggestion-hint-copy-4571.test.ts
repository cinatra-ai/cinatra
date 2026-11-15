/**
 * THE SUGGESTION HINT NAMES THE FLOOR'S OWN CONTROLS (cinatra#3080 fold,
 * pre-review finding 7).
 *
 * A pending review with suggestions told the reader nothing is recorded until
 * they "approve or reject below", while the floor below draws Comment,
 * Regenerate and Continue. The words are the approved drawing's, verbatim:
 * the app lifecycle cards design spec, section VIII (revision 3beff055,
 * the binding the cinatra#3080 grade governs), the
 * `note-line` under the suggestion chips. The parity fixture pins the rendered
 * card, so it must carry the same words.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC = path.resolve(__dirname, "..");
const CARD = readFileSync(path.join(SRC, "review-gate-card.tsx"), "utf8");
const FIXTURE = readFileSync(
  path.join(SRC, "__tests__", "__fixtures__", "review-gate-card-render-parity.json"),
  "utf8",
);

const APPROVED_HINT =
  "Press a suggestion to dismiss it, press it again to accept it. Nothing is recorded until you press Continue or Regenerate below.";

describe("the suggestion hint on a pending review floor", () => {
  it("is the approved drawing's sentence, in the card", () => {
    expect(CARD).toContain(APPROVED_HINT);
  });

  it("never tells the reader to approve or reject", () => {
    expect(CARD).not.toMatch(/until you approve or reject/);
    expect(FIXTURE).not.toMatch(/approve or reject below/);
  });

  it("is what every host's pending-with-suggestions parity fixture renders", () => {
    const fixtures = JSON.parse(FIXTURE) as Record<string, string>;
    const keys = Object.keys(fixtures).filter((k) => k.endsWith("/pending-with-suggestions"));
    expect(keys.length).toBeGreaterThanOrEqual(4);
    for (const k of keys) expect(fixtures[k]).toContain(APPROVED_HINT);
  });
});
