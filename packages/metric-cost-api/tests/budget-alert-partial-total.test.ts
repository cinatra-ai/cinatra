/**
 * cinatra#2669 — the monthly budget alert stops calling a floor a total.
 *
 * The alert compares `SUM(cost_usd)` over the current month against the
 * configured budget. That sum SKIPS every row the ledger could not price, so it
 * is a LOWER BOUND — and the direction of the error is the dangerous one: a bar
 * reading 60% can sit under a budget the operator has already passed.
 *
 * The count that qualifies a MONTHLY figure has to be measured over the SAME
 * month. `CostSummaryRow.nullCostCount` is all-time, which fails in both
 * directions: a clean month inherits March's unpriced rows and reads as partial,
 * and a month whose history is clean says nothing when an unpriced row lands
 * today. So the store reports `nullCostCountThisMonth` and this component uses
 * that one.
 *
 * The component is rendered for real (react-dom/server) rather than asserted
 * from its source, because the claim under test is what an operator READS.
 */
import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  BudgetAlert,
  budgetUnknownNote,
  formatBudgetAmount,
  formatBudgetPercent,
} from "../src/components/budget-alert";
import type { CostSummaryRow } from "../src/store";

function summary(over: Partial<CostSummaryRow> = {}): CostSummaryRow {
  return {
    totalAllTime: 100,
    totalThisMonth: 80,
    totalThisWeek: 10,
    eventCount: 50,
    nullCostCount: 0,
    nullCostCountThisMonth: 0,
    ...over,
  };
}

function render(row: CostSummaryRow, monthlyBudgetUsd: number | null = 100): string {
  return renderToStaticMarkup(
    createElement(BudgetAlert, {
      summary: row,
      budgetConfig: { monthlyBudgetUsd },
      legacyCosts: [],
    }),
  );
}

/** Rendered markup as readable text, entities resolved. */
function text(markup: string): string {
  return markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&mdash;/g, "—")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

describe("an exact month is still stated exactly", () => {
  it("says the plain amount and percentage when nothing this month is unpriced", () => {
    const out = text(render(summary({ nullCostCountThisMonth: 0 })));
    expect(out).toContain("$80.00 / $100.00 (80%)");
    // No hedge on a figure that needs none.
    expect(out).not.toContain("at least");
    expect(out).not.toContain("unknown-cost");
  });

  it("keeps the formatters unhedged at zero", () => {
    expect(formatBudgetAmount(80, 0)).toBe("$80.00");
    expect(formatBudgetPercent(80, 0)).toBe("80%");
    expect(budgetUnknownNote(0)).toBeNull();
  });
});

describe("a month holding unpriced rows is labelled partial", () => {
  it("marks the amount AND the percentage as a floor", () => {
    const out = text(render(summary({ nullCostCountThisMonth: 4 })));
    expect(out).toContain("at least $80.00 / $100.00 (at least 80%)");
  });

  it("says how many rows the figure leaves out, in the shared wording", () => {
    const out = text(render(summary({ nullCostCountThisMonth: 4 })));
    expect(out).toContain("4 unknown-cost rows");
    expect(out).toContain("may already be higher");
  });

  it("reads as a sentence for a single row", () => {
    expect(budgetUnknownNote(1)).toContain("1 unknown-cost row");
    expect(budgetUnknownNote(1)).not.toContain("1 unknown-cost rows");
  });

  it("rounds a FLOOR downwards, never up past the number it bounds", () => {
    // `toFixed` rounds to nearest, so $99.996 would print "at least $100.00" —
    // a lower bound ABOVE the amount it bounds, the same overstatement in
    // miniature that this issue exists to remove.
    expect(formatBudgetAmount(99.996, 1)).toBe("at least $99.99");
    expect(formatBudgetPercent(99.6, 1)).toBe("at least 99%");
    expect(formatBudgetPercent(79.9, 1)).toBe("at least 79%");
    // An EXACT figure is not a bound; it keeps rounding to nearest.
    expect(formatBudgetAmount(99.996, 0)).toBe("$100.00");
    expect(formatBudgetPercent(99.6, 0)).toBe("100%");
  });

  it("does not lose a cent to binary floating point", () => {
    // `Math.floor(1.15 * 100) / 100` is 1.14: the product is representable only
    // as 114.99999999999999. A floor is allowed to be conservative, but not to
    // under-report a cent of spend an operator can see elsewhere on the page.
    expect(formatBudgetAmount(1.15, 1)).toBe("at least $1.15");
    expect(formatBudgetAmount(8.2, 1)).toBe("at least $8.20");
    expect(formatBudgetAmount(1.149, 1)).toBe("at least $1.14");
    expect(formatBudgetPercent(29, 1)).toBe("at least 29%");
  });

  it("never announces 100% of a budget off a rounded-up floor", () => {
    const out = text(render(summary({ totalThisMonth: 99.6, nullCostCountThisMonth: 1 })));
    expect(out).toContain("Approaching budget");
    expect(out).toContain("at least 99%");
    expect(out).not.toContain("at least 100%");
  });

  it("hedges the over-budget banner too", () => {
    const out = text(render(summary({ totalThisMonth: 140, nullCostCountThisMonth: 2 })));
    expect(out).toContain("Over budget");
    expect(out).toContain("at least $140.00 spent of $100.00");
  });

  it("hedges the approaching-budget banner too", () => {
    const out = text(render(summary({ totalThisMonth: 85, nullCostCountThisMonth: 2 })));
    expect(out).toContain("Approaching budget");
    expect(out).toContain("at least $85.00 spent of $100.00 (at least 85%)");
  });
});

describe("the count is the MONTH's, not the ledger's", () => {
  // The negative control for the window: an all-time-only reading of the ledger
  // gets both cases exactly backwards.
  it("does not hedge a clean month sitting on a ledger full of unpriced history", () => {
    const out = text(render(summary({ nullCostCount: 250, nullCostCountThisMonth: 0 })));
    expect(out).toContain("$80.00 / $100.00 (80%)");
    expect(out).not.toContain("at least");
  });

  it("hedges a month with unpriced rows even when the all-time count is small", () => {
    const out = text(render(summary({ nullCostCount: 1, nullCostCountThisMonth: 1 })));
    expect(out).toContain("at least $80.00");
    expect(out).toContain("1 unknown-cost row");
  });

  it("stays silent with no budget configured", () => {
    expect(render(summary({ nullCostCountThisMonth: 4 }), null)).toBe("");
  });
});
