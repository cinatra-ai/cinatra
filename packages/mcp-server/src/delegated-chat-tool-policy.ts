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
  //      connector key, display name, authorized-connection presence, the
  //      POST-AUTHORIZATION connection ids, and the catalog's MCP
  //      primitive-name prefixes (build-time catalog data, no actor state,
  //      no grant). Never a credential, token, secret
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
  // ---------------------------------------------------------------------
  // cinatra#2932 (lifecycle-b W5a) — THE ONE LIFECYCLE DECISION EXCEPTION, and
  // it is here rather than hidden because the plan requires it to be readable:
  //
  //   "The written rule that the model never decides, and its tests, are
  //    rewritten openly to name this one exception where it is enforced."
  //
  // THE NAME CARRIES `decide` ON PURPOSE. It therefore hits the verb backstop
  // below and cannot reach chat without THIS entry plus its typed `CarveOut`
  // twin (src/lib/authz/carve-out.ts, at the delegated-chat-token boundary). A name
  // chosen to slip past the backstop would have concealed the class the
  // primitive belongs to — the opposite of what an exception should do.
  //
  // WHY IT IS SAFE, AND IT IS NOT THE ALLOWLIST THAT MAKES IT SO. Reaching the
  // tool is not permission to use it. The handler refuses unless the request
  // frame carries a server-minted, signed, SINGLE-USE grant naming the person,
  // the message, the ONE bound card and the ONE control — minted only when a
  // human sent a message with that card bound, spent atomically before any
  // effect, and matched against the frame's own identity. A prompt-injected
  // model holds no grant and this primitive does exactly nothing for it; a
  // model that does hold one can press ONE button of the ONE card the person
  // was looking at, once, and the card's own decision path runs under the
  // person's own credential with the same checks, the same CAS and the same
  // audit row a press produces.
  //
  // THE CLASS IS NOT REOPENED. `agent_run_resume`, `approvals_decide` and
  // `agent_creation_request_decide` stay unreachable: this is one named
  // primitive, not a lifted backstop.
  "lifecycle_bound_card_decide",
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
  // cinatra#2935 (lifecycle-b W5d) — the START class, added here for the same
  // defense-in-depth reason and NOT because chat gains anything. Chat already
  // reaches the road through `agent_run`, whose name carries no denied token;
  // what this makes unreachable by construction is a FUTURE `*_start` primitive
  // landing on this allowlist without an explicit, disclosed override. Nothing
  // on this allowlist carries `start` as a whole token today, so it denies
  // nothing that works. The widget's one narrow start (`agent_named_start`) is
  // deliberately absent from chat: a second name for a road chat already has is
  // a duplicate surface, not parity.
  "start",
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

// ---------------------------------------------------------------------------
// TYPED DELEGATED-CHAT DECLARATION (cinatra#2771, owner ruling 2026-08-15).
//
// A registration may DECLARE how it means its primitive to be used on the chat
// surface. Both registration paths carry it — `HostMcpToolRegistration`
// (`ctx.mcp.registerTool`) and the manifest-discovered `(name, config,
// handler)` shape, whose `config` already carried `annotations` / `_meta`.
//
// THE DECLARATION IS NOT AUTHORIZATION, and this module is deliberately the
// place the runtime reader lives so that fact is unmissable: everything above
// in this file — the hard family denies, the destructive-verb token backstop,
// the separately-audited `ALLOWED_PROPOSAL_OVERRIDE`, and the exact-name
// admission — stays authoritative and UNCHANGED. A declaration is applied
// strictly ON TOP, and only in the narrowing direction:
//
//   chat-eligible class  a name the host already admits stays admitted; a name
//                        the host does NOT admit is still refused. Declaring
//                        `read` can never make a denied family reachable.
//   `none`               the registration DECLINES chat; the name is dropped
//                        even though the host would have admitted it.
//   malformed            normalizes to `none`. A value we cannot read must
//                        never be re-read as "undeclared", because undeclared
//                        is NEUTRAL and that would be a widening
//                        reinterpretation of a broken input.
//   absent               neutral. Nothing changes. This is what every
//                        registration in the tree does today, which is why
//                        adding the field changes no current behavior.
//
// WHY THE RUNTIME READER IS HERE AND THE TYPE IS IN THE SDK. The author-facing
// TYPE belongs to `@cinatra-ai/sdk-extensions` (a connector must be able to
// declare without importing host internals), but this package cannot depend on
// the SDK and the SDK's connector contract is deliberately TYPE-ONLY — adding
// a runtime module there would put a new module on every route graph that
// mounts the MCP registry. This module is already on all of them and already
// dependency-free, so the reader is free. The two definitions are pinned
// together by an explicit drift test in `@cinatra-ai/llm` (the one package
// that depends on both).
//
// NOTE ON SCOPE (cinatra#2817). This is the DECLARATION channel only. The
// admission SOURCE is untouched: `isDelegatedChatMcpToolAllowed` above still
// ends at `ALLOWED_EXACT`. Replacing that with version- and declaration-bound
// admission is #2817's, sequenced deliberately because an incorrect swap
// widens what is CALLABLE, not merely what is advertised.
// ---------------------------------------------------------------------------

