import type { Metadata } from "next";

import { isPlatformAdmin, requireAuthSession } from "@/lib/auth-session";
import type { ApprovalViewer } from "@/app/configuration/approvals/sources/types";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";

import { loadFeedWindow } from "./feed-window";
import { NotificationsFeed } from "./notifications-feed";
import {
  isE2EDegradeApprovalsRequested,
  e2eDegradedApprovalSources,
} from "./e2e-degrade";

export const metadata: Metadata = { title: "Notifications" };
// Per-user + org-scoped, session-derived — never statically cached.
export const dynamic = "force-dynamic";

// ---------------------------------------------------------------------------
// /notifications v2 (cinatra#2380, S2) — the single chronological list
// unifying notifications and pending approvals, per the ratified notifications
// design spec (cinatra-ai/design specs/app-notifications.html v0.1.2 — the
// pinned contract recorded on the PR).
//
// Wide column (§I): `max-w-3xl` on BOTH the header and the content column, or
// they misalign (connector-setup precedent) — the surface previously carried
// no width tier of its own.
//
// The server page resolves the viewer, walks the union feed (feed-window.ts,
// bounded) for the FIRST numbered page ("all", page 1) for the initial paint +
// auth, and hands the known-total window to the client feed. Every subsequent
// filter-tab or page change is served by `feed-actions.ts`'s `fetchFeedWindow`
// server action. `requireAuthSession()` gates the page (redirects to
// sign-in); an org-less session degrades to notifications-only (no approval
// sources) via the E5 `sources: []` injection seam.
// ---------------------------------------------------------------------------
export default async function NotificationsPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireAuthSession();
  const userId = session.user.id;
  const orgId = session.session?.activeOrganizationId ?? null;

  const viewer: ApprovalViewer = {
    userId,
    orgId: orgId ?? "",
    isAdmin: isPlatformAdmin(session),
  };

  // E2E-only (cinatra#1561): force a degraded approval half so the §VI degraded
  // line + retry are provable on the production build. Prod-unreachable — gated
  // on CINATRA_E2E_SETUP_BYPASS (never set in prod) + `?e2e=degrade-approvals`.
  const sp = searchParams ? await searchParams : undefined;
  const degradeApprovals = isE2EDegradeApprovalsRequested(sp);

  const initialWindow = await loadFeedWindow(viewer, {
    chip: "all",
    page: 1,
    // Degrade seam wins; else no active org → notifications-only (approval
    // sources need an org).
    ...(degradeApprovals
      ? { deps: { sources: e2eDegradedApprovalSources() } }
      : orgId
        ? {}
        : { deps: { sources: [] } }),
  });

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Notifications"
        description="Everything that needs your attention — updates and pending approvals, newest first."
        divider={false}
        className="max-w-3xl"
      />
      <PageContent className="flex max-w-3xl flex-col gap-4 pb-8">
        <NotificationsFeed initialWindow={initialWindow} />
      </PageContent>
    </Main>
  );
}
