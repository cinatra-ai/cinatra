import "server-only";

// Manifest-driven discovery of connector MCP surfaces. The generated manifest
// (scripts/extensions/generate-extension-manifest.mjs) carries slug-keyed
// loader entries — a literal dynamic import of the connector's `mcp-module` /
// `mcp-handlers` subpath plus the factory export name — so the host registers
// connector MCP capability modules and captures connector primitive handlers
// WITHOUT importing any connector package by name. This is the same posture as
// src/lib/connector-modules.server.ts (the connector entry-module loader): the
// manifest is the single place a connector is named; the host consumes shapes.
//
// FAIL LOUDLY: a loader entry whose PRESENT module cannot be imported, or
// whose recorded factory is missing/not a function, throws — exactly like the
// static import it replaces. A silently skipped module would drop tools off
// the MCP surface with no failure signal. ONE deliberate exception
// (cinatra#7): a `guardedOptional` entry whose target module is ABSENT
// post-build (marketplace uninstall) resolves the standardized degraded
// result and is skipped per entry with a loud warn — absence is a legitimate
// state for an optional connector, not a broken one.

import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import {
  GENERATED_CONNECTOR_MCP_MODULES,
  GENERATED_CONNECTOR_PRIMITIVE_HANDLERS,
  type GeneratedConnectorFactoryEntry,
} from "@/lib/generated/extensions.server";
import { isDegradedExtensionLoad } from "@/lib/extension-load-guard";

/**
 * Host-provided actor resolution for connector tools that must derive the
 * human subject (userId/orgId) from the request/run context — the MCP SDK
 * `extra` carries no actor. Passed UNIFORMLY to every connector module
 * factory; connectors that don't take options simply ignore it.
 */
export type ConnectorActorResolver = () => Promise<{ userId?: string; orgId?: string }>;

export type ConnectorModuleHostOptions = {
  resolveActor?: ConnectorActorResolver;
};

/**
 * The data contract a connector MCP-module factory returns: an object exposing
 * `registerCapabilities(server)`. Connectors type the server parameter against
 * the SDK's structural `ExtensionMcpToolServer` contract, which the host's
 * `McpRuntimeToolServer` satisfies (proven by the contract-assignability test).
 */
export type ConnectorCapabilityModule = {
  registerCapabilities: (server: McpRuntimeToolServer) => void | Promise<void>;
};

/** The captured in-process primitive handler shape (request → result). */
export type ConnectorPrimitiveHandler = (request: unknown) => Promise<unknown>;

async function resolveFactory(
  slug: string,
  entry: GeneratedConnectorFactoryEntry,
): Promise<((...args: unknown[]) => unknown) | null> {
  const loaded = await entry.load();
  if (isDegradedExtensionLoad(loaded)) {
    console.warn(
      `[connector-mcp-registration] "${slug}": optional connector module is absent post-build — ` +
        `skipping this MCP surface entry (${loaded.reason})`,
    );
    return null;
  }
  const ns = loaded as Record<string, unknown>;
  const factory = ns[entry.factory];
  if (typeof factory !== "function") {
    throw new Error(
      `[connector-mcp-registration] "${slug}": manifest factory "${entry.factory}" is not an exported function`,
    );
  }
  return factory as (...args: unknown[]) => unknown;
}

/**
 * Load every connector MCP capability module recorded in the generated
 * manifest, in the manifest's deterministic (slug-sorted) order. Each factory
 * receives the SAME host options object; the returned modules are ready for
 * `registerCapabilities(server)`.
 */
export async function loadConnectorMcpModules(
  options: ConnectorModuleHostOptions = {},
): Promise<ConnectorCapabilityModule[]> {
  const modules: ConnectorCapabilityModule[] = [];
  for (const [slug, entry] of Object.entries(GENERATED_CONNECTOR_MCP_MODULES)) {
    const factory = await resolveFactory(slug, entry);
    if (!factory) continue; // absent optional module — degraded per entry above
    const mod = factory(options) as ConnectorCapabilityModule | null;
    if (!mod || typeof mod.registerCapabilities !== "function") {
      throw new Error(
        `[connector-mcp-registration] "${slug}": factory "${entry.factory}" did not return a capability module`,
      );
    }
    modules.push(mod);
  }
  return modules;
}

/**
 * Capture every connector's in-process primitive handlers recorded in the
 * generated manifest into one `name → handler` map (manifest slug order; tool
 * names are connector-prefixed, so collisions indicate a real bug and throw).
 */
export async function loadConnectorPrimitiveHandlers(): Promise<
  Record<string, ConnectorPrimitiveHandler>
> {
  const all: Record<string, ConnectorPrimitiveHandler> = {};
  for (const [slug, entry] of Object.entries(GENERATED_CONNECTOR_PRIMITIVE_HANDLERS)) {
    const factory = await resolveFactory(slug, entry);
    if (!factory) continue; // absent optional module — degraded per entry above
    const handlers = factory() as Record<string, ConnectorPrimitiveHandler> | null;
    if (!handlers || typeof handlers !== "object") {
      throw new Error(
        `[connector-mcp-registration] "${slug}": factory "${entry.factory}" did not return a handler map`,
      );
    }
    for (const [name, handler] of Object.entries(handlers)) {
      if (name in all) {
        throw new Error(
          `[connector-mcp-registration] duplicate primitive handler "${name}" (from "${slug}")`,
        );
      }
      all[name] = handler;
    }
  }
  return all;
}
