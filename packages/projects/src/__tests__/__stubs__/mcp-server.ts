/**
 * Vitest stub for `@cinatra-ai/mcp-server`.
 *
 * Mirrors packages/objects/src/__tests__/__stubs__/mcp-server.ts. Real
 * entry point imports next/navigation + better-auth + react which can't
 * be loaded in node tests. We only need `mcpRequestContextStorage` for
 * the registry path.
 *
 * THIS FILE NOW BACKS TWO SPECIFIERS (cinatra#2817 N2): the bare barrel
 * `@cinatra-ai/mcp-server` AND the `@cinatra-ai/mcp-server/request-context`
 * subpath, both aliased here by this package's vitest config. They MUST keep
 * resolving to this one file. `mcpRequestContextStorage` is a live
 * AsyncLocalStorage, so two resolutions would be two storages: a frame opened
 * through one is invisible through the other, and a writer would silently see
 * no context instead of failing. Anything the subpath's real module
 * (`packages/mcp-server/src/request-context.ts`) exports and a test needs must
 * be added HERE, never by re-pointing the subpath at real source.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export const mcpRequestContextStorage = new AsyncLocalStorage<{
  clientId?: string;
  orgId?: string | null;
  userId?: string | null;
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
  platformRole?: "platform_admin" | "user";
}>();

export type McpRuntimeToolServer = {
  registerTool: (name: string, meta: unknown, handler: (input: unknown) => Promise<unknown>) => void;
};
