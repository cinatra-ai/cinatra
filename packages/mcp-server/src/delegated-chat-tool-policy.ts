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
// Therefore the perimeter is DENY-BY-DEFAULT and read + dispatch + discovery
// only. It used to be a hand-listed allowlist of ~110 exact names; since
// cinatra#2817 it is version- and declaration-bound admission — a primitive is
// reachable only when the host/marketplace has REVIEWED its declaration for its
// exact owning package at its exact resolved version. This module keeps the two
// UNCONDITIONAL backstops (the family denies and the mutating-verb denylist),
// the separately audited proposal override, and the declaration channel; the
// ordered decision that combines them with the admission record lives in
// `delegated-chat-admission.ts`.
//
// WHAT THE ALLOWLIST COST, and why it is gone: a marketplace-installed
// connector's primitives stayed unreachable in delegated chat until someone
// edited this file and cut a release. That is not a security property, it is a
// deployment bottleneck wearing one — the review still happens, it just no
// longer has to be a core-file edit.
//
// AMENDMENT (cinatra#2022 S7 PR-δ): the invariant above — "the chat issuing
// raw MCP mutations" must never reach a mutation directly — is narrowed, not
// repealed, for exactly the two governed-invoker primitives below
// (`wordpress_site_tool_call` / `wordpress_site_tools_list`, already built +
// policy-classified in S2/S3, DARK on every delegated perimeter until this
// PR). Chat MAY reach a generic per-site tool-forwarding primitive,
// compensated by TWO independent layers neither of which existed as
// compensating controls for any other admitted tool: (1) the S5
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
// destructive call. No OTHER admitted tool gained mutation reach — this is a
// narrow, disclosed exception scoped to the two forwarding primitives, not a
// change to the perimeter's general read+dispatch+discovery posture.
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
// are INTENTIONALLY unadmitted. They are admin-only at the
// handler boundary as well (see resolveIsPlatformAdminFromSession gates on
// each of the four handlers in packages/agents/src/mcp/handlers.ts). The
// non-admin authoring path uses an isolated `agent_creation_request`
// proposal store — never these live tools.
// ---------------------------------------------------------------------------

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

// Defense-in-depth: even if a primitive is mistakenly admitted, deny anything
// whose name carries a mutating / side-effecting / destructive verb. This is a
// backstop, not the primary gate (version- and declaration-bound admission is).
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
  // admission alone, so reviewing one is not enough to expose it.
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

// ---------------------------------------------------------------------------
// THE HARD BACKSTOPS (cinatra#2817 slice 3).
//
// These three are all that remains of `isDelegatedChatMcpToolAllowed`. The
// predicate itself is GONE, along with the ~110-name `ALLOWED_EXACT` set it
// ended at: admission is now the version- and declaration-bound record, decided
// by the shared evaluator in `delegated-chat-admission.ts`.
//
// What survives is the part that was never an allowlist. The family denies and
// the destructive-verb backstop are UNCONDITIONAL refusals, behaviourally
// unchanged, and they are separately named here so a caller must state which
// one it is applying instead of getting all four rules from one opaque boolean.
// The proposal override keeps its exact position between them.
//
// NONE OF THESE ADMITS ANYTHING. Each answers only "is this name refused by
// this specific rule?". Admission is elsewhere, on purpose.
// ---------------------------------------------------------------------------

/**
 * Is the name in a family that must never be reachable from chat, whatever else
 * is true about it? Privilege, system and job-control namespaces.
 *
 * UNCONDITIONAL: no declaration, no admission and no proposal override reaches
 * past this.
 */
export function isHardDeniedDelegatedChatFamily(name: string): boolean {
  const normalized = name.toLowerCase();
  if (DENIED_FAMILY_PREFIXES.some((p) => normalized.startsWith(p))) return true;
  return DENIED_FAMILY_SUBSTRINGS.some((p) => normalized.includes(p));
}

/**
 * Does the name carry a mutating / side-effecting / destructive verb TOKEN?
 *
 * Matched as WHOLE underscore-delimited tokens, NOT raw substrings — so
 * `skills_installed_get` (token "installed") is not blocked by the `install`
 * verb. Case-folded first, because this is a DENY: a name that differs only in
 * casing must not slip past a refusal.
 */
export function carriesDeniedDelegatedChatVerbToken(name: string): boolean {
  return name
    .toLowerCase()
    .split("_")
    .filter(Boolean)
    .some((t) => DENIED_VERB_TOKENS.has(t));
}

/**
 * Is the name in the vetted, separately audited proposal-only override?
 *
 * Bypasses ONLY the verb backstop, exactly as it always did — never the family
 * denies, and (since #2817) never admission either. These names are core
 * primitives with migrated host declarations and release-versioned admission
 * records, so their behaviour is preserved without an exception to "nothing
 * outside the exactly admitted set is callable".
 */
export function isDelegatedChatProposalOverrideName(name: string): boolean {
  return ALLOWED_PROPOSAL_OVERRIDE.has(name.toLowerCase());
}

/** The proposal-override names, sorted. Diagnostic; never an admission. */
export function delegatedChatProposalOverrideNames(): readonly string[] {
  return [...ALLOWED_PROPOSAL_OVERRIDE].sort();
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
// SCOPE (cinatra#2817, slice 3 landed). This is the DECLARATION channel only,
// and it is now HALF of an admission rather than a narrowing hint on top of a
// name allowlist: the declaration a registration carries is digested and looked
// up against the reviewed record. The declaration alone still admits nothing —
// a class an extension declares for itself matches no review, and the shared
// evaluator refuses it as `self_classified_only`.
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
 * This NEVER admits on its own. The shared evaluator applies it as one step of
 * the ordered decision, and a declaration that survives it still has to match a
 * reviewed, version-bound admission record before anything is reachable.
 */
export function declarationPermitsDelegatedChat(
  declared: DelegatedChatToolClass | undefined,
): boolean {
  if (declared === undefined) return false;
  return CHAT_ELIGIBLE_DECLARED_CLASSES.has(declared);
}
