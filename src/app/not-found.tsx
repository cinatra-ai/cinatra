import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { CrumbContributionsClear } from "@/components/crumb-contributions";
import { getAuthSession, isPlatformAdmin } from "@/lib/auth-session";

export const metadata: Metadata = { title: "Page not found" };

export default async function NotFoundPage() {
  // `/configuration` is the platform-admin area (cinatra#2700, epic #2699), and
  // this page is reached by anyone who mistypes a URL — including the non-admin
  // who has just been bounced OFF a configuration route. Offering them the same
  // door again would be the dead link this slice removes.
  const viewerIsAdmin = isPlatformAdmin(await getAuthSession().catch(() => null));
  return (
    <Main className="min-h-screen">
      {/* Negative crumb clearing (cinatra#1737): a previously-authorized
          entity label must never survive into an unauthorized/404 visit. */}
      <CrumbContributionsClear />
      <PageHeader
        title="404 — Page not found"
        description="The page you're looking for doesn't exist or may have moved."
      />
      <PageContent className="pb-8">
        <div className="soft-panel rounded-card px-6 py-6">
          <p className="text-sm leading-6 text-muted-foreground">
            Check the URL for typos, or head back to the app.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/chat"
              className="inline-flex items-center justify-center rounded-control border border-primary bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-surface-strong hover:text-foreground"
            >
              Back to app
            </Link>
            {viewerIsAdmin ? (
              <Link
                href="/configuration"
                className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-primary"
              >
                Open configuration
              </Link>
            ) : null}
          </div>
        </div>
      </PageContent>
    </Main>
  );
}
