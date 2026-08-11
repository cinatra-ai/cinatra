import "server-only";

// Structured audit emitter for cinatra#407 hosted /widget-auth (Plan B, EPIC
// #406). One structured JSON line per event with actor / org / site / client /
// agent / origin / ip / ua context. SECRETS ARE NEVER LOGGED: there is no
// parameter through which a plaintext code, code_verifier, `cnx_*`, or `cwu_*`
// token could pass. A defensive scrubber additionally drops any value that
// looks like a live secret before serialization, so a careless future caller
// cannot leak one through a free-text field.
//
// Mirrors src/lib/connect-audit.ts (the per-site connect provisioning audit),
// kept as a separate domain trail for the per-USER login surface.

export type WidgetAuthAuditEvent =
  | "init_success"
  | "init_failure"
  | "page_viewed"
  | "page_invalid_txn"
  // The hosted widget login refused to authorize: no session, a stale/replayed
  // transaction, or the signed-in user is not a member of the transaction's org.
  // The NAME predates cinatra#2631 (which removed the separate consent step —
  // signing in is the grant now) and is kept so the existing trail stays one
  // series for its consumers; it has always meant "this login did not become an
  // authorization".
  | "consent_denied"
  | "code_issued"
  | "redeem_success"
  | "redeem_failure"
  // cinatra#408 stream-side dual-token validation (CHILD 3). The stream route
  // emits exactly one of these per per-user widget request: an AUTHORIZED event
  // when the `cwu_` validates and a per-user OBO override is minted (this marks
  // the authorization DECISION and precedes the actual A2A dispatch — the
  // carrier run's own lifecycle is the run-outcome trail, so the name does not
  // imply the dispatch succeeded), or a reject (with a reason CODE — never the
  // failing secret) on any fail-closed deny.
  | "stream_user_dispatch_authorized"
  | "stream_user_token_rejected"
  // cinatra#1221 S5 — the SAME dual-token DECISION on the unified
  // /api/assistants/chat broker-auth branch (the widget moves off the stream
  // relay onto the assistant runtime). Same authorization-decision semantics as
  // the stream-side pair above (the AUTHORIZED event precedes the LLM turn; the
  // turn/carrier lifecycle is the run-outcome trail).
  | "assistant_chat_widget_dispatch_authorized"
  | "assistant_chat_widget_token_rejected"
  // cinatra#1875 W2 AC#3 — the audience closure on the broker-auth branch. Site
  // auth is NOT the installation's audience: emitted (reason-coded, never a
  // secret) when the verified end user passes the dual-token sequence but is
  // OUT of the selected assistant's audience, so the turn 404-hides.
  | "assistant_chat_widget_out_of_audience"
  // cinatra#1998 Lane A — a sessionless broker-auth caller passed the SAME
  // dual-token sequence at GET /api/assistants/chat/capabilities and was served
  // the static advertisement (this authenticates the capability READ; it does
  // not authorize a run — the turn's own dual-token decision above is the
  // dispatch record). Reason-coded/scrubbed like its siblings; never a secret.
  | "assistant_chat_capabilities_broker_advertised"
  // cinatra#2574 (epic #2564 S8a) — the authorization DECISION for a widget
  // LIFECYCLE READ. Emitted by the one actor-construction seam every widget
  // lifecycle read goes through: authorized once the `cwu_` proved the
  // lifecycle grant AND the live org membership held, rejected (reason-coded,
  // never a secret and never a row identifier) on any fail-closed deny.
  | "widget_lifecycle_read_authorized"
  | "widget_lifecycle_read_rejected"
  // cinatra#2575 (epic #2564 S8b, corrected 2026-08-11) — the same DECISION, for
  // a widget lifecycle DECIDE. A separate pair rather than a shared one so an
  // investigation of a suspicious decision does not have to read every read
  // (codex round 0, finding 6). Same seam, same fields, same scrubbing.
  | "widget_lifecycle_decide_authorized"
  | "widget_lifecycle_decide_rejected";

export type WidgetAuthAuditFields = {
  actor?: string | null; // userId (never an email/secret)
  orgId?: string | null;
  siteId?: string | null;
  client?: string | null;
  agentSlug?: string | null;
  siteOrigin?: string | null;
  instanceId?: string | null;
  ip?: string | null;
  ua?: string | null;
  reason?: string | null;
  /**
   * The extension scopes a consent granted / a token carried (cinatra#2574),
   * space-delimited. Capability NAMES only — the scope vocabulary is public and
   * contains no credential, and the scrubber still runs over it.
   */
  grantedScopes?: string | null;
};

// Patterns that must NEVER appear in an audit line (defense-in-depth against a
// careless caller passing a live secret in a free-text field).
const SECRET_LIKE = [
  /cnx_[0-9a-f-]{36}_/i, // per-site credential
  /cwu_[A-Za-z0-9_-]{8,}/, // user widget token
];

function scrubValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  for (const re of SECRET_LIKE) {
    if (re.test(value)) return "[redacted-secret]";
  }
  return value;
}

export function emitWidgetAuthAudit(
  event: WidgetAuthAuditEvent,
  fields: WidgetAuthAuditFields = {},
): void {
  const scrubbed: Record<string, unknown> = { event };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    scrubbed[k] = scrubValue(v);
  }
  scrubbed.at = new Date().toISOString();
  try {
    console.info(`[widget-auth-audit] ${JSON.stringify(scrubbed)}`);
  } catch {
    /* never throw from the audit path */
  }
}
