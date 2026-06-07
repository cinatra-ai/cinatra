/**
 * Vitest stub for `@cinatra-ai/mcp-server`.
 *
 * Mirrors packages/objects/src/__tests__/__stubs__/mcp-server.ts. Real
 * entry point imports next/navigation + better-auth + react which can't
 * be loaded in node tests. We only need `mcpRequestContextStorage` for
 * the registry path.
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
