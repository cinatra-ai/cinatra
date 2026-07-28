/**
 * Provider registry — resolves connection configs to LlmProviderAdapter instances.
 */

import "server-only";

import type { ExtensionToolboxBuildContext } from "@cinatra-ai/sdk-extensions";
import { buildLlmMcpServerTool, buildExternalMcpServerTools } from "./mcp-access";
import { isScriptedTestProviderEnabled } from "./scripted-test-provider";
import type { LlmProvider, LlmProviderAdapter, LlmMcpServerTool } from "./types";
// llm-providers S4 switch-over (cinatra#1715): every provider adapter now lives
// in its connector and registers the `llm-provider-adapter` capability surface.
// packages/llm carries NO in-tree adapter and NO connector value-imports; a
// provider is resolvable ONLY through `getLlmProviderAdapterSurface` (co-located
// in llm-provider-surfaces so it adds no net-new route-reachable module). A
// provider whose connector is absent is honestly unavailable (null), never a
// silent fallback to deleted in-core code; a registered-but-malformed surface
// makes `getLlmProviderAdapterSurface` THROW (fail closed).
import { getLlmProviderAdapterSurface } from "@/lib/llm-provider-surfaces";
import { readDefaultLlmProviderFromDatabase, readDefaultImageProviderFromDatabase } from "@/lib/database";
import {
  buildRegisteredExternalMcpServerTools,
  buildSingleExternalMcpTool,
} from "@/lib/external-mcp-registry";
import {
  loadExternalMcpToolboxBySlug,
  sanitizeExternalMcpToolboxTools,
} from "@/lib/external-mcp-toolbox-loader.server";

/**
 * First-wins dedupe by `serverLabel`. The manifest-driven toolbox path and the
 * registry-wide global injection can both resolve the SAME
 * `external_mcp_servers` row (identical label + content) for a marker-bearing
 * extension without a first-party builder; providers reject duplicate server
 * labels, so the combined list keeps the first occurrence. A label collision
 * with DIFFERENT definitions indicates a real configuration bug — warn.
 */
