import { describe, it, expect } from "vitest";
import { isDelegatedChatMcpToolAllowed } from "../delegated-chat-tool-policy";

// Regression table for the delegated chat MCP tool policy.
// The policy is the authoritative server-side gate for what a chat-delegated
// on-behalf-of token may see/call. A false-deny silently breaks chat dispatch;
// a false-allow is a privilege/destructive escalation. Pin both directions.

describe("isDelegatedChatMcpToolAllowed", () => {
  it("allows the core agent dispatch + discovery surface", () => {
    for (const name of [
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
      "system_screen_lookup",
      "extensions_search",
      // Purge dry-run and destructive execution are explicitly
      // assistant-invocable; admin-gated at the extensions MCP registry layer.
      // "purge"/"execute" are NOT denied verb tokens, so ALLOWED_EXACT
      // membership is reached.
      "extensions_purge",
      "extensions_purge_execute",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(true);
    }
  });

  it("allows skills_installed_* reads (token-aware: 'installed' !== 'install')", () => {
    for (const name of [
      "skills_installed_get",
      "skills_installed_list",
      "skills_installed_resolve_for_agent",
      "skills_personal_list",
      "skills_personal_get",
      "skills_personal_list_for_agent",
      "skills_catalog_list",
      "skills_library_list",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(true);
    }
  });

  it("allows explicit read-only GTM + dashboard tools", () => {
    for (const name of [
      // Entity-specific reads (`accounts_list`/`accounts_get`/
      // `contacts_list`/`contacts_get`) and `objects_search` are outside this
      // allowlist. Chat reads non-CRM objects via canonical
      // `objects_list` / `objects_get`. CRM reads (accounts, contacts, lists)
      // flow through the provider-agnostic `crm_*` facade.
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
      "campaigns_list",
      "campaigns_get",
      "email_outreach_campaign_list",
      "email_outreach_campaign_get",
      "blog_project_list",
      "blog_project_get",
      "dashboards_cube_discover",
      "dashboards_cube_validate",
      "dashboards_cube_load",
      // Read-only artifact lifecycle + cost/usage observability.
      "artifacts_list",
      "artifact_assertion_list",
      "artifact_assertion_get",
      "artifact_representation_list",
      "artifact_representation_get",
      "artifact_representation_latest",
      "metric_cost_summary",
      "metric_cost_by_provider",
      "metric_cost_by_agent",
      "metric_cost_recent_events",
      "metric_cost_budget_get",
      "metric_cost_timeseries",
      "metric_usage_events",
      "metric_usage_summary",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(true);
    }
  });

  it("allows the WordPress governed-invoker primitives, denies the retired narrow reads they replaced (cinatra#2022 S7 PR-δ)", () => {
    // wordpress_site_tool_call / wordpress_site_tools_list are the S2/S3
    // governed-invoker primitives, chat-reachable as of this PR (ALLOWED_EXACT
    // swap). See the file-header AMENDMENT note for the two compensating
    // controls (S5 destructive-confirmation hook + the per-instance policy
    // floor, now restricted+empty by default) that keep this narrow.
    expect(isDelegatedChatMcpToolAllowed("wordpress_site_tool_call")).toBe(true);
    expect(isDelegatedChatMcpToolAllowed("wordpress_site_tools_list")).toBe(true);
    // The two narrow read-only entries they replaced are no longer chat-
    // reachable under their own names (they're superseded by the generic
    // primitives above, not additionally allowed).
    expect(isDelegatedChatMcpToolAllowed("wordpress_instances_list")).toBe(false);
    expect(isDelegatedChatMcpToolAllowed("wordpress_posts_list")).toBe(false);
  });

  it("allows agent_run_stop (user-directed run cancellation, proposal override)", () => {
    expect(isDelegatedChatMcpToolAllowed("agent_run_stop")).toBe(true);
    // The bulk variant + resume stay denied.
    expect(isDelegatedChatMcpToolAllowed("agent_runs_stop")).toBe(false);
    expect(isDelegatedChatMcpToolAllowed("agent_run_resume")).toBe(false);
  });

  it("denies privilege-mutating + destructive + lifecycle tools", () => {
    for (const name of [
      // privilege escalation (the original CRITICAL)
      "permissions_users_update_platform_role",
      // destructive data ops
      "objects_delete",
      "projects_delete",
      "contacts_delete",
      "accounts_delete",
      // CRM mutating verbs (deny-by-default; the chat dispatches agents that
      // perform CRM writes — raw CRM mutations from the chat token stay blocked)
      "crm_contact_create",
      "crm_contact_update",
      "crm_account_create",
      "crm_account_update",
      "crm_list_create",
      "crm_list_member_add",
      "crm_list_member_remove",
      // external irreversible sends/publishes
      "gmail_email_send",
      "linkedin_post_publish",
      "wordpress_post_delete",
      "wordpress_post_update",
      "drupal_node_update",
      // agent lifecycle / publish / triggers
      "agent_delete",
      // All four live source-mutating tools must stay
      // denied at the delegated-chat boundary (handler-level admin gates are
      // a second wall — see agent-source-admin-gate.test.ts).
      "agent_source_publish",
      "agent_source_write",
      "agent_source_write_files",
      "agent_source_compile",
      "agent_registry_publish",
      "agent_version_rollback",
      // NOTE: agent_run_stop is in ALLOWED_PROPOSAL_OVERRIDE (user-
      // directed "cancel that run") — asserted
      // allowed in the override test below. agent_runs_stop (bulk) +
      // trigger mutations stay denied.
      "agent_runs_stop",
      "agent_run_trigger_set",
      "agent_run_trigger_delete",
      // skills lifecycle
      "skills_packages_install_from_github",
      "skills_packages_uninstall",
      "skills_installed_upsert",
      "skills_personal_delete",
      // extensions lifecycle
      "extensions_install",
      "extensions_uninstall",
      // Registry-only single-version ops stay denied
      // (deny-by-default: their "unpublish"/"delete" verb tokens).
      "extensions_registry_unpublish",
      "extensions_registry_delete",
      // system / jobs families
      "agent_jobs_process_due",
      "apollo_jobs_run",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(false);
    }
  });

  it("denies anything not explicitly allowed (deny-by-default)", () => {
    for (const name of [
      "some_unknown_tool",
      "objects_save",
      // legacy `lists_*` retired — primitives unregistered
      // from `packages/lists/src/mcp/registry.ts`; chat-side deny-by-default
      // catches any residual probe.
      "lists_create",
      "lists_get",
      "lists_list",
      "lists_delete",
      "lists_members_add",
      "contacts_create",
      "campaigns_create",
      "agent_compile",
      "agent_save",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(false);
    }
  });

  it("denies the unified approvals_* tools — a decision stays on the rendered approval surface, never a chat auto-approve (#1048)", () => {
    // `approvals_decide` is denied by the `decide` verb TOKEN (same rationale as
    // stop/resume: a prompt-injected chat must never render a binding approval);
    // `approvals_list` / `approvals_get` are denied by deny-by-default (not on the
    // strict allowlist). The pre-existing `agent_creation_request_decide` is now
    // ALSO covered by the `decide` token (previously off-chat only by omission).
    for (const name of [
      "approvals_decide",
      "approvals_list",
      "approvals_get",
      "agent_creation_request_decide",
    ]) {
      expect(isDelegatedChatMcpToolAllowed(name), name).toBe(false);
    }
  });
});
