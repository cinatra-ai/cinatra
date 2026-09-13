/**
 * THE WAY BACK IS AN ACTION OF THE RUN, NOT A BANNER ACROSS IT (cinatra#3358).
 *
 * THE CHECKLIST SENTENCE, verbatim:
 *
 *   "no undrawn full-width cross-run banner — the return to the waiting run is
 *    placed where section I places the run's actions"
 *
 * WHERE THE DRAWING PUTS IT. Agent run & review §I draws the run as a
 * two-column frame — "a step rail down the left names the run's ordered steps,
 * and the run detail on the right shows the selected step" — and gives the
 * frame nothing above it. The run's actions are the page header's own slot, the
 * one `AgentPageLayout` already exposes and this screen already mounts the run
 * control into; that is where the return goes.
 *
 * HOW THIS ONE IS GRADED, and why it is read at the source. `instance-screens`
 * is an async SERVER component whose module graph reaches the store, the
 * authorization policy and the run-creation seam; mounting it in a test
 * environment proves nothing about a React Server Component tree and would
 * grade the mocks instead. The property this sentence makes is structural —
 * which slot the node is in — so it is read where it is written, the same
 * source-level grading this repository's sibling drawing suites already use for
 * decisions that live in composition rather than in rendered DOM. The node's own
 * rendering is graded on the boot, in both palettes, in the proof round.
 *
 *   pnpm vitest run packages/agents/src/__tests__/run-return-road-placement.test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = readFileSync(
  join(__dirname, "..", "instance-screens.tsx"),
  "utf8",
);

/** The text of the `actions={...}` prop the run page hands its layout. */
function runActionsSlot(): string {
  const start = SRC.indexOf("        actions={");
  expect(start, "the run page no longer hands its layout an actions slot").toBeGreaterThan(-1);
  const end = SRC.indexOf("\n        }\n", start);
  expect(end).toBeGreaterThan(start);
  return SRC.slice(start, end);
}

describe('"no undrawn full-width cross-run banner"', () => {
  it("draws no banner node above the run frame", () => {
    expect(SRC).not.toContain("completion-return-banner");
    expect(SRC).not.toContain("Another run is waiting on this one.");
  });
});

describe('"the return to the waiting run is placed where section I places the run\'s actions"', () => {
  it("mounts the return inside the run's actions slot", () => {
    const slot = runActionsSlot();
    expect(slot).toContain("completionReturnHref");
    expect(slot).toContain("completion-return-link");
    expect(slot).toContain("Back to the waiting run");
  });

  it("keeps the run's own control in the same slot beside it", () => {
    // The slot carries the run's actions — the return joins them, it does not
    // replace them.
    expect(runActionsSlot()).toContain("RunAgentButton");
  });

  it("is the ONLY place the return is drawn", () => {
    const occurrences = SRC.split("completion-return-link").length - 1;
    expect(occurrences).toBe(1);
  });
});

describe("the canonical-home redirect keeps the offer (convergence round, cinatra#3448)", () => {
  it("carries the produced key across the redirect, not only the contract's two", () => {
    // Graded at the source for the same reason the placements above are: this
    // screen is an async server component whose graph reaches the store and the
    // authorization policy. The redirect's own composition is read here; the
    // keys' behaviour is pinned in completion-return-offer.test.ts.
    const at = SRC.indexOf("if (home)");
    expect(at, "the canonical-home redirect is gone").toBeGreaterThan(-1);
    const redirectText = SRC.slice(at, at + 600);
    expect(redirectText).toContain("withCompletionReturn");
    expect(redirectText).toContain("withCompletionProduced");
    expect(redirectText).toContain("readCompletionProducedParam");
  });
});
