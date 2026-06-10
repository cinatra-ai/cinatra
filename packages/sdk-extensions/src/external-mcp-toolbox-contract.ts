// External-MCP toolbox contract — the data shape an external-MCP-capable
// extension's toolbox module produces for the host's LLM toolbox-injection
// path.
//
// An extension opts in by declaring `cinatra.providesExternalMcpToolbox: true`
// (the manifest capability marker) and shipping `src/mcp/toolbox.ts` exporting
// exactly ONE `create*ExternalMcpToolbox()` factory. The manifest generator
// records a slug-keyed loader entry (literal dynamic import of the package's
// `mcp-toolbox` subpath plus the factory export name); the host resolves the
// factory WITHOUT importing any extension package by name and calls
// `buildTools(provider)` when assembling the external MCP server tools for an
// LLM call.
//
// The tool shape is a structural mirror of the host's `LlmMcpServerTool`
// (`@cinatra-ai/llm`) so extensions carry no host-peer dependency; host-side
// assignability is locked by a type-level test next to the host loader.

/**
 * One external MCP server tool definition, as injected into an LLM provider
 * call. Structural mirror of `@cinatra-ai/llm`'s `LlmMcpServerTool`.
 */
export type ExtensionExternalMcpTool = {
  type: "mcp";
  /** Human-readable label for the MCP server. */
  serverLabel: string;
  /** URL of the MCP server (e.g. "https://example.com/api/mcp"). */
  serverUrl: string;
  /** Optional HTTP headers for authentication. */
  headers?: Record<string, string>;
  /** Optional OAuth access token. */
  authorization?: string;
  /** Optional description of the server's purpose. */
  serverDescription?: string;
  /** Optional list of allowed tool names, or null to allow all. */
  allowedTools?: string[] | null;
  /** Whether tools that mutate state require approval. */
  requireApproval?: "never" | "always" | "read-only";
};

/**
 * The module a `create*ExternalMcpToolbox()` factory returns.
 *
 * `buildTools` receives the LLM provider id (widened to `string` so the SDK
 * carries no host-internal union) and resolves the extension's CURRENTLY
 * INJECTABLE external MCP server tools — typically from the extension's own
 * configuration/credential state via its host-bound deps. It MUST never throw
 * for ordinary "not configured / not reachable" conditions; returning `[]`
 * is the no-op signal (the host additionally isolates per-extension failures).
 */
export type ExtensionExternalMcpToolbox = {
  buildTools: (provider: string) => Promise<ExtensionExternalMcpTool[]>;
};
