// Pure helpers for the OpenAI hosted-MCP tool-list failure (#500).
//
// Cinatra injects its own `cinatra` MCP server into OpenAI as a hosted-MCP tool,
// so the provider fetches the tool list from this instance's PUBLIC MCP URL. When
// that URL is unreachable (tunnel down, or a local/closed instance the provider
// cannot reach), OpenAI returns HTTP 424 (Failed Dependency) and the run dies
// with an opaque error. These helpers classify that case and build a clear,
// actionable replacement message (naming the affected server URL when present),
// so the provider layer can fail loud with a remedy instead of a raw 424.

type McpToolLike = { type?: string; server_url?: string; server_label?: string };

const HTTP_424_RE = /\b424\b/;
const MCP_RE = /\bmcp\b/i;

/**
 * True when an error is OpenAI's "could not enumerate the hosted-MCP tool list"
 * 424. Requires BOTH the 424 status and an MCP marker so it does not fire on
 * unrelated 424s. Accepts `unknown` so a caught value can be passed directly.
 */
export function isHostedMcpToolListError(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return HTTP_424_RE.test(message) && MCP_RE.test(message);
}

/**
 * Pull the hosted-MCP server URL out of the request's tool payload (the entry
 * with `type: "mcp"`), so the error message can name the unreachable URL.
 * Returns undefined when there is no MCP tool or it carries no `server_url`.
 */
export function extractMcpServerUrl(tools: unknown): string | undefined {
  if (!Array.isArray(tools)) return undefined;
  const mcp = (tools as McpToolLike[]).find((t) => t?.type === "mcp");
  return mcp?.server_url;
}

/**
 * Build the clear, actionable replacement for the raw 424. Keeps the stable
 * "424" + "MCP" tokens so the UI detector (`isMcpUnreachableError`) recognizes
 * it the same way it recognizes the raw provider text.
 */
export function buildMcpUnreachableMessage(serverUrl?: string): string {
  const where = serverUrl ? ` at ${serverUrl}` : "";
  return (
    `The AI provider could not reach this instance's public MCP server${where} ` +
    `to load the cinatra toolbox (HTTP 424 Failed Dependency), so the agent run was ` +
    `stopped. Make sure the instance's public URL / tunnel is reachable from the AI ` +
    `provider, then try again.`
  );
}

/**
 * The decision for handling a caught provider error against a request that
 * carried MCP tool injection. Both `generate()` (non-streaming) and `stream()`
 * route a caught 424 through {@link planMcpToolListErrorRecovery} so the two
 * paths stay behaviourally identical (#530 CodeRabbit follow-up):
 *  - `none`     → not a hosted-MCP 424 (or the request had no tools): the caller
 *                 re-throws / surfaces the original error UNCHANGED.
 *  - `retry`    → dev mode AND non-MCP tools remain: retry WITHOUT the MCP tool,
 *                 using `toolsWithoutMcp` as the replacement `tools` payload.
 *  - `fail`     → production (stable URL) or MCP-only: FAIL LOUD with the clear,
 *                 actionable `message` (a typed rewrite of the opaque raw 424).
 */
export type McpToolListErrorRecovery =
  | { kind: "none" }
  | { kind: "retry"; toolsWithoutMcp: Array<{ type?: string }> }
  | { kind: "fail"; message: string };

/**
 * Classify a caught provider error against the request's `tools` payload and
 * decide how to recover from the hosted-MCP tool-list 424 (#500). Pure: takes
 * the caught value, the request's `tools`, and whether we are in dev mode, and
 * returns a {@link McpToolListErrorRecovery}. The `client.responses.*` call and
 * the actual throw/log live in the provider; only the BRANCH lives here, so the
 * non-streaming and streaming paths cannot drift apart.
 */
export function planMcpToolListErrorRecovery(
  err: unknown,
  tools: unknown,
  isDevMode: boolean,
): McpToolListErrorRecovery {
  if (!isHostedMcpToolListError(err) || !tools) return { kind: "none" };
  const toolsWithoutMcp = Array.isArray(tools)
    ? (tools as Array<{ type?: string }>).filter((t) => t.type !== "mcp")
    : [];
  if (isDevMode && toolsWithoutMcp.length > 0) {
    return { kind: "retry", toolsWithoutMcp };
  }
  return { kind: "fail", message: buildMcpUnreachableMessage(extractMcpServerUrl(tools)) };
}
