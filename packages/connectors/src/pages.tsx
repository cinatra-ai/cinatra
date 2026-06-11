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
// Readiness comes from the registry's per-connector probes; importing the
// built-in probe module registers them (side effect).
import "@/lib/connector-readiness.server";
import { listConnectorRegistryEntries } from "@/lib/connectors-registry.server";
import { isConnectorVisibleToActor } from "@/lib/connector-policy";

import {
  resolveReadinessFailSoft,
  type ReadinessSnapshot,
} from "./readiness-fail-soft";

type ConnectorsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

// Scope tag per connector slug. Today, connector "scope" is a
// derived attribute of the configuration (user OAuth vs. org-level API key /
// instance list). The map below captures the practical scope each connector
// can be configured at; the scope filter on /connectors restricts the visible
// card set based on this assignment + the actor's accessible scopes.
const SCOPE_BY_SLUG: Record<string, "personal" | "organization"> = {
  "gmail-connector": "personal",
  "google-calendar-connector": "personal",
  "linkedin-connector": "personal",
  "youtube-connector": "personal",
  "google-oauth-connector": "personal",
  // Everything else defaults to organization scope (API keys + instance lists
  // configured at /configuration/llm, /connectors/{drupal,wordpress}, etc.).
};

function scopeForSlug(slug: string): "personal" | "organization" {
  return SCOPE_BY_SLUG[slug] ?? "organization";
}

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

  // Each connector carries two independent scope axes: its credential/config
  // locus (personal user-OAuth vs. organization-level keys) and its visibility
  // tier (admin-only vs. workspace). The normalized shape keeps both so the
  // shared predicate can answer "Personal", "Workspace: Admins only", etc.
  // without collapsing them into one bucket.
  function normalizedScopeForConnector(
    slug: string,
    defaultVisibility: "admin" | "workspace",
  ): NormalizedResourceScope {
    return {
      locus: scopeForSlug(slug) === "personal" ? "personal" : "organization",
      adminOnly: defaultVisibility === "admin",
    };
  }

  // Readiness resolves through each registry entry's probe (registered by the
  // built-in probe module or at runtime); a connector without a probe reports
  // not connected. Probes run only for the cards the actor can see.
  const readinessContext = { userId: session.user?.id ?? null };
  const visibleEntries = listConnectorRegistryEntries()
    .filter((entry) => isConnectorVisibleToActor(entry.packageId, actor))
    .filter((entry) =>
      scopeSelectionMatches(
        effectiveScope,
        normalizedScopeForConnector(entry.slug, entry.defaultVisibility),
      ),
    );
  const cards: ConnectorCardData[] = await Promise.all(
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
