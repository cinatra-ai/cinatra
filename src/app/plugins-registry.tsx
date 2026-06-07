import type { ReactNode } from "react";
import { notFound, redirect } from "next/navigation";

export type APIPluginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type APIPluginPageComponent = (props: APIPluginPageProps) => ReactNode | Promise<ReactNode>;

export async function getAPIPluginPage(slug: string): Promise<APIPluginPageComponent | null> {
  switch (slug) {
    // /configuration/llm/apify has no standalone route; the canonical Apify
    // settings UI is the full-page route at /connectors/apify. Without a modal
    // slug, the dispatcher falls through to notFound() instead of redirecting
    // to a ?modal=apify query that nothing renders.
    case "apollo":
      return (await import("@cinatra-ai/apollo-connector/settings-page")).ApolloSettingsPage;
    case "claude":
      // anthropic-connector is un-exempt: its settings-page consumes the
      // host-injected deps slot + sdk-ui, and the canonical setup UI is the GENERIC
      // connector dispatch route. This legacy /configuration/llm mount redirects
      // there so core no longer statically imports the connector (IoC — same pattern
      // as github/wordpress/drupal). The target is a public route URL, not an import.
      return async () => {
        redirect("/connectors/cinatra-ai/anthropic-connector/setup");
      };
    // Gemini settings are rendered as an in-page modal on /configuration/llm.
    // The standalone connector settings page is not part of this registry.
    case "github":
      // GitHub's settings-page consumes a host-injected `ctx` (ctx.nango,
      // SDK-only decouple). It renders through the GENERIC connector
      // dispatch route (`/connectors/[vendor]/[slug]/[subroute]`), which builds
      // the grant-aware host ctx + applies the connector-policy gate without core
      // naming the connector. This legacy /configuration/llm mount redirects there
      // so core no longer statically imports the connector (IoC — core-extension
      // import/instance-coupling gates). The redirect target is a public route URL
      // (slug), not a package import. (Same pattern as wordpress/drupal below.)
      return async () => {
        redirect("/connectors/cinatra-ai/github-connector/setup");
      };
    case "gmail":
      // The Google OAuth client credentials (shared by Gmail + Google Calendar)
      // are OWNED by the google-oauth-connector, whose setup-page renders
      // through the GENERIC connector dispatch route — it builds the grant-aware
      // host ctx and applies the connector-policy `read` gate for render
      // (google-oauth is defaultVisibility:"admin"); the credential WRITE is
      // separately `manage`-gated (requireExtensionAction first-statement in the
      // connector's save action) and the client SECRET is write-only (never sent
      // to the browser). This legacy /configuration/llm mount rendered the host
      // package's ungated settings form (saveGmailConnectionAction had no authz
      // gate at all); redirecting here retires that lower-privilege reach-around.
      // (Same pattern as github/wordpress/drupal.) The target is a public route
      // URL (slug), not a package import.
      return async () => {
        redirect("/connectors/cinatra-ai/google-oauth-connector/setup");
      };
    case "linkedin":
      return (await import("@cinatra-ai/linkedin-connector/settings-page")).LinkedInSettingsPage;
    case "openai":
      return (await import("@cinatra-ai/openai-connector/settings-page")).OpenAISettingsPage;
    case "openai-skills":
      return (await import("@cinatra-ai/openai-connector/openai-skills-settings-page")).OpenAIAPISkillsSettingsPage;
    case "wordpress":
      // The WordPress + Drupal connector settings now render through the GENERIC
      // connector dispatch route (`/connectors/[vendor]/[slug]/[subroute]`),
      // which builds the grant-aware host ctx + applies the connector-policy gate
      // without core naming the connector. These legacy /configuration/llm mounts
      // redirect there so cinatra core no longer statically imports/names the
      // connector (IoC — core-extension instance-coupling gate). The redirect
      // target is a public route URL (slug), not a package import.
      return async () => {
        redirect("/connectors/cinatra-ai/wordpress-mcp-connector/setup");
      };
    case "drupal":
      return async () => {
        redirect("/connectors/cinatra-ai/drupal-mcp-connector/setup");
      };
    case "youtube": {
      // YouTube's settings-page consumes a host-injected `ctx` (the
      // host-port mechanism); this legacy /configuration/llm/youtube path
      // builds the same grant-aware ctx the dispatch route does so both
      // mounts behave identically — AND applies the same connector-policy
      // gate so non-admins can't reach the page if YouTube's policy ever
      // becomes admin-only.
      const { YouTubeSettingsPage } = await import("@cinatra-ai/youtube-connector/settings-page");
      const { createExtensionHostContext } = await import("@/lib/extension-host-context");
      const { STATIC_EXTENSION_MANIFEST } = await import("@/lib/generated/extensions.server");
      const { getActorContext } = await import("@/lib/auth-session");
      const { enforceConnectorPolicy } = await import("@/lib/connector-policy");
      const PACKAGE_ID = "@cinatra-ai/youtube-connector";
      return async (props: APIPluginPageProps) => {
        const actor = await getActorContext();
        const decision = enforceConnectorPolicy(PACKAGE_ID, actor, "read");
        if (!decision.allowed) {
          notFound();
        }
        const ctx = createExtensionHostContext(
          PACKAGE_ID,
          STATIC_EXTENSION_MANIFEST[PACKAGE_ID]?.requestedHostPorts ?? [],
        );
        return YouTubeSettingsPage({ searchParams: props.searchParams, ctx });
      };
    }
    default:
      return null;
  }
}

