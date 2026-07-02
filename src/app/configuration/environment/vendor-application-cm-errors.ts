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
 * Detection is text-based and checks BOTH the error message AND a
 * `responseBody` field (the raw cm error envelope carried by
 * `MarketplaceMcpError`), because the refusal can surface either as the
 * transport-level JSON-RPC `McpError`
 * (`MCP error -32010: Unauthorized: User not authenticated`) or wrapped in a
 * `MarketplaceMcpError` whose body carries the same code/phrase.
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
export function isTerminalAuthFailure(err: unknown): boolean {
  const haystacks: string[] = [];
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
