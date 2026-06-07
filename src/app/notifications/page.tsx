import type { Metadata } from "next";
import { requireAuthSession } from "@/lib/auth-session";
import { listNotificationsForUserId } from "@/lib/notifications";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { notifPerf, notifPerfNow } from "@cinatra-ai/notifications/perf-log";

import { NotificationsArchiveBody } from "./notifications-archive-body";

export const metadata: Metadata = { title: "Notifications" };

export default async function NotificationsPage() {
  const __tTotal = notifPerfNow();
  // Notifications are per-user. Redirect to sign-in if there is no session.
  // Reuse the session already resolved by requireAuthSession() and list by
  // its user id; listNotifications() would otherwise call getAuthSession() a
  // second time, causing a redundant better-auth round-trip and enrichment on
  // the same request.
  const __tAuth = notifPerfNow();
  const session = await requireAuthSession();
  notifPerf("page.requireAuthSession", __tAuth);
  const __tList = notifPerfNow();
  const notifications = listNotificationsForUserId(session.user.id);
  notifPerf("page.listNotifications", __tList);
  notifPerf("page.TOTAL", __tTotal);

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Notifications"
        description="Review completed, failed, and in-progress background tasks across Cinatra."
        divider={false}
      />
      <PageContent className="flex flex-col gap-4 pb-8">
        {/* Filters/search/mark-all-read live in the client body; the server
            page stays minimal for auth and initial-paint data. */}
        <NotificationsArchiveBody notifications={notifications} />
      </PageContent>
    </Main>
  );
}
