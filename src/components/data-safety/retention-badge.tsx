import "server-only";

import { Badge } from "@/components/ui/badge";
import { getRetentionPolicy } from "@/lib/object-history";
import type { RetentionPolicy } from "@/lib/object-history";

// Retention indicator near the object History tab.
// indefinite → muted badge; duration → days-
// remaining countdown, escalating to destructive within 10% of expiry.
// The PoC retention registry is indefinite for every type today, so the
// duration branch is exercised by the unit test + ready for finite policies.

const DAY_MS = 24 * 60 * 60 * 1000;

export type RetentionDisplay = {
  label: string;
  variant: "secondary" | "default" | "destructive";
};

// Pure display logic, extracted so the countdown is unit-testable without RTL.
export function computeRetentionDisplay(
  policy: RetentionPolicy,
  createdAt: string | null | undefined,
  now: number = Date.now(),
): RetentionDisplay {
  if (policy.kind === "indefinite") {
    return { label: "Retention: indefinite", variant: "secondary" };
  }
  const totalDays = policy.days;
  if (!createdAt) {
    return { label: `Retention: ${totalDays}d`, variant: "secondary" };
  }
  const expiresAt = new Date(createdAt).getTime() + totalDays * DAY_MS;
  const daysRemaining = Math.max(0, Math.ceil((expiresAt - now) / DAY_MS));
  const nearExpiry = daysRemaining <= Math.max(1, Math.ceil(totalDays * 0.1));
  return {
    label: `Retention: ${daysRemaining}d left`,
    variant: nearExpiry ? "destructive" : "default",
  };
}

export type RetentionBadgeProps = {
  objectType: string;
  /** ISO timestamp of the object's creation; required for the duration countdown. */
  createdAt?: string | null;
};

export function RetentionBadge({ objectType, createdAt }: RetentionBadgeProps) {
  const { label, variant } = computeRetentionDisplay(
    getRetentionPolicy(objectType),
    createdAt,
  );
  return <Badge variant={variant}>{label}</Badge>;
}
