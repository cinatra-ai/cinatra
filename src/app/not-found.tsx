import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { Main } from "@/components/layout/main";

export const metadata: Metadata = { title: "Page not found" };

export default function NotFoundPage() {
  return (
    <Main className="min-h-screen">
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
            <Link
              href="/configuration"
              className="inline-flex items-center justify-center rounded-control border border-line bg-surface-strong px-5 py-3 text-sm font-semibold text-foreground transition hover:border-primary"
            >
              Open configuration
            </Link>
          </div>
        </div>
      </PageContent>
    </Main>
  );
}
