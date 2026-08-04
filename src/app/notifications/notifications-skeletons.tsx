// ---------------------------------------------------------------------------
// /notifications v2 — loading skeletons (cinatra#2380, S2).
//
// The ratified notifications design spec declares a `loading` presentation
// for the toolbar (§III) and for the card / list shell (§I/§II). These are the real,
// shipped skeletons for that state — built from the design-system Skeleton
// primitive (src/components/ui/skeleton.tsx) and the SAME tokens + geometry
// the live feed uses (notifications-feed.tsx): the toolbar chrome, the 34px
// glyph frame, the two-line body, the trailing status slot, and the spaced
// card shell. No new visual vocabulary is invented — the skeleton is the
// feed's own anatomy in the shimmer treatment.
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
 * Toolbar skeleton (§III). The toggle-group's four segments in the real
 * rail's chrome (the toolbar ground, a hairline-bordered segment cluster),
 * plus the trailing "Mark all read" placeholder, so the loading frame
 * occupies the same footprint as the resolved toolbar.
 */
export function NotificationsFilterRailSkeleton(): React.ReactElement {
  return (
    <div
      data-conformance-id="notifications-filter-rail"
      data-state="loading"
      role="group"
      aria-label="Filter notifications"
      aria-busy="true"
      className="flex min-h-12 w-full items-center justify-between gap-3 rounded-chip bg-toolbar p-[7px]"
    >
      <div className="flex overflow-hidden rounded-[7px] border border-line">
        {["w-10", "w-24", "w-16", "w-20"].map((w, i) => (
          <Skeleton key={i} className={cn("h-[30px] rounded-none", w)} />
        ))}
      </div>
      <Skeleton className="h-[30px] w-24 rounded-[7px]" />
    </div>
  );
}

/**
 * One card-shell skeleton (§II): the leading glyph frame, the two-line body,
 * and the trailing status slot — the uniform shell both species share, so it
 * stands in for a loading notification-row and approval-row alike.
 */
export function FeedRowSkeleton({
  isLast = false,
}: {
  /** No-op — cards are spaced (a `gap`, not a divider), so the last-card
   *  divider suppression no longer applies. Kept for call-site compatibility;
   *  carried onto `data-last` as an informational marker only. */
  isLast?: boolean;
} = {}): React.ReactElement {
  return (
    <div
      data-slot="feed-row-skeleton"
      data-state="loading"
      data-last={isLast || undefined}
      className="flex items-center gap-3.5 rounded-[11px] border border-line bg-surface-strong p-3.5"
    >
      <Skeleton className="size-[34px] flex-none rounded-lg" />
      <div className="min-w-0 flex-1 space-y-2 py-0.5">
        <Skeleton className="h-3.5 w-1/2 rounded" />
        <Skeleton className="h-3 w-1/3 rounded" />
      </div>
      <Skeleton className="size-[26px] flex-none rounded-md" />
    </div>
  );
}

/**
 * The whole-surface loading skeleton (§I): the toolbar skeleton above a
 * spaced stack of card skeletons — the loading presentation the
 * /notifications page shows before the first union-feed window resolves.
 */
export function NotificationsListSkeleton({
  rows = 4,
}: {
  rows?: number;
}): React.ReactElement {
  return (
    <div data-slot="notifications-list-skeleton" className="flex flex-col gap-4">
      <NotificationsFilterRailSkeleton />
      <ul className="grid gap-2.5">
        {Array.from({ length: rows }).map((_, i) => (
          <li key={i}>
            <FeedRowSkeleton />
          </li>
        ))}
      </ul>
    </div>
  );
}
