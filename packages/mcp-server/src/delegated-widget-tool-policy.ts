// ---------------------------------------------------------------------------
// Delegated PUBLIC-SITE-WIDGET MCP tool policy (S5-W1 §4.1 / §5 G9, G12).
//
// A `public_site_widget` delegated OBO token carries an authenticated end
// user's identity across the MCP boundary onto `/api/assistants/chat` for the
// WordPress / Drupal public-site widget path. Unlike the chat delegation, this
// token exists to do ONE thing: drive the kind's `*_content_editor_run` CMS-edit
// primitive AS THE END USER against the server-pinned instance.
//
// THE LOAD-BEARING TIGHTENING. This policy MUST NOT reuse the broad
// `delegated-chat` allowlist. `delegated-chat` permits the full chat-discoverable
// read/dispatch surface; a stolen/replayed widget token riding that allowlist
// could invoke ANY chat-permitted primitive as the user (the instance pin only
// guards `content_editor_run`). Instead this is a CLOSED, KIND-KEYED, minimal
// allowlist: a `wordpress`-kind token's allowlist contains ONLY wordpress
// primitives; a `drupal`-kind token's ONLY drupal primitives. Every other
// cinatra primitive is DENIED for a widget delegation regardless of the user's
// standing — capping the blast radius of a leaked widget token to the single
// CMS-edit primitive for its bound kind (G12), strictly narrower than
// `delegated-chat` (so it can never widen privilege).
//
// KIND ↔ PRIMITIVE BINDING (G9). Because the allowlist is keyed on the token's
// `knd` claim, a `wordpress` widget token can NEVER see or call
// `drupal_content_editor_run` (and vice versa): the cross-kind primitive is
// simply not in that kind's set. This is the MCP-boundary half of the G9
// handle↔token binding (the route enforces the other half).
//
// THE ONE WIDENING (cinatra#2577, epic #2564 S8d; corrected 2026-08-11). The set
// gained the READ-ONLY lifecycle pull primitives — ALL of them, the same four the
// chat policy holds — and nothing else. They are the SAME handlers the chat
// surface calls (`src/lib/lifecycle/lifecycle-pull-mcp.ts` and
// `src/lib/lifecycle/schedule-proposal-mcp.ts`), which resolve their own
// principal from the request frame, re-authorize every row, and answer one fixed
// refusal sentence otherwise — so being visible on a widget turn is not being
// readable by it. What this policy grants is REACH; the grant (`lifecycle.read`
// on the `cwu_`), the actor and the per-row access check are the handlers'.
//
// PARITY IS THE POINT. An earlier revision withheld the schedule proposal from
// the widget on the premise that "a widget visitor never arms a schedule". A
// widget reader is not a visitor — they are the signed-in person, with the rights
// they have inside Cinatra — so the widget reaches the same pull surface as
// first-party chat, and a structural test pins the two sets equal.
//
// WHAT DOES NOT CHANGE, ON ANY SURFACE: no lifecycle DECIDE/MUTATE primitive is
// here, and the verb backstop below makes adding one insufficient to expose it.
// `schedule_proposal_render` CREATES NOTHING — it mints an opaque, expiring
// proposal and returns a card envelope; arming is a human session action from
// the card, which is exactly why its name carries no denied verb token.
//
// Dependency-free on purpose (mirrors delegated-chat-tool-policy.ts): imported
// by both packages/mcp-server (the enforcement point) and app-layer
// code/tests, so it must not pull in DB or Next deps.
// ---------------------------------------------------------------------------

/** The connector KIND a widget delegation is bound to (the token's `knd`). */
export type WidgetDelegationKind = "wordpress" | "drupal";

/**
 * The kind's CMS-edit dispatch primitive — the reason the widget delegation
 * exists. One per kind, and the G9 binding is that a token only ever holds its
 * own (see the allowlist below).
 */
const WIDGET_CONTENT_EDITOR_TOOLS: Readonly<Record<WidgetDelegationKind, string>> = {
  wordpress: "wordpress_content_editor_run",
  drupal: "drupal_content_editor_run",
};

/**
 * The READ-ONLY lifecycle pull primitives (cinatra#2567 S3 + #2569 S5),
 * reachable on a widget delegation as of S8d. KIND-INDEPENDENT on purpose, and
 * that is not a loosening of the G9 kind binding: G9 exists because a
 * `wordpress` token must not drive a `drupal` CMS instance, and these primitives
 * address neither. They address the caller's own cinatra lifecycle work through
 * the caller's own standing, so keying them on the connector kind would encode a
 * distinction that does not exist.
 *
 * THE NAMES ARE THE CONTRACT and they are duplicated here as literals because
 * this module is deliberately dependency-free. A rename in the producer without
 * a matching edit here does not fail open — it fails CLOSED (the renamed tool is
 * simply not allowed) — and the structural test pins this list equal to the chat
 * policy's, so both the silent-withdrawal and the silent-divergence directions
 * are caught.
 */
