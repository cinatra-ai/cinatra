// ---------------------------------------------------------------------------
// THE NON-WIDENING GATE (cinatra#2817).
//
// The issue's hardest acceptance criterion is a NEGATIVE one: replacing the
// name-only perimeter must not change WHAT IS CALLABLE on the core surface. A
// swap that quietly admitted one extra core primitive would pass every other
// suite in this package — registration works, the evaluator is consistent, the
// catalog matches the plan — and still be the exact regression the issue is
// written to prevent.
//
// So the pre-#2817 answer is FROZEN here as a literal, and the post-swap
// projection is asserted equal to it in BOTH directions. The list below is the
// union of `ALLOWED_EXACT` and `ALLOWED_PROPOSAL_OVERRIDE` as they stood at the
// commit this branch was cut from, filtered through the predicate that then
// decided admission — i.e. exactly the names a delegated chat could see and
// call before the perimeter was replaced.
//
// WHY A LITERAL AND NOT A READ. Both sets are deleted by this issue, so there
// is nothing left to read. Reading them from git history instead would make the
// gate evaporate the moment main moved past this branch — a gate that stops
// gating is worse than no gate, because it still looks green.
//
// HOW TO CHANGE THIS LIST. Deliberately, in a commit that says why. Adding a
// name here is granting the delegated chat reach it did not have; removing one
// is withdrawing reach it did. Neither should ever be a side effect of editing
// a declaration table — which is the whole point of asserting it from the far
// side of the real evaluator.
// ---------------------------------------------------------------------------

import { describe, it, expect } from "vitest";
import { coreDelegatedChatAdmittedNames } from "../core-delegated-chat-surface";

/** Exactly what a delegated chat could see + call BEFORE cinatra#2817. */
const CALLABLE_BEFORE_2817: readonly string[] = [
  "agent_creation_request_edit",
  "agent_creation_request_get",
  "agent_creation_request_list",
  "agent_creation_request_propose",
  "agent_get",
  "agent_list",
  "agent_registry_list",
  "agent_run",
  "agent_run_get",
  "agent_run_list",
  "agent_run_messages_list",
  "agent_run_stop",
  "agent_version_diff",
  "agent_version_get",
  "agent_version_list",
  "artifact_assertion_get",
  "artifact_assertion_list",
  "artifact_authoring_chain_get",
  "artifact_authoring_emit",
  "artifact_extension_get",
  "artifact_extension_search",
  "artifact_representation_get",
  "artifact_representation_latest",
  "artifact_representation_list",
  "artifact_review_gate_render",
  "artifact_review_gates_list",
  "artifacts_get",
  "artifacts_list",
  "blog_project_get",
  "blog_project_list",
  "campaigns_get",
  "campaigns_list",
  "connector_inventory_list",
  "crm_account_get",
  "crm_account_search",
  "crm_contact_find_by_email",
  "crm_contact_get",
  "crm_contact_search",
  "crm_list_get",
  "crm_list_members_get",
  "crm_list_search",
  "dashboards_create",
  "dashboards_cube_chart",
  "dashboards_cube_discover",
  "dashboards_cube_load",
  "dashboards_cube_validate",
  "dashboards_get",
  "dashboards_list",
  "dashboards_update",
  "drupal_instances_list",
  "email_outreach_campaign_get",
  "email_outreach_campaign_list",
  "extensions_purge",
  "extensions_purge_execute",
  "extensions_search",
  "gmail_aliases_list",
  "linkedin_accounts_list",
  "media_feeds_list",
  "metric_cost_budget_get",
  "metric_cost_by_agent",
  "metric_cost_by_provider",
  "metric_cost_recent_events",
  "metric_cost_summary",
  "metric_cost_timeseries",
  "metric_usage_events",
  "metric_usage_summary",
  "objects_get",
  "objects_list",
  "projects_get",
  "projects_list",
  "schedule_proposal_render",
  "skills_catalog_list",
  "skills_installed_get",
  "skills_installed_list",
  "skills_installed_resolve_for_agent",
  "skills_library_list",
  "skills_personal_get",
  "skills_personal_list",
  "skills_personal_list_for_agent",
  "system_screen_lookup",
  "verification_record_render",
  "wordpress_site_tool_call",
  "wordpress_site_tools_list",
];

describe("the perimeter swap did not change what is callable", () => {
  it("admits EXACTLY the pre-#2817 core surface — no additions", () => {
    const now = [...coreDelegatedChatAdmittedNames()];
    const added = now.filter((name) => !CALLABLE_BEFORE_2817.includes(name));
    // Named rather than counted: a failure must say WHICH primitive the swap
    // exposed, because that is the whole content of the security review.
    expect(added).toEqual([]);
  });

  it("admits EXACTLY the pre-#2817 core surface — no silent withdrawals", () => {
    const now = [...coreDelegatedChatAdmittedNames()];
    const removed = CALLABLE_BEFORE_2817.filter((name) => !now.includes(name));
    // A withdrawal is not a security regression, but it IS a silent breakage of
    // a surface the chat relies on, so it fails here too and has to be stated.
    expect(removed).toEqual([]);
  });

  it("the frozen list is the real one (83 names), not an empty set passing vacuously", () => {
    expect(CALLABLE_BEFORE_2817).toHaveLength(83);
    expect(new Set(CALLABLE_BEFORE_2817).size).toBe(83);
    expect([...CALLABLE_BEFORE_2817]).toEqual([...CALLABLE_BEFORE_2817].sort());
  });
});
