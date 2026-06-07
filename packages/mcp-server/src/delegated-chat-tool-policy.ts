// ---------------------------------------------------------------------------
// Delegated chat MCP tool policy.
//
// A chat-delegated on-behalf-of token carries the human chat user's identity
// (including, for admins, platform_admin). The chat surface's job is to
// DISCOVER + DISPATCH + POLL agents and read context data. The actual
// side-effecting work (create/update/delete/send/publish) is performed by the
// dispatched AGENT running under its own actor context — NOT by the chat
// issuing raw MCP mutations. A hijacked / prompt-injected chat LLM must not
// be able to delete data, send email, publish posts, or publish agent
// packages directly through this channel even though the underlying user
// could do those things via the normal UI (which has its own confirmation
// surfaces).
//
// Therefore this policy is a STRICT explicit allowlist (read + dispatch +
// discovery only) with a defense-in-depth mutating-verb denylist on top.
// Deny-by-default: anything not explicitly listed is refused.
//
// Enforcement is server-side at MCP-runtime-server construction
// (registration-time filtering + a call-time handler guard) so it holds even
// if a provider ignores the client-side `allowedTools` hint.
//
// Dependency-free on purpose: imported by both packages/mcp-server (the
// enforcement point) and app-layer code/tests, so it must not pull in DB or
// Next deps.
//
// Source-mutation tool note:
// The four live source-mutating tools — `agent_source_write`,
// `agent_source_write_files`, `agent_source_compile`, `agent_source_publish` —
// are INTENTIONALLY not on the allowlist below. They are admin-only at the
// handler boundary as well (see resolveIsPlatformAdminFromSession gates on
// each of the four handlers in packages/agents/src/mcp/handlers.ts). The
// non-admin authoring path uses an isolated `agent_creation_request`
// proposal store — never these live tools.
// ---------------------------------------------------------------------------

