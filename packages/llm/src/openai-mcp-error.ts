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
