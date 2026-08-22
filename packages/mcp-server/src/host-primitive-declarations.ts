// ---------------------------------------------------------------------------
// HOST-OWNED DECLARATIONS FOR CORE/BUNDLED PRIMITIVES (cinatra#2817 slice 2).
//
// WHAT THIS REPLACES. `delegated-chat-tool-policy.ts` carried an INTERIM table
// (#2771) that SYNTHESIZED a class for each legacy-allowlisted name so the
// owner's "a missing declaration is unexposed" ruling could be applied without
// emptying the catalog. That table was explicitly temporary and explicitly
// forbidden from becoming authorization by inheritance.
//
// THIS IS THE MIGRATION, not the inheritance. Core and bundled primitives ship
// with the host and have no package of their own to declare in, so the host
// declares FOR them — here, explicitly, in one reviewable literal, owned by
// `HOST_PRIMITIVE_OWNER_PACKAGE` at `HOST_PRIMITIVE_RELEASE_VERSION`. The class
// values were migrated from the interim table because that table recorded a
// real classification decision, and re-deriving them from scratch would have
// silently changed the production catalog — which the byte-for-byte invariant
// exists to prevent. What changes is their STATUS: they are no longer a shim
// consulted downstream of a name allowlist, they are the declaration a real
// admission record is written against and digested over.
//
// A DECLARATION IS STILL NOT AUTHORIZATION. Nothing here admits anything. Each
// entry becomes an admission record only through
// `coreDelegatedChatAdmissionRecords()`, and the evaluator requires the record
// AND the declaration to agree on the class before a primitive is reachable.
//
// ADDING AN ENTRY IS A SECURITY DECISION, exactly as adding a name to the old
// allowlist was. The difference is that an entry alone no longer suffices: the
// admission record must also exist, at this exact release version, with a
// digest over this exact declaration.
// ---------------------------------------------------------------------------

import {
  HOST_PRIMITIVE_OWNER_PACKAGE,
  HOST_PRIMITIVE_RELEASE_VERSION,
} from "./host-primitive-identity";
import {
  admissionRecordFor,
  type DelegatedChatAdmissionRecord,
} from "./delegated-chat-admission";
import type { DelegatedChatToolClass } from "./delegated-chat-tool-policy";

/**
 * The classification rule, carried forward verbatim from the migration source
 * so a reviewer can check an entry rather than trust it:
 *
 *   discovery  enumerates the CATALOG of things chat can then act on — screens,
 *              extensions, agents, connected accounts/instances, cube schemas.
 *              Answers "what exists / what can I use?".
 *   read       returns DATA about specific entities — rows, content, versions,
 *              metrics, history, and the read-only lifecycle renders.
 *   dispatch   hands work to an executor that runs under its own actor — agent
 *              runs and run control, artifact emission, proposals into a review
 *              workflow, per-site tool forwarding.
 */
