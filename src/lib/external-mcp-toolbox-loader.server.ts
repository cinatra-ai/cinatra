import "server-only";

// Manifest-driven discovery of extension external-MCP toolboxes. The generated
// manifest (scripts/extensions/generate-extension-manifest.mjs) carries
// slug-keyed loader entries — a literal dynamic import of the extension's
// `mcp-toolbox` subpath plus the factory export name — so the LLM
// toolbox-injection path resolves first-party external-MCP builders WITHOUT
// importing any extension package by name. Same posture as
// src/lib/connector-mcp-registration.server.ts (the connector MCP-module
// loader): the manifest is the single place an extension is named; the host
// consumes shapes.
//
// FAIL LOUDLY here: a loader entry that exists but cannot be imported, or
// whose recorded factory is missing/not a function, or whose module has no
// `buildTools`, throws — a silently skipped toolbox would drop external MCP
// servers off every LLM call with no failure signal. CALLERS in the injection
// path catch per-extension and degrade to "no tools from this extension"
// (the long-standing never-throw toolbox contract).

import type {
  ExtensionExternalMcpTool,
  ExtensionExternalMcpToolbox,
} from "@cinatra-ai/sdk-extensions";
import {
  GENERATED_EXTERNAL_MCP_TOOLBOXES,
  type GeneratedConnectorFactoryEntry,
} from "@/lib/generated/extensions.server";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";

/**
 * Validate one toolbox-produced tool entry. Toolbox modules are extension
 * code behind a structural contract — a malformed entry must not escape the
 * caller's per-extension boundary and blow up dedupe/provider code downstream.
 */
function isValidExternalMcpTool(tool: unknown): tool is ExtensionExternalMcpTool {
  if (!tool || typeof tool !== "object") return false;
  const candidate = tool as { type?: unknown; serverLabel?: unknown; serverUrl?: unknown };
  return (
    candidate.type === "mcp" &&
    typeof candidate.serverLabel === "string" &&
    typeof candidate.serverUrl === "string"
  );
}

/**
 * Sanitize a toolbox `buildTools` result: THROWS on a non-array (contract
 * violation — callers catch per extension/id), drops invalid entries with a
 * warning, returns the valid tools. EVERY consumer of a manifest-resolved
 * toolbox (the always-inject enumeration, the declared-toolbox-id branch, the
 * transitional apify shim) must route builder output through this.
 */
export function sanitizeExternalMcpToolboxTools(
  slug: string,
  built: unknown,
): ExtensionExternalMcpTool[] {
  if (!Array.isArray(built)) {
    throw new Error(
      `[external-mcp-toolbox-loader] toolbox "${slug}" returned a non-array from buildTools`,
    );
  }
  const valid: ExtensionExternalMcpTool[] = [];
  for (const tool of built) {
    if (isValidExternalMcpTool(tool)) {
      valid.push(tool);
    } else {
      console.warn(
        `[external-mcp-toolbox-loader] toolbox "${slug}" produced an invalid tool entry — dropped`,
      );
    }
  }
  return valid;
}

async function resolveToolboxFactory(
  slug: string,
  entry: GeneratedConnectorFactoryEntry,
): Promise<(() => unknown) | null> {
  const loaded = await entry.load();
  if (isDegradedExtensionLoad(loaded)) {
    // cinatra#7: an absent optional toolbox module degrades to "no
    // first-party builder" per entry (loud warn) — same observable outcome as
    // an extension without a toolbox entry, never a thrown 500 in the
    // injection path.
    console.warn(
      `[external-mcp-toolbox-loader] "${slug}": optional toolbox module is absent post-build — ` +
        `degrading to no-toolbox (${loaded.reason})`,
    );
    return null;
  }
  const ns = loaded as Record<string, unknown>;
  const factory = ns[entry.factory];
  if (typeof factory !== "function") {
    throw new Error(
      `[external-mcp-toolbox-loader] "${slug}": manifest factory "${entry.factory}" is not an exported function`,
    );
  }
  return factory as () => unknown;
}

/**
 * Resolve an extension's first-party external-MCP toolbox module from the
 * generated manifest loader map, or `null` when the slug has no entry (the
 * extension's external MCP server resolves through the `external_mcp_servers`
 * registry instead).
 */
export async function loadExternalMcpToolboxBySlug(
  slug: string,
): Promise<ExtensionExternalMcpToolbox | null> {
  const entry = GENERATED_EXTERNAL_MCP_TOOLBOXES[slug];
  if (!entry) return null;
  const factory = await resolveToolboxFactory(slug, entry);
  if (!factory) return null; // absent optional module — degraded per entry above
  const toolbox = factory() as ExtensionExternalMcpToolbox | null;
  if (!toolbox || typeof toolbox.buildTools !== "function") {
    throw new Error(
      `[external-mcp-toolbox-loader] "${slug}": factory "${entry.factory}" did not return an external-MCP toolbox module`,
    );
  }
  return toolbox;
}
