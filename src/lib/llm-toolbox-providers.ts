import "server-only";

// Host-side resolution of `llm-toolbox` capability providers.
//
// A connector whose MCP server is managed OUTSIDE the `external_mcp_servers`
// registry (apify today) registers an `LlmToolboxProvider` behind the
// `llm-toolbox` capability from its own `serverEntry`
// (`register(ctx)` → `ctx.capabilities.registerProvider("llm-toolbox", …)`).
// The LLM injection paths (`packages/llm/src/registry.ts` declared-id
// resolution and `mcp-access.ts`'s legacy always-inject set) resolve declared
// toolbox ids HERE — never by branching on a hardcoded connector id.

import type { LlmToolboxProvider } from "@cinatra-ai/sdk-extensions";
import { LLM_TOOLBOX_CAPABILITY } from "@cinatra-ai/sdk-extensions/internal";
import { resolveCapabilityProviders } from "@/lib/extension-capabilities-registry";
import type { LlmMcpServerTool, LlmProvider } from "@cinatra-ai/llm";

// Structural guard: a capability impl is `unknown` by contract.
function isLlmToolboxProvider(impl: unknown): impl is LlmToolboxProvider {
  if (typeof impl !== "object" || impl === null) return false;
  const candidate = impl as { toolboxId?: unknown; build?: unknown };
  return typeof candidate.toolboxId === "string" && typeof candidate.build === "function";
}

// Structural guard on the BUILT tools: the provider's `build` contract returns
// `unknown[]` (the SDK does not import the llm package); validate the minimal
// MCP-server-tool shape before injection so a malformed provider result can
// never reach an LLM request.
function isLlmMcpServerToolLike(tool: unknown): tool is LlmMcpServerTool {
  if (typeof tool !== "object" || tool === null) return false;
  const candidate = tool as { type?: unknown; serverLabel?: unknown; serverUrl?: unknown };
  return (
    candidate.type === "mcp" &&
    typeof candidate.serverLabel === "string" &&
    typeof candidate.serverUrl === "string"
  );
}

/** The live `llm-toolbox` providers. */
export function resolveLlmToolboxProviders(): LlmToolboxProvider[] {
  return resolveCapabilityProviders(LLM_TOOLBOX_CAPABILITY)
    .map((p) => p.impl)
    .filter(isLlmToolboxProvider);
}

/**
 * Build the MCP server tools for ONE declared toolbox id, or null when no
 * registered provider serves that id (the caller falls through to the
 * external-MCP registry). Build failures degrade to an empty injection —
 * matching the registry-path semantics (never throw into the LLM call).
 */
export async function buildToolboxProviderTools(
  declaredId: string,
  provider: LlmProvider,
): Promise<LlmMcpServerTool[] | null> {
  const match = resolveLlmToolboxProviders().find((p) => p.toolboxId === declaredId);
  if (!match) return null;
  try {
    const built = await match.build(provider);
    return (Array.isArray(built) ? built : []).filter(isLlmMcpServerToolLike);
  } catch (err) {
    console.warn(
      `[llm-toolbox] provider for "${declaredId}" failed to build tools: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

/**
 * Build the MCP server tools across EVERY registered toolbox provider — the
 * legacy always-inject set (no declared ids) includes these alongside the
 * wordpress/drupal builders and the external-MCP registry.
 */
export async function buildAllToolboxProviderTools(
  provider: LlmProvider,
): Promise<LlmMcpServerTool[]> {
  const out: LlmMcpServerTool[] = [];
  for (const toolbox of resolveLlmToolboxProviders()) {
    const tools = await buildToolboxProviderTools(toolbox.toolboxId, provider);
    if (tools) out.push(...tools);
  }
  return out;
}
