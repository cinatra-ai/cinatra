/**
 * NO SERVICE-AUTHORED ADVISORY ROW ABOVE THE GATE (cinatra#3080, fix leg 8).
 *
 * WHAT THE NINTH ROUND PHOTOGRAPHED. On the run page, above the review gate —
 * on the parked reading and again on the settled one — the audit lane's own
 * body, drawn verbatim:
 *
 *   Audit of 3 disclosed field(s).
 *   • 3 disclosed field(s) carry content.
 *   [provenance] lane=core-analysis-lane target=… projection=… authz=allowed …
 *
 * The graded record filed it as one of the three drawn misses that "land on the
 * issue's own subject": "a raw provenance line renders above the gate against
 * the 'no provenance line' rule."
 *
 * THE RULE, IN THE DRAWING'S OWN WORDS. A display "shows the work and NOTHING
 * ABOUT ITSELF — no renderer name, no package identity, NO PROVENANCE LINE —
 * because the reader is deciding on the work, not on what drew it" (Agent run &
 * review §V). And §XIII.1 draws the in-run gate as its header strip, its display
 * and its floor, with nothing stacked above it: "the frame changes and nothing
 * else does."
 *
 * WHAT IS NOT TOUCHED. The verification card itself is untouched — Lifecycle
 * cards §VII gives it the turn after a repair, and the rail beside this column
 * keeps its own Audit entry (the ninth round measured four rail rows: step,
 * superseded review, continued review, audit). Nothing is filtered by author
 * kind and no comment body is rewritten. The row is simply not drawn in the
 * gate's own thread. Fix leg 5 already stopped the review CARD from projecting
 * notes at all (`src/lib/lifecycle/__tests__/review-card-no-provenance-line.ts`);
 * this is the other seam — the column the card is drawn in.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { describe, expect, it } from "vitest";

import { runDetailDrawsReview } from "../instance-screens";

const SRC = fs.readFileSync(
  path.join(__dirname, "..", "instance-screens.tsx"),
  "utf-8",
);

describe("the reading that decides it", () => {
  it("says YES for a gate this run already has", () => {
    expect(runDetailDrawsReview({ ref: "gate-ref", awaiting: false })).toBe(true);
  });

  it("says YES while a review is still expected to open", () => {
    // The panel draws its placeholder in the same slot the gate lands in, so a
    // card stacked above it now is stacked above the gate a moment later.
    expect(runDetailDrawsReview({ ref: null, awaiting: true })).toBe(true);
  });

  it("says NO for a run with no review at all", () => {
    expect(runDetailDrawsReview({ ref: null, awaiting: false })).toBe(false);
    expect(runDetailDrawsReview(null)).toBe(false);
  });
});

describe("the run detail column applies it to the audit card's mount", () => {
  it("guards the mount on the reading rather than drawing it unconditionally", () => {
    const at = SRC.indexOf("<VerificationSummaryCard");
    expect(at, "the run page mounts the audit card").toBeGreaterThan(0);
    // The guard is the condition the mount hangs off — the nearest one above it.
    const guardAt = SRC.lastIndexOf("verificationCardRefs.length > 0", at);
    expect(guardAt).toBeGreaterThan(0);
    const guard = SRC.slice(guardAt, at);
    expect(guard).toContain("!runDetailDrawsAReview");
  });

  it("keeps the card's other hosts — it is routed, not deleted", () => {
    expect(SRC).toContain("VerificationSummaryCard");
    expect(SRC).toContain("verificationCardRefs");
  });
});
