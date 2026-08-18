// ---------------------------------------------------------------------------
// The two REPLAY hops the typed delegated-chat declaration travels through
// (cinatra#2771).
//
// Both live here rather than inline in `@/lib/mcp-server` for one reason: that
// module imports the entire connector/module graph and a database, so anything
// inline in it is unreachable from a unit test and can only be pinned as a
// SOURCE STRING — which proves a line exists and proves nothing about what it
// does. These two hops are exactly where a new field on a registration gets
// silently dropped, so "it exists" is the wrong assurance to settle for.
//
// Nothing here decides authorization. The narrow-only SEMANTICS live in
// `delegated-chat-tool-policy.ts` and are enforced at the choke point; this
// module only makes sure the value the registration wrote is still there when
// the choke point looks.
// ---------------------------------------------------------------------------

import { z } from "zod";
import type { McpRuntimeToolServer } from "@cinatra-ai/mcp-server";
import { readDeclaredDelegatedChatClass } from "@cinatra-ai/mcp-server/delegated-chat-tool-policy";
import type { DelegatedChatToolClass } from "@cinatra-ai/sdk-extensions";

export type CapturedMcpToolHandler = (...args: unknown[]) => unknown | Promise<unknown>;

/**
 * One entry in the host's in-process primitive map: the raw MCP-SDK callback
 * PLUS the typed delegated-chat declaration its registration carried.
 *
 * Before the declaration rode along, the in-process self-invoker and the live
 * transport could disagree about the SAME registration — the invoker had no
 * way to apply the narrow-only rule `policedRegisterTool` applies.
 */
export type CapturedHostPrimitive = {
  handler: CapturedMcpToolHandler;
  /**
   * Narrow-only. `undefined` means the registration declared nothing — which
   * the decision layer now reads as `none` (owner ruling, cinatra#2771) unless
   * `resolveDelegatedChatClass` supplies the interim class the legacy allowlist
   * implies for the name.
   */
  delegatedChat?: DelegatedChatToolClass;
};

/** The minimal shape the replay reads off a registered extension tool. */
export type ReplayedExtensionRegistration = {
  description?: string;
  inputSchema?: unknown;
  delegatedChat?: DelegatedChatToolClass;
};

/**
 * Build the `registerTool` config the extension REPLAY puts on the wire.
 *
 * This config is constructed FROM SCRATCH — only title/description/schema used
 * to be rebuilt — so a field on the original registration is dropped here by
 * DEFAULT, and silently: the declaration would read as present in the registry
 * and absent in the decision. Carrying `delegatedChat` is what makes
 * `policedRegisterTool` see the SAME declaration for a `ctx.mcp.registerTool`
 * extension that it sees for a manifest-discovered connector that passes it in
 * `config` directly.
 *
 * Narrow-only: what rides here can only remove this name from a delegated-chat
 * build, never add it to one.
 */
export function buildReplayedExtensionToolConfig(
  name: string,
  registration: ReplayedExtensionRegistration,
): Record<string, unknown> {
  return {
    title: name,
    description: registration.description ?? name,
    // Standard Schema (zod) — the MCP SDK validates against `~standard`.
    inputSchema: (registration.inputSchema as z.ZodTypeAny) ?? z.object({}).passthrough(),
    delegatedChat: registration.delegatedChat,
  };
}

/**
 * The pure RECORDING server the self-primitive capture pass runs against: it
 * touches no live transport and only writes into `handlers`.
 *
 * The non-`registerTool` surface is stubbed as no-ops — module registrations
 * only call `registerTool`, but the stubs keep an errant call from throwing.
 */
export function createSelfPrimitiveRecordingServer(
  handlers: Map<string, CapturedHostPrimitive>,
): McpRuntimeToolServer {
  return {
    registerTool: (name: string, config: unknown, handler: CapturedMcpToolHandler) => {
      // Mirror the live server: the MCP SDK rejects a duplicate tool name, so a
      // silent overwrite here would let the self-call surface diverge from the
      // live transport. Fail loudly instead.
      if (handlers.has(name)) {
        throw new Error(
          `[mcp] duplicate tool registration "${name}" during self-primitive capture (the live server would reject it)`,
        );
      }
      // Read the declaration off the SAME `config` the live server's
      // `policedRegisterTool` reads, with the same total reader, so the
      // recording pass and the live pass cannot disagree about what a module
      // declared.
      handlers.set(name, {
        handler,
        delegatedChat: readDeclaredDelegatedChatClass(config),
      });
      return undefined as never;
    },
    registerResource: () => undefined as never,
    registerPrompt: () => undefined as never,
    registerScreen: () => undefined,
  } as unknown as McpRuntimeToolServer;
}
