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

  it("says why the anchor contract's own pin did not move with it", () => {
    // A pin that moves silently is a claim nobody made. This one is deliberate
    // and the reason is on file, so a reader is never left to infer it from the
    // fact that two pins in one file disagree.
    expect(
      typeof CONTRACT.runSurfaceDrawingPin.specCommitDeliberatelyNotMoved,
    ).toBe("string");
    expect(
      CONTRACT.runSurfaceDrawingPin.specCommitDeliberatelyNotMoved,
    ).toMatch(/run-recommendation-chip-row/);
    // And it did not move: the digest below is still computed over it.
    expect(CONTRACT.specCommit).toMatch(/app-lifecycle-cards\.html$/);
  });
});
