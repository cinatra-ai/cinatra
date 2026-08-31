import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import {
  SCOPE_SURFACE_KIND_LABEL,
  SCOPE_SURFACE_TAB_LABEL,
  scopeSurfaceEmptyTestId,
  scopeSurfaceSettingsHref,
  scopeSurfaceTabHrefs,
  type ScopeSurfaceRef,
  type ScopeSurfaceTab,
} from "@/lib/scope-surfaces";

/**
 * The shared shell every scope tab renders (cinatra#2807, per-scope surfaces
 * S1): the page chrome, the five-tab strip pointed at THIS scope, and the tab's
 * named empty-state surface.
 *
 * S1 reads nothing about the scope. The strip and the empty state are built
 * from the scope REFERENCE the route already carries, so the shell discloses
 * nothing an unauthorized viewer could not already read off the address bar —
 * which is why the header names the tab and the scope KIND rather than the
 * entity. The tabs' contents (and, with them, the per-scope reads and the
 * entity-named header) arrive with the slices that own them: the Assistants and
 * Agents lists with #2808, Artifacts and Skills with #2810, and the workspace
 * dashboards with #2811.
 */

/**
 * The shell states its OWN condition. It reads nothing about the scope, so it
 * can never say the scope holds nothing — a viewer with assistants, agents,
 * artifacts or skills in this scope would be told a falsehood.
 */
const PLACEHOLDER_TITLE = "This tab is not ready yet";

/** Honest placeholder copy — what the tab WILL list, never a claim of empty data. */
const TAB_PROMISE: Record<ScopeSurfaceTab | "dashboards", string> = {
  dashboards: "The dashboards of this scope appear here.",
  assistants: "The assistants reachable in this scope appear here, each with its Chat button.",
  agents: "The agents reachable in this scope appear here, each with its Run button.",
  artifacts: "The artifacts this scope owns appear here.",
  skills: "The skills this scope owns appear here.",
};

export function ScopeSurfacePage({
  scope,
  tab,
  title,
  description,
}: {
  scope: ScopeSurfaceRef;
  tab: ScopeSurfaceTab | "dashboards";
  /** Overrides the default page title (the tab name). */
  title?: string;
  description?: string;
}) {
  const hrefs = scopeSurfaceTabHrefs(scope);
  const settingsHref = scopeSurfaceSettingsHref(scope);

  return (
    <Main className="min-h-screen">
      <PageHeader
        label={SCOPE_SURFACE_KIND_LABEL[scope.kind]}
        title={title ?? SCOPE_SURFACE_TAB_LABEL[tab]}
        description={description}
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <EntityScopeTabs {...hrefs} settingsHref={settingsHref} active={tab} />
        <Empty data-testid={scopeSurfaceEmptyTestId(tab)} className="border">
          <EmptyHeader>
            <EmptyTitle>{PLACEHOLDER_TITLE}</EmptyTitle>
            <EmptyDescription>{TAB_PROMISE[tab]}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </PageContent>
    </Main>
  );
}
