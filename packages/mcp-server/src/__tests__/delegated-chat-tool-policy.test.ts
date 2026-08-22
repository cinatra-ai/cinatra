import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import {
  carriesDeniedDelegatedChatVerbToken,
  delegatedChatProposalOverrideNames,
  isDelegatedChatProposalOverrideName,
  isHardDeniedDelegatedChatFamily,
} from "../delegated-chat-tool-policy";
import {
  coreDelegatedChatAdmittedNames,
  isCoreDelegatedChatAdmitted,
} from "../core-delegated-chat-surface";
import { HOST_PRIMITIVE_DECLARATIONS } from "../host-primitive-declarations";

// Regression table for the delegated chat MCP tool perimeter.
//
// The perimeter is the authoritative server-side gate for what a chat-delegated
// on-behalf-of token may see/call. A false-deny silently breaks chat dispatch;
// a false-allow is a privilege/destructive escalation. Pin both directions.
//
// SINCE cinatra#2817 the question is asked of the DECISION, not of a name list:
// `isCoreDelegatedChatAdmitted` runs the real shared evaluator over this build's
// real migrated core admission records. Every case below therefore exercises the
// same code path a live request takes, with the core surface substituted for a
// request snapshot.

describe("the core delegated-chat surface", () => {
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
      // "purge"/"execute" are NOT denied verb tokens, so the admission lookup
      // is reached.
      "extensions_purge",
      "extensions_purge_execute",
    ]) {
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
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
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
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
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
    }
  });

  it("allows the WordPress governed-invoker primitives, denies the retired narrow reads they replaced (cinatra#2022 S7 PR-δ)", () => {
    // wordpress_site_tool_call / wordpress_site_tools_list are the S2/S3
    // governed-invoker primitives, chat-reachable as of this PR (ALLOWED_EXACT
    // swap). See the file-header AMENDMENT note for the two compensating
    // controls (S5 destructive-confirmation hook + the per-instance policy
    // floor, now restricted+empty by default) that keep this narrow.
    expect(isCoreDelegatedChatAdmitted("wordpress_site_tool_call")).toBe(true);
    expect(isCoreDelegatedChatAdmitted("wordpress_site_tools_list")).toBe(true);
    // The two narrow read-only entries they replaced are no longer chat-
    // reachable under their own names (they're superseded by the generic
    // primitives above, not additionally allowed).
    expect(isCoreDelegatedChatAdmitted("wordpress_instances_list")).toBe(false);
    expect(isCoreDelegatedChatAdmitted("wordpress_posts_list")).toBe(false);
  });

  it("allows agent_run_stop (user-directed run cancellation, proposal override)", () => {
    expect(isCoreDelegatedChatAdmitted("agent_run_stop")).toBe(true);
    // The bulk variant + resume stay denied.
    expect(isCoreDelegatedChatAdmitted("agent_runs_stop")).toBe(false);
    expect(isCoreDelegatedChatAdmitted("agent_run_resume")).toBe(false);
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
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(false);
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
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(false);
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
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(false);
    }
  });

  it("allows the read-only lifecycle PULL primitives (cinatra#2567, epic #2564 S3)", () => {
    // Refs in, one card out. The list re-checks run READ access per row before
    // it mints a ref; each render re-resolves the card's state server-side. No
    // gate content ever rides the tool result, so nothing about a review lands
    // in the persisted, LLM-visible transcript.
    for (const name of [
      "artifact_review_gates_list",
      "artifact_review_gate_render",
      "verification_record_render",
    ]) {
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
    }
  });

  it("denies the lifecycle DECISION class by construction, not just by omission (cinatra#2567)", () => {
    // The allowlist alone already denies these. The verb backstop is what makes
    // adding one to ALLOWED_EXACT insufficient to expose it — a review is
    // resolved on a rendered decision surface by a person, never by the model.
    for (const name of [
      "artifact_review_gate_decide",
      "artifact_review_gate_approve",
      "artifact_review_gate_reject",
      "artifact_review_gate_resume",
      "recommendation_hold_confirm",
      "trigger_schedule_arm",
      "verification_record_approve",
    ]) {
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(false);
    }
  });

  it("keeps the host DECLARATIONS and the verb backstop CONSISTENT", () => {
    // The two halves can silently disagree: a new denied verb token would
    // shadow a declared read and the primitive would vanish from chat with no
    // failing test anywhere near it. Read EVERY host declaration, not a
    // hand-copied sample.
    const declared = Object.keys(HOST_PRIMITIVE_DECLARATIONS);
    expect(declared.length).toBeGreaterThan(50);
    for (const name of declared) {
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// THE HARD BACKSTOPS, on their own (cinatra#2817 slice 3).
//
// These three used to be branches inside one opaque boolean. They are separate
// exported predicates now, so a caller must state which rule it is applying —
// and so the two UNCONDITIONAL ones can be pinned as unconditional.
// ---------------------------------------------------------------------------
describe("the hard backstops", () => {
  it("family denies are name-only, case-folded, and cover prefix AND substring forms", () => {
    for (const name of [
      "permissions_grant",
      "PERMISSIONS_GRANT",
      "apollo_jobs_list",
      "agent_system_reset",
      "queue_jobs_drain",
      "worker_process_due",
    ]) {
      expect(isHardDeniedDelegatedChatFamily(name), name).toBe(true);
    }
    for (const name of ["agent_list", "skills_installed_get", "artifacts_get"]) {
      expect(isHardDeniedDelegatedChatFamily(name), name).toBe(false);
    }
  });

  it("the verb backstop matches WHOLE tokens, case-folded", () => {
    for (const name of ["objects_delete", "OBJECTS_DELETE", "agent_run_resume", "x_publish_y"]) {
      expect(carriesDeniedDelegatedChatVerbToken(name), name).toBe(true);
    }
    // "installed" is not "install"; "approvals" is not "approve".
    for (const name of ["skills_installed_get", "approvals_list", "artifact_review_gates_list"]) {
      expect(carriesDeniedDelegatedChatVerbToken(name), name).toBe(false);
    }
  });

  it("the proposal override is exactly the seven audited names", () => {
    const names = delegatedChatProposalOverrideNames();
    expect([...names]).toEqual([...names].sort());
    for (const name of names) {
      expect(isDelegatedChatProposalOverrideName(name), name).toBe(true);
    }
    expect(isDelegatedChatProposalOverrideName("objects_delete")).toBe(false);
  });

  it("the override bypasses the VERB backstop and nothing else", () => {
    // Every override name carries a denied verb token or has no reason to be
    // there — that is what the override is FOR.
    const verbBearing = delegatedChatProposalOverrideNames().filter((n) =>
      carriesDeniedDelegatedChatVerbToken(n),
    );
    expect(verbBearing.length).toBeGreaterThan(0);
    for (const name of verbBearing) {
      // Admitted despite the verb token...
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
      // ...but the family denies still hold above it.
      expect(isHardDeniedDelegatedChatFamily(name), name).toBe(false);
    }
  });

  it("a DENIED FAMILY loses even when it is on the override list and declared", () => {
    // Constructed rather than found: no such name exists today, and the point
    // is that adding one could not open the family.
    expect(isCoreDelegatedChatAdmitted("permissions_dashboards_create")).toBe(false);
    expect(isHardDeniedDelegatedChatFamily("permissions_dashboards_create")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// THE CORE-SURFACE PROJECTION (cinatra#2776 accessor → cinatra#2817 projection).
//
// The hosted-MCP wire gate needs to know which primitive names may NEVER appear
// as inline function schemas on a provider request. It used to read a name
// accessor; it now reads a projection DERIVED by running every host declaration
// back through the real evaluator, so it cannot drift from the decision.
// ---------------------------------------------------------------------------
describe("coreDelegatedChatAdmittedNames", () => {
  it("includes the proposal-override members, not just the plain reads", () => {
    const names = coreDelegatedChatAdmittedNames();
    // A plain admitted read and two override members (which carry a
    // create/update/stop verb token and are reachable ONLY because the override
    // sits above the verb backstop).
    expect(names).toContain("agent_list");
    expect(names).toContain("agent_run_stop");
    expect(names).toContain("agent_creation_request_propose");
  });

  it("agrees with the decision in BOTH directions", () => {
    const names = coreDelegatedChatAdmittedNames();
    // Nothing the decision function would refuse can appear here.
    for (const name of names) {
      expect(isCoreDelegatedChatAdmitted(name), name).toBe(true);
    }
    // And a denied name is absent.
    for (const denied of ["permissions_grant", "artifact_delete", "approvals_decide"]) {
      expect(isCoreDelegatedChatAdmitted(denied), denied).toBe(false);
      expect(names).not.toContain(denied);
    }
  });

  it("is sorted, deduped and non-trivial (a vacuous set would make the gate blind)", () => {
    const names = coreDelegatedChatAdmittedNames();
    expect(names.length).toBeGreaterThan(50);
    expect([...names]).toEqual([...names].sort());
    expect(new Set(names).size).toBe(names.length);
  });
});
