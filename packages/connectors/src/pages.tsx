import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import {
  requireAuthSession,
  getActorContext,
} from "@/lib/auth-session";
import {
  readOrgsWithTeamsForUser,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { STATIC_EXTENSION_MANIFEST } from "@/lib/generated/extensions.server";
import { Main } from "@/components/layout/main";
import {
  ConnectorsClient,
  type ConnectorCardData,
} from "./connectors-client";
import type { AvailableScopes } from "@/components/access-scope";
import {
  DEFAULT_SCOPE_TOKEN,
  scopeSelectionMatches,
  type NormalizedResourceScope,
} from "@/lib/scope-filter";
import { buildConnectionScopeEntries } from "@/lib/connection-scope-entries";
import { listNangoConnectionsForScopeFilter } from "@cinatra-ai/extensions/connection-identity-store";
import { readExtensionAccessPolicies } from "@cinatra-ai/extensions/permissions-store";
// Readiness comes from the registry's per-connector probes; importing the
// built-in probe module registers them (side effect).
import "@/lib/connector-readiness.server";
import {
  listConnectorRegistryEntries,
} from "@/lib/connectors-registry.server";
import {
  resolveInstalledCatalogConnectorIds,
  listRuntimeOnlyConnectorCards,
} from "@/lib/installed-connectors.server";
import { isConnectorVisibleToActor } from "@/lib/connector-policy";
import { connectorCatalogDefaultVisibility } from "@/lib/connector-access-config-host";

import {
  resolveReadinessFailSoft,
  type ReadinessSnapshot,
} from "./readiness-fail-soft";

type ConnectorsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// cinatra#953 (W3): the scope filter matches REAL granted connections — the
// actor-visible `nango_connection` identity rows and their per-connection
// grant rows — via `buildConnectionScopeEntries` (the former hardcoded
// per-slug pseudo-scope map is deleted): Team/Project/Org selections
// genuinely narrow to connections granted to that concrete locus, and
// Personal shows the actor's own connections.

export async function ConnectorsPage({ searchParams }: ConnectorsPageProps) {
  const session = await requireAuthSession();
  const actor = await getActorContext();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const scopeRaw = resolvedSearchParams?.scope;
  const requestedScope =
    typeof scopeRaw === "string" ? scopeRaw : Array.isArray(scopeRaw) ? scopeRaw[0] : undefined;

  // Build the actor's accessible scopes (organizations they belong to,
  // projects they can read). Used to populate the scope-filter Select.
  const actorUserId = session.user?.id ?? null;
  const orgs = actorUserId ? await readOrgsWithTeamsForUser(actorUserId) : [];
  const activeOrgId = session.session?.activeOrganizationId ?? null;
  const projects =
    actorUserId && activeOrgId ? await readProjectsForUser(actorUserId, activeOrgId) : [];

  // The scope picker shares the hierarchical access combobox with the
  // agent-run permissions page. As a FILTER (not a grant), "Workspace: All"
  // is available to everyone — server-side visibility (isConnectorVisibleToActor)
  // still bounds what each actor can see — so canGrantWorkspace is always true.
  const scopes: AvailableScopes = {
    orgs: orgs.map((org) => ({
      id: org.id,
      name: org.name,
      teams: org.teams.map((t) => ({ id: t.id, name: t.name })),
    })),
    projects: projects.map((p) => ({ id: p.id, name: p.name })),
    canGrantWorkspace: true,
  };

  // The scope tokens the actor may select. "personal" / "workspace" / "admin"
  // are always selectable filters; org / team / project tokens are gated to the
  // actor's memberships. Unknown / inaccessible tokens collapse to the default
  // ("workspace" = the broadest view) — never honor a scope the actor can't see.
  const accessibleScopeTokens = new Set<string>(["personal", "workspace", "admin"]);
  for (const org of orgs) {
    accessibleScopeTokens.add(`org:${org.id}`);
    for (const team of org.teams) accessibleScopeTokens.add(`team:${team.id}`);
  }
  for (const project of projects) accessibleScopeTokens.add(`project:${project.id}`);
  const effectiveScope =
    requestedScope && accessibleScopeTokens.has(requestedScope)
      ? requestedScope
      : DEFAULT_SCOPE_TOKEN;

  // REAL granted-connection entries (cinatra#953 W3): one batched identity
  // read (the actor's org's rows + the actor's OWN rows — foreign null-org
  // rows are excluded fail-closed) + one batched grant read, folded into
  // per-connector NormalizedResourceScope entries. Each card also keeps its
  // visibility-tier axis (admin-only cards match the Admin filter), derived
  // from the connector's shipped cinatra/config.json (cinatra#955 — the
  // legacy hand-catalog tier is deleted).
  const connectionRows = actorUserId
    ? await listNangoConnectionsForScopeFilter(activeOrgId, actorUserId)
    : [];
  const connectionPolicies = await readExtensionAccessPolicies(
    "connection",
    connectionRows.map((row) => row.id),
  );
  const scopeEntriesByPackage = buildConnectionScopeEntries(
    connectionRows,
    connectionPolicies,
    actorUserId,
  );
  function connectorScopeEntries(packageId: string): NormalizedResourceScope[] {
    const entries = scopeEntriesByPackage.get(packageId) ?? [];
    return connectorCatalogDefaultVisibility(packageId) === "admin"
      ? [...entries, { locus: "workspace", adminOnly: true }]
      : entries;
  }

  // Readiness resolves through each registry entry's probe (registered by the
  // built-in probe module or at runtime); a connector without a probe reports
  // not connected. Probes run only for the cards the actor can see.
  const readinessContext = { userId: session.user?.id ?? null };
  // cinatra#658 (F1): the card filter is now RUNTIME-SOURCED (the #657 payoff).
  // A catalog connector is shown iff it is "installed" for THIS actor — a live
  // (active|locked) addressable canonical `installed_extension` row OR (no
  // addressable row AND bundled in the image). So a runtime-installed catalog
  // connector becomes visible without a rebuild, and an operator-ARCHIVED bundled
  // connector disappears. The actor-scoped installed set is pre-resolved in ONE
  // batched canonical read (vs. one read per card), then the sync filter keys off
  // it (fail-closed for runtime rows + store outage; bundled fallback only for a
  // bundled built-in that legitimately has no row — CG-1).
  const catalogEntries = listConnectorRegistryEntries();
  const installedCatalogIds = await resolveInstalledCatalogConnectorIds(
    catalogEntries.map((entry) => entry.packageId),
    actor,
  );
  const visibleEntries = catalogEntries
    .filter((entry) => installedCatalogIds.has(entry.packageId))
    .filter((entry) => isConnectorVisibleToActor(entry.packageId, actor))
    .filter(
      (entry) =>
        effectiveScope === DEFAULT_SCOPE_TOKEN ||
        connectorScopeEntries(entry.packageId).some(
          (scopeEntry) => scopeSelectionMatches(effectiveScope, scopeEntry),
        ),
    );
  // Runtime-ONLY connectors (installed at runtime, NO build-time catalog
  // descriptor) — resolved behind the full trust gate (anchor → integrity →
  // signature → trust). Their card metadata is sourced from the TRUSTED
  // materialized manifest; route vendor/slug are derived from the package name.
  const runtimeOnlyCards = await listRuntimeOnlyConnectorCards(actor);
  const catalogCards: ConnectorCardData[] = await Promise.all(
    visibleEntries.map(async (entry) => {
      // FAIL-SOFT per connector (cinatra#110): one throwing probe degrades its
      // own card to "not connected" instead of 500-ing the whole index.
      const readiness: ReadinessSnapshot = await resolveReadinessFailSoft(entry.slug, () =>
        entry.readinessProbe(readinessContext),
      );
      // Prefer the extension's own self-describing identity (manifest
      // displayName + sanitized logo data URI) over the static host catalog, so
      // a connector renders its own card. Falls back to the catalog displayName
      // (always present) and, for the logo, to the client icon map when null.
      const manifest = STATIC_EXTENSION_MANIFEST[entry.packageId];
      return {
        slug: entry.slug,
        name: manifest?.displayName ?? entry.displayName,
        logo: manifest?.logo ?? null,
        connected: readiness.connected,
        connectedLabel: readiness.connectedLabel,
        href: entry.setupHref,
      };
    }),
  );
  // Runtime-only cards: their setup href is the dispatch route derived from the
  // trusted package-name identity. Readiness is "not connected" (no catalog
  // readiness probe exists for a non-catalog connector).
  const runtimeOnlyCardData: ConnectorCardData[] = runtimeOnlyCards.map((card) => ({
    slug: card.slug,
    name: card.displayName,
    logo: card.logo,
    connected: false,
    href: `/connectors/${card.vendor}/${card.slug}/setup`,
  }));
  const cards: ConnectorCardData[] = [...catalogCards, ...runtimeOnlyCardData];

  return (
    <Main className="min-h-screen">
      <PageHeader
        title="Connectors"
        description="Here's a list of your connected services and tools."
        divider={false}
      />
      <PageContent>
        <ConnectorsClient cards={cards} scopeValue={effectiveScope} scopes={scopes} />
      </PageContent>
    </Main>
  );
}
