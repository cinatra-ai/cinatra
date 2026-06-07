/**
 * Provider registry — resolves connection configs to LlmProviderAdapter instances.
 */

import "server-only";

import { createOpenAIProviderAdapter, getConfiguredOpenAIConnection, type OpenAIConnectionConfig } from "./providers/openai";
import { createAnthropicProviderAdapter, type AnthropicConnectionConfig } from "./providers/anthropic";
import { createGeminiProviderAdapter, getConfiguredGeminiConnection } from "./providers/gemini";
import { buildLlmMcpServerTool, buildExternalMcpServerTools } from "./mcp-access";
import type { LlmProvider, LlmProviderAdapter, LlmMcpServerTool } from "./types";
// Anthropic API connection config is owned by @cinatra-ai/anthropic-connector.
// The MCP-client-registry connector owns inbound MCP-client OAuth client
// management only.
import { getConfiguredAnthropicConnection } from "@cinatra-ai/anthropic-connector";
import { readDefaultLlmProviderFromDatabase, readDefaultImageProviderFromDatabase } from "@/lib/database";
import {
  buildRegisteredExternalMcpServerTools,
  buildSingleExternalMcpTool,
} from "@/lib/external-mcp-registry";

// ---------------------------------------------------------------------------
// MCP server tool injection — OpenAI and Anthropic
// ---------------------------------------------------------------------------

/**
 * Single per-provider MCP tool resolver. Called only by `injectMcpTools` in
 * `index.ts`, the sole MCP injection site.
 *
 * When declaredToolboxIds is undefined → legacy always-inject set (cinatra
 * self-MCP + WordPress MCP + registered external MCPs, optionally skipping
 * the registry per skipExternalMcpRegistry).
 *
 * When declaredToolboxIds is defined → filtered set: "cinatra-mcp" resolves
 * to the Cinatra self-MCP; any other id resolves via buildSingleExternalMcpTool
 * (id → label fallback, isPrivateUrl guard, Nango credentials). Unmatched ids
 * are silently dropped.
 */
export async function resolveMcpToolsForDeclaredIds(params: {
  provider: "openai" | "anthropic";
  declaredToolboxIds: string[] | undefined;
  skipExternalMcpRegistry?: boolean;
  /**
   * Optional override for the `cinatra-mcp` toolbox resolution. When
   * non-null the override result REPLACES the default
   * `buildLlmMcpServerTool(provider)` (a machine `client_credentials`
   * bearer with no user/org identity). The bridge uses this to inject a
   * delegated agent-run-OBO Bearer so chat-dispatched agents inherit
   * the dispatching user's identity at the MCP boundary instead of
   * failing with `not_org_member`. External MCP toolboxes are
   * unaffected.
   *
   * If the override returns null, fall back to the machine-token path
   * — preserves pre-fix behavior for callers that opt in but cannot
   * mint a delegated token (e.g. legacy A2A bridge calls without a
   * resolved run-by user).
   */
  cinatraMcpToolOverride?: () => Promise<LlmMcpServerTool | null>;
}): Promise<LlmMcpServerTool[]> {
  const {
    provider,
    declaredToolboxIds,
    skipExternalMcpRegistry,
    cinatraMcpToolOverride,
  } = params;
  const resolveCinatraMcpTool = async (): Promise<LlmMcpServerTool | null> => {
    if (cinatraMcpToolOverride) {
      const overridden = await cinatraMcpToolOverride();
      if (overridden) return overridden;
    }
    return buildLlmMcpServerTool(provider);
  };
  if (declaredToolboxIds === undefined) {
    const cinatraMcpTool = await resolveCinatraMcpTool();
    const externalMcpTools = await buildExternalMcpServerTools(provider);
    const registeredMcpTools = skipExternalMcpRegistry
      ? []
      : await buildRegisteredExternalMcpServerTools();
    return [
      ...(cinatraMcpTool ? [cinatraMcpTool] : []),
      ...externalMcpTools,
      ...registeredMcpTools,
    ];
  }
  const tools: LlmMcpServerTool[] = [];
  for (const declaredId of declaredToolboxIds) {
    if (declaredId === "cinatra-mcp") {
      const cinatraMcpTool = await resolveCinatraMcpTool();
      if (cinatraMcpTool) tools.push(cinatraMcpTool);
      continue;
    }
    // Apify is managed outside external_mcp_servers; route the legacy
    // `apify-connector` toolbox id to the first-party builder. Without this
    // branch, declared-id resolution would silently drop Apify tools for any
    // agent that pinned `apify-connector` in its toolboxes.
    if (declaredId === "apify-connector") {
      const { buildApifyMcpServerTools } = await import("@/lib/apify-mcp-connection");
      const apifyTools = await buildApifyMcpServerTools(provider);
      tools.push(...apifyTools);
      if (apifyTools.length === 0) {
        console.warn(
          `[resolveMcpToolsForDeclaredIds] declared toolbox id "apify-connector" resolved to 0 tools (Nango unconfigured or no connection saved)`,
        );
      }
      continue;
    }
    const externalTool = await buildSingleExternalMcpTool(declaredId);
    if (externalTool) {
      tools.push(externalTool);
    } else {
      console.warn(
        `[resolveMcpToolsForDeclaredIds] declared toolbox id "${declaredId}" not found in external MCP registry — agent will run without this tool`,
      );
    }
  }
  return tools;
}

