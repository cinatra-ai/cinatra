// Recursive Authorization redaction for provider log bodies.
//
// Replaces any value at a key matching `/^authorization$/i` OR exactly
// `"authorization_token"` with the literal string "[REDACTED]". Used by
// writeAnthropicLogFile (this package) to keep Bearer tokens out of the
// .logs/ files on disk.
//
// DUPLICATED at `packages/connector-openai/src/log-redaction.ts` (with the
// same content). Sharing it is blocked by the dep direction:
// llm depends on connector-openai (for writeOpenAILogFile),
// so connector-openai cannot reverse-import without cycling. ~15 LoC is
// cheap enough to duplicate; both copies are exercised by their own
// vitest canary test.

const AUTHORIZATION_KEY = /^authorization$/i;
const AUTHORIZATION_TOKEN_KEY = "authorization_token";
const REDACTED = "[REDACTED]";

export function redactAuthorizationDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuthorizationDeep);
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (AUTHORIZATION_KEY.test(k) || k === AUTHORIZATION_TOKEN_KEY) {
        out[k] = REDACTED;
      } else {
        out[k] = redactAuthorizationDeep(v);
      }
    }
    return out;
  }
  return value;
}