// Explicit read / dispatch / discovery tools the chat legitimately needs.
// NOTHING here mutates state, sends, publishes, or deletes. Adding a tool to
// this set is a security decision — keep it to read + dispatch + poll.
const ALLOWED_EXACT = new Set<string>([
  // Generic screen/extension discovery
  "system_screen_lookup",
  "extensions_search",

  // Chat-driven semantic-artifact authoring. Allowlisted because the
  // chat-create-artifact skill
  // (assistant-skills/skills/chat-create-artifact) is the model-
  // facing dispatcher for the "create me an X artifact" intent. The
  // emit primitive is gated server-side (recursion ledger + extension
  // validation + content-size cap + MIME + manifest.skills.authoring
  // presence) — the chat allowlist entry just exposes the dispatch
  // surface.
  "artifact_extension_search",
  "artifact_extension_get",
  "artifact_authoring_emit",
  "artifact_authoring_chain_get",
  // Read-only artifact lookups the chat needs after emitting so it
  // can confirm the artifact back to the user.
  "artifacts_get",
  // Read-only artifact lifecycle surfaces. The chat is the primary artifact author; letting
  // it LIST its emissions + read their semantic identity (assertions) and
  // version history (representations) closes the "I can emit but can't
  // see what I emitted" gap. All read-only — no mutation verb tokens, so
  // they need no CarveOut; the deny-by-default backstop passes them.
  "artifacts_list",
  "artifact_assertion_list",
  "artifact_assertion_get",
  "artifact_representation_list",
  "artifact_representation_get",
  "artifact_representation_latest",

  // Read-only cost + usage observability. The
  // user asks the chat "how much has this org spent on LLM this week?" —
  // today that requires manual cube-discovery hops. These 10 primitives
  // are pure reads over the metric-cost / metric-usage stores. NOTE: the
  // underlying `usage_events` is currently instance/schema-scoped, not
  // per-org — so answers are deployment-wide until the metrics layer gains
  // org scoping. The chat should caveat accordingly.
  "metric_cost_summary",
  "metric_cost_by_provider",
  "metric_cost_by_agent",
  "metric_cost_recent_events",
  "metric_cost_budget_get",
  "metric_cost_timeseries",
  "metric_usage_events",
  "metric_usage_summary",

  // Extension purge. `extensions_purge` is the read-only
  // dry-run (blast radius + digest). `extensions_purge_execute` is the
  // DESTRUCTIVE saga, explicitly assistant-invocable for this delegated
  // channel. Both stay admin-gated at the extensions MCP registry layer; the
  // registry single-version delete/unpublish stay denied (their
  // "delete"/"unpublish" verb tokens are auto-blocked by
  // DENIED_VERB_TOKENS below).
  "extensions_purge",
  "extensions_purge_execute",

  // Agent discovery + dispatch + run status (the chat's core purpose).
  // agent_run creates an agent_runs row + enqueues a job — that is the
  // intended dispatch action, not an arbitrary mutation. The dispatched
  // agent performs its work under its OWN actor context.
  "agent_list",
  "agent_get",
  "agent_run",
  "agent_run_get",
  "agent_run_list",
  "agent_run_messages_list",
  "agent_registry_list",
  "agent_version_list",
  "agent_version_get",
  "agent_version_diff",

  // Skill / personal-skill discovery (read-only).
  "skills_catalog_list",
  "skills_library_list",
  "skills_installed_get",
  "skills_installed_list",
  "skills_installed_resolve_for_agent",
  "skills_personal_list",
  "skills_personal_list_for_agent",
  "skills_personal_get",

  // Read-only shared object context the chat surfaces in conversation. Explicit
  // get/list/search only — NO create/update/delete.
  // Chat reads non-CRM objects via canonical `objects_list` / `objects_get`.
  // CRM reads (accounts, contacts, lists) flow through the provider-agnostic
  // `crm_*` facade — read-only CRM access through the provider-agnostic facade.
  // The eight CRM read entries below MUST stay in lockstep with
  // `src/lib/objects/surface-inventory.ts` `DELEGATED_CHAT_OBJECT_ALLOWLIST`
  // (parity asserted by the inventory test). Mutating CRM verbs
  // (crm_*_create / crm_*_update / crm_list_member_add / crm_list_member_remove)
  // are INTENTIONALLY NOT here — the chat dispatches agents that perform
  // those writes; raw mutating MCP from the chat token stays blocked.
  "objects_list",
  "objects_get",
  "crm_list_search",
  "crm_list_get",
  "crm_list_members_get",
  "crm_account_search",
  "crm_account_get",
  "crm_contact_search",
  "crm_contact_get",
  "crm_contact_find_by_email",
  "projects_list",
  "projects_get",
  "blog_project_list",
  "blog_project_get",
  "campaigns_list",
  "campaigns_get",
  "email_outreach_campaign_list",
  "email_outreach_campaign_get",
  "media_feeds_list",
  "gmail_aliases_list",
  "linkedin_accounts_list",
  "wordpress_instances_list",
  "wordpress_posts_list",
  "drupal_instances_list",

  // Dashboards — read-only catalog + semantic queries. CRUD on dashboard
  // entities themselves stays in ALLOWED_PROPOSAL_OVERRIDE below (create/update
  // are carve-out gated; publish/archive remain denied via verb-token
  // backstop). _chart is the MCP-Apps-render variant of _load.
  "dashboards_list",
  "dashboards_get",
  "dashboards_cube_discover",
  "dashboards_cube_validate",
  "dashboards_cube_load",
  "dashboards_cube_chart",
  // Workflow proposal-only authoring + read.
  // The two mutating-verb tools (draft_create/_update) are in
  // ALLOWED_PROPOSAL_OVERRIDE below (they carry create/update tokens). These
  // are the no-verb-token reads + non-destructive proposal tools. NONE of
  // start/approve/reject are listed (deny-by-default keeps them unreachable).
  "workflow_template_list",
  "workflow_template_instantiate",
  "workflow_draft_get",
  "workflow_draft_list",
  "workflow_validate",
  "workflow_preview",
  "workflow_status_get",
  "workflow_status_list",
  "workflow_cascade_preview",
  "workflow_copy",
  "workflow_save_as_template",
]);

