import type { Metadata } from "next";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import {
  loadUnifiedFeedPage,
  encodeUnifiedFeedCursor,
} from "@/app/configuration/approvals/unified-feed";
import type { ApprovalViewer } from "@/app/configuration/approvals/sources/types";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";

import { buildFeedRowVMs, FEED_PAGE_SIZE } from "./feed-view-model";
import { NotificationsFeed } from "./notifications-feed";

export const metadata: Metadata = { title: "Notifications" };
// Per-user + org-scoped, session-derived — never statically cached.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /notifications v2 (cinatra#1557, E7) — the single chronological list unifying
// notifications and pending approvals, per the ratified notifications design
// spec (application-design-notifications; pinned contract recorded on the PR).
//
// The server page resolves the viewer, loads the FIRST unified-feed page (E5)
// for the initial paint + auth, maps it to the serializable view-model, and
// hands it to the client feed. Pagination, filtering, inline decide and
// mark-read live in the client body; subsequent pages come from the
// `loadMoreUnifiedFeed` server action. `requireAuthSession()` gates the page
// (redirects to sign-in); an org-less session degrades to notifications-only
// (no approval sources) via E5's `sources: []` injection seam.
// ---------------------------------------------------------------------------
export default async function NotificationsPage() {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const orgId = session.session?.activeOrganizationId ?? null;

  const viewer: ApprovalViewer = {
    userId,
    orgId: orgId ?? "",
    isAdmin: isPlatformAdmin(session),
  };

  const page = await loadUnifiedFeedPage(viewer, {
    limit: FEED_PAGE_SIZE,
    // No active org → notifications-only; the approval sources need an org.
    ...(orgId ? {} : { deps: { sources: [] } }),
  });

  const items = buildFeedRowVMs(page.items);
  const initialNextCursor = page.nextCursor
    ? encodeUnifiedFeedCursor(page.nextCursor)
    : null;

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Notifications"
        description="Everything that needs your attention — updates and pending approvals, newest first."
        divider={false}
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        <NotificationsFeed
          initialItems={items}
          initialNextCursor={initialNextCursor}
          initialDegraded={page.degraded}
        />
      </PageContent>
    </Main>
  );
}
