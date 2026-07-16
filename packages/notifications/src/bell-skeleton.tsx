import { Bell } from "lucide-react";

import { Skeleton } from "@/components/ui/skeleton";

// ---------------------------------------------------------------------------
// Notifications bell — loading presentation (spec §IV, cinatra#1549 E11-AC2).
//
// The bell is a badge + link (no flyout — retired in the E8 cutover). While the
// viewer-eligibility count is still resolving it shows THIS skeleton: the real
// Bell glyph in the ghost icon-button frame with a design-system Skeleton
// standing in for the count badge. Built from the Skeleton primitive
// (src/components/ui/skeleton.tsx) — no new visual vocabulary invented.
//
// This is the real, exported loading presentation for the bell. The bell's
// steady-state badge resolves through the E6 client store + the server-resolved
// approvals count (notifications-provider.tsx), which has no live loading state
// today, so this presentation is mounted on the design-conformance harness (a
// production-build verification route) for the `notifications-bell` loading
// state variant rather than wired into the always-on header — it is not claimed
// to be exercised in ordinary product navigation.
// ---------------------------------------------------------------------------
export function NotificationsBellSkeleton(): React.ReactElement {
  return (
    <span
      data-conformance-id="notifications-bell"
      data-state="loading"
      role="status"
      aria-busy="true"
      aria-label="Notifications, loading"
      className="relative inline-grid size-9 place-items-center rounded-full text-muted-foreground"
    >
      <Bell className="h-5 w-5" aria-hidden />
      <Skeleton className="absolute -right-1 -top-1 size-4 rounded-full" />
    </span>
  );
}