/**
 * How a registration declares its primitive is meant to be used on the
 * delegated chat surface. Structural mirror of the SDK's author-facing
 * `DelegatedChatToolClass` (drift-tested).
 */
export type DelegatedChatToolClass = "read" | "discovery" | "dispatch" | "none";

/** Every structurally valid declaration value, in declaration order. */
export const DELEGATED_CHAT_TOOL_CLASSES = [
  "read",
  "discovery",
  "dispatch",
  "none",
] as const satisfies readonly DelegatedChatToolClass[];

const VALID_DECLARED_CLASSES: ReadonlySet<string> = new Set(DELEGATED_CHAT_TOOL_CLASSES);

/** The classes that do not, by themselves, remove a name from the chat surface. */
const CHAT_ELIGIBLE_DECLARED_CLASSES: ReadonlySet<string> = new Set([
  "read",
  "discovery",
  "dispatch",
]);

/**
 * Structurally validate one declaration value.
 *
 * `undefined` means UNDECLARED (neutral). Anything present but unreadable
 * normalizes to `"none"` — fail-closed in the narrowing direction, never back
 * to neutral.
 */
export function normalizeDelegatedChatToolClass(
  value: unknown,
): DelegatedChatToolClass | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === "string" && VALID_DECLARED_CLASSES.has(value)) {
    return value as DelegatedChatToolClass;
  }
  return "none";
}

/**
 * Read a declaration off the manifest-discovered registration path's `config`
 * (the `(name, config, handler)` shape).
 *
 * TOTAL, for real: a non-object config, a missing field, or a scalar all read
 * as UNDECLARED, and the property READ ITSELF is guarded. `config` is an
 * arbitrary object supplied by a connector, so `config.delegatedChat` can be an
 * accessor that throws (or a Proxy whose `get` trap does). An escaping throw
 * here would propagate out of a registration pass — on the live transport that
 * is `policedRegisterTool` deciding admission, so the throw would take down the
 * whole per-request capability build rather than refuse one name.
 *
 * A read that throws lands on `"none"`, NOT on `undefined`: the field is
 * PRESENT and unreadable, which is exactly the malformed case, and the same
 * fail-closed-toward-narrowing rule applies — an unreadable declaration must
 * never be re-read as the NEUTRAL "undeclared". Note this also means a throwing
 * getter is not rescued by the interim shim below, which only fills in for a
 * genuinely ABSENT declaration.
 */
export function readDeclaredDelegatedChatClass(
  config: unknown,
): DelegatedChatToolClass | undefined {
  if (typeof config !== "object" || config === null) return undefined;
  let raw: unknown;
  try {
    raw = (config as { delegatedChat?: unknown }).delegatedChat;
  } catch {
    return "none";
  }
  return normalizeDelegatedChatToolClass(raw);
}

/**
 * Whether a declaration leaves a name on the chat surface.
 *
 * TRUE for exactly the three chat-eligible classes. FALSE for `"none"`, for
 * anything that normalized to it, and — since the owner's ruling — for a
 * MISSING declaration. Absent no longer means neutral: an undeclared primitive
 * is unexposed.
 *
 * This NEVER admits on its own — every caller applies it as an AND on top of
 * `isDelegatedChatMcpToolAllowed`.
 *
 * Callers that decide about a name admitted by the LEGACY allowlist must pass
 * this the output of `resolveDelegatedChatClass`, not a raw read: nothing in
 * the tree declares yet, so a raw read would empty the entire interim catalog.
 * See the interim shim below.
 */
