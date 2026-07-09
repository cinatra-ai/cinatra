// ---------------------------------------------------------------------------
// In-admin CMS content-editor MCP tool policy (#1214).
//
// The in-admin CMS assistants — the embedded WordPress and Drupal admin widgets
// — dispatch a content-editor agent run (`@cinatra-ai/wordpress-agent` /
// `@cinatra-ai/drupal-agent`). The ratified #1214 invariant is that the in-admin
// assistant reaches the CMS ONLY through the CMS's MCP integration, never a
// direct REST / JSON:API call with a stored credential.
//
// The two in-admin editing primitives were rerouted onto the MCP integrations
// (WordPress: `wordpress_post_get` / `wordpress_post_update` via the plugin MCP
// content server — connector #66; Drupal: `drupal_node_*` via `drupal/mcp_tools`
// — connector #64). BUT the dispatched content-editor agent gets the cinatra
// self-MCP tool with `allowedTools: null` (unrestricted), so it can still REACH
// the neighbouring WordPress primitives that were NOT rerouted and remain
// direct-REST-backed (`wordpress_post_status`, `wordpress_posts_list`,
// `wordpress_post_delete`, `wordpress_media_upload`, `wordpress_post_create_draft`,
// `wordpress_post_update_meta`). That residual reach is the boundary gap this
// policy closes fail-closed: the content-editor agent's cinatra self-MCP access
// is pinned to the MCP-backed primitives its SKILL.md actually uses.
//
// Enforcement tier: an explicit `allowedTools` allowlist on the agent-run
// cinatra self-MCP tool, applied at dispatch (the /api/llm-bridge tool build),
// exactly mirroring how the first-party external-MCP toolboxes already pin their
// injected servers (see the Drupal external toolbox `DRUPAL_MCP_ALLOWED_TOOLS`:
// an open `allowedTools: null` "would expose every present AND future server
// tool"). Non-allowlisted tools are not advertised to the provider and a call to
// one is rejected by the hosted-MCP relay — a structured denial, not a silent
// pass-through.
//
// FAIL-CLOSED BY CONSTRUCTION: the allowlist is a fixed, explicit set. Any new
// or unknown cinatra-mcp tool (including any not-yet-rerouted CMS primitive) is
// excluded by default — it must be added here deliberately (a security
// decision) once it is proven MCP-backed.
//
// Dependency-free on purpose: imported by both packages/mcp-server and
// app-layer code/tests (the bridge), so it must not pull in DB or Next deps.
//
// TRUE-IoC (core→extension instance-coupling ban): this policy names NO
// specific extension package. WHICH dispatched agent runs are in-admin CMS
// content editors is resolved by the HOST from the generated
// `relayAgentPackage` bindings — the same manifest-driven source
// (`cinatra.widgetStream.relayAgentPackage`) the widget-stream relay already
// uses (see src/lib/widget-stream-agents.server.ts,
// `isInAdminCmsContentEditorPackage`). The host passes the resolved boolean
// into {@link resolveAgentRunCinatraMcpAllowedTools}; this module only owns the
// TOOL allowlist (tool names, not extension instances) and its enforcement
// predicate.
// ---------------------------------------------------------------------------

/**
 * The MCP-backed cinatra-mcp primitives the in-admin CMS content-editor agents
 * are allowed to reach. Enumerated from each agent's SKILL.md (the operations it
 * actually performs), restricted to the primitives proven to egress ONLY via
 * the CMS MCP integration:
 *
 * WordPress (wordpress-agent SKILL.md STEP 1/STEP 2 — the only two tools it
 * calls; every other WordPress primitive is a "NEVER" rule there):
 *   - `wordpress_post_get`    → plugin MCP content server (connector #66)
 *   - `wordpress_post_update` → plugin MCP content server (connector #66)
 *
 * Drupal (drupal-agent SKILL.md STEP 1/STEP 2/STEP 3 — its full tool set; all
 * already route through `drupal/mcp_tools`, connector #64):
 *   - `drupal_node_get`                  → mcp_jsonapi_list_entities (MCP-primary read)
 *   - `drupal_node_create_draft_revision`→ drupal/mcp_tools
 *   - `drupal_node_update`               → mcp_update_content
 *   - `drupal_node_publish`              → mcp_publish_content
 *
 * DELIBERATELY EXCLUDED (still direct-REST — the residual violation #1214's
 * follow-up reroutes): `wordpress_post_status`, `wordpress_posts_list`,
 * `wordpress_pages_list`, `wordpress_post_get_latest`, `wordpress_post_delete`,
 * `wordpress_media_upload`, `wordpress_post_create_draft`,
 * `wordpress_post_update_meta`, `wordpress_status`, `wordpress_instances_list`.
 * The content-editor SKILL.md gates delete/meta behind "unless the user
 * explicitly asks"; under the invariant those requests fail closed here until
 * the primitives are rerouted onto plugin MCP abilities.
 */
export const IN_ADMIN_CMS_MCP_ALLOWED_TOOLS: readonly string[] = [
  // WordPress — rerouted onto the plugin MCP content server.
  "wordpress_post_get",
  "wordpress_post_update",
  // Drupal — all already route through drupal/mcp_tools.
  "drupal_node_get",
  "drupal_node_create_draft_revision",
  "drupal_node_update",
  "drupal_node_publish",
] as const;

const ALLOWED_TOOL_SET: ReadonlySet<string> = new Set(
  IN_ADMIN_CMS_MCP_ALLOWED_TOOLS,
);

/**
 * True when an in-admin CMS content-editor agent may reach the named
 * cinatra-mcp tool. STRICT explicit allowlist — deny-by-default. Any tool not
 * on {@link IN_ADMIN_CMS_MCP_ALLOWED_TOOLS} (a not-yet-rerouted CMS primitive,
 * or any new tool) is refused.
 */
export function isInAdminCmsMcpToolAllowed(name: string): boolean {
  return ALLOWED_TOOL_SET.has(name);
}

/**
 * Resolve the cinatra self-MCP `allowedTools` value for a dispatched agent run.
 * `isInAdminCmsContentEditor` is decided by the HOST from the generated
 * `relayAgentPackage` bindings (no extension package is named here — see the
 * module header). Returns the explicit in-admin CMS allowlist (a fresh mutable
 * copy for the `LlmMcpServerTool.allowedTools` field) for an in-admin CMS
 * content-editor run, or `null` (unrestricted — unchanged behavior) otherwise.
 */
export function resolveAgentRunCinatraMcpAllowedTools(
  isInAdminCmsContentEditor: boolean,
): string[] | null {
  return isInAdminCmsContentEditor ? [...IN_ADMIN_CMS_MCP_ALLOWED_TOOLS] : null;
}
