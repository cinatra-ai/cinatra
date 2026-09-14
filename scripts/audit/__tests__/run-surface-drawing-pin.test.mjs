/**
 * THE PULL REQUEST RECORDS THE DRAWING IT WAS BUILT FROM (cinatra#3068).
 *
 * The run surface's drawing publishes no generated conformance manifest, so it
 * is not one of the `design-pin-drift` ids and there is no manifest hash for it
 * to be pinned by. A change to that surface can therefore be made — and was —
 * without any record of WHICH drawing it conforms to, which is the one thing a
 * later reader cannot reconstruct.
 *
 * So the pin is a recorded one, in this repository's own pin file for this card
 * family, and the module the drawing governs carries the same commit in its
 * header. This suite is what keeps the two from drifting into two answers.
 *
 * Run:
 *   npx vitest run scripts/audit/__tests__/run-surface-drawing-pin.test.mjs
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
);

const CONTRACT = JSON.parse(
  readFileSync(
    path.join(REPO_ROOT, "scripts/audit/chat-hitl-anchor-contract.json"),
    "utf8",
  ),
);
const RAIL_MODULE = readFileSync(
  path.join(REPO_ROOT, "packages/agents/src/run-input-rail-steps.tsx"),
  "utf8",
);

/**
 * THE RATIFIED COMMIT ITSELF (convergence, fix leg 2). Shape and cross-file
 * agreement are not a pin: changing both files to the same OTHER commit would
 * satisfy them, and the record would then name a drawing this change was never
 * read against. The commit is therefore stated here as a literal, so moving the
 * pin is a deliberate edit to the suite that asserts it and never a side effect
 * of editing the record it pins.
 */
const RATIFIED_DRAWING_PIN = "c73c68f5e39ed5b8da06b4dfd575ccf3692974c8";

describe("the run surface's drawing pin is recorded", () => {
  it("records a whole commit, not a short one and not a range", () => {
    expect(CONTRACT.runSurfaceDrawingPin).toBeTruthy();
    expect(CONTRACT.runSurfaceDrawingPin.pin).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records the RATIFIED commit, not merely some commit both files agree on", () => {
    expect(CONTRACT.runSurfaceDrawingPin.pin).toBe(RATIFIED_DRAWING_PIN);
    expect(RAIL_MODULE).toContain(`ratified drawing pin: ${RATIFIED_DRAWING_PIN}`);
  });

  it("names both drawings the surface is read from", () => {
    expect(CONTRACT.runSurfaceDrawingPin.specs).toEqual([
      "specs/app-artifact-review.html",
      "specs/app-lifecycle-cards.html",
    ]);
  });

  it("carries the same commit in the module the drawing governs", () => {
    expect(RAIL_MODULE).toContain(
      `ratified drawing pin: ${CONTRACT.runSurfaceDrawingPin.pin}`,
    );
  });

  it("says why this change moves no pin of its own", () => {
    // A pin that moves silently is a claim nobody made. This one is deliberate
    // and the reason is on file, so a reader is never left to infer it from the
    // fact that two pins in one file disagree.
    expect(
      typeof CONTRACT.runSurfaceDrawingPin.specCommitDeliberatelyNotMoved,
    ).toBe("string");
    expect(
      CONTRACT.runSurfaceDrawingPin.specCommitDeliberatelyNotMoved,
    ).toMatch(/run-recommendation-chip-row/);
    expect(CONTRACT.specCommit).toMatch(/app-lifecycle-cards\.html$/);
  });
});

/**
 * THE FORWARD KEEPS BOTH RECORDS (the merge-forward with the main line's pin
 * adoption).
 *
 * `specCommit` and this record are two DIFFERENT pins in one file, and a
 * merge-forward is exactly where one of them quietly wins. The main line adopted
 * a newer `specCommit` and recorded the anchor set that resolves at it; this
 * branch recorded the run surface's own drawing pin. Both survive, and the note
 * beside the run-surface pin reads against the pin the file actually carries
 * rather than the one it carried before the forward.
 */
describe("the merge-forward keeps both of the file's pins", () => {
  it("carries the adopted anchor set the newer pin was recorded with", () => {
    expect(Array.isArray(CONTRACT.anchorsUnresolvedAtPin)).toBe(true);
    expect(CONTRACT.anchorsUnresolvedAtPin.length).toBeGreaterThan(0);
    // Sorted and unique, which is how the adoption writes it -- a hand-merged
    // union of two sides would not be either.
    expect(CONTRACT.anchorsUnresolvedAtPin).toEqual(
      [...new Set(CONTRACT.anchorsUnresolvedAtPin)].sort(),
    );
  });

  it("keeps the run surface's own pin beside it, untouched", () => {
    expect(CONTRACT.runSurfaceDrawingPin.pin).toBe(RATIFIED_DRAWING_PIN);
  });

  it("does not claim the anchor pin stands where it stood before the forward", () => {
    const why = CONTRACT.runSurfaceDrawingPin.specCommitDeliberatelyNotMoved;
    const recordedPin = CONTRACT.specCommit.match(/design@([0-9a-f]{40})/)[1];
    // The note must not name a commit other than the one the file carries: that
    // is the shape a forward that took the older pin's prose would leave.
    for (const named of why.match(/[0-9a-f]{40}/g) ?? []) {
      expect(named).toBe(recordedPin);
    }
  });
});

/**
 * THE FORWARD MUST NOT CARRY A READING THE BRANCH HAS ALREADY REDRAWN.
 *
 * The note beside the run surface's pin argued that re-ratifying the card's
 * contract belonged to "the change that redraws the card" -- and THIS branch is
 * that change: the Skills step now draws one pill per skill with a checkbox in
 * front of the name and the vendor, and ONE Continue beneath the list. The
 * per-skill Confirm / Adjust / Skip floor is gone, and this file's own anchors
 * no longer name a single `data-skill-action`. A merge-forward that takes the
 * base's prose verbatim leaves the note describing a card nobody ships, which
 * is a false record in the one file that exists to hold the true one. The note
 * must read against the anchors the file actually carries.
 */
describe("the pin note reads against the card the branch ships", () => {
  const anchorText = JSON.stringify(CONTRACT.domExpectations);
  const why = CONTRACT.runSurfaceDrawingPin.specCommitDeliberatelyNotMoved;

  it("no longer anchors the retired per-skill decision controls", () => {
    expect(anchorText).not.toMatch(/data-skill-action/);
  });

  it("does not describe the shipped card as drawing the retired floor", () => {
    expect(why).not.toMatch(/shipped card draws the retired/i);
    expect(why).not.toMatch(/data-skill-action/);
  });

  it("names the reading the Skills step actually draws", () => {
    // Not merely the WORDS: the note has to carry the cardinality and the
    // by-clause the card is graded on, or it can drift back to a half-truth
    // while still mentioning a checkbox.
    expect(why).toMatch(/one pill per skill/i);
    expect(why).toMatch(/checkbox in front of the name/i);
    expect(why).toMatch(/vendor/i);
    expect(why).toMatch(/one Continue beneath the list/i);
  });

  it("does not claim the retired floor is still anchored", () => {
    expect(why).toMatch(/retired/i);
    expect(JSON.stringify(CONTRACT.domExpectations.carriage.recommendation_hold)).not.toMatch(
      /data-skill-action/,
    );
  });
});
