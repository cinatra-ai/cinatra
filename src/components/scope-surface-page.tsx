import Link from "next/link";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Button } from "@/components/ui/button";
import { domainIcons, type DomainIcon } from "@/components/domain-icons";
import { ScopeDashboardsTab } from "@/components/dashboards/scope-dashboards-tab";
import { CrumbContributions } from "@/components/crumb-contributions";
import { EntityScopeTabs } from "@/components/entity-scope-tabs";
import { Main } from "@/components/layout/main";
import { PageContent } from "@/components/page-content";
import { PageHeader } from "@/components/page-header";
import {
  SCOPE_SURFACE_ENTITY_FALLBACK,
  SCOPE_SURFACE_KIND_LABEL,
  SCOPE_SURFACE_TAB_ACTION,
  scopeSurfaceCrumbEntries,
  scopeSurfaceEmptyTestId,
  scopeSurfaceSettingsHref,
  scopeSurfaceTabHrefs,
  type ScopeSurfaceRef,
  type ScopeSurfaceTab,
} from "@/lib/scope-surfaces";

/**
 * The shared shell every scope tab renders (cinatra#2807, per-scope surfaces
 * S1): the page chrome, the five-tab strip pointed at THIS scope, and the tab's
 * own body.
 *
 * The header names the ENTITY, never the tab. The ratified drawing makes a
 * scope page an entity page — "The page's heading reads Workspace, and the page
 * is an entity page" — and the four scoped tabs are tabs OF that page, so the
 * heading keeps naming the entity while the strip carries the tab's own name.
 * The route resolves that name through its own gated read and hands it in; where
 * a reader may not be told it, the header falls back to the scope's kind noun.
 *
 * The tabs' CONTENTS still arrive with the slices that own them: the Assistants
 * and Agents lists with #2808, Artifacts and Skills with #2810, and the
 * workspace dashboards with #2811.
 */

/**
 * The shell states its OWN condition. It reads nothing about the scope, so it
 * can never say the scope holds nothing — a viewer with assistants, agents,
 * artifacts or skills in this scope would be told a falsehood.
 */
const PLACEHOLDER_TITLE = "This tab is not ready yet";

/** Honest placeholder copy — what the tab WILL list, never a claim of empty data. */
const TAB_PROMISE: Record<ScopeSurfaceTab, string> = {
  assistants: "The assistants reachable in this scope appear here, each with its Chat button.",
  agents: "The agents reachable in this scope appear here, each with its Run button.",
  artifacts: "The artifacts this scope owns appear here.",
  skills: "The skills this scope owns appear here.",
};

/**
 * The empty state's icon, taken from the app's OWN domain-icon vocabulary — the
 * same mark the sidebar draws for that domain, set in the Empty pattern's
 * dashed circle (`EmptyMedia variant="icon"`).
 */
const TAB_ICON: Record<ScopeSurfaceTab, DomainIcon> = {
  assistants: domainIcons.assistants,
  agents: domainIcons.agents,
  artifacts: domainIcons.artifacts,
  skills: domainIcons.skills,
};

/**
 * The entity the drawn caption names — "The dashboards in <b>Team: Growth</b>."
 * The workspace names itself; the three id-bearing scopes are named
 * "<Kind>: <Name>" exactly as the drawing's own example names them, and fall
 * back to the kind alone where the reader may not be told the name.
 */
function dashboardsCaptionEntity(
  scope: ScopeSurfaceRef,
  title: string | undefined,
): string {
  if (scope.kind === "workspace") return SCOPE_SURFACE_ENTITY_FALLBACK.workspace;
  const kind = SCOPE_SURFACE_KIND_LABEL[scope.kind];
  return title ? `${kind}: ${title}` : kind;
}

export function ScopeSurfacePage({
  scope,
  tab,
  title,
  description,
}: {
  scope: ScopeSurfaceRef;
  tab: ScopeSurfaceTab | "dashboards";
  /**
   * The entity's own name, resolved by the route through its gated read.
   * Omitted where the reader may not be told it — the header then falls back to
   * the scope's kind noun, never to the tab's name and never to a raw id.
   */
  title?: string;
  description?: string;
}) {
  const hrefs = scopeSurfaceTabHrefs(scope);
  const settingsHref = scopeSurfaceSettingsHref(scope);

  return (
    <Main className="min-h-screen">
      {/* Post-gate crumb publisher: the route resolved the name behind the
          entity's own read gate before rendering this shell. */}
      <CrumbContributions entries={scopeSurfaceCrumbEntries(scope, tab, title)} />
      <PageHeader
        label={SCOPE_SURFACE_KIND_LABEL[scope.kind]}
        title={title ?? SCOPE_SURFACE_ENTITY_FALLBACK[scope.kind]}
        description={description}
        divider={false}
      />
      <PageContent className="flex flex-col gap-6 pb-8">
        <EntityScopeTabs {...hrefs} settingsHref={settingsHref} active={tab} />
        {tab === "dashboards" ? (
          <DashboardsTabBody scope={scope} title={title} />
        ) : (
          <ScopedTabEmpty tab={tab} />
        )}
      </PageContent>
    </Main>
  );
}

/**
 * The Dashboards tab's body, as the drawing gives it for a scope that carries
 * no Add.
 *
 * The Workspace section sends this body straight to the Dashboards tab section
 * — "The body below the strip is the ordinary entity-page body of that same
 * section" — and that section rules that "a personal user scope and the
 * whole-workspace scope are not add-to-scope targets — they carry no Add". So
 * this renders that section's own body: the drawn muted caption naming the
 * entity, the row list, and — until the workspace's own dashboards reader lands
 * with its slice (#2811) — that section's own empty reading, with no Add
 * anywhere and no page-wide dashed frame ("The panel sits inside the tab body:
 * no bespoke panel, and no page-wide dashed frame").
 */
function DashboardsTabBody({
  scope,
  title,
}: {
  scope: ScopeSurfaceRef;
  title?: string;
}) {
  return (
    <ScopeDashboardsTab
      data={{ scopeKind: scope.kind, rows: [], canManage: false }}
      caption={{
        kind: "entity",
        entityLabel: dashboardsCaptionEntity(scope, title),
      }}
    />
  );
}

/**
 * One of the four scoped tabs holding nothing to list. The drawing binds those
 * four by name to the shared Empty state — "it reads as the Empty state of
 * Components and nothing else — that pattern at its own values" — carrying "a
 * single primary action button — never just empty text", inside the tab body
 * with "no bespoke panel, and no page-wide dashed frame".
 */
function ScopedTabEmpty({ tab }: { tab: ScopeSurfaceTab }) {
  const TabIcon = TAB_ICON[tab];
  const action = SCOPE_SURFACE_TAB_ACTION[tab];
  return (
    <Empty data-testid={scopeSurfaceEmptyTestId(tab)}>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <TabIcon aria-hidden />
        </EmptyMedia>
        <EmptyTitle>{PLACEHOLDER_TITLE}</EmptyTitle>
        <EmptyDescription>{TAB_PROMISE[tab]}</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button asChild>
          <Link href={action.href}>{action.label}</Link>
        </Button>
      </EmptyContent>
    </Empty>
  );
}
