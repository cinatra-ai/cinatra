# AGENTS.md — @cinatra-ai/llm

## Purpose

Unified LLM orchestration layer. All LLM API calls in the application go through this package. Provider adapters translate the unified `LlmProviderAdapter` interface to each SDK's native format.

## Key files

| File | Role |
|---|---|
| `src/registry.ts` | Resolves connection config → adapter. Owns `resolveMcpToolsForDeclaredIds` shared helper used by `index.ts::injectMcpTools`. |
| `src/index.ts` | Orchestration entry points (`runDeterministicLlmTask`, `runSkillAwareDeterministicLlmTask`, `generate`, `stream`). Owns `injectMcpTools` — the single MCP injection site. |
| `src/providers/openai.ts` | OpenAI adapter — native MCP tool, shell tool, function tools, web search |
| `src/providers/anthropic.ts` | Anthropic adapter — function tools, MCP server tool (native or function-tools mode with auto-fallback) |
| `src/providers/gemini.ts` | Gemini adapter — function tools (no native MCP) |
| `src/mcp-access.ts` | `buildLlmMcpServerTool` — exchanges client_credentials for JWT, builds `LlmMcpServerTool` |
| `src/tools/skills.ts` | Skill tool helpers — internal: `buildSkillTools`, `readSkillContent`; public: `buildMcpTools`, `createShellTool`, `createWebSearchTool` |

## MCP server tool — automatic injection at the orchestration layer

`injectMcpTools` in `index.ts` is the single MCP injection site. It is called by all 4 orchestration entry points (`runDeterministicLlmTask`, `runSkillAwareDeterministicLlmTask`, `generate`, `stream`) immediately before invoking `adapter.generate` / `adapter.stream`. It prepends the Cinatra MCP server tool (and any external MCP servers) to the tools list when credentials and a public URL are configured.

**Do not call `buildLlmMcpServerTool` at individual call sites.** Code that goes through any of the 4 orchestration entry points gets MCP injection automatically. Direct callers of `resolveProviderAdapter` (e.g. `src/lib/mcp-server.ts::readConfiguredLlmProviders`) get an UNWRAPPED adapter — no MCP injection. The current direct caller only does a truthy check (no `.generate`/`.stream` call), so the unwrapped adapter is safe.

When the MCP server is not reachable (no tunnel, no credentials), the helper is a no-op — the call proceeds with the original tools list.

**Valid skips** (no `injectMcpTools` mutation):
1. `params.tools` already contains a `type: "mcp"` entry (deduplication)
2. `params.provider === "gemini"` (no native MCP support)
3. `params.skipMcpInjection: true` (legacy stream-only opt-out)
4. `resolveMcpToolsForDeclaredIds` returns `[]` (credentials/tunnel unavailable, or `declaredToolboxIds: []`)

### Per-agent toolbox filtering

`GenerateInput` and `StreamInput` now accept an optional `declaredToolboxIds: string[]` field. The LangGraph bridge route (`/api/internal/langgraph-llm-step`) populates it from the calling agent's compiled `CompiledAgentOas.toolboxes[].id`. When the field is set, `injectMcpTools` filters MCP injection to only those ids: `"cinatra-mcp"` → Cinatra self-MCP via `buildLlmMcpServerTool`; any other id → resolved via `buildSingleExternalMcpTool(id)` against `external_mcp_servers` (by id, with fallback to label match). Unmatched ids are silently dropped. When the field is undefined (chat and other non-agent callers), legacy behavior is preserved — the helper injects cinatra + WordPress + globally registered external MCPs.

## Tool types

| Type | Factory | Provider support | Notes |
|---|---|---|---|
| `LlmFunctionTool` | (inline) | All | Has `execute` callback; orchestration layer calls it when model issues a function call |
| `LlmShellTool` | `createShellTool`, `createLocalSkillShellTool` | All (OpenAI native; others simulate) | Exposes skill directories as virtual paths `/skills/<slug>` |
| `LlmMcpServerTool` | `createMcpServerTool`, `buildMcpTools` | OpenAI (native); Anthropic (native or function-tools, see below); Gemini (function tool shim) | Auto-injected for OpenAI/Anthropic via `injectMcpTools` in `index.ts` |
| `LlmWebSearchTool` | `createWebSearchTool` | OpenAI only (`web_search_preview`) | No execute handler — processed server-side by OpenAI |

