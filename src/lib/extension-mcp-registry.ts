import "server-only";

// Host-owned registry of MCP tools an extension registers via `ctx.mcp.registerTool`
// (the `mcp` host port). EMPTY by default — no extension registers a tool unless
// it opts in (grants "mcp" + calls registerTool in register(ctx)). The MCP server
// build (`registerAllCapabilities`) replays this registry AFTER the static
// modules, skipping any tool name a static module already claimed. So with an
// empty registry the replay is a no-op and the existing chat/agent MCP tool set
// is byte-for-byte unchanged.
//
// CROSS-COMPILATION SINGLETON: Next.js 16 builds separate bundler compilations
// (instrumentation / route / RSC), each with its own module cache. The loader
// registers tools at boot (instrumentation compilation); the MCP route reads them
// at request time (route compilation) — so the registry MUST be a true
// per-process singleton, anchored on a namespaced+versioned `Symbol.for(...)` key
// (same pattern as the email/social connector registries).

import type { HostMcpToolRegistration } from "@cinatra-ai/sdk-extensions";

export type RegisteredExtensionMcpTool = HostMcpToolRegistration & { packageName: string };

class ExtensionMcpRegistryImpl {
  private entries: Map<string, RegisteredExtensionMcpTool> = new Map();

  register(packageName: string, tool: HostMcpToolRegistration): void {
    const name = tool?.name;
    if (!name || typeof name !== "string") {
      throw new Error(`[extensionMcpRegistry] ${packageName} registered an MCP tool with no name`);
    }
    if (typeof tool.handler !== "function") {
      throw new Error(`[extensionMcpRegistry] ${packageName} MCP tool "${name}" has no handler`);
    }
    const existing = this.entries.get(name);
    if (existing && existing.packageName !== packageName) {
      console.warn(
        `[extensionMcpRegistry] tool "${name}" re-registered by ${packageName} (was ${existing.packageName})`,
      );
    }
    this.entries.set(name, { ...tool, packageName });
  }

  listAll(): readonly RegisteredExtensionMcpTool[] {
    return Array.from(this.entries.values());
  }

  /**
   * Remove every tool a package registered (uninstall/teardown). Returns the
   * removed tool names. Without this, an uninstalled extension's MCP tools
   * persisted in this memory-only registry until process restart — a split-brain
   * hole: the tool stayed listable + invocable and kept shadow-allowing in the
   * authz effective-set after the extension was gone.
   */
  removeByPackage(packageName: string): string[] {
    const removed: string[] = [];
    for (const [name, tool] of this.entries) {
      if (tool.packageName === packageName) {
        this.entries.delete(name);
        removed.push(name);
      }
    }
    return removed;
  }

  size(): number {
    return this.entries.size;
  }

  /** @internal Only for tests. */
  _clearForTests(): void {
    this.entries.clear();
  }
}

const EXTENSION_MCP_REGISTRY_KEY = Symbol.for("@cinatra-ai/host:extension-mcp-registry/v1");
type RegistryHolder = { [k: symbol]: ExtensionMcpRegistryImpl | undefined };
const _holder = globalThis as unknown as RegistryHolder;
export const extensionMcpRegistry: ExtensionMcpRegistryImpl =
  _holder[EXTENSION_MCP_REGISTRY_KEY] ??
  (_holder[EXTENSION_MCP_REGISTRY_KEY] = new ExtensionMcpRegistryImpl());

export function registerExtensionMcpTool(packageName: string, tool: HostMcpToolRegistration): void {
  extensionMcpRegistry.register(packageName, tool);
}

export function listExtensionMcpTools(): readonly RegisteredExtensionMcpTool[] {
  return extensionMcpRegistry.listAll();
}

/**
 * A REDACTED diagnostic snapshot of the registered extension MCP tools — tool name
 * + owning packageName ONLY, never the handler. For the operator control-plane
 * endpoint, so the aggregator never has to carry handler-bearing registry entries.
 */
export function snapshotExtensionMcpTools(): { name: string; packageName: string }[] {
  return extensionMcpRegistry.listAll().map((t) => ({ name: t.name, packageName: t.packageName }));
}

/**
 * Teardown an uninstalled extension's MCP tools: drop them from the registry AND
 * from the authz effective-set, so the tool is no longer listable, invocable, or
 * shadow-allowed the moment the extension is gone (no restart needed). Returns
 * the removed tool names. Safe no-op for a package that registered nothing.
 */
export function removeExtensionMcpToolsForPackage(packageName: string): string[] {
  const removed = extensionMcpRegistry.removeByPackage(packageName);
  const eff = _effHolder[EFFECTIVE_KEY];
  if (eff) {
    for (const [name, pkg] of eff) {
      if (pkg === packageName) eff.delete(name);
    }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// EFFECTIVE set — the tool names the MCP-server build (`registerAllCapabilities`)
// ACTUALLY replayed into the server, EXCLUDING names skipped due to a static or
// reserved host-tool collision. The authz boundary consults THIS (not raw
// registry membership) so an extension cannot unlock a host tool (e.g. an
// unclassified built-in like `system_screen_lookup`) by registering its name —
// such a registration is skipped by the replay and never becomes "effective".
// globalThis-anchored (same cross-compilation reason as the registry); last
// server-build wins (the static + reserved name set is stable per process).
const EFFECTIVE_KEY = Symbol.for("@cinatra-ai/host:extension-mcp-effective/v1");
type EffectiveHolder = { [k: symbol]: Map<string, string> | undefined };
const _effHolder = globalThis as unknown as EffectiveHolder;

/** Record the extension tools that were effectively registered into a server build. */
export function markEffectiveExtensionMcpTools(tools: ReadonlyArray<{ name: string; packageName: string }>): void {
  const m = new Map<string, string>();
  for (const t of tools) m.set(t.name, t.packageName);
  _effHolder[EFFECTIVE_KEY] = m;
}

/** The owning package if `name` is an EFFECTIVELY-registered extension tool, else undefined. */
export function getEffectiveExtensionMcpTool(name: string): { packageName: string } | undefined {
  const pkg = _effHolder[EFFECTIVE_KEY]?.get(name);
  return pkg ? { packageName: pkg } : undefined;
}

/** @internal Tests only — clear both the registry and the effective set. */
export function _resetExtensionMcpForTests(): void {
  extensionMcpRegistry._clearForTests();
  _effHolder[EFFECTIVE_KEY] = new Map();
}