export function declarationPermitsDelegatedChat(
  declared: DelegatedChatToolClass | undefined,
): boolean {
  if (declared === undefined) return false;
  return CHAT_ELIGIBLE_DECLARED_CLASSES.has(declared);
}

// ---------------------------------------------------------------------------
// INTERIM DECLARATIONS FOR THE LEGACY ALLOWLIST (cinatra#2771 → deleted by
// cinatra#2817).
//
// WHY THIS EXISTS. `declarationPermitsDelegatedChat` above now reads a MISSING
// declaration as "unexposed", per the owner's ruling. Nothing in the tree
// declares yet, and production admission still seeds from
// `delegatedChatAllowedToolNames()` (the interim source of truth, per the
// owner's correction in issue comment 5307314368). Taken together those two
// facts would empty the ENTIRE delegated-chat catalog the moment the ruling's
// semantics were applied literally — every admitted name is undeclared, so
// every admitted name would be withdrawn.
//
// So the ruling is applied where it belongs (the predicate) and the gap is
// closed where the gap actually is (the interim seeding). This table SYNTHESIZES
// the declaration each legacy-allowlisted primitive would carry if its
// registration declared one. The result: `missing = none` holds for real at the
// predicate, and today's catalog is unchanged BYTE FOR BYTE (asserted in
// `__tests__/delegated-chat-declaration.test.ts`).
//
// SCOPE, AND WHY THIS CANNOT WIDEN. Every consultation is downstream of
// `isDelegatedChatMcpToolAllowed` — the shim is only ever reached for a name
// the legacy allowlist ALREADY admits, so it cannot make a denied family, a
// destructive-verb name, or an unlisted connector primitive reachable. The
// exhaustiveness test requires the table's keys to be exactly
// `delegatedChatAllowedToolNames()`, in both directions, so it can neither
// grow past the allowlist nor silently miss a member of it.
//
// #2817's OBLIGATION. When persisted, version-bound admission replaces
// `ALLOWED_EXACT`, this whole section is DELETED, not migrated — and the
// classes below must be RE-DERIVED from what registrations actually declare,
// never inherited from here. The class values are documentation today (all
// three chat-eligible classes behave identically at the predicate); they must
// not become authorization by inheritance from a table this PR wrote.
//
// THE CLASSIFICATION RULE used below:
//   discovery  enumerates the CATALOG of things chat can then act on — screens,
//              extensions, agents, connected accounts/instances, cube schemas.
//              Answers "what exists / what can I use?".
//   read       returns DATA about specific entities — rows, content, versions,
//              metrics, history, and the read-only lifecycle renders.
//   dispatch   hands work to an executor that runs under its own actor — agent
//              runs and run control, artifact emission, proposals into a review
//              workflow, per-site tool forwarding.
// ---------------------------------------------------------------------------

/**
 * Interim classes for `ALLOWED_EXACT`. Kept in the same order as that set so
 * the two read side by side under review.
 */
const INTERIM_CLASSES_EXACT: Readonly<Record<string, DelegatedChatToolClass>> = {
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

  // The lifecycle PULL surfaces. Read-only by construction — each returns an
  // opaque ref or one rendered card, never a decision.
  artifact_review_gates_list: "read",
  artifact_review_gate_render: "read",
  verification_record_render: "read",
  // Mints an opaque, expiring proposal token and returns a card envelope. It
  // creates no run, writes no trigger row and arms no schedule, so it is `read`
  // on the same terms as the three renders above — NOT `dispatch`, which would
  // overstate what it does.
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
  // classes describes it honestly — the policy header above says chat must not
  // reach raw mutations at all, and this name only survives the destructive-verb
  // backstop because neither "purge" nor "execute" is a denied token. Classified
  // `dispatch` as the least-wrong fit (it hands a saga to an executor).
  //
  // Whether it belongs on the chat allowlist AT ALL is a live question about
  // `ALLOWED_EXACT`, not about the declaration channel, so it is deliberately
  // NOT decided here: removing it would change the production catalog, which
  // this PR's byte-for-byte invariant exists to prevent. Flagged for #2817 /
  // the owner as an admission question.
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

  // "What connections / instances does this actor have?" — the catalog chat
  // consults before it can act through one.
  media_feeds_list: "discovery",
  connector_inventory_list: "discovery",
  gmail_aliases_list: "discovery",
  linkedin_accounts_list: "discovery",
  drupal_instances_list: "discovery",

  // The governed-invoker pair (#2022 S7 PR-δ): one enumerates a site's
  // forwardable tools, the other forwards one call to the site.
  wordpress_site_tools_list: "discovery",
  wordpress_site_tool_call: "dispatch",

  dashboards_list: "read",
  dashboards_get: "read",
  dashboards_cube_discover: "discovery",
  dashboards_cube_validate: "read",
  dashboards_cube_load: "read",
  dashboards_cube_chart: "read",
};