const CORE_EXACT = {
  system_screen_lookup: "discovery",
  extensions_search: "discovery",
  artifact_extension_search: "discovery",
  artifact_extension_get: "discovery",
  artifact_authoring_emit: "dispatch",
  artifact_authoring_chain_get: "read",
  artifacts_get: "read",
  artifacts_list: "read",
  artifact_assertion_list: "read",
  artifact_assertion_get: "read",
  artifact_representation_list: "read",
  artifact_representation_get: "read",
  artifact_representation_latest: "read",
  artifact_review_gates_list: "read",
  artifact_review_gate_render: "read",
  verification_record_render: "read",
  schedule_proposal_render: "read",
  metric_cost_summary: "read",
  metric_cost_by_provider: "read",
  metric_cost_by_agent: "read",
  metric_cost_recent_events: "read",
  metric_cost_budget_get: "read",
  metric_cost_timeseries: "read",
  metric_usage_events: "read",
  metric_usage_summary: "read",
  // Dry-run only (no mutation, no audit row) — see ADMIN_REQUIRED_TOOLS in
  // packages/extensions/src/mcp/registry.ts.
  extensions_purge: "read",
  // THE ONE UNCOMFORTABLE ENTRY, recorded rather than smoothed over. This
  // primitive EXECUTES the destructive purge saga; it is in that package's
  // MUTATING_TOOLS and admin-gated there. None of the three chat-eligible
  // classes describes it honestly — the module header says chat must not reach
  // raw mutations at all, and this name only survives the destructive-verb
  // backstop because neither "purge" nor "execute" is a denied token.
  // Classified `dispatch` as the least-wrong fit (it hands a saga to an
  // executor). Whether it should be admitted AT ALL is a live question, carried
  // forward from #2771 unresolved: removing it here would change the production
  // catalog, which this migration's byte-for-byte invariant exists to prevent.
  extensions_purge_execute: "dispatch",
  agent_list: "discovery",
  agent_get: "read",
  agent_run: "dispatch",
  agent_run_get: "read",
  agent_run_list: "read",
  agent_run_messages_list: "read",
  agent_registry_list: "discovery",
  agent_version_list: "read",
  agent_version_get: "read",
  agent_version_diff: "read",
  skills_catalog_list: "discovery",
  skills_library_list: "discovery",
  skills_installed_get: "read",
  skills_installed_list: "read",
  skills_installed_resolve_for_agent: "read",
  skills_personal_list: "read",
  skills_personal_list_for_agent: "read",
  skills_personal_get: "read",
  objects_list: "read",
  objects_get: "read",
  crm_list_search: "read",
  crm_list_get: "read",
  crm_list_members_get: "read",
  crm_account_search: "read",
  crm_account_get: "read",
  crm_contact_search: "read",
  crm_contact_get: "read",
  crm_contact_find_by_email: "read",
  projects_list: "read",
  projects_get: "read",
  blog_project_list: "read",
  blog_project_get: "read",
  campaigns_list: "read",
  campaigns_get: "read",
  email_outreach_campaign_list: "read",
  email_outreach_campaign_get: "read",
  media_feeds_list: "discovery",
  // THE ADMISSION RATIONALE, carried forward with the entry (it used to sit
  // beside this name in the deleted allowlist). Safe on the
  // injection-hardened perimeter for three reasons:
  //
  //   1. FIELD ALLOWLIST. The result is a fixed, snapshot-tested projection —
  //      connector key, display name, authorized-connection presence, the
  //      POST-AUTHORIZATION connection ids, and the catalog's MCP
  //      primitive-name prefixes (build-time catalog data, no actor state, no
  //      grant). Never a credential, token, secret ref, owner identity,
  //      organization id, or the raw Nango connection identifier (the
  //      token-vault address). The projector is the only constructor of a
  //      result row and a field-allowlist test fails on any added field, so
  //      widening the model-facing surface cannot happen silently
  //      (src/lib/connector-inventory.server.ts).
  //   2. NO SCOPE OR ACTOR INPUT. The schema is empty and strict; identity
  //      comes from the trusted MCP request frame. A prompt-injected LLM has
  //      nothing to ask another tenant's inventory WITH.
  //   3. PER-ROW AUTHORIZATION, NOT ID SECRECY. The underlying reader returns
  //      the whole org's live connection rows (fine for the page's aggregate
  //      math, a leak if serialized), so every row passes the canonical
  //      per-connection `use` gate before it can be emitted.
  connector_inventory_list: "discovery",
  gmail_aliases_list: "discovery",
  linkedin_accounts_list: "discovery",
  drupal_instances_list: "discovery",
  // The governed-invoker pair (#2022 S7 PR-delta): one enumerates a site's
  // forwardable tools, the other forwards one call to the site. The only
  // admitted names with mutation reach, compensated by the S5
  // destructive-confirmation hook and the per-instance tool-policy floor — see
  // the module header of `delegated-chat-tool-policy.ts`.
  wordpress_site_tools_list: "discovery",
  wordpress_site_tool_call: "dispatch",
  dashboards_list: "read",
  dashboards_get: "read",
  dashboards_cube_discover: "discovery",
  dashboards_cube_validate: "read",
  dashboards_cube_load: "read",
  dashboards_cube_chart: "read",
} as const;

const CORE_PROPOSAL_OVERRIDE = {
  dashboards_create: "dispatch",
  dashboards_update: "dispatch",
  agent_run_stop: "dispatch",
  agent_creation_request_propose: "dispatch",
  agent_creation_request_edit: "dispatch",
  agent_creation_request_list: "read",
  agent_creation_request_get: "read",
} as const;
/**
 * Every core/bundled primitive the host declares for, and the class it declares.
 *
 * The two source literals stay SEPARATE above and are merged only here, for the
 * same reason the interim tables did: the proposal-override members are
 * admitted past the destructive-verb backstop by a separately audited
 * mechanism, and folding them into one object would erase the structural signal
 * that says so — a reviewer diffing the core set against its class table would
 * silently pick up seven names that are not in it.
 */
export const HOST_PRIMITIVE_DECLARATIONS: Readonly<Record<string, DelegatedChatToolClass>> =
  Object.freeze({ ...CORE_EXACT, ...CORE_PROPOSAL_OVERRIDE });

/** The class the host declares for a core/bundled primitive, if it declares one. */
export function hostDeclaredDelegatedChatClass(
  name: string,
): DelegatedChatToolClass | undefined {
  return HOST_PRIMITIVE_DECLARATIONS[name.toLowerCase()];
}

/**
 * The RELEASE-VERSIONED admission records the migration writes for the core
 * surface.
 *
 * Each is bound to `(HOST_PRIMITIVE_OWNER_PACKAGE, HOST_PRIMITIVE_RELEASE_VERSION,
 * name, digest(declaration))`, so it authorizes this release's core primitive
 * and nothing else: not a different version of the host, not an extension that
 * registers the same name, and not the same primitive after its declared class
 * changes.
 *
 * A `"none"` declaration would be a core primitive DECLINING chat; it produces
 * no record, because an admission that approves nothing is a contradiction and
 * the absence of a record is already the refusal.
 */
export function coreDelegatedChatAdmissionRecords(options?: {
  reviewedAt?: string;
}): DelegatedChatAdmissionRecord[] {
  const records: DelegatedChatAdmissionRecord[] = [];
  for (const [name, declaredClass] of Object.entries(HOST_PRIMITIVE_DECLARATIONS)) {
    if (declaredClass === "none") continue;
    records.push(
      admissionRecordFor(
        {
          ownerPackage: HOST_PRIMITIVE_OWNER_PACKAGE,
          resolvedVersion: HOST_PRIMITIVE_RELEASE_VERSION,
          primitiveName: name,
          declaredClass,
        },
        options,
      ),
    );
  }
  return records;
}
