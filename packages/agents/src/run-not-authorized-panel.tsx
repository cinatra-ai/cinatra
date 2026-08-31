import { Lock } from "lucide-react";

import { CrumbContributionsClear } from "@/components/crumb-contributions";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";

/**
 * THE STANDARD NOT-AUTHORIZED PANEL, FOR EVERY RUN SURFACE (cinatra#2934, the
 * fifth graded proof set).
 *
 * The ratified drawing says it once and says it for all of them
 * (design@c73c68f5e39e `specs/app-artifact-review.html` §VII): "A viewer with
 * no access to the run at all never reaches the surface: it opens to the
 * standard not-authorized panel, never to the target." The review surface
 * already answered that way; the run page and the schedule surface did not —
 * they answered a flat not-found, whose sentence is untrue (the run exists) and
 * whose chrome contradicted itself, since the trail above it still named the
 * surface the page had just denied existed.
 *
 * WHAT THIS PANEL MAY CONTAIN, AND WHY IT IS SO BARE. It is drawn for a person
 * who may NOT read the run, so it holds nothing of the run: no title, no
 * schedule, no exchange, no state — nothing that is not already in the address
 * the reader typed. It offers no control, because there is no act to offer, and
 * it confirms nothing, because a refusal that says "your request was received"
 * is a second untrue sentence. `CrumbContributionsClear` is part of that: a
 * label published by an earlier authorized visit must not survive into this one
 * and put a run's name above a page that refuses to show it.
 *
 * WHY IT IS ONE COMPONENT. The three surfaces refuse for the same reason and
 * must refuse the same way; two panels would drift, and the difference between
 * them would read to the person as a difference in what happened.
 */
export function RunNotAuthorizedPanel({
  surface,
  conformanceId,
}: {
  /** The tab the reader asked for — the word already in their address bar. */
  surface: string;
  conformanceId: string;
}) {
  return (
    <Main className="min-h-screen">
      <CrumbContributionsClear />
      <PageHeader label="Agent run" title={surface} description="Not authorized" divider />
      <PageContent className="flex flex-col gap-6 pb-8">
        <div
          className="flex flex-col items-center gap-3 rounded-lg border border-line bg-surface-strong px-5 py-14 text-center"
          data-conformance-id={conformanceId}
          data-state="error"
        >
          <div className="grid size-10 place-items-center rounded-lg bg-surface-muted text-muted-foreground">
            <Lock aria-hidden="true" className="size-5" />
          </div>
          <p className="text-sm font-semibold text-foreground">
            You don&apos;t have access to this run
          </p>
          <p className="max-w-md text-xs leading-relaxed text-muted-foreground">
            This page belongs to an agent run you&apos;re not authorized to act on. Ask
            the person who started it to share it with you.
          </p>
        </div>
      </PageContent>
    </Main>
  );
}