/**
 * Interim classes for `ALLOWED_PROPOSAL_OVERRIDE`.
 *
 * DELIBERATELY A SEPARATE LITERAL, not folded into the table above. The
 * override is a separately-audited exception admitted ABOVE the destructive-verb
 * backstop, and collapsing its members into the same object would erase the one
 * structural signal that says so — a reviewer diffing `ALLOWED_EXACT` against
 * its class table would silently pick up seven names that are not in it. The
 * two are merged only at lookup, below.
 *
 * A class here still grants nothing: these names are admitted by the override,
 * never by their declaration.
 */
const INTERIM_CLASSES_PROPOSAL_OVERRIDE: Readonly<Record<string, DelegatedChatToolClass>> = {
  dashboards_create: "dispatch",
  dashboards_update: "dispatch",
  agent_run_stop: "dispatch",
  agent_creation_request_propose: "dispatch",
  agent_creation_request_edit: "dispatch",
  agent_creation_request_list: "read",
  agent_creation_request_get: "read",
  // cinatra#2932 (lifecycle-b W5a) — the LENT ACTION.
  //
  // `dispatch`, which is the honest class of the three on offer: it hands work
  // to a path that runs under its OWN actor — here the person's own credential,
  // resolved live — rather than returning data (`read`) or enumerating a catalog
  // (`discovery`). The classification is DOCUMENTATION today, as this whole
  // table's header says: all three chat-eligible classes behave identically at
  // the predicate, and what actually gates this primitive is the single-use
  // grant its handler demands. When cinatra#2817 deletes this table, this class
  // must be RE-DERIVED from the registration's own declaration, never inherited
  // from here.
  lifecycle_bound_card_decide: "dispatch",
};

const INTERIM_DECLARATIONS: ReadonlyMap<string, DelegatedChatToolClass> = new Map([
  ...Object.entries(INTERIM_CLASSES_EXACT),
  ...Object.entries(INTERIM_CLASSES_PROPOSAL_OVERRIDE),
] as ReadonlyArray<[string, DelegatedChatToolClass]>);

/**
 * The class the LEGACY allowlist implies for a name it admits, or `undefined`
 * for any other name.
 *
 * INTERIM (cinatra#2817 deletes this). Never an admission decision: a caller
 * must have run `isDelegatedChatMcpToolAllowed` first, exactly as it must
 * before consulting a real declaration.
 */
export function interimDelegatedChatClassFor(
  name: string,
): DelegatedChatToolClass | undefined {
  return INTERIM_DECLARATIONS.get(name.toLowerCase());
}

/**
 * The declaration in force for one host-admitted name: what the registration
 * declared, else the interim class the legacy allowlist implies.
 *
 * This is the ONE place the interim fallback is applied, so all three
 * declaration consumers — the registration choke point, the call-time
 * self-invoker lookup, and the chat catalog resolver's seeding — agree about
 * what a name means, and #2817 has a single call site to delete.
 *
 * A REAL declaration always wins, in BOTH directions: a registration that
 * declares `none` (or ships something malformed, which normalized to `none`) is
 * withdrawn even though the shim would have supplied a class for it.
 */
export function resolveDelegatedChatClass(
  name: string,
  declared: DelegatedChatToolClass | undefined,
): DelegatedChatToolClass | undefined {
  if (declared !== undefined) return declared;
  return interimDelegatedChatClassFor(name);
}
