// CLI-safe connector descriptors. Plain JS, no imports, no transitive Node-only or
// browser-only deps. Imported by both the @cinatra-ai/cinatra CLI (plain Node, agents-install.mjs)
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
//
// IDENTITY SURFACE (identity-surface ruling, "accept the normal"):
// this file IS the single SANCTIONED hand-maintained slug -> packageId catalog.
// It is classified `mechanical` in
// scripts/audit/lib/extension-reference-classification.mjs (a hand catalog, NOT
// "mechanical at ZERO"): it carries NO concrete extension package-name literal —
// every packageId is DERIVED from its slug via `packageIdForSlug`, so a rename
// resolves away from any pinned literal rather than re-pinning it. The package
// SCOPE (the `@cinatra-ai` org lexeme) is the only org-name reference and is
// hoisted to the single `CONNECTOR_PACKAGE_SCOPE` constant below so it is named
// in exactly one place.

/**
 * @typedef {Object} ConnectorDescriptor
 * @property {string} packageId - npm package id (e.g. `@cinatra-ai/openai-connector`)
 * @property {string} slug - URL slug under `/connectors/cinatra-ai/<slug>/` (matches extension directory name)
 * @property {string} displayName - user-facing label on the /connectors card
 * @property {"admin" | "workspace"} defaultVisibility - default visibility tier seeded by the dev fixture
 * @property {string[]} mcpPrimitivePrefixes - prefix list used by the connectorDependencies backfill (e.g. `["apollo_"]`)
 * @property {string} setupSubroute - dispatch sub-route segment (always `"setup"`; reserved for future use)
 */

// The single org-scope lexeme for first-party connector packages. Named in ONE
// place (identity-surface decoupling) so the `@cinatra-ai`
// org name is not re-spelled across every derivation; a scope rename touches this
// constant only.
export const CONNECTOR_PACKAGE_SCOPE = "@cinatra-ai";

// Every catalog entry's packageId equals `<scope>/<slug>` (the slug is the
// extension directory and workspace-package short name), so packageIds are
// DERIVED from the slug for every entry — the catalog pins no package-name
// literal in core (cinatra#35 / IOC-44; instance-coupling gate). A
// rename must resolve away from the pinned literal, not re-pin it under the
// new name.
export const packageIdForSlug = (slug) => `${CONNECTOR_PACKAGE_SCOPE}/${slug}`;

/** @type {Omit<ConnectorDescriptor, "packageId">[]} */
const RAW_DESCRIPTORS = [
  {
    slug: "openai-connector",
    displayName: "OpenAI",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["openai_"],
    setupSubroute: "setup",
  },
  {
    slug: "anthropic-connector",
    displayName: "Anthropic",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["anthropic_"],
    setupSubroute: "setup",
  },
  {
    slug: "gemini-connector",
    displayName: "Gemini",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["gemini_"],
    setupSubroute: "setup",
  },
  {
    // Inbound MCP-client connector for Claude Desktop, Claude.ai, ChatGPT,
    // and any MCP-compatible client that connects to Cinatra via OAuth.
    slug: "mcp-client-connector",
    displayName: "MCP Clients",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    slug: "gmail-connector",
    displayName: "Gmail",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["gmail_"],
    setupSubroute: "setup",
  },
  {
    slug: "google-calendar-connector",
    displayName: "Google Calendar",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["google_calendar_", "appointment_schedule_"],
    setupSubroute: "setup",
  },
  {
    slug: "apollo-connector",
    displayName: "Apollo",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["apollo_"],
    setupSubroute: "setup",
  },
  {
    slug: "apify-connector",
    displayName: "Apify",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["apify_"],
    setupSubroute: "setup",
  },
  {
    slug: "linkedin-connector",
    displayName: "LinkedIn",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["linkedin_"],
    setupSubroute: "setup",
  },
  {
    slug: "youtube-connector",
    displayName: "YouTube",
    defaultVisibility: "workspace",
    mcpPrimitivePrefixes: ["youtube_"],
    setupSubroute: "setup",
  },
  {
    slug: "wordpress-mcp-connector",
    displayName: "WordPress MCP",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["wordpress_"],
    setupSubroute: "setup",
  },
  {
    slug: "drupal-mcp-connector",
    displayName: "Drupal MCP",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["drupal_"],
    setupSubroute: "setup",
  },
  {
    // Embeddable assistant chat-widget setup for WordPress (lifted from the
    // retired /configuration/assistants/wordpress-widget admin page).
    slug: "wordpress-assistant-connector",
    displayName: "WordPress Assistant",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    slug: "drupal-assistant-connector",
    displayName: "Drupal Assistant",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    slug: "tailscale-connector",
    displayName: "Tailscale",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["tailscale_"],
    setupSubroute: "setup",
  },
  {
    slug: "github-connector",
    displayName: "GitHub",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["github_"],
    setupSubroute: "setup",
  },
  {
    slug: "a2a-server-connector",
    displayName: "A2A Servers",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["a2a_"],
    setupSubroute: "setup",
  },
  {
    slug: "google-oauth-connector",
    displayName: "Google",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["google_oauth_"],
    setupSubroute: "setup",
  },
  // LinkedIn OAuth app credentials (the admin half of the LinkedIn connector
  // split — cinatra-ai/linkedin-connector#9). Mirrors google-oauth-connector:
  // an admin-visibility setup page that owns the Client ID / secret form and
  // exposes NO MCP primitives (the per-user connect + publish primitives stay
  // on @cinatra-ai/linkedin-connector).
  {
    slug: "linkedin-oauth-connector",
    displayName: "LinkedIn OAuth",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  // twenty-connector is a provider for the provider-agnostic crm-connector
  // facade. Only the provider appears here — crm-connector itself is a
  // facade/dependency, not a setup-discoverable surface.
  {
    slug: "twenty-connector",
    displayName: "Twenty CRM",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["crm_", "twenty_"],
    setupSubroute: "setup",
  },
  // plane-connector is a provider for the provider-agnostic pm-connector
  // (project-management) facade — the schedule↔PM-task mirror (cinatra#317).
  // Only the provider appears here; the pm-connector facade is a
  // dependency, not a setup-discoverable surface (same shape as twenty-connector
  // above).
  {
    slug: "plane-connector",
    displayName: "Plane",
    defaultVisibility: "admin",
    mcpPrimitivePrefixes: ["plane_"],
    setupSubroute: "setup",
  },
];

/**
 * The public catalog: RAW entries + the slug-derived packageId. Derivation is
 * BY CONSTRUCTION (no entry can carry a hand-pinned package-name literal):
 * the derived packageId is assigned AFTER the spread, so a raw entry can
 * never override it.
 * @type {ConnectorDescriptor[]}
 */
export const CONNECTOR_DESCRIPTORS = RAW_DESCRIPTORS.map((d) => ({
  ...d,
  packageId: packageIdForSlug(d.slug),
}));

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
