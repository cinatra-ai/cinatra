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
// `buildTools(provider, context?)` when assembling the external MCP server
// tools for an LLM call.
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
  /**
   * Approval vocabulary (llm-providers S2, #1713 AC2) — whether the injected
   * server's tool calls execute without a human approval step:
   *   - "auto_execute"      — tool calls run without approval (the default;
   *                           an OMITTED value means exactly this).
   *   - "approval_required" — every tool call needs an approval step. A
   *                           provider whose declared `approval` capability is
   *                           "unsupported" (Anthropic today) REFUSES such a
   *                           toolbox fail-closed — it is never silently
   *                           downgraded to auto-execution.
   * Replaces the retired three-value `requireApproval` ("never" | "always" |
   * "read-only") that only OpenAI consumed. The host toolbox sanitizer DROPS a
   * tool entry that still carries a legacy `requireApproval` approval intent
   * ("always"/"read-only") rather than auto-executing it. Mirror of
   * `@cinatra-ai/llm`'s `LlmMcpServerTool.approval`.
   */
  approval?: "auto_execute" | "approval_required";
  /**
   * @deprecated Retired three-value approval vocabulary (pre-#1713 AC2) —
   * declare `approval` instead. Kept ONLY as a type-level compatibility member
   * so companion extension sources built against the previous SDK still
   * typecheck while their migrations land; the host boundary sanitizer
   * (`checkMcpApprovalVocabulary`) strips a `"never"` (identical semantics to
   * the `auto_execute` default) and DROPS a tool entry carrying `"always"` /
   * `"read-only"` approval intent fail-closed — a legacy value never reaches a
   * provider adapter. DELIBERATELY absent from the host's `LlmMcpServerTool`
   * mirror (the mirror lock quarantines exactly this key): host-constructed
   * tools never pass the extension-boundary sanitizer, so the host type
   * carrying the retired key would let approval intent silently serialize as
   * auto-execution. Remove once every pinned companion extension declares the
   * new vocabulary.
   */
  requireApproval?: "never" | "always" | "read-only";
  /**
   * MCP wire transport this server speaks (llm-providers S2, #1713). Optional:
   * an extension that omits it is treated as `"unknown"` by the host injection
   * layer (transport is never inferred from `serverUrl`). Mirror of
   * `@cinatra-ai/llm`'s `LlmMcpServerTool.transport`.
   */
  transport?: "streamable-http" | "sse" | "unknown";
};

/**
 * Host-built, identity-free build context (cinatra#2019 S4 / trusted-site
 * mode). Carries WHERE the injection is being assembled and, on run surfaces,
 * WHICH connector instance the run is pinned to:
 *
 *   - `surface` — the host surface assembling this LLM call's injection:
 *     `"chat"` (workspace assistant chat), `"agent_run"` (agent/workflow run
 *     surfaces, including the LLM bridge), `"public_site_widget"` (the
 *     public-site widget principal, which shares the chat injection plumbing
 *     host-side), `"session"` (other session-scoped assembly).
 *   - `connectorInstancePin` — present only when the calling surface is bound
 *     to ONE connector instance (e.g. an agent run pinned to an instance). A
 *     pure NARROWING filter: a toolbox consuming it may only ever restrict
 *     emission to the pinned instance, never widen beyond it.
 *
 * The context NEVER carries user/org identity — per-instance authority always
 * derives host-side from the host's ambient trusted actor stores, so there is
 * nothing here for a caller to forge. Toolboxes that gate emission on this
 * context MUST treat an ABSENT context as "emit nothing" (fail-closed on
 * hosts/call sites that predate the widening).
 *
 * Scope note: only the manifest-toolbox path (`ExtensionExternalMcpToolbox`)
 * carries this context. The host's `llm-toolbox` capability path
 * (`LlmToolboxProvider.build(provider)`) is deliberately NOT widened — those
 * providers perform no per-instance site injection.
 */
export type ExtensionToolboxBuildContext = {
  surface: "chat" | "agent_run" | "public_site_widget" | "session";
  connectorInstancePin?: { connectorKey: string; instanceId: string };
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
 *
 * `context` (optional, cinatra#2019 S4) is the host-built
 * `ExtensionToolboxBuildContext` above. The parameter is OPTIONAL end to end:
 * a toolbox implemented against the previous one-parameter shape stays
 * structurally assignable, and a host call site that does not yet pass a
 * context stays type-valid — a toolbox whose emission policy depends on the
 * context MUST then fail closed (return `[]`) when it is absent.
 */
export type ExtensionExternalMcpToolbox = {
  buildTools: (
    provider: string,
    context?: ExtensionToolboxBuildContext,
  ) => Promise<ExtensionExternalMcpTool[]>;
};
