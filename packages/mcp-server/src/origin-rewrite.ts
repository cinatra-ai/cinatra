/**
 * Origin-rewrite helpers for the MCP server's JSON metadata responses.
 *
 * Extracted from `index.tsx` (a tracked file-size-ratchet bottleneck) so the
 * entry module stays a thin facade. These are pure, dependency-free string
 * transforms: when the MCP server is reached through a public origin that
 * differs from the internal request origin (a reverse proxy / tunnel), the
 * advertised URLs baked into Better Auth / OAuth metadata must be rewritten from
 * the internal origin to the public one. `index.tsx` composes these via
 * `rewriteJsonOriginResponse`, which supplies the source/target origins.
 */

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
