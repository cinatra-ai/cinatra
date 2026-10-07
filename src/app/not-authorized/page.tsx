import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";
import { CrumbContributionsClear } from "@/components/crumb-contributions";
import { resolveNotAuthorizedDescription } from "@/lib/not-authorized-reason";

export const metadata: Metadata = { title: "Not Authorized" };

/**
 * The refusal page. An optional `reason` (cinatra#3787) lets a refusing surface
 * say what is actually missing; the closed set and every sentence live in
 * `@/lib/not-authorized-reason`, and anything outside it reads the default
 * platform-admin sentence exactly as before.
 */
export default async function NotAuthorizedPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const description = resolveNotAuthorizedDescription(
    (await searchParams)?.reason,
  );
  return (
    <Main className="min-h-screen">
      {/* Negative crumb clearing (cinatra#1737): a previously-authorized
          entity label must never survive into an unauthorized/404 visit. */}
      <CrumbContributionsClear />
      <PageHeader
        title="Not authorized"
        description={description}
      />
      <PageContent className="pb-8">
        <div className="soft-panel rounded-card px-6 py-6">
          <p className="text-sm leading-6 text-muted-foreground">
            If this is a fresh setup with no users yet, register the first account from the sign-in area. The first registered user is promoted to full access automatically.
          </p>
          <div className="mt-5 flex flex-wrap gap-3">
            <Link
              href="/sign-in"
              className="inline-flex items-center justify-center rounded-control border border-primary bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground transition hover:bg-surface-strong hover:text-foreground"
            >
              Go to sign in
            </Link>
            <Link
              href="/chat"
              className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-primary"
            >
              Back to app
            </Link>
          </div>
        </div>
      </PageContent>
    </Main>
  );
}
