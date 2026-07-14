/**
 * §III read-authorization refusal for the artifact detail route (cinatra#1431,
 * spec design@4c6799db §III: "A row the viewer may list but not read opens to a
 * not-authorized panel, never to its bytes"). Rendered when
 * `readArtifactForDetail` returns `denied` — the row is an artifact the actor
 * can LIST but the canonical `object.read` decision refuses. A genuinely absent
 * / non-listable row 404s instead (existence stays hidden); this panel is only
 * for the list-visible-but-read-denied case, so naming it leaks nothing.
 */
import Link from "next/link";
import { Lock } from "lucide-react";

import { Main } from "@/components/layout/main";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";

export function ArtifactReadDeniedPanel() {
  return (
    <Main className="min-h-screen">
      <PageHeader title="Artifact" description="Not authorized" divider />
      <PageContent className="flex flex-col gap-6 pb-8">
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-14 text-center"
          data-testid="artifact-read-denied"
          data-conformance-id="artifact-read-denied"
          data-state="error"
        >
          <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
            <Lock aria-hidden className="size-5" />
          </div>
          <p className="text-sm font-semibold text-foreground">
            You don&apos;t have access to this artifact
          </p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            This artifact exists in your library view, but you&apos;re not
            authorized to open its contents.{" "}
            <Link
              href="/artifacts"
              className="text-primary underline-offset-4 hover:underline"
            >
              Back to Library
            </Link>
          </p>
        </div>
      </PageContent>
    </Main>
  );
}
