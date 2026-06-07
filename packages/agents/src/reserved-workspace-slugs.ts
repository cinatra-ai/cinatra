// Reserved workspace package slugs.
//
// NOTE: intentionally NO `import "server-only"`. This module is imported by
// ensure-agent-package.ts, which is a pure-Node module loaded from
// instrumentation.node.ts at boot — a server-only guard would throw there.
// The module is pure data + string logic anyway (no server APIs).
//
// Workspace TS packages and on-disk agent/extension packages share the exact
// npm scope `@cinatra-ai`. No current agent slug collides with a workspace
// slug, but a FUTURE authored agent named e.g. `@cinatra-ai/skills` would be
// structurally indistinguishable from the `@cinatra-ai/skills` workspace
// package in registries, dependency resolution, and any
// `agent_templates.package_name`-keyed lookup — and the agent-only resolvers
// (input-schema-resolver, oas-compiler) would derive
// `extensions/cinatra-ai/skills/...` for it. The structural truth is the disk
// location: `packages/<slug>` is a workspace TS package;
// `extensions/cinatra-ai/<slug>` is an agent/extension package. packageName
// alone is not sufficient, so agent-identity acceptance points reject any
// agent whose slug is a reserved workspace slug.

/**
 * Every `@cinatra-ai/<slug>` reserved by a workspace TS package. Sourced
 * from `packages/*` package.json names (+ the `asset-transcript` tsconfig
 * sub-entry alias). An agent package may NOT take any of these slugs.
 */
export const RESERVED_WORKSPACE_PACKAGE_SLUGS: ReadonlySet<string> = new Set([
  "a2a",
  "agent-ui-protocol",
  "agents",
  "asset-blog",
  "asset-email",
  "asset-transcript",
  "assets",
  "chat",
  "cli",
  "connector-apify",
  "connector-apollo",
  "connector-claude", // reserved connector alias — see "claude-connector" below
  "connector-mcp-client-registry",
  "connector-drupal",
  "connector-gemini",
  "connector-github",
  "connector-gmail",
  "connector-google-calendar",
  "connector-linkedin",
  "connector-media-feeds",
  "connector-nango",
  "connector-openai",
  "connector-wordpress",
  "connector-youtube",
  // Reserved kind-at-end aliases for transport connectors. Both
  // `connector-<x>` and `<x>-connector` forms are reserved so an authored
  // agent cannot collide with either connector package identity.
  "apify-connector",
  "apollo-connector",
  "drupal-connector",
  "drupal-mcp-connector",
  "github-connector",
  "gmail-connector",
  "google-calendar-connector",
  "linkedin-connector",
  "media-feeds-connector",
  "wordpress-connector",
  "wordpress-mcp-connector",
  "youtube-connector",
  "email-connector", // facade package
  // LLM-provider packages use kind-at-end connector naming. Kind stays
  // "connector" — these implement LlmProviderAdapter not EmailConnector but
  // live in the same extensions/cinatra-ai/*-connector/ layout for
  // consistency.
  "openai-connector",
  "gemini-connector",
  "claude-connector", // reserved connector alias for collision prevention
  "mcp-client-registry-connector", // mcp client registry connector package
  "connectors",
  "copilotkit",
  "dashboards",
  "entity-accounts",
  "entity-contacts",
  "extension-types",
  "extensions",
  "google-oauth-connection",
  "lists",
  "llm",
  "mcp-client",
  "mcp-server",
  "metric-cost-api",
  "metric-usage-api",
  "objects",
  "permissions",
  "projects",
  "registries",
  "sdk-dashboard",
  "sdk-extensions",
  "sdk-ui",
  "skills",
  "trigger",
  "trigger-email-send",
]);

const CANONICAL_AGENT_NAME_RE = /^@cinatra-ai\/([a-z0-9][a-z0-9-]*)$/;

/**
 * True if `packageName` is a canonical-scope agent identity whose slug is
 * reserved by a workspace TS package. Only the exact `@cinatra-ai/<slug>`
 * shape is checked — third-party / operator-vendor scopes are not the
 * collision class this guards.
 */
export function isReservedWorkspaceSlug(packageName: string): boolean {
  const m = CANONICAL_AGENT_NAME_RE.exec(packageName);
  return m !== null && RESERVED_WORKSPACE_PACKAGE_SLUGS.has(m[1]);
}

/**
 * Throws if `packageName` is an `@cinatra-ai/<reserved-workspace-slug>`
 * agent identity. Call at agent-identity acceptance points that should fail
 * loudly (authoring/publish), where a silent skip would hide the conflict.
 */
export function assertNotReservedAgentPackageName(packageName: string): void {
  if (isReservedWorkspaceSlug(packageName)) {
    throw new Error(
      `Agent package name "${packageName}" collides with a reserved workspace package slug. Agent packages live under extensions/cinatra-ai/<slug>/ and must not reuse a packages/<slug>/ workspace name. Choose a different slug (agent slugs conventionally end in "-agent").`,
    );
  }
}
