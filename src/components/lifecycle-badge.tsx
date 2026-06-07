import * as React from "react";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";

// LifecycleBadge is a thin wrapper over <StatusPill>.
// One canonical status renderer (StatusPill); LifecycleBadge keeps its
// existing API so call sites do not have to migrate.
//
// Mapping: lifecycle "active" → StatusPill "approved" (sea-green check).
//          lifecycle "archived" → StatusPill "archived" (muted box icon).

export type LifecycleStatus = "active" | "archived";

const LIFECYCLE_TO_PILL: Record<LifecycleStatus, StatusPillStatus> = {
  active: "approved",
  archived: "archived",
};

const LIFECYCLE_LABEL: Record<LifecycleStatus, string> = {
  active: "Active",
  archived: "Archived",
};

export type LifecycleBadgeProps = {
  status: LifecycleStatus;
  className?: string;
  children?: React.ReactNode;
} & Omit<React.ComponentProps<"span">, "children" | "className">;

export function LifecycleBadge({ status, className, children, ...props }: LifecycleBadgeProps) {
  return (
    <StatusPill
      status={LIFECYCLE_TO_PILL[status]}
      data-slot="lifecycle-badge"
      className={cn(className)}
      {...props}
    >
      {children ?? LIFECYCLE_LABEL[status]}
    </StatusPill>
  );
}
