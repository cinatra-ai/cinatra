/**
 * NO NESTED BODY CARD INSIDE THE TARGET PANEL (cinatra#3080, the fix leg after
 * the second proof round).
 *
 * `specs/app-artifact-review.html` §IV draws ONE panel per target: "Every target
 * opens with a header that names what is under review and fixes it in place ...
 * Beneath the header sits the representation slot", and the drawing's own markup
 * is one bordered container with the header and the representation inside it.
 *
 * WHAT THE SECOND ROUND SAW. A one-target gate drew THREE boxes: the card's own
 * header card, a gap, the card's island box — and, inside the island's document,
 * the target panel's own border again. The card now frames the pair itself
 * (pinned by `review-target-one-panel-3080` in packages/agents), so the panel
 * INSIDE the frame must not draw a second one.
 *
 * A LEGACY gate that still pins several targets is the one reading where the
 * island's document pairs each header with its own body — there the panel keeps
 * its frame, because nothing outside the frame can draw those pairs.
 *
 * Source-text assertions, the established pattern for this server-only route
 * (see `review-surface-conformance`): the panel is `import "server-only"` and
 * cannot be mounted in this tier.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "..", "..", "..", "..");
const read = (abs: string) => readFileSync(abs, "utf8");

const ISLAND = read(path.join(SRC_ROOT, "app", "lifecycle", "review-island", "page.tsx"));
const PANEL = read(
  path.join(
    SRC_ROOT,
    "app",
    "agents",
    "[vendor]",
    "[packageName]",
    "[instanceId]",
    "review",
    "[reviewTaskId]",
    "review-target-panel.tsx",
  ),
);

describe("cinatra#3080 — the target panel draws no second frame inside the card's", () => {
  it("the panel takes whether it is framed, and draws its border only when it is", () => {
    expect(PANEL).toContain("framed");
    // Every frame class it draws is under that condition — never unconditional.
    const frameLines = PANEL.split("\n").filter((l) => l.includes("rounded-control border"));
    expect(frameLines.length).toBeGreaterThan(0);
    for (const line of frameLines) {
      expect(line).toContain("framed");
    }
    // The conformance anchor stays whichever way it is drawn.
    expect(PANEL).toContain('data-conformance-id="review-target"');
  });

  it("the island frames a target ONLY on the legacy reading that pins several", () => {
    expect(ISLAND).toContain("framed={surface.targets.length > 1}");
  });
});
