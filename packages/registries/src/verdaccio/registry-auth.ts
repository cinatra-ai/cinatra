// Registry-scoped credential options for pacote / npm-registry-fetch.
//
// Pure module — no "server-only" import. Must stay loadable from plain Node
// contexts (CLI extractors, vitest, scripts) like the rest of this package.

/**
 * Build the credential entry pacote's HTTP layer (npm-registry-fetch) actually
 * reads.
 *
 * npm-registry-fetch (20.x, pacote ^22's fetch layer) resolves auth
 * EXCLUSIVELY from registry-scoped option keys of the form
 * `'//<host>/<path>:_authToken'` (the npmrc "nerf-dart" convention, walked up
 * the request URI's path) or from an explicit `forceAuth` object — a flat
 * `token` option is read by NEITHER path and silently produces requests with
 * no Authorization header at all (see npm-registry-fetch lib/auth.js). That
 * was the #179 regression: every pacote read built on a flat `token` ran
 * unauthenticated.
 *
 * The scoped key is preferred over `forceAuth` deliberately: `forceAuth`
 * attaches the credential to EVERY request made with the options object,
 * including packument-referenced tarball URLs that may point at a different
 * host. The scoped key sends the token only to URIs under the configured
 * registry host — npm-registry-fetch walks the request URI's path up to the
 * host root, so same-host tarball URLs (the Verdaccio layout) still match.
 *
 * Key derivation matches npm's nerf-dart: `//<host><pathname>/` (host keeps
 * its port; pathname keeps any registry path prefix; trailing slash enforced).
 * Returns `{}` when no token is configured (anonymous registry access).
 * Throws on a malformed registry URL — fail fast at the call boundary rather
 * than emit a silently-wrong key (same stance as cli-flags' extractHost).
 */
export function registryScopedAuthOptions(
  registryUrl: string,
  token: string | null | undefined,
): Record<string, string> {
  if (!token) return {};
  const parsed = new URL(registryUrl);
  const pathname = parsed.pathname.endsWith("/")
    ? parsed.pathname
    : `${parsed.pathname}/`;
  return { [`//${parsed.host}${pathname}:_authToken`]: token };
}

// ---------------------------------------------------------------------------
// Token-redacting facade over the pacote calls this repo makes.
//
// This lives beside registryScopedAuthOptions on purpose: the two halves of the
// same credential contract. That function decides how the token GOES OUT; the
// facade below decides that it never COMES BACK in a failure. Deliberately in
// this module rather than a file of its own — every route budget that reaches
// the registries barrel would otherwise grow by a module (route-graph-ratchet),
// and the credential seam is exactly where a reader looks for this.
//
// WHY IT EXISTS (cinatra#2163). pacote's HTTP layer is npm-registry-fetch.
// Through npm-registry-fetch 19 the `HttpErrorGeneral` message appended ONLY
// the registry response body's `error` field. From 20 (pacote 22's fetch
// layer) it appends `body.error` OR `body.message` OR — failing both — the
// whole body JSON-serialized. A registry, a reverse proxy, or a diagnostic
// error handler that echoes the inbound request back (its `Authorization`
// header included) therefore now lands the bearer token in `Error.message`,
// which is the field that reaches logs, telemetry and surfaced error text.
// Measured on a hostile in-process registry stub that echoes the inbound
// Authorization header under `message`: pacote 21 / fetch 19 => token absent
// from `Error.message`; pacote 22 / fetch 20 => token present verbatim.
//
// The fix is a facade rather than a wrapper at each call site: every pacote
// call in this repo already receives its credential as a registry-scoped
// `'//<host><path>:_authToken'` option key (see registryScopedAuthOptions
// above), so the facade recovers the exact secret from the SAME options object
// the caller passed. No call site changes shape, and the three consuming
// modules bind `pacote` to the facade so an added call in them is covered by
// default — the raw module stays importable, so this is a strong default, not
// a fence.
//
// SCOPE OF THE REDACTION (deliberately narrow, same stance as the sibling
// redactToken in client.ts): exact literal occurrences of the configured
// token(s) in the error's `message` and `stack`, one shallow pass over an
// attached response `body` object's own string values, and the same treatment
// of a `cause` error one level down. It is NOT a general sanitizer and does
// NOT claim to scrub every carrier: nested body objects/arrays, response
// headers, other custom error properties, non-Error throws, and URL-encoded or
// otherwise transformed copies of the credential are all out of scope. This is
// defense in depth over the ONE carrier the fetch-layer major widened.
// ---------------------------------------------------------------------------

