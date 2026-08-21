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
  // cinatra#2754 — the review-island credential's query parameter. A structured
  // log record that carries the parsed query (`{ ref, ic }`) loses the value
  // here; the string patterns below catch the address in unparsed text. The
  // literal is pinned to `REVIEW_ISLAND_CREDENTIAL_QUERY_PARAM` by
  // `src/lib/__tests__/review-island-query-redaction.test.ts` rather than
  // imported, so this leaf keeps its zero-dependency shape.
  "ic",
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
  // THE REVIEW-ISLAND CREDENTIAL (cinatra#2754). `/lifecycle/review-island` is
  // the one route in this app whose QUERY is a bearer: an `<iframe src>` GET
  // carries no header and, cross-site, no cookie, so the address itself
  // authenticates the reader (plan §12). An address that reaches a log line is
  // therefore a credential in a log line, and the ruling's third hardening says
  // it must not survive there. Two entries, both narrow, added rather than
  // broadening an existing pattern (this list's documented rule):
  //
  //   1. THE ADDRESS, wherever it appears — an access-log request line, a HAR
  //      entry, a stringified DOM fragment. Anchored on the route's own path,
  //      so nothing outside the island can be touched by it.
  [
    /(\/lifecycle\/review-island\?(?:[^\s"'<>]*?[?&])?ic=)[A-Za-z0-9_-]+/g,
    "$1[redacted]",
  ],
  //   2. THE VALUE ALONE, for the shapes that carry the query without the path
  //      (a `searchParams` dump, a query string logged on its own). Bounded to
  //      the key `ic` AND to a value at least as long as a sealed credential
  //      can be, so an ordinary short parameter that happens to be called `ic`
  //      is left alone.
  [/(\bic=)[A-Za-z0-9_-]{40,}/g, "$1[redacted]"],
  //   3. THE ALREADY-SERIALIZED QUERY. The structural pass below removes the
  //      value at the key `ic` while the record is still an OBJECT; a logger
  //      that stringifies the query before handing it over presents
  //      `{"ic":"…"}` as text, where only a string pattern can reach it. Same
  //      key bound, same length bound.
  [/(["']ic["']\s*:\s*["'])[A-Za-z0-9_-]{40,}/g, "$1[redacted]"],
  //   4. THE PERCENT-ENCODED ADDRESS. An island URL nested inside another URL's
  //      query (a redirect target, a proxied `next=`) arrives with its own
  //      separators escaped, so neither `ic=` nor a word boundary before `ic`
  //      ever appears. Anchored on the escaped (or literal) query separator that
  //      must precede the key, which is what keeps it narrow.
  [/((?:%3F|%26|[?&])ic%3D)[A-Za-z0-9_-]{40,}/gi, "$1[redacted]"],
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
