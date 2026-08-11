import { Card, CardContent } from "@/components/ui/card";
import type { CostSummaryRow, BudgetConfig, LegacyCostEntry } from "../store";
import { legacyMonthlyShare } from "./cost-summary-cards";
import { unknownRowsPhrase } from "./cost-by-provider-table";

type BudgetAlertProps = {
  summary: CostSummaryRow;
  budgetConfig: BudgetConfig;
  legacyCosts: LegacyCostEntry[];
};

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

// ---------------------------------------------------------------------------
// Why this alert says "at least" (cinatra#2669).
//
// The figure compared against the budget is `SUM(cost_usd)` over the current
// month, and that sum SKIPS every row the ledger could not price — an image
// call, a knowledge-graph episode, a model with no rate card. So the number is a
// LOWER BOUND, and presenting it as "spent" is the one direction that matters:
// a bar reading 60% can sit under a budget the operator has already passed.
//
// `CostSummaryRow.nullCostCount` could not qualify it — that counter is
// ALL-TIME, so a ledger full of unpriced rows from March would mark a complete
// month as partial and an unpriced row added today would go unmentioned in a
// month whose history is clean. The store therefore measures the unpriced rows
// over the SAME month window as the amount (`nullCostCountThisMonth`), and this
// component labels the amount, the percentage and the bar from it.
//
// With nothing unpriced this month the wording is byte-identical to before: an
// exact figure must not be hedged.
// ---------------------------------------------------------------------------

/**
 * Floor `value` at `decimals` places WITHOUT letting binary floating point eat
 * a unit.
 *
 * `Math.floor(1.15 * 100) / 100` is `1.14`: the product is representable only
 * as `114.99999999999999`. Rounding the scaled value to a precision far below
 * anything a currency carries snaps that representation error away before the
 * floor sees it, so a true `1.149` still floors to `1.14` while an exact `1.15`
 * stays `1.15`.
 */
function floorAt(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.floor(Number((value * scale).toFixed(9))) / scale;
}

/**
 * The amount, marked as a floor when the month holds rows nobody could price.
 *
 * A displayed FLOOR has to round DOWN. `toFixed` rounds to nearest, so
 * `$99.996` would print "at least $100.00" — a lower bound above the number it
 * bounds, which is the same overstatement in miniature that this whole issue is
 * about. An exact figure keeps rounding to nearest: it is not a bound, it is
 * the amount.
 */
export function formatBudgetAmount(total: number, unknownCostCount: number): string {
  if (unknownCostCount <= 0) return formatUsd(total);
  return `at least ${formatUsd(floorAt(total, 2))}`;
}

/** The percentage, marked and floored the same way and for the same reason. */
export function formatBudgetPercent(pct: number, unknownCostCount: number): string {
  if (unknownCostCount <= 0) return `${pct.toFixed(0)}%`;
  return `at least ${floorAt(pct, 0)}%`;
}

/** What the figure leaves out, in the wording every other surface uses. */
export function budgetUnknownNote(unknownCostCount: number): string | null {
  if (unknownCostCount <= 0) return null;
  return (
    `This month's ledger holds ${unknownRowsPhrase(unknownCostCount)}, ` +
    `so the amount above is a floor and real spend may already be higher.`
  );
}

export function BudgetAlert({ summary, budgetConfig, legacyCosts }: BudgetAlertProps) {
  if (budgetConfig.monthlyBudgetUsd === null) return null;

  const budget = budgetConfig.monthlyBudgetUsd;
  const now = new Date();
  const legacyThisMonth = legacyCosts.reduce((sum, e) => sum + legacyMonthlyShare(e, now), 0);
  const thisMonthTotal = (summary.totalThisMonth ?? 0) + legacyThisMonth;
  const pct = (thisMonthTotal / budget) * 100;
  // Window-aligned by construction: the same month `totalThisMonth` was summed
  // over. An all-time count here would qualify the wrong number.
  const unknownThisMonth = summary.nullCostCountThisMonth ?? 0;
  const amountLabel = formatBudgetAmount(thisMonthTotal, unknownThisMonth);
  const percentLabel = formatBudgetPercent(pct, unknownThisMonth);
  const unknownNote = budgetUnknownNote(unknownThisMonth);

  const barColorClass =
    pct >= 100
      ? "h-full bg-destructive transition-all"
      : pct >= 80
        ? "h-full bg-warning transition-all"
        : "h-full bg-foreground/30 transition-all";

  return (
    <div className="flex flex-col gap-3">
      {/* Progress bar */}
      <Card className="border-line bg-surface backdrop-blur-none">
        <CardContent className="px-5 py-4">
          <div className="flex items-baseline justify-between">
            <h3 className="text-sm font-semibold text-foreground">Monthly Budget</h3>
            <span className="text-xs text-muted-foreground">
              {amountLabel} / {formatUsd(budget)} ({percentLabel})
            </span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-chip bg-surface-muted">
            <div
              className={barColorClass}
              style={{ width: `${Math.min(pct, 100).toFixed(1)}%` }}
            />
          </div>
          {unknownNote && (
            <p className="mt-2 text-xs text-muted-foreground" data-testid="budget-unknown-note">
              {unknownNote}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Warning / over-budget banner */}
      {pct >= 100 && (
        <div className="rounded-panel border border-destructive/40 bg-destructive/10 px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            Over budget &mdash; {amountLabel} spent of {formatUsd(budget)} monthly budget
          </span>
        </div>
      )}
      {pct >= 80 && pct < 100 && (
        <div className="rounded-panel border border-warning/40 bg-warning/10 px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            Approaching budget &mdash; {amountLabel} spent of {formatUsd(budget)} ({percentLabel})
          </span>
        </div>
      )}
    </div>
  );
}
