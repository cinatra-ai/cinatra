/**
 * Vitest stub for @cinatra-ai/mcp-server. The real module imports from
 * `@/components/ui/...` which isn't resolvable from the test process.
 * We only need the type surface used by our registry — supply minimal shims.
 *
 * Backed by a real AsyncLocalStorage so tests can wrap calls in
 * `mcpRequestContextStorage.run({...}, fn)` to exercise the
 * identity-resolution path (top-level vs a2aActorContext precedence) and
 * the ALS-survives-await invariant the production handler relies on.
 */
import { AsyncLocalStorage } from "node:async_hooks";

export type McpRequestContext = {
  clientId?: string;
  orgId?: string | null;
  userId?: string | null;
  runId?: string;
  agentId?: string;
  packageVersion?: string;
  agentSpecVersion?: string;
  platformRole?: "platform_admin" | "member";
  a2aActorContext?: {
    userId?: string;
    orgId?: string | null;
    tokenScopes?: string[];
    teamIds?: string[];
    projectIds?: string[];
    clientId?: string;
  } | null;
};

export const mcpRequestContextStorage = new AsyncLocalStorage<McpRequestContext>();

export type McpRuntimeToolServer = {
  registerTool: (name: string, meta: unknown, handler: unknown) => void;
  registerResource: (
    name: string,
    uriOrTemplate: unknown,
    config: unknown,
    cb: unknown,
  ) => void;
};
