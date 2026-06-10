import "server-only";

import type { LlmMcpServerTool, LlmProvider } from "@cinatra-ai/llm";
import {
  loadExternalMcpToolboxBySlug,
  sanitizeExternalMcpToolboxTools,
} from "@/lib/external-mcp-toolbox-loader.server";

// ---------------------------------------------------------------------------
// TRANSITIONAL shim for the Apify first-party toolbox.
//
// The builder itself lives in the apify-connector extension's `mcp-toolbox`
// module, resolved through the generated manifest loader map — this file names
// NO extension package. It survives only because the declared-toolbox-id
// resolution in packages/llm/src/registry.ts routes the legacy
// "apify-connector" toolbox id through this entry point; that branch (and with
// it this shim) is retired by the provider/transport-registration cutover.
//
// Contract preserved: returns [] on any failure — never throws (the
// declared-id path has no catch of its own around this call).
// ---------------------------------------------------------------------------

const APIFY_TOOLBOX_SLUG = "apify-connector";

export async function buildApifyMcpServerTools(
  provider: LlmProvider,
): Promise<LlmMcpServerTool[]> {
  try {
    const toolbox = await loadExternalMcpToolboxBySlug(APIFY_TOOLBOX_SLUG);
    if (!toolbox) {
      console.warn(
        `[apify-mcp-connection] no generated external-MCP toolbox entry for "${APIFY_TOOLBOX_SLUG}" — returning empty list`,
      );
      return [];
    }
    return sanitizeExternalMcpToolboxTools(
      APIFY_TOOLBOX_SLUG,
      await toolbox.buildTools(provider),
    );
  } catch (err) {
    console.warn(
      `[apify-mcp-connection] buildApifyMcpServerTools failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}