/**
 * The ONE lifecycle DECISION primitive a widget delegation may reach
 * (cinatra#2932, lifecycle-b W5a) — the lent action.
 *
 * PARITY IS THE REASON IT IS HERE. The epic's rule is that the person sees and
 * does the same things inside a third-party application as in the app, and the
 * structural test pins the widget's lifecycle set EQUAL to chat's in both
 * directions. Withholding this one primitive from the widget would not be a
 * safety property; it would be the widget quietly refusing a button the person
 * can press on the card in front of them.
 *
 * IT IS NOT A WIDER SURFACE. The grant the handler demands is minted for a
 * message the person typed, names one card and one control, and is spent once;
 * inside a third-party application the deciding authority is built fresh from
 * the widget's own credential at the call, never from the conversation's weaker
 * runtime. Nothing is offered here that the widget's own credential cannot do.
 */
export const DELEGATED_WIDGET_BOUND_CARD_ACTION = "lifecycle_bound_card_decide";

/**
 * The ONE narrowly scoped START a widget delegation may reach (cinatra#2935,
 * lifecycle-b W5d).
 *
 * WHY IT IS HERE. Until this slice the widget's only way to start an agent was
 * the server-side sentence-matcher that ran BEFORE the model read the message —
 * the defect the plan removes. Removing it without this entry would take a real
 * capability away from a person inside a third-party application, which the plan
 * forbids: "Once the matcher is gone the widget keeps the capability the right
 * way: its assistant gets one narrowly scoped start, authorized afresh from the
 * widget's own credential at the call and fenced to the agents the signed-in
 * person may start."
 *
 * IT IS NOT `agent_run`, AND THAT IS THE POINT. The chat allowlist holds
 * `agent_run` with its template ids, timeouts and polling surface; this closed
 * allowlist deliberately does not (cinatra#2790 pins that), and it still does
 * not. What is added is one door: a package name and the inputs the person gave.
 * The handler resolves the person's own LIVE standing at the call and starts the
 * run as them through `agent_run`'s own execute gate, so an agent they may not
 * start is REFUSED and the platform's own refusal is relayed. Nothing is offered
 * here that the widget's own credential cannot do.
 *
 * ITS NAME CARRIES `start`, which the backstop below now denies, so it needs
 * this entry AND the exact-name exception in `isDelegatedWidgetMcpToolAllowed`
 * AND its typed `CarveOut` twin to be reachable at all — the same disclosure
 * shape the lent action has, for the same reason.
 */
export const DELEGATED_WIDGET_NAMED_AGENT_START = "agent_named_start";

export const DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS: readonly string[] = [
  "artifact_review_gates_list",
  "artifact_review_gate_render",
  "verification_record_render",
  "schedule_proposal_render",
];

// The CLOSED, KIND-KEYED minimal allowlist. Each kind maps to the EXACT set of
// primitives a widget delegation of that kind may see + call.
//
// The set is the kind's single `*_content_editor_run` CMS-edit primitive plus
// the read-only lifecycle pulls (all of them — first-party parity). The design (§4.1) permits "explicitly
// enumerated, kind-scoped reads" here IF the surface needs them — the CMS
// editor's own reads still do NOT, because on the S5 path they happen at HOP-2
// under the carrier agent-run's OBO token (`buildLlmMcpServerToolForAgentRun`,
// the #1214 content-editor allowlist), never under this widget token. Adding
// anything else is a security decision: a CONNECTOR read MUST be kind-scoped (a
// wordpress read only under "wordpress") and never a wildcard, and no primitive
// that resolves a lifecycle interaction may be added at all.
const DELEGATED_WIDGET_ALLOWLIST: Readonly<
  Record<WidgetDelegationKind, ReadonlySet<string>>
> = {
  wordpress: new Set<string>([
    WIDGET_CONTENT_EDITOR_TOOLS.wordpress,
    ...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
    DELEGATED_WIDGET_BOUND_CARD_ACTION,
    DELEGATED_WIDGET_NAMED_AGENT_START,
  ]),
  drupal: new Set<string>([
    WIDGET_CONTENT_EDITOR_TOOLS.drupal,
    ...DELEGATED_WIDGET_LIFECYCLE_READ_TOOLS,
    DELEGATED_WIDGET_BOUND_CARD_ACTION,
    DELEGATED_WIDGET_NAMED_AGENT_START,
  ]),
};

/**
 * The DECISION/MUTATION verb backstop, mirroring the chat policy's
 * (`delegated-chat-tool-policy.ts`) and applied for the same reason: the
 * allowlist is the primary gate, and this makes the class unreachable BY
 * CONSTRUCTION so that adding an entry to the allowlist is NOT enough to expose
 * it. The epic's structural rule is that the model may PRESENT a lifecycle
 * interaction and may never resolve one; on the widget branch that rule has to
 * survive a one-line edit to the set above.
 *
 * Matched as WHOLE underscore-delimited tokens, never raw substrings, so the
 * allowed surface is untouched: `wordpress_content_editor_run` (tokens
 * "wordpress", "content", "editor", "run"), `artifact_review_gates_list` and the
 * three `*_render` primitives carry none of these tokens. `schedule_proposal_
 * render` is deliberately named so — a propose primitive called
 * `agent_run_trigger_propose` would carry the `trigger` token and be denied here,
 * which is the property that keeps arming unreachable from any transport.
 */
