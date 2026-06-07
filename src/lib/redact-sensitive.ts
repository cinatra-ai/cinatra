import "server-only";

// -----------------------------------------------------------------------------
// Structural log-redaction helper.
//
// Used at sites that log HTTP responses, errors, or audit events. Walks objects
// deep and replaces values at known sensitive keys with `[REDACTED]`. The helper
// is structural (key-based) so it stays readable; the additive
// STRING_PATTERN_SCRUBS layer catches Bearer-token / Authorization patterns that
// show up INSIDE string values (e.g. error.message text or stringified response
// bodies).
//
// The redaction-regression test is the primary gate for the whole flow; this
// helper makes it easy for callers to avoid leaks in the first place.
// -----------------------------------------------------------------------------

const REDACTED = "[REDACTED]";
const CIRCULAR = "[CIRCULAR]";

const SENSITIVE_KEYS = new Set([
  "Authorization",
  "authorization",
  "token",
  "requestSecret",
  "request_secret",
]);

// Structural key-based redaction does not catch Bearer tokens or request-secret
// values that show up INSIDE a string value (e.g. `error.message = "Failed:
// Authorization: Bearer abc"`). These narrow regexes scrub known patterns in
// string content as a defence-in-depth layer. The redaction-regression test is
// still the primary gate.
//
// Patterns are intentionally narrow to avoid false positives. STRING_PATTERN_
// SCRUBS should be additive only; do not remove or generalize patterns without
// review. If a new leak shape is discovered, add another entry rather than
// broadening an existing one.
const STRING_PATTERN_SCRUBS: Array<[RegExp, string]> = [
  // "Authorization: Bearer <token>" (case-insensitive on the literal). The
  // bearer portion is the part replaced; the surrounding "Authorization: "
  // is kept so the message remains readable.
  [/(\bauthorization\s*:\s*Bearer\s+)\S+/gi, "$1[redacted]"],
  // Bare "Bearer <token>" outside a header context.
  [/(\bBearer\s+)[A-Za-z0-9._\-]+/g, "$1[redacted]"],
];

function scrubString(s: string): string {
  let out = s;
  for (const [pattern, replacement] of STRING_PATTERN_SCRUBS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/**
 * Deep-walks `value` and returns a new structure with all values at
 * `SENSITIVE_KEYS` replaced with `[REDACTED]`. String values are passed
 * through `scrubString` to redact embedded Bearer/Authorization patterns.
 * Error instances are coerced safely (`message` is scrubbed, `stack` is
 * wholesale redacted, `cause` is walked).
 *
 * Cycle-safe via a `WeakSet`; self-referential structures resolve to a
 * `[CIRCULAR]` marker rather than infinite-looping.
 *
 * Never mutates the input.
 */
export function redactSensitive(value: unknown): unknown {
  return walk(value, new WeakSet());
}

function walk(value: unknown, seen: WeakSet<object>): unknown {
  // Primitives: strings get scrubbed; everything else round-trips.
  if (value === null || value === undefined) return value;
  if (typeof value === "string") return scrubString(value);
  if (typeof value !== "object" && typeof value !== "function") return value;

  // Cycle guard.
  if (seen.has(value as object)) return CIRCULAR;
  seen.add(value as object);

  // Error instances: coerce message via scrubString, redact stack wholesale,
  // recurse on cause if present.
  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: scrubString(String(value.message ?? "")),
      stack: REDACTED,
    };
    if ((value as { cause?: unknown }).cause !== undefined) {
      out.cause = walk((value as { cause?: unknown }).cause, seen);
    }
    return out;
  }

  // Arrays.
  if (Array.isArray(value)) {
    return value.map((item) => walk(item, seen));
  }

  // Plain objects.
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_KEYS.has(key)) {
      out[key] = REDACTED;
    } else {
      out[key] = walk(child, seen);
    }
  }
  return out;
}