// Explicit proposal-only OVERRIDE: vetted draft-authoring tools
// that intentionally carry a mutating verb token (create/update) but are
// chat-reachable because they only ever touch a DRAFT (enforced at the handler:
// draft-status-only + canManage + CAS + fail-closed validation). Checked BEFORE
// the verb-token denylist (which would otherwise block create/update).
//
// These entries MUST stay in lockstep with the typed `CarveOut` records at
// `boundary:"delegated_chat_token"` in src/lib/authz/carve-out.ts. The parity
// check asserts the relationship; removing
// a name here without removing the matching CarveOut (or vice-versa) fails CI.
const ALLOWED_PROPOSAL_OVERRIDE = new Set<string>([
  "workflow_draft_create",
  "workflow_draft_update",
  // Dashboard authoring from chat — handler enforces actor + canWrite + config
  // validation + audit row in one transaction (mutation-service.ts:154-214).
  // An enterprise-intelligence-platform
  // chat should be able to author analytics views in addition to workflow
  // drafts. Publish/archive stay denied (the publish/archive verb tokens have
  // no CarveOut → caught by DENIED_VERB_TOKENS below).
  "dashboards_create",
  "dashboards_update",
  // User-directed run cancellation. The stop verb token is on the deny list, so
  // cancelling a run the user just dispatched requires this explicit
  // override. Low blast radius: agent_run_stop only halts processing of
  // a run the caller can already access (the handler re-checks run
  // access via enforceRunAccess). It does NOT delete data or emit
  // external effects. The resume primitive is INTENTIONALLY NOT here —
  // resume is often approval, and a prompt-injected chat must not
  // auto-approve a HITL gate. Resume stays on the rendered
  // approval surface.
  "agent_run_stop",
  // Agent-Creation Approval Workflow — non-admin proposal path.
  // The propose/edit primitives write into the ISOLATED agent_creation_request
  // store (NEVER the live agent_source_* tree); list/get are author-or-admin
  // reads of their own requests. The decide primitive is INTENTIONALLY NOT
  // here — admin-only, surfaced via /configuration/agents/approvals UI; a
  // prompt-injected chat must not auto-approve a proposal (mirrors the
  // resume-on-approval-surface rule above).
  "agent_creation_request_propose",
  "agent_creation_request_edit",
  "agent_creation_request_list",
  "agent_creation_request_get",
]);

// Defense-in-depth: even if a future tool is mistakenly added to
// ALLOWED_EXACT, deny anything whose name carries a mutating / side-effecting
// / destructive verb. This is a backstop, not the primary gate (the explicit
// allowlist is).
//
// Matched as WHOLE underscore-delimited tokens, NOT raw substrings — so
// `skills_installed_get` (token "installed") is NOT blocked by the
// `install` verb. A raw substring check for `_install` would wrongly deny the
// allowed skills_installed_* reads.
const DENIED_VERB_TOKENS = new Set<string>([
  "delete",
  "send",
  "publish",
  "unpublish",
  "archive",
  "restore",
  "create",
  "update",
  "write",
  "cancel",
  "stop",
  "rollback",
  "install",
  "uninstall",
  "upsert",
  "refresh",
  "trigger",
]);

// Family prefixes that must never be reachable from chat regardless of verb.
// These ARE prefix checks (privilege / system / job-control namespaces).
const DENIED_FAMILY_PREFIXES = [
  "permissions_",
  "apollo_jobs_",
] as const;

const DENIED_FAMILY_SUBSTRINGS = [
  "_system_",
  "_jobs_",
  "process_due",
] as const;

/**
 * Returns true if a delegated chat MCP request may see + call the named tool.
 * STRICT: explicit allowlist AND no mutating-verb TOKEN AND not in a denied
 * family. Anything else is refused (deny-by-default).
 */
export function isDelegatedChatMcpToolAllowed(name: string): boolean {
  const normalized = name.toLowerCase();
  if (DENIED_FAMILY_PREFIXES.some((p) => normalized.startsWith(p))) {
    return false;
  }
  if (DENIED_FAMILY_SUBSTRINGS.some((p) => normalized.includes(p))) {
    return false;
  }
  // Vetted proposal-only override (workflow draft authoring) — allowed
  // despite its create/update verb token. Still gated by the hard family-deny
  // checks above; only the verb-token backstop is bypassed.
  if (ALLOWED_PROPOSAL_OVERRIDE.has(normalized)) return true;
  // Token-aware verb check: split on underscores, deny if ANY token is a
  // destructive verb. "skills_installed_get" → ["skills","installed","get"]
  // — "installed" !== "install" so it survives.
  const tokens = normalized.split("_").filter(Boolean);
  if (tokens.some((t) => DENIED_VERB_TOKENS.has(t))) return false;
  return ALLOWED_EXACT.has(normalized);
}
