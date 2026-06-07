import { DollarSign, Calendar, CalendarDays } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import type { CostSummaryRow, LegacyCostEntry } from "../store";
import { getDaysInMonth, getDate, getOverlappingDaysInIntervals, startOfMonth, endOfMonth, differenceInDays } from "date-fns";

type CostSummaryCardsProps = {
  summary: CostSummaryRow;
  legacyCosts: LegacyCostEntry[];
};

function formatUsd(value: number | null): string {
  if (value === null || value === undefined) return "$0.00";
  return `$${value.toFixed(2)}`;
}

// Returns true if the entry is active during the current calendar month.
// - null startDate means no lower bound (subscription already started)
// - null endDate means no upper bound (subscription still running)
function isActiveInMonth(entry: LegacyCostEntry, now: Date): boolean {
  const monthStart = startOfMonth(now);
  const monthEnd = endOfMonth(now);
  if (entry.startDate) {
    const start = new Date(entry.startDate);
    if (start > monthEnd) return false; // not started yet this month
  }
  if (entry.endDate) {
    const end = new Date(entry.endDate);
    if (end < monthStart) return false; // already ended before this month
  }
  return true;
}

// Returns the share of this entry's cost that counts toward "This Month".
// - monthly: the full costUsd amount is the monthly cost
// - yearly: costUsd / 12 is the monthly equivalent
// - once: date-overlap proration within the current month (original behavior)
export function legacyMonthlyShare(entry: LegacyCostEntry, now: Date): number {
  const cost = parseFloat(entry.costUsd);
  if (isNaN(cost) || cost <= 0) return 0;

  if (entry.frequency === "monthly") {
    return isActiveInMonth(entry, now) ? cost : 0;
  }
  if (entry.frequency === "yearly") {
    return isActiveInMonth(entry, now) ? cost / 12 : 0;
  }
  // once — original date-overlap proration logic (LEGACY-04)
  if (!entry.startDate || !entry.endDate) return 0;
  const start = new Date(entry.startDate);
  const end = new Date(entry.endDate);
  const totalDays = differenceInDays(end, start) + 1;
  if (totalDays <= 0) return 0;
  const overlap = getOverlappingDaysInIntervals(
    { start: startOfMonth(now), end: endOfMonth(now) },
    { start, end },
  );
  if (overlap <= 0) return 0;
  return cost * (overlap / totalDays);
}

function buildLegacySubtitle(legacyOnlyAmount: number, subscriptionOnlyAmount: number): string | undefined {
  const parts: string[] = [];
  if (legacyOnlyAmount > 0) parts.push(`$${legacyOnlyAmount.toFixed(2)} one-time`);
  if (subscriptionOnlyAmount > 0) parts.push(`$${subscriptionOnlyAmount.toFixed(2)} subscriptions`);
  if (parts.length === 0) return undefined;
  return `Incl. ${parts.join(" + ")}`;
}

export function CostSummaryCards({ summary, legacyCosts }: CostSummaryCardsProps) {
  const now = new Date();

  // Split by cost type for subtitle breakdown
  const legacyEntries       = legacyCosts.filter((e) => e.costType === "legacy");
  const subscriptionEntries = legacyCosts.filter((e) => e.costType === "subscription");

  const legacyAllTimeOnly       = legacyEntries.reduce((sum, e) => sum + parseFloat(e.costUsd), 0);
  const subscriptionAllTimeOnly = subscriptionEntries.reduce((sum, e) => sum + parseFloat(e.costUsd), 0);
  const legacyAllTime           = legacyAllTimeOnly + subscriptionAllTimeOnly;

  const legacyThisMonthOnly       = legacyEntries.reduce((sum, e) => sum + legacyMonthlyShare(e, now), 0);
  const subscriptionThisMonthOnly = subscriptionEntries.reduce((sum, e) => sum + legacyMonthlyShare(e, now), 0);
  const legacyThisMonth           = legacyThisMonthOnly + subscriptionThisMonthOnly;

  const allTimeTotal   = (summary.totalAllTime ?? 0) + legacyAllTime;
  const thisMonthTotal = (summary.totalThisMonth ?? 0) + legacyThisMonth;

  const cards = [
    {
      label: "All Time",
      value: formatUsd(allTimeTotal),
      icon: DollarSign,
      subtitle: buildLegacySubtitle(legacyAllTimeOnly, subscriptionAllTimeOnly),
    },
    {
      label: "This Month",
      value: formatUsd(thisMonthTotal),
      icon: Calendar,
      subtitle: buildLegacySubtitle(legacyThisMonthOnly, subscriptionThisMonthOnly),
    },
    { label: "This Week", value: formatUsd(summary.totalThisWeek), icon: CalendarDays },
  ];

  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
      {cards.map((card) => (
        <Card key={card.label} className="border-line bg-surface backdrop-blur-none">
          <CardContent className="px-5 py-4">
            <div className="flex items-center gap-2 text-muted-foreground">
              <card.icon className="h-4 w-4" />
              <span className="text-sm font-medium">{card.label}</span>
            </div>
            <p className="mt-2 text-2xl font-bold text-foreground">{card.value}</p>
            {card.subtitle && (
              <p className="mt-1 text-xs text-muted-foreground">{card.subtitle}</p>
            )}
          </CardContent>
        </Card>
      ))}
      {summary.nullCostCount > 0 && (
        <p className="col-span-full text-xs text-muted-foreground">
          {summary.nullCostCount} event(s) have unknown cost (missing model pricing).
        </p>
      )}
    </div>
  );
}