function dedupeMcpToolsByServerLabel(tools: LlmMcpServerTool[]): LlmMcpServerTool[] {
  const seen = new Map<string, LlmMcpServerTool>();
  for (const tool of tools) {
    const existing = seen.get(tool.serverLabel);
    if (!existing) {
      seen.set(tool.serverLabel, tool);
      continue;
    }
    if (existing.serverUrl !== tool.serverUrl) {
      console.warn(
        `[llm-registry] duplicate MCP server label "${tool.serverLabel}" with different URLs — keeping the first`,
      );
    }
  }
  return [...seen.values()];
}

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
   * A present override OWNS cinatra self-MCP resolution INCLUDING the
   * machine-token fallback: the bridge mints the machine
   * `client_credentials` token itself so the durable run-context binding
   * (#1195) is keyed to the EXACT bearer attached to the tool. A null
   * result is therefore AUTHORITATIVE (no tool) — re-minting here would
   * attach a bearer that carries no binding (silently reintroducing the
   * process-local registry's cross-run aliasing risk) and double the
   * token-endpoint load. Degrade toward no tool, never toward an unbound
   * one.
   */
  cinatraMcpToolOverride?: () => Promise<LlmMcpServerTool | null>;
  /**
   * Host-built, identity-free toolbox build context (cinatra#2019 S4):
   * `{ surface, connectorInstancePin? }`. Threaded into first-party
   * manifest-toolbox `buildTools(provider, context)` calls on BOTH the
   * always-inject and the declared-id path so surface-gating toolboxes can
   * discriminate chat / agent_run / widget builds (absent ⇒ they emit
   * nothing, fail-closed). NOT passed to the `llm-toolbox` capability
   * providers or the `external_mcp_servers` registry resolver — neither
   * performs per-instance site injection.
   */
  context?: ExtensionToolboxBuildContext;
}): Promise<LlmMcpServerTool[]> {
  const {
    provider,
    declaredToolboxIds,
    skipExternalMcpRegistry,
    cinatraMcpToolOverride,
    context,
  } = params;
  const resolveCinatraMcpTool = async (): Promise<LlmMcpServerTool | null> => {
    if (cinatraMcpToolOverride) {
      // Authoritative (see the option doc above): the override owns every
      // fallback, so a null here must NOT trigger a second machine mint —
      // that bearer would carry no durable run-context binding (#1195).
      return cinatraMcpToolOverride();
    }
    return buildLlmMcpServerTool(provider);
  };
  if (declaredToolboxIds === undefined) {
    const cinatraMcpTool = await resolveCinatraMcpTool();
    // skipExternalMcpRegistry must ALSO suppress the manifest path's
    // registry fallback (marker-bearing extensions without a first-party
    // builder resolve through external_mcp_servers rows) — otherwise the
    // opt-out would be reachable through the back door.
    const externalMcpTools = await buildExternalMcpServerTools(provider, {
      skipRegistryFallback: skipExternalMcpRegistry === true,
      context,
    });
    const registeredMcpTools = skipExternalMcpRegistry
      ? []
      : await buildRegisteredExternalMcpServerTools();
    return [
      ...(cinatraMcpTool ? [cinatraMcpTool] : []),
      ...dedupeMcpToolsByServerLabel([...externalMcpTools, ...registeredMcpTools]),
    ];
  }
  const tools: LlmMcpServerTool[] = [];
  for (const declaredId of declaredToolboxIds) {
    if (declaredId === "cinatra-mcp") {
      const cinatraMcpTool = await resolveCinatraMcpTool();
      if (cinatraMcpTool) tools.push(cinatraMcpTool);
      continue;
    }
    // Registration-driven toolbox resolution: a connector managed OUTSIDE
    // external_mcp_servers (apify today) registers an `llm-toolbox` capability
    // provider for its declared toolbox id from its own serverEntry. Without
    // this lookup, declared-id resolution would silently drop those tools for
    // any agent that pinned the connector's toolbox id.
    const { buildToolboxProviderTools } = await import("@/lib/llm-toolbox-providers");
    const providerTools = await buildToolboxProviderTools(declaredId, provider);
    if (providerTools !== null) {
      tools.push(...providerTools);
      if (providerTools.length === 0) {
        console.warn(
          `[resolveMcpToolsForDeclaredIds] declared toolbox id "${declaredId}" resolved to 0 tools (connection unconfigured or not saved)`,
        );
      }
      continue;
    }
    // Manifest-driven first-party toolboxes: a declared id matching a slug in
    // the generated external-MCP toolbox loader map resolves through the
    // extension's own builder (same source as the legacy always-inject set) —
    // no host edit per extension. Failures degrade to "no tools from this id"
    // (declared-id resolution never throws).
    try {
      const toolbox = await loadExternalMcpToolboxBySlug(declaredId);
      if (toolbox) {
        const toolboxTools = sanitizeExternalMcpToolboxTools(
          declaredId,
          await toolbox.buildTools(provider, context),
        );
        tools.push(...toolboxTools);
        if (toolboxTools.length === 0) {
          console.warn(
            `[resolveMcpToolsForDeclaredIds] declared toolbox id "${declaredId}" resolved to 0 tools (extension unconfigured or endpoints unreachable)`,
          );
        }
        continue;
      }
    } catch (err) {
      console.warn(
        `[resolveMcpToolsForDeclaredIds] declared toolbox id "${declaredId}" failed to resolve via the manifest toolbox loader — agent will run without this tool`,
        err instanceof Error ? err.message : String(err),
      );
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
  /**
   * Host-derived build context for the chat surface (cinatra#2019 S4). The
   * assistant runtime passes `{ surface: "chat" }` for cookie-session turns
   * and `{ surface: "public_site_widget" }` for widget-principal turns — the
   * two share this plumbing, so the explicit surface is what lets a
   * surface-gating toolbox refuse widget builds fail-closed. Absent ⇒
   * toolboxes that gate on it emit nothing (unwidened-caller fail-closed).
   */
  context?: ExtensionToolboxBuildContext,
): Promise<LlmMcpServerTool[]> {
  const [externalMcpTools, registeredMcpTools] = await Promise.all([
    buildExternalMcpServerTools(provider, { context }),
    buildRegisteredExternalMcpServerTools(),
  ]);
  return dedupeMcpToolsByServerLabel([...externalMcpTools, ...registeredMcpTools]);
}

// ---------------------------------------------------------------------------
// Resolve a provider adapter from stored connection config
// ---------------------------------------------------------------------------

export async function resolveProviderAdapter(provider: LlmProvider): Promise<LlmProviderAdapter | null> {
  // llm-providers S4 switch-over (cinatra#1715): a provider is resolvable ONLY
  // through its CONNECTOR-registered `llm-provider-adapter` surface. The
  // connector OWNS resolution — the result (an adapter, or a `null` "connector
  // present but not configured") is AUTHORITATIVE. When the surface is ABSENT
  // (the provider's connector is not installed/registered), the provider is
  // honestly UNAVAILABLE (`null`) — the in-core factories were deleted, so there
  // is NO silent fallback. A registered-but-malformed surface makes
  // `getLlmProviderAdapterSurface` THROW (fail closed), so a broken adapter can
  // never silently downgrade.
  const surface = getLlmProviderAdapterSurface(provider);
  if (!surface) return null;
  const adapter = await surface.createAdapter();
  return (adapter ?? null) as LlmProviderAdapter | null;
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
  // Scripted-test-provider seam (dev/CI UAT only; #1919 AC3). When the
  // deterministic provider is enabled the runtime IS "configured": the widget
  // broker gate (and every hasConfiguredLlmRuntime caller) must not 400 the turn
  // before the scripted stream can answer, since the deterministic UAT app
  // carries no real provider creds. Production is untouched — the flag is never
  // set there, and the scripted stream itself fail-closes outside an explicit
  // development runtime (assertScriptedProviderNotProduction at the stream entry).
  if (isScriptedTestProviderEnabled()) return true;
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

// Adapter factories are no longer re-exported: every provider adapter lives in
// its connector (cinatra#1715). Callers resolve an adapter via
// `resolveProviderAdapter` / `resolveFirstAvailableAdapter`, which go through
// the connector-registered `llm-provider-adapter` surface.
