import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

import { NotificationsListSkeleton } from "./notifications-skeletons";

// ---------------------------------------------------------------------------
// /notifications v2 — route-level loading UI (cinatra#1549 E11-AC2).
//
// `page.tsx` is `force-dynamic` and awaits `loadUnifiedFeedPage` (a DB +
// approval-source-registry read), so Next.js streams THIS skeleton while the
// first feed page resolves. It is the ratified spec's §I/§III loading
// presentation — the filter-chip rail skeleton + the row/list skeleton — under
// the same page header the resolved page renders, so the frame does not jump on
// swap. User-visible on every navigation to /notifications.
// ---------------------------------------------------------------------------
export default function NotificationsLoading(): React.ReactElement {
  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Notifications"
        description="Everything that needs your attention — updates and pending approvals, newest first."
        divider={false}
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        <NotificationsListSkeleton />
      </PageContent>
    </Main>
  );
}
