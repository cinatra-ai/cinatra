// ---------------------------------------------------------------------------
// Registry failure classification for the installed-extension catalog
// (cinatra#2539).
//
// The catalog hydrates its rows from the registry, but every field the registry
// contributes (catalog title, description, author, published version) already
// has a native-descriptor / static-manifest / package-name fallback. So a
// registry that cannot be REACHED should degrade the hydration, not delete the
// operator's list of installed extensions.
//
// That must not become "swallow every registry error". The rule below is an
// ALLOW-LIST, not a deny-list: a failure degrades only when it is positively
// recognised as "could not reach / did not answer". Everything else — a 401/403
// revoked or wrong token, a 404 registry URL pointing at something that is not
// a registry, a malformed 200 body, a bad URL, a TLS/certificate problem, or an
// outright programming error — is a condition the operator has to see, so it
// keeps propagating exactly as it did before. Failing loud on an UNKNOWN shape
// is the safe direction: the worst case is the pre-existing behaviour.
//
// Pure and dependency-free so the rule is unit-testable without the loader's
// server-only module graph.
// ---------------------------------------------------------------------------

/**
 * Node/undici transport codes that mean "the request never got an answer".
 * A TLS/certificate code is deliberately ABSENT — a bad certificate is a
 * configuration problem the operator must see, not a blip.
 */
const TRANSPORT_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ECONNABORTED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "ENETDOWN",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_BODY_TIMEOUT",
  "UND_ERR_SOCKET",
  // npm-registry-fetch / make-fetch-happen surface these two for a request
  // that timed out or could not complete against the registry.
  "ERR_SOCKET_TIMEOUT",
  "FETCH_ERROR",
]);

/** Error names that mean the request was cut short rather than answered. */
const TRANSPORT_NAMES = new Set([
  "AbortError",
  "TimeoutError",
  "RegistryCatalogBudgetExceededError",
]);

function numericStatus(err: unknown): number | undefined {
  const candidate = err as { status?: unknown; statusCode?: unknown } | null;
  if (!candidate) return undefined;
  if (typeof candidate.status === "number") return candidate.status;
  if (typeof candidate.statusCode === "number") return candidate.statusCode;
  return undefined;
}

/**
 * Is this the "cannot reach / did not answer" class — the only class the
 * catalog renders through?
 *
 * Walks the `cause` chain, because `fetch` reports a connection failure as a
 * bare `TypeError: fetch failed` whose `cause` carries the real code.
 */
export function isRegistryUnreachable(err: unknown): boolean {
  for (let current: unknown = err, depth = 0; current != null && depth < 8; depth += 1) {
    const status = numericStatus(current);
    // The registry ANSWERED. 5xx = up but broken on its own side (degrade);
    // anything else it chose to answer with is the operator's to see.
    if (status !== undefined) return status >= 500;

    const shaped = current as { name?: unknown; code?: unknown; cause?: unknown };
    if (typeof shaped.name === "string" && TRANSPORT_NAMES.has(shaped.name)) return true;
    if (typeof shaped.code === "string" && TRANSPORT_CODES.has(shaped.code)) return true;
    current = shaped.cause;
  }
  // Unrecognised: fail LOUD. An unknown failure shape must not be able to hide
  // behind a catalog that merely looks a little sparse.
  return false;
}
