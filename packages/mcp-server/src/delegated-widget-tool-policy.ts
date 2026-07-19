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
// Dependency-free on purpose (mirrors delegated-chat-tool-policy.ts): imported
// by both packages/mcp-server (the enforcement point) and app-layer
// code/tests, so it must not pull in DB or Next deps.
// ---------------------------------------------------------------------------

/** The connector KIND a widget delegation is bound to (the token's `knd`). */
export type WidgetDelegationKind = "wordpress" | "drupal";

// The CLOSED, KIND-KEYED minimal allowlist. Each kind maps to the EXACT set of
// primitives a widget delegation of that kind may see + call.
//
// The set is INTENTIONALLY just the single `*_content_editor_run` CMS-edit
// primitive per kind. The design (§4.1) permits "explicitly enumerated, kind-
// scoped reads" here IF the editor panel needs them — but on the S5 path the
// editor's own reads happen at HOP-2 under the carrier agent-run's OBO token
// (`buildLlmMcpServerToolForAgentRun`, the #1214 content-editor allowlist), NOT
// under this widget token. The widget turn itself is a SINGLE blocking
// content-editor dispatch, so the minimal (reads-empty) set is the correct,
// tightest blast radius. Adding a read here is a security decision: it MUST be
// kind-scoped (a wordpress read only under "wordpress") and never a wildcard.
const DELEGATED_WIDGET_ALLOWLIST: Readonly<
  Record<WidgetDelegationKind, ReadonlySet<string>>
> = {
  wordpress: new Set<string>(["wordpress_content_editor_run"]),
  drupal: new Set<string>(["drupal_content_editor_run"]),
};

/**
 * Returns true iff a `public_site_widget` delegation of the given `kind` may see
 * + call the named tool. CLOSED / deny-by-default: only the exact kind-scoped
 * entries above are permitted; every other primitive — and every primitive of a
 * DIFFERENT kind (G9) — is refused. An unknown `kind` denies everything
 * (fail-closed).
 *
 * EXACT-MATCH by design: the comparison is case-SENSITIVE
 * against the canonical lowercase primitive names. Unlike the broader chat
 * policy, this closed allowlist must NOT case-fold — a distinct tool registered
 * under a non-canonical casing (e.g. `WordPress_Content_Editor_Run`) is a
 * DIFFERENT primitive and MUST be denied, never treated as the editor by a
 * case-insensitive collision. Every cinatra primitive registers under its
 * canonical lowercase name, so exact-match never rejects the legitimate tool.
 */
export function isDelegatedWidgetMcpToolAllowed(
  kind: WidgetDelegationKind,
  name: string,
): boolean {
  const allowed = DELEGATED_WIDGET_ALLOWLIST[kind];
  if (!allowed) return false;
  return allowed.has(name);
}