export async function renderAPIPluginPage(slug: string, props: APIPluginPageProps) {
  // Slugs that render as inline modals on /configuration/llm redirect old standalone routes.
  const modalSlugs: Record<string, string> = {
    claude: "anthropic",
    // Gemini is a cinatra-native in-page modal. The standalone
    // /configuration/llm/gemini URL redirects here.
    gemini: "gemini",
    // NOTE: gmail is deliberately NOT a modal slug — it flows through
    // getAPIPluginPage("gmail"), whose `case "gmail"` redirects to the
    // google-oauth-connector dispatch route (the Google OAuth client credentials
    // are owned there). Same as github/drupal. Listing it
    // here would short-circuit to an inert `?modal=gmail` that nothing renders.
    linkedin: "linkedin",
    openai: "openai",
    wordpress: "wordpress",
  };
  if (modalSlugs[slug]) {
    redirect(`/configuration/llm?modal=${modalSlugs[slug]}`);
  }

  const Page = await getAPIPluginPage(slug);

  if (!Page) {
    notFound();
  }

  return <Page {...props} />;
}

export async function getAgentPluginScreens(agentId: string) {
  // Dynamic fallback to agent-builder compiled templates, keyed by slug.
  // Visibility is enforced inside readAgentTemplateBySlug: the caller passes the actor.
  const { readAgentTemplateBySlug } = await import("@cinatra-ai/agents");
  const { getAuthSession } = await import("@/lib/auth-session");
  const session = await getAuthSession();
  const template = await readAgentTemplateBySlug(agentId, {
    actorUserId: session?.user?.id ?? null,
    includeNonPublished: true,
  });
  if (!template) return null;
  const screens = (await import("@cinatra-ai/agents")).agentPluginScreens;
  // Marker so consumers can detect dynamic-template screens without a hardcoded allowlist.
  return Object.assign({}, screens, { __isDynamicBuilderScreens: true as const });
}

// Package-name-based screen lookup for /agents/{vendor}/{packageName}/... routes.
// Accepts the full scoped package name (e.g. "@cinatra-ai/email-outreach-agent") and looks up
// the installed agent template by package_name, then returns agentPluginScreens from agent-builder.
export async function getAgentPluginScreensByPackageName(packageName: string) {
  const { readAgentTemplateBySlug } = await import("@cinatra-ai/agents");
  const { getAuthSession } = await import("@/lib/auth-session");
  const session = await getAuthSession();
  // Strip leading '@' and pass vendor/name; readAgentTemplateBySlug detects '/'
  // and prepends '@' for the package_name DB lookup.
  const slugArg = packageName.startsWith("@") ? packageName.slice(1) : packageName;
  const template = await readAgentTemplateBySlug(slugArg, {
    actorUserId: session?.user?.id ?? null,
    includeNonPublished: true,
  });
  if (!template) return null;
  const screens = (await import("@cinatra-ai/agents")).agentPluginScreens;
  return Object.assign({}, screens, { __isDynamicBuilderScreens: true as const });
}

// Route resolver fallback: PURE DB READ. When no local template matches the
// packageName, look up `agent_templates` by the composite
// (connector_slug, remote_agent_id) key. If a row exists for an external
// template persisted by the dispatch-time upsert, return screens. Otherwise
// return null so the caller can notFound().
//
// This resolver NEVER fetches external agent cards and NEVER mutates the
// database. Discovery of new external agents happens at dispatch time through
// the external branch of sendAgentBuilderMessage, or via an explicit admin
// sync flow.
//
// Arg shape: `agentId` = "{vendor}/{packageName}" (no leading '@').
export async function resolveAgentScreensWithA2AFallback(agentId: string) {
  // Primary path for internal templates.
  const screens = await getAgentPluginScreensByPackageName(`@${agentId}`);
  if (screens) return screens;

  // Fallback — composite-key lookup in agent_templates.
  const parts = agentId.split("/");
  if (parts.length !== 2) return null;
  const [connectorSlug, remoteAgentId] = parts;
  if (!connectorSlug || !remoteAgentId) return null;

  const { readAgentTemplateByConnectorAndRemoteId } = await import("@cinatra-ai/agents");
  const template = await readAgentTemplateByConnectorAndRemoteId(connectorSlug, remoteAgentId);
  if (!template) return null; // No persisted row → 404 (caller handles)

  // Row exists → resolve screens by the template's stored packageName. The
  // template is persisted by sendAgentBuilderMessage's external branch at
  // first-dispatch time.
  if (!template.packageName) return null;
  return getAgentPluginScreensByPackageName(template.packageName);
}

export async function requireAgentPluginScreens(agentId: string) {
  const screens = await getAgentPluginScreens(agentId);
  if (!screens) {
    notFound();
  }
  return screens;
}

export async function getSkillsPluginPages() {
  return (await import("@cinatra-ai/skills/pages")).skillsPluginPages;
}

export async function requireSkillsPluginPages() {
  const pages = await getSkillsPluginPages();
  if (!pages) {
    notFound();
  }
  return pages;
}
