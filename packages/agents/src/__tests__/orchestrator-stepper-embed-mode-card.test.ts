/**
 * Debug session: hitl-cream-card-dev-preview
 *
 * Bug: in the dev preview (amber wrapper), the embedded HitlApprovalCard's
 * inner <Card> was rendered with bg-transparent / border-0 / shadow-none /
 * py-0 because the embedMode wrapper applied
 * `[&>[data-slot=card]]:bg-transparent` and friends. That stripped the cream
 * `bg-card` (#f7f7f3) surface so the user only saw the inner renderer's
 * panel borders, with the amber wrapper directly behind them.
 *
 * Non-dev-preview rendering correctly shows the cream Card surface — dev
 * preview must match.
 *
 * This test asserts that the embedMode branch in orchestrator-stepper-panel.tsx
 * does NOT apply any of the visual-stripping classes that turn the inner
 * <Card> transparent / borderless / shadowless. We assert against the source
 * text because mounting the panel requires extensive sdk/mcp mocking that
 * is out of scope for a purely structural CSS regression.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it, expect } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "orchestrator-stepper-panel.tsx"),
  "utf8",
);

describe("orchestrator-stepper-panel embedMode wrapper — cream Card preservation", () => {
  it("does not strip the inner Card's background, border, shadow or padding in dev preview", () => {
    // Locate the embedMode return block. The original (broken) wrapper used
    //   <div className="[&>[data-slot=card]]:rounded-none [&>[data-slot=card]]:border-0 [&>[data-slot=card]]:bg-transparent [&>[data-slot=card]]:py-0 [&>[data-slot=card]]:shadow-none [&>[data-slot=card]>[data-slot=card-content]]:p-0">
    //     {stageCard}
    //   </div>
    //
    // We scan the source for any direct-child Card visual-stripping selector
    // and fail if any is present. The fix is to drop these overrides and let
    // the inner <Card> render with its natural cream `bg-card` + ring.
    const forbiddenPatterns = [
      /\[&>\[data-slot=card\]\]:bg-transparent/,
      /\[&>\[data-slot=card\]\]:border-0/,
      /\[&>\[data-slot=card\]\]:shadow-none/,
      /\[&>\[data-slot=card\]\]:py-0/,
      /\[&>\[data-slot=card\]\]:rounded-none/,
      /\[&>\[data-slot=card\]>\[data-slot=card-content\]\]:p-0/,
    ];

    const violations = forbiddenPatterns.filter((re) => re.test(SRC));

    expect(
      violations,
      `Dev-preview embedMode wrapper must not strip the inner Card's cream surface. ` +
        `Forbidden selectors found: ${violations.map((r) => r.source).join(", ")}`,
    ).toEqual([]);
  });
});
