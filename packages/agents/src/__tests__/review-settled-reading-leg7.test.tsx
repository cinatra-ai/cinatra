// @vitest-environment jsdom
/**
 * THE SETTLED READING, AS DRAWN (cinatra#3080, PR #3100, fix leg 7).
 *
 * The eighth proof round graded the settled gate 11 of 24 against the ratified
 * ratified drawing at its default branch. Five of the thirteen
 * failures are this file's subject, and each test below quotes the sentence it
 * pins.
 *
 * THE HEADER STRIP. The drawing draws it as: eleven-by-fourteen padding, a
 * bottom rule (`border-bottom:1px solid var(--line)`), the word "Review" in bold
 * sans on the baseline, and BESIDE it a mono ten-pixel muted line naming what is
 * under review — "Outreach agent · run rn_8f31… · step 4 of 6". There is no
 * glyph before the word: the round measured an unspecified clipboard tile there.
 *
 * THE SETTLED MARKER. The drawing draws ONE bordered inline row below the whole
 * gate — `display:flex; align-items:center; gap:8px; border:1px solid
 * var(--line); border-radius:8px; padding:9px 12px; margin-top:10px` — holding
 * the approved pill with its dot ("Continued") and, beside it, a muted
 * twelve-pixel sentence: "Decided on the revision above. These are the words
 * that will be sent." The round measured a centred 144-css-px icon stack over
 * "The gate is resolved and the run has been released to continue."
 */
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ReviewGateHeader } from "../review-gate-card";
import { ReviewGateSettled } from "../review-gate-states";

describe("the gate header strip", () => {
  it("draws the word alone — no glyph before it", () => {
    const markup = renderToStaticMarkup(<ReviewGateHeader pending={false} naming={null} />);
    expect(markup).toContain(">Review<");
    // The clipboard tile the round charged as an unspecified element.
    expect(markup).not.toContain("lucide-clipboard-check");
    expect(markup).not.toContain("<svg");
  });

  it("carries the strip's own bottom rule", () => {
    const markup = renderToStaticMarkup(<ReviewGateHeader pending={false} naming={null} />);
    expect(markup).toMatch(/class="[^"]*\bborder-b\b[^"]*\bborder-line\b/);
  });

  it("draws the target-naming line beside the word, on the same baseline", () => {
    const markup = renderToStaticMarkup(
      <ReviewGateHeader
        pending={false}
        naming={{ agentLabel: "Outreach agent", runId: "rn_8f31c0d2", step: { index: 4, total: 6 } }}
      />,
    );
    expect(markup).toMatch(/class="[^"]*\bitems-baseline\b/);
    expect(markup).toContain("Outreach agent · run rn_8f31… · step 4 of 6");
    expect(markup).toMatch(/class="[^"]*\bfont-mono\b/);
  });

  it("says only what it can source — no invented segment", () => {
    const markup = renderToStaticMarkup(
      <ReviewGateHeader
        pending={false}
        naming={{ agentLabel: null, runId: "rn_8f31c0d2", step: null }}
      />,
    );
    expect(markup).toContain("run rn_8f31…");
    expect(markup).not.toContain("step");
    expect(markup).not.toContain("·");
  });

  it("draws no naming line at all when it can source none", () => {
    const markup = renderToStaticMarkup(
      <ReviewGateHeader pending={false} naming={{ agentLabel: null, runId: null, step: null }} />,
    );
    expect(markup).not.toContain("font-mono");
  });
});

describe("the settled marker", () => {
  it("is ONE bordered inline row, not a centred stack", () => {
    const markup = renderToStaticMarkup(<ReviewGateSettled outcome="approved" />);
    expect(markup).toMatch(/class="[^"]*\bflex\b[^"]*\bitems-center\b/);
    expect(markup).toMatch(/class="[^"]*\bborder\b[^"]*\bborder-line\b/);
    // the centred stack the round measured
    expect(markup).not.toContain("text-center");
    expect(markup).not.toContain("mx-auto");
    expect(markup).not.toContain("place-items-center");
  });

  it("holds the approved pill with its dot, reading the decision word alone", () => {
    const markup = renderToStaticMarkup(<ReviewGateSettled outcome="approved" />);
    expect(markup).toContain("Continued");
    expect(markup).toMatch(/data-review-settled-dot/);
  });

  it("reads the drawn sentence", () => {
    const markup = renderToStaticMarkup(<ReviewGateSettled outcome="approved" />);
    expect(markup).toContain("Decided on the revision above. These are the words that will be sent.");
    expect(markup).not.toContain("released to continue");
  });

  it("names no person, on any outcome", () => {
    for (const outcome of ["approved", "rejected", "changes_requested"] as const) {
      const markup = renderToStaticMarkup(<ReviewGateSettled outcome={outcome} />);
      expect(markup).not.toMatch(/\bby\s+[A-Z]/);
    }
  });
});