### `LlmWebSearchTool`

`{ type: "web_search" }` — translates to `{ type: "web_search_preview" }` in the OpenAI Responses API. The model can fetch live URLs and follow links within a single multi-step conversation. Other provider adapters ignore this tool type.

Use when: the task requires fetching live web content and Crawlee is not available or not needed (e.g. the agent-scrape web search path).

### Local skill shell tool — virtual paths and pipe stripping

`createLocalSkillShellTool` exposes skills using virtual paths (`/skills/<slug>`) in the declaration — the real filesystem path is never sent to the LLM. `executeLocalSkillCommand` resolves virtual paths to real ones internally.

Supported commands: `cat`, `head`, `tail`. Pipe suffixes (`| sed`, `| sort`, etc.) are stripped before parsing. `cd <dir> &&` prefixes are also stripped.

### `maxSteps`

`DeterministicLlmExecutionInput` accepts an optional `maxSteps` field. Default for skill-aware tasks: 6 (enough for SKILL.md read + output, with room for one retry). Web search tasks typically need 10–15 steps (SKILL.md read + multiple page fetches).

### `extraTools` — additional tools through the orchestration wrapper

`SkillAwareDeterministicLlmExecutionInput` accepts `extraTools?: LlmTool[]`. Use this to pass additional tools alongside skill tools without calling `buildSkillTools` directly:

```typescript
await runResolvedSkillAwareDeterministicLlmTask({
  runtime: llmRuntime,
  skillIds: ["@cinatra/example-skill:extract-data"],
  extraTools: [createWebSearchTool()],
  // ...
});
```

### Skill delivery — internal concern

`buildSkillTools` and `readSkillContent` in `src/tools/skills.ts` are **internal helpers** — they are not exported from the package public API. Consumers must not import or call them directly. Pass `skillIds` to the orchestration wrapper functions instead.

The orchestration wrapper auto-selects the delivery method per provider:
- **OpenAI / Anthropic**: skills delivered as tools (`read_skill` / `shell`) via `buildSkillTools`
- **Gemini**: skill content inlined into the system prompt via `readSkillContent` (avoids the extra function-call round-trip)

## Anthropic MCP mode

The Anthropic adapter supports two MCP delivery modes, controlled by the `mcpMode` setting in `@cinatra-ai/anthropic-connector`:

| Mode | API path | Requirement |
|---|---|---|
| `"function-tools"` | `client.messages.create` (standard) | No beta required — MCP tools fetched as function tools via `fetchMcpToolsAsLlmFunctionTools` |
| `"native"` | `client.beta.messages.create` | Requires `mcp-client-2025-11-20` beta enabled on the Anthropic account |

**Default**: `"function-tools"`. The setting is stored in the anthropic-connector DB record. If `"native"` is stored and the beta call fails (e.g. the beta is not enabled on the account), the adapter automatically falls back to `"function-tools"` for that run and logs a warning.

**Shell tool**: `LlmShellTool` is translated to a standard function tool named `bash` (not to `bash_20250124`/computer-use). No additional beta headers are required.

## Adding a new provider

1. Add an adapter factory in `src/providers/<provider>.ts` implementing `LlmProviderAdapter`
2. Register it in `src/registry.ts` under `resolveProviderAdapter`
3. Export the factory from `src/index.ts`
4. If the provider supports native MCP tools, extend the `injectMcpTools` helper in `index.ts` to handle the new provider (the current implementation short-circuits Gemini and resolves MCP tools for `"openai" | "anthropic"`).

**Connector return objects must include `defaultModel`.** Any `getConfigured*Connection()` function that omits `defaultModel` from its return value causes the adapter to silently fall back to the hardcoded `DEFAULT_MODEL` constant — overriding whatever model the user configured in the UI and recording the wrong model in metrics-cost. Always pass `defaultModel: settings.defaultModel` in both the Nango path and the DB-fallback path of the connection function.

## Validation

```bash
pnpm --filter @cinatra-ai/llm typecheck
```
