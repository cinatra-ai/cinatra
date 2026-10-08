import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { CrumbContributions } from "@/components/crumb-contributions";
import type { CrumbContribution } from "@/lib/breadcrumb-contributions";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import type { MissingAgentDependency } from "./runtime-install-gate";

/** Approved Extensions §IV.2: only the install gate's missing-dependency reading. */
export function RunStartRefusedPanel({ agentName, missing, requirementsHref, agentsHref, crumbEntries }: {
  agentName: string;
  missing: ReadonlyArray<MissingAgentDependency>;
  /** Already gated by the server's platform-administrator reading. */
  requirementsHref: string | null;
  agentsHref: string;
  crumbEntries: readonly CrumbContribution[];
}) {
  return (
    <Main className="min-h-screen">
      <CrumbContributions entries={crumbEntries} />
      <PageContent className="py-8">
        <Alert variant="destructive" className="flex max-w-[560px] items-start gap-3 border-destructive/[0.34] bg-destructive/[0.06] py-3.5"
          data-conformance-id="agent-start-refused" data-state="error kind:agent">
          <span className="grid size-8 flex-none place-items-center rounded-lg bg-destructive/[0.12] text-destructive">
            <TriangleAlert aria-hidden="true" className="size-[17px]" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="font-sans text-row-title font-semibold text-foreground">{agentName} can&apos;t start</p>
            <p className="mt-1 mb-2.5 text-xs leading-normal text-muted-foreground">
              It requires {missing.map((dependency, index) => (
                <span key={dependency.packageName}>
                  {index > 0 ? ", " : ""}<b>{dependency.displayName?.trim() || dependency.packageName}</b>{" "}
                  <span className="font-mono text-badge-xs text-foreground">{dependency.packageName}</span>
                </span>
              ))}, which {missing.length === 1 ? "is" : "are"} not installed.{" "}
              {requirementsHref
                ? `Install ${missing.length === 1 ? "it" : "them"} from the marketplace, then start the agent again.`
                : `Ask a platform administrator to install ${missing.length === 1 ? "it" : "them"}, then start the agent again.`}
            </p>
            <div className="flex items-center gap-2.5">
              {requirementsHref ? (
                <Button asChild size="sm" className="px-3 text-xs">
                  <Link href={requirementsHref} data-action="view-requirements -> agent-listing-open">View requirements</Link>
                </Button>
              ) : null}
              <Button asChild variant="link" size="sm" className="h-auto p-0 text-xs">
                <Link href={agentsHref} data-action="back-to-agents -> scope-agents-tab">Back to Agents</Link>
              </Button>
            </div>
          </div>
        </Alert>
      </PageContent>
    </Main>
  );
}
