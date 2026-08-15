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
// AMENDMENT (cinatra#2022 S7 PR-δ): the invariant above — "the chat issuing
// raw MCP mutations" must never reach a mutation directly — is narrowed, not
// repealed, for exactly the two governed-invoker primitives below
// (`wordpress_site_tool_call` / `wordpress_site_tools_list`, already built +
// policy-classified in S2/S3, DARK on every delegated perimeter until this
// PR). Chat MAY reach a generic per-site tool-forwarding primitive,
// compensated by TWO independent layers neither of which existed as
// compensating controls for any other tool on this allowlist: (1) the S5
// destructive-confirmation hook (`connector-instance-destructive-hook.ts`),
// which REQUIRES a rendered confirmation for any destructive-classified
// ability on the `chat` surface (`CONFIRMATION_SURFACE_DEFAULTS.chat ===
// "require"`); (2) the per-instance tool-policy floor
// (`evaluateInstanceToolPolicy`), whose absent-record default this same PR
// flips from OPEN to RESTRICTED+empty — so NOTHING is actually chat-reachable
// for an instance until its site owner explicitly allow-lists specific
// abilities in connector settings. A hijacked / prompt-injected chat LLM
// therefore still cannot delete data through this channel on any instance
// that hasn't been explicitly opened up ability-by-ability; on one that has,
// the destructive-confirmation hook still stands between it and any
// destructive call. No OTHER tool on this allowlist gained mutation reach —
// this is a narrow, disclosed exception scoped to the two forwarding
// primitives, not a change to the allowlist's general read+dispatch+
// discovery posture.
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
  // chat-create-artifact guidance (a reference of the chat-assistant-core
  // router bundle, chat-assistant-core-skill/skills/chat-assistant-core/
  // references/chat-create-artifact.md) is the model-facing dispatcher for
  // the "create me an X artifact" intent. The
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

  // cinatra#2567 (epic #2564 S3) — the CONVERSATIONAL PULL for lifecycle
  // state. All three are strictly read-only and return OPAQUE REFS, never rows:
  // `artifact_review_gates_list` answers with refs for the open review gates
  // the caller may read (per-row run READ access re-checked before a ref is
  // minted), and the two `*_render` primitives turn one ref into one lifecycle
  // CARD whose state the server resolves on every render. Nothing about a gate
  // rides the tool result, and every denial answers one fixed sentence with no
  // ids or counts.
  //
  // They add NO mutation reach. The matching decide/mutate primitives do not
  // exist on any surface — a review is still resolved only on a rendered
  // decision surface, exactly like `agent_run_resume` and `approvals_decide`
  // above — and the decision-verb backstop below now denies that whole class
  // even if a future edit put such a name on this allowlist.
  "artifact_review_gates_list",
  "artifact_review_gate_render",
  "verification_record_render",

  // cinatra#2569 (epic #2564 S5) — the schedule PROPOSAL producer. Read-only in
  // exactly the sense the three above are: it mints an opaque, expiring
  // proposal token and returns a card envelope. It creates no run, writes no
  // trigger row and arms no schedule; §VI's "nothing exists until the reader
  // confirms" is enforced by there being no chat-reachable primitive that
  // confirms — Confirm is a browser session action, and the `confirm`/`arm`/
  // `trigger` verb tokens below keep that whole class unreachable even if a
  // future edit put such a name on this allowlist.
  //
  // The NAME is load-bearing for that guarantee. A propose primitive called
  // `agent_run_trigger_propose` would carry the `trigger` token and need an
  // ALLOWED_PROPOSAL_OVERRIDE entry to reach chat at all — i.e. it would have
  // to bypass the backstop that makes this safe. This one carries no denied
  // token and needs no override.
  "schedule_proposal_render",

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

  // cinatra#2723 — the platform's READ-ONLY connector inventory. Every other
  // connector-shaped entry on this allowlist is a PER-CONNECTOR OPERATIONAL
  // tool scoped to one already-bound connection, so the chat could never answer
  // "which connectors are connected?" and implied the negative instead. This is
  // the missing inventory read, and it is safe on the injection-hardened
  // perimeter for three reasons:
  //
  //   1. FIELD ALLOWLIST. The result is a fixed, snapshot-tested projection —
  //      connector key, display name, authorized-connection presence, and the
  //      POST-AUTHORIZATION connection ids. Never a credential, token, secret
  //      ref, owner identity, organization id, or the raw Nango connection
  //      identifier (the token-vault address). The projector is the only
  //      constructor of a result row and a field-allowlist test fails on any
  //      added field, so widening the model-facing surface cannot happen
  //      silently (src/lib/connector-inventory.server.ts).
  //   2. NO SCOPE OR ACTOR INPUT. The schema is empty and strict; identity comes
  //      from the trusted MCP request frame. A prompt-injected LLM has nothing
  //      to ask another tenant's inventory WITH.
  //   3. PER-ROW AUTHORIZATION, NOT ID SECRECY. The underlying reader returns
  //      the whole org's live connection rows (fine for the page's aggregate
  //      math, a leak if serialized), so every row passes the canonical
  //      per-connection `use` gate before it can be emitted. Returning ids the
  //      caller is authorized to use is deliberate — the invoker re-authorizes
  //      every call live, and the assistants directory already returns
  //      authorized instance ids by design.
  //
  // Read-only: it writes nothing, and its name carries no denied verb token.
  "connector_inventory_list",

  "gmail_aliases_list",
  "linkedin_accounts_list",
  "drupal_instances_list",

  // cinatra#2022 S7 PR-δ — the governed invoker's two
  // generic per-site tool-forwarding primitives (already built + policy-
  // classified in S2/S3; DARK on every delegated perimeter until this PR).
  // Replaces the narrow `wordpress_instances_list` / `wordpress_posts_list`
  // read-only entries above with the actual cutover target. See the
  // AMENDMENT note at the top of this file for the two compensating layers
  // (S5 destructive-confirmation hook + the per-instance tool-policy floor,
  // now RESTRICTED+empty by default) that keep this a narrow, safe exception
  // rather than a blanket mutation grant. `wordpress_site_tools_list` is
  // read-only (catalog discovery); `wordpress_site_tool_call` is the one
  // primitive on this ENTIRE allowlist that can mutate — by design, gated by
  // the two layers above, not by this allowlist itself.
  "wordpress_site_tool_call",
  "wordpress_site_tools_list",

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
  // Dashboard authoring from chat — handler enforces actor + canWrite + config
  // validation + audit row in one transaction (mutation-service.ts:154-214).
  // An enterprise-intelligence-platform chat should be able to author analytics
  // views. Publish/archive stay denied (the publish/archive verb tokens have
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
  // A `*_decide` tool renders a binding approval/rejection at its source (e.g.
  // `approvals_decide`, `agent_creation_request_decide`). Same rationale as
  // `stop`/`resume`: a prompt-injected chat must NEVER auto-approve — decisions
  // stay on the rendered approval surface. Defense-in-depth; these tools are also
  // deny-by-default (never on the allowlist).
  "decide",
  // cinatra#2567 (epic #2564 S3) — the rest of the LIFECYCLE DECISION class,
  // for the same reason `decide` is here. The epic's structural rule is that
  // the model may PRESENT a lifecycle interaction and may never resolve one:
  // approving, rejecting, resuming a held run, confirming a proposal or arming
  // a schedule are all decisions a human makes on a rendered surface. No such
  // primitive exists today on any surface, so these tokens deny nothing that
  // works — they make the class unreachable BY CONSTRUCTION rather than by the
  // allowlist alone, so adding one to ALLOWED_EXACT is not enough to expose it.
  // Whole-token matching keeps the read surface intact: `approvals_list`
  // (token "approvals") and `artifact_review_gates_list` are unaffected, and
  // the only existing primitive carrying one of these exact tokens is
  // `agent_run_resume`, already denied. Like every entry here the tokens are
  // GLOBAL, not lifecycle-scoped: a future unrelated read that happens to
  // contain one as a whole token needs an explicit ALLOWED_PROPOSAL_OVERRIDE
  // entry, exactly as `agent_run_stop` needed one for "stop".
  "approve",
  "reject",
  "resume",
  "confirm",
  "arm",
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

