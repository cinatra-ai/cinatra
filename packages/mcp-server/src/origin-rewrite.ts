/**
 * Origin-rewrite helpers for the MCP server's JSON metadata responses.
 *
 * Extracted from `index.tsx` (a tracked file-size-ratchet bottleneck) so the
 * entry module stays a thin facade. When the server is reached through a public
 * origin that differs from the internal request origin (a reverse proxy /
 * tunnel), the advertised URLs baked into Better Auth / OAuth metadata must be
 * rewritten from the internal origin to the public one.
 *
 * The module is pure and app-graph-free — Web-standard `Request`/`Response` and
 * string transforms only: NO React, NO Next.js, NO `@/` aliases, NO
 * `server-only`, NO database access. That is what lets an app route import
 * `rewriteJsonOriginResponse` from `@cinatra-ai/mcp-server/origin-rewrite`
 * without pulling the heavy `@cinatra-ai/mcp-server` barrel (cinatra#2478).
 *
 * `inferRequestOrigin` is the single trusted source of the PUBLIC origin, and
 * `rewriteJsonOriginResponse` the single rewrite treatment, for every metadata
 * document this instance advertises — both the ones built in-process from the
 * inferred origin (the `/api/mcp` protected-resource document) and the ones
 * built from the internal origin and handed back already serialized (the
 * authorization-server / OpenID-configuration documents, and the `/api/cli`
 * protected-resource document).
 */

/**
 * The PUBLIC origin this request arrived at.
 *
 * Trusts the reverse proxy's `x-forwarded-proto` + `x-forwarded-host` pair when
 * BOTH are present (a deployment terminating TLS in front of the app knows the
 * public origin; the app, bound to an internal interface, does not — it may not
 * even see a routable one, e.g. a wildcard `0.0.0.0` bind). Falls back to the
 * request URL's own origin when the pair is absent, which is the direct /
 * unproxied case.
 */
export function inferRequestOrigin(request: Request): string {
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const forwardedHost = request.headers.get("x-forwarded-host");

  if (forwardedProto && forwardedHost) {
    return `${forwardedProto}://${forwardedHost}`;
  }

  return new URL(request.url).origin;
}

/**
 * Rewrite the internal origin to the public one throughout an already-built
 * JSON response.
 *
 * The treatment for a metadata document whose body was produced from the
 * INTERNAL origin: parse it, rewrite every origin-bearing string leaf, and
 * re-serialize. A non-JSON response, an unparseable body, or a request whose
 * internal origin already equals the public origin (the unproxied case) is
 * returned untouched — the same object, not a copy.
 */
export async function rewriteJsonOriginResponse(input: {
  request: Request;
  response: Response;
}): Promise<Response> {
  const contentType = input.response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    return input.response;
  }

  const internalOrigin = new URL(input.request.url).origin;
  const publicOrigin = inferRequestOrigin(input.request);
  if (internalOrigin === publicOrigin) {
    return input.response;
  }

  const body = await input.response.clone().json().catch(() => null);
  if (!body) {
    return input.response;
  }

  const headers = new Headers(input.response.headers);
  headers.delete("content-length");

  return new Response(
    JSON.stringify(replaceOriginInValue(body, internalOrigin, publicOrigin)),
    {
      status: input.response.status,
      statusText: input.response.statusText,
      headers,
    },
  );
}

/**
 * Rewrite every occurrence of `sourceOrigin` (and the well-known localhost dev
 * origins) inside a string to `targetOrigin`. Returns the string unchanged when
 * there is nothing to replace.
 */
export function replaceOriginInString(value: string, sourceOrigin: string, targetOrigin: string): string {
  let nextValue = value;

  if (sourceOrigin !== targetOrigin) {
    nextValue = nextValue.replaceAll(sourceOrigin, targetOrigin);
  }

  return nextValue
    .replaceAll("http://localhost:3000", targetOrigin)
    .replaceAll("https://localhost:3000", targetOrigin)
    .replaceAll("http://127.0.0.1:3000", targetOrigin)
    .replaceAll("https://127.0.0.1:3000", targetOrigin);
}

/**
 * Recursively rewrite origins inside any JSON-shaped value (string, array, or
 * plain object). Non-string leaves are returned untouched.
 */
export function replaceOriginInValue(value: unknown, sourceOrigin: string, targetOrigin: string): unknown {
  if (typeof value === "string") {
    return replaceOriginInString(value, sourceOrigin, targetOrigin);
  }

  if (Array.isArray(value)) {
    return value.map((entry) => replaceOriginInValue(entry, sourceOrigin, targetOrigin));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, replaceOriginInValue(entry, sourceOrigin, targetOrigin)]),
    );
  }

  return value;
}