/**
 * The NON-cinatra MCP server tools for the chat: connected WordPress / Drupal
 * external servers + any externally-registered MCP servers (Apify, etc.).
 * Returns everything `resolveMcpToolsForDeclaredIds` would inject EXCEPT the
 * cinatra self-MCP — the chat builds that separately with a delegated
 * human-actor token (see runner.ts / buildLlmMcpServerToolForChat).
 *
 * Lives here (not as a widened `buildExternalMcpServerTools` index export)
 * so the chat runner consumes ONE package-level helper instead of importing
 * package internals + `@/lib/external-mcp-registry` itself.
 */
export async function resolveChatExternalMcpTools(
  provider: "openai" | "anthropic",
): Promise<LlmMcpServerTool[]> {
  const [externalMcpTools, registeredMcpTools] = await Promise.all([
    buildExternalMcpServerTools(provider),
    buildRegisteredExternalMcpServerTools(),
  ]);
  return [...externalMcpTools, ...registeredMcpTools];
}

// ---------------------------------------------------------------------------
// Resolve a provider adapter from stored connection config
// ---------------------------------------------------------------------------

export async function resolveProviderAdapter(provider: LlmProvider): Promise<LlmProviderAdapter | null> {
  switch (provider) {
    case "openai": {
      const connection = await getConfiguredOpenAIConnection();
      if (!connection?.apiKey) return null;
      return createOpenAIProviderAdapter(connection);
    }
    case "anthropic": {
      const connection = await getConfiguredAnthropicConnection();
      if (!connection?.apiKey) return null;
      return createAnthropicProviderAdapter(connection);
    }
    case "gemini": {
      const connection = await getConfiguredGeminiConnection();
      if (!connection?.apiKey) return null;
      return createGeminiProviderAdapter(connection.apiKey);
    }
  }
}

/**
 * Resolve the first available provider adapter from a preference list.
 * When no explicit list is provided, reads the DB-configured default provider
 * first, then falls back through all remaining providers in order.
 */
export async function resolveFirstAvailableAdapter(
  preferredProviders?: LlmProvider[],
): Promise<LlmProviderAdapter | null> {
  let providers: LlmProvider[];
  if (preferredProviders) {
    // Explicit caller preference (e.g. a per-purpose Anthropic selection) is
    // honored as-is — Anthropic IS a valid per-purpose target.
    providers = preferredProviders;
  } else {
    // Standing invariant: the GLOBAL default resolution (no explicit
    // preference) must never resolve Anthropic.
    // `readDefaultLlmProviderFromDatabase()` is already sanitized to
    // openai/gemini, but the implicit fallthrough list must ALSO exclude
    // Anthropic so an unavailable OpenAI cannot silently promote a connected
    // Anthropic to the resolved global adapter. Anthropic stays reachable via
    // an explicit `preferredProviders`/`resolveProviderAdapter("anthropic")`
    // per-purpose call — just never as the implicit global default.
    const dbDefault = readDefaultLlmProviderFromDatabase() as LlmProvider;
    const globalEligible: LlmProvider[] = ["openai", "gemini"];
    providers = [dbDefault, ...globalEligible.filter((p) => p !== dbDefault)];
  }

  for (const provider of providers) {
    const adapter = await resolveProviderAdapter(provider);
    if (adapter) return adapter;
  }

  return null;
}

/**
 * Check if any LLM runtime is available.
 */
export async function hasConfiguredLlmRuntime(preferredProviders?: LlmProvider[]): Promise<boolean> {
  return Boolean(await resolveFirstAvailableAdapter(preferredProviders));
}

/**
 * Resolve the system-default provider adapter.
 * Uses the admin-configured default from the database, falling back through
 * all providers in order until one is available.
 */
export async function resolveDefaultAdapter(): Promise<LlmProviderAdapter | null> {
  return resolveFirstAvailableAdapter();
}

/**
 * Resolve the adapter to use for image generation.
 * Reads the admin-configured image provider preference, then falls back to
 * the first available adapter that implements generateImage.
 */
export async function resolveDefaultImageAdapter(): Promise<LlmProviderAdapter | null> {
  const preferred = readDefaultImageProviderFromDatabase() as LlmProvider | null;
  const allProviders: LlmProvider[] = ["openai", "anthropic", "gemini"];
  const ordered: LlmProvider[] = preferred
    ? [preferred, ...allProviders.filter((p) => p !== preferred)]
    : allProviders;

  for (const provider of ordered) {
    const adapter = await resolveProviderAdapter(provider);
    if (adapter?.generateImage) return adapter;
  }
  return null;
}

// Re-export adapter factories for direct use when connection is already known
export { createOpenAIProviderAdapter } from "./providers/openai";
export { createAnthropicProviderAdapter } from "./providers/anthropic";
export { createGeminiProviderAdapter } from "./providers/gemini";
export type { OpenAIConnectionConfig, AnthropicConnectionConfig };
