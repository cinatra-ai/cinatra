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
 * @property {string[]} mcpPrimitivePrefixes - prefix list used by the connectorDependencies backfill (e.g. `["apollo_"]`)
 * @property {string} setupSubroute - dispatch sub-route segment (always `"setup"`; reserved for future use)
 * @property {string} [consumesConnectionFrom] - the SLUG of the connector whose
 *   connection gates this one, for a connector that holds NO connection of its
 *   own (cinatra#3108). Omitted — the normal case — means the connector is
 *   judged on its own connection. A connector that can never own a connection
 *   row is otherwise unconnected for every person forever, so this declaration
 *   is what lets the host judge it on the connection it actually uses. The host
 *   reads the declaration generically: no connector is named in host code.
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
    mcpPrimitivePrefixes: ["openai_"],
    setupSubroute: "setup",
  },
  {
    slug: "anthropic-connector",
    displayName: "Anthropic",
    mcpPrimitivePrefixes: ["anthropic_"],
    setupSubroute: "setup",
  },
  {
    slug: "gemini-connector",
    displayName: "Gemini",
    mcpPrimitivePrefixes: ["gemini_"],
    setupSubroute: "setup",
  },
  {
    // Inbound MCP-client connector for Claude Desktop, Claude.ai, ChatGPT,
    // and any MCP-compatible client that connects to Cinatra via OAuth.
    slug: "mcp-client-connector",
    displayName: "MCP Clients",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    slug: "gmail-connector",
    displayName: "Gmail",
    mcpPrimitivePrefixes: ["gmail_"],
    setupSubroute: "setup",
  },
  {
    slug: "google-calendar-connector",
    displayName: "Google Calendar",
    mcpPrimitivePrefixes: ["google_calendar_"],
    setupSubroute: "setup",
  },
  {
    // Appointment schedules are their own connector since cinatra#2367: the
    // `appointment_schedule_` prefix MOVED off the google-calendar entry above
    // (one owner per primitive name). This connector declares a REQUIRED
    // runtime dependency on google-calendar-connector, so installing it pulls
    // the calendar connector in dependency-first.
    //
    // IT HOLDS NO CONNECTION OF ITS OWN (cinatra#3108). It books against the
    // calendar connector's Google connection (its runtime resolves the
    // `googleCalendar` connection slot) and writes no connection row under its
    // own package id, and it publishes no connect field either — so judged on a
    // row it can never own it was unconnected for every person, forever. It
    // therefore declares the connection it consumes, and the host judges it on
    // THAT connection.
    slug: "google-appointment-schedules-connector",
    displayName: "Google Appointment Schedules",
    mcpPrimitivePrefixes: ["appointment_schedule_"],
    consumesConnectionFrom: "google-calendar-connector",
    setupSubroute: "setup",
  },
  {
    slug: "apollo-connector",
    displayName: "Apollo",
    mcpPrimitivePrefixes: ["apollo_"],
    setupSubroute: "setup",
  },
  {
    slug: "apify-connector",
    displayName: "Apify",
    mcpPrimitivePrefixes: ["apify_"],
    setupSubroute: "setup",
  },
  {
    slug: "linkedin-connector",
    displayName: "LinkedIn",
    mcpPrimitivePrefixes: ["linkedin_"],
    setupSubroute: "setup",
  },
  {
    slug: "youtube-connector",
    displayName: "YouTube",
    mcpPrimitivePrefixes: ["youtube_"],
    setupSubroute: "setup",
  },
  {
    slug: "wordpress-mcp-connector",
    displayName: "WordPress MCP",
    mcpPrimitivePrefixes: ["wordpress_"],
    setupSubroute: "setup",
  },
  {
    slug: "drupal-mcp-connector",
    displayName: "Drupal MCP",
    mcpPrimitivePrefixes: ["drupal_"],
    setupSubroute: "setup",
  },
  {
    // Embeddable assistant chat-widget setup for WordPress (lifted from the
    // retired /configuration/assistants/wordpress-widget admin page).
    slug: "wordpress-assistant-connector",
    displayName: "WordPress Assistant",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    slug: "drupal-assistant-connector",
    displayName: "Drupal Assistant",
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  {
    slug: "tailscale-connector",
    displayName: "Tailscale",
    mcpPrimitivePrefixes: ["tailscale_"],
    setupSubroute: "setup",
  },
  {
    slug: "github-connector",
    displayName: "GitHub",
    mcpPrimitivePrefixes: ["github_"],
    setupSubroute: "setup",
  },
  {
    slug: "a2a-server-connector",
    displayName: "A2A Servers",
    mcpPrimitivePrefixes: ["a2a_"],
    setupSubroute: "setup",
  },
  {
    slug: "google-oauth-connector",
    displayName: "Google",
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
    mcpPrimitivePrefixes: [],
    setupSubroute: "setup",
  },
  // twenty-connector is a provider for the provider-agnostic crm-connector
  // facade. Only the provider appears here — crm-connector itself is a
  // facade/dependency, not a setup-discoverable surface.
  {
    slug: "twenty-connector",
    displayName: "Twenty CRM",
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
    mcpPrimitivePrefixes: ["plane_"],
    setupSubroute: "setup",
  },
  // mcp-server-connector (cinatra#612) carries the carved external-MCP
  // ("MCP Servers" — the outbound MCP servers Cinatra connects to) management
  // UI as its setup page. Admin-visibility (global/org/team config). It ships
  // NO MCP primitives of its own — the registered external servers ARE the MCP;
  // this connector only manages their host-owned registry rows — so no prefixes.
  {
    slug: "mcp-server-connector",
    displayName: "MCP Servers",
    mcpPrimitivePrefixes: [],
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
