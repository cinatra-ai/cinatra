import * as React from "react";
import { StatusPill, type StatusPillStatus } from "@/components/ui/status-pill";
import { cn } from "@/lib/utils";

// LifecycleBadge is a thin wrapper over <StatusPill>.
// One canonical status renderer (StatusPill); LifecycleBadge keeps its
// existing API so call sites do not have to migrate.
//
// The status union mirrors the canonical extension lifecycle
// (EXTENSION_LIFECYCLE_STATUSES in packages/extensions/src/canonical-types.ts):
// "active" | "archived" | "locked".
//
// Mapping: lifecycle "active" → StatusPill "approved" (sea-green check).
//          lifecycle "archived" → StatusPill "archived" (muted grey cross).
//          lifecycle "locked" → StatusPill "approved" (live/green styling —
//          a locked system extension IS active) with a distinct "Locked"
//          label + explanatory tooltip, mirroring lifecycle-ui.ts copy.

export type LifecycleStatus = "active" | "archived" | "locked";

const LIFECYCLE_TO_PILL: Record<LifecycleStatus, StatusPillStatus> = {
  active: "approved",
  archived: "archived",
  locked: "approved",
};

const LIFECYCLE_LABEL: Record<LifecycleStatus, string> = {
  active: "Active",
  archived: "Archived",
  locked: "Locked",
};

// Default tooltip per status — overridable via the standard `title` prop.
const LIFECYCLE_TITLE: Partial<Record<LifecycleStatus, string>> = {
  locked: "System extension — always active; cannot be archived or uninstalled.",
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
      data-lifecycle={status}
      title={LIFECYCLE_TITLE[status]}
      className={cn(className)}
      {...props}
    >
      {children ?? LIFECYCLE_LABEL[status]}
    </StatusPill>
  );
}
