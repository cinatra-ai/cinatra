import * as React from "react";
import { Badge } from "@/components/ui/badge";

/**
 * Registry risk levels. Mirrors `AgentPackageSummary["riskLevel"]`
 * (packages/registries/src/types.ts) — restated literally so the
 * design-system layer carries no package import.
 */
export type RiskLevel = "low" | "medium" | "high" | "critical";

/**
 * Canonical risk-level → shadcn Badge variant mapping: critical/high read as
 * destructive, medium as outline, low as secondary. Unknown values fall back
 * to secondary so a forward-compat level renders instead of crashing.
 *
 * This is the ONLY place the mapping lives — the registry detail page
 * (packages/agents/src/screens.tsx) and the extensions catalog list
 * (packages/extensions/src/screens/registry-catalog-screen.tsx) both consume
 * <RiskBadge> rather than re-mapping variants inline. Sibling components:
 * VisibilityBadge (src/components/visibility-badge.tsx), LifecycleBadge
 * (src/components/lifecycle-badge.tsx).
 */
function riskBadgeVariant(
  level: string,
): "destructive" | "outline" | "secondary" {
  if (level === "critical" || level === "high") return "destructive";
  if (level === "medium") return "outline";
  return "secondary"; // low
}

export type RiskBadgeProps = {
  /** Registry risk level; rendered verbatim as the badge label. */
  riskLevel: RiskLevel | (string & {});
  className?: string;
} & Omit<React.ComponentProps<typeof Badge>, "variant" | "children">;

export function RiskBadge({ riskLevel, className, ...props }: RiskBadgeProps) {
  return (
    <Badge
      variant={riskBadgeVariant(riskLevel)}
      data-risk-level={riskLevel}
      aria-label={`Risk level: ${riskLevel}`}
      className={className}
      {...props}
    >
      {riskLevel}
    </Badge>
  );
}
