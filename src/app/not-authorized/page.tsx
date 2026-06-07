import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";

export const metadata: Metadata = { title: "Not Authorized" };

export default function NotAuthorizedPage() {
  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Not authorized"
        description="This area is limited to platform admins. Sign in with the admin account or ask an admin to grant your user the admin role."
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
