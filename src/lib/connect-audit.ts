import "server-only";

// Structured audit emitter for cinatra#221 "Connect with Cinatra" (§6).
//
// Emits one structured JSON log line per provisioning event with the actor /
// org / client / origin / ip / ua context. SECRETS ARE NEVER LOGGED: this
// emitter has no parameter through which a plaintext `code`, `code_verifier`,
// `cnx_*`, `cci_*`, or `webhookSecret` could pass — only a code/credential HASH
// (already non-reversible) is ever accepted, via the `codeHash` field. A
// defensive scrubber additionally drops any value that looks like a live secret
// before it is serialized, so a future careless caller cannot leak one.
//
// Kept deliberately decoupled from the @cinatra/authz `audit_events` table
// (which has a different actor-principal shape); this is the connector-domain
// audit trail. If a richer sink is wired later, swap the emit() body — the call
// sites stay the same.

export type ConnectAuditEvent =
  | "authorize_viewed"
  | "authorize_approved"
  | "authorize_denied"
  | "code_issued"
  | "install_code_issued"
  | "exchange_success"
  | "exchange_failure"
  | "site_created"
  | "site_revoked"
  | "site_rotated";

export type ConnectAuditFields = {
  actor?: string | null;
  orgId?: string | null;
  client?: string | null;
  redirectUri?: string | null;
  widgetOrigin?: string | null;
  callbackOrigin?: string | null;
  ip?: string | null;
  ua?: string | null;
  credentialVersion?: number | null;
  // sha256 HASH ONLY — never a plaintext code/credential.
  codeHash?: string | null;
  siteId?: string | null;
  reason?: string | null;
};

// Patterns that must NEVER appear in an audit line. Defense-in-depth against a
// careless caller passing a live secret in a free-text field (e.g. `reason`).
const SECRET_LIKE = [/cnx_[0-9a-f-]{36}_/i, /cci_[A-Za-z0-9_-]{8,}/];

function scrubValue(value: unknown): unknown {
  if (typeof value !== "string") return value;
  for (const re of SECRET_LIKE) {
    if (re.test(value)) return "[redacted-secret]";
  }
  return value;
}

export function emitConnectAudit(
  event: ConnectAuditEvent,
  fields: ConnectAuditFields = {},
): void {
  const scrubbed: Record<string, unknown> = { event };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    scrubbed[k] = scrubValue(v);
  }
  scrubbed.at = new Date().toISOString();
  try {
    console.info(`[connect-audit] ${JSON.stringify(scrubbed)}`);
  } catch {
    /* never throw from the audit path */
  }
}