const DELEGATED_WIDGET_DENIED_VERB_TOKENS: ReadonlySet<string> = new Set<string>([
  "decide",
  "approve",
  "reject",
  "resume",
  "confirm",
  "arm",
  "create",
  "update",
  "delete",
  "write",
  "publish",
  "unpublish",
  "cancel",
  "stop",
  "skip",
  "apply",
  "submit",
  "commit",
  "emit",
  "set",
  "send",
  "install",
  "uninstall",
  "archive",
  "restore",
  "upsert",
  "trigger",
  // cinatra#2935 (lifecycle-b W5d). Starting a run is a mutation, so the token
  // joins the class the backstop makes unreachable BY CONSTRUCTION — which is
  // what forces the one start this slice adds to be an exact-name exception
  // somebody can find rather than a quiet allowlist line. Whole-token matching
  // keeps every allowed name intact: the ONLY name on either delegated policy
  // that carries `start` as a token is the one narrow start added above, which is
  // admitted by exact name ABOVE this backstop — so this token denies nothing
  // that works, and everything that is not that one disclosed entry.
  "start",
]);

/**
 * Does this primitive name carry a decision/mutation verb token? Exported so the
 * structural test can drive the backstop directly against a synthetically
 * widened allowlist — the negative control that proves the rule has teeth.
 */
export function carriesDelegatedWidgetDeniedVerb(name: string): boolean {
  return name
    .split("_")
    .filter(Boolean)
    .some((token) => DELEGATED_WIDGET_DENIED_VERB_TOKENS.has(token));
}

/**
 * The EXACT set a widget delegation of this kind may see + call, sorted. The
 * declared contents of the policy, exposed for structural inspection (the S8d
 * conformance test asserts the whole set, so a silent addition fails as loudly
 * as a silent removal). Never used to make an authorization decision — that is
 * `isDelegatedWidgetMcpToolAllowed`, which also applies the verb backstop.
 */
export function delegatedWidgetAllowedToolNames(
  kind: WidgetDelegationKind,
): readonly string[] {
  const allowed = DELEGATED_WIDGET_ALLOWLIST[kind];
  if (!allowed) return [];
  return [...allowed].sort();
}

/**
 * Returns true iff a `public_site_widget` delegation of the given `kind` may see
 * + call the named tool. CLOSED / deny-by-default: only the exact kind-scoped
 * entries above are permitted; every other primitive — and every connector
 * primitive of a DIFFERENT kind (G9) — is refused. An unknown `kind` denies
 * everything (fail-closed), and the decision/mutation verb backstop denies its
 * whole class regardless of what the allowlist says.
 *
 * EXACT-MATCH by design: the comparison is case-SENSITIVE
 * against the canonical lowercase primitive names. Unlike the broader chat
 * policy, this closed allowlist must NOT case-fold — a distinct tool registered
 * under a non-canonical casing (e.g. `WordPress_Content_Editor_Run`) is a
 * DIFFERENT primitive and MUST be denied, never treated as the editor by a
 * case-insensitive collision. Every cinatra primitive registers under its
 * canonical lowercase name, so exact-match never rejects the legitimate tool.
 * The verb backstop is the one comparison that DOES case-fold its input first,
 * because it is a deny: a name that only differs in casing must not slip past a
 * refusal.
 */
export function isDelegatedWidgetMcpToolAllowed(
  kind: WidgetDelegationKind,
  name: string,
): boolean {
  const allowed = DELEGATED_WIDGET_ALLOWLIST[kind];
  if (!allowed) return false;
  // THE ONE DISCLOSED EXCEPTION (cinatra#2932, lifecycle-b W5a). The lent
  // action's name carries `decide`, so the backstop below would deny it; it is
  // admitted here, by exact name, ABOVE the backstop — the same shape the chat
  // policy's override has, and for the same reason: an exception that has to be
  // written down is an exception somebody can find. Exact match, never
  // case-folded: a differently-cased name is a DIFFERENT primitive and falls
  // through to the backstop, which denies it.
  if (name === DELEGATED_WIDGET_BOUND_CARD_ACTION && allowed.has(name)) return true;
  // THE SECOND DISCLOSED EXCEPTION (cinatra#2935, lifecycle-b W5d). The one
  // narrow start's name carries `start`, which the backstop below now denies; it
  // is admitted here, by exact name, ABOVE the backstop, exactly as the lent
  // action is. Exact match, never case-folded: a differently-cased name is a
  // DIFFERENT primitive and falls through to the backstop, which denies it.
  if (name === DELEGATED_WIDGET_NAMED_AGENT_START && allowed.has(name)) return true;
  if (carriesDelegatedWidgetDeniedVerb(name.toLowerCase())) return false;
  return allowed.has(name);
}
