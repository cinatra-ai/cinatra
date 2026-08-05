// Pure cm-error classification helper for the vendor-application server
// actions. Kept OUT of the `"use server"` actions module so it can be exported
// + unit-tested directly (every export from a "use server" file must be an
// async server action; a synchronous helper there would fail the build).

/**
 * Whether a thrown cm error is a TERMINAL authentication/authorization refusal
 * — i.e. cm rejected the call at its auth middleware BEFORE running the ability,
 * so NO reservation row was created server-side.
 *
 * The marketplace MCP auth middleware refuses an unauthenticated/unauthorized
 * principal with JSON-RPC code `-32010` and the message
 * `Unauthorized: User not authenticated` (observed on instances whose bearer
 * resolves locally — e.g. a legacy `instance_identity.tokenCiphertext` — but is
 * rejected by cm). Because the refusal happens before the INSERT, retrying with
 * the same `application_id` can never reconcile: there is nothing on the cm side
 * to match. Distinguishing this from an ambiguous transient/mid-INSERT failure
 * lets `applyVendorApplicationAction` roll back its persist-first marker instead
 * of stranding a false "applied" state.
 *
 * Detection checks a numeric JSON-RPC `code` property, the error message, AND a
 * `responseBody` field (the raw cm error envelope carried by
 * `MarketplaceMcpError`), because the refusal can surface either as the
 * transport-level JSON-RPC error or wrapped in a `MarketplaceMcpError` whose
 * body carries the same code/phrase.
 *
 * The numeric `code` read exists because the MCP client's message format
 * changed. Under `@modelcontextprotocol/sdk@1.29.0` a JSON-RPC error arrived as
 * an `McpError` whose message EMBEDDED the code — `"MCP error -32010:
 * Unauthorized: User not authenticated"` — so the text scan below saw it. Under
 * `@modelcontextprotocol/client@2.0.0` (cinatra#2218 L2b) the same refusal
 * arrives as a `ProtocolError` whose message is the bare server text and whose
 * code lives on `.code`. Without this read the code signal would silently die
 * and detection would rest entirely on the English phrase — which still matches
 * the message cm sends today, so nothing would fail visibly, and the classifier
 * would quietly regress the day that wording changed. Read structurally
 * (`typeof code === "number"`), NOT by scanning `.data`: a false terminal match
 * discards the persist-first idempotency marker and lets a retry mint a
 * duplicate cm row.
 *
 * Matching is DELIBERATELY NARROW — only the `-32010` JSON-RPC code or the
 * explicit "user not authenticated" phrase counts. A bare "unauthorized"
 * substring is NOT sufficient: that word can appear in errors that surface
 * AFTER the reservation row was created (e.g. a downstream
 * authorization/permission failure inside the ability), and a false positive
 * there would wrongly discard the persist-first idempotency marker and let a
 * retry mint a duplicate cm row. The two accepted signals both originate at
 * cm's auth middleware, which runs BEFORE the INSERT, so they reliably mean
 * "no cm row exists".
 */
/** The marketplace MCP auth middleware's pre-INSERT refusal code. */
const CM_AUTH_REFUSAL_JSONRPC_CODE = -32010;

export function isTerminalAuthFailure(err: unknown): boolean {
  const haystacks: string[] = [];
  // Structural JSON-RPC code. Checked FIRST and exactly — the v2 MCP client
  // carries the code here instead of in the message text (see the doc comment).
  if (typeof err === "object" && err !== null) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "number" && code === CM_AUTH_REFUSAL_JSONRPC_CODE) {
      return true;
    }
  }
  if (err instanceof Error && typeof err.message === "string") {
    haystacks.push(err.message);
  }
  // MarketplaceMcpError carries the raw cm error body separately from `message`.
  // Guard the property read against null/non-object inputs (the catch binding is
  // `unknown` — a thrown non-Error value reaches here too).
  if (typeof err === "object" && err !== null) {
    const responseBody = (err as { responseBody?: unknown }).responseBody;
    if (typeof responseBody === "string") {
      haystacks.push(responseBody);
    }
  }
  if (haystacks.length === 0) {
    return false;
  }
  const text = haystacks.join("\n").toLowerCase();
  // JSON-RPC auth-refusal code emitted by the marketplace MCP auth middleware.
  // Boundary-anchored so it matches the code -32010 exactly and never a larger
  // number that merely starts/ends with those digits (e.g. -320100, -132010).
  if (/(?<!\d)-32010(?!\d)/.test(text)) {
    return true;
  }
  // Explicit unauthenticated phrasing ("Unauthorized: User not authenticated").
  // The full phrase — NOT a bare "unauthorized" — is required to avoid
  // false-positives on post-INSERT authorization errors.
  return text.includes("user not authenticated");
}