/** Replace every literal occurrence of `token` in `value`. */
function scrub(value: string, token: string): string {
  return value.includes(token) ? value.replaceAll(token, "[redacted]") : value;
}

/**
 * Recover the credential(s) from a pacote options object.
 *
 * Every options object this repo builds carries the credential under a
 * registry-scoped nerf-dart key (`//<host><path>:_authToken`). Anonymous
 * access produces no such key and yields an empty list.
 *
 * ALL such keys are collected, not just the first: npm-registry-fetch picks the
 * LONGEST matching path prefix, so an options object carrying more than one
 * path-scoped credential would otherwise let this redact the wrong one and
 * leave the credential actually sent on the wire in the error text. Redacting
 * every scoped value it can see is both simpler and strictly safer than trying
 * to re-derive that selection here.
 */
function tokensFromOptions(opts: unknown): string[] {
  if (!opts || typeof opts !== "object") return [];
  const seen = new Set<string>();
  for (const [key, value] of Object.entries(opts as Record<string, unknown>)) {
    if (key.endsWith(":_authToken") && typeof value === "string" && value.length > 0) {
      seen.add(value);
    }
  }
  return [...seen];
}

/**
 * Scrub the configured token out of an error IN PLACE and return it.
 *
 * Mutating rather than re-wrapping is deliberate: call sites branch on
 * `error.statusCode === 404` / `error.code === "E404"` and on the error's
 * prototype, so a fresh `new Error(...)` would silently break the 404 handling
 * that keeps `isVersionPublished` and the packument readers correct.
 */
export function redactTokenInError(
  error: unknown,
  token: string | null | readonly string[],
  depth = 0,
): unknown {
  const tokens = (typeof token === "string" ? [token] : token ?? []).filter(
    (t): t is string => typeof t === "string" && t.length > 0,
  );
  if (tokens.length === 0 || !(error instanceof Error)) return error;
  const scrubAll = (value: string) => tokens.reduce(scrub, value);

  if (typeof error.message === "string") {
    const redacted = scrubAll(error.message);
    if (redacted !== error.message) error.message = redacted;
  }
  // `stack` is captured at construction and embeds the original message text,
  // so it has to be scrubbed independently.
  if (typeof error.stack === "string") {
    const redacted = scrubAll(error.stack);
    if (redacted !== error.stack) error.stack = redacted;
  }
  // npm-registry-fetch attaches the parsed response body. This carrier is not
  // new in the 20 line, but it is the same secret and it is cheap to cover.
  // ONE shallow pass over own string values — a nested object is out of scope.
  const body = (error as { body?: unknown }).body;
  if (typeof body === "string") {
    (error as { body?: unknown }).body = scrubAll(body);
  } else if (body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
      if (typeof value === "string") {
        (body as Record<string, unknown>)[key] = scrubAll(value);
      }
    }
  }
  // A wrapped cause is the one other carrier that routinely reaches a logger.
  // Exactly one level — bounded on purpose, and enough for the fetch layer's
  // own wrapping.
  if (depth === 0) {
    redactTokenInError((error as { cause?: unknown }).cause, tokens, depth + 1);
  }
  return error;
}

async function guarded<T>(opts: unknown, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    throw redactTokenInError(error, tokensFromOptions(opts));
  }
}

type PacoteLike = {
  packument: (spec: string, opts?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  tarball: (spec: string, opts?: Record<string, unknown>) => Promise<Buffer>;
  extract: (spec: string, dest: string, opts?: Record<string, unknown>) => Promise<void>;
};

/**
 * Build the redacting facade over a pacote module. Exported as a factory so
 * the behaviour is testable against a stub without a live registry.
 */
export function createRedactingPacote(impl: PacoteLike): PacoteLike {
  return {
    packument: (spec, opts) => guarded(opts, () => impl.packument(spec, opts)),
    tarball: (spec, opts) => guarded(opts, () => impl.tarball(spec, opts)),
    extract: (spec, dest, opts) => guarded(opts, () => impl.extract(spec, dest, opts)),
  };
}
