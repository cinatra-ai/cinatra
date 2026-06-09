import {
  getPrimarySavedNangoConnections,
  listSavedNangoConnections,
} from "@cinatra-ai/nango-connector";
import { PageHeader } from "@/components/page-header";
import { PageContent } from "@/components/page-content";
import { getStoredGoogleCalendarAppointments } from "@cinatra-ai/google-calendar-connector";
import {
  requireAuthSession,
  getActorContext,
} from "@/lib/auth-session";
import {
  readOrgsWithTeamsForUser,
  readProjectsForUser,
} from "@/lib/better-auth-db";
import { countExternalMcpOAuthClients } from "@/lib/better-auth-oauth-client";
import { getWordPressAPISettings } from "@/lib/wordpress-api";
import { getDrupalAPISettings } from "@/lib/drupal-api";
import { getGoogleOAuthStatus } from "@cinatra-ai/google-oauth-connection";
import { getApolloAPIStatus } from "@cinatra-ai/apollo-connector";
import { getApifyStatus } from "@cinatra-ai/apify-connector";
import { getTailscaleConnectionStatus } from "@cinatra-ai/tailscale-connector";
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
import { getAnthropicAPIStatus } from "@cinatra-ai/anthropic-connector";
import { getGeminiAPIStatus } from "@cinatra-ai/gemini-connector";
import { getConfiguredOpenAIConnection } from "@cinatra-ai/openai-connector";
import { listConnectorDescriptors } from "@cinatra-ai/connectors-catalog/descriptors.mjs";
import { isConnectorVisibleToActor } from "@/lib/connector-policy";

type ConnectorsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type ReadinessSnapshot = {
  connected: boolean;
  connectedLabel?: string;
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

  const userConnections = getPrimarySavedNangoConnections({
    scope: "user",
    userId: session.user.id,
  });
  const appointmentSchedules = getStoredGoogleCalendarAppointments(session.user.id);

  const [googleOAuthStatus, configuredOpenAIConnection] = await Promise.all([
    getGoogleOAuthStatus(),
    getConfiguredOpenAIConnection(),
  ]);
  const apolloStatus = getApolloAPIStatus();
  const apifyStatus = getApifyStatus();
  const a2aConnectedCount = listSavedNangoConnections("a2aServer").length;
  const wordpressConnectedCount = getWordPressAPISettings().instances.length;
  const drupalConnectedCount = getDrupalAPISettings().instances.length;
  // Inbound MCP-client readiness is a host-owned signal (the Better Auth
  // oauthClient table), so the card needs no import from the extension.
  const mcpClientConnectedCount = await countExternalMcpOAuthClients();
  const tailscaleStatus = getTailscaleConnectionStatus();
  const anthropicStatus = getAnthropicAPIStatus();
  const geminiStatus = getGeminiAPIStatus();

  const appointmentsCount = appointmentSchedules.appointments.length;

  const READINESS_BY_SLUG = new Map<string, ReadinessSnapshot>([
    ["openai-connector", { connected: Boolean(configuredOpenAIConnection?.apiKey) }],
    ["anthropic-connector", { connected: anthropicStatus.status === "connected" }],
    ["gemini-connector", { connected: geminiStatus.status === "connected" }],
    [
      "mcp-client-connector",
      {
        connected: mcpClientConnectedCount > 0,
        connectedLabel: mcpClientConnectedCount > 0 ? `${mcpClientConnectedCount}` : undefined,
      },
    ],
    ["gmail-connector", { connected: Boolean(userConnections.gmail) }],
    [
      "google-calendar-connector",
      {
        connected: Boolean(userConnections.googleCalendar) || appointmentsCount > 0,
        connectedLabel:
          appointmentsCount > 0 ? `${appointmentsCount} appt` : undefined,
      },
    ],
    ["apollo-connector", { connected: apolloStatus.status === "connected" }],
    ["apify-connector", { connected: apifyStatus.status === "connected" }],
    ["linkedin-connector", { connected: Boolean(userConnections.linkedin) }],
    ["youtube-connector", { connected: Boolean(userConnections.youtube) }],
    [
      "wordpress-mcp-connector",
      {
        connected: wordpressConnectedCount > 0,
        connectedLabel:
          wordpressConnectedCount > 0 ? `${wordpressConnectedCount}` : undefined,
      },
    ],
    [
      "drupal-mcp-connector",
      {
        connected: drupalConnectedCount > 0,
        connectedLabel:
          drupalConnectedCount > 0 ? `${drupalConnectedCount}` : undefined,
      },
    ],
    ["tailscale-connector", { connected: tailscaleStatus.connected }],
    ["github-connector", { connected: false }],
    [
      "a2a-server-connector",
      {
        connected: a2aConnectedCount > 0,
        connectedLabel: a2aConnectedCount > 0 ? `${a2aConnectedCount}` : undefined,
      },
    ],
    ["google-oauth-connector", { connected: googleOAuthStatus.status === "connected" }],
  ]);

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

  const cards: ConnectorCardData[] = listConnectorDescriptors()
    .filter((d) => isConnectorVisibleToActor(d.packageId, actor))
    .filter((d) =>
      scopeSelectionMatches(
        effectiveScope,
        normalizedScopeForConnector(d.slug, d.defaultVisibility),
      ),
    )
    .map((d) => {
      const readiness = READINESS_BY_SLUG.get(d.slug) ?? { connected: false };
      // Prefer the extension's own self-describing identity (manifest
      // displayName + sanitized logo data URI) over the static host catalog, so
      // a connector renders its own card. Falls back to the catalog displayName
      // (always present) and, for the logo, to the client icon map when null.
      const manifest = STATIC_EXTENSION_MANIFEST[d.packageId];
      return {
        slug: d.slug,
        name: manifest?.displayName ?? d.displayName,
        logo: manifest?.logo ?? null,
        connected: readiness.connected,
        connectedLabel: readiness.connectedLabel,
        href: `/connectors/cinatra-ai/${d.slug}/setup`,
      };
    });

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
