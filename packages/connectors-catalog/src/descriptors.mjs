// CLI-safe connector descriptors. Plain JS, no imports, no transitive Node-only or
// browser-only deps. Imported by both `packages/cli/` (plain Node, agents-install.mjs)
// and the host server registry (`src/lib/connectors-registry.server.ts`).
//
// Catalog layering: this file holds pure data only. Readiness probes + setup-page
// loaders are attached server-side in the registry, NOT here, so the plain-Node
// CLI importer never pulls in `@/lib/database` and friends.
//
// New connectors require: descriptor here + tsconfig path alias for the setup-page
// subpath + a loader-map entry in `src/lib/connector-setup-pages.ts` + an extension
// package at `extensions/cinatra-ai/<slug>/`. The setup-pages-parity host test fails
// fast if any descriptor lacks a corresponding setup-page loader.

/**
 * @typedef {Object} ConnectorDescriptor
 * @property {string} packageId - npm package id (e.g. `@cinatra-ai/openai-connector`)
 * @property {string} slug - URL slug under `/connectors/cinatra-ai/<slug>/` (matches extension directory name)
 * @property {string} displayName - user-facing label on the /connectors card
 * @property {"admin" | "workspace"} defaultVisibility - default visibility tier seeded by the dev fixture
 * @property {string[]} mcpPrimitivePrefixes - prefix list used by the connectorDependencies backfill (e.g. `["apollo_"]`)
 * @property {string} setupSubroute - dispatch sub-route segment (always `"setup"`; reserved for future use)
 */

// Every catalog entry's packageId equals `@cinatra-ai/<slug>` (the slug is the
// extension directory and workspace-package short name). Renamed entries derive
// their packageId from the slug instead of re-pinning the package-name literal
// in core (instance-coupling gate: a rename must resolve away from the pinned
// literal, not re-pin it under the new name).
const packageIdForSlug = (slug) => `@cinatra-ai/${slug}`;

/** @type {ConnectorDescriptor[]} */
export const CONNECTOR_DESCRIPTORS = [
  {
    packageId: "@cinatra-ai/openai-connector",
    slug: "openai-connector",
    displayName: "OpenAI",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["openai_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/anthropic-connector",
    slug: "anthropic-connector",
    displayName: "Anthropic",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["anthropic_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/gemini-connector",
    slug: "gemini-connector",
    displayName: "Gemini",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["gemini_"],
    setupSubroute: "setup",
  },
  {
    // Inbound MCP-client connector for Claude Desktop, Claude.ai, ChatGPT,
    // and any MCP-compatible client that connects to Cinatra via OAuth.
    packageId: packageIdForSlug("mcp-client-connector"),
    slug: "mcp-client-connector",
    displayName: "MCP Client",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/gmail-connector",
    slug: "gmail-connector",
    displayName: "Gmail",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["gmail_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/google-calendar-connector",
    slug: "google-calendar-connector",
    displayName: "Google Calendar",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["google_calendar_", "appointment_schedule_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/apollo-connector",
    slug: "apollo-connector",
    displayName: "Apollo",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["apollo_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/apify-connector",
    slug: "apify-connector",
    displayName: "Apify",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["apify_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/linkedin-connector",
    slug: "linkedin-connector",
    displayName: "LinkedIn",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["linkedin_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/youtube-connector",
    slug: "youtube-connector",
    displayName: "YouTube",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["youtube_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/wordpress-mcp-connector",
    slug: "wordpress-mcp-connector",
    displayName: "WordPress MCP",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["wordpress_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/drupal-mcp-connector",
    slug: "drupal-mcp-connector",
    displayName: "Drupal MCP",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["drupal_"],
    setupSubroute: "setup",
  },
  {
    // Embeddable assistant chat-widget setup for WordPress (lifted from the
    // retired /configuration/assistants/wordpress-widget admin page).
    packageId: "@cinatra-ai/wordpress-assistant-connector",
    slug: "wordpress-assistant-connector",
    displayName: "WordPress Assistant",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/drupal-assistant-connector",
    slug: "drupal-assistant-connector",
    displayName: "Drupal Assistant",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/tailscale-connector",
    slug: "tailscale-connector",
    displayName: "Tailscale",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["tailscale_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/github-connector",
    slug: "github-connector",
    displayName: "GitHub",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["github_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/a2a-server-connector",
    slug: "a2a-server-connector",
    displayName: "A2A Servers",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["a2a_"],
    setupSubroute: "setup",
  },
  {
    packageId: "@cinatra-ai/google-oauth-connector",
    slug: "google-oauth-connector",
    displayName: "Google",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["google_oauth_"],
    setupSubroute: "setup",
  },
  // twenty-connector is a provider for the provider-agnostic crm-connector
  // facade. Only the provider appears here — crm-connector itself is a
  // facade/dependency, not a setup-discoverable surface.
  {
    packageId: "@cinatra-ai/twenty-connector",
    slug: "twenty-connector",
    displayName: "Twenty CRM",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["crm_", "twenty_"],
    setupSubroute: "setup",
  },
];

/** @returns {ConnectorDescriptor[]} defensive copy */
export function listConnectorDescriptors() {
  return CONNECTOR_DESCRIPTORS.map((d) => ({
    ...d,
    mcpPrimitivePrefixes: [...d.mcpPrimitivePrefixes],
  }));
}

/** @returns {ConnectorDescriptor | undefined} */
export function getConnectorDescriptorByPackageId(packageId) {
  return CONNECTOR_DESCRIPTORS.find((d) => d.packageId === packageId);
}

/** @returns {ConnectorDescriptor | undefined} */
export function getConnectorDescriptorBySlug(slug) {
  return CONNECTOR_DESCRIPTORS.find((d) => d.slug === slug);
}
