// ---------------------------------------------------------------------------
// Pure URL-shape helper for the MCP server's `publicBaseUrl`.
//
// Plain ESM `.mjs`, NO imports, NO `server-only`, NO `@/` aliases. Importable
// from anywhere:
//   - TS in-process callers (`packages/mcp-server/src/llm-credentials.ts`)
//     via `import { normaliseMcpPublicBaseUrl } from "./mcp-public-base-url-shape.mjs"`.
//   - The plain-`.mjs` Cinatra CLI (`packages/cli/src/index.mjs`) directly.
//
// Why a separate file: the CLI must write `mcp_server.publicBaseUrl` into a
// clone's Postgres DB, but the existing TS
// `setMcpPublicBaseUrl` lives behind `server-only` + Next path aliases and
// `@cinatra-ai/mcp-server` ships no compiled `dist/`. Extracting only the pure
// URL-shape rules (validation, normalisation, origin-only contract) into this
// module gives both writers a single source of truth without forcing either
// to bend toward the other's import constraints.
// ---------------------------------------------------------------------------

/**
 * The metadata row key under which the MCP server's settings live. Stable
 * across the writers; matches `MCP_SETTINGS_KEY` in
 * `packages/mcp-server/src/llm-credentials.ts` and `packages/cli/src/index.mjs`.
 */
export const MCP_PUBLIC_BASE_URL_METADATA_KEY = "connector_config:mcp_server";

/**
 * The set of `publicBaseUrlSource` values callers can request when writing.
 * `"unknown"` is reserved for the null-URL path (cannot be passed in).
 *
 *   - `"manual"` (default): operator pasted the URL into the dev tab form.
 *   - `"tailscale-auto"`: `cinatra clone start` minted a
 *     Tailscale Funnel URL via the Nango-stored OAuth client.
 *   - `"tailscale-funnel"`: Tailscale sidecar path that read `TS_AUTHKEY`
 *     from env.
 *
 * @typedef {"manual" | "tailscale-auto" | "tailscale-funnel"} McpPublicBaseUrlSource
 */

/**
 * Normalise an operator-supplied (or env-derived) MCP public base URL.
 * Returns the canonical origin-only form plus the matching
 * `publicBaseUrlSource`.
 *
 * Rules:
 *   - `null` / `undefined` / empty / whitespace → `{ url: null, source: "unknown" }`.
 *   - Trailing slashes stripped before parsing.
 *   - Scheme MUST be http(s); other schemes throw.
 *   - URL MUST be origin-only — no path, no query, no fragment. Throws otherwise.
 *   - Successful normalisation: `{ url, source: options.source ?? "manual" }`.
 *
 * Error messages mirror the prior in-place validation in
 * `setMcpPublicBaseUrl()` so callers who relied on the wording continue to see
 * an equivalent rejection.
 *
 * @param {string | null | undefined} input
 * @param {{ source?: McpPublicBaseUrlSource }} [options]
 * @returns {{ url: string | null, source: McpPublicBaseUrlSource | "unknown" }}
 */
export function normaliseMcpPublicBaseUrl(input, options) {
  if (input == null) return { url: null, source: "unknown" };
  if (typeof input !== "string") {
    return { url: null, source: "unknown" };
  }
  // Strip trailing slashes via a LINEAR char-index trim. The previous
  // `/\/+$/` is an anchored greedy slash-repetition — polynomial-ReDoS on
  // input with many trailing slashes (CodeQL js/polynomial-redos, high).
  const trimmedInput = input.trim();
  let trimEnd = trimmedInput.length;
  while (trimEnd > 0 && trimmedInput.charCodeAt(trimEnd - 1) === 47) trimEnd--; // 47 = "/"
  const trimmed = trimmedInput.slice(0, trimEnd);
  if (trimmed.length === 0) return { url: null, source: "unknown" };

  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(
      `MCP publicBaseUrl: URL must be a valid http(s)://… origin, got ${JSON.stringify(input)}`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP publicBaseUrl: URL must use http(s) scheme, got ${JSON.stringify(input)}`,
    );
  }
  if (parsed.pathname !== "/" && parsed.pathname !== "") {
    throw new Error(
      `MCP publicBaseUrl: URL must be an origin without a path (got ${JSON.stringify(input)}). ` +
        `Save just the host, e.g. https://my-tunnel.example.ts.net`,
    );
  }
  if (parsed.search.length > 0 || parsed.hash.length > 0) {
    throw new Error(
      `MCP publicBaseUrl: URL must not have a query string or fragment (got ${JSON.stringify(input)}).`,
    );
  }
  const requestedSource = options?.source;
  const source =
    requestedSource === "tailscale-auto" || requestedSource === "tailscale-funnel"
      ? requestedSource
      : "manual";
  return { url: `${parsed.protocol}//${parsed.host}`, source };
}

/**
 * Compute the next metadata-row body for a publicBaseUrl write, preserving
 * any sibling fields and dropping retired columns. Mirrors the in-place
 * merge in `setMcpPublicBaseUrl()` so the CLI writer + the in-process writer
 * produce byte-equivalent rows for the same input.
 *
 * @param {Record<string, unknown>} current   Existing row contents (may be empty).
 * @param {string | null | undefined} url     Operator-supplied URL.
 * @param {{ source?: McpPublicBaseUrlSource }} [options]  Tag the write with a
 *        non-default `publicBaseUrlSource` (e.g. `"tailscale-auto"` for the
 *        auto-tunnel path). Defaults to `"manual"`.
 * @returns {Record<string, unknown>}
 */
export function buildMcpPublicBaseUrlRow(current, url, options) {
  const { url: nextUrl, source: nextSource } = normaliseMcpPublicBaseUrl(
    url,
    options,
  );
  const next = {
    ...current,
    publicBaseUrl: nextUrl,
    publicBaseUrlSource: nextSource,
    updatedAt: new Date().toISOString(),
  };
  // Drop fields no longer used by the public base URL row shape.
  delete next.tunnelMode;
  delete next.externalUrl;
  delete next.cloudflaredMissing;
  return next;
}
