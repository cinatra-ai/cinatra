import { Card, CardContent } from "@/components/ui/card";
import type { CostSummaryRow, BudgetConfig, LegacyCostEntry } from "../store";
import { legacyMonthlyShare } from "./cost-summary-cards";

type BudgetAlertProps = {
  summary: CostSummaryRow;
  budgetConfig: BudgetConfig;
  legacyCosts: LegacyCostEntry[];
};

function formatUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

export function BudgetAlert({ summary, budgetConfig, legacyCosts }: BudgetAlertProps) {
  if (budgetConfig.monthlyBudgetUsd === null) return null;

  const budget = budgetConfig.monthlyBudgetUsd;
  const now = new Date();
  const legacyThisMonth = legacyCosts.reduce((sum, e) => sum + legacyMonthlyShare(e, now), 0);
  const thisMonthTotal = (summary.totalThisMonth ?? 0) + legacyThisMonth;
  const pct = (thisMonthTotal / budget) * 100;

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
              {formatUsd(thisMonthTotal)} / {formatUsd(budget)} ({pct.toFixed(0)}%)
            </span>
          </div>
          <div className="mt-3 h-2 w-full overflow-hidden rounded-chip bg-surface-muted">
            <div
              className={barColorClass}
              style={{ width: `${Math.min(pct, 100).toFixed(1)}%` }}
            />
          </div>
        </CardContent>
      </Card>

      {/* Warning / over-budget banner */}
      {pct >= 100 && (
        <div className="rounded-panel border border-destructive/40 bg-destructive/10 px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            Over budget &mdash; {formatUsd(thisMonthTotal)} spent of {formatUsd(budget)} monthly budget
          </span>
        </div>
      )}
      {pct >= 80 && pct < 100 && (
        <div className="rounded-panel border border-warning/40 bg-warning/10 px-4 py-3">
          <span className="text-sm font-medium text-foreground">
            Approaching budget &mdash; {formatUsd(thisMonthTotal)} spent of {formatUsd(budget)} ({pct.toFixed(0)}%)
          </span>
        </div>
      )}
    </div>
  );
}
