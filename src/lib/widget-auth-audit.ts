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
  | "consent_denied" // user not a member, or explicit deny
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
  | "stream_user_token_rejected";

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