/**
 * The EXACT set of primitive names a delegated CHAT request may see + call,
 * sorted. The widget policy's `delegatedWidgetAllowedToolNames(kind)` twin
 * (`delegated-widget-tool-policy.ts`) — chat had no equivalent until now.
 *
 * Why an accessor and not a read of `ALLOWED_EXACT` (cinatra#2776): the
 * authoritative answer is BOTH allowlists. `ALLOWED_PROPOSAL_OVERRIDE` is
 * accepted independently, above the verb backstop, so a consumer that inspects
 * `ALLOWED_EXACT` alone MISSES every proposal-path primitive and would, for
 * instance, let a serializer flatten `workflow_draft_create` into an inline
 * function schema without any gate noticing. Both sets are unioned here and
 * then run BACK through `isDelegatedChatMcpToolAllowed`, so the family-deny and
 * verb rules apply to the projection exactly as they apply to a live decision:
 * a name that the decision function would refuse can never appear here, however
 * an allowlist is edited.
 *
 * Declarative only. Never used to MAKE an authorization decision — that stays
 * `isDelegatedChatMcpToolAllowed`.
 */
export function delegatedChatAllowedToolNames(): readonly string[] {
  const union = new Set<string>([...ALLOWED_EXACT, ...ALLOWED_PROPOSAL_OVERRIDE]);
  return [...union].filter((name) => isDelegatedChatMcpToolAllowed(name)).sort();
}
