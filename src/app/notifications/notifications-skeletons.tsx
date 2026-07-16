// ---------------------------------------------------------------------------
// /notifications v2 — loading skeletons (cinatra#1549 E11-AC2).
//
// The ratified notifications design spec (application-design-notifications,
// design@2bcc2c7e) declares a `loading` presentation for the filter-chip rail
// (§III) and for the row / list shell (§I/§II). These are the real, shipped
// skeletons for that state — built from the design-system Skeleton primitive
// (src/components/ui/skeleton.tsx) and the SAME tokens + geometry the live feed
// uses (notifications-feed.tsx): the 34px glyph frame, the two-line body, the
// trailing status slot, and the 30px filter chips. No new visual vocabulary is
// invented — the skeleton is the feed's own anatomy in the shimmer treatment.
//
// `loading.tsx` renders `NotificationsListSkeleton` as the route-level loading
// UI while the force-dynamic page streams (user-visible on every navigation to
// /notifications); the design-conformance harness mounts these components for
// the `notifications-filter-rail`, `notification-row`, and `notifications-list`
// loading state variants (tests/e2e/design/conformance/contract.ts).
// ---------------------------------------------------------------------------
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/**
 * Filter-chip rail skeleton (§III). Four chip-shaped placeholders in the real
 * rail's geometry (h-[30px] rounded-full), inside the same labelled group the
 * live rail carries, so the loading frame occupies the same footprint.
 */
export function NotificationsFilterRailSkeleton(): React.ReactElement {
  return (
    <div
      data-conformance-id="notifications-filter-rail"
      data-state="loading"
      role="group"
      aria-label="Filter notifications"
      aria-busy="true"
      className="flex flex-wrap gap-2"
    >
      {["w-11", "w-32", "w-24", "w-28"].map((w, i) => (
        <Skeleton key={i} className={cn("h-[30px] rounded-full", w)} />
      ))}
    </div>
  );
}

/**
 * One row-shell skeleton (§II): the leading glyph frame, the two-line body, and
 * the trailing status slot — the uniform shell both species share, so it stands
 * in for a loading notification-row and approval-row alike.
 */
export function FeedRowSkeleton({
  isLast = false,
}: {
  isLast?: boolean;
}): React.ReactElement {
  return (
    <div
      data-slot="feed-row-skeleton"
      data-state="loading"
      className={cn(
        "flex items-start gap-3.5 px-3.5 py-3",
        isLast ? "" : "border-b border-line",
      )}
    >
      <Skeleton className="size-[34px] flex-none rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2 py-0.5">
        <Skeleton className="h-3.5 w-1/2 rounded" />
        <Skeleton className="h-3 w-1/3 rounded" />
      </div>
      <Skeleton className="size-2 flex-none rounded-full" />
    </div>
  );
}

/**
 * The whole-surface loading skeleton (§I): the filter-rail skeleton above a
 * bordered list of row skeletons — the loading presentation the /notifications
 * page shows before the first unified-feed page resolves.
 */
export function NotificationsListSkeleton({
  rows = 4,
}: {
  rows?: number;
}): React.ReactElement {
  return (
    <div data-slot="notifications-list-skeleton" className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <NotificationsFilterRailSkeleton />
        <Skeleton className="h-7 w-24 rounded" />
      </div>
      <ul className="flex flex-col overflow-hidden rounded-lg border border-line bg-surface-strong">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i}>
            <FeedRowSkeleton isLast={i === rows - 1} />
          </li>
        ))}
      </ul>
    </div>
  );
}
